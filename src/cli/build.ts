import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import * as esbuild from "esbuild";
import { STATIC_PREFIX, type ReactManifest } from "../react/manifest.js";
import {
    APP_BUNDLE,
    OUT_DIR,
    PRERENDER_DIR,
    REACT_MANIFEST,
    RSC_BUNDLE,
    SERVER_BUNDLE,
    SSR_BUNDLE,
    STATIC_DIR,
    scanProject,
    toPosix,
    type Project,
    type Segment,
} from "./project.js";
import { actionModuleId, reactPlugin } from "./react-plugin.js";
import { TYPES_DIR, writeTypes } from "./typegen.js";

export interface BuildOptions {
    root: string;
    minify?: boolean;
    dev?: boolean;
    /** Output directory, absolute or relative to `root`. Default: `.tyvo`. */
    outDir?: string;
}

export interface BuildResult extends Project {
    /** Client component files (project-relative); the dev server reloads the page when one of them changes. */
    clientModules: string[];
}

/** Images, fonts and media imported from code become hashed files under /_tyvo/static/ (the import is the URL). */
const ASSETS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav"];
const assetLoaders = Object.fromEntries(ASSETS.map((ext) => [ext, "file" as const]));

/**
 * - `.tyvo/app.mjs`: routes + `config.ts` (dependencies external), exported as handler options.
 * - `.tyvo/server.mjs`: starts the server with them.
 * - with pages: `.tyvo/rsc.mjs` (react-server), `.tyvo/static/*` (browser JS, CSS, assets), `.tyvo/ssr.mjs` (HTML),
 *   `.tyvo/react-manifest.json`. `tyvo build` then prerenders into `.tyvo/prerender/` (see prerender.ts).
 */
export async function build({ root, minify = false, dev = false, outDir: out = OUT_DIR }: BuildOptions): Promise<BuildResult> {
    const project = scanProject(root);
    // The folder types ("./$types") are code the bundles import, so they must match the files being built.
    writeTypes(root);
    const outDir = isAbsolute(out) ? out : join(root, out);
    const staticDir = join(outDir, STATIC_DIR);
    mkdirSync(outDir, { recursive: true });
    rmSync(staticDir, { recursive: true, force: true });
    // Pages prerendered by an earlier production build must not be served by this one.
    rmSync(join(outDir, PRERENDER_DIR), { recursive: true, force: true });

    const tsconfigPath = join(root, "tsconfig.json");
    const shared: esbuild.BuildOptions = {
        absWorkingDir: root,
        bundle: true,
        sourcemap: true,
        minify,
        // TypeScript first; .js is needed for packages in node_modules (project .js files are rejected by scanProject).
        resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
        jsx: "automatic",
        tsconfig: existsSync(tsconfigPath) ? tsconfigPath : undefined,
        define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
        loader: assetLoaders,
        logLevel: "silent",
        plugins: [folderTypesPlugin(root)],
    };
    // Node bundles live in .tyvo/; their assets go to .tyvo/static/ with the same names the browser build produces.
    const node: esbuild.BuildOptions = { ...shared, platform: "node", format: "esm", target: "node18", assetNames: `${STATIC_DIR}/[name]-[hash]`, publicPath: "/_tyvo/" };

    // Busts Node's module cache when a process loads several builds (tests in watch mode).
    const version = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await esbuild.build({
        ...node,
        stdin: { contents: appEntry(project, outDir, version), resolveDir: root, sourcefile: "tyvo-app-entry.ts", loader: "ts" },
        outfile: join(outDir, APP_BUNDLE),
        packages: "external",
    });
    rmSync(join(outDir, SERVER_BUNDLE + ".map"), { force: true });
    writeFileSync(join(outDir, SERVER_BUNDLE), serverEntry(dev));

    const clientModules = usesReact(project) ? await buildReact(project, shared, node, outDir, staticDir) : [];
    for (const bundle of [APP_BUNDLE, RSC_BUNDLE, SSR_BUNDLE]) relativeSourceMap(join(outDir, bundle));
    return { ...project, clientModules };
}

/**
 * `import ... from "./$types"` in src/app/<folder>/ is the generated .tyvo/types/src/app/<folder>/$types.ts — what
 * tsconfig's `rootDirs` tells TypeScript, done for the bundler.
 */
function folderTypesPlugin(root: string): esbuild.Plugin {
    return {
        name: "tyvo-folder-types",
        setup(build) {
            build.onResolve({ filter: /^\.\/\$types(\.ts|\.js)?$/ }, (args) => {
                const folder = relative(root, args.resolveDir);
                if (folder.startsWith("..") || isAbsolute(folder)) return undefined;
                const file = join(root, TYPES_DIR, folder, "$types.ts");
                if (existsSync(file)) return { path: file };
                return { errors: [{ text: `${toPosix(folder)}/$types is not generated (only folders with a route.ts, page.tsx or layout.tsx have one). Run "tyvo typegen".` }] };
            });
        },
    };
}

