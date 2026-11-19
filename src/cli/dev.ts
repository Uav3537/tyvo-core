import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { build, formatBuildError } from "./build.js";
import { dim, fail, formatDuration, ok, progress } from "./output.js";
import { OUT_DIR, SERVER_BUNDLE, toPosix } from "./project.js";
import { writeTypes } from "./typegen.js";

const WATCHED = /\.(ts|tsx|json|js|jsx|mjs|cjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/;
const IGNORED = /(^|\/)(node_modules|\.tyvo|\.git|dist)(\/|$)/;

/**
 * Rebuilds and restarts the server whenever a source file changes. Open pages are told about the new build:
 * server-only changes re-render in place (client component state is kept), client components and CSS reload the page.
 */
export async function dev(root: string, port: number | undefined): Promise<void> {
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> = Promise.resolve();
    let clientModules = new Set<string>();
    const changed = new Set<string>();

    const stop = () =>
        new Promise<void>((resolve) => {
            if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill();
        });

    const cycle = async () => {
        const files = [...changed];
        changed.clear();
        if (files.length) progress(`Compiling ${dim(files.join(", "))} ...`);
        const started = performance.now();
        // Decided against the previous build's client modules: that is what the open pages are running.
        const update = files.some((file) => clientModules.has(file) || file.endsWith(".css")) ? "reload" : "refresh";
        try {
            // New or removed pages and routes: the editor sees them as typed paths, and broken rules, right away.
            const { notes, issues } = writeTypes(root);
            for (const note of notes) ok(note);
            for (const issue of issues) fail(issue);
            clientModules = new Set((await build({ root, dev: true })).clientModules);
        } catch (error) {
            fail(`Failed to compile\n${formatBuildError(error)}`);
            return;
        }
        await stop();
        // The first start prints its banner ("ready" log entry); restarts after a change only this line.
        const restart = !!child;
        if (restart) ok(`Compiled in ${formatDuration(performance.now() - started)}`);
        child = spawn(process.execPath, ["--enable-source-maps", join(root, OUT_DIR, SERVER_BUNDLE)], {
            cwd: root,
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: {
                ...process.env,
                NODE_ENV: "development",
                TYVO_DEV_UPDATE: update,
                ...(restart ? { TYVO_DEV_RESTART: "1" } : {}),
                ...(port ? { PORT: String(port) } : {}),
            },
        });
        // The server may move to another port when the configured one is taken; restarts reuse it so open pages keep working.
        child.on("message", (message: { type?: string; port?: number }) => {
            if (message.type === "tyvo:port" && message.port) port = message.port;
        });
    };

    // Serialize cycles so two rebuilds never race on the same port.
    const schedule = () => {
        running = running.then(cycle);
    };

    schedule();
    watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const file = toPosix(filename.toString());
        if (IGNORED.test(file) || !WATCHED.test(file)) return;
        changed.add(file);
        clearTimeout(timer);
        timer = setTimeout(schedule, 80);
    });

    const exit = async () => {
        await stop();
        process.exit(0);
    };
    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
}
