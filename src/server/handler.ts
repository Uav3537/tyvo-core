import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { readLimited } from "../body.js";
import { cacheSlot } from "../cache.js";
import { emit, type RequestLog } from "../log.js";
import { HANDLES_PREFLIGHT, corsHeaders, isPreflight, preflightResponse } from "../cors.js";
import { declaredPath } from "../route.js";
import { isProxy, runProxied, type ProxyDefinition } from "../proxy.js";
import { createNonce, cspHeader, cspHeaders } from "../csp.js";
import { resolveIp } from "../ip.js";
import { readNavigation } from "../navigation.js";
import { applyRatelimit, toErrorResponse } from "../pipeline.js";
import { ACTION_HEADER, ACTION_PATH, DEV_PATH, RSC_CONTENT_TYPE, RSC_HEADER, STATIC_PREFIX, type ReactManifest } from "../react/manifest.js";
import type { Rsc, RscResult } from "../react/rsc.js";
import type { Ssr } from "../react/ssr.js";
import { HttpError, TyvoResponse } from "../response.js";
import { configure, getRuntime, type Runtime } from "../runtime.js";
import { HTTP_METHODS, isHttpMethod, type HttpMethod } from "../shared/conventions.js";
import type { Params, Route, RouteContext, TyvoConfig } from "../types.js";
import { Router, pathKey, toPath, type RouteEntry } from "./router.js";
import { isStaticStatus, readStatic, type StaticBuild, type StaticPage, type StaticVariant } from "./static.js";

export interface RouteModule {
    file: string;
    module: Record<string, unknown>;
    /** The proxy.ts modules wrapping this route, outer first. */
    proxies?: { file: string; module: Record<string, unknown> }[];
}

/** React side of the build: `.tyvo/rsc.mjs`, `.tyvo/ssr.mjs` and the client manifest. */
export interface ReactBundles {
    rsc: Rsc;
    ssr: Ssr;
    manifest: ReactManifest;
    /** Directory served under `/_tyvo/static/`. */
    staticDir: string;
}

export interface HandlerOptions {
    routes: RouteModule[];
    /** Page files, in the same order as the RSC bundle's pages. */
    pages?: string[];
    /** Loaded on the first page request. */
    react?: () => Promise<ReactBundles>;
    /** The `config.ts` module. Required: every export is checked by `configure()`. */
    config: TyvoConfig;
    /** `public/`: files served as-is at the site root when no route matches. */
    publicDir?: string;
    dev?: boolean;
    /** Development only: what the browser should do with this build ("refresh" keeps client state). */
    devUpdate?: "refresh" | "reload";
    /** `.tyvo/prerender/`: pages prerendered by `tyvo build`, served without rendering. */
    prerenderDir?: string;
}

export interface RequestInfo {
    ip: string;
}

export type FetchHandler = (request: Request, info?: RequestInfo) => Promise<Response>;

type MethodTable = Partial<Record<HttpMethod, Route>>;
type Endpoint = { kind: "route"; methods: MethodTable; proxies: ProxyDefinition[] } | { kind: "page"; index: number };

/** What the request log entry says about how a request was answered; filled in while dispatching. */
type RequestMeta = Pick<RequestLog, "kind" | "pattern" | "action" | "prerendered" | "ip">;

const PAGE_METHODS: HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

/** Origin of the request a page is prerendered with (there is no client request at build time). */
const PRERENDER_ORIGIN = "http://localhost";

// Tags of the cache() data read while a page is prerendered. One store per process, shared by every copy of Tyvo.
const TAG_SCOPE = Symbol.for("tyvo.cache.tags");
const tagScope: AsyncLocalStorage<Set<string>> = ((globalThis as Record<symbol, unknown>)[TAG_SCOPE] ??= new AsyncLocalStorage<Set<string>>()) as AsyncLocalStorage<Set<string>>;
cacheSlot().collect ??= (tags) => {
    const store = tagScope.getStore();
    if (store) for (const tag of tags) store.add(tag);
};

