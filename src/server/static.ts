import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Params } from "../types.js";

// Prerendered pages: rendered by `tyvo build` (pages with `export const prerender = true`) into `.tyvo/prerender/`,
// served from memory and regenerated in the background (`revalidate`, `revalidatePath()`, `revalidateTag()`).

const MANIFEST = "manifest.json";

/** One rendering of a page: the HTML document or the server component payload for client-side navigation. */
export interface StaticVariant {
    status: number;
    /** Header values may contain the build's nonce placeholder (CSP). */
    headers: [string, string][];
    /** HTML as text (with the nonce placeholder on its scripts), the payload as bytes. */
    body: string | Uint8Array;
}

export interface StaticPage {
    /** URL path, e.g. `/posts/1`. */
    path: string;
    /** Index of the page in the build. */
    index: number;
    params: Params;
    revalidate: number | false;
    /** Tags of the `cache()` data read while rendering; `revalidateTag()` regenerates the page. */
    tags: string[];
    /** Milliseconds since the epoch. */
    generatedAt: number;
    html: StaticVariant;
    flight: StaticVariant;
}

export interface StaticBuild {
    /**
     * Stands in for the CSP nonce in prerendered HTML and headers; every response replaces it with a fresh nonce,
     * so a prerendered page keeps a per-response nonce.
     */
    placeholder: string;
    pages: StaticPage[];
}

interface StoredVariant {
    status: number;
    headers: [string, string][];
    file: string;
}

interface StoredPage extends Omit<StaticPage, "html" | "flight"> {
    html: StoredVariant;
    flight: StoredVariant;
}

/** Writes the prerendered pages into `dir` (which the build has emptied). */
export function writeStatic(dir: string, build: StaticBuild): void {
    mkdirSync(dir, { recursive: true });
    const store = (variant: StaticVariant, file: string): StoredVariant => {
        writeFileSync(join(dir, file), variant.body);
        return { status: variant.status, headers: variant.headers, file };
    };
    const pages: StoredPage[] = build.pages.map(({ html, flight, ...page }, i) => ({ ...page, html: store(html, `${i}.html`), flight: store(flight, `${i}.rsc`) }));
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ placeholder: build.placeholder, pages }, null, 2));
}

/** The prerendered pages in `dir`, or undefined when the build has none. */
export function readStatic(dir: string): StaticBuild | undefined {
    const manifest = join(dir, MANIFEST);
    if (!existsSync(manifest)) return undefined;
    const stored = JSON.parse(readFileSync(manifest, "utf8")) as { placeholder: string; pages: StoredPage[] };
    const load = (variant: StoredVariant, text: boolean): StaticVariant => ({
        status: variant.status,
        headers: variant.headers,
        body: text ? readFileSync(join(dir, variant.file), "utf8") : new Uint8Array(readFileSync(join(dir, variant.file))),
    });
    return {
        placeholder: stored.placeholder,
        pages: stored.pages.map((page) => ({ ...page, html: load(page.html, true), flight: load(page.flight, false) })),
    };
}

/** Statuses a prerendered page may have: rendered, not found, or a redirect. */
export function isStaticStatus(status: number): boolean {
    return status === 200 || status === 404 || (status >= 301 && status <= 308 && status !== 304 && status !== 305 && status !== 306);
}
