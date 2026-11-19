import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
    APP_DIR,
    CONFIG_BASENAME,
    FORBIDDEN_EXTENSIONS,
    PUBLIC_DIR,
    SOURCE_EXTENSIONS,
    appFileOf,
    hasForbiddenExtension,
    parseRouteDir,
    proxyChainOf,
    type AppFileKind,
} from "../shared/conventions.js";

export const OUT_DIR = ".tyvo";
export const SERVER_BUNDLE = "server.mjs";
/** Routes, pages and config.ts, exported without starting a server (used by server.mjs, prerendering and tests). */
export const APP_BUNDLE = "app.mjs";
export const PRERENDER_DIR = "prerender";
export const RSC_BUNDLE = "rsc.mjs";
export const SSR_BUNDLE = "ssr.mjs";
export const STATIC_DIR = "static";
export const REACT_MANIFEST = "react-manifest.json";
const IGNORED_DIRS = new Set(["node_modules", OUT_DIR, ".git", "dist", PUBLIC_DIR]);
const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use server\1/;

export class ProjectError extends Error {
    override name = "ProjectError";
}

/** Special files of one folder level, relative to the project root. */
export interface Segment {
    layout?: string;
    loading?: string;
    error?: string;
    notFound?: string;
    proxy?: string;
}

export interface Project {
    root: string;
    /** Route files relative to `root`, `/`-separated. */
    routes: string[];
    /** The proxy.ts files wrapping each route file, outer first (routes without proxies are left out). */
    routeProxies: Record<string, string[]>;
    /** Page files with the special files of every folder from `app/` down to theirs (root first). */
    pages: { file: string; segments: Segment[] }[];
    /** `app/` itself: its layout and not-found.tsx render 404s for URLs that match nothing. */
    root_segment: Segment;
    /** Modules starting with "use server" (server actions), relative to `root`. */
    serverActions: string[];
    /** `public/`, if it exists. */
    publicDir: string | undefined;
    /** `config.ts` relative to `root`. Required. */
    config: string;
}

const SEGMENT_KEYS: Partial<Record<AppFileKind, keyof Segment>> = { layout: "layout", loading: "loading", error: "error", "not-found": "notFound", proxy: "proxy" };

/** Scans the project and enforces the TypeScript-only rule. */
export function scanProject(root: string): Project {
    const appDir = join(root, APP_DIR);
    if (!existsSync(appDir)) throw new ProjectError(`No "${APP_DIR}" directory found in ${root}. Run "tyvo init" to scaffold a project.`);

    const forbidden: string[] = [];
    const routes: string[] = [];
    const pageFiles: string[] = [];
    const segments = new Map<string, Segment>();

    for (const file of walk(appDir)) {
        const rel = toPosix(relative(root, file));
        const base = rel.slice(rel.lastIndexOf("/") + 1);
        if (hasForbiddenExtension(base)) {
            forbidden.push(rel);
            continue;
        }
        const appFile = appFileOf(rel);
        if (!appFile) continue;
        if (appFile.kind === "route") routes.push(rel);
        else if (appFile.kind === "page") pageFiles.push(rel);
        else {
            const key = SEGMENT_KEYS[appFile.kind]!;
            const segment = segments.get(appFile.dir) ?? {};
            if (segment[key]) throw new ProjectError(`Both ${appFile.kind}.ts and ${appFile.kind}.tsx exist in ${APP_DIR}/${appFile.dir}`);
            segment[key] = rel;
            segments.set(appFile.dir, segment);
        }
    }

    for (const ext of FORBIDDEN_EXTENSIONS) {
        if (existsSync(join(root, CONFIG_BASENAME + ext))) forbidden.push(CONFIG_BASENAME + ext);
    }
    if (forbidden.length) {
        throw new ProjectError(
            `Tyvo only supports TypeScript (${SOURCE_EXTENSIONS.join(", ")}). Rename or remove:\n${forbidden.map((f) => `  - ${f}`).join("\n")}`,
        );
    }

    const endpoints = [...routes, ...pageFiles];
    const duplicates = endpoints.filter((file, i) => endpoints.findIndex((other) => dirOf(other) === dirOf(file)) !== i);
    if (duplicates.length) {
        throw new ProjectError(`Only one of route.ts / page.tsx may exist per directory. Conflicts in: ${duplicates.map(dirOf).join(", ")}`);
    }

    for (const file of endpoints) {
        try {
            parseRouteDir(appFileOf(file)!.dir);
        } catch (error) {
            throw new ProjectError(`${file}: ${(error as Error).message}`);
        }
    }

    const config = SOURCE_EXTENSIONS.map((ext) => CONFIG_BASENAME + ext).find((name) => existsSync(join(root, name)));
    if (!config) {
        throw new ProjectError(`config.ts is required: Tyvo has no hidden defaults. Run "tyvo init" (or copy its config.ts) to get one with every default spelled out.`);
    }
    if ((pageFiles.length || segments.get("")?.notFound) && !segments.get("")?.layout) {
        throw new ProjectError(`Pages need a root layout: create ${APP_DIR}/layout.tsx rendering <html> and <body> around {children}.`);
    }

    const pages = pageFiles.sort().map((file) => {
        const parts = appFileOf(file)!.dir.split("/").filter(Boolean);
        const chain: Segment[] = [];
        for (let i = 0; i <= parts.length; i++) chain.push(segments.get(parts.slice(0, i).join("/")) ?? {});
        return { file, segments: chain };
    });

    const serverActions = [...walk(root)]
        .filter((file) => SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)) && !file.endsWith(".d.ts"))
        .filter((file) => USE_SERVER.test(readFileSync(file, "utf8")))
        .map((file) => toPosix(relative(root, file)))
        .sort();

    const publicPath = join(root, PUBLIC_DIR);
    const publicDir = existsSync(publicPath) && statSync(publicPath).isDirectory() ? publicPath : undefined;

    const proxyFiles = [...segments.values()].flatMap((segment) => (segment.proxy ? [segment.proxy] : []));
    const routeProxies: Record<string, string[]> = {};
    for (const file of routes) {
        const chain = proxyChainOf(file, proxyFiles);
        if (chain.length) routeProxies[file] = chain;
    }

    return { root, routes: routes.sort(), routeProxies, pages, root_segment: segments.get("") ?? {}, serverActions, publicDir, config };
}

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) yield* walk(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

function dirOf(file: string): string {
    return file.slice(0, file.lastIndexOf("/"));
}

export function toPosix(path: string): string {
    return path.split(sep).join("/");
}
