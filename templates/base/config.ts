// Every Tyvo setting lives here. Tyvo has no hidden defaults: each export below is required
// (the generated .tyvo/types/check.ts and "tyvo check" enforce it), and these values are the defaults.
// Settings are values; the hooks Tyvo calls per request (getIp, onError, defaultRatelimit.key) are functions.
import {
    bodyParser,
    HttpError,
    isIp,
    normalizeIp,
    type CacheStorage,
    type CookieOptions,
    type CorsOptions,
    type CspOptions,
    type Logger,
    memoryCache,
    memoryStorage,
    nextLogger,
    type Parser,
    type PrefetchOptions,
    type RatelimitOptions,
    type RatelimitStorage,
    type ServerActionOptions,
    type ServerOptions,
    type StaticCacheControl,
    type TrailingSlash,
    type TyvoResponse,
} from "@tyvo/core";

/** Parses request bodies for every route() without its own `parser`. Bodies over the limit get 413. */
export const defaultParser: Parser = bodyParser({ limit: 1024 * 1024 });

/** Rate limit for every endpoint (hand-written routes and pages too); route()/page() can override any field with `ratelimit`. false disables it. */
export const defaultRatelimit: RatelimitOptions | false = {
    timeWindow: 60_000,
    max: 100,
    // The bucket a request counts against: one per client, endpoint and method. Return request.ip alone for one
    // budget per client across the app, or a user id from a middleware for per-account limits.
    key: (request, { pattern }) => `${request.method}:${pattern}:${request.ip}`,
};

/** Where rate-limit counters live. Replace with your own { get, set } (Redis, DB, ...) to share them across instances. */
export const ratelimitStorage: RatelimitStorage = memoryStorage({ sweepInterval: 60_000 });

/**
 * Where cache() results live. memoryCache keeps them in this process only: with several instances, each has its own
 * copy and revalidateTag() reaches only the one that calls it. Replace with your own { get, set, delete, deleteTag }
 * (Redis, DB, ...) to share them; such a store must serialize the values (e.g. JSON).
 */
export const cacheStorage: CacheStorage = memoryCache({ sweepInterval: 60_000 });

/**
 * CORS for every endpoint (hand-written routes and pages too); route() can override it with `cors`: route({ cors: { origin: [...] } }).
 * origin: "*", a list of exact origins, or (origin, request) => boolean. The empty list allows no cross-origin requests.
 * Set the whole export to false to send no CORS headers at all.
 */
export const defaultCORS: CorsOptions | false = {
    origin: [],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["content-type", "authorization"],
    exposeHeaders: [],
    credentials: false,
    maxAge: 600,
};

/**
 * Content-Security-Policy for every endpoint; route()/page() can override it with csp (directives merge by name).
 * nonce: a fresh nonce per page is added to script-src and put on every script Tyvo renders, so no 'unsafe-inline' is needed.
 */
export const defaultCSP: CspOptions | false = {
    directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
    },
    nonce: true,
    reportOnly: false,
};

/** Options for every cookie set with request.cookies.set() / delete(); each call can override fields. */
export const defaultCookie: CookieOptions = {
    path: "/",
    domain: undefined, // host-only
    maxAge: undefined, // session cookie
    httpOnly: true,
    secure: true, // browsers treat http://localhost as secure, so this works in development too
    sameSite: "lax",
    partitioned: false,
};

/** Key for signed cookies: request.cookies.set(name, value, { signed: true }). At least 32 characters; set in .env.local. */
export const cookieSecret: string = requireEnv("COOKIE_SECRET");

/** Server actions ("use server" modules), called by the browser through POST /_tyvo/action. */
export const serverActions: ServerActionOptions = {
    bodyLimit: 1024 * 1024,
    // The Origin header must be the site itself or one of these (CSRF protection).
    allowedOrigins: [],
};

