import { z } from "@tyvo/core";
import { route } from "./$types";

// Cookies live on the request: request.cookies.set()/delete() become Set-Cookie on the response.
export const POST = route({
    bodySchema: z.object({ name: z.string().min(1) }),
    handler: (request, response) => {
        // Any JSON-serializable value; signed with cookieSecret from config.ts (a tampered value reads as undefined).
        request.cookies.set("session", { name: request.body.name, since: Date.now() }, { signed: true, maxAge: 60 * 60 * 24 });
        request.cookies.set("visits", 1);
        return response.status(201).json({ ok: true });
    },
});

export const GET = route({
    // Validated like the query (strings are converted): request.cookies.get("visits") is a number here.
    cookieSchema: z.object({
        session: z.object({ name: z.string(), since: z.number() }).optional(),
        visits: z.number().int().default(0),
    }),
    handler: (request, response) => {
        const visits = request.cookies.get("visits") + 1;
        request.cookies.set("visits", visits);
        return response.json({ session: request.cookies.get("session") ?? null, visits });
    },
});

export const DELETE = route({
    handler: (request, response) => {
        request.cookies.delete("session");
        request.cookies.delete("visits");
        return response.empty();
    },
});