export interface Handler extends FetchHandler {
    router: Router<Endpoint>;
    /** Renders every page with `export const prerender = true` (for `tyvo build`) and serves them from now on. */
    prerender(): Promise<StaticBuild>;
}

/** Builds a Web-standard `(Request) => Response` handler from the bundled routes, pages and `config.ts`. */
export function createHandler({ routes, pages = [], react, config, publicDir, dev = false, devUpdate = "reload", prerenderDir }: HandlerOptions): Handler {
    const runtime = configure(config);
    const router = new Router<Endpoint>();
    for (const { file, module, proxies = [] } of routes) {
        const chain = proxies.map(({ file: proxyFile, module: proxyModule }) => {
            if (!isProxy(proxyModule.default)) throw new TypeError(`${proxyFile}: the default export must be proxy({ guards, middlewares, modifiers }).`);
            return proxyModule.default;
        });
        const entry = router.add(file, { kind: "route", methods: collectMethods(file, module), proxies: chain });
        if (entry && entry.value.kind === "route") {
            for (const [name, route] of Object.entries(entry.value.methods)) checkDeclaredPath(`${file}: ${name}`, declaredPath(route), entry.path);
        }
    }
    const pageEntries = pages.map((file, index) => router.add(file, { kind: "page", index }));

    let bundles: Promise<ReactBundles> | undefined;
    const loadReact = () => {
        if (!react) throw new Error("This build has no pages.");
        return (bundles ??= react());
    };

    // ---- Prerendered pages -------------------------------------------------------------------------------
    const prerendered = (!dev && prerenderDir && readStatic(prerenderDir)) || undefined;
    const placeholder = prerendered?.placeholder ?? `TYVONONCE${randomBytes(12).toString("hex")}`;
    const statics = new Map<string, StaticPage>(prerendered?.pages.map((page) => [pathKey(page.path), page]));
    const regenerating = new Map<string, Promise<void>>();

    const renderStatic = async (index: number, path: string, params: Params): Promise<StaticPage> => {
        const reactBundles = await loadReact();
        const entry = pageEntries[index];
        if (!entry) throw new Error(`Page ${pages[index]} is not routed (private folder).`);
        const url = new URL(path, PRERENDER_ORIGIN);
        const context: RouteContext = { params, ip: "", pattern: entry.pattern, prerender: true };
        const tags = new Set<string>();
        const [html, flight] = await tagScope.run(tags, () =>
            Promise.all([
                staticVariant(renderPage(reactBundles, index, new Request(url, { headers: { accept: "text/html" } }), context, dev, placeholder), true),
                staticVariant(renderPage(reactBundles, index, new Request(url, { headers: { [RSC_HEADER]: "1" } }), context, dev, placeholder), false),
            ]),
        );
        const revalidate = reactBundles.rsc.pages[index]!.revalidate;
        return { path, index, params, revalidate, tags: [...tags], generatedAt: Date.now(), html, flight };
    };

    /** Regenerates in the background; the current version is served until the new one is ready. */
    const regenerate = (key: string, queue: boolean): Promise<void> => {
        const running = regenerating.get(key);
        // A timed refresh joins a running one; revalidatePath()/revalidateTag() wait for it and render again,
        // so the data they were called for is in the result.
        if (running && !queue) return running;
        const next = (running ?? Promise.resolve()).then(async () => {
            const current = statics.get(key);
            if (!current) return;
            try {
                const page = await renderStatic(current.index, current.path, current.params);
                if (!isStaticStatus(page.html.status)) throw new Error(`answered ${page.html.status}`);
                statics.set(key, page);
            } catch (error) {
                emit({ type: "message", level: "error", message: `Regenerating ${current.path} failed; the previous version stays`, error });
            }
        });
        const tracked = next.finally(() => {
            if (regenerating.get(key) === tracked) regenerating.delete(key);
        });
        regenerating.set(key, tracked);
        return tracked;
    };

    const serveStatic = (page: StaticPage, request: Request): Response => {
        if (page.revalidate !== false && Date.now() - page.generatedAt > page.revalidate * 1000) void regenerate(pathKey(page.path), false);
        const variant = request.headers.get(RSC_HEADER) ? page.flight : page.html;
        // A fresh nonce per response, as for rendered pages.
        const nonce = createNonce();
        const headers = new Headers(variant.headers.map(([name, value]) => [name, value.replaceAll(placeholder, nonce)]));
        const body = typeof variant.body === "string" ? variant.body.replaceAll(placeholder, nonce) : variant.body;
        return new Response(variant.status === 204 || (variant.status >= 300 && variant.status < 400) ? null : body, { status: variant.status, headers });
    };

    cacheSlot().pages.add({
        revalidatePath: (path) => {
            const key = pathKey(new URL(path, PRERENDER_ORIGIN).pathname);
            return statics.has(key) ? regenerate(key, true) : Promise.resolve();
        },
        revalidateTag: async (tag) => {
            await Promise.all([...statics].filter(([, page]) => page.tags.includes(tag)).map(([key]) => regenerate(key, true)));
        },
    });

    const prerender = async (): Promise<StaticBuild> => {
        if (!react) return { placeholder, pages: [] };
        const reactBundles = await loadReact();
        const rendered: StaticPage[] = [];
        for (const [index, info] of reactBundles.rsc.pages.entries()) {
            if (!info.prerender) continue;
            const entry = pageEntries[index];
            if (!entry) continue;
            for (const params of await staticParamsOf(reactBundles, index, entry)) {
                const path = toPath(entry.segments, params);
                // A more specific route (e.g. a static folder next to [id]) would serve this URL instead.
                if (router.match(path)?.entry !== entry) throw new Error(`${info.file}: staticParams() returned ${JSON.stringify(params)}, but ${path} is served by another route.`);
                const page = await renderStatic(index, path, params);
                if (!isStaticStatus(page.html.status)) {
                    throw new Error(`${info.file}: prerendering ${path} answered ${page.html.status}. Prerendered pages must render (200), call notFound() or redirect.`);
                }
                statics.set(pathKey(path), page);
                rendered.push(page);
            }
        }
        return { placeholder, pages: rendered };
    };
    // -------------------------------------------------------------------------------------------------------

    /** Every request is logged (`loggers` in config.ts) once its response is ready. */
    const handle = async (request: Request, info: RequestInfo = { ip: "" }): Promise<Response> => {
        const started = performance.now();
        const meta: RequestMeta = { kind: "not-found", pattern: undefined, action: undefined, prerendered: false, ip: info.ip };
        const response = await dispatch(request, info, meta);
        const url = new URL(request.url);
        emit({
            type: "request",
            level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
            method: request.method.toUpperCase(),
            path: url.pathname + url.search,
            status: response.status,
            duration: performance.now() - started,
            request,
            ...meta,
        });
        return response;
    };

    const dispatch = async (request: Request, info: RequestInfo, meta: RequestMeta): Promise<Response> => {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const isRead = method === "GET" || method === "HEAD";

        // Errors outside route()/page() (404, 405, a throwing hand-written route) also go through onError in config.ts.
        const fail = async (error: unknown) => (await toErrorResponse(config.onError, error, request))._build();

        if (react && isRead && url.pathname.startsWith(STATIC_PREFIX)) {
            meta.kind = "internal";
            return (await serveFile((await loadReact()).staticDir, url.pathname.slice(STATIC_PREFIX.length), dev ? "no-cache" : config.staticCacheControl.assets, request)) ?? fail(new HttpError(404));
        }
        if (dev && react && isRead && url.pathname === DEV_PATH) {
            meta.kind = "internal";
            return devEvents((await loadReact()).manifest.build, devUpdate);
        }

        let ip: string;
        try {
            ip = await resolveIp(config, request, info.ip);
        } catch (error) {
            return fail(error);
        }
        meta.ip = ip;
        if (react && url.pathname === ACTION_PATH) {
            meta.kind = "action";
            meta.action = request.headers.get(ACTION_HEADER) ?? undefined;
            if (method !== "POST") return fail(new HttpError(405, undefined, undefined, { allow: "POST" }));
            try {
                return await serverAction(runtime, await loadReact(), request, { params: {}, ip, pattern: ACTION_PATH });
            } catch (error) {
                return fail(error);
            }
        }

        const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
        const slashed = pathname !== url.pathname;
        // A trailing slash on a route or page URL: trailingSlash in config.ts decides (files never take one).
        const matched = slashed && config.trailingSlash === "strict" ? null : router.match(pathname);
        if (matched && slashed && config.trailingSlash === "redirect") {
            meta.kind = "internal";
            return new Response(null, { status: 308, headers: { location: pathname + url.search } });
        }
        const response = new TyvoResponse();
        if (!matched) {
            if (publicDir && isRead) {
                const file = await serveFile(publicDir, url.pathname.slice(1), dev ? "no-cache" : config.staticCacheControl.public, request);
                if (file) {
                    meta.kind = "public";
                    return file;
                }
            }
            // An HTML 404 from app/not-found.tsx when there is one, otherwise onError.
            if (react && isRead && wantsPage(request)) {
                const reactBundles = await loadReact();
                const result = await reactBundles.rsc.renderNotFound(request, reactBundles.manifest);
                if (result) return toPageResponse(reactBundles, result, request, dev);
            }
            return fail(new HttpError(404));
        }

        const endpoint = matched.entry.value;
        meta.kind = endpoint.kind;
        meta.pattern = matched.entry.pattern;
        const allowed = (endpoint.kind === "page" ? PAGE_METHODS : allowedMethods(endpoint.methods)).join(", ");
        const context: RouteContext = { params: matched.params, ip, pattern: matched.entry.pattern, proxies: endpoint.kind === "route" ? endpoint.proxies : [] };

        // route() exports apply defaultCORS/defaultRatelimit (or their own overrides) themselves.
        // Everything else — hand-written route functions and pages — gets the defaults here, at the framework level.
        const methodOf = (name: string) => (isHttpMethod(name) ? endpoint.kind === "route" && endpoint.methods[name] : undefined) || undefined;
        const targetFor = (name: string) => methodOf(name) ?? (name === "HEAD" ? methodOf("GET") : undefined);

        if (isPreflight(request) && !(endpoint.kind === "route" && endpoint.methods.OPTIONS)) {
            const target = targetFor(request.headers.get("access-control-request-method")!.toUpperCase());
            if (target && isTyvoRoute(target)) {
                // That route() answers from its own `cors`.
                try {
                    return await target(request, context);
                } catch (error) {
                    return fail(error);
                }
            }
            if (runtime.cors) return preflightResponse(runtime.cors, request);
        }

        const defaults = new Headers();
        const target = endpoint.kind === "route" ? targetFor(method) : undefined;
        if (!(target && isTyvoRoute(target)) && runtime.cors) {
            for (const [name, value] of await corsHeaders(runtime.cors, request)) defaults.set(name, value);
        }
        // Pages get their CSP (with a nonce) from renderPage; other non-route() endpoints get defaultCSP here.
        if (endpoint.kind === "route" && !(target && isTyvoRoute(target))) {
            for (const [name, value] of cspHeaders(runtime.csp || undefined)) defaults.set(name, value);
        }
        const send = (result: Response) => addHeaders(method === "HEAD" ? new Response(null, result) : result, defaults);

        if (method === "OPTIONS" && (endpoint.kind === "page" || !endpoint.methods.OPTIONS)) {
            return send(response.header("allow", allowed).empty(204)._build());
        }

        let result: unknown;
        try {
            if (endpoint.kind === "page") {
                if (method !== "GET" && method !== "HEAD") return send(await fail(new HttpError(405, undefined, undefined, { allow: allowed })));
                // Prerendered: served as built (no middlewares, loader or rate limit per request).
                const prerenderedPage = statics.get(pathKey(pathname));
                meta.prerendered = !!prerenderedPage;
                // Rate limiting for pages happens in the RSC renderer (page() options or defaultRatelimit).
                result = prerenderedPage ? serveStatic(prerenderedPage, request) : await renderPage(await loadReact(), endpoint.index, request, context, dev);
            } else {
                if (!target) return send(await fail(new HttpError(405, undefined, undefined, { allow: allowed })));
                if (!isTyvoRoute(target) && runtime.ratelimit) {
                    for (const [name, value] of await applyRatelimit(runtime, runtime.ratelimit, request, context)) defaults.set(name, value);
                }
                // route() runs its proxies itself (after its schemas); a hand-written function is wrapped here.
                result =
                    isTyvoRoute(target) || endpoint.proxies.length === 0
                        ? await target(request, context)
                        : await runProxied(endpoint.proxies, request, context, async () => target(request, context));
            }
        } catch (error) {
            return send(await fail(error));
        }

        if (!(result instanceof Response)) {
            return send(await fail(new TypeError(`${matched.entry.file}: ${method} must return a Response, got ${result === null ? "null" : typeof result}.`)));
        }
        return send(result);
    };

    return Object.assign(handle, { router, prerender });
}

