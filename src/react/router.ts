// `@tyvo/core/router` — client-side routing. Shipped with a "use client" banner (see tsup.config.ts), so the hooks and
// components below are client components; pages (server components) render <Link> and use redirect()/notFound().
import {
    Component,
    createContext,
    createElement,
    useCallback,
    useContext,
    useMemo,
    useSyncExternalStore,
    type AnchorHTMLAttributes,
    type ComponentType,
    type ErrorInfo,
    type MouseEvent,
    type ReactNode,
} from "react";
import { readNavigation } from "../navigation.js";
import { hrefString, type CheckHref, type PageMeta, type PageMetaOf, type PagePath, type Params, type ParamsOf } from "../routes.js";
import type { Query } from "../request.js";
import type { NavigateOptions, TyvoBrowserRuntime } from "./runtime-types.js";

export type { NavigateOptions } from "./runtime-types.js";
export { href } from "../routes.js";
export type { CheckHref, Href, PagePath, ParamsOf } from "../routes.js";

interface RouteState {
    pathname: string;
    search: string;
    /** The page's folder path (`/users/[id]`); undefined while a not-found page is shown. */
    path: string | undefined;
    /** Path segments as strings. */
    params: Params;
    /** `params` after the page's `paramSchema` (the same values without one). */
    pageParams: Readonly<Record<string, unknown>>;
    /** The query after the page's `querySchema` (search params as an object without one). */
    pageQuery: Readonly<Record<string, unknown>>;
}

const RouteContext = createContext<RouteState | null>(null);

function runtime(): TyvoBrowserRuntime {
    if (typeof window === "undefined" || !window.__tyvo) {
        throw new Error("[tyvo] the router is only available in the browser (call it from an event handler or effect).");
    }
    return window.__tyvo;
}

/**
 * Client-side navigation. Usable anywhere in browser code (event handlers, effects, plain modules). Targets are
 * checked against the app's pages; build dynamic ones with `href()`:
 *
 * ```ts
 * import { href, router } from "@tyvo/core/router";
 * router.push("/users/1");
 * router.push(href("/users/[id]", { id }));
 * ```
 */
export interface Router {
    push<const H extends string>(href: CheckHref<H> | URL, options?: Omit<NavigateOptions, "replace">): Promise<void>;
    replace<const H extends string>(href: CheckHref<H> | URL, options?: Omit<NavigateOptions, "replace">): Promise<void>;
    back(): void;
    forward(): void;
    /** Re-render the current page from the server; client component state is kept. */
    refresh(): Promise<void>;
    /** Load a page's server component payload ahead of time so navigating to it is instant. */
    prefetch<const H extends string>(href: CheckHref<H> | URL): void;
}

// Typed through the interface: an inferred object type would have CheckHref resolved when the package is built.
export const router: Router = {
    push: (href, options) => runtime().navigate(hrefString(href), { ...options, replace: false }),
    replace: (href, options) => runtime().navigate(hrefString(href), { ...options, replace: true }),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => runtime().refresh(),
    prefetch: (href) => {
        if (typeof window !== "undefined") window.__tyvo?.prefetch(hrefString(href));
    },
};

/** The router, for client components. */
export function useRouter(): Router {
    return router;
}

function useRoute(hook: string): RouteState {
    const route = useContext(RouteContext);
    if (!route) throw new Error(`[tyvo] ${hook}() must be used inside a page rendered by Tyvo.`);
    return route;
}

/** Current path, e.g. `/users/1`. */
export function usePathname(): string {
    return useRoute("usePathname").pathname;
}

/** Current search params (read-only). */
export function useSearchParams(): URLSearchParams {
    const { search } = useRoute("useSearchParams");
    return useMemo(() => new URLSearchParams(search), [search]);
}

type ParamsOutOf<P extends string> = PageMetaOf<P> extends PageMeta ? PageMetaOf<P>["paramsOut"] : ParamsOf<P>;
type QueryOutOf<P extends string> = PageMetaOf<P> extends PageMeta ? PageMetaOf<P>["queryOut"] : Query;

