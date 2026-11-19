import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads `.env` files into `process.env`, most specific first (an earlier file wins; real environment variables
 * always win):
 *
 *   .env.<mode>.local  >  .env.local  >  .env.<mode>  >  .env
 *
 * `mode` is "development" for `tyvo dev`, "production" for `tyvo build` / `tyvo start`, "test" for `buildTestClient()`.
 * `.local` files hold secrets and machine-specific values and are git-ignored.
 */
export function loadEnv(root: string, mode: "development" | "production" | "test"): string[] {
    const files = [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"];
    const loaded: string[] = [];
    for (const file of files) {
        const path = join(root, file);
        if (!existsSync(path)) continue;
        for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
            if (process.env[key] === undefined) process.env[key] = value;
        }
        loaded.push(file);
    }
    return loaded;
}

/** `KEY=value` lines; `#` comments, optional `export `, single/double quotes (double quotes expand \n). */
export function parseEnv(source: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of source.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        const [, key, raw] = match as unknown as [string, string, string];
        let value = raw;
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1);
            if (quote === '"') value = value.replace(/\\n/g, "\n");
        } else {
            value = value.replace(/\s+#.*$/, "");
        }
        result[key] = value;
    }
    return result;
}
