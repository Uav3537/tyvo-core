// Logging: every message Tyvo produces at runtime is a LogEntry, run through `loggers` from config.ts.
// Free of Node imports: also bundled into the SSR runtime, which reaches the config through the runtime's global slot.

export type LogLevel = "info" | "warn" | "error";

interface BaseEntry {
    level: LogLevel;
    time: Date;
}

/** What answered a request. */
export type RequestKind =
    /** route.ts */
    | "route"
    /** page.tsx (rendered, or `prerendered: true`) */
    | "page"
    /** POST /_tyvo/action */
    | "action"
    /** a file from public/ */
    | "public"
    /** browser JS, CSS and assets under /_tyvo/static/, and the dev live-update stream */
    | "internal"
    /** nothing matched (404) */
    | "not-found";

/** One finished request (when its response headers are ready; a streamed body may still be running). */
export interface RequestLog extends BaseEntry {
    type: "request";
    method: string;
    /** Path and query, e.g. `/users/1?tab=posts`. */
    path: string;
    status: number;
    /** Milliseconds until the response was ready. */
    duration: number;
    ip: string;
    kind: RequestKind;
    /** Route pattern, e.g. `/users/:id`, when a route or page matched. */
    pattern: string | undefined;
    /** Server action id (`src/actions/likes.ts#like`) for `kind: "action"`. */
    action: string | undefined;
    /** Served from the pages prerendered by `tyvo build`. */
    prerendered: boolean;
    request: Request;
}

/** The server is listening. */
export interface ReadyLog extends BaseEntry {
    type: "ready";
    url: string;
    version: string;
    dev: boolean;
    /** `tyvo dev` restarted the server after a rebuild (the CLI has already printed "Compiled"). */
    restart: boolean;
    /** Milliseconds since the process started. */
    duration: number;
    /** `.env` files that were loaded. */
    envFiles: string[];
    routes: { pattern: string; file: string }[];
}

/** A message: warnings (e.g. an invalid getIp() result) and errors (a throwing handler, a failed render, ...). */
export interface MessageLog extends BaseEntry {
    type: "message";
    message: string;
    /** The error, for error and some warning entries. */
    error?: unknown;
    /** The request being handled, when there is one. */
    request?: Request;
}

export type LogEntry = RequestLog | ReadyLog | MessageLog;

/**
 * One step of `loggers` in config.ts, called in order for every entry — like a middleware:
 * - nothing: the entry goes on to the next logger unchanged.
 * - a `LogEntry`: replaces the entry for the loggers after this one.
 * - `false`: drops the entry; the loggers after this one do not see it.
 */
export type Logger = (entry: LogEntry) => LogEntry | false | void | Promise<LogEntry | false | void>;

const RUNTIME = Symbol.for("tyvo.runtime");

type LogInput = { [K in LogEntry["type"]]: Omit<Extract<LogEntry, { type: K }>, "time"> & { time?: Date } }[LogEntry["type"]];

/** Runs an entry through `loggers` from config.ts (plain console output before Tyvo is configured). */
export function emit(input: LogInput): void {
    const entry = { time: new Date(), ...input } as LogEntry;
    const loggers = (globalThis as { [RUNTIME]?: { config: { loggers: readonly Logger[] } } })[RUNTIME]?.config.loggers;
    if (!loggers) {
        fallback(entry);
        return;
    }
    void runLoggers(loggers, entry);
}

/** Synchronous loggers run synchronously (output stays in order); an async one makes the rest wait for it. */
function runLoggers(loggers: readonly Logger[], entry: LogEntry, start = 0): void | Promise<void> {
    let current = entry;
    for (let i = start; i < loggers.length; i++) {
        let result: ReturnType<Logger>;
        try {
            result = loggers[i]!(current);
        } catch (error) {
            console.error(`[tyvo] loggers[${i}] in config.ts threw:`, error);
            continue;
        }
        if (result instanceof Promise) {
            return result.then(
                (resolved) => {
                    if (resolved === false) return;
                    return runLoggers(loggers, resolved && typeof resolved === "object" ? resolved : current, i + 1);
                },
                (error) => {
                    console.error(`[tyvo] loggers[${i}] in config.ts threw:`, error);
                    return runLoggers(loggers, current, i + 1);
                },
            );
        }
        if (result === false) return;
        if (result && typeof result === "object") current = result;
    }
}

