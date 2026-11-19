// Bundled into `.tyvo/rsc.mjs` with the "react-server" condition. `@tyvo/core/server` stays external so this shares the
// same runtime (config, rate-limit storage) as the route handlers; `@tyvo/core/router` becomes client references.
import { Fragment, Suspense, createElement, type ComponentType, type ReactNode } from "react";
// @ts-expect-error no type declarations are published for react-server-dom-turbopack
import { decodeReply, renderToReadableStream } from "react-server-dom-turbopack/server.edge";
import { ErrorBoundary, NotFoundBoundary, RedirectBoundary, RouterProvider } from "@tyvo/core/router";
import {
    checkDeclaredPath,
    declaredPath,
    emit,
    errorToResponse,
    routePathOfFile,
    getRuntime,
    isPage,
    mergeMetadata,
    metadataTags,
    readNavigation,
    resolveCsp,
    runPage,
    toQuery,
    type CspOptions,
    type Metadata,
    type RouteContext,
} from "@tyvo/core/server";
import type { ReactManifest } from "./manifest.js";

type Module = Record<string, unknown>;

/** The special files of one folder level (`app/`, `app/users/`, ...). */
export interface RscSegment {
    layout?: Module;
    loading?: Module;
    error?: Module;
    notFound?: Module;
}

export interface RscPage {
    file: string;
    page: Module;
    /** One per folder level from `app/` down to the page's folder. */
    segments: RscSegment[];
}

export type RscResult =
    | { response: Response }
    | { flight: ReadableStream<Uint8Array>; headers: Headers | undefined; csp: CspOptions | undefined; status: number };

/** A page's `export const prerender` / `export const revalidate`. */
export interface RscPageInfo {
    file: string;
    prerender: boolean;
    /** Seconds after which a request regenerates the prerendered page in the background; false: never. */
    revalidate: number | false;
}

export interface Rsc {
    pages: readonly RscPageInfo[];
    /** The page's `staticParams()`, or undefined when it has none. */
    staticParams(index: number): Promise<unknown>;
    render(index: number, request: Request, context: RouteContext, manifest: ReactManifest, options?: { notFound?: boolean }): Promise<RscResult>;
    /** For URLs that match nothing: `app/not-found.tsx` inside the root layout, or undefined without one. */
    renderNotFound(request: Request, manifest: ReactManifest): Promise<RscResult | undefined>;
    /** POST /_tyvo/action. */
    action(request: Request, manifest: ReactManifest): Promise<Response>;
}

type BundlerConfig = Record<string, { id: string; chunks: string[]; name: string }>;