/** Reads a rendered response into a stored variant; per-request headers (cookies, rate limit) are dropped. */
async function staticVariant(pending: Promise<Response>, text: boolean): Promise<StaticVariant> {
    const response = await pending;
    const headers: [string, string][] = [];
    for (const [name, value] of response.headers) {
        if (name !== "set-cookie" && name !== "retry-after" && !name.startsWith("ratelimit-")) headers.push([name, value]);
    }
    return { status: response.status, headers, body: text ? await response.text() : new Uint8Array(await response.arrayBuffer()) };
}

/** `[{}]` for a page without dynamic segments, otherwise what its `staticParams()` returns. */
async function staticParamsOf(bundles: ReactBundles, index: number, entry: RouteEntry<Endpoint>): Promise<Params[]> {
    const { file } = bundles.rsc.pages[index]!;
    const dynamic = entry.segments.some((segment) => segment.kind !== "static");
    const list = await bundles.rsc.staticParams(index);
    if (list === undefined) {
        if (dynamic) throw new Error(`${file}: a prerendered page with dynamic segments (${entry.pattern}) needs export async function staticParams().`);
        return [{}];
    }
    if (!Array.isArray(list) || !list.every((params) => typeof params === "object" && params !== null)) {
        throw new Error(`${file}: staticParams() must return an array of params objects, e.g. [{ id: "1" }].`);
    }
    if (!dynamic) throw new Error(`${file}: staticParams() is only for pages with dynamic segments; ${entry.pattern} has none.`);
    return list as Params[];
}

