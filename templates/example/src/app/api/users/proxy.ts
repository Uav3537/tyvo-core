import { proxy } from "@tyvo/core";
import { webAuth } from "@/guards";
import { noStore } from "@/modifiers";

// Wraps every route.ts in src/app/api/users/ and below (pages are not affected), like a layout wraps pages.
// Its guards run before each route reads the body or validates anything (an unauthenticated request gets 401, never
// a 400 describing the schemas); its modifiers run after the route's own. The routes see what webAuth adds
// (request.user) in their types.
export default proxy({
    guards: [webAuth],
    modifiers: [noStore],
});
