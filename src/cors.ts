/** CORS settings. `defaultCORS` in `config.ts` holds them all; `route({ cors })` overrides individual fields. */
export interface CorsOptions {
    /**
     * Origins allowed to call the route: `"*"`, a list of exact origins (`"https://app.example.com"`),
     * or a function deciding per request. An empty list allows no cross-origin requests.
     */
    origin: "*" | readonly string[] | ((origin: string, request: Request) => boolean | Promise<boolean>);
    /** Methods allowed in preflight (`Access-Control-Allow-Methods`). */
    methods: readonly string[];
    /** Request headers allowed in preflight. `"*"` echoes whatever the browser asks for. */
    allowHeaders: "*" | readonly string[];
    /** Response headers the browser may read (`Access-Control-Expose-Headers`). */
    exposeHeaders: readonly string[];
    /** Allow cookies / Authorization. With `origin: "*"` the request origin is echoed instead of `*`. */
    credentials: boolean;
    /** How long the browser may cache a preflight, in seconds. */
    maxAge: number;
}

const FIELDS = ["origin", "methods", "allowHeaders", "exposeHeaders", "credentials", "maxAge"] as const;

/** Marks functions made by route(), which answer CORS preflights themselves. */
export const HANDLES_PREFLIGHT = Symbol.for("tyvo.route.preflight");

export function isCorsOptions(value: unknown): value is CorsOptions {
    return typeof value === "object" && value !== null && FIELDS.every((field) => (value as Record<string, unknown>)[field] !== undefined);
}

/** The route's `cors` on top of `defaultCORS` from `config.ts`. */
export function resolveCors(route: Partial<CorsOptions> | false | undefined, fallback: CorsOptions | false): CorsOptions | undefined {
    if (route === false) return undefined;
    if (route === undefined) return fallback || undefined;
    const merged = { ...(fallback || {}), ...route };
    if (!isCorsOptions(merged)) {
        throw new TypeError(`route \`cors\` needs every field (${FIELDS.join(", ")}) when defaultCORS in config.ts is false.`);
    }
    return merged;
}

export function isPreflight(request: Request): boolean {
    return request.method === "OPTIONS" && request.headers.has("origin") && request.headers.has("access-control-request-method");
}

/** `Access-Control-Allow-Origin` value for this request, or `undefined` when its origin is not allowed. */
async function allowOrigin(options: CorsOptions, request: Request): Promise<string | undefined> {
    const origin = request.headers.get("origin");
    if (!origin) return undefined;
    if (options.origin === "*") return options.credentials ? origin : "*";
    const allowed = typeof options.origin === "function" ? await options.origin(origin, request) : options.origin.includes(origin);
    return allowed ? origin : undefined;
}

/** Headers for an actual (non-preflight) cross-origin request. Empty when the request has no allowed origin. */
export async function corsHeaders(options: CorsOptions, request: Request): Promise<Headers> {
    const headers = new Headers();
    if (options.origin !== "*" || options.credentials) headers.set("vary", "Origin");
    const origin = await allowOrigin(options, request);
    if (!origin) return headers;
    headers.set("access-control-allow-origin", origin);
    if (options.credentials) headers.set("access-control-allow-credentials", "true");
    if (options.exposeHeaders.length) headers.set("access-control-expose-headers", options.exposeHeaders.join(", "));
    return headers;
}

/** Answers a preflight. A disallowed origin gets 204 without CORS headers, so the browser blocks the request. */
export async function preflightResponse(options: CorsOptions, request: Request): Promise<Response> {
    const headers = await corsHeaders(options, request);
    headers.delete("access-control-expose-headers");
    headers.append("vary", "Access-Control-Request-Headers");
    if (headers.has("access-control-allow-origin")) {
        headers.set("access-control-allow-methods", options.methods.join(", "));
        const requested = request.headers.get("access-control-request-headers");
        const allowHeaders = options.allowHeaders === "*" ? requested : options.allowHeaders.join(", ");
        if (allowHeaders) headers.set("access-control-allow-headers", allowHeaders);
        headers.set("access-control-max-age", String(options.maxAge));
    }
    return new Response(null, { status: 204, headers });
}
