// The rules for app/ files, as types. Each check is `"ok"` or a message naming the file and what to change; the
// generated `.tyvo/types/check.ts` assigns one per export and rule (`export const c0: "ok" = ... as RouteExportCheck<...>`),
// so every broken rule is its own ordinary TypeScript error — in the editor, `tsc`, `tyvo check` and `tyvo build`.
import type { ReactNode } from "react";
import type { Metadata } from "./metadata.js";
import type { PageDefinition } from "./page.js";
import type { ProxyDefinition } from "./proxy.js";
import type { ParamsOf } from "./routes.js";
import type { HttpMethod } from "./shared/conventions.js";
import type { Route, RouteMeta } from "./types.js";

type Methods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
/** `"ok"` when there is no message. */
type Ok<E> = [E] extends [never] ? "ok" : E;
type Component = (props: any) => ReactNode | Promise<ReactNode>;
type Fn = (...args: any[]) => unknown;

/** `"ok"`, or one message per export of `M` that is not in `Allowed`. */
export type UnknownExportsCheck<M, Allowed extends string, F extends string, Rule extends string> = Ok<
    Exclude<keyof M, Allowed> extends infer Name ? (Name extends string ? `${F}: "${Name}" is not a valid export. ${Rule}` : never) : never
>;

// ---- route.ts -------------------------------------------------------------------------------------

type MetaOf<R> = R extends { readonly "~tyvo"?: infer M } ? (M extends RouteMeta ? M : undefined) : undefined;

type RouteExportError<K extends string, R, P extends string, F extends string> = [R] extends [Route]
    ? MetaOf<R> extends infer M extends RouteMeta
        ?
              | ([M["path"]] extends [string]
                    ? [M["path"]] extends [P]
                        ? never
                        : `${F}: ${K} declares path "${M["path"] & string}", but this folder serves "${P}". Use path: "${P}".`
                    : never)
              | ([Exclude<M["paramKeys"], keyof ParamsOf<P>>] extends [never]
                    ? never
                    : `${F}: paramSchema key "${Exclude<M["paramKeys"], keyof ParamsOf<P>> & string}" of ${K} is not a dynamic segment of ${P}.`)
        : never
    : `${F}: ${K} must be a function (request: Request, context: RouteContext) => Response | Promise<Response>. Use route({ ... }) or write one by hand.`;

/**
 * One export of a route.ts (`K`: an HTTP method, or "default"). With `route` from "./$types" the path and
 * `paramSchema` keys are already checked in the file; this also covers `route()` imported from "@tyvo/core" and
 * hand-written functions. `P` is the folder's path, `F` the file.
 */
export type RouteExportCheck<M, K extends string, P extends string, F extends string> = K extends keyof M
    ? K extends "default"
        ? `${F}: route files cannot have a default export. Export named handlers instead (${Methods}).`
        : Ok<RouteExportError<K, M[K], P, F>>
    : "ok";

export type RouteUnknownExportsCheck<M, F extends string> = UnknownExportsCheck<
    M,
    HttpMethod | "default",
    F,
    `Route files may only export ${Methods} (types are fine); move it to another module.`
>;

// ---- page.tsx, layout.tsx, loading.tsx, error.tsx, not-found.tsx -------------------------------------

type Dynamic<P extends string> = [keyof ParamsOf<P>] extends [never] ? false : true;
/** `export const prerender = true` (or a boolean that may be true). */
type Prerendered<M> = "prerender" extends keyof M ? ([M["prerender" & keyof M]] extends [false] ? false : true) : false;

type PageDefaultError<D, P extends string, F extends string> = [D] extends [PageDefinition<any>]
    ? D extends { readonly "~tyvo"?: { path: infer Declared } }
        ? [Declared] extends [string]
            ? [Declared] extends [P]
                ? never
                : `${F}: page() declares path "${Declared}", but this folder serves "${P}". Use path: "${P}".`
            : never
        : never
    : [D] extends [Component]
      ? never
      : `${F}: the default export must be a component or page({ ... }).`;

