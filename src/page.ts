import type { ReactNode } from "react";
import type { z } from "zod";
import { applyCookies } from "./cookies.js";
import { applyRatelimit, errorResponse, finalize, parseQuery, resolveRatelimit, runSteps, type Issue } from "./pipeline.js";
import { parseCspOverride, type CspOverride } from "./csp.js";
import type { Metadata } from "./metadata.js";
import { readNavigation } from "./navigation.js";
import type { RatelimitOptions } from "./ratelimit.js";
import { TyvoRequest, type Query } from "./request.js";
import { HttpError, TyvoResponse, isTyvoResponse } from "./response.js";
import { DECLARED_PATH, isGuard, isMiddleware } from "./route.js";
import type { PagePath, ParamsOf } from "./routes.js";
import type { Runtime } from "./runtime.js";
import type { ChainRequest, ChainState, MaybePromise, ParamSchemaCheck, Params, RouteContext, Schema, TyvoGuard, TyvoMiddleware } from "./types.js";

export const PAGE = Symbol.for("tyvo.page");

type ParamsFor<P> = [P] extends [never] ? Params : P extends string ? ParamsOf<P> : Params;

/**
 * Props every page component receives. Name the page's path to type its params from it:
 * `export default function User({ params }: PageProps<"/users/[id]">)` gives `params.id: string`.
 */
export interface PageProps<P extends PagePath = never> {
    params: ParamsFor<P>;
    /** Search params as an object; repeated keys are arrays. */
    query: Query;
}

/**
 * What `export async function staticParams()` in a prerendered `page.tsx` returns: one entry per page to generate,
 * `[id]` -> string, `[...slug]` -> non-empty string[], `[[...slug]]` -> string[] or undefined.
 */
export type StaticParams = Readonly<Record<string, string | readonly string[] | undefined>>[];

/** Props of a `layout.tsx` default export. `LayoutProps<"/users/[id]">` types `params` from the layout's folder path. */
export interface LayoutProps<P extends string = never> {
    children: ReactNode;
    params: ParamsFor<P>;
}

/** What a loader may return: a response ends the request (redirect, 401, ...), an object becomes component props. */
export type LoaderResult = TyvoResponse<any> | object;
type LoaderProps<TLoader> = Exclude<Awaited<TLoader>, TyvoResponse<any>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type PathParamsOf<TPath> = TPath extends string ? ParamsOf<TPath> : Params;
type InputOf<S> = [S] extends [Schema] ? z.input<S> : undefined;

/** A page's params: the path's segments, with `paramSchema`'s output over them. */
export type PageParamsOut<TPath, TParams> = [TParams] extends [Schema] ? Simplify<Omit<PathParamsOf<TPath>, keyof z.output<TParams>> & z.output<TParams>> : PathParamsOf<TPath>;
/** A page's query: search params as an object, with `querySchema`'s output over them (keys it does not mention stay). */
export type PageQueryOut<TQuery> = [TQuery] extends [Schema]
    ? z.output<TQuery> extends Record<string, string | string[] | undefined>
        ? z.output<TQuery> & Readonly<Record<string, string | string[] | undefined>>
        : z.output<TQuery> & Readonly<Record<string, unknown>>
    : Query;

/** What `page()` records about a page at the type level (see `PageMeta`). */
export type PageMetaFor<TPath, TQuery, TParams> = {
    path: TPath extends string ? TPath : undefined;
    params: InputOf<TParams>;
    query: InputOf<TQuery>;
    paramsOut: PageParamsOut<TPath, TParams>;
    queryOut: PageQueryOut<TQuery>;
};

type PagePropsFor<TPath, TQuery, TParams> = { params: PageParamsOut<TPath, TParams>; query: PageQueryOut<TQuery> };

export interface PageOptions<
    TMiddlewares extends readonly TyvoMiddleware<any>[],
    TLoader extends LoaderResult,
    TPath extends PagePath | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TParams extends Schema | undefined = undefined,
    TGuards extends readonly TyvoGuard<any>[] = [],
