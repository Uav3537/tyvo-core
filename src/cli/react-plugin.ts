import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as esbuild from "esbuild";
import { toPosix } from "./project.js";

type Mode = "rsc" | "ssr" | "browser";

export interface ReactPluginOptions {
    root: string;
    mode: Mode;
    /** rsc: filled with every "use client" module (absolute path -> client module id). */
    clients?: Map<string, string>;
    /** rsc: files that must stay server components (pages, layouts). */
    serverOnly?: Set<string>;
}

/** React itself is always resolved from the project, so a linked or nested copy never duplicates it. */
const REACT_PACKAGES = /^(react|react-dom|react-server-dom-turbopack|scheduler)(\/|$)/;
/** Shared with the route bundle at runtime: same config, same rate-limit storage. */
const ALWAYS_EXTERNAL = new Set(["@tyvo/core", "@tyvo/core/server"]);
const CLIENT_NAMESPACE = "tyvo-client-reference";
/** rsc: a "use server" module wrapped so each export is registered as a server reference. */
const SERVER_MODULE_NAMESPACE = "tyvo-server-module";
/** ssr/browser: a "use server" module replaced by functions that call the server. */
const SERVER_REFERENCE_NAMESPACE = "tyvo-server-reference";
const ORIGINAL = "?tyvo-original";
const SKIP = { tyvoSkip: true };
const SCRIPT = /\.(m|c)?(j|t)sx?$/;
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use client\1/;
const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use server\1/;

/** Stable, non-guessable id of a "use server" module; actions are addressed as `<id>#<export>`. */
export function actionModuleId(root: string, path: string): string {
    return createHash("sha256").update(clientModuleId(root, path)).digest("hex").slice(0, 16);
}

export function clientModuleId(root: string, path: string): string {
    return toPosix(relative(root, path));
}

/**
 * - rsc: "use client" modules are replaced by client references; packages that use React are bundled
 *   (so they get the react-server build), everything else stays external.
 * - ssr: packages that use React are bundled, everything else stays external.
 * - browser: everything is bundled.
 */
