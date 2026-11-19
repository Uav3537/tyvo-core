import type { Href } from "./routes.js";
import { TyvoCookies } from "./cookies.js";
import { emit } from "./log.js";
import { readNavigation } from "./navigation.js";
import { consume, isRatelimitOptions, type RatelimitOptions } from "./ratelimit.js";
import { TyvoRequest } from "./request.js";
import { HttpError, TyvoResponse, builtFrom, isTyvoProceed, isTyvoResponse } from "./response.js";
import type { Runtime } from "./runtime.js";
import { RUN, type ChainState, type ChainStep, type RequestSchemas, type RouteContext, type Schema, type TyvoModifier } from "./types.js";

// Request processing shared by route() and page().

export interface Issue {
    /** Which part failed: "body" | "query" | "params" | "headers" | "cookies" | "request" (the `schema` option). */
    in: string;
    path: string[];
    message: string;
    code: string;
}

type AnySchemas = RequestSchemas<Schema | undefined, Schema | undefined, Schema | undefined, Schema | undefined, Schema | undefined, Schema | undefined>;
type ParseResult = Awaited<ReturnType<Schema["safeParseAsync"]>>;

export function hasSchemas(schemas: AnySchemas): boolean {
    return !!(schemas.bodySchema || schemas.querySchema || schemas.paramSchema || schemas.headerSchema || schemas.cookieSchema || schemas.schema);
}

/**
 * Runs every schema with `safeParseAsync` and replaces the validated fields with the outputs.
 * All failures are collected and thrown together as one 400 response listing each issue and where it came from.
 */
export async function validateRequest<T extends object>(schemas: AnySchemas, request: T): Promise<T> {
    const issues: Issue[] = [];
    const next = { ...request } as Record<string, unknown>;

    const collect = (part: string, result: ParseResult, fallback: unknown): unknown => {
        if (result.success) return result.data;
        for (const issue of result.error.issues) {
            issues.push({ in: part, path: issue.path.map(String), message: issue.message, code: issue.code });
        }
        return fallback;
    };

    if (schemas.bodySchema) next.body = collect("body", await schemas.bodySchema.safeParseAsync(next.body), next.body);
    // zod strips unknown keys; merging keeps the headers/query other middlewares rely on.
    if (schemas.querySchema) next.query = mergeOver(next.query, collect("query", await parseQuery(schemas.querySchema, next.query), undefined));
    // Path segments are strings too: same conversion as the query.
    if (schemas.paramSchema) next.params = mergeOver(next.params, collect("params", await parseQuery(schemas.paramSchema, next.params), undefined));
    if (schemas.headerSchema) next.headers = mergeOver(next.headers, collect("headers", await schemas.headerSchema.safeParseAsync(next.headers), undefined));
    if (schemas.cookieSchema && next.cookies instanceof TyvoCookies) {
        // Cookie values are strings too: same conversion as the query. The jar keeps recording changes.
        const jar = next.cookies;
        const output = collect("cookies", await parseQuery(schemas.cookieSchema, jar.all()), undefined);
        if (output && typeof output === "object") next.cookies = jar._withValues(output as Record<string, unknown>);
    }
    if (schemas.schema) {
        const { headers: _headers, body: _body, ...rest } = next;
        const output = collect("request", await schemas.schema.safeParseAsync(rest), undefined);
        if (output && typeof output === "object") Object.assign(next, output);
    }

    if (issues.length) throw new HttpError(400, "Invalid request", { error: "Invalid request", issues });
    return next as T;
}

function mergeOver(original: unknown, output: unknown): unknown {
    return output && typeof output === "object" ? { ...(original as object), ...output } : original;
}

/** Query, params and cookies arrive as strings: convert them to what the schema accepts (see `coerce`), then validate once. */
export function parseQuery(schema: Schema, query: unknown): Promise<ParseResult> {
    return schema.safeParseAsync(coerce(schema, query));
}

/** The parts of zod's schema definitions (`schema._zod.def`) the conversion follows. */
interface Def {
    type: string;
    innerType?: Schema;
    in?: Schema;
    getter?: () => Schema;
    shape?: Record<string, Schema>;
    element?: Schema;
    options?: Schema[];
    left?: Schema;
    right?: Schema;
    values?: unknown[];
    entries?: Record<string, unknown>;
}

// One spelling per number: no leading zeros, no "-0", no trailing zeros in the fraction ("1.50" is "1.5").
const INTEGER = /^(?:0|-?[1-9]\d*)$/;
const DECIMAL = /^(?:0|-?[1-9]\d*|-?(?:0|[1-9]\d*)\.\d*[1-9])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Converts URL strings to what `schema` accepts at each place, following its structure (objects, arrays, unions,
 * optional/nullable/default, pipes, lazy, literals, enums). Conversions are strict, so one value never has several
 * spellings: numbers are canonical decimals (`42`, `-1.5`; not `042`, `0x2A`, `4.2e1`, ` 42`, `-0`, `1.50`), booleans `true`/`false`,
 * bigints integers, dates ISO 8601. A union takes its first option the converted value satisfies. Values that do not
 * convert are left as they are, so validation reports them.
 */
