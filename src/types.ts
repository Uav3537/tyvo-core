import type { z } from "zod";
import type { Parser } from "./body.js";
import type { CacheStorage } from "./cache.js";
import type { CookieOptions, TyvoCookies } from "./cookies.js";
import type { CorsOptions } from "./cors.js";
import type { CspOptions, CspOverride } from "./csp.js";
import type { Logger } from "./log.js";
import type { RatelimitOptions, RatelimitStorage } from "./ratelimit.js";
import type { TyvoRequest } from "./request.js";
import type { TyvoProceed, TyvoResponse } from "./response.js";
import type { ProxyDefinition } from "./proxy.js";
import type { Params, ParamsOf, RoutePath } from "./routes.js";

export type { Params } from "./routes.js";

export type MaybePromise<T> = T | Promise<T>;

export type ParserData<P> = P extends Parser<infer T> ? T : unknown;

/** Any zod schema. */
export type Schema = z.ZodType;
type Output<S> = S extends z.ZodType ? z.output<S> : never;
type Field<K extends string, S> = [S] extends [z.ZodType] ? { [P in K]: Output<S> } : {};
type CookiesField<S> = [S] extends [z.ZodType] ? { cookies: TyvoCookies<Output<S> extends Record<string, unknown> ? Output<S> : {}> } : {};

/**
 * Headers and query keep the keys their schema does not mention (zod strips them from the output, Tyvo merges
 * the output back over the original). Validated keys get the schema's type, the others stay loosely typed.
 */
type OpenField<K extends string, S, TRest> = [S] extends [z.ZodType]
    ? { [P in K]: Output<S> extends Record<string, TRest> ? Output<S> & Readonly<Record<string, TRest>> : Output<S> & Readonly<Record<string, unknown>> }
    : {};
type SchemaFields<S> = [S] extends [z.ZodType] ? (Output<S> extends object ? Output<S> : {}) : {};

/**
 * Request validation shared by `route()` and `middleware()`. Every schema is checked with `safeParseAsync`;
 * all failures are reported together as one 400 response. On success the outputs replace the request fields.
 */
export interface RequestSchemas<TBody, TQuery, TParams, THeaders, TCookies, TSchema> {
    /** Validates `request.body` (the parsed body). */
    bodySchema?: TBody;
    /**
     * Validates `request.query` (search params as an object; repeated keys are arrays). The output is merged over
     * the original, so keys the schema does not mention are kept; use `z.strictObject` to reject them instead.
     *
     * URL values are strings. Before validating, each one is converted to what the schema accepts at its place, strictly:
     * numbers must be plain decimals (`42`, `-1.5`; not `042`, `0x2A`, `4.2e1`), booleans `true`/`false`, bigints
     * integers, dates ISO 8601, and a single value becomes an array where one is expected. Unions, optionals,
     * defaults and literals are followed (`z.union([z.number(), z.literal("me")])` gets `42` or `"me"`).
     * Anything that does not convert is validated as the original string.
     */
    querySchema?: TQuery;
    /**
     * Validates `request.params` — the dynamic segments of the route's path (`[id]` -> string, `[...slug]` -> string[]).
     * Strings are converted like the query (`z.number()` works for `/users/42`). Its keys must be segments of the
     * folder path: checked by the types with `route({ path })`, and by the generated `.tyvo/types/check.ts` otherwise.
     */
    paramSchema?: TParams;
    /** Validates `request.headers` (a plain object with lower-case names). The output is merged over the original. */
    headerSchema?: THeaders;
    /**
     * Validates the cookies (`request.cookies.all()`: signed cookies verified and unwrapped). Like `querySchema`,
     * strings are converted where the schema expects numbers/booleans. `request.cookies.get()` is then typed by the output.
     */
    cookieSchema?: TCookies;
    /**
     * Validates the rest of the request — `const { headers, body, ...rest } = request` — after the schemas above,
     * e.g. `z.object({ ip: z.ipv4() })`. Its output keys are merged into the request.
     */
    schema?: TSchema;
}

