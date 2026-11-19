// Must be evaluated before react-server-dom-turbopack/client.browser: it provides the module loader
// globals the Flight client calls. Client component chunks are ES modules addressed by URL.
const modules = new Map<string, unknown>();
const loading = new Map<string, Promise<void>>();
const globals = globalThis as Record<string, unknown>;

globals.__turbopack_load_by_url__ = (url: string): Promise<void> => {
    let promise = loading.get(url);
    if (!promise) {
        promise = import(/* @vite-ignore */ url).then((module: unknown) => {
            modules.set(url, module);
        });
        loading.set(url, promise);
    }
    return promise;
};

globals.__turbopack_require__ = (id: string): unknown => {
    const module = modules.get(id);
    if (!module) throw new Error(`[tyvo] client module "${id}" was required before it was loaded.`);
    return module;
};

export {};