function wantsPage(request: Request): boolean {
    return !!request.headers.get(RSC_HEADER) || (request.headers.get("accept") ?? "").includes("text/html");
}

/** `nonce` replaces the fresh per-response nonce (prerendering stores a placeholder instead). */
async function renderPage(bundles: ReactBundles, index: number, request: Request, context: RouteContext, dev: boolean, nonce?: string): Promise<Response> {
    const result = await bundles.rsc.render(index, request, context, bundles.manifest);
    try {
        return await toPageResponse(bundles, result, request, dev, nonce);
    } catch (error) {
        // redirect()/notFound() thrown while rendering the shell (outside any loading.tsx boundary).
        const navigation = readNavigation(error);
        if (navigation?.kind === "redirect") return new Response(null, { status: navigation.status, headers: { location: navigation.url } });
        if (navigation?.kind === "not-found") {
            return toPageResponse(bundles, await bundles.rsc.render(index, request, context, bundles.manifest, { notFound: true }), request, dev, nonce);
        }
        throw error;
    }
}

async function toPageResponse(bundles: ReactBundles, result: RscResult, request: Request, dev: boolean, fixedNonce?: string): Promise<Response> {
    if ("response" in result) return result.response;
    const headers = new Headers(result.headers);
    headers.append("vary", RSC_HEADER);
    // One nonce per document: in the CSP header and on every script React and Tyvo render into it.
    const nonce = result.csp?.nonce ? (fixedNonce ?? createNonce()) : undefined;
    if (result.csp) headers.set(...cspHeader(result.csp, nonce));
    // Client-side navigation only needs the server component payload.
    if (request.headers.get(RSC_HEADER)) {
        headers.set("content-type", `${RSC_CONTENT_TYPE}; charset=utf-8`);
        return new Response(result.flight, { status: result.status, headers });
    }
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(await bundles.ssr.render(result.flight, bundles.manifest, { nonce, dev, prefetchTtl: getRuntime().config.prefetch.ttl }), { status: result.status, headers });
}