/** What a set of schemas does to the request type: part outputs replace their fields, then `schema`'s output is merged. */
export type Validated<TBody, TQuery, TParams, THeaders, TCookies, TSchema> = Compose<
    Simplify<
        Field<"body", TBody> &
            OpenField<"query", TQuery, string | string[] | undefined> &
            OpenField<"params", TParams, string | string[] | undefined> &
            OpenField<"headers", THeaders, string | undefined> &
            CookiesField<TCookies>
    >,
    SchemaFields<TSchema>
>;

export const MIDDLEWARE = Symbol.for("tyvo.middleware");
export const GUARD = Symbol.for("tyvo.guard");
/** Internal runner, keyed by a symbol so it stays out of autocomplete. */
export const RUN = Symbol.for("tyvo.middleware.run");

/**
 * What a guard or middleware handler returns on every path: a `TyvoResponse` ends the request,
 * `response.proceed(added)` passes it on with `added` merged in. A path that returns nothing is a type error.
 */
export type MiddlewareResult = TyvoResponse<any> | TyvoProceed<any>;

/** A middleware or a guard: what `requires` of a middleware may list. */
export type ChainStep = TyvoMiddleware<any> | TyvoGuard<any>;

/**
 * The request a guard sees: everything but the body, which is not read yet. `params` / `query` / `headers` /
 * `cookies` are the raw values (no schema has run).
 */
export type GuardRequest = Omit<TyvoRequest, "body">;

export interface GuardOptions<TRequires extends readonly TyvoGuard<any>[], TResult extends MiddlewareResult> {
    /** Guards this one depends on: they run (in order) before it, so what they add is guaranteed (and typed) in `handler`. */
    requires?: TRequires;
    /**
     * Runs before the body is read and before any schema. Every path returns: a `TyvoResponse` to end the request
     * (401, 403...), or `response.proceed(added)` to pass it on (`added` is typed for everything after).
     */
    handler: (request: ChainRequest<GuardRequest, TRequires>, response: TyvoResponse) => MaybePromise<TResult>;
}

/**
 * A guard created with `guard()`: a middleware that runs before the body is read and before the schemas, so a
 * request it rejects costs no parsing and learns nothing about the schemas. `TAdded` is what it may add.
 */
export interface TyvoGuard<TAdded extends object = {}> {
    /** Runs the guard (and what it requires) on its own. Resolves to the ending response, or the resulting request. */
    (request: TyvoRequest<any>, response?: TyvoResponse): Promise<TyvoResponse<any> | TyvoRequest<any>>;
    readonly [GUARD]: true;
    readonly [RUN]: (state: ChainState) => Promise<TyvoResponse<any> | undefined>;
    /** Type-only. */
    readonly __added?: TAdded;
}

export interface MiddlewareOptions<
    TRequires extends readonly ChainStep[],
    TBody extends Schema | undefined,
    TQuery extends Schema | undefined,
    TParams extends Schema | undefined,
    THeaders extends Schema | undefined,
    TCookies extends Schema | undefined,
    TSchema extends Schema | undefined,
    TResult extends MiddlewareResult,
> extends RequestSchemas<TBody, TQuery, TParams, THeaders, TCookies, TSchema> {
    /**
     * Middlewares (or guards) this one depends on: they run (in order) before it, so whatever they add to the request
     * is guaranteed (and typed) in `handler`. Each runs at most once per request, however many others require it; a
     * guard already run in the guard stage is not run again.
     */
    requires?: TRequires;
    /**
     * Runs after `requires` and the schemas; what the schemas produce is typed here and in everything after. Every
     * path returns: a `TyvoResponse` ends the request, `response.proceed(added)` passes it on with `added`.
     */
    handler: (
        request: Merge<ChainRequest<TyvoRequest, TRequires>, Validated<TBody, TQuery, TParams, THeaders, TCookies, TSchema>>,
        response: TyvoResponse,
    ) => MaybePromise<TResult>;
}

/** Shared per-request state while a middleware chain runs. */
export interface ChainState {
    request: object;
    executed: Set<ChainStep>;
}

/**
 * A middleware created with `middleware()`. `TAdded` is a union of the objects it may add to the request
 * (`{}` stands for "nothing added" on some path).
 */
