#!/usr/bin/env node
// Tries the local build without publishing: copies it over an installed @tyvo/core.
//
//   npm run local                          global install (the `tyvo` command)
//   npm run local -- <project> [...]       also <project>/node_modules/@tyvo/core
//   npm run local -- --watch <project>     rebuild and copy again on every change
//   npm run local -- --restore <project>   put the npm versions back
//
// Only the published files (package.json "files" + package.json) are replaced; the target's own node_modules stay.
// Nothing is linked, so the next `npm install` / `npm i -g` of a real release simply overwrites the copy.
import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const projects = args.filter((arg) => !arg.startsWith("--")).map((dir) => resolve(dir));

function run(command, cwd = repo) {
    console.log(`> ${command}${cwd === repo ? "" : `  (in ${cwd})`}`);
    execSync(command, { cwd, stdio: "inherit" });
}

const globalTarget = join(execSync("npm root -g", { encoding: "utf8" }).trim(), ...pkg.name.split("/"));
const targets = [
    { label: "global", dir: globalTarget },
    ...projects.map((project) => ({ label: project, dir: join(project, "node_modules", ...pkg.name.split("/")), project })),
];

if (flags.has("--restore")) {
    for (const target of targets) {
        if (target.project) {
            rmSync(target.dir, { recursive: true, force: true });
            run("npm install", target.project);
        } else {
            run(`npm install -g ${pkg.name}`);
        }
    }
    process.exit(0);
}

for (const target of targets) {
    if (!existsSync(target.dir)) {
        console.error(`${pkg.name} is not installed at ${target.dir}. Install it first (npm install ${target.project ? "" : "-g "}${pkg.name}).`);
        process.exit(1);
    }
    if (realpathSync(target.dir) === realpathSync(repo)) {
        console.error(`${target.dir} is linked to this repo (npm link). Remove the link first: npm rm ${target.project ? "" : "-g "}${pkg.name}`);
        process.exit(1);
    }
}

function copy() {
    const current = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const entries = [...current.files, "package.json"];
    for (const target of targets) {
        // Dependencies are not reinstalled: a new or changed one has to be installed by hand.
        const installed = JSON.parse(readFileSync(join(target.dir, "package.json"), "utf8"));
        const changed = Object.entries(current.dependencies ?? {}).filter(([name, range]) => installed.dependencies?.[name] !== range);

        // Old hashed chunks must not linger, so each published entry is replaced as a whole.
        for (const entry of entries) {
            const from = join(repo, entry);
            if (!existsSync(from)) continue;
            rmSync(join(target.dir, entry), { recursive: true, force: true });
            cpSync(from, join(target.dir, entry), { recursive: true });
        }
        // `tyvo init` from this copy installs the copy itself: its version may not be on npm yet.
        const copied = JSON.parse(readFileSync(join(target.dir, "package.json"), "utf8"));
        copied.tyvoLocalBuild = repo.replace(/[\\/]$/, "");
        writeFileSync(join(target.dir, "package.json"), JSON.stringify(copied, null, 2) + "\n");
        console.log(`✓ local build copied to ${target.label}`);
        for (const [name, range] of changed) console.warn(`  ! dependency ${name}@${range} differs from the installed release; install it there if it fails.`);
    }
    console.log(`  Projects: run "tyvo typegen" (or tyvo dev) there to regenerate .tyvo/types/ with this build's checks.`);
}

if (!flags.has("--watch")) {
    run("npm run build");
    copy();
    process.exit(0);
}

// --watch: tsup rebuilds dist/, every settled change is copied again.
const tsup = spawn("npx tsup --watch", { cwd: repo, stdio: "inherit", shell: true });
let timer;
const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
        try {
            copy();
        } catch (error) {
            console.error(`copy failed: ${error.message}`);
        }
    }, 1500); // tsup writes its five configs (and the slower .d.ts pass) one after another
};
for (const dir of ["dist", "templates"]) {
    if (existsSync(join(repo, dir))) watch(join(repo, dir), { recursive: true }, schedule);
}
const stop = () => {
    tsup.kill();
    process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
