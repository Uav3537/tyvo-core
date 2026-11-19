import type { Parser } from "./body.js";
import { applyCookies } from "./cookies.js";
import { HANDLES_PREFLIGHT, corsHeaders, isPreflight, preflightResponse, resolveCors } from "./cors.js";
import { cspHeaders, parseCspOverride, resolveCsp } from "./csp.js";
import {
    applyModifiers,
    applyRatelimit,
    describe,
    errorResponse,
    finalize,
    hasSchemas,
    resolveRatelimit,
    runSteps,
    settle,
    validateRequest,
    validateResponse,
} from "./pipeline.js";
import { TyvoRequest } from "./request.js";
import { TyvoResponse, isTyvoResponse, trackedBuilder } from "./response.js";
import type { RoutePath } from "./routes.js";
import { getRuntime } from "./runtime.js";
import {
    GUARD,
    MIDDLEWARE,
    MODIFIER,
    RUN,
    type AddedByGuard,
    type AddedByMiddleware,
    type ChainRequest,
    type ChainState,
    type ChainStep,
    type GuardOptions,
    type GuardRequest,
    type TyvoGuard,
    type MiddlewareOptions,
    type MiddlewareResult,
    type ModifierOptions,
    type RouteContext,
    type ResponseFor,
    type RouteMetaOf,
    type RouteOptions,
    type TyvoRoute,
    type Schema,
    type Validated,
    type TyvoMiddleware,
    type TyvoModifier,
} from "./types.js";

/**
 * Builds a route export with Tyvo's processing. The result is a plain `(request: Request) => Promise<Response>`,
 * interchangeable with a hand-written `export function GET(request) { ... }`. In route.ts, import `route` from
 * `"./$types"`: that one is bound to the folder, so `request.params` and what the folder's proxies add are typed.
 *
 * Order: CORS → rate limit → guards → body parsing → schemas → middlewares → handler → modifiers. The handler must
 * return a `TyvoResponse`. Guards (authentication, permissions) reject before the body is read or any schema runs;
 * middlewares see the validated request.
 * CORS preflights are answered from the route's `cors` (over `defaultCORS`) without running anything else.
 *
 * ```ts
 * import { route } from "./$types";
 *
 * export const POST = route({
 *     middlewares: [webAuth],
 *     bodySchema: z.object({ title: z.string() }),
 *     handler: async (request, response) => response.status(201).json({ title: request.body.title }),
 * });
 * ```
 */
export function route<
    const TMiddlewares extends readonly TyvoMiddleware<any>[] = [],
    const TGuards extends readonly TyvoGuard<any>[] = [],
    TParser extends Parser<any> | undefined = undefined,
    TBody extends Schema | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TParams extends Schema | undefined = undefined,
    THeaders extends Schema | undefined = undefined,
    TCookies extends Schema | undefined = undefined,
    TSchema extends Schema | undefined = undefined,
    TResponseSchema extends Schema | undefined = undefined,
    TResponse extends ResponseFor<TResponseSchema> = ResponseFor<TResponseSchema>,
    const TPath extends RoutePath | undefined = undefined,
