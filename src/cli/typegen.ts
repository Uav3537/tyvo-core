// `.tyvo/types/`: everything the type system needs to know about the app, generated from the files in src/app/.
// - routes.d.ts: the routes and pages (typed paths for href(), <Link>, route({ path }), api(), useParams/useQuery) and
//   the proxies around them.
// - check.ts: every Tyvo rule as plain TypeScript, so `tsc`, `tyvo check`, `tyvo build` and the editor report broken
//   rules without any plugin. Module rules are type checks (src/checks.ts); file-system rules (which files may live in
//   src/app/, conflicts, "use client") are decided here and written as failing `"ok"` assignments.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    APP_DIR,
    CONFIG_BASENAME,
    ConventionError,
    HTTP_METHODS,
    SOURCE_EXTENSIONS,
    appFileOf,
    formatSegments,
    isAllowedAppFile,
    isPrivateDir,
    parseRouteDir,
    proxyChainOf,
    routePathOf,
    type AppFileKind,
    type Segment,
} from "../shared/conventions.js";

export const TYPES_DIR = ".tyvo/types";
const PUBLIC_DIR = "public";
export const TYPES_INCLUDE = `${TYPES_DIR}/**/*.ts`;
const IGNORED = new Set(["node_modules", ".tyvo", ".git", "dist"]);
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use client\1/;
const ALLOWED = "route.ts, proxy.ts, page.tsx, layout.tsx, loading.tsx, error.tsx, not-found.tsx and *.css";

/** The files to check: `app` is the path the conventions see (`src/app/...`), `file` the real one (imports, messages). */
export interface SourceTree {
    files: { app: string; file: string }[];
    read(file: string): string;
    /** The config file, project-relative, if there is one. */
    config: string | undefined;
    /** Files under public/, project-relative with forward slashes (`public/robots.txt`). */
    publicFiles?: string[];
}

export interface AppEntry {
    file: string;
    kind: AppFileKind;
    /** route.ts / page.tsx: the folder's path (`/users/[id]`). */
    path?: string;
    /** route.ts: the proxy.ts files wrapping it, outer first. */
    proxies?: string[];
}

export interface AppScan {
    entries: AppEntry[];
    /** Broken file-system rules, each naming the file. */
    issues: string[];
    config: string | undefined;
}

/** The project's own src/app/ and config.ts. */
export function projectTree(root: string): SourceTree {
    const files: SourceTree["files"] = [];
    const walk = (dir: string, rel: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!IGNORED.has(entry.name)) walk(join(dir, entry.name), `${rel}/${entry.name}`);
            } else if (entry.isFile()) {
                files.push({ app: `${rel}/${entry.name}`, file: `${rel}/${entry.name}` });
            }
        }
    };
    walk(join(root, APP_DIR), APP_DIR);
    const config = SOURCE_EXTENSIONS.map((ext) => CONFIG_BASENAME + ext).find((name) => existsSync(join(root, name)));

    const publicFiles: string[] = [];
    const walkPublic = (dir: string, rel: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walkPublic(join(dir, entry.name), `${rel}/${entry.name}`);
            else if (entry.isFile()) publicFiles.push(`${rel}/${entry.name}`);
        }
    };
    walkPublic(join(root, PUBLIC_DIR), PUBLIC_DIR);
    return { files, read: (file) => readFileSync(join(root, file), "utf8"), config, publicFiles };
}

/** Whether a route path's segments serve the URL segments `parts` (as the server's router matches them). */
function servesUrl(segments: Segment[], parts: string[]): boolean {
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!;
        if (segment.kind === "optionalCatchAll") return true;
        if (segment.kind === "catchAll") return parts.length > i;
        if (i >= parts.length) return false;
        if (segment.kind === "static" && segment.value !== parts[i]) return false;
    }
    return parts.length === segments.length;
}

