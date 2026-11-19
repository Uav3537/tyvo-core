import { applyCookies } from "./cookies.js";
import { applyModifiers, finalize, runSteps } from "./pipeline.js";
import { TyvoRequest } from "./request.js";
import { TyvoResponse } from "./response.js";
import { isGuard, isMiddleware, isModifier } from "./route.js";
import type { ChainState, RouteContext, TyvoGuard, TyvoMiddleware, TyvoModifier } from "./types.js";

export const PROXY = Symbol.for("tyvo.proxy");

export interface ProxyOptions<TMiddlewares extends readonly TyvoMiddleware<any>[], TGuards extends readonly TyvoGuard<any>[] = []> {
    /**
     * Run before every route.ts this proxy wraps, before the body is read and before any schema (outer proxies first,
     * then the route's own guards): authentication and permissions for a whole branch of the API. See `guard()`.
     */
    guards?: TGuards;
    /**
     * Run after the route's schemas, ahead of the route's own middlewares (outer proxies first): they see the
     * validated request. What guards and middlewares add is typed in the routes below.
     */
    middlewares?: TMiddlewares;
    /** Run on every response of the routes this proxy wraps, after the route's own modifiers (inner proxies first). */
    modifiers?: readonly TyvoModifier[];
}

export interface ProxyDefinition<
    TMiddlewares extends readonly TyvoMiddleware<any>[] = readonly TyvoMiddleware<any>[],
    TGuards extends readonly TyvoGuard<any>[] = readonly TyvoGuard<any>[],
> {
    readonly [PROXY]: true;
    readonly guards: TGuards;
    readonly middlewares: TMiddlewares;
    readonly modifiers: readonly TyvoModifier[];
}

/**
 * The default export of `proxy.ts`. A proxy wraps every route.ts in its folder and the folders below it — the way a
 * layout wraps pages, but for routes only (pages are not affected):
 *
 * ```ts
 * // src/app/api/admin/proxy.ts
 * export default proxy({ guards: [webAuth, adminOnly], modifiers: [noStore] });
 * ```
 *
 * For a request to `src/app/api/admin/users/route.ts` the order is: CORS, rate limit; the guards of `app/proxy.ts`,
 * `app/api/proxy.ts`, `app/api/admin/proxy.ts` (outer first) and the route's own; body parsing and the route's schemas;
 * the proxies' middlewares (outer first) and the route's own; the handler; the route's modifiers, then the proxies'
 * (inner first). A guard or middleware runs at most once per request, even when a proxy and the route both list it.
 */
export function proxy<const TMiddlewares extends readonly TyvoMiddleware<any>[] = [], const TGuards extends readonly TyvoGuard<any>[] = []>(
    options: ProxyOptions<TMiddlewares, TGuards>,
): ProxyDefinition<TMiddlewares, TGuards> {
    if (typeof options !== "object" || options === null) throw new TypeError("proxy(): pass { guards, middlewares, modifiers }.");
    const guards = (options.guards ?? []) as TGuards;
    const middlewares = (options.middlewares ?? []) as TMiddlewares;
    const modifiers = options.modifiers ?? [];
    if (!Array.isArray(guards) || !guards.every(isGuard)) throw new TypeError("proxy(): every entry of `guards` must be created with guard().");
    if (!Array.isArray(middlewares) || !middlewares.every(isMiddleware)) throw new TypeError("proxy(): every entry of `middlewares` must be created with middleware().");
    if (!Array.isArray(modifiers) || !modifiers.every(isModifier)) throw new TypeError("proxy(): every entry of `modifiers` must be created with modifier().");
    return Object.freeze({ [PROXY]: true as const, guards, middlewares, modifiers });
}

export function isProxy(value: unknown): value is ProxyDefinition {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[PROXY] === true;
}

/** Guards and middlewares of a proxy chain (outer first) and its modifiers in the order they apply (inner first). */
export function proxyParts(proxies: readonly ProxyDefinition[]): { guards: TyvoGuard<any>[]; middlewares: TyvoMiddleware<any>[]; modifiers: TyvoModifier[] } {
    return {
        guards: proxies.flatMap((entry) => entry.guards),
        middlewares: proxies.flatMap((entry) => entry.middlewares),
        modifiers: [...proxies].reverse().flatMap((entry) => entry.modifiers),
    };
}

/**
 * Runs a hand-written route function (`export function GET(request)`) inside its proxies: their guards, then their
 * middlewares, may end the request; otherwise the function's `Response` goes through their modifiers. `route()`
 * exports run their proxies themselves (guards before the body and schemas, middlewares after).
 */
export async function runProxied(proxies: readonly ProxyDefinition[], raw: Request, context: RouteContext, call: () => Promise<Response>): Promise<Response> {
    const { guards, middlewares, modifiers } = proxyParts(proxies);
    const request = new TyvoRequest({ raw, body: undefined, params: context.params, ip: context.ip });
    const state: ChainState = { request, executed: new Set() };
    const ended = (await runSteps(guards, state)) ?? (await runSteps(middlewares, state));
    const chain = state.request;
    if (ended) return applyCookies(finalize(await applyModifiers(modifiers, request, ended), undefined), request.cookies);
    const response = await call();
    // Not a Response: the caller reports it.
    if (!(response instanceof Response)) return response;
    if (modifiers.length === 0) return applyCookies(response, request.cookies);
    const wrapped = new TyvoResponse<unknown>({ status: response.status, headers: response.headers, kind: "binary", data: response.body });
    return applyCookies(finalize(await applyModifiers(modifiers, chain as TyvoRequest, wrapped), undefined), request.cookies);
}
