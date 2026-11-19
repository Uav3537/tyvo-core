import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tyvo package root: the nearest directory above `from` holding package.json. Bundled code may land in
 * dist/ or dist/chunks/, so paths into the package (package.json, templates/) cannot be fixed relative ones.
 */
export function packageRoot(from: string): string {
    let dir = dirname(fileURLToPath(from));
    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error("tyvo: package.json not found");
        dir = parent;
    }
    return dir;
}