export interface TyvoMiddleware<TAdded extends object = {}> {
    /** Runs the middleware (and what it requires) on its own. Resolves to the ending response, or the resulting request. */
    (request: TyvoRequest<any>, response?: TyvoResponse): Promise<TyvoResponse<any> | TyvoRequest<any>>;
    readonly [MIDDLEWARE]: true;
    readonly [RUN]: (state: ChainState) => Promise<TyvoResponse<any> | undefined>;
    /** Type-only. */
    readonly __added?: TAdded;
}

/** Context the server passes as the second argument of every route export. */
export interface RouteContext {
    params: Params;
    ip: string;
    /** Route pattern such as `/users/:id`, also used to namespace rate-limit buckets. */
    pattern: string;
    /** @internal Set while a page is prerendered (build time or revalidation), not for client requests. */
    prerender?: boolean;
    /** @internal The proxy.ts files wrapping this route, outer first. */
    proxies?: readonly ProxyDefinition[];
}

/**
 * What a route file's `GET`/`POST`/... export must be. Write one by hand for raw access,
 * or build one with `route()` for parsing, rate limiting and middlewares.
 */
export type Route = (request: Request, context: RouteContext) => Response | Promise<Response>;

/** What `route()` knows about an export at the type level; read by `api()` and the generated route checks. */
export interface RouteMeta {
    /** `route({ path })`, or undefined. */
    path: string | undefined;
    /** Keys of `paramSchema`'s input (`never` without one). */
    paramKeys: string;
    /** Input types of the schemas (what a client sends), `undefined` without a schema. */
    params: unknown;
    query: unknown;
    body: unknown;
    /** What the handler's `response.json(...)` (etc.) carries. */
    response: unknown;
}

/** A `route()` export: a plain `Route` that keeps its request and response types. */
export type TyvoRoute<TMeta extends RouteMeta = RouteMeta> = Route & {
    /** Type-only; never set at runtime. */
    readonly "~tyvo"?: TMeta;
};

type InputOf<S> = S extends Schema ? z.input<S> : undefined;
type SchemaKeys<S> = S extends Schema ? keyof z.input<S> & string : never;
type ResponseData<R> = R extends TyvoResponse<infer D> ? D : unknown;

export type RouteMetaOf<TPath, TBody, TQuery, TParams, TResponse, TResponseSchema = undefined> = {
    path: TPath extends string ? TPath : undefined;
    paramKeys: SchemaKeys<TParams>;
    params: InputOf<TParams>;
    query: InputOf<TQuery>;
    body: InputOf<TBody>;
    /** With `responseSchema`, what the client receives is its output. */
    response: [TResponseSchema] extends [Schema] ? z.output<TResponseSchema> : ResponseData<TResponse>;
};

/** What the handler may return: anything, or with `responseSchema` a response whose body is the schema's input. */
export type ResponseFor<TResponseSchema> = [TResponseSchema] extends [Schema] ? TyvoResponse<z.input<TResponseSchema>> : TyvoResponse<any>;

/** `{ params }` typed from the path, when `route({ path })` / `page({ path })` names one. */
export type PathParams<TPath> = TPath extends string ? { params: ParamsOf<TPath> } : {};

type MiddlewaresOfProxies<TModules> = TModules extends readonly [infer Head, ...infer Tail]
    ? [...(Head extends { default: ProxyDefinition<infer M, any> } ? M : []), ...MiddlewaresOfProxies<Tail>]
    : [];
type GuardsOfProxies<TModules> = TModules extends readonly [infer Head, ...infer Tail]
    ? [...(Head extends { default: ProxyDefinition<any, infer G> } ? G : []), ...GuardsOfProxies<Tail>]
    : [];
/** The guards of the proxy.ts files wrapping `TPath` (outer first): they run before the route's own guards. */
export type ProxyGuards<TPath> = TPath extends keyof Tyvo.RouteProxies ? GuardsOfProxies<Tyvo.RouteProxies[TPath]> : [];
/**
 * The middlewares of the proxy.ts files wrapping `TPath` (outer first), from the generated `Tyvo.RouteProxies`.
 * They run before the route's own, so what they add is typed in its handler.
 */