/** Applies the file-system rules and lists the special files. */
export function scanApp(tree: SourceTree): AppScan {
    const entries: AppEntry[] = [];
    const issues: string[] = [];
    const byDir = new Map<string, Map<AppFileKind, string[]>>();
    const endpoints: { file: string; dir: string; segments: Segment[] }[] = [];

    for (const { app, file } of tree.files) {
        const rel = app.slice(APP_DIR.length + 1);
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        if (isPrivateDir(dir)) continue;
        const special = appFileOf(app);
        if (!special) {
            const base = rel.slice(rel.lastIndexOf("/") + 1);
            if (!isAllowedAppFile(base)) issues.push(`${file}: not allowed in ${APP_DIR}/. Only ${ALLOWED} live here; move it to src/ (or a _private folder).`);
            continue;
        }
        const kinds = byDir.get(dir) ?? new Map<AppFileKind, string[]>();
        byDir.set(dir, kinds.set(special.kind, [...(kinds.get(special.kind) ?? []), file]));

        const entry: AppEntry = { file, kind: special.kind };
        if (special.kind === "route" || special.kind === "page") {
            try {
                const segments = parseRouteDir(dir) ?? [];
                entry.path = routePathOf(segments);
                endpoints.push({ file, dir, segments });
            } catch (error) {
                if (!(error instanceof ConventionError)) throw error;
                issues.push(`${file}: ${error.message}`);
                continue;
            }
        }
        if (special.kind === "page" || special.kind === "layout" || special.kind === "error") {
            const client = USE_CLIENT.test(tree.read(file));
            if (client && special.kind !== "error") {
                issues.push(`${file}: ${special.kind}.tsx is a server component and cannot use "use client". Move the interactive part into its own component file.`);
            }
            if (!client && special.kind === "error") issues.push(`${file}: error.tsx must be a client component: add "use client" at the top (error boundaries run in the browser).`);
        }
        entries.push(entry);
    }

    for (const [dir, kinds] of byDir) {
        for (const [kind, files] of kinds) {
            // Every message starts with the file it is about ("<file>: ..."), so `tyvo check` can show it there.
            if (files.length > 1) issues.push(`${files[0]}: ${files.slice(1).join(" and ")} exists too; keep one ${kind} file in this folder.`);
        }
        const route = kinds.get("route")?.[0];
        const page = kinds.get("page")?.[0];
        if (route && page) issues.push(`${route}: ${page} is in the same folder; only one of route.ts / page.tsx may exist per folder (they would serve the same URL).`);
    }

    // Folders that differ only by groups or parameter names serve the same URLs.
    const shapes = new Map<string, string>();
    for (const endpoint of endpoints) {
        const shape = endpoint.segments.map((segment) => (segment.kind === "static" ? `s:${segment.value}` : segment.kind)).join("/");
        const other = shapes.get(shape);
        if (other && other.slice(0, other.lastIndexOf("/")) !== endpoint.file.slice(0, endpoint.file.lastIndexOf("/"))) {
            issues.push(`${endpoint.file}: ${other} serves the same URLs (${formatSegments(endpoint.segments)}); rename or remove one of them.`);
        } else shapes.set(shape, endpoint.file);
    }

    // Routes and pages are matched before public/: a file whose URL one of them serves is never sent.
    for (const file of tree.publicFiles ?? []) {
        const parts = file.slice(PUBLIC_DIR.length + 1).split("/");
        const owner = endpoints.find((endpoint) => servesUrl(endpoint.segments, parts));
        if (owner) {
            issues.push(
                `${file}: ${formatSegments(owner.segments)} serves /${parts.join("/")} (${owner.file}), and routes and pages are matched before public/, so this file is never sent. Rename or move one of them.`,
            );
        }
    }

    const hasPages = entries.some((entry) => entry.kind === "page" || entry.kind === "not-found");
    if (hasPages && !byDir.get("")?.has("layout")) {
        issues.push(`${APP_DIR}/layout.tsx is missing: pages need a root layout rendering <html> and <body> around {children}.`);
    }
    if (!tree.config) issues.push(`config.ts is missing. Tyvo has no hidden defaults: every project needs a config.ts (see the one "tyvo init" generates).`);

    // Proxies wrap the routes in their folder and below (by folder, like layouts).
    const proxies = entries.filter((entry) => entry.kind === "proxy");
    const appOf = new Map(tree.files.map(({ app, file }) => [file, app]));
    for (const entry of entries) {
        if (entry.kind !== "route") continue;
        const chain = proxyChainOf(appOf.get(entry.file)!, proxies.map((proxy) => appOf.get(proxy.file)!));
        entry.proxies = chain.map((app) => proxies.find((proxy) => appOf.get(proxy.file) === app)!.file);
    }
    return { entries: entries.sort((a, b) => a.file.localeCompare(b.file)), issues, config: tree.config };
}

