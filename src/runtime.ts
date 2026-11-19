import type { Parser } from "./body.js";
import type { CacheStorage } from "./cache.js";
import type { CookieSettings } from "./cookies.js";
import { isCorsOptions, type CorsOptions } from "./cors.js";
import { parseCspOptions, type CspOptions } from "./csp.js";
import { isRatelimitOptions, type RatelimitOptions, type RatelimitStorage } from "./ratelimit.js";
import { CONFIG_EXPORTS } from "./shared/conventions.js";
import type { TyvoConfig } from "./types.js";

/** `config.ts`, resolved once. Shared between `@tyvo/core` and `@tyvo/core/server` through a global slot. */
export interface Runtime {
    config: TyvoConfig;
    parser: Parser;
    ratelimit: RatelimitOptions | false;
    storage: RatelimitStorage;
    cacheStorage: CacheStorage;
    cors: CorsOptions | false;
    csp: CspOptions | false;
    cookies: CookieSettings;
}

const SLOT = Symbol.for("tyvo.runtime");
type Slot = { [SLOT]?: Runtime };

/** Checks `config.ts` (every export is required) and makes it the active runtime. */
export function configure(config: TyvoConfig): Runtime {
    const missing = CONFIG_EXPORTS.filter((name) => (config as unknown as Record<string, unknown>)[name] === undefined);
    if (missing.length) throw new TypeError(`config.ts is missing required exports: ${missing.join(", ")}.`);
    for (const name of ["getIp", "onError"] as const) {
        if (typeof config[name] !== "function") throw new TypeError(`config.ts: "${name}" must be a function.`);
    }
    if (typeof config.ratelimitStorage.get !== "function" || typeof config.ratelimitStorage.set !== "function") {
        throw new TypeError(`config.ts: "ratelimitStorage" must implement get(key) and set(key, entry, ttl).`);
    }
    const cacheStorage = config.cacheStorage as Partial<CacheStorage> | null;
    if (typeof cacheStorage !== "object" || cacheStorage === null || !(["get", "set", "delete", "deleteTag"] as const).every((name) => typeof cacheStorage[name] === "function")) {
        throw new TypeError(`config.ts: "cacheStorage" must implement get(key), set(key, entry, ttl), delete(key) and deleteTag(tag).`);
    }
    if (!Number.isInteger(config.port)) throw new TypeError(`config.ts: "port" must be an integer.`);
    const server = config.server;
    const isMs = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (
        typeof server !== "object" ||
        server === null ||
        !("hostname" in server) ||
        (server.hostname !== undefined && typeof server.hostname !== "string") ||
        !isMs(server.requestTimeout) ||
        !isMs(server.headersTimeout) ||
        !isMs(server.keepAliveTimeout) ||
        !(Number.isInteger(server.maxHeaderSize) && server.maxHeaderSize > 0)
    ) {
        throw new TypeError(`config.ts: "server" must be { hostname, requestTimeout, headersTimeout, keepAliveTimeout, maxHeaderSize } (hostname may be undefined; the rest are integers >= 0).`);
    }
    const statics = config.staticCacheControl;
    if (typeof statics !== "object" || statics === null || typeof statics.public !== "string" || typeof statics.assets !== "string") {
        throw new TypeError(`config.ts: "staticCacheControl" must be { public: string, assets: string } (Cache-Control header values).`);
    }
    if (!(["redirect", "strict", "ignore"] as unknown[]).includes(config.trailingSlash)) {
        throw new TypeError(`config.ts: "trailingSlash" must be "redirect", "strict" or "ignore".`);
    }
    if (typeof config.prefetch !== "object" || config.prefetch === null || !isMs(config.prefetch.ttl)) {
        throw new TypeError(`config.ts: "prefetch" must be { ttl: number } (milliseconds, >= 0).`);
    }
    if (!Array.isArray(config.loggers) || !config.loggers.every((logger) => typeof logger === "function")) {
        throw new TypeError(`config.ts: "loggers" must be an array of functions (entry) => void, e.g. [nextLogger({ ... })].`);
    }

    const parser = config.defaultParser;
    if (typeof parser !== "function") throw new TypeError(`config.ts: "defaultParser" must be a parser, e.g. bodyParser({ limit: 1024 * 1024 }).`);
    const ratelimit = config.defaultRatelimit;
    if (ratelimit !== false && !isRatelimitOptions(ratelimit)) {
        throw new TypeError(`config.ts: "defaultRatelimit" must be false or { timeWindow, max, key }.`);
    }

    if (config.defaultCORS !== false && !isCorsOptions(config.defaultCORS)) {
        throw new TypeError(`config.ts: "defaultCORS" must be false or { origin, methods, allowHeaders, exposeHeaders, credentials, maxAge }.`);
    }

    if (config.defaultCSP !== false) {
        parseCspOptions(config.defaultCSP, "config.ts defaultCSP");
    }

    const actions = config.serverActions;
    if (typeof actions !== "object" || actions === null || !(actions.bodyLimit > 0) || !Array.isArray(actions.allowedOrigins)) {
        throw new TypeError(`config.ts: "serverActions" must be { bodyLimit: number, allowedOrigins: string[] }.`);
    }

    const cookie = config.defaultCookie;
    const cookieFields = ["path", "domain", "maxAge", "httpOnly", "secure", "sameSite", "partitioned"];
    if (typeof cookie !== "object" || cookie === null || !cookieFields.every((field) => field in cookie)) {
        throw new TypeError(`config.ts: "defaultCookie" must set every field: ${cookieFields.join(", ")}.`);
    }
    if (typeof config.cookieSecret !== "string" || config.cookieSecret.length < 32) {
        throw new TypeError(`config.ts: "cookieSecret" must be a string of at least 32 characters.`);
    }

    const runtime: Runtime = {
        config,
        parser,
        ratelimit,
        storage: config.ratelimitStorage,
        cacheStorage: config.cacheStorage,
        cors: config.defaultCORS,
        csp: config.defaultCSP,
        cookies: { defaults: cookie, secret: config.cookieSecret },
    };
    (globalThis as Slot)[SLOT] = runtime;
    return runtime;
}

/** The active runtime. To call a route directly (e.g. in tests), first run `configure(config)` with your config.ts. */
export function getRuntime(): Runtime {
    const runtime = (globalThis as Slot)[SLOT];
    if (!runtime) throw new Error("Tyvo is not configured. Call configure() from tyvo/server with your config.ts exports first.");
    return runtime;
}