export type ProxyMiddlewares<TPath> = TPath extends keyof Tyvo.RouteProxies ? MiddlewaresOfProxies<Tyvo.RouteProxies[TPath]> : [];

/** Makes `paramSchema` fail to type-check when one of its keys is not a dynamic segment of `path`. */
export type ParamSchemaCheck<TParams, TPath> = TPath extends string
    ? [Exclude<SchemaKeys<TParams>, keyof ParamsOf<TPath>>] extends [never]
        ? unknown
        : { "~error": `paramSchema key "${Exclude<SchemaKeys<TParams>, keyof ParamsOf<TPath>>}" is not a dynamic segment of ${TPath}` }
    : unknown;

export interface RouteOptions<
    TParser extends Parser<any> | undefined,
    TBody extends Schema | undefined,
    TQuery extends Schema | undefined,
    TParams extends Schema | undefined,
    THeaders extends Schema | undefined,
    TCookies extends Schema | undefined,
    TSchema extends Schema | undefined,
    TMiddlewares extends readonly TyvoMiddleware<any>[],
    TResponse extends TyvoResponse<any>,
    TPath extends RoutePath | undefined = undefined,
    TResponseSchema extends Schema | undefined = undefined,
    TGuards extends readonly TyvoGuard<any>[] = [],
> extends RequestSchemas<TBody, TQuery, TParams, THeaders, TCookies, TSchema> {
    /**
     * This route's path as written in its folder names, e.g. `"/api/users/[id]"`. Optional; with it `request.params`
     * is typed from the path (`{ id: string }`) and `paramSchema`'s keys are checked against it. A path that is not
     * this file's folder fails the type check and the server start.
     */
    path?: TPath;
    paramSchema?: TParams & ParamSchemaCheck<TParams, TPath>;
    /**
     * Run in order before the body is read and before the schemas (after the proxies' guards). Rejecting here (401,
     * 403...) costs no parsing and reveals nothing about the schemas. See `guard()`.
     */
    guards?: TGuards;
    /** Run in order after the schemas, before the handler: they see the validated request. See `middleware()`. */
    middlewares?: TMiddlewares;
    /** Run in order after the handler (and on responses that ended the middleware chain). See `modifier()`. */
    modifiers?: readonly TyvoModifier[];
    /** Overrides `defaultRatelimit()` from `config.ts`. Missing fields are taken from it; `false` disables limiting. */
    ratelimit?: Partial<RatelimitOptions> | false;
    /** Overrides `defaultCORS` from `config.ts`. Missing fields are taken from it; `false` disables CORS for this route. */
    cors?: Partial<CorsOptions> | false;
    /** Overrides `defaultCSP` from `config.ts`; `directives` are merged by name. `false` sends no CSP header. */
    csp?: CspOverride | false;
    /** Overrides `defaultParser` from `config.ts`, e.g. `bodyParser({ limit: 10_000_000 })`. */
    parser?: TParser;
    /**
     * Validates what the handler sends. The handler must return a response whose body is the schema's input type;
     * end with errors by throwing (`HttpError`, `notFound()`), which `onError` turns into the response. At runtime the
     * JSON body of every 2xx response from the handler is parsed with it before it is sent (the output replaces it, so
     * transforms apply); a body that does not match is a server error (500 through `onError`, logged with the issues).
     * `api()` types `data` with the output.
     */
    responseSchema?: TResponseSchema;
    handler: (
        request: ChainRequest<
            Merge<Merge<TyvoRequest<ParserData<TParser>>, PathParams<TPath>>, Validated<TBody, TQuery, TParams, THeaders, TCookies, TSchema>>,
            [...ProxyGuards<TPath>, ...TGuards, ...ProxyMiddlewares<TPath>, ...TMiddlewares]
        >,
        response: TyvoResponse,
    ) => MaybePromise<TResponse>;
}

export const MODIFIER = Symbol.for("tyvo.modifier");

/** What a modifier handler returns on every path: the response to send (the one it got, or a new one). */
export type ModifierResult = TyvoResponse<any>;

