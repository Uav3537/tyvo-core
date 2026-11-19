// Shared by the test files: a complete config.ts (every setting, as `tyvo init` writes it) and an in-memory client.
import { HttpError, memoryCache, memoryStorage, normalizeIp, isIp, bodyParser, type TyvoConfig } from "../src/index.js";
import { createTestClient, type TestClient, type TestClientOptions } from "../src/testing/index.js";

/** A full config. Errors keep their `issues` (tests read them); no loggers, so test output stays quiet. */
export function testConfig(overrides: Partial<TyvoConfig> = {}): TyvoConfig {
    return {
        defaultParser: bodyParser({ limit: 1024 * 1024 }),
        defaultRatelimit: { timeWindow: 60_000, max: 1000, key: (request, { pattern }) => `${request.method}:${pattern}:${request.ip}` },
        ratelimitStorage: memoryStorage({ sweepInterval: 60_000 }),
        cacheStorage: memoryCache({ sweepInterval: 60_000 }),
        defaultCORS: {
            origin: ["https://app.example.com"],
            methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
            allowHeaders: ["content-type", "authorization"],
            exposeHeaders: [],
            credentials: false,
            maxAge: 600,
        },
        defaultCSP: { directives: { "default-src": ["'self'"] }, nonce: true, reportOnly: false },
        defaultCookie: { path: "/", domain: undefined, maxAge: undefined, httpOnly: true, secure: true, sameSite: "lax", partitioned: false },
        cookieSecret: "test-secret-that-is-at-least-32-characters",
        serverActions: { bodyLimit: 1024 * 1024, allowedOrigins: [] },
        getIp: (request, socketIp) => {
            const ip = normalizeIp(socketIp);
            return isIp(ip) ? ip : "127.0.0.1";
        },
        onError: (error, request, response) => {
            if (error instanceof HttpError) return response.withHeaders(error.headers).json(error.body ?? { error: error.message }, error.status);
            return response.json({ error: "Internal Server Error" }, 500);
        },
        port: 3000,
        trailingSlash: "redirect",
        server: { hostname: undefined, requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 },
        staticCacheControl: { public: "public, max-age=3600", assets: "public, max-age=31536000, immutable" },
        prefetch: { ttl: 30_000 },
        loggers: [],
        ...overrides,
    };
}

/**
 * A client for route modules given inline: `{ "/api/users/[id]": { GET: route({ ... }) } }`. Keys are URL paths as
 * written in folder names; they become `src/app/<path>/route.ts`. Proxies are keyed the same way (their folder).
 */
export function app(
    routes: Record<string, Record<string, unknown>>,
    options: Partial<Omit<TestClientOptions, "routes" | "proxies">> & { proxies?: Record<string, Record<string, unknown>> } = {},
): TestClient {
    const file = (path: string, name: string) => `src/app${path === "/" ? "" : path}/${name}.ts`;
    return createTestClient({
        config: options.config ?? testConfig(),
        publicDir: options.publicDir,
        origin: options.origin,
        ip: options.ip,
        cookies: options.cookies,
        routes: Object.fromEntries(Object.entries(routes).map(([path, module]) => [file(path, "route"), module])),
        proxies: Object.fromEntries(Object.entries(options.proxies ?? {}).map(([path, module]) => [file(path, "proxy"), module])),
    });
}

export async function json(response: Response): Promise<any> {
    return response.json();
}