/** The page's state, after checking that `path` is the page being shown. */
function usePage(hook: string, path: string): RouteState {
    const route = useRoute(hook);
    if (route.path !== path) {
        const where = route.path === undefined ? "outside a page (a not-found page is shown)" : `on the page ${JSON.stringify(route.path)}`;
        throw new Error(
            `[tyvo] ${hook}(${JSON.stringify(path)}) is used ${where}. Pass the path of the page it renders on, or call ${hook}() without a path for the raw values.`,
        );
    }
    return route;
}

/**
 * Dynamic segments of the current page.
 * - `useParams("/users/[id]")`: typed for that page, after its `paramSchema` (`id: number`). Throws when another page
 *   is shown, so a component that renders on several pages takes the values as props, or calls `useParams()`.
 * - `useParams()`: the raw segments of whatever page is shown, `[id]` -> string, `[...slug]` -> string[].
 */
export function useParams(): Params;
export function useParams<const P extends PagePath>(path: P): ParamsOutOf<P>;
export function useParams(path?: string): unknown {
    if (path === undefined) return useRoute("useParams").params;
    return usePage("useParams", path).pageParams;
}

/**
 * Search params of the current page as an object.
 * - `useQuery("/search")`: typed for that page, after its `querySchema` (`page: number`). Throws when another page is shown.
 * - `useQuery()`: the raw values of whatever page is shown; repeated keys are arrays.
 */
export function useQuery(): Query;
export function useQuery<const P extends PagePath>(path: P): QueryOutOf<P>;
export function useQuery(path?: string): unknown {
    const route = path === undefined ? useRoute("useQuery") : usePage("useQuery", path);
    const { search, pageQuery } = route;
    return useMemo(() => {
        if (path !== undefined) return pageQuery;
        const query: Record<string, string | string[]> = {};
        for (const [name, value] of new URLSearchParams(search)) {
            const existing = query[name];
            query[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
        }
        return query;
    }, [path, search, pageQuery]);
}

const noopSubscribe = () => () => {};

/** Whether a navigation (or refresh) is in progress. */
export function useNavigation(): { pending: boolean } {
    const pending = useSyncExternalStore(
        typeof window !== "undefined" && window.__tyvo ? window.__tyvo.subscribe : noopSubscribe,
        () => window.__tyvo?.isPending() ?? false,
        () => false,
    );
    return { pending };
}

export interface LinkProps<H extends string = string> extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    /**
     * A page of the app: a literal URL (`"/users/42"`, checked against the pages) or one built with `href()`. Also
     * `#hash`, an absolute URL literal, or a `URL` object for external addresses built at runtime.
     */
    href: CheckHref<H> | URL;
    /** Replace the current history entry instead of pushing a new one. */
    replace?: boolean;
    /** Scroll to the top after navigating. Default: true. */
    scroll?: boolean;
    /** Fetch the target's payload when the link is hovered or focused. Default: true. */
    prefetch?: boolean;
}