function fallback(entry: LogEntry): void {
    if (entry.type !== "message") return;
    const write = entry.level === "error" ? console.error : entry.level === "warn" ? console.warn : console.log;
    if (entry.error === undefined) write(`[tyvo] ${entry.message}`);
    else write(`[tyvo] ${entry.message}`, entry.error);
}

// ---- nextLogger(): Next.js-style console output ------------------------------------------------------------

export interface NextLoggerOptions {
    /** ANSI colors, e.g. `process.stdout.isTTY`. */
    colors: boolean;
    /** Print a line per request (Next.js does in development only). */
    requests: boolean;
    /** Also print requests for browser assets and the dev live-update stream (`kind: "internal"`). */
    internalRequests: boolean;
}

/**
 * Console output in the style of Next.js:
 *
 * ```
 *    ▲ Tyvo 1.0.0
 *    - Local:        http://localhost:3000
 *    - Environments: .env.local
 *
 *  ✓ Ready in 412ms
 *  GET /users/1 200 in 23ms
 *  ⚠ getIp() returned "unknown", which is not an IPv4/IPv6 address; using the socket address.
 *  ⨯ Error: boom
 *      at handler (src/app/api/x/route.ts:4:15)
 * ```
 */
export function nextLogger(options: NextLoggerOptions): Logger {
    const paint = (code: number) => (text: string) => (options.colors ? `\x1b[${code}m${text}\x1b[0m` : text);
    const bold = paint(1);
    const dim = paint(2);
    const red = paint(31);
    const green = paint(32);
    const yellow = paint(33);
    const cyan = paint(36);
    const magenta = paint(35);

    return (entry) => {
        switch (entry.type) {
            case "ready": {
                if (entry.restart) return;
                const lines = [`   ${magenta(bold("▲ Tyvo " + entry.version))}${entry.dev ? dim(" (development)") : ""}`, `   - Local:        ${entry.url}`];
                if (entry.envFiles.length) lines.push(`   - Environments: ${entry.envFiles.join(", ")}`);
                lines.push("", ` ${green("✓")} Ready in ${formatDuration(entry.duration)}`);
                console.log(lines.join("\n"));
                return;
            }
            case "request": {
                if (!options.requests || (entry.kind === "internal" && !options.internalRequests)) return;
                const color = entry.status >= 500 ? red : entry.status >= 400 ? yellow : entry.status >= 300 ? cyan : green;
                const action = entry.action ? dim(` (${entry.action})`) : "";
                const prerendered = entry.prerendered ? dim(" (prerendered)") : "";
                console.log(` ${bold(entry.method)} ${entry.path}${action} ${color(String(entry.status))} in ${formatDuration(entry.duration)}${prerendered}`);
                return;
            }
            case "message": {
                const detail = entry.error === undefined ? "" : "\n" + describeError(entry.error);
                if (entry.level === "error") console.error(` ${red("⨯")} ${entry.message}${detail}`);
                else if (entry.level === "warn") console.warn(` ${yellow("⚠")} ${entry.message}${detail}`);
                else console.log(` ${cyan("○")} ${entry.message}${detail}`);
                return;
            }
        }
    };
}

function formatDuration(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Stack (or message) with the `cause` chain and a React digest, without Node's util. */
function describeError(error: unknown, depth = 0): string {
    if (!(error instanceof Error)) return typeof error === "string" ? error : safeJson(error);
    let text = error.stack ?? `${error.name}: ${error.message}`;
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") text += `\n    digest: ${digest}`;
    if (error.cause !== undefined && depth < 5) text += `\n  [cause]: ${describeError(error.cause, depth + 1)}`;
    return text;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
