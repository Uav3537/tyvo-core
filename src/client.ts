// `@tyvo/core/client` — calls the app's route.ts endpoints with their types (params, query, body and the response the
// handler returns), like tRPC or Hono's RPC client. Works in the browser and on the server (give it a `baseUrl` there).
import { HTTP_METHODS, type HttpMethod } from "./shared/conventions.js";
import { href, searchOf, type ParamsOf, type RoutePath, type UrlValue } from "./routes.js";
import type { RouteMeta } from "./types.js";

type ModuleOf<P extends string> = P extends keyof Tyvo.RouteModules ? Tyvo.RouteModules[P] : Partial<Record<HttpMethod, unknown>>;
/** What `route()` recorded about an export; `undefined` for hand-written functions. */
type MetaOf<R> = R extends { readonly "~tyvo"?: infer M } ? (M extends RouteMeta ? M : undefined) : undefined;
type Or<T, Fallback> = [T] extends [undefined] ? Fallback : T;

type LooseQuery = Readonly<Record<string, UrlValue | readonly UrlValue[] | undefined>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type PathParamsInput<P extends string> = string extends P
    ? Readonly<Record<string, UrlValue | readonly UrlValue[] | undefined>>
    : { readonly [K in keyof ParamsOf<P>]: ParamsOf<P>[K] extends string ? string | number : readonly (string | number)[] };
/** The path's params, with the route's `paramSchema` input over them (`id: number | "me"`): what the route accepts. */
type RouteParamsInput<P extends string, R> = MetaOf<R> extends RouteMeta
    ? MetaOf<R>["params"] extends object
        ? Simplify<Omit<PathParamsInput<P>, keyof MetaOf<R>["params"]> & MetaOf<R>["params"]>
        : PathParamsInput<P>
    : PathParamsInput<P>;
type ParamsPart<P extends string, R> = [keyof ParamsOf<P>] extends [never] ? { params?: RouteParamsInput<P, R> } : { params: RouteParamsInput<P, R> };

/** What a call takes: the path's params, and the query and body the route's schemas accept (their input types). */
export type ApiInput<P extends string, R> = ParamsPart<P, R> & {
    query?: Or<MetaOf<R> extends RouteMeta ? MetaOf<R>["query"] : undefined, LooseQuery>;
    /** Sent as JSON, unless it is a string, FormData, Blob, URLSearchParams or bytes. */
    body?: Or<MetaOf<R> extends RouteMeta ? MetaOf<R>["body"] : undefined, unknown>;
    headers?: HeadersInit;
    signal?: AbortSignal;
    /** Anything else for `fetch`. */
    init?: Omit<RequestInit, "method" | "body" | "headers" | "signal">;
};

/** A response: `data` is what the handler returns (`response.json(data)`) when `ok`, anything otherwise (errors from `onError`). */
export type ApiResult<T> = { ok: true; status: number; data: T; response: Response } | { ok: false; status: number; data: unknown; response: Response };

type DataOf<R> = MetaOf<R> extends RouteMeta ? MetaOf<R>["response"] : unknown;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Call<P extends string, R> = (...input: [RequiredKeys<ApiInput<P, R>>] extends [never] ? [input?: ApiInput<P, R>] : [input: ApiInput<P, R>]) => Promise<ApiResult<DataOf<R>>>;

/** The methods a route.ts exports, each a typed call. */
export type ApiRoute<P extends string> = { [M in keyof ModuleOf<P> & HttpMethod]: Call<P, ModuleOf<P>[M]> };

export interface ApiOptions {
    /** Prefix of every URL, e.g. `http://localhost:3000` on the server. Default: `""` (same origin, browser only). */
    baseUrl?: string;
    /** Headers sent with every call (a call's own `headers` win). */
    headers?: HeadersInit;
    /** Default: the global `fetch`. */
    fetch?: typeof fetch;
}

export type Api = <const P extends RoutePath>(path: P) => ApiRoute<P>;

type AnyInput = Partial<ApiInput<string, unknown>>;

/**
 * A client for the app's route.ts endpoints. Paths, params, query, body and response data are typed from the routes
 * themselves (generated into `.tyvo/types/` by `tyvo dev` / `tyvo typegen`):
 *
 * ```ts
 * const api = createApi();
 * const result = await api("/api/users/[id]").GET({ params: { id: 42 } });
 * if (result.ok) console.log(result.data.name);
 * ```
 */
export function createApi(options: ApiOptions = {}): Api {
    const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    return ((path: string) => {
        const methods: Partial<Record<HttpMethod, (input?: AnyInput) => Promise<ApiResult<unknown>>>> = {};
        for (const method of HTTP_METHODS) methods[method] = (input = {}) => call(method, path, input);
        return methods;
    }) as Api;

    async function call(method: HttpMethod, path: string, input: AnyInput): Promise<ApiResult<unknown>> {
        const url = baseUrl + href(path as never, input.params as never) + searchOf((input.query as LooseQuery | undefined) ?? {});
        const headers = new Headers(options.headers);
        for (const [name, value] of new Headers(input.headers)) headers.set(name, value);
        let body: BodyInit | undefined;
        if (input.body !== undefined) {
            if (isBodyInit(input.body)) body = input.body;
            else {
                body = JSON.stringify(input.body);
                if (!headers.has("content-type")) headers.set("content-type", "application/json");
            }
        }
        const response = await (options.fetch ?? fetch)(url, { ...input.init, method, headers, body, signal: input.signal });
        const data = method === "HEAD" || response.status === 204 || response.status === 205 ? undefined : await readBody(response.clone());
        return { ok: response.ok, status: response.status, data, response } as ApiResult<unknown>;
    }
}

/** `createApi()` with same-origin URLs: for client components. */
export const api: Api = createApi();

async function readBody(response: Response): Promise<unknown> {
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) return response.json();
    if (type.startsWith("text/") || type === "") return response.text();
    return response.blob();
}

function isBodyInit(value: unknown): value is BodyInit {
    return (
        typeof value === "string" ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        (typeof Blob !== "undefined" && value instanceof Blob) ||
        (typeof FormData !== "undefined" && value instanceof FormData) ||
        value instanceof URLSearchParams ||
        (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    );
}
