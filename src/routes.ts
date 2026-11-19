// Route paths as types. Shared by `@tyvo/core`, `@tyvo/core/router` and `@tyvo/core/client`, so it must stay browser-safe.
import { parseRoutePath, toPath } from "./shared/conventions.js";

declare global {
    namespace Tyvo {
        /**
         * Every page and route of the app by path (`"/users/[id]"`), written to `.tyvo/types/routes.d.ts` by
         * `tyvo dev`, `build`, `check` and `typegen`. Until then it is empty and paths are plain strings.
         */
        interface Routes {}
        /** The route module of every `route.ts`, by path. Generated with `Routes`; used by `api()`. */
        interface RouteModules {}
        /** The page module of every `page.tsx`, by path. Generated with `Routes`; types params and query of links. */
        interface PageModules {}
        /** The proxy.ts modules wrapping each route (outer first), by path. Generated; types what their middlewares add. */
        interface RouteProxies {}
    }
}

type Registered = [keyof Tyvo.Routes] extends [never] ? false : true;
type PathsOfKind<K> = { [P in keyof Tyvo.Routes]: Tyvo.Routes[P] extends { kind: K } ? P : never }[keyof Tyvo.Routes] & string;

/** Path of any page or route of the app, as written in folder names: `"/users/[id]"`. */
export type AppPath = Registered extends true ? keyof Tyvo.Routes & string : string;
/** Path of a `page.tsx`. */
export type PagePath = Registered extends true ? PathsOfKind<"page"> : string;
/** Path of a `route.ts`. */
export type RoutePath = Registered extends true ? PathsOfKind<"route"> : string;

/** `[id]` -> string, `[...slug]` -> string[], `[[...slug]]` -> string[] | undefined. */
export type Params = Readonly<Record<string, string | string[] | undefined>>;

type Split<S extends string> = S extends "" ? [] : S extends `${infer Head}/${infer Tail}` ? [Head, ...Split<Tail>] : [S];
type SegmentsOf<P extends string> = P extends `/${infer Rest}` ? Split<Rest> : Split<P>;
type ParamOf<S> = S extends `[[...${infer N}]]`
    ? { readonly [K in N]?: string[] }
    : S extends `[...${infer N}]`
      ? { readonly [K in N]: string[] }
      : S extends `[${infer N}]`
        ? { readonly [K in N]: string }
        : {};
type Collect<S extends readonly unknown[], Acc = {}> = S extends readonly [infer Head, ...infer Tail] ? Collect<Tail, Acc & ParamOf<Head>> : Acc;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The params of a path, read from the path itself:
 * `"/users/[id]"` -> `{ id: string }`, `"/docs/[...slug]"` -> `{ slug: string[] }`, `"/shop/[[...slug]]"` -> `{ slug?: string[] }`.
 */
export type ParamsOf<P extends string> = string extends P ? Params : Simplify<Collect<SegmentsOf<P>>>;

// ---- What page() records about a page (read from the generated Tyvo.PageModules) ----------------------------------

/** What `page()` knows about a page at the type level; read by `href()`, `useParams()` and `useQuery()`. */
export interface PageMeta {
    path: string | undefined;
    /** Input types of `paramSchema` / `querySchema` (what a link carries), `undefined` without one. */
    params: unknown;
    query: unknown;
    /** What the page receives: path params with `paramSchema`'s output over them, and the query (with `querySchema`'s output). */
    paramsOut: unknown;
    queryOut: unknown;
}

/** The `page()` meta of a page path, or `undefined` for a plain component page (or before types are generated). */
export type PageMetaOf<P> = P extends keyof Tyvo.PageModules
    ? Tyvo.PageModules[P] extends { default: infer D }
        ? D extends { readonly "~tyvo"?: infer M }
            ? M extends PageMeta
                ? M
                : undefined
            : undefined
        : undefined
    : undefined;

// ---- Links ---------------------------------------------------------------------------------------------------------

/**
 * A URL of a page of the app, built by `href()`. `<Link>`, `router.push()` and `redirect()` accept it as is; any other
 * string must be a literal they can check against the app's pages.
 */
// A string-keyed brand (not a unique symbol): the published type declarations hold more than one copy of this file.
export type Href = string & { readonly "~tyvoHref": true };

type External = `http://${string}` | `https://${string}` | `//${string}` | `mailto:${string}` | `tel:${string}`;
type QueryLess<H extends string> = H extends `${infer Path}?${string}` ? Path : H;
type PathPart<H extends string> = H extends `${infer Path}#${string}` ? QueryLess<Path> : QueryLess<H>;
/** One URL segment: a literal, non-empty, not a `[param]` placeholder. A `string` (unknown text) could hold a "/". */
type IsSegment<S extends string> = string extends S ? false : S extends "" ? false : S extends `${string}${"[" | "]"}${string}` ? false : true;
type AllSegments<U extends readonly string[]> = U extends readonly [infer Head extends string, ...infer Tail extends string[]]
    ? IsSegment<Head> extends true
        ? AllSegments<Tail>
        : false
    : true;
