#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, formatBuildError } from "./build.js";
import { check } from "./check.js";
import { dev } from "./dev.js";
import { loadEnv } from "./env.js";
import { banner, fail, formatDuration, ok, routeTable } from "./output.js";
import { prerender } from "./prerender.js";
import { packageRoot } from "../shared/package.js";
import { OUT_DIR, SERVER_BUNDLE } from "./project.js";
import { TYPES_DIR, writeTypes } from "./typegen.js";
import { templates } from "./templates.js";

const HELP = `tyvo <command> [options]

Commands:
  init [dir]     Scaffold a new Tyvo project (then runs npm install)
  dev            Start the development server with rebuild on change
  build          Type-check, bundle the server into ${OUT_DIR}/ and prerender pages (export const prerender = true)
  start          Run the production bundle
  check          Type-check and validate src/app/ and config.ts
  typegen        Write the route types and rule checks (.tyvo/types/); dev, build and check do it too

Options:
  --port <n>     Port for dev/start (overrides PORT and config.ts "port")
  --no-check     Skip type checking in build
  --minify       Minify the build output
  --example      init: add example routes, pages, middlewares and server actions
  --no-install   init: skip npm install
  --force        init: overwrite existing files
  -v, --version  Print the Tyvo version

Environment: .env.<mode>.local > .env.local > .env.<mode> > .env are loaded into process.env
(mode: development for dev, production for build/start).
`;

interface Args {
    command: string | undefined;
    positionals: string[];
    flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
    const flags = new Map<string, string | true>();
    const positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
        const next = argv[i + 1];
        if (inline !== undefined) flags.set(name, inline);
        else if (name === "port" && next && !next.startsWith("--")) flags.set(name, argv[++i]!);
        else flags.set(name, true);
    }
    return { command: positionals.shift(), positionals, flags };
}

function tyvoVersion(): string {
    const pkg = join(packageRoot(import.meta.url), "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version;
}

function init(target: string, options: { force: boolean; example: boolean; install: boolean }): void {
    const { force } = options;
    const root = resolve(target);
    // A fresh secret per project, written to .env.local (git-ignored).
    const cookieSecret = randomBytes(32).toString("base64url");
    const files = templates(basename(root), tyvoVersion(), { example: options.example, cookieSecret });
    for (const [file, contents] of Object.entries(files)) {
        const path = join(root, file);
        if (existsSync(path) && !force) {
            console.log(`  skip    ${file} (exists)`);
            continue;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
        console.log(`  create  ${file}`);
    }
    // So the editor knows the routes (typed <Link>, href(), api()) before the first `tyvo dev`.
    writeTypes(root);
    const cd = resolve(target) === process.cwd() ? "" : `  cd ${target}\n`;
    if (options.install) {
        const local = localBuild();
        console.log("\nInstalling dependencies (npm install)...");
        // A local build (npm run local in the Tyvo repo) may carry a version npm does not have yet: install
        // everything else from npm and copy this build in as @tyvo/core.
        const installed = local ? installWithLocalBuild(root) : npmInstall(root);
        if (!installed) {
            console.log(`\nnpm install failed. Run it yourself, then:\n${cd}  npm run dev`);
            return;
        }
        if (local) {
            console.log(
                `\nUsing the local Tyvo build (${local}) as @tyvo/core ${tyvoVersion()}.` +
                    `\nUntil that version is on npm, "npm install" in this project fails; re-run "npm run local -- <project>" in the Tyvo repo instead.`,
            );
        }
        console.log(`\nDone. Next steps:\n${cd}  npm run dev`);
        return;
    }
    console.log(`\nDone. Next steps:\n${cd}  npm install\n  npm run dev`);
}

function npmInstall(root: string): boolean {
    // npm creates package-lock.json. On Windows npm is a .cmd script, which needs a shell; a single command
    // string (no argument array) keeps the shell from concatenating unescaped arguments.
    return spawnSync("npm install", { cwd: root, stdio: "inherit", shell: true }).status === 0;
}

/** Set by scripts/local.mjs in the copies it makes; a release installed from npm has no such field. */
function localBuild(): string | undefined {
    const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "package.json"), "utf8"));
    return typeof pkg.tyvoLocalBuild === "string" ? pkg.tyvoLocalBuild : undefined;
}

function installWithLocalBuild(root: string): boolean {
    const manifest = join(root, "package.json");
    const original = readFileSync(manifest, "utf8");
    const pkg = JSON.parse(original);
    delete pkg.dependencies["@tyvo/core"];
    writeFileSync(manifest, JSON.stringify(pkg, null, 4) + "\n");
    try {
        if (!npmInstall(root)) return false;
    } finally {
        writeFileSync(manifest, original);
    }
    // The whole package, including its own node_modules (esbuild, ...), as npm would have installed it.
    const target = join(root, "node_modules", "@tyvo", "core");
    rmSync(target, { recursive: true, force: true });
    cpSync(packageRoot(import.meta.url), target, { recursive: true });
    return true;
}