>(
    options: RouteOptions<TParser, TBody, TQuery, TParams, THeaders, TCookies, TSchema, TMiddlewares, TResponse, TPath, TResponseSchema, TGuards>,
): TyvoRoute<RouteMetaOf<TPath, TBody, TQuery, TParams, TResponse, TResponseSchema>> {
    if (typeof options?.handler !== "function") throw new TypeError("route(): `handler` must be a function.");
    const guards: readonly TyvoGuard<any>[] = options.guards ?? [];
    for (const entry of guards) {
        if (!isGuard(entry)) throw new TypeError(`route(): every entry of \`guards\` must be created with guard()${isMiddleware(entry) ? " (this one is a middleware: list it in `middlewares`)" : ""}.`);
    }
    if (options.path !== undefined && (typeof options.path !== "string" || !options.path.startsWith("/"))) {
        throw new TypeError(`route(): \`path\` must be the route's folder path, e.g. "/api/users/[id]".`);
    }
    const middlewares: readonly TyvoMiddleware<any>[] = options.middlewares ?? [];
    for (const entry of middlewares) {
        if (!isMiddleware(entry)) throw new TypeError(`route(): every entry of \`middlewares\` must be created with middleware()${isGuard(entry) ? " (this one is a guard: list it in `guards`)" : ""}.`);
    }
    const modifiers: readonly TyvoModifier[] = options.modifiers ?? [];
    for (const entry of modifiers) {
        if (!isModifier(entry)) throw new TypeError("route(): every entry of `modifiers` must be created with modifier().");
    }
    if (options.parser !== undefined && typeof options.parser !== "function") throw new TypeError("route(): `parser` must be a function, e.g. bodyParser().");
    const validates = hasSchemas(options);
    if (options.responseSchema !== undefined && typeof options.responseSchema?.safeParseAsync !== "function") {
        throw new TypeError("route(): `responseSchema` must be a zod schema.");
    }
    // Checked once, when the route is defined.
    const csp = parseCspOverride(options.csp, "route() `csp`");

    // The context is optional so a route can also be called directly, e.g. in tests.
    const handle = async (raw: Request, context: Partial<RouteContext> = {}): Promise<Response> => {
        const runtime = getRuntime();
        const proxies = context.proxies ?? [];
        // Framework headers (CORS, rate limit) are added to whatever response goes out, errors included.
        const headers = new Headers();
        let request: TyvoRequest = new TyvoRequest<unknown>({ raw, body: undefined, params: context.params ?? {}, ip: context.ip ?? "" });
        let outgoing: TyvoResponse<any>;
        try {
            const cors = resolveCors(options.cors, runtime.cors);
            // With CORS off, a preflight still must not reach the handler: answer without CORS headers (the browser blocks).
            if (isPreflight(raw)) return cors ? await preflightResponse(cors, raw) : new Response(null, { status: 204 });
            if (cors) for (const [name, value] of await corsHeaders(cors, raw)) headers.set(name, value);
            for (const [name, value] of cspHeaders(resolveCsp(csp, runtime.csp))) headers.set(name, value);

            const limit = resolveRatelimit(options.ratelimit, runtime.ratelimit);
            if (limit) for (const [name, value] of await applyRatelimit(runtime, limit, raw, context)) headers.set(name, value);

            // One state for both stages: a step runs at most once per request.
            const state: ChainState = { request, executed: new Set() };
            // Guards (the proxies' first, outer first) decide before the body is read or any schema reveals anything.
            let ended = await runSteps([...proxies.flatMap((entry) => entry.guards), ...guards], state);
            request = state.request as TyvoRequest;
            if (!ended) {
                const body: unknown = raw.body === null ? undefined : await (options.parser ?? runtime.parser)(raw.clone());
                request = { ...request, body } as TyvoRequest;
                if (validates) request = await validateRequest(options, request);
                state.request = request;
                // Then the middlewares: the proxies' (outer first), then the route's own.
                ended = await runSteps([...proxies.flatMap((entry) => entry.middlewares), ...middlewares], state);
                request = state.request as TyvoRequest;
            }
            if (ended) {
                outgoing = ended;
            } else {
                const result: unknown = await options.handler(request as never, new TyvoResponse());
                if (!isTyvoResponse(result)) {
                    throw new TypeError(`route handler must return a TyvoResponse (e.g. response.json(...)), got ${describe(result)}.`);
                }
                outgoing = await validateResponse(options.responseSchema, result);
            }
        } catch (error) {
            // A 429 carries its rate-limit headers on the error; onError applies them.
            outgoing = await errorResponse(runtime, error, raw);
        }

        // Cookies set or deleted through request.cookies go out with whatever response is sent.
        // The route's modifiers first, then the proxies' (inner first).
        const allModifiers = [...modifiers, ...[...proxies].reverse().flatMap((entry) => entry.modifiers)];
        try {
            return applyCookies(finalize(await applyModifiers(allModifiers, request, outgoing), headers), request.cookies);
        } catch (error) {
            return applyCookies(finalize(await errorResponse(runtime, error, raw), headers), request.cookies);
        }
    };

    return Object.assign(handle, { [HANDLES_PREFLIGHT]: true, [DECLARED_PATH]: options.path });
}