> {
    /**
     * This page's path as written in its folder names, e.g. `"/users/[id]"`. Optional; with it `params` (in the loader
     * and the component) is typed from the path. A path that is not this file's folder fails the type check, and
     * rendering pages fails with an error naming the right path.
     */
    path?: TPath;
    /**
     * Validates and converts the query before anything else runs, like route()'s `querySchema` (URL strings become
     * numbers, booleans, dates... strictly). Its output types `query` in the loader, the component, `useQuery(path)`
     * and what `href()` accepts for this page. An invalid query is a 400 (through `onError`).
     */
    querySchema?: TQuery;
    /**
     * Validates and converts the path segments, like route()'s `paramSchema` (`z.object({ id: z.number() })` for
     * `/users/42`). Its keys must be dynamic segments of the folder. Params that do not validate render the
     * not-found page (404): the URL names nothing.
     */
    paramSchema?: TParams & ParamSchemaCheck<TParams, TPath>;
    /**
     * Run in order before the schemas, exactly like route() guards: a page they reject (redirect, 401...) never
     * validates its params or query. See `guard()`.
     */
    guards?: TGuards;
    /** Run in order after the schemas, before the loader, exactly like route() middlewares. */
    middlewares?: TMiddlewares;
    /** Overrides `defaultRatelimit()` from `config.ts`. `false` disables limiting. */
    ratelimit?: Partial<RatelimitOptions> | false;
    /** Overrides `defaultCSP` from `config.ts`; `directives` are merged by name. `false` sends no CSP header. */
    csp?: CspOverride | false;
    /** Runs on the server for every request. Its object result is passed to `component` as props (typed). */
    loader?: (request: ChainRequest<Merge<TyvoRequest<undefined>, PagePropsFor<TPath, TQuery, TParams>>, [...TGuards, ...TMiddlewares]>, response: TyvoResponse) => MaybePromise<TLoader>;
    /** A React Server Component; may be async. */
    component: (props: PagePropsFor<TPath, TQuery, TParams> & LoaderProps<TLoader>) => ReactNode | Promise<ReactNode>;
    /** `<title>`/`<meta>` for this page: an object, or a function of the loader's props. */
    metadata?: Metadata | ((props: PagePropsFor<TPath, TQuery, TParams> & LoaderProps<TLoader>) => Metadata | Promise<Metadata>);
}

type Merge<A, B> = Omit<A, keyof B> & B;

export interface PageDefinition<TMeta extends { path: string | undefined } = { path: string | undefined }> {
    /** Type-only; never set at runtime. */
    readonly "~tyvo"?: TMeta;
    readonly [PAGE]: true;
    readonly querySchema: Schema | undefined;
    readonly paramSchema: Schema | undefined;
    readonly guards: readonly TyvoGuard<any>[];
    readonly middlewares: readonly TyvoMiddleware<any>[];
    readonly ratelimit: Partial<RatelimitOptions> | false | undefined;
    readonly csp: CspOverride | false | undefined;
    readonly loader: ((request: any, response: TyvoResponse) => MaybePromise<LoaderResult>) | undefined;
    readonly component: (props: any) => ReactNode | Promise<ReactNode>;
    readonly metadata: Metadata | ((props: any) => Metadata | Promise<Metadata>) | undefined;
}

/**
 * High-level page definition for `page.tsx`. A plain component export works too:
 * `export default async function Page({ params }: PageProps) { ... }`.
 *
 * ```tsx
 * export default page({
 *     middlewares: [webAuth],
 *     loader: async (request) => ({ user: request.user }),
 *     component: ({ user }) => <h1>{user.name}</h1>,
 * });
 * ```
 */
export function page<
    const TMiddlewares extends readonly TyvoMiddleware<any>[] = [],
    TLoader extends LoaderResult = {},
    const TPath extends PagePath | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TParams extends Schema | undefined = undefined,
    const TGuards extends readonly TyvoGuard<any>[] = [],
>(options: PageOptions<TMiddlewares, TLoader, TPath, TQuery, TParams, TGuards>): PageDefinition<PageMetaFor<TPath, TQuery, TParams>> {
    if (typeof options?.component !== "function") throw new TypeError("page(): `component` must be a function component.");
    if (options.path !== undefined && (typeof options.path !== "string" || !options.path.startsWith("/"))) {
        throw new TypeError(`page(): \`path\` must be the page's folder path, e.g. "/users/[id]".`);
    }
    const guards = options.guards ?? [];
    for (const entry of guards) {
        if (!isGuard(entry)) throw new TypeError(`page(): every entry of \`guards\` must be created with guard()${isMiddleware(entry) ? " (this one is a middleware: list it in `middlewares`)" : ""}.`);
    }
    const middlewares = options.middlewares ?? [];
    for (const entry of middlewares) {
        if (!isMiddleware(entry)) throw new TypeError(`page(): every entry of \`middlewares\` must be created with middleware()${isGuard(entry) ? " (this one is a guard: list it in `guards`)" : ""}.`);
    }
    for (const name of ["querySchema", "paramSchema"] as const) {
        const schema = options[name];
        if (schema !== undefined && typeof (schema as Schema | undefined)?.safeParseAsync !== "function") throw new TypeError(`page(): \`${name}\` must be a zod schema.`);
    }
    return Object.freeze({
        [PAGE]: true as const,
        [DECLARED_PATH]: options.path,
        querySchema: options.querySchema,
        paramSchema: options.paramSchema as Schema | undefined,
        guards,
        middlewares,
        ratelimit: options.ratelimit,
        csp: parseCspOverride(options.csp, "page() `csp`"),
        loader: options.loader as PageDefinition["loader"],
        component: options.component,
        metadata: options.metadata,
    });
}

