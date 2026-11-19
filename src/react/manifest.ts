/** Written by `tyvo build` to `.tyvo/react-manifest.json`. */
export interface ReactManifest {
    /** Changes with every build; the dev server uses it to tell the browser something changed. */
    build: string;
    /** URL of the browser runtime (bootstrap module). */
    runtime: string;
    /** Client component module id (project-relative path) -> browser chunk URL. */
    clients: Record<string, string>;
    /** Stylesheets imported anywhere in the app (server and client components). */
    css: string[];
}

export const RSC_HEADER = "x-tyvo-rsc";
export const RSC_CONTENT_TYPE = "text/x-component";
export const STATIC_PREFIX = "/_tyvo/static/";
export const ACTION_PATH = "/_tyvo/action";
export const ACTION_HEADER = "x-tyvo-action";
export const DEV_PATH = "/_tyvo/dev";
