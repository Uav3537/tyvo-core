#!/usr/bin/env node
// Publishes tyvo to npm: `npm run release [patch|minor|major|<version>] [-- --dry-run]`.
// Only the "files" listed in package.json (dist, assets.d.ts, templates) are uploaded; src/ is not.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bump = args.find((arg) => !arg.startsWith("--"));

function run(command, options = {}) {
    console.log(`\n> ${command}`);
    return execSync(command, { stdio: options.capture ? "pipe" : "inherit", encoding: "utf8" });
}

function version() {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

try {
    if (!dryRun) {
        try {
            console.log(`npm user: ${run("npm whoami", { capture: true }).trim()}`);
        } catch {
            throw new Error('Not logged in to npm. Run "npm login" first.');
        }
    }

    // Updates package.json (and package-lock.json) only; committing and tagging is left to you.
    if (bump) run(`npm version ${bump} --no-git-tag-version`);

    run("npm run typecheck");
    run("npm run build");

    const cliVersion = run("node dist/cli.js -v", { capture: true }).trim();
    if (cliVersion !== version()) throw new Error(`dist/cli.js reports ${cliVersion}, package.json has ${version()}.`);

    const published = (() => {
        try {
            return run(`npm view @tyvo/core@${version()} version`, { capture: true }).trim();
        } catch {
            return "";
        }
    })();
    if (published) throw new Error(`@tyvo/core@${version()} is already on npm. Pass patch, minor, major or a version.`);

    // prepublishOnly would rebuild; the build above is fresh, so skip it.
    run(`npm publish --ignore-scripts${dryRun ? " --dry-run" : ""}`);
    console.log(`\n${dryRun ? "Dry run complete for" : "Published"} @tyvo/core@${version()}`);
} catch (error) {
    console.error(`\nRelease failed: ${error.message}`);
    process.exit(1);
}