/** The generated files. `toRoot` leads from the types folder back to the project root (`../..` for `.tyvo/types`). */
export function renderTypes(scan: AppScan, toRoot: string, corePackage = "@tyvo/core"): Record<string, string> {
    const header = `// Generated by Tyvo from ${APP_DIR}/ (tyvo dev, build, check, typegen). Do not edit.\n`;
    const moduleOf = (file: string) => JSON.stringify(`${toRoot}/${file.replace(/\.tsx?$/, "")}`);
    const literal = (text: string) => JSON.stringify(text);
    const endpoints = scan.entries.filter((entry): entry is AppEntry & { path: string } => entry.path !== undefined);
    const seen = new Set<string>();
    const unique = endpoints.filter((entry) => !seen.has(entry.path) && seen.add(entry.path));

    const routes = [
        header,
        "export {};",
        "",
        "declare global {",
        "    namespace Tyvo {",
        "        interface Routes {",
        ...unique.map((entry) => `            ${literal(entry.path)}: { kind: ${literal(entry.kind)} };`),
        "        }",
        "        interface RouteModules {",
        ...unique.filter((entry) => entry.kind === "route").map((entry) => `            ${literal(entry.path)}: typeof import(${moduleOf(entry.file)});`),
        "        }",
        "        interface PageModules {",
        ...unique.filter((entry) => entry.kind === "page").map((entry) => `            ${literal(entry.path)}: typeof import(${moduleOf(entry.file)});`),
        "        }",
        "        interface RouteProxies {",
        ...unique
            .filter((entry) => entry.proxies?.length)
            .map((entry) => `            ${literal(entry.path)}: [${entry.proxies!.map((proxy) => `typeof import(${moduleOf(proxy)})`).join(", ")}];`),
        "        }",
        "    }",
        "}",
        "",
    ].join("\n");

    const check = [
        header,
        '// Every Tyvo rule as TypeScript. Each line is "ok" or fails with a message naming the file and what to change.',
        `import type * as T from ${literal(corePackage)};`,
        "",
    ];
    if (scan.config) {
        check.push(
            `// ${scan.config}: every setting, with the right type (Tyvo has no hidden defaults).`,
            `declare const config: typeof import(${moduleOf(scan.config)});`,
            "export const configCheck: T.TyvoConfig = config;",
            "",
        );
    }
    // One line per rule, so every problem is reported at once (TypeScript stops at the first one of an assignment).
    const rule = (name: string, type: string) => `export const ${name}: "ok" = null as unknown as ${type};`;
    scan.entries.forEach((entry, index) => {
        const m = `typeof m${index}`;
        const file = literal(entry.file);
        check.push(`// ${entry.file}`, `declare const m${index}: typeof import(${moduleOf(entry.file)});`);
        if (entry.kind === "route") {
            for (const key of [...HTTP_METHODS, "default"]) check.push(rule(`c${index}_${key}`, `T.RouteExportCheck<${m}, ${literal(key)}, ${literal(entry.path!)}, ${file}>`));
            check.push(rule(`c${index}_exports`, `T.RouteUnknownExportsCheck<${m}, ${file}>`));
        } else if (entry.kind === "page") {
            for (const key of ["default", "metadata", "generateMetadata", "prerender", "revalidate", "staticParams"]) {
                check.push(rule(`c${index}_${key}`, `T.PageExportCheck<${m}, ${literal(key)}, ${literal(entry.path!)}, ${file}>`));
            }
            check.push(rule(`c${index}_exports`, `T.PageUnknownExportsCheck<${m}, ${file}>`));
        } else if (entry.kind === "proxy") {
            check.push(rule(`c${index}_default`, `T.ProxyExportCheck<${m}, ${file}>`), rule(`c${index}_exports`, `T.ProxyUnknownExportsCheck<${m}, ${file}>`));
        } else {
            const kind = literal(entry.kind);
            for (const key of entry.kind === "layout" ? ["default", "metadata", "generateMetadata"] : ["default"]) {
                check.push(rule(`c${index}_${key}`, `T.ComponentExportCheck<${m}, ${kind}, ${literal(key)}, ${file}>`));
            }
            check.push(rule(`c${index}_exports`, `T.ComponentUnknownExportsCheck<${m}, ${kind}, ${file}>`));
        }
    });
    if (scan.issues.length) {
        check.push("", "// Files in the wrong place: each line below fails until its file is fixed.");
        scan.issues.forEach((issue, index) => check.push(`export const f${index}: "ok" = ${literal(issue)};`));
    }
    check.push("");
    return { "routes.d.ts": routes, "check.ts": check.join("\n"), ...folderTypes(scan, corePackage) };
}

