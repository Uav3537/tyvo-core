import type { TyvoRequest } from "./request.js";

/** What `key` gets besides the request. */
export interface RatelimitTarget {
    /** The endpoint's pattern, e.g. `/users/:id` (`/_tyvo/action` for server actions). */
    pattern: string;
}

export interface RatelimitOptions {
    /** Length of one window in milliseconds. */
    timeWindow: number;
    /** Requests allowed per key within one window. */
    max: number;
    /**
     * The bucket a request counts against; requests with the same key share `max`. Return everything that should
     * separate buckets, e.g. `` `${request.method}:${pattern}:${request.ip}` `` (per client, endpoint and method)
     * or `request.ip` alone (one budget per client across the whole app).
     */
    key: (request: TyvoRequest, target: RatelimitTarget) => string | Promise<string>;
}

export interface RatelimitEntry {
    count: number;
    /** Epoch milliseconds at which the window resets. */
    resetAt: number;
}

/**
 * Backing store for rate-limit counters. Export one from `config.ts` as `ratelimitStorage`
 * to share counters across processes (Redis, a database, ...).
 */
export interface RatelimitStorage {
    get(key: string): RatelimitEntry | undefined | null | Promise<RatelimitEntry | undefined | null>;
    /** `ttl` is the time in milliseconds until the entry may be discarded. */
    set(key: string, entry: RatelimitEntry, ttl: number): void | Promise<void>;
}

export interface MemoryStorageOptions {
    /** How often expired entries are removed, in milliseconds. */
    sweepInterval: number;
}

/** Process-local storage (counters are not shared between processes). */
export function memoryStorage(options: MemoryStorageOptions): RatelimitStorage {
    const entries = new Map<string, RatelimitEntry>();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of entries) if (entry.resetAt <= now) entries.delete(key);
    }, options.sweepInterval);
    timer.unref?.();

    return {
        get(key) {
            const entry = entries.get(key);
            if (entry && entry.resetAt <= Date.now()) {
                entries.delete(key);
                return undefined;
            }
            return entry;
        },
        set(key, entry) {
            entries.set(key, entry);
        },
    };
}

export interface RatelimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: number;
}

/** Fixed-window counter. */
export async function consume(storage: RatelimitStorage, key: string, options: RatelimitOptions): Promise<RatelimitResult> {
    const now = Date.now();
    let entry = await storage.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + options.timeWindow };

    entry = { count: entry.count + 1, resetAt: entry.resetAt };
    await storage.set(key, entry, entry.resetAt - now);

    return {
        allowed: entry.count <= options.max,
        limit: options.max,
        remaining: Math.max(0, options.max - entry.count),
        resetAt: entry.resetAt,
    };
}

export function isRatelimitOptions(value: unknown): value is RatelimitOptions {
    const options = value as Partial<RatelimitOptions> | null;
    return typeof options === "object" && options !== null && typeof options.timeWindow === "number" && typeof options.max === "number" && typeof options.key === "function";
}