/**
 * esbuild prefixes `publicPath` (/_tyvo/, for asset URLs) to the sourceMappingURL comment too, which Node cannot
 * resolve: point it at the map next to the bundle so `--enable-source-maps` shows stack traces in src/.
 */
function relativeSourceMap(file: string): void {
    if (!existsSync(file)) return;
    const code = readFileSync(file, "utf8");
    const fixed = code.replace(/\/\/# sourceMappingURL=\S+\s*$/, `//# sourceMappingURL=${file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1)}.map\n`);
    if (fixed !== code) writeFileSync(file, fixed);
}

async function buildReact(project: Project, shared: esbuild.BuildOptions, node: esbuild.BuildOptions, outDir: string, staticDir: string): Promise<string[]> {
    const { root } = project;
    const urlOf = (path: string) => STATIC_PREFIX + toPosix(relative(staticDir, path));

    // 1. Server components. "use client" modules become client references and are collected;
    //    "use server" modules are registered as server actions; CSS they import goes to rsc.css.
    const clients = new Map<string, string>();
    const serverOnly = new Set(project.pages.flatMap((page) => [page.file, ...page.segments.map((segment) => segment.layout)]).filter(Boolean).map((file) => join(root, file!)));
    await esbuild.build({
        ...node,
        stdin: { contents: rscEntry(project), resolveDir: root, sourcefile: "tyvo-rsc-entry.ts", loader: "ts" },
        outfile: join(outDir, RSC_BUNDLE),
        conditions: ["react-server"],
        plugins: [folderTypesPlugin(root), reactPlugin({ root, mode: "rsc", clients, serverOnly })],
    });

    const css: string[] = [];
    const serverCss = join(outDir, RSC_BUNDLE.replace(/\.mjs$/, ".css"));
    if (existsSync(serverCss)) {
        const hash = createHash("sha256").update(readFileSync(serverCss)).digest("hex").slice(0, 8).toUpperCase();
        const target = join(staticDir, `server-${hash}.css`);
        mkdirSync(staticDir, { recursive: true });
        renameSync(serverCss, target);
        rmSync(serverCss + ".map", { force: true });
        css.push(urlOf(target));
    }

    // 2. Browser: runtime + one entry per client component, sharing chunks.
    const clientPaths = [...clients.keys()];
    const browser = await esbuild.build({
        ...shared,
        entryPoints: ["@tyvo/core/react-browser", ...clientPaths],
        outdir: staticDir,
        platform: "browser",
        format: "esm",
        target: "es2022",
        splitting: true,
        entryNames: "[name]-[hash]",
        chunkNames: "chunk-[hash]",
        assetNames: "[name]-[hash]",
        publicPath: STATIC_PREFIX,
        metafile: true,
        plugins: [folderTypesPlugin(root), reactPlugin({ root, mode: "browser" })],
    });

    const build = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const manifest: ReactManifest = { build, runtime: "", clients: {}, css };
    const byEntry = new Map<string, string>();
    for (const [output, meta] of Object.entries(browser.metafile!.outputs)) {
        if (output.endsWith(".css")) css.push(urlOf(join(root, output)));
        if (meta.entryPoint) byEntry.set(meta.entryPoint, output);
        if (meta.entryPoint && /react-browser\.js$/.test(meta.entryPoint)) manifest.runtime = urlOf(join(root, output));
    }
    for (const path of clientPaths) {
        const output = byEntry.get(toPosix(relative(root, path)));
        if (!output) throw new Error(`[tyvo] no browser output for client module ${path}`);
        manifest.clients[clients.get(path)!] = urlOf(join(root, output));
    }
    if (!manifest.runtime) throw new Error("[tyvo] browser runtime was not emitted.");
    writeFileSync(join(outDir, REACT_MANIFEST), JSON.stringify(manifest, null, 2));

    // 3. SSR: every client component, rendered to HTML from the Flight payload. Its CSS duplicates the browser's.
    await esbuild.build({
        ...node,
        stdin: { contents: ssrEntry(clients), resolveDir: root, sourcefile: "tyvo-ssr-entry.ts", loader: "ts" },
        outfile: join(outDir, SSR_BUNDLE),
        plugins: [folderTypesPlugin(root), reactPlugin({ root, mode: "ssr" })],
    });
    const ssrCss = join(outDir, SSR_BUNDLE.replace(/\.mjs$/, ".css"));
    rmSync(ssrCss, { force: true });
    rmSync(ssrCss + ".map", { force: true });

    return [...clients.values()];
}

/** Pages, or a root not-found.tsx for unknown URLs, need the React bundles. */
function usesReact(project: Project): boolean {
    return project.pages.length > 0 || !!project.root_segment.notFound;
}

/** `.tyvo/app.mjs`: `options` for createHandler()/startServer() and `createApp(overrides)`. */
function appEntry(project: Project, outDir: string, version: string): string {
    const lines = [`import { createHandler } from "@tyvo/core/server";`, `import { readFile } from "node:fs/promises";`, `import { fileURLToPath } from "node:url";`];
    lines.push(`import * as config from ${JSON.stringify("./" + project.config)};`);
    const proxies = new Map<string, string>();
    const proxyModule = (file: string) => {
        if (!proxies.has(file)) {
            proxies.set(file, `proxy${proxies.size}`);
            lines.push(`import * as ${proxies.get(file)} from ${JSON.stringify("./" + file)};`);
        }
        return `{ file: ${JSON.stringify(file)}, module: ${proxies.get(file)} }`;
    };
    const routes = project.routes.map((file, index) => {
        lines.push(`import * as route${index} from ${JSON.stringify("./" + file)};`);
        const chain = (project.routeProxies[file] ?? []).map(proxyModule);
        return `{ file: ${JSON.stringify(file)}, module: route${index}, proxies: [${chain.join(", ")}] }`;
    });
    // Loaded at runtime (not bundled): they were built with different conditions.
    const react = usesReact(project)
        ? `async () => {
    const [rsc, ssr, manifest] = await Promise.all([
        import(at("./${RSC_BUNDLE}?v=${version}").href),
        import(at("./${SSR_BUNDLE}?v=${version}").href),
        readFile(at("./${REACT_MANIFEST}"), "utf8"),
    ]);
    return { rsc: rsc.default, ssr: ssr.default, manifest: JSON.parse(manifest), staticDir: fileURLToPath(at("./${STATIC_DIR}")) };
}`
        : "undefined";
    lines.push(`const at = (file) => new URL(file, import.meta.url);`);
    const publicDir = project.publicDir ? `fileURLToPath(at(${JSON.stringify(toPosix(relative(outDir, project.publicDir)) + "/")}))` : "undefined";
    lines.push(
        `export const options = { config, routes: [${routes.join(", ")}], pages: ${JSON.stringify(project.pages.map((p) => p.file))}, react: ${react}, publicDir: ${publicDir}, prerenderDir: fileURLToPath(at("./${PRERENDER_DIR}/")) };`,
        `export function createApp(overrides = {}) { return createHandler({ ...options, ...overrides }); }`,
    );
    return lines.join("\n");
}

function serverEntry(dev: boolean): string {
    return [
        `import { startServer } from "@tyvo/core/server";`,
        `import { options } from "./${APP_BUNDLE}";`,
        `startServer({ ...options, dev: ${dev}, devUpdate: process.env.TYVO_DEV_UPDATE });`,
        "",
    ].join("\n");
}

function rscEntry(project: Project): string {
    const lines = [`import { createRSC } from "@tyvo/core/react-rsc";`];
    const modules = new Map<string, string>();
    const name = (file: string) => {
        if (!modules.has(file)) {
            const id = `m${modules.size}`;
            modules.set(file, id);
            lines.push(`import * as ${id} from ${JSON.stringify("./" + file)};`);
        }
        return modules.get(file)!;
    };
    const segment = (s: Segment) =>
        `{ ${(["layout", "loading", "error", "notFound"] as const)
            .filter((key) => s[key])
            .map((key) => `${key}: ${name(s[key]!)}`)
            .join(", ")} }`;
    const pages = project.pages.map((page) => `{ file: ${JSON.stringify(page.file)}, page: ${name(page.file)}, segments: [${page.segments.map(segment).join(", ")}] }`);
    // Every "use server" module, so actions only imported by client components are registered too.
    const actions = project.serverActions.map((file) => `${JSON.stringify(actionModuleId(project.root, join(project.root, file)))}: ${name(file)}`);
    lines.push(`export default createRSC([${pages.join(", ")}], ${segment(project.root_segment)}, { ${actions.join(", ")} });`);
    return lines.join("\n");
}

function ssrEntry(clients: Map<string, string>): string {
    const lines = [`import { createSSR } from "@tyvo/core/react-ssr";`];
    const entries = [...clients].map(([path, id], index) => {
        lines.push(`import * as c${index} from ${JSON.stringify(toPosix(path))};`);
        return `${JSON.stringify(id)}: c${index}`;
    });
    lines.push(`export default createSSR({ ${entries.join(", ")} });`);
    return lines.join("\n");
}

export function formatBuildError(error: unknown): string {
    if (error && typeof error === "object" && "errors" in error && Array.isArray((error as esbuild.BuildFailure).errors)) {
        return esbuild
            .formatMessagesSync((error as esbuild.BuildFailure).errors, { kind: "error", color: process.stdout.isTTY })
            .join("\n");
    }
    return error instanceof Error ? error.message : String(error);
}
