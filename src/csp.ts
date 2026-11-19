import { z } from "zod";

// ---- Source expressions ---------------------------------------------------------------------------
// Types and runtime checks describe the same grammar; the nonce source is left out because Tyvo adds it.

export type CspKeyword =
    | "'self'"
    | "'none'"
    | "'unsafe-inline'"
    | "'unsafe-eval'"
    | "'wasm-unsafe-eval'"
    | "'unsafe-hashes'"
    | "'strict-dynamic'"
    | "'report-sample'"
    | "'inline-speculation-rules'";
export type CspHash = `'${"sha256" | "sha384" | "sha512"}-${string}'`;
type HostScheme = "http" | "https" | "ws" | "wss";
export type CspScheme = `${HostScheme | "data" | "blob" | "mediastream" | "filesystem"}:`;
/** `*`, `cdn.example.com`, `*.example.com:443/path`, `https://api.example.com`, `localhost:3000`. */
export type CspHost = "*" | `${string}.${string}` | "localhost" | `localhost:${string}` | `${HostScheme}://${string}`;
export type CspSource = CspKeyword | CspHash | CspScheme | CspHost;
/** `frame-ancestors` accepts no keywords besides `'self'` and `'none'`. */
export type CspAncestorSource = "'self'" | "'none'" | CspScheme | CspHost;
export type CspSandboxToken =
    | "allow-downloads"
    | "allow-forms"
    | "allow-modals"
    | "allow-orientation-lock"
    | "allow-pointer-lock"
    | "allow-popups"
    | "allow-popups-to-escape-sandbox"
    | "allow-presentation"
    | "allow-same-origin"
    | "allow-scripts"
    | "allow-storage-access-by-user-activation"
    | "allow-top-navigation"
    | "allow-top-navigation-by-user-activation"
    | "allow-top-navigation-to-custom-protocols";