/**
 * request.ip for every request; must return an IPv4/IPv6 address. socketIp is the TCP peer address as Node reports it
 * (IPv4 clients on a dual-stack socket arrive as ::ffff:1.2.3.4, which normalizeIp turns into 1.2.3.4).
 * Behind a proxy you control, trust its forwarded address instead (only then: clients can send any header):
 *   const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
 *   if (forwarded && isIp(normalizeIp(forwarded))) return normalizeIp(forwarded);
 */
export function getIp(request: Request, socketIp: string): string {
    const ip = normalizeIp(socketIp);
    // Requests made in memory (tests calling the handler directly) may have no socket address.
    return isIp(ip) ? ip : "127.0.0.1";
}

/**
 * Turns every error into the response: Tyvo's own HttpErrors (400 invalid request, 404, 405, 413, 429)
 * and anything a handler, middleware or page throws (Tyvo logs those through `loggers` before calling this).
 */
export function onError(error: unknown, request: Request, response: TyvoResponse): TyvoResponse<unknown> {
    if (error instanceof HttpError) {
        const body = (error.body ?? { error: error.message }) as Record<string, unknown>;
        // A 400 from the schemas lists every issue (field names, expected types). Outside development only the summary
        // goes out; keep `issues` here if your own pages show them (e.g. form errors) — guards already ran, so only
        // requests they let through get this far.
        if (process.env.NODE_ENV !== "development" && "issues" in body) {
            const { issues: _issues, ...summary } = body;
            return response.withHeaders(error.headers).json(summary, error.status);
        }
        return response.withHeaders(error.headers).json(body, error.status);
    }
    return response.json({ error: "Internal Server Error" }, 500);
}

/** Port to listen on. The PORT environment variable and "tyvo dev/start --port" take precedence. */
export const port = 3000;

/**
 * A route or page URL with a trailing slash (/users/7/): "redirect" sends 308 to /users/7 (one URL per page, as search
 * engines prefer), "strict" answers 404, "ignore" serves both. Files in public/ never take a trailing slash.
 */
export const trailingSlash: TrailingSlash = "redirect";

/** The HTTP server of "tyvo dev" / "tyvo start". These are Node's own defaults, spelled out. */
export const server: ServerOptions = {
    hostname: undefined, // every interface; the HOST environment variable takes precedence
    requestTimeout: 300_000, // whole request (headers and body), then 408; 0 disables it
    headersTimeout: 60_000,
    keepAliveTimeout: 5_000, // idle keep-alive connection after a response
    maxHeaderSize: 16 * 1024, // request headers above this get 431
};

/** Cache-Control of static files in production ("tyvo dev" always sends no-cache). */
export const staticCacheControl: StaticCacheControl = {
    public: "public, max-age=3600", // public/: same URL when the file changes, so keep it short
    assets: "public, max-age=31536000, immutable", // /_tyvo/static/: file names carry a content hash
};

/** Client-side navigation: how long a page prefetched by <Link> or router.prefetch() stays usable. */
export const prefetch: PrefetchOptions = { ttl: 30_000 };

/**
 * Every log entry (requests, server ready, warnings, errors) runs through these in order, like middlewares:
 * return nothing to pass the entry on, a changed entry to replace it, or false to drop it.
 * Add your own before nextLogger to filter, or after it to ship entries elsewhere, e.g.
 *   (entry) => (entry.type === "request" && entry.path === "/health" ? false : undefined),
 *   (entry) => void fetch("https://logs.example.com", { method: "POST", body: JSON.stringify(entry) }),
 */
export const loggers: Logger[] = [
    // Console output like Next.js: request lines in development only, as "next dev" / "next start" do.
    nextLogger({
        colors: !!process.stdout.isTTY,
        requests: process.env.NODE_ENV === "development",
        internalRequests: false, // browser assets under /_tyvo/static/ and the live-update stream
    }),
];

/** Environment variables come from the real environment or .env files (.env.local is created by tyvo init). */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable ${name}. Set it in .env.local or the environment.`);
    return value;
}
