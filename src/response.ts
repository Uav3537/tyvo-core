import { hrefString, type CheckHref } from "./routes.js";

export const RESPONSE = Symbol.for("tyvo.response");

type BodyKind = "empty" | "json" | "text" | "html" | "binary" | "stream" | "sse";

/** Chunks of `response.stream()`: strings are sent as UTF-8. */
export type StreamChunk = string | Uint8Array;
export type StreamSource = ReadableStream<StreamChunk> | AsyncIterable<StreamChunk>;

/** One server-sent event. `data` is sent as-is when it is a string, as JSON otherwise. */
export interface SseEvent {
    data: unknown;
    /** Event name (`addEventListener(event, ...)` in the browser); without it the browser fires "message". */
    event?: string;
    /** Sent back by the browser as `Last-Event-ID` when it reconnects. */
    id?: string;
    /** Reconnection delay for the browser, in milliseconds. */
    retry?: number;
}

export interface SseOptions {
    /**
     * Sends a `: keep-alive` comment every this many milliseconds while no event is due, so proxies and load
     * balancers do not close an idle stream. `false` (the default) sends none.
     */
    keepAlive?: number | false;
}

interface ResponseState<T> {
    status: number;
    headers: Headers;
    kind: BodyKind;
    data: T;
    sse: SseOptions | undefined;
}

/**
 * Immutable response description. Every method returns a new instance whose type carries the body,
 * e.g. `response.json({ a: 1 })` is a `TyvoResponse<{ a: number }>`.
 * Handlers only return it; the framework turns it into a real `Response` with `_build()`.
 */
export class TyvoResponse<T = undefined> {
    readonly [RESPONSE] = true;
    readonly statusCode: number;
    readonly headers: Headers;
    readonly kind: BodyKind;
    readonly data: T;
    private readonly sseOptions: SseOptions | undefined;

    constructor(state?: Partial<ResponseState<T>>) {
        this.statusCode = state?.status ?? 200;
        this.headers = new Headers(state?.headers);
        this.kind = state?.kind ?? "empty";
        this.data = state?.data as T;
        this.sseOptions = state?.sse;
    }

    status(code: number): TyvoResponse<T> {
        return this.with({ status: code });
    }

    /** Sets several headers at once (e.g. the ones carried by an `HttpError`). */
    withHeaders(init: HeadersInit): TyvoResponse<T> {
        const headers = new Headers(this.headers);
        for (const [name, value] of new Headers(init)) headers.set(name, value);
        return this.with({ headers });
    }

    header(name: string, value: string): TyvoResponse<T> {
        const headers = new Headers(this.headers);
        headers.set(name, value);
        return this.with({ headers });
    }

    json<D>(data: D, status?: number): TyvoResponse<D> {
        return this.with({ kind: "json", data, status });
    }

    text<const D extends string>(data: D, status?: number): TyvoResponse<D> {
        return this.with({ kind: "text", data, status });
    }

    html(data: string, status?: number): TyvoResponse<string> {
        return this.with({ kind: "html", data, status });
    }

    /** Raw body (stream, bytes, Blob, FormData, ...). */
    binary<D extends BodyInit>(data: D, status?: number): TyvoResponse<D> {
        return this.with({ kind: "binary", data, status });
    }

    /**
     * Streams the body as it is produced: a `ReadableStream` or an async iterable (e.g. an async generator) of
     * strings and bytes. Set the content type with `.header("content-type", ...)`.
     * When the client disconnects, the iterator is closed (`finally` blocks run); `request.signal` aborts too.
     */
    stream<D extends StreamSource>(source: D, status?: number): TyvoResponse<D> {
        if (!isStreamSource(source)) throw new TypeError("response.stream() needs a ReadableStream or an async iterable.");
        return this.with({ kind: "stream", data: source, status });
    }

    /**
     * Server-sent events (`text/event-stream`, read with `new EventSource(url)` in the browser) from an async
     * iterable of `{ data, event?, id?, retry? }`, typically an async generator:
     *
     * ```ts
     * handler: (request, response) =>
     *     response.sse(async function* () {
     *         while (!request.signal.aborted) {
     *             yield { event: "time", data: { now: Date.now() } };
     *             await setTimeout(1000);
     *         }
     *     }(), { keepAlive: 15_000 }),
     * ```
     *
     * `cache-control: no-cache` is set unless the response already has a cache-control header.
     */
    sse<D extends AsyncIterable<SseEvent>>(source: D, options: SseOptions = {}): TyvoResponse<D> {
        if (!isAsyncIterable(source)) throw new TypeError("response.sse() needs an async iterable of { data, event?, id?, retry? }, e.g. an async generator.");
        const keepAlive = options.keepAlive ?? false;
        if (keepAlive !== false && !(Number.isFinite(keepAlive) && keepAlive > 0)) throw new TypeError("response.sse(): `keepAlive` must be a positive number of milliseconds or false.");
        return this.with({ kind: "sse", data: source, sse: { keepAlive } });
    }