export function coerce(schema: Schema, value: unknown): unknown {
    const def = (schema as unknown as { _zod?: { def?: Def } })._zod?.def;
    if (!def || value === undefined) return value;
    switch (def.type) {
        case "optional":
        case "nullable":
        case "nonoptional":
        case "default":
        case "prefault":
        case "catch":
        case "readonly":
            return def.innerType ? coerce(def.innerType, value) : value;
        case "pipe":
            return def.in ? coerce(def.in, value) : value;
        case "lazy":
            return def.getter ? coerce(def.getter(), value) : value;
        case "object": {
            if (!isPlainObject(value) || !def.shape) return value;
            const out: Record<string, unknown> = { ...value };
            for (const [key, field] of Object.entries(def.shape)) if (key in out) out[key] = coerce(field, out[key]);
            return out;
        }
        case "array":
            if (!def.element) return value;
            if (Array.isArray(value)) return value.map((item) => coerce(def.element!, item));
            // `?tag=a` where an array is expected: one value is a one-item array.
            return typeof value === "string" ? [coerce(def.element, value)] : value;
        case "union":
            for (const option of def.options ?? []) {
                const candidate = coerce(option, value);
                if (accepts(option, candidate)) return candidate;
            }
            return value;
        case "intersection":
            return def.left && def.right ? coerce(def.right, coerce(def.left, value)) : value;
        case "number":
            return typeof value === "string" && DECIMAL.test(value) ? Number(value) : value;
        case "bigint":
            return typeof value === "string" && INTEGER.test(value) ? BigInt(value) : value;
        case "boolean":
            return value === "true" ? true : value === "false" ? false : value;
        case "date":
            return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value) : value;
        case "literal":
            return typeof value === "string" ? matchPrimitive(value, def.values ?? []) : value;
        case "enum":
            return typeof value === "string" ? matchPrimitive(value, Object.values(def.entries ?? {})) : value;
        default:
            return value;
    }
}

/** The non-string literal/enum value `text` spells, if any (`"42"` for `z.literal(42)`). */
function matchPrimitive(text: string, values: readonly unknown[]): unknown {
    if (values.includes(text)) return text;
    for (const candidate of values) {
        if (typeof candidate === "number" && DECIMAL.test(text) && Number(text) === candidate) return candidate;
        if (typeof candidate === "bigint" && INTEGER.test(text) && BigInt(text) === candidate) return candidate;
        if (typeof candidate === "boolean" && text === String(candidate)) return candidate;
    }
    return text;
}

function accepts(schema: Schema, value: unknown): boolean {
    try {
        return schema.safeParse(value).success;
    } catch {
        // Async refinements cannot run synchronously: take the option, the real (async) validation follows.
        return true;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Thrown when a handler's response does not match its route's `responseSchema`: a server bug, so a 500 (logged). */
export class ResponseValidationError extends Error {
    override name = "ResponseValidationError";

    constructor(readonly issues: Omit<Issue, "in">[]) {
        super(`Response does not match responseSchema: ${issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ")}`);
    }
}

/** `responseSchema`: parses the JSON body of a 2xx response; the output replaces it. Other responses pass unchanged. */
export async function validateResponse(schema: Schema | undefined, response: TyvoResponse<any>): Promise<TyvoResponse<any>> {
    if (!schema || response.kind !== "json" || response.statusCode < 200 || response.statusCode >= 300) return response;
    const result = await schema.safeParseAsync(response.data);
    if (!result.success) {
        throw new ResponseValidationError(result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message, code: issue.code })));
    }
    return new TyvoResponse({ status: response.statusCode, headers: response.headers, kind: "json", data: result.data });
}

/** Runs modifiers in order; each sees the response the previous one produced. */
export async function applyModifiers(modifiers: readonly TyvoModifier[], request: TyvoRequest<any>, response: TyvoResponse<any>): Promise<TyvoResponse<any>> {
    for (const entry of modifiers) response = await entry(request, response);
    return response;
}

/**
 * Runs guards or middlewares in order on `state` (one per request, shared by the guard and middleware stages so
 * nothing runs twice). Resolves to the response that ended the chain, or undefined (the result is `state.request`).
 */
export async function runSteps(steps: readonly ChainStep[], state: ChainState): Promise<TyvoResponse<any> | undefined> {
    for (const entry of steps) {
        const ended = await entry[RUN](state);
        if (ended) return ended;
    }
    return undefined;
}

/** Runs middlewares in order on a fresh state. Resolves to the response that ended the chain, or the resulting request. */
export async function runChain(steps: readonly ChainStep[], request: TyvoRequest<any>): Promise<TyvoResponse<any> | object> {
    const state: ChainState = { request, executed: new Set() };
    return (await runSteps(steps, state)) ?? state.request;
}

