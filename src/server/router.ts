import { formatSegments, parseRouteDir, routeDirOf, routePathOf, type Segment } from "../shared/conventions.js";
import type { Params } from "../types.js";

export interface RouteEntry<T> {
    file: string;
    /** `/users/:id`, as shown in logs. */
    pattern: string;
    /** `/users/[id]`, as written in types (`route({ path })`, `PageProps<...>`). */
    path: string;
    segments: Segment[];
    value: T;
}

const RANK: Record<Segment["kind"], number> = { static: 0, dynamic: 1, catchAll: 2, optionalCatchAll: 3 };

export class Router<T> {
    private readonly entries: RouteEntry<T>[] = [];

    /** `file` is relative to the project root, e.g. `app/users/[id]/route.ts`. */
    add(file: string, value: T): RouteEntry<T> | null {
        const dir = routeDirOf(file);
        if (dir === null) throw new Error(`"${file}" is not a route file.`);
        const segments = parseRouteDir(dir);
        if (!segments) return null;

        const pattern = formatSegments(segments);
        const key = shapeKey(segments);
        const conflict = this.entries.find((entry) => shapeKey(entry.segments) === key);
        if (conflict) throw new Error(`Conflicting routes: "${conflict.file}" and "${file}" both resolve to ${pattern}.`);

        const entry = { file, pattern, path: routePathOf(segments), segments, value };
        this.entries.push(entry);
        this.entries.sort(compare);
        return entry;
    }

    match(pathname: string): { entry: RouteEntry<T>; params: Params } | null {
        const parts = pathname.split("/").filter(Boolean).map(safeDecode);
        for (const entry of this.entries) {
            const params = matchSegments(entry.segments, parts);
            if (params) return { entry, params };
        }
        return null;
    }

    list(): readonly RouteEntry<T>[] {
        return this.entries;
    }
}

export { toPath } from "../shared/conventions.js";

/** Path with every segment decoded, so differently encoded spellings of one URL compare equal. */
export function pathKey(pathname: string): string {
    return "/" + pathname.split("/").filter(Boolean).map(safeDecode).join("/");
}

function matchSegments(segments: Segment[], parts: string[]): Params | null {
    const params: Record<string, string | string[] | undefined> = {};
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!;
        const part = parts[i];
        switch (segment.kind) {
            case "static":
                if (part !== segment.value) return null;
                break;
            case "dynamic":
                if (part === undefined) return null;
                params[segment.name] = part;
                break;
            case "catchAll":
                if (part === undefined) return null;
                params[segment.name] = parts.slice(i);
                return params;
            case "optionalCatchAll":
                params[segment.name] = part === undefined ? undefined : parts.slice(i);
                return params;
        }
    }
    return parts.length === segments.length ? params : null;
}

function compare(a: RouteEntry<unknown>, b: RouteEntry<unknown>): number {
    const length = Math.max(a.segments.length, b.segments.length);
    for (let i = 0; i < length; i++) {
        const left = a.segments[i];
        const right = b.segments[i];
        if (!left || !right) return left ? 1 : -1;
        const diff = RANK[left.kind] - RANK[right.kind];
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Two routes conflict when they match exactly the same URLs, regardless of parameter names. */
function shapeKey(segments: Segment[]): string {
    return segments.map((segment) => (segment.kind === "static" ? `s:${segment.value}` : segment.kind)).join("/");
}

function safeDecode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}