export function createRSC(pages: RscPage[], root: RscSegment, actions: Record<string, Module>): Rsc {
    const globals = globalThis as Record<string, unknown>;
    // Server references inside action arguments resolve through the same loader the SSR bundle installs.
    globals.__tyvo_action_modules = actions;
    globals.__turbopack_require__ ??= (id: string) => actions[id] ?? missingModule(id);

    const bundlerConfigs = new WeakMap<ReactManifest, BundlerConfig>();
    const bundlerConfigFor = (manifest: ReactManifest) => {
        let config = bundlerConfigs.get(manifest);
        if (!config) {
            config = {};
            for (const [id, url] of Object.entries(manifest.clients)) config[id] = { id: url, chunks: [url], name: "*" };
            bundlerConfigs.set(manifest, config);
        }
        return config;
    };
    const serverManifest = Object.fromEntries(Object.keys(actions).map((id) => [id, { id, chunks: [], name: "*" }]));

    const flightOf = (tree: unknown, manifest: ReactManifest, label: string): ReadableStream<Uint8Array> =>
        renderToReadableStream(tree, bundlerConfigFor(manifest), {
            onError(error: unknown) {
                // redirect()/notFound() travel to the client as their digest; everything else is logged.
                if (readNavigation(error)) return (error as { digest: string }).digest;
                emit({ type: "message", level: "error", message: `Error while rendering ${label}`, error });
                return undefined;
            },
        });

    async function notFoundResult(segments: RscSegment[], request: Request, params: RouteContext["params"], manifest: ReactManifest, headers?: Headers): Promise<RscResult> {
        // Nearest not-found.tsx from the page's folder upwards; without one, onError in config.ts answers the 404.
        let level = segments.length - 1;
        while (level >= 0 && !segments[level]!.notFound) level--;
        if (level < 0) return { response: await errorToResponse(new NotFoundError(), request) };
        const scope = segments.slice(0, level + 1);
        const url = new URL(request.url);
        const leaf = createElement(scope[level]!.notFound!.default as ComponentType, {});
        const query = toQuery(url.searchParams);
        const metadata = await resolveMetadata(scope, undefined, { params, query });
        const tree = buildTree(scope, leaf, { url, path: undefined, params, pageParams: params, pageQuery: query, metadata, manifest });
        return { flight: flightOf(tree, manifest, "not-found"), headers, csp: resolveCsp(undefined, getRuntime().csp), status: 404 };
    }

    return {
        pages: pages.map(({ file, page }) => pageInfo(file, page)),

        async staticParams(index) {
            const fn = pages[index]?.page.staticParams;
            return typeof fn === "function" ? await fn() : undefined;
        },

        async render(index, request, context, manifest, options = {}) {
            const entry = pages[index];
            if (!entry) throw new Error(`Unknown page index ${index}.`);
            if (options.notFound) return notFoundResult(entry.segments, request, context.params, manifest);

            const exported = entry.page.default;
            if (!isPage(exported) && typeof exported !== "function") {
                throw new TypeError(`${entry.file}: the default export must be a component or page({ ... }).`);
            }
            // Without page() the default rate limit still applies (no middlewares, no loader).
            const definition = isPage(exported)
                ? exported
                : ({ middlewares: [], ratelimit: undefined, loader: undefined, component: exported, metadata: undefined, csp: undefined, querySchema: undefined, paramSchema: undefined, guards: [] } as never);
            const result = await runPage(definition, request, context, getRuntime());
            if ("response" in result) return result;
            if ("notFound" in result) return notFoundResult(entry.segments, request, context.params, manifest, result.headers);

            const url = new URL(request.url);
            // params / query as the page's schemas returned them (the raw values without schemas).
            const { params, query } = result;
            const props = { ...result.props, params, query };
            const component = (isPage(exported) ? exported.component : exported) as ComponentType<any>;
            // Keyed by path: another URL remounts the page (fresh client state) while layouts keep theirs.
            const leaf = createElement(component, { ...props, key: url.pathname });

            let pageMetadata = await metadataOf(entry.page, { params, query });
            if (isPage(exported) && exported.metadata) {
                const own = typeof exported.metadata === "function" ? await exported.metadata(props) : exported.metadata;
                pageMetadata = { ...pageMetadata, ...own };
            }
            // Layouts get the raw segments of their folder: the page's schemas belong to the page.
            const raw = { params: context.params, query: toQuery(url.searchParams) };
            const metadata = await resolveMetadata(entry.segments, pageMetadata, raw);
            const tree = buildTree(entry.segments, leaf, { url, path: routePathOfFile(entry.file) ?? undefined, params: context.params, pageParams: params, pageQuery: query, metadata, manifest });
            const csp = resolveCsp(isPage(exported) ? exported.csp : undefined, getRuntime().csp);
            return { flight: flightOf(tree, manifest, entry.file), headers: result.headers, csp, status: 200 };
        },

        async renderNotFound(request, manifest) {
            if (!root.notFound) return undefined;
            return notFoundResult([root], request, {}, manifest);
        },

        async action(request, manifest) {
            const id = request.headers.get("x-tyvo-action") ?? "";
            const separator = id.lastIndexOf("#");
            const action = separator === -1 ? undefined : actions[id.slice(0, separator)]?.[id.slice(separator + 1)];
            if (typeof action !== "function") return errorToResponse(new NotFoundError(), request);

            const isForm = request.headers.get("content-type")?.startsWith("multipart/form-data");
            const args: unknown[] = await decodeReply(isForm ? await request.formData() : await request.text(), serverManifest);

            let model: { value: Promise<unknown>; redirect?: string };
            try {
                model = { value: Promise.resolve(await (action as (...args: unknown[]) => unknown)(...args)) };
            } catch (error) {
                const navigation = readNavigation(error);
                if (navigation?.kind === "redirect") model = { value: Promise.resolve(undefined), redirect: navigation.url };
                else {
                    // Rejected inside the payload: the caller's `await` throws (message hidden in production).
                    const rejected = Promise.reject(error);
                    rejected.catch(() => {});
                    model = { value: rejected };
                }
            }
            return new Response(flightOf(model, manifest, `action ${id}`), { headers: { "content-type": "text/x-component; charset=utf-8" } });
        },
    };
}