    /**
     * Redirects. The target is checked like `<Link href>`: a page of the app (a literal, or built with `href()`),
     * `#hash`, an absolute URL literal, or a `URL` object for external addresses built at runtime.
     */
    redirect<const H extends string>(location: CheckHref<H> | URL, status: 301 | 302 | 303 | 307 | 308 = 302): TyvoResponse<undefined> {
        const headers = new Headers(this.headers);
        headers.set("location", hrefString(location));
        return this.with({ kind: "empty", data: undefined, status, headers });
    }

    empty(status = 204): TyvoResponse<undefined> {
        return this.with({ kind: "empty", data: undefined, status });
    }

    /**
     * For guards and middlewares: pass the request on to the next step, adding `added` to it (typed for everything
     * after). Not a response: nothing set on this builder (status, headers) is sent, and a route handler cannot
     * return it.
     *
     * ```ts
     * return response.proceed({ user });   // continue, with request.user
     * return response.proceed();           // continue unchanged
     * ```
     */
    proceed(): TyvoProceed<{}>;
    proceed<TAdded extends object>(added: TAdded): TyvoProceed<TAdded>;
    proceed(added: object = {}): TyvoProceed<object> {
        return new TyvoProceed(added);
    }

    /**
     * @internal Called by the framework to produce the outgoing `Response`. Not meant for handlers.
     */
    _build(): Response {
        const headers = new Headers(this.headers);
        const contentType = (type: string) => {
            if (!headers.has("content-type")) headers.set("content-type", type);
        };
        let body: BodyInit | null = null;
        switch (this.kind) {
            case "json":
                body = JSON.stringify(this.data) ?? "null";
                contentType("application/json; charset=utf-8");
                break;
            case "text":
                body = String(this.data);
                contentType("text/plain; charset=utf-8");
                break;
            case "html":
                body = String(this.data);
                contentType("text/html; charset=utf-8");
                break;
            case "binary":
                body = this.data as BodyInit;
                break;
            case "stream":
                body = byteStream(this.data as StreamSource);
                break;
            case "sse":
                body = eventStream(this.data as AsyncIterable<SseEvent>, this.sseOptions?.keepAlive ?? false);
                contentType("text/event-stream; charset=utf-8");
                if (!headers.has("cache-control")) headers.set("cache-control", "no-cache");
                break;
        }
        // 204/304 must not carry a body.
        if (this.statusCode === 204 || this.statusCode === 304) body = null;
        return new Response(body, { status: this.statusCode, headers });
    }

    private with<D = T>(patch: Partial<ResponseState<D>> & { status?: number | undefined }): TyvoResponse<D> {
        const next = new TyvoResponse<D>({
            status: patch.status ?? this.statusCode,
            headers: patch.headers ?? this.headers,
            kind: patch.kind ?? this.kind,
            data: ("data" in patch ? patch.data : this.data) as D,
            sse: "sse" in patch ? patch.sse : this.sseOptions,
        });
        // A builder handed to a guard or middleware remembers whether a response body was made from it.
        const lineage = lineages.get(this);
        if (lineage) {
            lineages.set(next, lineage);
            if (patch.kind !== undefined) lineage.built = true;
        }
        return next;
    }
}

/** Builders handed to guard and middleware handlers, and every response made from them. */
const lineages = new WeakMap<TyvoResponse<any>, { built: boolean }>();

/** @internal A fresh builder for a guard or middleware handler, see `builtFrom`. */
export function trackedBuilder(): TyvoResponse {
    const builder = new TyvoResponse();
    lineages.set(builder, { built: false });
    return builder;
}

/**
 * @internal Whether a response (json, text, redirect, ...) was made from this builder. A handler that made one but
 * returned `response.proceed()` most likely forgot a `return` in front of it.
 */
export function builtFrom(builder: TyvoResponse<any>): boolean {
    return lineages.get(builder)?.built ?? false;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return typeof value === "object" && value !== null && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
}

function isStreamSource(value: unknown): value is StreamSource {
    return value instanceof ReadableStream || isAsyncIterable(value);
}

const encoder = new TextEncoder();
const toBytes = (chunk: StreamChunk): Uint8Array => (typeof chunk === "string" ? encoder.encode(chunk) : chunk);

/**
 * Pull-based: nothing is read from the source until the body is consumed (a HEAD response never starts it),
 * and cancelling the body (client gone) closes the iterator.
 */
