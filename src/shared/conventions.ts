// File-system conventions shared by the runtime, the CLI and the generated type checks.
// Must stay free of Node/TypeScript imports so it can be bundled anywhere.

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Routes and pages live here; other source folders (components/, lib/, middlewares/) sit next to it in src/. */
export const APP_DIR = "src/app";
export const CONFIG_BASENAME = "config";
export const ROUTE_BASENAME = "route";
export const PAGE_BASENAME = "page";
export const LAYOUT_BASENAME = "layout";
export const LOADING_BASENAME = "loading";
export const ERROR_BASENAME = "error";
export const NOT_FOUND_BASENAME = "not-found";
/** Wraps every route.ts in its folder and below (pages are not affected). */
export const PROXY_BASENAME = "proxy";
export const PUBLIC_DIR = "public";
export const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
export const FORBIDDEN_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"] as const;

export const CONFIG_EXPORTS = ["defaultParser", "defaultRatelimit", "ratelimitStorage", "cacheStorage", "defaultCORS", "defaultCSP", "defaultCookie", "cookieSecret", "serverActions", "getIp", "onError", "port", "trailingSlash", "server", "staticCacheControl", "prefetch", "loggers"] as const;

export type Segment =
    | { kind: "static"; value: string }
    | { kind: "dynamic"; name: string }
    | { kind: "catchAll"; name: string }
    | { kind: "optionalCatchAll"; name: string };

export class ConventionError extends Error {
    override name = "ConventionError";
}

export function isHttpMethod(name: string): name is HttpMethod {
    return (HTTP_METHODS as readonly string[]).includes(name);
}

function hasBasename(basename: string, name: string): boolean {
    return SOURCE_EXTENSIONS.some((ext) => basename === name + ext);
}

export function isRouteFile(basename: string): boolean {
    return hasBasename(basename, ROUTE_BASENAME);
}

export function isPageFile(basename: string): boolean {
    return hasBasename(basename, PAGE_BASENAME);
}

export function isLayoutFile(basename: string): boolean {
    return hasBasename(basename, LAYOUT_BASENAME);
}

export function hasForbiddenExtension(fileName: string): boolean {
    return FORBIDDEN_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Converts the directory part of a route file (relative to `app/`, `/`-separated)
 * into route segments. Returns `null` when the route lives inside a private (`_folder`) directory.
 *
 *   ""                      -> /
 *   "users/[id]"            -> /users/:id
 *   "(admin)/stats"         -> /stats
 *   "docs/[...slug]"        -> /docs/*slug
 *   "shop/[[...slug]]"      -> /shop/*slug?
 */
export function parseRouteDir(dir: string): Segment[] | null {
    const parts = dir.split("/").filter(Boolean);
    const segments: Segment[] = [];
    const names = new Set<string>();

    for (const [index, part] of parts.entries()) {
        if (part.startsWith("_")) return null;
        if (part.startsWith("(") && part.endsWith(")")) continue;

        let segment: Segment;
        let match: RegExpMatchArray | null;
        if ((match = part.match(/^\[\[\.\.\.([^\]]*)\]\]$/))) {
            segment = { kind: "optionalCatchAll", name: match[1]! };
        } else if ((match = part.match(/^\[\.\.\.([^\]]*)\]$/))) {
            segment = { kind: "catchAll", name: match[1]! };
        } else if ((match = part.match(/^\[([^\]]*)\]$/))) {
            segment = { kind: "dynamic", name: match[1]! };
        } else if (/[[\]]/.test(part)) {
            throw new ConventionError(`Invalid route segment "${part}". Use [name], [...name] or [[...name]].`);
        } else {
            segment = { kind: "static", value: part };
        }

        if (segment.kind !== "static") {
            if (!IDENTIFIER.test(segment.name)) {
                throw new ConventionError(`Invalid parameter name "${segment.name}" in "${part}". Parameter names must be valid identifiers.`);
            }
            if (names.has(segment.name)) {
                throw new ConventionError(`Duplicate parameter name "${segment.name}" in route "${dir}".`);
            }
            names.add(segment.name);
            if ((segment.kind === "catchAll" || segment.kind === "optionalCatchAll") && index !== parts.length - 1) {
                throw new ConventionError(`Catch-all segment "${part}" must be the last segment of the route.`);
            }
        }
        segments.push(segment);
    }
    return segments;
}

/**
 * A route's path as written in the folder names, without groups: `app/(shop)/users/[id]/page.tsx` -> `/users/[id]`.
 * This is how routes are named in types (`PageProps<"/users/[id]">`, `route({ path })`, `href()`).
 */
export function routePathOf(segments: Segment[]): string {
    const path = segments
        .map((segment) => {
            switch (segment.kind) {
                case "static":
                    return segment.value;
                case "dynamic":
                    return `[${segment.name}]`;
                case "catchAll":
                    return `[...${segment.name}]`;
                case "optionalCatchAll":
                    return `[[...${segment.name}]]`;
            }
        })
        .join("/");
    return "/" + path;
}

