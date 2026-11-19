#!/usr/bin/env node
// Type-checks templates/ like a generated project: writes the types and rule checks for base/ + example/ (example's
// files win, as `tyvo init --example` copies them over base/) into templates/.types/, then runs tsc -p templates.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const repo = fileURLToPath(new URL("..", import.meta.url));
const templates = join(repo, "templates");

// The generator is TypeScript in src/cli; bundle it for this script.
const bundle = join(repo, "node_modules", ".cache", "tyvo-typegen.mjs");
await esbuild.build({ entryPoints: [join(repo, "src/cli/typegen.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "warning" });
const { scanApp, renderTypes } = await import(pathToFileURL(bundle).href + `?${Date.now()}`);

// The project `tyvo init --example` creates: src/app/ paths, each backed by the template file that ends up there.
const files = new Map();
for (const dir of ["base", "example"]) {
    const walk = (abs, rel) => {
        if (!existsSync(abs)) return;
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(abs, entry.name), `${rel}/${entry.name}`);
            else files.set(`src/app${rel}/${entry.name}`, `${dir}/src/app${rel}/${entry.name}`);
        }
    };
    walk(join(templates, dir, "src", "app"), "");
}
const scan = scanApp({
    files: [...files].map(([app, file]) => ({ app, file })),
    read: (file) => readFileSync(join(templates, file), "utf8"),
    config: "base/config.ts",
});

const out = join(templates, ".types");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(renderTypes(scan, ".."))) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), content);
}

execSync("npx tsc --noEmit -p templates", { cwd: repo, stdio: "inherit" });
