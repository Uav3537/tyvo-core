/** Options for `Set-Cookie`. `defaultCookie` in `config.ts` holds them all; `request.cookies.set()` overrides fields. */
export interface CookieOptions {
    path: string;
    /** `undefined` = host-only cookie. */
    domain: string | undefined;
    /** Lifetime in seconds. `undefined` = session cookie (deleted when the browser closes). */
    maxAge: number | undefined;
    httpOnly: boolean;
    /** Only sent over HTTPS. Browsers treat `localhost` as secure, so this also works in development. */
    secure: boolean;
    sameSite: "strict" | "lax" | "none";
    /** CHIPS partitioned cookie (requires `secure`). */
    partitioned: boolean;
}

/** What a cookie can hold: strings are stored as-is, everything else as JSON. */
export type CookieValue = string | number | boolean | null | CookieValue[] | { [key: string]: CookieValue };

export interface SetCookieOptions extends Partial<CookieOptions> {
    /** Sign the value with `cookieSecret` from `config.ts`; `get()` then ignores tampered values. */
    signed?: boolean;
}

export interface GetCookieOptions {
    /** Only return the value if it was set with `signed: true` and its signature is valid. */
    signed?: boolean;
}

export interface CookieSettings {
    defaults: CookieOptions;
    secret: string;
}

type Change = { kind: "set"; value: string; header: string } | { kind: "delete"; header: string };

/** Shared by every copy of the jar within one request (middlewares spread the request; the jar travels with it). */
interface JarState {
    incoming: Map<string, string>;
    changes: Map<string, Change>;
    settings: () => CookieSettings;
}

const SIGNED_PREFIX = "s:";
/** Marks a JSON-encoded value (same convention as Express' cookie-parser). */
const JSON_PREFIX = "j:";
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * `request.cookies`: reads the request's cookies and records changes, which Tyvo sends as `Set-Cookie`
 * on the outgoing response. `T` is the cookie shape — `cookieSchema`'s output when the route has one.
 */
export class TyvoCookies<T extends Record<string, unknown> = Record<string, CookieValue | undefined>> {
    readonly #state: JarState;
    readonly #values: Partial<T> | undefined;

    /** @internal Created by Tyvo for every request. */
    constructor(header: string | null, settings: () => CookieSettings, state?: JarState, values?: Partial<T>) {
        this.#state = state ?? { incoming: parseCookieHeader(header), changes: new Map(), settings };
        this.#values = values;
    }