function iteratorStream<T>(source: AsyncIterable<T>, encode: (value: T) => Uint8Array, keepAlive: number | false = false): ReadableStream<Uint8Array> {
    let iterator: AsyncIterator<T> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => clearInterval(timer);
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!iterator) {
                iterator = source[Symbol.asyncIterator]();
                if (keepAlive) {
                    timer = setInterval(() => {
                        try {
                            controller.enqueue(encoder.encode(": keep-alive\n\n"));
                        } catch {
                            stop();
                        }
                    }, keepAlive);
                }
            }
            try {
                const { done, value } = await iterator.next();
                if (done) {
                    stop();
                    controller.close();
                } else {
                    controller.enqueue(encode(value));
                }
            } catch (error) {
                stop();
                controller.error(error);
            }
        },
        cancel() {
            stop();
            // Not awaited: a generator suspended in an `await` only returns once that settles.
            iterator?.return?.()?.catch(() => {});
        },
    });
}

function byteStream(source: StreamSource): ReadableStream<Uint8Array> {
    if (source instanceof ReadableStream) {
        return source.pipeThrough(new TransformStream<StreamChunk, Uint8Array>({ transform: (chunk, controller) => controller.enqueue(toBytes(chunk)) }));
    }
    return iteratorStream(source, toBytes);
}

function eventStream(source: AsyncIterable<SseEvent>, keepAlive: number | false): ReadableStream<Uint8Array> {
    return iteratorStream(source, (event) => encoder.encode(formatEvent(event)), keepAlive);
}

/** One event in the `text/event-stream` format; multi-line data becomes several `data:` lines. */
export function formatEvent(event: SseEvent): string {
    if (typeof event !== "object" || event === null || !("data" in event)) {
        throw new TypeError(`response.sse(): every event must be an object { data, event?, id?, retry? }, got ${event === null ? "null" : typeof event}.`);
    }
    const field = (name: string, value: string) => {
        if (/[\r\n]/.test(value) || (name === "id" && value.includes("\0"))) throw new TypeError(`response.sse(): event \`${name}\` must not contain line breaks.`);
        return `${name}: ${value}\n`;
    };
    let out = "";
    if (event.event !== undefined) out += field("event", String(event.event));
    if (event.id !== undefined) out += field("id", String(event.id));
    if (event.retry !== undefined) {
        if (!Number.isInteger(event.retry) || event.retry < 0) throw new TypeError("response.sse(): event `retry` must be a non-negative integer (milliseconds).");
        out += `retry: ${event.retry}\n`;
    }
    const data = typeof event.data === "string" ? event.data : (JSON.stringify(event.data) ?? "null");
    for (const line of data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
    return out + "\n";
}

const PROCEED = Symbol.for("tyvo.proceed");

/**
 * What `response.proceed(added)` returns: "pass the request on, with these fields added". Guards and middlewares
 * return either this or a `TyvoResponse` (which ends the request) on every path.
 */
export class TyvoProceed<TAdded extends object = {}> {
    readonly [PROCEED] = true as const;
    /** What the next steps see added to the request. */
    readonly added: TAdded;

    constructor(added: TAdded) {
        const proto = typeof added === "object" && added !== null ? Object.getPrototypeOf(added) : undefined;
        if (typeof added !== "object" || added === null || Array.isArray(added) || (proto !== Object.prototype && proto !== null)) {
            throw new TypeError("response.proceed(added): `added` must be a plain object, e.g. { user }.");
        }
        this.added = added;
    }
}

/** `instanceof` that also works across duplicated copies of the package. */
export function isTyvoProceed(value: unknown): value is TyvoProceed<object> {
    return value instanceof TyvoProceed || (typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[PROCEED] === true);
}

/** `instanceof` that also works across duplicated copies of the package. */
export function isTyvoResponse(value: unknown): value is TyvoResponse<unknown> {
    return value instanceof TyvoResponse || (typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[RESPONSE] === true);
}

/**
 * Throw from a handler or middleware to end the request with the given status. Tyvo itself throws it for
 * 400 (invalid body/schema), 404, 405, 413 and 429; `onError` in `config.ts` turns it into the response.
 */
export class HttpError extends Error {
    override name = "HttpError";
    /** Headers the response should carry, e.g. `allow` for 405 or `retry-after` for 429. */
    readonly headers: Headers;

    constructor(
        readonly status: number,
        message?: string,
        /** Response body to send instead of the default `{ error: message }`. */
        readonly body?: unknown,
        headers?: HeadersInit,
    ) {
        super(message ?? defaultStatusText(status));
        this.headers = new Headers(headers);
    }
}

function defaultStatusText(status: number): string {
    const texts: Record<number, string> = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        409: "Conflict",
        422: "Unprocessable Entity",
        429: "Too Many Requests",
        500: "Internal Server Error",
    };
    return texts[status] ?? `HTTP ${status}`;
}
