import { defineConfig } from "tsup";

// Imported by name from the React runtimes; must stay external so user builds share one instance.
const selfReference = ["@tyvo/core", "@tyvo/core/server", "@tyvo/core/router"];

// Shared chunks go to dist/chunks/ so dist/ itself only holds the entry points.
const esbuildOptions = (options: { chunkNames?: string }) => {
    options.chunkNames = "chunks/[name]-[hash]";
};

export default defineConfig([
    {
        entry: { index: "src/index.ts", server: "src/server/index.ts", cli: "src/cli/index.ts", testing: "src/testing/index.ts" },
        format: ["esm"],
        target: "node18",
        platform: "node",
        dts: { entry: { index: "src/index.ts", server: "src/server/index.ts", testing: "src/testing/index.ts" } },
        sourcemap: true,
        splitting: true,
        esbuildOptions,
    },
    {
        // Re-bundled by `tyvo build` into .tyvo/rsc.mjs and .tyvo/ssr.mjs.
        entry: { "react-rsc": "src/react/rsc.ts", "react-ssr": "src/react/ssr.ts" },
        format: ["esm"],
        target: "node18",
        platform: "node",
        external: selfReference,
        splitting: false,
        sourcemap: true,
    },
    {
        // Re-bundled by `tyvo build` into the browser runtime.
        entry: { "react-browser": "src/react/browser.ts" },
        format: ["esm"],
        target: "es2022",
        platform: "browser",
        splitting: false,
        sourcemap: true,
    },
    {
        // Typed API client: runs in the browser and on the server, so no "use client" (server code calls it too).
        entry: { client: "src/client.ts" },
        format: ["esm"],
        target: "es2022",
        platform: "neutral",
        dts: true,
        splitting: false,
        sourcemap: true,
    },
    {
        // Client components: the directive must survive bundling so `tyvo build` sees them.
        entry: { router: "src/react/router.ts", link: "src/react/link.ts" },
        format: ["esm"],
        target: "es2022",
        platform: "browser",
        external: selfReference,
        dts: true,
        banner: { js: '"use client";' },
        splitting: false,
        sourcemap: true,
    },
]);
