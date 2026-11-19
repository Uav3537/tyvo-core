import { guard } from "@tyvo/core";

const sessions: Record<string, { user: { id: string; name: string } }> = {
    secret: { user: { id: "1", name: "tyvo" } },
};

// Guards run before the body is read and before any schema: a request they reject costs no parsing and learns
// nothing about the route. They see headers, cookies and the raw params/query, but no body (a type error).

/** Reads the session. response.proceed(added) passes the request on with `added` in it (typed) for what follows. */
export const parseAuth = guard({
    handler: async (request, response) => {
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        return response.proceed({ session: sessions[token] ?? null });
    },
});

/** `requires` runs parseAuth first, so `request.session` is guaranteed here. */
export const webAuth = guard({
    requires: [parseAuth],
    handler: async (request, response) => {
        if (!request.session) {
            // Returning a TyvoResponse ends the request here, before the body is read.
            return response.status(401).json({ error: "Unauthorized" });
        }
        // Every path returns. Had the `return` above been forgotten, the 401 made there fails the request (500)
        // instead of letting it through.
        return response.proceed({ user: request.session.user });
    },
});