const KEYWORDS = new Set<string>([
    "'self'",
    "'none'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "'wasm-unsafe-eval'",
    "'unsafe-hashes'",
    "'strict-dynamic'",
    "'report-sample'",
    "'inline-speculation-rules'",
]);
const HASH = /^'sha(256|384|512)-[A-Za-z0-9+/_-]+={0,2}'$/;
const SCHEME = /^(https?|wss?|data|blob|mediastream|filesystem):$/;
const HOST = /^(?:(https?|wss?):\/\/)?(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:(\d{1,5}|\*))?(\/[^\s;,']*)?$/i;

function isHost(value: string): boolean {
    if (value === "*") return true;
    const match = HOST.exec(value);
    if (!match) return false;
    const [, scheme, , hostname] = match;
    // Without a scheme, a bare word is almost certainly a typo (e.g. self instead of 'self').
    return !!scheme || hostname!.includes(".") || hostname === "localhost";
}

const isSource = (value: unknown): value is CspSource =>
    typeof value === "string" && (KEYWORDS.has(value) || HASH.test(value) || SCHEME.test(value) || isHost(value));
const isAncestor = (value: unknown): value is CspAncestorSource =>
    typeof value === "string" && (value === "'self'" || value === "'none'" || SCHEME.test(value) || isHost(value));

const source = z.custom<CspSource>(isSource, {
    message: "Invalid CSP source. Use a quoted keyword ('self', 'none', ...), a hash ('sha256-…'), a scheme (https:), or a host (cdn.example.com).",
});
const ancestor = z.custom<CspAncestorSource>(isAncestor, {
    message: "Invalid frame-ancestors source. Use 'self', 'none', a scheme (https:), or a host.",
});
const noneAlone = (list: readonly string[]) => !list.includes("'none'") || list.length === 1;
const sourceList = z.array(source).min(1).readonly().refine(noneAlone, "'none' must be the only source of a directive.");
const ancestorList = z.array(ancestor).min(1).readonly().refine(noneAlone, "'none' must be the only source of a directive.");
const sandboxToken = z.enum([
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-presentation",
    "allow-same-origin",
    "allow-scripts",
    "allow-storage-access-by-user-activation",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-top-navigation-to-custom-protocols",
]);

/** Every supported directive and the value it takes. */
const DIRECTIVES = {
    // Fetch directives
    "default-src": sourceList,
    "child-src": sourceList,
    "connect-src": sourceList,
    "fenced-frame-src": sourceList,
    "font-src": sourceList,
    "frame-src": sourceList,
    "img-src": sourceList,
    "manifest-src": sourceList,
    "media-src": sourceList,
    "object-src": sourceList,
    "script-src": sourceList,
    "script-src-elem": sourceList,
    "script-src-attr": sourceList,
    "style-src": sourceList,
    "style-src-elem": sourceList,
    "style-src-attr": sourceList,
    "worker-src": sourceList,
    // Document directives
    "base-uri": sourceList,
    /** `true` = everything sandboxed; a list re-allows features. */
    sandbox: z.union([z.literal(true), z.array(sandboxToken).readonly()]),
    // Navigation directives
    "form-action": sourceList,
    "frame-ancestors": ancestorList,
    // Reporting directives
    "report-uri": z.array(z.url()).min(1).readonly(),
    /** Name of a group defined in the `Reporting-Endpoints` header. */
    "report-to": z.string().regex(/^[A-Za-z0-9_-]+$/, "report-to takes a reporting group name."),
    // Other directives
    "upgrade-insecure-requests": z.literal(true),
    "require-trusted-types-for": z.tuple([z.literal("'script'")]).readonly(),
    "trusted-types": z
        .array(z.union([z.enum(["'none'", "'allow-duplicates'"]), z.string().regex(/^[A-Za-z0-9\-#=_/@.%*]+$/)]))
        .min(1)
        .readonly(),
} as const;

type DirectiveSchemas = typeof DIRECTIVES;
type DirectiveName = keyof DirectiveSchemas;
type DirectiveValue<K extends DirectiveName> = z.output<DirectiveSchemas[K]>;

/** The policy: each directive with the value it takes. */
export type CspDirectives = { readonly [K in DirectiveName]?: DirectiveValue<K> };
/** In an override, `false` removes a directive inherited from `defaultCSP`. */
export type CspDirectivesOverride = { readonly [K in DirectiveName]?: DirectiveValue<K> | false };

const mapDirectives = <T extends z.ZodType>(wrap: (schema: z.ZodType) => T) =>
    z.strictObject(Object.fromEntries(Object.entries(DIRECTIVES).map(([name, schema]) => [name, wrap(schema)])) as Record<DirectiveName, T>);

const cspOptionsSchema = z.strictObject({
    directives: mapDirectives((schema) => schema.optional()),
    nonce: z.boolean(),
    reportOnly: z.boolean(),
});
/** `false` entries (removals) are taken out before parsing, so errors point at the real problem instead of a union. */
const cspOverrideSchema = z.strictObject({
    directives: mapDirectives((schema) => schema.optional()).optional(),
    nonce: z.boolean().optional(),
    reportOnly: z.boolean().optional(),
});

/** Content-Security-Policy. `defaultCSP` in `config.ts` holds it all; `route({ csp })` / `page({ csp })` override parts. */
export interface CspOptions {
    directives: CspDirectives;
    /**
     * Generate a fresh nonce per page and add `'nonce-…'` to `script-src`. Tyvo puts it on the scripts it renders
     * (React SSR and the inline server component payload), so pages work with a strict `script-src 'self'`.
     */
    nonce: boolean;
    /** Send `Content-Security-Policy-Report-Only` instead: violations are reported, nothing is blocked. */
    reportOnly: boolean;
}

/** Per-route/page override: `directives` are merged by name over the default (`false` removes one). */
export interface CspOverride {
    directives?: CspDirectivesOverride;
    nonce?: boolean;
    reportOnly?: boolean;
}

/** Validates `defaultCSP` (or a merged policy); throws with every problem listed. */
export function parseCspOptions(value: unknown, where: string): CspOptions {
    const result = cspOptionsSchema.safeParse(value);
    if (!result.success) throw new TypeError(`${where} is not a valid CSP:\n${z.prettifyError(result.error)}`);
    const options = result.data as CspOptions;
    const scriptSrc = options.directives["script-src"];
    if (options.nonce && (!scriptSrc || scriptSrc.includes("'none'"))) {
        throw new TypeError(`${where}: nonce: true needs a "script-src" directive (other than 'none') to add the nonce to.`);
    }
    return options;
}

/** Validates a route()/page() `csp` override; throws with every problem listed. */
export function parseCspOverride(value: unknown, where: string): CspOverride | false | undefined {
    if (value === undefined || value === false) return value;
    const removed: string[] = [];
    let input = value;
    const directives = (value as { directives?: unknown }).directives;
    if (typeof directives === "object" && directives !== null) {
        const kept: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(directives)) {
            if (entry === false) removed.push(name);
            else kept[name] = entry;
        }
        input = { ...value, directives: kept };
    }
    const result = cspOverrideSchema.safeParse(input);
    if (!result.success) throw new TypeError(`${where} is not a valid CSP override:\n${z.prettifyError(result.error)}`);
    const unknown = removed.filter((name) => !(name in DIRECTIVES));
    if (unknown.length) throw new TypeError(`${where}: unknown directive(s) ${unknown.join(", ")}.`);
    const parsed = result.data as CspOverride;
    if (!removed.length) return parsed;
    return { ...parsed, directives: { ...parsed.directives, ...Object.fromEntries(removed.map((name) => [name, false])) } };
}

/** The route's/page's `csp` on top of `defaultCSP` from `config.ts`. */
export function resolveCsp(override: CspOverride | false | undefined, fallback: CspOptions | false): CspOptions | undefined {
    if (override === false) return undefined;
    if (override === undefined) return fallback || undefined;
    const directives: Record<string, unknown> = { ...(fallback ? fallback.directives : {}) };
    for (const [name, value] of Object.entries(override.directives ?? {})) {
        if (value === false) delete directives[name];
        else directives[name] = value;
    }
    const merged = { ...(fallback || {}), ...override, directives };
    if (!fallback && (merged.nonce === undefined || merged.reportOnly === undefined)) {
        throw new TypeError("`csp` needs directives, nonce and reportOnly when defaultCSP in config.ts is false.");
    }
    return parseCspOptions(merged, "csp");
}

/** A random nonce for one response. */
export function createNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** `[header name, header value]` for the policy, with the nonce added to `script-src`. */
export function cspHeader(options: CspOptions, nonce: string | undefined): [string, string] {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(options.directives) as [string, unknown][]) {
        if (value === undefined) continue;
        if (value === true) parts.push(name);
        else if (typeof value === "string") parts.push(`${name} ${value}`);
        else {
            const sources = name === "script-src" && nonce ? [...(value as string[]), `'nonce-${nonce}'`] : (value as string[]);
            parts.push(sources.length ? `${name} ${sources.join(" ")}` : name);
        }
    }
    return [options.reportOnly ? "content-security-policy-report-only" : "content-security-policy", parts.join("; ")];
}

/** Header for a non-page response: it renders no inline scripts, so no nonce is added. */
export function cspHeaders(options: CspOptions | undefined): Headers {
    const headers = new Headers();
    if (options) headers.set(...cspHeader(options, undefined));
    return headers;
}