/**
 * `<folder>/$types.ts` for every folder with a route.ts, page.tsx or layout.tsx: `route`, `routes`, `page` and the
 * props types, bound to the folder's path. Files there import them as `"./$types"`; tsconfig's `rootDirs` (and the
 * build) map that to this generated file.
 */
function folderTypes(scan: AppScan, corePackage: string): Record<string, string> {
    const folders = new Map<string, Set<AppFileKind>>();
    for (const entry of scan.entries) {
        if (entry.kind !== "route" && entry.kind !== "page" && entry.kind !== "layout") continue;
        const dir = entry.file.slice(0, entry.file.lastIndexOf("/"));
        folders.set(dir, (folders.get(dir) ?? new Set()).add(entry.kind));
    }
    // What routes.d.ts registers for each path (the first file wins when two folders conflict). A binder for a path of
    // another kind would itself be a type error, so a conflicting folder only gets its params (the conflict is reported).
    const registered = new Map<string, AppFileKind>();
    for (const entry of scan.entries) if (entry.path !== undefined && !registered.has(entry.path)) registered.set(entry.path, entry.kind);

    const out: Record<string, string> = {};
    for (const [dir, kinds] of folders) {
        const appDir = dir.slice(dir.indexOf(APP_DIR) + APP_DIR.length + 1);
        let path: string;
        try {
            path = routePathOf(parseRouteDir(appDir) ?? []);
        } catch {
            continue; // an invalid folder name: reported in check.ts
        }
        const p = JSON.stringify(path);
        const values: string[] = [];
        const types = ["ParamsOf"];
        const lines: string[] = [];
        if (kinds.has("route") && registered.get(path) === "route") {
            values.push("bindRoute");
            lines.push(
                "",
                `/** route() for this folder: request.params and what the proxies around it add are typed (export const GET = route({ ... })). */`,
                `export const route = bindRoute(${p});`,
            );
        }
        if (kinds.has("page") && registered.get(path) === "page") {
            values.push("bindPage");
            types.push("PageProps as PagePropsOf");
            lines.push(
                "",
                `/** page() for this folder: params are typed from ${path}. */`,
                `export const page = bindPage(${p});`,
                `/** Props of a plain page component in this folder. */`,
                `export type PageProps = PagePropsOf<${p}>;`,
            );
        }
        if (kinds.has("layout")) {
            types.push("LayoutProps as LayoutPropsOf");
            lines.push("", `/** Props of this folder's layout.tsx. */`, `export type LayoutProps = LayoutPropsOf<${p}>;`);
        }
        out[`${dir}/$types.ts`] = [
            `// Generated by Tyvo for ${dir}/: import from "./$types" in that folder. Do not edit.`,
            ...(values.length ? [`import { ${values.join(", ")} } from ${JSON.stringify(corePackage)};`] : []),
            `import type { ${types.join(", ")} } from ${JSON.stringify(corePackage)};`,
            "",
            `/** This folder's params: ${path}. */`,
            `export type Params = ParamsOf<${p}>;`,
            ...lines,
            "",
        ].join("\n");
    }
    return out;
}