/** `route()` with the folder's path filled in: what `"./$types"` exports as `route`. */
export interface BoundRoute<TPath extends RoutePath> {
    <
        const TMiddlewares extends readonly TyvoMiddleware<any>[] = [],
        const TGuards extends readonly TyvoGuard<any>[] = [],
        TParser extends Parser<any> | undefined = undefined,
        TBody extends Schema | undefined = undefined,
        TQuery extends Schema | undefined = undefined,
        TParams extends Schema | undefined = undefined,
        THeaders extends Schema | undefined = undefined,
        TCookies extends Schema | undefined = undefined,
        TSchema extends Schema | undefined = undefined,
        TResponseSchema extends Schema | undefined = undefined,
        TResponse extends ResponseFor<TResponseSchema> = ResponseFor<TResponseSchema>,
    >(
        options: RouteOptions<TParser, TBody, TQuery, TParams, THeaders, TCookies, TSchema, TMiddlewares, TResponse, TPath, TResponseSchema, TGuards>,
    ): TyvoRoute<RouteMetaOf<TPath, TBody, TQuery, TParams, TResponse, TResponseSchema>>;
}

/** @internal Used by the generated `"./$types"` of each route folder. */
export function bindRoute<const TPath extends RoutePath>(path: TPath): BoundRoute<TPath> {
    return ((options: object) => route({ ...options, path } as never)) as unknown as BoundRoute<TPath>;
}

/** Where `route({ path })` / `page({ path })` keep their path, checked against the folder when the server starts. */
export const DECLARED_PATH = Symbol.for("tyvo.path");

export function declaredPath(value: unknown): string | undefined {
    const path = value && (typeof value === "function" || typeof value === "object") ? (value as Record<symbol, unknown>)[DECLARED_PATH] : undefined;
    return typeof path === "string" ? path : undefined;
}

/**
 * Defines a middleware. Every path of the handler returns one of (a path that returns nothing is a type error):
 * - a `TyvoResponse` (e.g. `response.status(401).json(...)`) — the request ends with it.
 * - `response.proceed(added)` (e.g. `{ session }`) — passed on, with `added` merged into the request seen by later
 *   middlewares and the handler, with its type. `response.proceed()` passes it on unchanged.
 *
 * `requires` lists the middlewares this one depends on: they run first, so what they add is guaranteed in `handler`.
 * `bodySchema` / `querySchema` / `paramSchema` / `headerSchema` / `cookieSchema` / `schema` validate the request first;
 * their output types flow into the handler and everything after this middleware.
 *
 * ```ts
 * const webAuth = middleware({
 *     requires: [parseAuth],
 *     handler: (request, response) => (request.session ? response.proceed() : response.status(401).json({ error: "Unauthorized" })),
 * });
 * ```
 */
export function middleware<
    const TRequires extends readonly ChainStep[] = [],
    TBody extends Schema | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TParams extends Schema | undefined = undefined,
    THeaders extends Schema | undefined = undefined,
    TCookies extends Schema | undefined = undefined,
    TSchema extends Schema | undefined = undefined,
    TResult extends MiddlewareResult = MiddlewareResult,
>(
    options: MiddlewareOptions<TRequires, TBody, TQuery, TParams, THeaders, TCookies, TSchema, TResult>,
): TyvoMiddleware<AddedByMiddleware<TRequires, Validated<TBody, TQuery, TParams, THeaders, TCookies, TSchema>, TResult>> {
    if (typeof options?.handler !== "function") throw new TypeError("middleware(): `handler` must be a function.");
    if ("forward" in options) throw new TypeError("middleware(): `forward` was renamed to `requires`.");
    const requires: readonly ChainStep[] = options.requires ?? [];
    if (!Array.isArray(requires)) throw new TypeError("middleware(): `requires` must be an array of middlewares or guards.");
    for (const entry of requires) {
        if (!isMiddleware(entry) && !isGuard(entry)) throw new TypeError("middleware(): every entry of `requires` must be created with middleware() or guard().");
    }
    const validates = hasSchemas(options);

    const self = Object.assign(
        async (request: TyvoRequest<any>): Promise<TyvoResponse<any> | TyvoRequest<any>> => {
            const state: ChainState = { request, executed: new Set() };
            return (await run(state)) ?? (state.request as TyvoRequest<any>);
        },
        { [MIDDLEWARE]: true as const, [RUN]: (state: ChainState) => run(state) },
    );

    async function run(state: ChainState): Promise<TyvoResponse<any> | undefined> {
        if (state.executed.has(self)) return undefined;
        state.executed.add(self);
        for (const entry of requires) {
            const ended = await entry[RUN](state);
            if (ended) return ended;
        }
        if (validates) state.request = await validateRequest(options, state.request);
        const builder = trackedBuilder();
        return settle(state, await options.handler(state.request as never, builder), "middleware handler", builder);
    }

    return self;
}