/** POST /_tyvo/action: same-origin check, default rate limit and body limit from config.ts, then the RSC bundle. */
async function serverAction(runtime: Runtime, bundles: ReactBundles, request: Request, context: RouteContext): Promise<Response> {
    const options = runtime.config.serverActions;
    const origin = request.headers.get("origin");
    const self = new URL(request.url).origin;
    if (!origin || (origin !== self && !options.allowedOrigins.includes(origin))) {
        throw new HttpError(403, "Server actions only accept same-origin requests (see serverActions.allowedOrigins in config.ts).");
    }
    const headers = runtime.ratelimit ? await applyRatelimit(runtime, runtime.ratelimit, request, context) : new Headers();
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.bodyLimit) throw new HttpError(413, `Request body exceeds ${options.bodyLimit} bytes`);
    const body = request.body ? await readLimited(request.body, options.bodyLimit) : new Uint8Array();
    const response = await bundles.rsc.action(new Request(request.url, { method: "POST", headers: request.headers, body }), bundles.manifest);
    return addHeaders(response, headers);
}

/** Server-sent events: tells the browser which build is running; it reconnects after every dev rebuild. */
function devEvents(build: string, update: "refresh" | "reload"): Response {
    let timer: ReturnType<typeof setInterval> | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(`retry: 300\ndata: ${JSON.stringify({ build, update })}\n\n`));
            timer = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
        },
        cancel() {
            clearInterval(timer);
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Content-Type by file extension; anything else is sent as `application/octet-stream`. */
const MIME: Record<string, string> = {
    // Code and data
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonld": "application/ld+json",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".xml": "application/xml",
    ".rss": "application/rss+xml",
    ".atom": "application/atom+xml",
    // Text
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".ics": "text/calendar; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    // Images
    ".png": "image/png",
    ".apng": "image/apng",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".jxl": "image/jxl",
    ".heic": "image/heic",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    // Fonts
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    // Video
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mov": "video/quicktime",
    // Audio
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    // 3D models
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    // Documents and archives
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
};

/**
 * A file inside `dir` for a GET/HEAD `request`, or undefined (missing, a directory, or outside `dir`). Streamed from
 * disk (never read whole), with `ETag` / `Last-Modified` for revalidation (`304 Not Modified`) and single byte ranges
 * (`206 Partial Content`, `416` when unsatisfiable; `If-Range` honoured). HEAD gets the headers without opening the file.
 */
async function serveFile(dir: string, file: string, cacheControl: string, request: Request): Promise<Response | undefined> {
    let name: string;
    try {
        name = decodeURIComponent(file);
    } catch {
        return undefined;
    }
    // A file is not a folder: "/robots.txt/" is not "/robots.txt" (one URL per file; some file systems ignore the slash).
    if (name.endsWith("/") || name.endsWith("\\")) return undefined;
    const path = normalize(join(dir, name));
    if (!path.startsWith(normalize(dir + sep))) return undefined;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(path);
    } catch {
        return undefined;
    }
    if (!info.isFile()) return undefined;

    const size = info.size;
    // Weak: equal size and modification time stand for equal content; HTTP dates have whole seconds.
    const etag = `W/"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const modified = Math.floor(info.mtimeMs / 1000) * 1000;
    const headers = new Headers({
        "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": cacheControl,
        etag,
        "last-modified": new Date(modified).toUTCString(),
        "accept-ranges": "bytes",
        // Browsers use the content-type above as is, never guess from the bytes (an upload that looks like HTML stays inert).
        "x-content-type-options": "nosniff",
    });

    if (notModified(request, etag, modified)) {
        headers.delete("content-type");
        return new Response(null, { status: 304, headers });
    }

    let range: { start: number; end: number } | undefined;
    const rangeHeader = request.headers.get("range");
    if (rangeHeader && rangeApplies(request.headers.get("if-range"), etag, modified)) {
        const parsed = parseRange(rangeHeader, size);
        if (parsed === "unsatisfiable") {
            headers.set("content-range", `bytes */${size}`);
            headers.delete("content-type");
            return new Response(null, { status: 416, headers });
        }
        range = parsed;
    }

    const start = range?.start ?? 0;
    const end = range ? range.end : size - 1;
    headers.set("content-length", String(size === 0 ? 0 : end - start + 1));
    if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
    const status = range ? 206 : 200;
    if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers });
    const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
}

/** `If-None-Match` (weak comparison) wins over `If-Modified-Since`, as RFC 9110 says. */
function notModified(request: Request, etag: string, modified: number): boolean {
    const noneMatch = request.headers.get("if-none-match");
    if (noneMatch !== null) {
        const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
        return noneMatch.trim() === "*" || noneMatch.split(",").some((tag) => opaque(tag) === opaque(etag));
    }
    const since = request.headers.get("if-modified-since");
    if (since === null) return false;
    const date = Date.parse(since);
    return !Number.isNaN(date) && modified <= date;
}

/** A `Range` applies unless `If-Range` names another version. A weak ETag never matches `If-Range` (strong comparison). */
function rangeApplies(ifRange: string | null, etag: string, modified: number): boolean {
    if (ifRange === null) return true;
    const value = ifRange.trim();
    if (value.startsWith('"') || value.startsWith("W/")) return !etag.startsWith("W/") && value === etag;
    const date = Date.parse(value);
    return !Number.isNaN(date) && date === modified;
}

/**
 * One byte range of a file of `size` bytes: `bytes=0-99`, `bytes=100-`, `bytes=-100` (the last 100). A header this
 * cannot use (another unit, several ranges, malformed) is ignored (undefined: the whole file); a well-formed range
 * outside the file is "unsatisfiable" (416).
 */
function parseRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === "" && match[2] === "")) return undefined;
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (suffix === 0 || size === 0) return "unsatisfiable";
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size) return "unsatisfiable";
    if (end < start) return undefined;
    return { start, end };
}

/** `route({ path })` / `page({ path })` must name the folder they live in; checked when the server starts. */
export function checkDeclaredPath(label: string, declared: string | undefined, actual: string): void {
    if (declared !== undefined && declared !== actual) {
        throw new Error(`${label} declares path "${declared}", but its folder serves "${actual}". Use path: "${actual}" (or remove it).`);
    }
}

function isTyvoRoute(target: Route): boolean {
    return (target as unknown as Record<symbol, unknown>)[HANDLES_PREFLIGHT] === true;
}

/** Adds framework headers the response does not set itself (`vary` is merged). Copies immutable responses. */
function addHeaders(response: Response, headers: Headers): Response {
    let target = response;
    for (const [name, value] of headers) {
        const existing = target.headers.get(name);
        if (existing !== null && name !== "vary") continue;
        const next = existing !== null ? `${existing}, ${value}` : value;
        try {
            target.headers.set(name, next);
        } catch {
            target = new Response(target.body, target);
            target.headers.set(name, next);
        }
    }
    return target;
}

function collectMethods(file: string, module: Record<string, unknown>): MethodTable {
    const table: MethodTable = {};
    for (const [name, value] of Object.entries(module)) {
        if (!isHttpMethod(name)) continue;
        if (typeof value !== "function") throw new TypeError(`${file}: export "${name}" must be a function (request: Request) => Response.`);
        table[name] = value as Route;
    }
    return table;
}

function allowedMethods(methods: MethodTable): HttpMethod[] {
    const allowed = new Set(HTTP_METHODS.filter((method) => methods[method]));
    if (allowed.has("GET")) allowed.add("HEAD");
    allowed.add("OPTIONS");
    return HTTP_METHODS.filter((method) => allowed.has(method));
}