export interface ModifierOptions {
    /**
     * Runs after the route handler with the response about to be sent (not a fresh builder as in middlewares). Every
     * path returns the response to send: `response` itself to keep it, or one made from it (`response.header(...)`)
     * or a new one to replace it. A path that returns nothing is a type error.
     */
    handler: (request: TyvoRequest, response: TyvoResponse<unknown>) => MaybePromise<ModifierResult>;
}

/** A modifier created with `modifier()`: the counterpart of a middleware, applied to the outgoing response. */
export interface TyvoModifier {
    /** Runs the modifier on its own and resolves to the response that would be sent. */
    (request: TyvoRequest<any>, response: TyvoResponse<any>): Promise<TyvoResponse<any>>;
    readonly [MODIFIER]: true;
}

// ---- Request type accumulated through the middleware chain ----------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * What a handler's return type adds to the request: what each `response.proceed(added)` path adds, the request's own
 * keys included (`proceed({ params })` replaces the params, with that type). A response adds nothing (the request ends).
 * Add only what is new: `proceed({ ...request, user })` would replace every field with the type this handler saw.
 */
type AddedBy<TResult> = TResult extends TyvoProceed<infer A> ? A : never;

export type AddedByResult<TResult> = [AddedBy<TResult>] extends [never] ? {} : AddedBy<TResult>;

/** Applies `B` on top of `A` for every combination of their union members. */
type Compose<A, B> = A extends unknown ? (B extends unknown ? Simplify<Omit<A, keyof B> & B> : never) : never;

type AddedByList<TMiddlewares extends readonly unknown[], TAcc = {}> = TMiddlewares extends readonly [infer Head, ...infer Rest]
    ? AddedByList<Rest, Head extends TyvoMiddleware<infer A> ? Compose<TAcc, A> : Head extends TyvoGuard<infer A> ? Compose<TAcc, A> : TAcc>
    : TAcc;

/** Everything a guard adds: what it requires first, then its own handler. */
export type AddedByGuard<TRequires extends readonly unknown[], TResult> = Compose<AddedByList<TRequires>, AddedByResult<TResult>>;

/** Everything a middleware adds: what it requires first, then its schemas' outputs, then its own handler. */
export type AddedByMiddleware<TRequires extends readonly ChainStep[], TValidated, TResult> = Compose<
    Compose<AddedByList<TRequires>, TValidated>,
    AddedByResult<TResult>
>;

/** `TAdded` on top of `TRequest`, for every member of either union. */
type Merge<TRequest, TAdded> = TRequest extends unknown ? (TAdded extends unknown ? Simplify<Omit<TRequest, keyof TAdded> & TAdded> : never) : never;

export type ChainRequest<TRequest, TMiddlewares extends readonly unknown[]> = Merge<TRequest, AddedByList<TMiddlewares>>;

/** Cache-Control of the static files Tyvo serves in production (`tyvo dev` always sends `no-cache`). */
export interface StaticCacheControl {
    /** Files from `public/`. Their URLs do not change when their content does, so keep it short or revalidating. */
    public: string;
    /** Build assets under `/_tyvo/static/` (scripts, styles, imported files). Their names carry a content hash. */
    assets: string;
}

/** The Node HTTP server of `tyvo dev` / `tyvo start`. */
export interface ServerOptions {
    /** Address to listen on; `undefined` listens on every interface. The `HOST` environment variable takes precedence. */
    hostname: string | undefined;
    /** Milliseconds to receive a whole request (headers and body) before the connection is closed (408). `0` disables it. */
    requestTimeout: number;
    /** Milliseconds to receive the request headers. */
    headersTimeout: number;
    /** Milliseconds an idle keep-alive connection stays open after a response. */
    keepAliveTimeout: number;
    /** Maximum size of the request headers in bytes (431 above). */
    maxHeaderSize: number;
}

/**
 * What a route or page URL with a trailing slash (`/users/7/`) does:
 * - `"redirect"`: 308 to the URL without it (`/users/7`), query kept, when that URL is served; otherwise 404.
 * - `"strict"`: 404; only the URL without the slash is served.
 * - `"ignore"`: served like the URL without it (two URLs for one route or page).
 * Files (public/ and build assets) never take a trailing slash.
 */
