// Bundled into `.tyvo/ssr.mjs` (default conditions) together with every client component.
import { createElement, use, type ReactElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
// @ts-expect-error no type declarations are published for react-server-dom-turbopack
import { createFromReadableStream } from "react-server-dom-turbopack/client.edge";
import { emit } from "../log.js";
import type { ReactManifest } from "./manifest.js";

type Module = Record<string, unknown>;

export interface SsrOptions {
    /** Goes on every script in the document (React's and the inline payload) to satisfy the page's CSP. */
    nonce?: string;
    /** Enables the development live-update client. */
    dev: boolean;
    /** `prefetch.ttl` from config.ts, for the browser runtime. */
    prefetchTtl: number;
}

export interface Ssr {
    /**
     * Rejects when the shell (everything outside a Suspense/loading boundary) throws — including redirect()/notFound(),
     * which the server then turns into an HTTP redirect or the not-found page.
     */
    render(flight: ReadableStream<Uint8Array>, manifest: ReactManifest, options: SsrOptions): Promise<ReadableStream<Uint8Array>>;
}

/** Server actions cannot run while rendering HTML; they are only callable from the browser. */
function callServer(): never {
    throw new Error("[tyvo] server actions can only be called from the browser, not during server rendering.");
}

/** `modules` maps client module ids (project-relative paths) to the modules bundled for SSR. */
export function createSSR(modules: Record<string, Module>): Ssr {
    const globals = globalThis as Record<string, unknown>;
    // One loader for the whole process: client modules (SSR) and server action modules (registered by the RSC bundle).
    globals.__turbopack_require__ = (id: string) => {
        const module = modules[id] ?? (globals.__tyvo_action_modules as Record<string, Module> | undefined)?.[id];
        if (!module) throw new Error(`[tyvo] module "${id}" is missing from the SSR bundle.`);
        return module;
    };
    globals.__turbopack_load_by_url__ = () => Promise.resolve();

    const moduleMaps = new WeakMap<ReactManifest, Record<string, Record<string, { id: string; chunks: string[]; name: string }>>>();
    const moduleMapFor = (manifest: ReactManifest) => {
        let map = moduleMaps.get(manifest);
        if (!map) {
            map = {};
            for (const [id, url] of Object.entries(manifest.clients)) map[url] = { "*": { id, chunks: [], name: "*" } };
            moduleMaps.set(manifest, map);
        }
        return map;
    };

    return {
        async render(flight, manifest, { nonce, dev, prefetchTtl }) {
            const [forHtml, forInline] = flight.tee();
            const tree: Promise<ReactNode> = createFromReadableStream(forHtml, {
                serverConsumerManifest: { moduleMap: moduleMapFor(manifest), moduleLoading: null, serverModuleMap: null },
                callServer,
            });
            const Root = () => use(tree) as ReactElement;
            const html: ReadableStream<Uint8Array> = await renderToReadableStream(createElement(Root), {
                bootstrapModules: [manifest.runtime],
                bootstrapScriptContent: `self.__TYVO_BUILD=${JSON.stringify(manifest.build)};self.__TYVO_DEV=${dev};self.__TYVO_PREFETCH_TTL=${JSON.stringify(prefetchTtl)}`,
                nonce,
                onError(error: unknown) {
                    // redirect()/notFound() keep their digest for the client; they are not failures.
                    const digest = (error as { digest?: unknown } | null)?.digest;
                    if (typeof digest === "string" && digest.startsWith("TYVO_")) return digest;
                    emit({ type: "message", level: "error", message: "Error while rendering HTML (SSR)", error });
                    return undefined;
                },
            });
            return html.pipeThrough(inlineFlight(forInline, nonce));
        },
    };
}

const BODY_END = "</body></html>";

/**
 * Interleaves the Flight payload into the HTML as `<script>` tags so the browser can hydrate
 * without a second request. Scripts are only emitted between complete HTML chunks.
 */
function inlineFlight(flight: ReadableStream<Uint8Array>, nonce: string | undefined): TransformStream<Uint8Array, Uint8Array> {
    const encoder = new TextEncoder();
    const htmlDecoder = new TextDecoder();
    let pendingScripts = "";
    let flightDone: Promise<void> | undefined;
    let started = false;
    let holdBack = "";

    const startFlight = (controller: TransformStreamDefaultController<Uint8Array>) => {
        const decoder = new TextDecoder();
        flightDone = (async () => {
            const reader = flight.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                pendingScripts += script(decoder.decode(value, { stream: true }), nonce);
            }
            const rest = decoder.decode();
            if (rest) pendingScripts += script(rest, nonce);
        })();
        void controller;
    };

    const flushScripts = (controller: TransformStreamDefaultController<Uint8Array>) => {
        if (!pendingScripts) return;
        controller.enqueue(encoder.encode(pendingScripts));
        pendingScripts = "";
    };

    return new TransformStream({
        transform(chunk, controller) {
            if (!started) {
                started = true;
                startFlight(controller);
            }
            // Keep `</body></html>` back so the remaining scripts can go before it.
            let text = holdBack + htmlDecoder.decode(chunk, { stream: true });
            holdBack = "";
            if (text.endsWith(BODY_END)) {
                holdBack = BODY_END;
                text = text.slice(0, -BODY_END.length);
            }
            controller.enqueue(encoder.encode(text));
            flushScripts(controller);
        },
        async flush(controller) {
            if (!started) startFlight(controller);
            await flightDone;
            flushScripts(controller);
            controller.enqueue(encoder.encode(holdBack + htmlDecoder.decode()));
        },
    });
}

/** Escapes `<` (no `</script>` breakout) and U+2028/U+2029 (line terminators inside a <script>). */
function escapeScript(json: string): string {
    let out = "";
    for (const char of json) {
        const code = char.charCodeAt(0);
        out += code === 0x3c || code === 0x2028 || code === 0x2029 ? "\\u" + code.toString(16).padStart(4, "0") : char;
    }
    return out;
}

function script(text: string, nonce: string | undefined): string {
    const attribute = nonce ? ` nonce="${nonce}"` : "";
    return `<script${attribute}>(self.__TYVO_FLIGHT||=[]).push(${escapeScript(JSON.stringify(text))})</script>`;
}