/**
 * Applies what a guard or middleware handler returned: a `TyvoResponse` ends the request (returned), a
 * `response.proceed(added)` merges `added` into `state.request` (every key, the request's own included, as the
 * types say). Anything else is an error naming the handler, and so is a proceed after the handler made a response
 * from its `builder` (a forgotten `return`).
 */
export function settle(state: ChainState, result: unknown, who: string, builder: TyvoResponse<any>): TyvoResponse<any> | undefined {
    if (isTyvoResponse(result)) return result;
    if (isTyvoProceed(result)) {
        // Fail closed: `if (!user) response.status(401).json(...)` without `return` must not let the request through.
        if (builtFrom(builder)) {
            throw new TypeError(
                `${who} made a response (e.g. response.status(401).json(...)) but returned response.proceed(): a missing \`return\` in front of the response? The request is not passed on.`,
            );
        }
        state.request = { ...state.request, ...result.added };
        return undefined;
    }
    throw new TypeError(`${who} must return a TyvoResponse to end the request or response.proceed(...) to pass it on, on every path; got ${describe(result)}.`);
}

/** The route's `ratelimit` on top of `defaultRatelimit` from `config.ts`. */
export function resolveRatelimit(route: Partial<RatelimitOptions> | false | undefined, fallback: RatelimitOptions | false): RatelimitOptions | undefined {
    if (route === false) return undefined;
    if (route === undefined) return fallback || undefined;
    const merged = { ...(fallback || {}), ...route };
    if (!isRatelimitOptions(merged)) {
        throw new TypeError("route `ratelimit` needs `timeWindow`, `max` and `key` when defaultRatelimit in config.ts is false.");
    }
    return merged;
}

export async function applyRatelimit(runtime: Runtime, limit: RatelimitOptions, raw: Request, context: Partial<RouteContext>): Promise<Headers> {
    const pattern = context.pattern ?? new URL(raw.url).pathname;
    const key = await limit.key(new TyvoRequest({ raw, body: undefined, params: context.params ?? {}, ip: context.ip ?? "" }), { pattern });
    if (typeof key !== "string") throw new TypeError(`ratelimit key() must return a string, got ${describe(key)}.`);
    const state = await consume(runtime.storage, key, limit);
    const reset = String(Math.ceil((state.resetAt - Date.now()) / 1000));
    const headers = new Headers({
        "ratelimit-limit": String(state.limit),
        "ratelimit-remaining": String(state.remaining),
        "ratelimit-reset": reset,
    });
    if (!state.allowed) {
        headers.set("retry-after", reset);
        throw new HttpError(429, undefined, undefined, headers);
    }
    return headers;
}

/** Builds the outgoing response and adds framework headers (rate limit) the handler did not set. */
export function finalize(response: TyvoResponse<unknown>, extra: Headers | undefined): Response {
    const built = response._build();
    for (const [name, value] of extra ?? []) {
        if (!built.headers.has(name)) built.headers.set(name, value);
    }
    return built;
}

/** Every error — Tyvo's own `HttpError`s included — becomes a response through `onError` in `config.ts`. */
export async function errorResponse(runtime: Runtime, error: unknown, raw: Request): Promise<TyvoResponse<unknown>> {
    return toErrorResponse(runtime.config.onError, error, raw);
}

export async function toErrorResponse(onError: Runtime["config"]["onError"], error: unknown, raw: Request): Promise<TyvoResponse<unknown>> {
    // redirect() / notFound() thrown from a handler, middleware or loader.
    const navigation = readNavigation(error);
    if (navigation?.kind === "redirect") return new TyvoResponse().redirect(navigation.url as Href, navigation.status); // checked where redirect() was called
    if (navigation?.kind === "not-found") error = new HttpError(404);
    // Tyvo's own HttpErrors (400, 404, 429, ...) are answers, not failures; anything else is logged.
    if (!(error instanceof HttpError)) emit({ type: "message", level: "error", message: `${raw.method} ${pathOf(raw)} failed`, error, request: raw });
    try {
        const result: unknown = await onError(error, raw, new TyvoResponse());
        if (isTyvoResponse(result)) return result;
        emit({ type: "message", level: "error", message: `onError() in config.ts must return a TyvoResponse, got ${describe(result)}.`, request: raw });
    } catch (inner) {
        emit({ type: "message", level: "error", message: `onError() in config.ts threw while handling ${raw.method} ${pathOf(raw)}`, error: inner, request: raw });
    }
    // Only reached when onError itself is broken.
    return new TyvoResponse().json({ error: "Internal Server Error" }, 500);
}

/** Path and query of a request, for log messages. */
export function pathOf(request: Request): string {
    const url = new URL(request.url);
    return url.pathname + url.search;
}

export function describe(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value instanceof Response) return "a Response (return response.json(...) etc. instead)";
    return typeof value;
}