/** The URL for a route's params: `/users/[id]` segments + `{ id: "1" }` -> `/users/1`. Throws on a missing or mistyped param. */
export function toPath(segments: Segment[], params: Readonly<Record<string, unknown>>): string {
    const parts: string[] = [];
    const invalid = (name: string, expected: string) => new TypeError(`param "${name}" must be ${expected}, got ${JSON.stringify(params[name]) ?? "undefined"}.`);
    for (const segment of segments) {
        if (segment.kind === "static") {
            parts.push(segment.value);
            continue;
        }
        const value = params[segment.name];
        if (segment.kind === "dynamic") {
            if (typeof value !== "string" || value === "") throw invalid(segment.name, "a non-empty string");
            parts.push(encodeURIComponent(value));
            continue;
        }
        if (value === undefined && segment.kind === "optionalCatchAll") continue;
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "") || (segment.kind === "catchAll" && value.length === 0)) {
            throw invalid(segment.name, segment.kind === "catchAll" ? "a non-empty array of non-empty strings" : "an array of non-empty strings or undefined");
        }
        parts.push(...value.map((item: string) => encodeURIComponent(item)));
    }
    return "/" + parts.join("/");
}

/** The route path a project file serves (`src/app/(shop)/users/[id]/page.tsx` -> `/users/[id]`), or null when it is not routed. */
export function routePathOfFile(relativeFile: string): string | null {
    const file = appFileOf(relativeFile.replace(/\\/g, "/"));
    if (!file) return null;
    const segments = parseRouteDir(file.dir);
    return segments ? routePathOf(segments) : null;
}

/** Segments of a route path such as `/users/[id]` (the inverse of `routePathOf`). */
export function parseRoutePath(path: string): Segment[] {
    if (!path.startsWith("/")) throw new ConventionError(`Route path "${path}" must start with "/".`);
    return parseRouteDir(path.slice(1)) ?? [];
}

export function formatSegments(segments: Segment[]): string {
    const path = segments
        .map((segment) => {
            switch (segment.kind) {
                case "static":
                    return segment.value;
                case "dynamic":
                    return `:${segment.name}`;
                case "catchAll":
                    return `*${segment.name}`;
                case "optionalCatchAll":
                    return `*${segment.name}?`;
            }
        })
        .join("/");
    return "/" + path;
}

export type AppFileKind = "route" | "page" | "layout" | "loading" | "error" | "not-found" | "proxy";

const SPECIAL_FILES: [string, AppFileKind][] = [
    [ROUTE_BASENAME, "route"],
    [PAGE_BASENAME, "page"],
    [LAYOUT_BASENAME, "layout"],
    [LOADING_BASENAME, "loading"],
    [ERROR_BASENAME, "error"],
    [NOT_FOUND_BASENAME, "not-found"],
    [PROXY_BASENAME, "proxy"],
];

/**
 * The proxy.ts files that wrap a route file, outermost first: those in the route's folder and every folder above it
 * inside `app/` (by folder, like layouts, so a proxy in `(group)/` only wraps that group). Paths are project-relative.
 */
export function proxyChainOf(routeFile: string, proxyFiles: readonly string[]): string[] {
    const route = appFileOf(routeFile.replace(/\\/g, "/"));
    if (!route) return [];
    const inside = (dir: string) => dir === "" || route.dir === dir || route.dir.startsWith(dir + "/");
    return proxyFiles
        .map((file) => ({ file, proxy: appFileOf(file.replace(/\\/g, "/")) }))
        .filter((entry) => entry.proxy?.kind === "proxy" && inside(entry.proxy.dir))
        .sort((a, b) => a.proxy!.dir.split("/").filter(Boolean).length - b.proxy!.dir.split("/").filter(Boolean).length)
        .map((entry) => entry.file);
}

/** Classifies `app/users/[id]/page.tsx` (relative to project root, `/`-separated) and returns its directory inside `app/`. */
export function appFileOf(relativeFile: string): { kind: AppFileKind; dir: string } | null {
    if (!relativeFile.startsWith(APP_DIR + "/")) return null;
    const parts = relativeFile.slice(APP_DIR.length + 1).split("/");
    const base = parts[parts.length - 1]!;
    const kind = SPECIAL_FILES.find(([name]) => hasBasename(base, name))?.[1] ?? null;
    return kind ? { kind, dir: parts.slice(0, -1).join("/") } : null;
}

/** True when `dir` (inside `app/`) is or sits below a private `_folder`, where any file is allowed. */
export function isPrivateDir(dir: string): boolean {
    return dir.split("/").some((part) => part.startsWith("_"));
}

/** Files allowed in `app/` outside private folders: the special files and stylesheets (`globals.css`, `*.module.css`). */
export function isAllowedAppFile(basename: string): boolean {
    return SPECIAL_FILES.some(([name]) => hasBasename(basename, name)) || basename.endsWith(".css");
}

/** Directory (inside `app/`) of an endpoint file — `route.ts` or `page.tsx`. */
export function routeDirOf(relativeFile: string): string | null {
    const file = appFileOf(relativeFile);
    return file && (file.kind === "route" || file.kind === "page") ? file.dir : null;
}