    /**
     * Value of a cookie, including changes made earlier in this request. Tampered signed cookies read as `undefined`.
     * With a `cookieSchema` the result is the schema's output (a cookie deleted later in the same request reads as `undefined`).
     */
    get<K extends keyof T & string>(name: K): T[K];
    get(name: string, options: GetCookieOptions & { signed: true }): CookieValue | undefined;
    get(name: string, options?: GetCookieOptions): CookieValue | undefined;
    get(name: string, options: GetCookieOptions = {}): unknown {
        const change = this.#state.changes.get(name);
        if (change) return change.kind === "set" ? decode(this.#unwrap(change.value, options)) : undefined;
        if (this.#values && !options.signed && name in this.#values) return this.#values[name as keyof T];
        const raw = this.#state.incoming.get(name);
        return raw === undefined ? undefined : decode(this.#unwrap(raw, options));
    }

    has(name: string, options?: GetCookieOptions): boolean {
        return this.get(name, options) !== undefined;
    }

    /** Every readable cookie (signed ones verified and unwrapped), including this request's changes. */
    all(): T {
        const result: Record<string, unknown> = {};
        for (const name of new Set([...this.#state.incoming.keys(), ...this.#state.changes.keys()])) {
            const value = this.get(name);
            if (value !== undefined) result[name] = value;
        }
        return result as T;
    }

    /**
     * Sets a cookie on the response. Options override `defaultCookie` from `config.ts`.
     * Strings are stored as-is; any other JSON-serializable value is stored as JSON and `get()` returns it decoded.
     */
    set<K extends keyof T & string>(name: K, value: T[K] & CookieValue, options?: SetCookieOptions): void;
    set(name: string, value: CookieValue, options?: SetCookieOptions): void;
    set(name: string, value: CookieValue, options: SetCookieOptions = {}): void {
        if (!NAME.test(name)) throw new TypeError(`Invalid cookie name "${name}".`);
        const { defaults, secret } = this.#state.settings();
        const { signed, ...overrides } = options;
        const encoded = typeof value === "string" ? value : JSON_PREFIX + JSON.stringify(value);
        if (encoded === JSON_PREFIX + "undefined") throw new TypeError(`Cookie "${name}": value is not JSON-serializable.`);
        const stored = signed ? SIGNED_PREFIX + encoded + "." + sign(encoded, secret) : encoded;
        const header = serialize(name, stored, { ...defaults, ...overrides });
        this.#state.changes.set(name, { kind: "set", value: stored, header });
    }

    /** Deletes a cookie. Pass the same `path`/`domain` it was set with if they differ from `defaultCookie`. */
    delete(name: string, options: Partial<Pick<CookieOptions, "path" | "domain">> = {}): void {
        const { defaults } = this.#state.settings();
        const header = serialize(name, "", { ...defaults, ...options, maxAge: 0 }) + "; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
        this.#state.changes.set(name, { kind: "delete", header });
    }

    /** @internal Same jar, typed and backed by `cookieSchema`'s output. */
    _withValues<V extends Record<string, unknown>>(values: V): TyvoCookies<V> {
        return new TyvoCookies<V>(null, this.#state.settings, this.#state, values);
    }

    /** @internal The `Set-Cookie` header values for this request's changes. */
    _setCookieHeaders(): string[] {
        return [...this.#state.changes.values()].map((change) => change.header);
    }

    #unwrap(raw: string, options: GetCookieOptions): string | undefined {
        if (!raw.startsWith(SIGNED_PREFIX)) return options.signed ? undefined : raw;
        const body = raw.slice(SIGNED_PREFIX.length);
        const dot = body.lastIndexOf(".");
        if (dot === -1) return undefined;
        const value = body.slice(0, dot);
        return timingSafeEqual(body.slice(dot + 1), sign(value, this.#state.settings().secret)) ? value : undefined;
    }
}

/** Appends the jar's `Set-Cookie` headers to a response (copying it if its headers are immutable). */
export function applyCookies(response: Response, cookies: unknown): Response {
    if (!(cookies instanceof TyvoCookies)) return response;
    const headers = cookies._setCookieHeaders();
    if (!headers.length) return response;
    let target = response;
    try {
        for (const header of headers) target.headers.append("set-cookie", header);
    } catch {
        target = new Response(response.body, response);
        for (const header of headers) target.headers.append("set-cookie", header);
    }
    return target;
}

/** `j:{...}` -> the parsed JSON; anything else (including malformed JSON) stays a string. */
function decode(value: string | undefined): CookieValue | undefined {
    if (value === undefined || !value.startsWith(JSON_PREFIX)) return value;
    try {
        return JSON.parse(value.slice(JSON_PREFIX.length)) as CookieValue;
    } catch {
        return value;
    }
}

function parseCookieHeader(header: string | null): Map<string, string> {
    const cookies = new Map<string, string>();
    for (const pair of header?.split(";") ?? []) {
        const index = pair.indexOf("=");
        if (index === -1) continue;
        const name = pair.slice(0, index).trim();
        if (!name || cookies.has(name)) continue;
        const value = pair.slice(index + 1).trim().replace(/^"(.*)"$/, "$1");
        try {
            cookies.set(name, decodeURIComponent(value));
        } catch {
            cookies.set(name, value);
        }
    }
    return cookies;
}

function serialize(name: string, value: string, options: CookieOptions): string {
    if (options.sameSite === "none" && !options.secure) throw new TypeError(`Cookie "${name}": sameSite "none" requires secure: true.`);
    if (options.partitioned && !options.secure) throw new TypeError(`Cookie "${name}": partitioned requires secure: true.`);
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`];
    if (options.domain) parts.push(`Domain=${options.domain}`);
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
    if (options.httpOnly) parts.push("HttpOnly");
    if (options.secure) parts.push("Secure");
    parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
    if (options.partitioned) parts.push("Partitioned");
    return parts.join("; ");
}

// ---- HMAC-SHA256 (pure TS so `@tyvo/core` stays importable outside Node) --------------------------------

function sign(value: string, secret: string): string {
    const encoder = new TextEncoder();
    return base64url(hmacSha256(encoder.encode(secret), encoder.encode(value)));
}

function timingSafeEqual(a: string, b: string): boolean {
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
}

function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
    const block = 64;
    let k = key.length > block ? sha256(key) : key;
    const padded = new Uint8Array(block);
    padded.set(k);
    k = padded;
    const inner = new Uint8Array(block + message.length);
    const outer = new Uint8Array(block + 32);
    for (let i = 0; i < block; i++) {
        inner[i] = k[i]! ^ 0x36;
        outer[i] = k[i]! ^ 0x5c;
    }
    inner.set(message, block);
    outer.set(sha256(inner), block);
    return sha256(outer);
}

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
    const length = data.length;
    const total = Math.ceil((length + 9) / 64) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(data);
    buffer[length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000));
    view.setUint32(total - 4, (length * 8) >>> 0);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

    for (let offset = 0; offset < total; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
            const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
            w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0]! + a) >>> 0;
        h[1] = (h[1]! + b) >>> 0;
        h[2] = (h[2]! + c) >>> 0;
        h[3] = (h[3]! + d) >>> 0;
        h[4] = (h[4]! + e) >>> 0;
        h[5] = (h[5]! + f) >>> 0;
        h[6] = (h[6]! + g) >>> 0;
        h[7] = (h[7]! + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
    return out;
}

/** @internal Exposed for tests. */
export const _hmacSha256Base64url = sign;
