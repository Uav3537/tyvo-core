import { z } from "@tyvo/core";
import { auditTrail } from "@/middlewares";
import { logErrors } from "@/modifiers";
// route() bound to this folder (generated): request.params is typed from /api/users/[id], and so is what
// ../proxy.ts adds (request.user from its webAuth guard, which also handles authentication and no-store for every route here).
import { route } from "./$types";

const User = z.object({ id: z.string(), name: z.string() });

export const GET = route({
    // Overrides only these fields of defaultCORS in config.ts.
    cors: { origin: ["http://localhost:5173"], credentials: true },
    // What this route sends: the handler must return it (a type error otherwise) and it is checked before it goes out.
    responseSchema: z.object({ id: z.string(), viewer: User }),
    handler: async (request, response) => {
        return response.json({ id: request.params.id, viewer: request.user });
    },
});

export const PATCH = route({
    middlewares: [auditTrail],
    modifiers: [logErrors],
    ratelimit: { timeWindow: 10_000, max: 5 },
    // Every schema is checked with safeParse; all failures come back together as one 400 with the issues.
    // On success the outputs replace the fields and are typed: request.params.id is a number here.
    // Query values are strings in the URL and are converted strictly to what the schema expects
    // (?dryRun=true&version=2; "1", "02" or "2e0" are rejected, not guessed).
    querySchema: z.object({ dryRun: z.boolean().default(false), version: z.number().int().optional() }),
    headerSchema: z.object({ "content-type": z.string().startsWith("application/json") }),
    // Path segments: its keys must be segments of this folder's path (a type error otherwise). /api/users/me works too.
    paramSchema: z.object({ id: z.union([z.number().int().positive(), z.literal("me")]) }),
    bodySchema: z.object({ name: z.string().min(1).max(50) }),
    handler: async (request, response) => {
        const id = request.params.id === "me" ? Number(request.user.id) : request.params.id;
        return response.json({ id, name: request.body.name, dryRun: request.query.dryRun, version: request.query.version, by: request.user.name, at: request.audit.at });
    },
});