export function reactPlugin({ root, mode, clients, serverOnly }: ReactPluginOptions): esbuild.Plugin {
    const directiveCache = new Map<string, "client" | "server" | undefined>();
    const directiveOf = (path: string) => {
        if (!directiveCache.has(path)) {
            const source = SCRIPT.test(path) ? readFileSync(path, "utf8") : "";
            directiveCache.set(path, USE_CLIENT.test(source) ? "client" : USE_SERVER.test(source) ? "server" : undefined);
        }
        return directiveCache.get(path);
    };
    const isClientModule = (path: string) => directiveOf(path) === "client";
    const usesReact = createReactDependencyCheck();
    const realRoot = realpathSync(root);
    const isLocal = (path: string) => {
        const rel = relative(realRoot, safeRealpath(path));
        return !rel.startsWith("..") && !rel.split(/[\\/]/).includes("node_modules");
    };

    return {
        name: `tyvo-react-${mode}`,
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData?.tyvoSkip) return undefined;
                // The real module behind a server-module wrapper (rsc).
                if (args.path.endsWith(ORIGINAL)) return { path: args.path.slice(0, -ORIGINAL.length), suffix: ORIGINAL };
                const isBare = !/^[./]/.test(args.path) && !/^[a-zA-Z]:[\\/]/.test(args.path);
                const fromRoot = isBare && REACT_PACKAGES.test(args.path);

                const result = await build.resolve(args.path, {
                    kind: args.kind,
                    importer: args.importer,
                    resolveDir: fromRoot ? root : args.resolveDir,
                    pluginData: SKIP,
                });
                if (result.errors.length || result.external || !result.path || result.namespace !== "file") return result;

                if (mode === "rsc" && args.kind !== "entry-point" && isClientModule(result.path)) {
                    if (serverOnly?.has(result.path)) {
                        return { errors: [{ text: `${clientModuleId(root, result.path)} is a page or layout and cannot be a client component ("use client"). Move the interactive part into its own component.` }] };
                    }
                    clients!.set(result.path, clientModuleId(root, result.path));
                    return { path: result.path, namespace: CLIENT_NAMESPACE };
                }

                if (args.kind !== "entry-point" && directiveOf(result.path) === "server") {
                    return { path: result.path, namespace: mode === "rsc" ? SERVER_MODULE_NAMESPACE : SERVER_REFERENCE_NAMESPACE };
                }

                if (mode === "browser" || !isBare || isLocal(result.path)) return { path: result.path };
                if (ALWAYS_EXTERNAL.has(args.path)) return { path: args.path, external: true };
                if (fromRoot || args.path.startsWith("@tyvo/core/react-") || usesReact(result.path)) return { path: result.path };
                return { path: args.path, external: true };
            });

            const tsconfig = build.initialOptions.tsconfig;

            // ssr/browser: calling an exported action sends it to the server (window.__tyvo_callServer).
            build.onLoad({ filter: /.*/, namespace: SERVER_REFERENCE_NAMESPACE }, async (args) => {
                const id = actionModuleId(root, args.path);
                const client = mode === "browser" ? "client.browser" : "client.edge";
                const lines = [
                    `import { createServerReference } from "react-server-dom-turbopack/${client}";`,
                    `const call = (id, args) => { const callServer = globalThis.__tyvo_callServer; if (!callServer) throw new Error("[tyvo] server actions can only be called from the browser."); return callServer(id, args); };`,
                ];
                for (const name of await exportNames(root, args.path, tsconfig)) {
                    const reference = `createServerReference(${JSON.stringify(`${id}#${name}`)}, call)`;
                    lines.push(name === "default" ? `export default ${reference};` : `export const ${name} = ${reference};`);
                }
                return { contents: lines.join("\n"), loader: "js", resolveDir: root };
            });

            if (mode !== "rsc") return;

            // rsc: the real module, with every exported function registered as a server reference.
            build.onLoad({ filter: /.*/, namespace: SERVER_MODULE_NAMESPACE }, async (args) => {
                const id = actionModuleId(root, args.path);
                const names = await exportNames(root, args.path, tsconfig);
                const original = JSON.stringify(toPosix(args.path) + ORIGINAL);
                const lines = [
                    `import * as actions from ${original};`,
                    `import { registerServerReference } from "react-server-dom-turbopack/server.edge";`,
                    `for (const name of ${JSON.stringify(names)}) if (typeof actions[name] === "function") registerServerReference(actions[name], ${JSON.stringify(id)}, name);`,
                    `export * from ${original};`,
                ];
                if (names.includes("default")) lines.push(`export { default } from ${original};`);
                return { contents: lines.join("\n"), loader: "js", resolveDir: root };
            });

            build.onLoad({ filter: /.*/, namespace: CLIENT_NAMESPACE }, async (args) => {
                const id = clients!.get(args.path)!;
                const names = await exportNames(root, args.path, tsconfig);
                const lines = [`import { registerClientReference } from "react-server-dom-turbopack/server.edge";`];
                for (const name of names) {
                    const reference = `registerClientReference(function () { throw new Error(${JSON.stringify(
                        `Attempted to call ${name}() from the server, but it is a client component export of ${id}.`,
                    )}); }, ${JSON.stringify(id)}, ${JSON.stringify(name)})`;
                    lines.push(name === "default" ? `export default ${reference};` : `export const ${name} = ${reference};`);
                }
                return { contents: lines.join("\n"), loader: "js", resolveDir: root };
            });
        },
    };
}

/** Export names of a module, including `export *` from local files. */
async function exportNames(root: string, path: string, tsconfig: string | undefined): Promise<string[]> {
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: [path],
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform: "neutral",
        packages: "external",
        jsx: "automatic",
        tsconfig,
        logLevel: "silent",
        // Only the export names matter here: stylesheets and assets are irrelevant.
        loader: Object.fromEntries([".css", ".module.css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav"].map((ext) => [ext, "empty" as const])),
    });
    const output = Object.values(result.metafile.outputs)[0];
    return output?.exports ?? [];
}

function createReactDependencyCheck(): (path: string) => boolean {
    const cache = new Map<string, boolean>();
    return (path) => {
        const pkg = findPackageJson(dirname(path));
        if (!pkg) return false;
        let result = cache.get(pkg);
        if (result === undefined) {
            const json = JSON.parse(readFileSync(pkg, "utf8"));
            result = ["dependencies", "peerDependencies"].some((field) => json[field] && "react" in json[field]);
            cache.set(pkg, result);
        }
        return result;
    };
}

function findPackageJson(dir: string): string | undefined {
    for (;;) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
            const json = JSON.parse(readFileSync(candidate, "utf8"));
            if (json.name) return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

function safeRealpath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}
