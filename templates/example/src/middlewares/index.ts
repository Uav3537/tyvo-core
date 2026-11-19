import { middleware } from "@tyvo/core";
import { webAuth } from "@/guards";

/**
 * Middlewares run after the body is read and the route's schemas ran: they see the validated request.
 * `requires` may name guards too; one that already ran (here, in ../app/api/users/proxy.ts) does not run again.
 */
export const auditTrail = middleware({
    requires: [webAuth],
    handler: async (request, response) => response.proceed({ audit: { by: request.user.id, at: new Date().toISOString() } }),
});
