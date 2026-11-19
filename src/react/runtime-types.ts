// Contract between the browser runtime (react-browser) and the client modules (tyvo/router).
// They are separate bundles, so they meet on `window.__tyvo`.

export interface NavigateOptions {
    /** Replace the current history entry instead of pushing a new one. */
    replace?: boolean;
    /** Scroll to the top after navigating. Default: true. */
    scroll?: boolean;
}

export interface TyvoBrowserRuntime {
    navigate(href: string, options?: NavigateOptions): Promise<void>;
    /** Re-render the current URL from the server, keeping client state. */
    refresh(): Promise<void>;
    /** Fetch a page's server component payload ahead of navigation. */
    prefetch(href: string): void;
    /** Navigation pending state, for useSyncExternalStore. */
    subscribe(listener: () => void): () => void;
    isPending(): boolean;
}

declare global {
    interface Window {
        __tyvo?: TyvoBrowserRuntime;
        __TYVO_FLIGHT?: string[];
        __TYVO_BUILD?: string;
        __TYVO_DEV?: boolean;
        /** `prefetch.ttl` from config.ts, set by the server-rendered document. */
        __TYVO_PREFETCH_TTL?: number;
    }
}