/** Writes `.tyvo/types/` (only files whose content changed, so editors do not reload for nothing). */
export function writeTypes(root: string): { notes: string[]; issues: string[] } {
    const scan = scanApp(projectTree(root));
    const dir = join(root, TYPES_DIR);
    const written = new Set<string>();
    for (const [name, content] of Object.entries(renderTypes(scan, "../.."))) {
        const file = join(dir, name);
        written.add(file);
        mkdirSync(dirname(file), { recursive: true });
        if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content);
    }
    // Folders that no longer have a route, page or layout lose their $types.ts, and folders left empty go too.
    const sweep = (folder: string) => {
        if (!existsSync(folder)) return;
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                sweep(path);
                if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
            } else if (entry.name === "$types.ts" && !written.has(path)) rmSync(path);
        }
    };
    sweep(join(dir, APP_DIR));
    return { notes: ensureTsconfig(root), issues: scan.issues };
}

/**
 * The project's tsconfig.json must include `.tyvo/types/` (and not exclude `.tyvo`). Projects from earlier versions
 * also lose the editor plugin entry (`{ "name": "@tyvo/core" }`): the generated checks replace it. Fixed in place
 * when the file is plain JSON.
 */
export function ensureTsconfig(root: string): string[] {
    const file = join(root, "tsconfig.json");
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    let config: { include?: unknown; exclude?: unknown; files?: unknown; compilerOptions?: { plugins?: unknown } };
    try {
        config = JSON.parse(text);
    } catch {
        return text.includes(TYPES_INCLUDE) ? [] : [`tsconfig.json: add "${TYPES_INCLUDE}" to "include" (and remove ".tyvo" from "exclude"): Tyvo's types and checks live there.`];
    }
    const notes: string[] = [];
    if (Array.isArray(config.include) && !config.include.includes(TYPES_INCLUDE)) {
        config.include.push(TYPES_INCLUDE);
        notes.push(`tsconfig.json: added "${TYPES_INCLUDE}" to "include" (generated route types and checks).`);
    } else if (config.include === undefined && config.files === undefined) {
        config.include = ["**/*.ts", "**/*.tsx", TYPES_INCLUDE];
        notes.push(`tsconfig.json: added "include" with "${TYPES_INCLUDE}" (generated route types and checks).`);
    }
    if (Array.isArray(config.exclude)) {
        const kept = config.exclude.filter((entry) => typeof entry !== "string" || entry.replace(/^\.\//, "").replace(/\/$/, "") !== ".tyvo");
        if (kept.length !== config.exclude.length) {
            config.exclude = kept;
            notes.push(`tsconfig.json: removed ".tyvo" from "exclude" (it only holds build output and the generated types).`);
        }
    }
    // "./$types" in src/app/<folder>/ resolves to .tyvo/types/src/app/<folder>/$types.ts.
    const options = (config.compilerOptions ??= {}) as { rootDirs?: unknown; plugins?: unknown };
    const rootDirs = Array.isArray(options.rootDirs) ? options.rootDirs : [];
    const normalized = rootDirs.map((dir) => String(dir).replace(/^\.\//, "").replace(/\/$/, "") || ".");
    if (!normalized.includes(".") || !normalized.includes(TYPES_DIR)) {
        options.rootDirs = [...rootDirs, ...(normalized.includes(".") ? [] : ["."]), ...(normalized.includes(TYPES_DIR) ? [] : [`./${TYPES_DIR}`])];
        notes.push(`tsconfig.json: added "rootDirs" [".", "./${TYPES_DIR}"] so "./$types" resolves to the generated folder types.`);
    }
    const plugins = config.compilerOptions?.plugins;
    if (Array.isArray(plugins)) {
        const kept = plugins.filter((plugin) => !/^@tyvo\/core(\/plugin)?$|^tyvo\/plugin$/.test(String((plugin as { name?: unknown })?.name)));
        if (kept.length !== plugins.length) {
            if (kept.length) config.compilerOptions!.plugins = kept;
            else delete config.compilerOptions!.plugins;
            notes.push(`tsconfig.json: removed the Tyvo editor plugin (its checks are generated into ${TYPES_DIR}/check.ts now).`);
        }
    }
    if (notes.length) writeFileSync(file, JSON.stringify(config, null, 4) + "\n");
    return notes;
}