/** Whether the URL segments `U` are served by the page path segments `P`. */
type Matches<U extends readonly string[], P extends readonly string[]> = P extends readonly [infer PH extends string, ...infer PT extends string[]]
    ? PH extends `[[...${string}]]`
        ? AllSegments<U>
        : PH extends `[...${string}]`
          ? U extends readonly [string, ...string[]]
              ? AllSegments<U>
              : false
          : U extends readonly [infer UH extends string, ...infer UT extends string[]]
            ? PH extends `[${string}]`
                ? IsSegment<UH> extends true
                    ? Matches<UT, PT>
                    : false
                : [UH] extends [PH]
                  ? [PH] extends [UH]
                      ? Matches<UT, PT>
                      : false
                  : false
            : false
    : U extends readonly []
      ? true
      : false;
type MatchingPage<H extends string> = { [P in PagePath]: Matches<SegmentsOf<PathPart<H>>, SegmentsOf<P>> extends true ? P : never }[PagePath];
type HrefError<M extends string> = `Invalid href: ${M}`;

/**
 * Checks a link target (`<Link href>`, `router.push()`, `redirect()`): `H` itself when it is valid, otherwise an error
 * message type the argument is not assignable to. Valid: a literal URL of a page of the app (`"/users/42"`, with an
 * optional `?query` / `#hash`; each segment literal and non-empty), an `Href` from `href()`, `#hash`, or an absolute
 * URL. A plain `string` is refused: build it with `href()` so its path and params are checked. Before the routes are
 * generated, any string.
 */
export type CheckHref<H extends string> = Registered extends false
    ? H
    : H extends Href
      ? H
      : string extends H
        ? HrefError<"build links from variables with href() (or pass a URL object for external addresses), so they are checked against the app's pages">
        : H extends External | `#${string}`
          ? H
          : H extends `/${string}`
            ? [MatchingPage<H>] extends [never]
                ? HrefError<`"${H}" matches no page of the app`>
                : H
            : HrefError<`"${H}" must start with "/" or "#", or be an absolute URL`>;

// ---- href() --------------------------------------------------------------------------------------------------------

/** A value in a URL: dates become ISO 8601, everything else `String(value)` (the spelling Tyvo's schemas accept). */
export type UrlValue = string | number | boolean | bigint | Date;

type SchemaInput<P, K extends "params" | "query"> = PageMetaOf<P> extends PageMeta ? (PageMetaOf<P>[K] extends object ? PageMetaOf<P>[K] : undefined) : undefined;
type PathParamsInput<P extends string> = { readonly [K in keyof ParamsOf<P>]: ParamsOf<P>[K] extends string ? string | number : readonly (string | number)[] };

/**
 * What `href()` accepts for a path's params: for a page with `paramSchema`, the schema's input for its keys (`id: number`),
 * otherwise strings (numbers are converted).
 */
export type ParamsInput<P extends string> = string extends P
    ? Readonly<Record<string, UrlValue | readonly UrlValue[] | undefined>>
    : SchemaInput<P, "params"> extends object
      ? Simplify<Omit<PathParamsInput<P>, keyof SchemaInput<P, "params">> & SchemaInput<P, "params">>
      : PathParamsInput<P>;

type LooseQuery = Readonly<Record<string, UrlValue | readonly UrlValue[] | undefined>>;
/** What `href()` accepts as the query of a path: a page's `querySchema` input, or any values. */
export type QueryInput<P extends string> = SchemaInput<P, "query"> extends object ? SchemaInput<P, "query"> : LooseQuery;

export interface HrefOptions<TQuery = LooseQuery> {
    /** Appended as search params; arrays repeat the key, `undefined` is skipped. */
    query?: TQuery;
    hash?: string;
}

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type OptionsArg<P extends string> = [RequiredKeys<QueryInput<P>>] extends [never]
    ? [options?: HrefOptions<QueryInput<P>>]
    : [options: HrefOptions<QueryInput<P>> & { query: QueryInput<P> }];
type HrefArgs<P extends string> = [keyof ParamsOf<P>] extends [never] ? [params?: ParamsInput<P>, ...options: OptionsArg<P>] : [params: ParamsInput<P>, ...options: OptionsArg<P>];

/** What `href()` returns: an `Href` for a page (accepted by `<Link>`), a plain string for a route. */
export type HrefResult<P extends string> = P extends PagePath ? Href : string;

/**
 * The URL of a page or route, from its path and params, checked against the app's routes. For a page with
 * `paramSchema` / `querySchema`, params and query take the schemas' input types:
 *
 * ```ts
 * href("/users/[id]", { id: 42 });                         // "/users/42"
 * href("/docs/[...slug]", { slug: ["a", "b"] });          // "/docs/a/b"
 * href("/search", {}, { query: { q: "tyvo" } });          // "/search?q=tyvo"
 * ```
 */
export function href<const P extends AppPath>(path: P, ...[params, options]: HrefArgs<P>): HrefResult<P> {
    const strings: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries((params ?? {}) as Record<string, unknown>)) {
        strings[name] = Array.isArray(value) ? value.map(urlValue) : value === undefined ? undefined : urlValue(value);
    }
    let url = toPath(parseRoutePath(path), strings);
    if (options?.query) url += searchOf(options.query as LooseQuery);
    if (options?.hash) url += `#${options.hash.replace(/^#/, "")}`;
    return url as HrefResult<P>;
}

function urlValue(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

/** `?a=1&b=2` (empty string when nothing is set). */
export function searchOf(query: Readonly<Record<string, unknown>>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) search.append(key, urlValue(item));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
}

/** A link target as a string: `URL` objects (external addresses built at runtime) by their `href`. */
export function hrefString(target: string | URL): string {
    return typeof target === "string" ? target : target.href;
}