type NamedError<K extends string, V, M, P extends string, F extends string> = K extends "metadata"
    ? [V] extends [Metadata] ? never : `${F}: "metadata" must be a Metadata object.`
    : K extends "generateMetadata"
      ? [V] extends [Fn] ? never : `${F}: "generateMetadata" must be a function returning Metadata.`
      : K extends "prerender"
        ? [V] extends [boolean]
            ? Prerendered<M> extends true
                ? Dynamic<P> extends true
                    ? "staticParams" extends keyof M
                        ? never
                        : `${F}: ${P} has dynamic segments, so a prerendered page needs export async function staticParams() returning the params to render, e.g. [{ id: "1" }].`
                    : never
                : never
            : `${F}: "prerender" must be true or false.`
        : K extends "revalidate"
          ? [V] extends [number | false]
              ? Prerendered<M> extends true ? never : `${F}: "revalidate" only applies to prerendered pages: add export const prerender = true.`
              : `${F}: "revalidate" must be a number of seconds or false.`
          : K extends "staticParams"
            ? [V] extends [Fn]
                ? Prerendered<M> extends true
                    ? Dynamic<P> extends true ? never : `${F}: "staticParams" is only for pages with dynamic segments; ${P} has none.`
                    : `${F}: "staticParams" only applies to prerendered pages: add export const prerender = true.`
                : `${F}: "staticParams" must be a function returning the params of every page to prerender.`
            : never;

/** One export of a page.tsx (`K`: "default", "metadata", "generateMetadata", "prerender", "revalidate" or "staticParams"). */
export type PageExportCheck<M, K extends string, P extends string, F extends string> = K extends keyof M
    ? Ok<K extends "default" ? PageDefaultError<M[K], P, F> : NamedError<K, M[K], M, P, F>>
    : K extends "default"
      ? `${F}: page.tsx needs a default export: a component or page({ ... }).`
      : "ok";

export type PageUnknownExportsCheck<M, F extends string> = UnknownExportsCheck<
    M,
    "default" | "metadata" | "generateMetadata" | "prerender" | "revalidate" | "staticParams",
    F,
    "page.tsx may only export a default component, metadata, generateMetadata, prerender, revalidate and staticParams (types are fine)."
>;

type ComponentKind = "layout" | "loading" | "error" | "not-found";

/** One export of a layout.tsx ("default", "metadata", "generateMetadata") or loading/error/not-found.tsx ("default"). */
export type ComponentExportCheck<M, Kind extends ComponentKind, K extends string, F extends string> = K extends keyof M
    ? K extends "default"
        ? [M[K]] extends [Component] ? "ok" : `${F}: the default export of ${Kind}.tsx must be a component.`
        : Ok<NamedError<K, M[K], M, string, F>>
    : K extends "default"
      ? `${F}: ${Kind}.tsx needs a default export: a component.`
      : "ok";

export type ComponentUnknownExportsCheck<M, Kind extends ComponentKind, F extends string> = Kind extends "layout"
    ? UnknownExportsCheck<M, "default" | "metadata" | "generateMetadata", F, "layout.tsx may only export a default component, metadata and generateMetadata (types are fine).">
    : UnknownExportsCheck<M, "default", F, `${Kind}.tsx may only have a default export (types are fine).`>;

// ---- proxy.ts ---------------------------------------------------------------------------------------

export type ProxyExportCheck<M, F extends string> = "default" extends keyof M
    ? [M["default" & keyof M]] extends [ProxyDefinition<any>] ? "ok" : `${F}: the default export must be proxy({ guards, middlewares, modifiers }).`
    : `${F}: proxy.ts needs a default export: export default proxy({ middlewares, modifiers }).`;

export type ProxyUnknownExportsCheck<M, F extends string> = UnknownExportsCheck<M, "default", F, "proxy.ts may only have a default export: proxy({ guards, middlewares, modifiers }).">;
