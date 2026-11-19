import { z } from "@tyvo/core";
import { parseAuth } from "@/guards";
import { Counter } from "@/components/counter";
// page() bound to this folder (generated): params are typed from /users/[id], here converted by paramSchema.
import { page } from "./$types";

// page() adds guards, middlewares, rate limiting, a typed loader and metadata in front of the component.
export default page({
    guards: [parseAuth],
    // Merged over defaultCSP in config.ts: only img-src changes for this page.
    csp: { directives: { "img-src": ["'self'", "data:", "https://avatars.githubusercontent.com"] } },
    // /users/42 -> { id: 42 }. /users/abc or /users/101 do not validate: app/not-found.tsx renders with 404.
    paramSchema: z.object({ id: z.number().int().min(0).max(100) }),
    loader: async (request, response) => {
        const { id } = request.params; // number
        if (id === 0) return response.redirect("/");
        return { id, viewer: request.session?.user.name ?? "guest" };
    },
    metadata: ({ id }) => ({ title: "User " + id }),
    component: ({ id, viewer }) => (
        <div className="container stack">
            <h1>User {id}</h1>
            <p className="muted">Viewed by {viewer}</p>
            <Counter initial={id} />
        </div>
    ),
});