/**
 * Defines a guard: a middleware for authentication and permissions that runs before the body is read and before any
 * schema. A request it rejects costs no parsing and learns nothing about the route's schemas. It sees headers,
 * cookies, the raw params and query (strings) and what the guards it `requires` add, but no body (a type error).
 * List it in `guards` of route(), page() or proxy(); a middleware may also `require` it.
 *
 * Every path of the handler returns, as in middleware(): a `TyvoResponse` ends the request, `response.proceed(added)`
 * passes it on with `added` merged in (typed for every guard, middleware and handler after it).
 *
 * ```ts
 * export const webAuth = guard({
 *     handler: async (request, response) => {
 *         const session = await findSession(request.cookies.get("sid"));
 *         if (!session) return response.status(401).json({ error: "Unauthorized" });
 *         return response.proceed({ user: session.user });
 *     },
 * });
 * ```
 */
export function guard<const TRequires extends readonly TyvoGuard<any>[] = [], TResult extends MiddlewareResult = MiddlewareResult>(
    options: GuardOptions<TRequires, TResult>,
): TyvoGuard<AddedByGuard<TRequires, TResult>> {
    if (typeof options?.handler !== "function") throw new TypeError("guard(): `handler` must be a function.");
    if ("bodySchema" in options || "querySchema" in options || "paramSchema" in options || "headerSchema" in options || "cookieSchema" in options || "schema" in options) {
        throw new TypeError("guard(): guards run before any schema and take none. Validate in a middleware() or the route instead.");
    }
    const requires: readonly TyvoGuard<any>[] = options.requires ?? [];
    if (!Array.isArray(requires)) throw new TypeError("guard(): `requires` must be an array of guards.");
    for (const entry of requires) {
        if (!isGuard(entry)) throw new TypeError("guard(): every entry of `requires` must be created with guard(); a guard runs before middlewares, so it cannot require one.");
    }

    const self = Object.assign(
        async (request: TyvoRequest<any>): Promise<TyvoResponse<any> | TyvoRequest<any>> => {
            const state: ChainState = { request, executed: new Set() };
            return (await run(state)) ?? (state.request as TyvoRequest<any>);
        },
        { [GUARD]: true as const, [RUN]: (state: ChainState) => run(state) },
    );

    async function run(state: ChainState): Promise<TyvoResponse<any> | undefined> {
        if (state.executed.has(self)) return undefined;
        state.executed.add(self);
        for (const entry of requires) {
            const ended = await entry[RUN](state);
            if (ended) return ended;
        }
        const builder = trackedBuilder();
        return settle(state, await options.handler(state.request as ChainRequest<GuardRequest, TRequires>, builder), "guard handler", builder);
    }

    return self as unknown as TyvoGuard<AddedByGuard<TRequires, TResult>>;
}

/**
 * Defines a modifier — the counterpart of a middleware, run after the route handler on the response about to be sent
 * (including responses that ended the middleware chain and error responses). Every path returns the response to
 * send: `response` to keep it, or one made from it (or a new one) to replace it. Returning nothing is a type error.
 *
 * ```ts
 * const noStore = modifier({
 *     handler: (request, response) => response.header("cache-control", "no-store"),
 * });
 * ```
 */
export function modifier(options: ModifierOptions): TyvoModifier {
    if (typeof options?.handler !== "function") throw new TypeError("modifier(): `handler` must be a function.");
    const self = async (request: TyvoRequest<any>, response: TyvoResponse<any>): Promise<TyvoResponse<any>> => {
        const result: unknown = await options.handler(request, response);
        if (!isTyvoResponse(result)) {
            throw new TypeError(`modifier handler must return the response to send on every path (\`return response\` to keep it); got ${describe(result)}.`);
        }
        return result;
    };
    return Object.assign(self, { [MODIFIER]: true as const });
}

export function isMiddleware(value: unknown): value is TyvoMiddleware<any> {
    return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[MIDDLEWARE] === true;
}

export function isGuard(value: unknown): value is TyvoGuard<any> {
    return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[GUARD] === true;
}

export function isModifier(value: unknown): value is TyvoModifier {
    return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[MODIFIER] === true;
}
