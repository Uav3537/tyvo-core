// Browser bootstrap: hydrates the server-rendered document and implements navigation, prefetching,
// server action calls and (in development) live updates. Client modules reach it through `window.__tyvo`.
import "./browser-shim.js";
import { createElement, startTransition, use, useEffect, useLayoutEffect, useState, useTransition, type ReactElement, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
// @ts-expect-error no type declarations are published for react-server-dom-turbopack
import { createFromFetch, createFromReadableStream, encodeReply } from "react-server-dom-turbopack/client.browser";
import { ACTION_HEADER, ACTION_PATH, DEV_PATH, RSC_CONTENT_TYPE, RSC_HEADER } from "./manifest.js";
import type { NavigateOptions, TyvoBrowserRuntime } from "./runtime-types.js";

// ---- Server actions -------------------------------------------------------------------------------

interface ActionResult {
    value: Promise<unknown>;
    redirect?: string;
}

/** Called by React for every server action: POST the encoded arguments, decode the returned payload. */
async function callServer(id: string, args: unknown[]): Promise<unknown> {
    const response = fetch(ACTION_PATH, {
        method: "POST",
        headers: { [ACTION_HEADER]: id, accept: RSC_CONTENT_TYPE },
        body: await encodeReply(args),
    });
    const result: ActionResult = await createFromFetch(response, { callServer });
    if (result.redirect) {
        void navigate(result.redirect, { replace: false });
        return undefined;
    }
    const value = await result.value;
    // Actions usually change data: re-render the current page from the server (client state is kept).
    void refresh();
    return value;
}
(globalThis as { __tyvo_callServer?: typeof callServer }).__tyvo_callServer = callServer;

// ---- Payload loading ------------------------------------------------------------------------------

/** Turns the inline `<script>` Flight chunks into a stream; later chunks arrive through the patched `push`. */
function inlineFlightStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            const chunks = (window.__TYVO_FLIGHT ??= []);
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            chunks.push = (...items: string[]) => {
                for (const item of items) controller.enqueue(encoder.encode(item));
                return 0;
            };
            const close = () => controller.close();
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", close, { once: true });
            else close();
        },
    });
}

const prefetched = new Map<string, { response: Promise<Response>; at: number }>();

function request(href: string): Promise<Response> {
    return fetch(href, { headers: { [RSC_HEADER]: "1" } });
}

function takePrefetched(href: string): Promise<Response> | undefined {
    const entry = prefetched.get(href);
    prefetched.delete(href);
    return entry && Date.now() - entry.at < (window.__TYVO_PREFETCH_TTL ?? 0) ? entry.response : undefined;
}

/** Resolves to the new tree, or never when the response is not a page (then a full load takes over). */
async function loadTree(responsePromise: Promise<Response>, href: string, onFinalUrl: (url: string) => void): Promise<ReactNode> {
    const response = await responsePromise;
    if (!response.headers.get("content-type")?.includes(RSC_CONTENT_TYPE)) {
        window.location.href = response.url || href;
        return new Promise<never>(() => {});
    }
    if (response.redirected) onFinalUrl(response.url);
    return createFromFetch(Promise.resolve(response), { callServer });
}

// ---- Root component and navigation state ----------------------------------------------------------

let setTree: ((tree: Promise<ReactNode>) => void) | undefined;
let startNavigation: ((callback: () => void) => void) = startTransition;
let pending = false;
const listeners = new Set<() => void>();
let afterCommit: (() => void) | undefined;

function setPending(value: boolean) {
    if (pending === value) return;
    pending = value;
    for (const listener of listeners) listener();
}

function Root({ initial }: { initial: Promise<ReactNode> }) {
    const [tree, set] = useState(initial);
    const [isPending, start] = useTransition();
    setTree = set;
    startNavigation = start;
    useEffect(() => setPending(isPending), [isPending]);
    useLayoutEffect(() => {
        const callback = afterCommit;
        afterCommit = undefined;
        callback?.();
    }, [tree]);
    return use(tree) as ReactElement;
}

let historyKey = 0;
const scrollPositions = new Map<number, number>();

function currentKey(): number {
    const state = window.history.state as { __tyvo?: number } | null;
    return typeof state?.__tyvo === "number" ? state.__tyvo : 0;
}

function render(tree: Promise<ReactNode>, then: () => void) {
    afterCommit = then;
    startNavigation(() => setTree?.(tree));
}

async function navigate(href: string, options: NavigateOptions = {}): Promise<void> {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) {
        window.location.href = url.href;
        return;
    }
    scrollPositions.set(currentKey(), window.scrollY);
    const key = ++historyKey;
    if (options.replace) window.history.replaceState({ __tyvo: key }, "", url.href);
    else window.history.pushState({ __tyvo: key }, "", url.href);

    const tree = loadTree(takePrefetched(url.href) ?? request(url.href), url.href, (finalUrl) => {
        window.history.replaceState({ __tyvo: key }, "", finalUrl);
    });
    render(tree, () => {
        if (options.scroll ?? true) window.scrollTo(0, url.hash ? (document.getElementById(url.hash.slice(1))?.offsetTop ?? 0) : 0);
    });
    await tree;
}

async function refresh(): Promise<void> {
    prefetched.clear();
    const tree = loadTree(request(window.location.href), window.location.href, () => {});
    render(tree, () => {});
    await tree;
}

window.addEventListener("popstate", () => {
    const key = currentKey();
    const tree = loadTree(request(window.location.href), window.location.href, () => {});
    render(tree, () => window.scrollTo(0, scrollPositions.get(key) ?? 0));
});

const runtime: TyvoBrowserRuntime = {
    navigate,
    refresh,
    prefetch(href) {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin || prefetched.has(url.href)) return;
        prefetched.set(url.href, { response: request(url.href), at: Date.now() });
    },
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    isPending: () => pending,
};
window.__tyvo = runtime;
window.history.replaceState({ ...(window.history.state ?? {}), __tyvo: 0 }, "");
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

/** redirect()/notFound() are control flow handled by Tyvo's boundaries, not errors worth logging. */
function isNavigation(error: unknown): boolean {
    for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
        const digest = (current as { digest?: unknown }).digest;
        if (typeof digest === "string" && digest.startsWith("TYVO_")) return true;
    }
    return false;
}
const report = (error: unknown) => {
    if (!isNavigation(error)) console.error(error);
};

hydrateRoot(document, createElement(Root, { initial: createFromReadableStream(inlineFlightStream(), { callServer }) }), {
    onCaughtError: report,
    onRecoverableError: report,
});

// ---- Development: live updates ----------------------------------------------------------------------

if (window.__TYVO_DEV) {
    // The dev server restarts on every change; on reconnect it reports the new build. Server-only changes
    // re-render in place (client state is kept); client components and CSS need a full reload.
    const events = new EventSource(DEV_PATH);
    events.onmessage = (event) => {
        const { build, update } = JSON.parse(event.data) as { build: string; update: "refresh" | "reload" };
        if (build === window.__TYVO_BUILD) return;
        if (update === "reload") window.location.reload();
        else {
            window.__TYVO_BUILD = build;
            void refresh();
        }
    };
}
