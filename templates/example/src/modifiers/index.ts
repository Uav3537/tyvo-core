import { modifier } from "@tyvo/core";

/** Modifiers run after the handler on the response about to be sent; every path returns the response to send. */
export const noStore = modifier({
    handler: (request, response) => response.header("cache-control", "no-store"),
});

/** `return response` sends it unchanged. */
export const logErrors = modifier({
    handler: (request, response) => {
        if (response.statusCode >= 400) console.warn(`[${request.method}] ${request.url.pathname} -> ${response.statusCode}`);
        return response;
    },
});
