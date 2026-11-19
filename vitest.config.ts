import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
    resolve: {
        // The package imports itself by name (as tsconfig.json's "paths" do): tests run against the sources.
        alias: [
            { find: /^@tyvo\/core\/server$/, replacement: src("server/index.ts") },
            { find: /^@tyvo\/core\/router$/, replacement: src("react/router.ts") },
            { find: /^@tyvo\/core$/, replacement: src("index.ts") },
        ],
    },
    test: {
        include: ["test/**/*.test.ts"],
        // `vitest --typecheck` also checks the type tests (*.test-d.ts) with tsc.
        typecheck: { include: ["test/**/*.test-d.ts"], tsconfig: "test/tsconfig.json" },
    },
});
