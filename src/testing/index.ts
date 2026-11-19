// `@tyvo/core/testing` — calls the app in memory, without a server or a port. Works with any test runner.
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../cli/build.js";
import { loadEnv } from "../cli/env.js";
import { APP_BUNDLE, OUT_DIR } from "../cli/project.js";
import { createHandler, type Handler, type HandlerOptions } from "../server/handler.js";
import { proxyChainOf } from "../shared/conventions.js";
import type { TyvoConfig } from "../types.js";

type QueryValue = string | number | boolean | bigint;

export interface TestRequestOptions {
    headers?: HeadersInit;
    /** Appended to the path's search params; arrays repeat the key. `undefined` values are skipped. */
    query?: Record<string, QueryValue | readonly QueryValue[] | undefined>;
    /**
     * Strings, bytes, Blob, FormData, URLSearchParams and streams are sent as they are; anything else as JSON
     * (with `content-type: application/json` unless a content type is given).
     */
    body?: unknown;
    /** The socket address `getIp()` in config.ts receives. Overrides the client's `ip`. */
    ip?: string;
    signal?: AbortSignal;
}

/** Cookies the client sends with every request; `Set-Cookie` responses update them (domain and path are ignored). */
export interface TestCookies {
    /** The raw value as sent (signed cookies include their signature). */
    get(name: string): string | undefined;
    set(name: string, value: string): void;
    delete(name: string): void;
    clear(): void;
    all(): Record<string, string>;
}

export interface TestClient {
    fetch(path: string, options?: TestRequestOptions & { method?: string }): Promise<Response>;
    get(path: string, options?: TestRequestOptions): Promise<Response>;
    head(path: string, options?: TestRequestOptions): Promise<Response>;
    options(path: string, options?: TestRequestOptions): Promise<Response>;
    delete(path: string, options?: TestRequestOptions): Promise<Response>;
    post(path: string, options?: TestRequestOptions): Promise<Response>;
    put(path: string, options?: TestRequestOptions): Promise<Response>;
    patch(path: string, options?: TestRequestOptions): Promise<Response>;
    readonly cookies: TestCookies;
    /** The app itself: `(request: Request, { ip }) => Promise<Response>`. */
    readonly handler: Handler;
}

export interface TestClientSettings {
    /** Base of every request URL. Default: `http://localhost`. */
    origin?: string;
    /** Socket address for every request. Default: `127.0.0.1`. */
    ip?: string;
    /** Keep cookies between requests. Default: true. */
    cookies?: boolean;
}

export interface TestClientOptions extends TestClientSettings {
    /** Your config.ts: `import * as config from "../config"`. */
    config: TyvoConfig;
    /**
     * Route modules by project-relative file, e.g.
     * `{ "src/app/users/[id]/route.ts": await import("../src/app/users/[id]/route") }`.
     */
    routes: Record<string, Record<string, unknown>>;
    /**
     * proxy.ts modules by project-relative file, e.g. `{ "src/app/api/proxy.ts": await import("../src/app/api/proxy") }`.
     * Each wraps the given routes in its folder and below, as in the real app.
     */
    proxies?: Record<string, Record<string, unknown>>;
    /** Served for URLs no route matches, like `public/`. */
    publicDir?: string;
}

/**
 * A client for route modules your test runner has already loaded (it must understand TypeScript and the `@/` path,
 * e.g. Vitest). Pages need the React build: use `buildTestClient()` for them.
 *
 * ```ts
 * import * as config from "../config";
 * const client = createTestClient({ config, routes: { "src/app/api/hello/route.ts": await import("../src/app/api/hello/route") } });
 * const response = await client.get("/api/hello");
 * ```
 */
export function createTestClient(options: TestClientOptions): TestClient {
    const clean = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");
    const proxies = new Map(Object.entries(options.proxies ?? {}).map(([file, module]) => [clean(file), module]));
    const routes = Object.entries(options.routes).map(([file, module]) => ({
        file: clean(file),
        module,
        proxies: proxyChainOf(clean(file), [...proxies.keys()]).map((proxyFile) => ({ file: proxyFile, module: proxies.get(proxyFile)! })),
    }));
    return clientFor(createHandler({ config: options.config, routes, publicDir: options.publicDir }), options);
}