/** Checks the prerender exports once, when the bundle loads (the generated .tyvo/types/check.ts reports them earlier). */
function pageInfo(file: string, page: Module): RscPageInfo {
    const actual = routePathOfFile(file);
    if (actual !== null) checkDeclaredPath(`${file}: page()`, declaredPath(page.default), actual);
    const { prerender = false, revalidate = false, staticParams } = page as { prerender?: unknown; revalidate?: unknown; staticParams?: unknown };
    if (typeof prerender !== "boolean") throw new TypeError(`${file}: "prerender" must be true or false.`);
    if (revalidate !== false && !(typeof revalidate === "number" && revalidate > 0 && Number.isFinite(revalidate))) {
        throw new TypeError(`${file}: "revalidate" must be a number of seconds (> 0) or false.`);
    }
    if (staticParams !== undefined && typeof staticParams !== "function") throw new TypeError(`${file}: "staticParams" must be a function.`);
    if (!prerender && (page.revalidate !== undefined || staticParams !== undefined)) {
        throw new TypeError(`${file}: "revalidate" and "staticParams" only apply to prerendered pages; add export const prerender = true.`);
    }
    return { file, prerender, revalidate: revalidate as number | false };
}

class NotFoundError extends Error {
    readonly digest = "TYVO_NOT_FOUND";
}

function missingModule(id: string): never {
    throw new Error(`[tyvo] module "${id}" is not registered.`);
}

type MetadataContext = { params: Readonly<Record<string, unknown>>; query: Readonly<Record<string, unknown>> };

async function metadataOf(module: Module | undefined, context: MetadataContext): Promise<Metadata | undefined> {
    if (!module) return undefined;
    if (typeof module.generateMetadata === "function") return (await module.generateMetadata(context)) as Metadata;
    return module.metadata as Metadata | undefined;
}

async function resolveMetadata(segments: RscSegment[], page: Metadata | undefined, context: MetadataContext) {
    const levels = await Promise.all(segments.map((segment) => metadataOf(segment.layout, context)));
    return mergeMetadata([...levels, page]);
}

interface TreeOptions {
    url: URL;
    /** The page's folder path, for useParams(path) / useQuery(path); undefined for a not-found page. */
    path: string | undefined;
    params: RouteContext["params"];
    pageParams: Readonly<Record<string, unknown>>;
    pageQuery: Readonly<Record<string, unknown>>;
    metadata: ReturnType<typeof mergeMetadata>;
    manifest: ReactManifest;
}

/**
 * Layout > ErrorBoundary(error.tsx) > Suspense(loading.tsx) > NotFoundBoundary(not-found.tsx) > ... > page, per folder.
 * Metadata and stylesheets go into the root layout's children; React hoists them into <head>.
 */
function buildTree(segments: RscSegment[], leaf: ReactNode, { url, path, params, pageParams, pageQuery, metadata, manifest }: TreeOptions): ReactNode {
    let node = leaf;
    for (let level = segments.length - 1; level >= 0; level--) {
        const segment = segments[level]!;
        if (segment.notFound) node = createElement(NotFoundBoundary, { fallback: createElement(segment.notFound.default as ComponentType, {}) }, node);
        if (segment.loading) node = createElement(Suspense, { fallback: createElement(segment.loading.default as ComponentType, {}) }, node);
        if (segment.error) node = createElement(ErrorBoundary, { errorComponent: segment.error.default as ComponentType<any> }, node);
        if (level === 0) node = createElement(Fragment, null, ...headTags(metadata, manifest), node);
        if (segment.layout) node = createElement(segment.layout.default as ComponentType<any>, { params }, node);
    }
    return createElement(RouterProvider, { pathname: url.pathname, search: url.search, path, params, pageParams, pageQuery }, createElement(RedirectBoundary, null, node));
}

function headTags({ metadata, title }: ReturnType<typeof mergeMetadata>, manifest: ReactManifest): ReactNode[] {
    const tags: ReactNode[] = metadataTags(metadata, title).map((tag, index) =>
        tag.tag === "title" ? createElement("title", { key: `m${index}` }, tag.text) : createElement(tag.tag, { key: `m${index}`, ...tag.attributes }),
    );
    for (const href of manifest.css) tags.push(createElement("link", { key: href, rel: "stylesheet", href, precedence: "default" }));
    return tags;
}