/** `page()` with the folder's path filled in: what `"./$types"` exports as `page`. */
export interface BoundPage<TPath extends PagePath> {
    <
        const TMiddlewares extends readonly TyvoMiddleware<any>[] = [],
        TLoader extends LoaderResult = {},
        TQuery extends Schema | undefined = undefined,
        TParams extends Schema | undefined = undefined,
        const TGuards extends readonly TyvoGuard<any>[] = [],
    >(
        options: PageOptions<TMiddlewares, TLoader, TPath, TQuery, TParams, TGuards>,
    ): PageDefinition<PageMetaFor<TPath, TQuery, TParams>>;
}

/** @internal Used by the generated `"./$types"` of each page folder. */
export function bindPage<const TPath extends PagePath>(path: TPath): BoundPage<TPath> {
    return ((options: object) => page({ ...options, path } as never)) as unknown as BoundPage<TPath>;
}

export function isPage(value: unknown): value is PageDefinition {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[PAGE] === true;
}

export type PageRunResult =
    | { response: Response }
    /** `params` / `query` after the page's schemas. */
    | { props: object; params: Readonly<Record<string, unknown>>; query: Readonly<Record<string, unknown>>; headers: Headers | undefined }
    /** notFound() was called in a middleware or the loader: render the nearest not-found.tsx with 404. */
    | { notFound: true; headers: Headers | undefined };

/**
 * `paramSchema` / `querySchema` of a page over the raw values: params that do not validate mean the URL names nothing
 * (`undefined`: not found); an invalid query is a 400.
 */
async function validatePage(
    definition: PageDefinition,
    params: Params,
    query: Query,
): Promise<{ params: Readonly<Record<string, unknown>>; query: Readonly<Record<string, unknown>> } | undefined> {
    let outParams: Readonly<Record<string, unknown>> = params;
    let outQuery: Readonly<Record<string, unknown>> = query;
    if (definition.paramSchema) {
        const result = await parseQuery(definition.paramSchema, params);
        if (!result.success) return undefined;
        outParams = { ...params, ...(result.data as object) };
    }
    if (definition.querySchema) {
        const result = await parseQuery(definition.querySchema, query);
        if (!result.success) {
            const issues: Issue[] = result.error.issues.map((issue) => ({ in: "query", path: issue.path.map(String), message: issue.message, code: issue.code }));
            throw new HttpError(400, "Invalid request", { error: "Invalid request", issues });
        }
        // zod strips unknown keys; merging keeps the others, as in route().
        outQuery = { ...query, ...(result.data as object) };
    }
    return { params: outParams, query: outQuery };
}

/** @internal Rate limit → guards → schemas → middlewares → loader. Used by the RSC renderer. */
export async function runPage(definition: PageDefinition, raw: Request, context: Partial<RouteContext>, runtime: Runtime): Promise<PageRunResult> {
    let headers: Headers | undefined;
    try {
        // Prerendering is not a client request: no rate limit.
        const limit = context.prerender ? undefined : resolveRatelimit(definition.ratelimit, runtime.ratelimit);
        if (limit) headers = await applyRatelimit(runtime, limit, raw, context);

        const request = new TyvoRequest({ raw, body: undefined, params: context.params ?? {}, ip: context.ip ?? "" });
        const state: ChainState = { request, executed: new Set() };
        // Guards first: a page they reject never validates its params or query.
        const rejected = await runSteps(definition.guards, state);
        if (rejected) return { response: applyCookies(finalize(rejected, headers), request.cookies) };
        const validated = await validatePage(definition, request.params, request.query);
        if (!validated) return { notFound: true, headers };
        if (definition.paramSchema || definition.querySchema) state.request = { ...state.request, params: validated.params, query: validated.query };
        const ended = await runSteps(definition.middlewares, state);
        if (ended) return { response: applyCookies(finalize(ended, headers), request.cookies) };
        const chain = state.request;

        let props: object = {};
        if (definition.loader) {
            const result = await definition.loader(chain, new TyvoResponse());
            if (isTyvoResponse(result)) return { response: applyCookies(finalize(result, headers), request.cookies) };
            if (result && typeof result === "object") props = result;
        }
        // Cookies set by middlewares or the loader go out with the rendered page.
        const out = new Headers(headers);
        for (const header of request.cookies._setCookieHeaders()) out.append("set-cookie", header);
        return { props, params: validated.params, query: validated.query, headers: out };
    } catch (error) {
        if (readNavigation(error)?.kind === "not-found") return { notFound: true, headers };
        return { response: finalize(await errorResponse(runtime, error, raw), headers) };
    }
}