export interface BuildTestClientOptions extends TestClientSettings {
    /** Project directory. Default: `process.cwd()`. */
    root?: string;
    /** Load `.env.test.local`, `.env.local`, `.env.test` and `.env` into process.env first. Default: true. */
    env?: boolean;
    /** Prerender pages with `export const prerender = true` and serve them as `tyvo start` would. Default: false (rendered per request). */
    prerender?: boolean;
    /** Overrides for the handler, e.g. `{ config: { ...config, port: 0 } }`. */
    handler?: Partial<HandlerOptions>;
}

let builds = 0;

/**
 * Builds the project exactly like `tyvo build` (routes, pages, server actions, config.ts) into a private folder under
 * `.tyvo/test/` and returns a client for it. No test-runner support for TypeScript is needed. Build once per test file:
 *
 * ```ts
 * const client = await buildTestClient();
 * const page = await client.get("/users/1");
 * expect(await page.text()).toContain("User 1");
 * ```
 */
export async function buildTestClient(options: BuildTestClientOptions = {}): Promise<TestClient> {
    const root = options.root ?? process.cwd();
    if (options.env !== false) loadEnv(root, "test");
    // One folder per build: test runners build in parallel worker processes.
    const outDir = join(isAbsolute(root) ? root : join(process.cwd(), root), OUT_DIR, "test", `${process.pid}-${builds++}`);
    process.once("exit", () => rmSync(outDir, { recursive: true, force: true }));
    await build({ root, outDir });
    const app = (await import(pathToFileURL(join(outDir, APP_BUNDLE)).href)) as { createApp(overrides?: Partial<HandlerOptions>): Handler };
    const handler = app.createApp({ prerenderDir: undefined, ...options.handler });
    if (options.prerender) await handler.prerender();
    return clientFor(handler, options);
}

function clientFor(handler: Handler, settings: TestClientSettings): TestClient {
    const origin = settings.origin ?? "http://localhost";
    const jar = new Map<string, string>();
    const keepCookies = settings.cookies !== false;

    const send = async (path: string, { method = "GET", headers: init, query, body, ip, signal }: TestRequestOptions & { method?: string } = {}): Promise<Response> => {
        const url = new URL(path, origin);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
        }
        const headers = new Headers(init);
        if (keepCookies && jar.size && !headers.has("cookie")) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));

        let payload: BodyInit | undefined;
        if (body !== undefined) {
            if (isBodyInit(body)) payload = body;
            else {
                payload = JSON.stringify(body);
                if (!headers.has("content-type")) headers.set("content-type", "application/json");
            }
        }
        const request = new Request(url, { method, headers, body: payload, signal, ...(payload instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
        const response = await handler(request, { ip: ip ?? settings.ip ?? "127.0.0.1" });
        if (keepCookies) storeCookies(jar, response);
        return response;
    };

    const withMethod = (method: string) => (path: string, options?: TestRequestOptions) => send(path, { ...options, method });
    return {
        fetch: send,
        get: withMethod("GET"),
        head: withMethod("HEAD"),
        options: withMethod("OPTIONS"),
        delete: withMethod("DELETE"),
        post: withMethod("POST"),
        put: withMethod("PUT"),
        patch: withMethod("PATCH"),
        handler,
        cookies: {
            get: (name) => jar.get(name),
            set: (name, value) => void jar.set(name, value),
            delete: (name) => void jar.delete(name),
            clear: () => jar.clear(),
            all: () => Object.fromEntries(jar),
        },
    };
}

function isBodyInit(value: unknown): value is BodyInit {
    return (
        typeof value === "string" ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        value instanceof Blob ||
        value instanceof FormData ||
        value instanceof URLSearchParams ||
        value instanceof ReadableStream
    );
}

function storeCookies(jar: Map<string, string>, response: Response): void {
    // Not in TypeScript 5.0's DOM lib, but available in every supported Node version.
    for (const line of (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const expired = attributes.some((attribute) => {
            const [key = "", value = ""] = attribute.split("=", 2).map((part) => part.trim());
            if (key.toLowerCase() === "max-age") return Number(value) <= 0;
            if (key.toLowerCase() === "expires") return Date.parse(value) <= Date.now();
            return false;
        });
        if (expired) jar.delete(name);
        else jar.set(name, pair.slice(separator + 1).trim());
    }
}
