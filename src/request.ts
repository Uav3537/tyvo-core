import { TyvoCookies } from "./cookies.js";
import { getRuntime } from "./runtime.js";
import type { Params } from "./types.js";

export interface TyvoRequestInit<TBody> {
    raw: Request;
    body: TBody;
    params: Params;
    ip: string;
}

/**
 * The request handed to middlewares and route handlers.
 * It only holds plain own properties, so `{ ...request, session }` keeps everything it carries.
 */
export class TyvoRequest<TBody = unknown> {
    readonly method: string;
    readonly url: URL;
    /** Headers as a plain object with lower-case names (`request.headers.authorization`). Replaced by `headerSchema`'s output. */
    readonly headers: Readonly<Record<string, string>>;
    /** Search params as an object; repeated keys become arrays. Replaced by `querySchema`'s output. */
    readonly query: Query;
    /** Cookie jar: `get`/`has`/`all` read, `set`/`delete` become `Set-Cookie` on the response. Typed by `cookieSchema`. */
    readonly cookies: TyvoCookies;
    readonly params: Params;
    /**
     * Body parsed by the route's parser (or `defaultParser` from `config.ts`), replaced by `bodySchema`'s output.
     * `undefined` for body-less requests. The raw stream is `raw.body`.
     */
    readonly body: TBody;
    readonly ip: string;
    readonly signal: AbortSignal;
    /** The original Web `Request`. Its body has not been consumed. */
    readonly raw: Request;

    constructor(init: TyvoRequestInit<TBody>) {
        this.raw = init.raw;
        this.method = init.raw.method.toUpperCase();
        this.url = new URL(init.raw.url);
        this.headers = Object.fromEntries(init.raw.headers);
        this.query = toQuery(this.url.searchParams);
        this.cookies = new TyvoCookies(init.raw.headers.get("cookie"), () => getRuntime().cookies);
        this.params = init.params;
        this.body = init.body;
        this.ip = init.ip;
        this.signal = init.raw.signal;
    }
}

export type Query = Readonly<Record<string, string | string[]>>;

export function toQuery(params: URLSearchParams): Query {
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of params) {
        const existing = query[name];
        query[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    return query;
}

/** Keys every request carries; middlewares add keys on top of these. */
export type TyvoRequestKey = keyof TyvoRequest<unknown>;
