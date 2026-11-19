import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Handler } from "../server/handler.js";
import { writeStatic } from "../server/static.js";
import { APP_BUNDLE, PRERENDER_DIR } from "./project.js";

/**
 * Renders every page with `export const prerender = true` into `<outDir>/prerender/`, through the built app
 * (config.ts is loaded, as at runtime). Returns the generated paths with their page's index in the build.
 */
export async function prerender(outDir: string): Promise<{ index: number; path: string }[]> {
    const app = (await import(pathToFileURL(join(outDir, APP_BUNDLE)).href + `?t=${Date.now()}`)) as { createApp(overrides?: object): Handler };
    const build = await app.createApp().prerender();
    if (build.pages.length) writeStatic(join(outDir, PRERENDER_DIR), build);
    return build.pages.map(({ index, path }) => ({ index, path }));
}