/** Fails early with one clear line instead of a wall of "Could not resolve" errors from the bundler. */
function requireInstalled(root: string): void {
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) return;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => !isInstalled(root, name));
    if (missing.length) {
        throw new Error(`Dependencies are not installed (missing: ${missing.join(", ")}). Run: npm install`);
    }
}

function isInstalled(root: string, name: string): boolean {
    // Walks up like Node's resolution, so hoisted workspace installs count too.
    for (let dir = root; ; dir = dirname(dir)) {
        if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
        if (dirname(dir) === dir) return false;
    }
}

/** The server prints the loaded .env files in its "ready" log entry (see nextLogger). */
function shareEnv(files: string[]): void {
    process.env.TYVO_ENV_FILES = files.join(",");
}

/** `.tyvo/types/` from `src/app/`; prints what it fixed in tsconfig.json and, with `report`, the broken file rules. */
function typegen(root: string, report: boolean): string[] {
    const { notes, issues } = writeTypes(root);
    for (const note of notes) ok(note);
    if (report) for (const issue of issues) fail(issue);
    return issues;
}

function runCheck(root: string): boolean {
    // The broken rules also fail the type check below (they are in .tyvo/types/check.ts), with the same messages.
    typegen(root, false);
    const started = performance.now();
    const { errors, warnings } = check(root);
    const summary = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
    if (errors) fail(`Type check failed (${summary})`);
    else ok(`Types and conventions checked in ${formatDuration(performance.now() - started)}${warnings ? ` (${summary})` : ""}`);
    return errors === 0;
}

async function main(): Promise<void> {
    const { command, positionals, flags } = parseArgs(process.argv.slice(2));
    if (command === "-v" || command === "version" || flags.has("version")) {
        console.log(tyvoVersion());
        return;
    }
    const root = process.cwd();
    const port = flags.has("port") ? Number(flags.get("port")) : undefined;
    if (port !== undefined && !Number.isInteger(port)) throw new Error(`Invalid --port value.`);
    if (command === "dev" || command === "build" || command === "check") requireInstalled(root);

    switch (command) {
        case "init":
            init(positionals[0] ?? ".", { force: flags.has("force"), example: flags.has("example"), install: !flags.has("no-install") });
            break;
        case "dev":
            shareEnv(loadEnv(root, "development"));
            await dev(root, port);
            break;
        case "build": {
            const envFiles = loadEnv(root, "production");
            banner(tyvoVersion(), envFiles.length ? [["Environments", envFiles.join(", ")]] : []);
            if (flags.has("no-check")) typegen(root, true);
            else if (!runCheck(root)) process.exit(1);
            const started = performance.now();
            const project = await build({ root, minify: flags.has("minify") });
            ok(`Compiled ${project.routes.length} route${project.routes.length === 1 ? "" : "s"} and ${project.pages.length} page${project.pages.length === 1 ? "" : "s"} in ${formatDuration(performance.now() - started)}`);
            // Prerendering loads config.ts (and its environment variables); only do it when a page asks for it.
            const PRERENDER = /^\s*export\s+const\s+prerender\s*(?::[^=]+)?=\s*true\b/m;
            const prerendered = new Map<string, string[]>();
            if (project.pages.some((page) => PRERENDER.test(readFileSync(join(root, page.file), "utf8")))) {
                const prerendering = performance.now();
                const pages = await prerender(join(root, OUT_DIR));
                for (const { index, path } of pages) {
                    const file = project.pages[index]!.file;
                    prerendered.set(file, [...(prerendered.get(file) ?? []), path]);
                }
                ok(`Generated ${pages.length} static page${pages.length === 1 ? "" : "s"} in ${formatDuration(performance.now() - prerendering)}`);
            }
            routeTable([...project.routes, ...project.pages.map((page) => page.file)], prerendered);
            // Prerendering loaded config.ts, which may keep the process alive (timers, connections).
            process.exit(0);
        }
        case "start": {
            const bundle = join(root, OUT_DIR, SERVER_BUNDLE);
            if (!existsSync(bundle)) throw new Error(`${OUT_DIR}/${SERVER_BUNDLE} not found. Run "tyvo build" first.`);
            shareEnv(loadEnv(root, "production"));
            if (port) process.env.PORT = String(port);
            process.env.NODE_ENV ??= "production";
            // Stack traces in logged errors point into src/, as with `tyvo dev` (--enable-source-maps).
            process.setSourceMapsEnabled(true);
            await import(pathToFileURL(bundle).href);
            break;
        }
        case "check":
            if (!runCheck(root)) process.exit(1);
            break;
        case "typegen":
            if (typegen(root, true).length) process.exitCode = 1;
            ok(`Types and checks written to ${TYPES_DIR}/`);
            break;
        case undefined:
        case "help":
            console.log(HELP);
            break;
        default:
            console.error(`Unknown command "${command}".\n\n${HELP}`);
            process.exit(1);
    }
}

main().catch((error) => {
    fail(formatBuildError(error));
    process.exit(1);
});