export type TrailingSlash = "redirect" | "strict" | "ignore";

/** Client-side navigation (`<Link>`, `router.prefetch()`). */
export interface PrefetchOptions {
    /** Milliseconds a prefetched page stays usable; navigating later fetches it again. */
    ttl: number;
}

export interface ServerActionOptions {
    /** Maximum size of an action's encoded arguments in bytes (413 above). */
    bodyLimit: number;
    /** Origins besides the site's own that may call actions (the Origin header is checked against CSRF). */
    allowedOrigins: readonly string[];
}

/**
 * Shape of `config.ts`. Every export is required: Tyvo has no hidden defaults, the defaults live in the
 * `config.ts` that `tyvo init` generates. Settings are values (`default*`, `ratelimitStorage`, `cacheStorage`,
 * `serverActions`, `cookieSecret`, `port`, `trailingSlash`, `server`, `staticCacheControl`, `prefetch`, `loggers`); hooks Tyvo calls
 * per request are functions (`getIp`, `onError`, and `key` in `defaultRatelimit`).
 */
export interface TyvoConfig {
    /** Body parser for every route() without its own `parser`, e.g. `bodyParser({ limit: 1024 * 1024 })`. */
    defaultParser: Parser;
    /** Rate limit for every endpoint: hand-written routes, pages, and route()/page() without their own `ratelimit`. `false` disables it. */
    defaultRatelimit: RatelimitOptions | false;
    /** Where rate-limit counters live, e.g. `memoryStorage({ sweepInterval: 60_000 })`. */
    ratelimitStorage: RatelimitStorage;
    /** Where `cache()` results live, e.g. `memoryCache({ sweepInterval: 60_000 })`; a shared store reaches every process. */
    cacheStorage: CacheStorage;
    /**
     * Content-Security-Policy for every endpoint; route()/page() can override it with `csp`.
     * `false` sends no CSP header.
     */
    defaultCSP: CspOptions | false;
    /** Server actions ("use server"): POST /_tyvo/action. */
    serverActions: ServerActionOptions;
    /** Options for every cookie set with `request.cookies.set()` / `delete()`; each call can override fields. */
    defaultCookie: CookieOptions;
    /** Key for signed cookies (`set(name, value, { signed: true })`). At least 32 characters; keep it out of source control. */
    cookieSecret: string;
    /** CORS for every endpoint: hand-written routes, pages, and route() without its own `cors`. `false` sends no CORS headers. */
    defaultCORS: CorsOptions | false;
    /**
     * `request.ip` for every request. `socketIp` is the TCP peer address exactly as Node reports it (IPv4 clients on a
     * dual-stack socket look like `::ffff:1.2.3.4`; `normalizeIp()` turns that into `1.2.3.4`). Must return an IPv4/IPv6
     * address: anything else is an error (500 through `onError`).
     */
    getIp: (request: Request, socketIp: string) => MaybePromise<string>;
    /** Turns every error into the response: Tyvo's own `HttpError`s (400, 404, 405, 413, 429) and anything a handler throws. */
    onError: (error: unknown, request: Request, response: TyvoResponse) => MaybePromise<TyvoResponse<any>>;
    /** Port to listen on. The `PORT` environment variable and `--port` take precedence. */
    port: number;
    /** What a route or page URL with a trailing slash does: "redirect" (308 to the URL without it), "strict" (404) or "ignore". */
    trailingSlash: TrailingSlash;
    /** Hostname, timeouts and header limit of the HTTP server. */
    server: ServerOptions;
    /** Cache-Control of `public/` files and build assets in production. */
    staticCacheControl: StaticCacheControl;
    /** How long prefetched pages stay usable in the browser. */
    prefetch: PrefetchOptions;
    /**
     * Called in order for every log entry (requests, server ready, warnings, errors), like middlewares:
     * return nothing to pass the entry on, a new entry to replace it, or `false` to drop it.
     */
    loggers: readonly Logger[];
}
