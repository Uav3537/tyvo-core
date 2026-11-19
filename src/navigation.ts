import { hrefString, type CheckHref } from "./routes.js";

// redirect() / notFound(): thrown from server code (page loaders, server components, route handlers, server actions)
// and recognised by their `digest`, which React forwards from the server to the client unchanged.

const REDIRECT = "TYVO_REDIRECT";
const NOT_FOUND = "TYVO_NOT_FOUND";

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

export type Navigation = { kind: "redirect"; url: string; status: RedirectStatus } | { kind: "not-found" };

export class NavigationError extends Error {
    override name = "NavigationError";
    constructor(
        message: string,
        readonly digest: string,
    ) {
        super(message);
    }
}

/**
 * Stops rendering and redirects. In pages it becomes an HTTP redirect, during client navigation a router.replace().
 * The target is checked like `<Link href>`: a page of the app (a literal, or built with `href()`), `#hash`, an absolute
 * URL literal, or a `URL` object for external addresses built at runtime.
 */
export function redirect<const H extends string>(url: CheckHref<H> | URL, status: RedirectStatus = 307): never {
    const target = hrefString(url);
    throw new NavigationError(`Redirect to ${target}`, `${REDIRECT};${status};${target}`);
}

/** Stops rendering and shows the nearest `not-found.tsx` (HTTP 404). In route() handlers it becomes a 404 through onError. */
export function notFound(): never {
    throw new NavigationError("Not found", NOT_FOUND);
}

/** Reads a redirect()/notFound() back from an error or its digest. */
export function readNavigation(error: unknown): Navigation | undefined {
    const digest = typeof error === "string" ? error : (error as { digest?: unknown } | null)?.digest;
    if (typeof digest !== "string") return undefined;
    if (digest === NOT_FOUND) return { kind: "not-found" };
    if (digest.startsWith(REDIRECT + ";")) {
        const [, status, ...url] = digest.split(";");
        return { kind: "redirect", status: Number(status) as RedirectStatus, url: url.join(";") };
    }
    return undefined;
}