/** `<a>` that navigates without a full page load. */
export function Link<const H extends string>({ href: target, replace, scroll, prefetch = true, onClick, onMouseEnter, onFocus, ...rest }: LinkProps<H>) {
    const href = hrefString(target);
    const isInternal = () => new URL(href, window.location.href).origin === window.location.origin;
    const handleClick = useCallback(
        (event: MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            if (!window.__tyvo || event.defaultPrevented || event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if ((rest.target && rest.target !== "_self") || rest.download !== undefined || !isInternal()) return;
            event.preventDefault();
            void window.__tyvo.navigate(href, { replace, scroll });
        },
        [href, replace, scroll, onClick, rest.target, rest.download],
    );
    const warm = () => {
        if (prefetch && isInternal()) window.__tyvo?.prefetch(href);
    };
    return createElement("a", {
        ...rest,
        href,
        onClick: handleClick,
        onMouseEnter: (event: MouseEvent<HTMLAnchorElement>) => {
            onMouseEnter?.(event);
            warm();
        },
        onFocus: (event: Parameters<NonNullable<typeof onFocus>>[0]) => {
            onFocus?.(event);
            warm();
        },
    });
}

// ---- Rendered by Tyvo around pages (not meant to be used directly) ---------------------------------

/** @internal Provides the current route to the hooks above. */
export function RouterProvider({ pathname, search, path, params, pageParams, pageQuery, children }: RouteState & { children?: ReactNode }) {
    const value = useMemo(() => ({ pathname, search, path, params, pageParams, pageQuery }), [pathname, search, path, params, pageParams, pageQuery]);
    return createElement(RouteContext.Provider, { value }, children);
}

interface BoundaryState {
    error: unknown;
    pathname: string;
}

/** Resets a boundary when the URL changes, like Next.js. */
function withPathname<P extends { pathname: string }>(Inner: ComponentType<P>): ComponentType<Omit<P, "pathname">> {
    return function Boundary(props: Omit<P, "pathname">) {
        const route = useContext(RouteContext);
        return createElement(Inner, { ...props, pathname: route?.pathname ?? "" } as P);
    };
}

class ErrorBoundaryInner extends Component<{ errorComponent: ComponentType<{ error: Error; reset: () => void }>; pathname: string; children?: ReactNode }, BoundaryState> {
    override state: BoundaryState = { error: null, pathname: this.props.pathname };

    static getDerivedStateFromError(error: unknown) {
        // redirect()/notFound() are handled by the boundaries above.
        if (readNavigation(error)) throw error;
        return { error };
    }

    static getDerivedStateFromProps(props: { pathname: string }, state: BoundaryState) {
        return props.pathname !== state.pathname ? { error: null, pathname: props.pathname } : null;
    }

    reset = () => {
        this.setState({ error: null });
        void window.__tyvo?.refresh();
    };

    override render() {
        if (this.state.error) return createElement(this.props.errorComponent, { error: this.state.error as Error, reset: this.reset });
        return this.props.children;
    }
}

/** @internal Renders `error.tsx` when something below it throws. */
export const ErrorBoundary = withPathname(ErrorBoundaryInner);

class NotFoundBoundaryInner extends Component<{ fallback: ReactNode; pathname: string; children?: ReactNode }, BoundaryState> {
    override state: BoundaryState = { error: null, pathname: this.props.pathname };

    static getDerivedStateFromError(error: unknown) {
        if (readNavigation(error)?.kind !== "not-found") throw error;
        return { error };
    }

    static getDerivedStateFromProps(props: { pathname: string }, state: BoundaryState) {
        return props.pathname !== state.pathname ? { error: null, pathname: props.pathname } : null;
    }

    override render() {
        return this.state.error ? this.props.fallback : this.props.children;
    }
}

/** @internal Renders `not-found.tsx` when notFound() is thrown below it. */
export const NotFoundBoundary = withPathname(NotFoundBoundaryInner);

/** @internal Turns redirect() thrown during client rendering into router.replace(); unhandled notFound() into a full load (server 404). */
export class RedirectBoundary extends Component<{ children?: ReactNode }, { error: unknown }> {
    override state = { error: null as unknown };

    static getDerivedStateFromError(error: unknown) {
        if (!readNavigation(error)) throw error;
        return { error };
    }

    override componentDidCatch(error: unknown, _info: ErrorInfo) {
        const navigation = readNavigation(error);
        // A redirect() target is any URL the server chose, not necessarily a typed page path.
        if (navigation?.kind === "redirect") void runtime().navigate(navigation.url, { replace: true }).then(() => this.setState({ error: null }));
        else if (navigation?.kind === "not-found") window.location.reload();
    }

    override render() {
        return this.state.error ? null : this.props.children;
    }
}
