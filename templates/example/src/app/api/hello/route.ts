// Route exports are plain (request: Request) => Response functions.
// Write them by hand for raw access, or use route() from "./$types" for parsing, validation, rate limiting and middlewares.
export function GET(request: Request) {
    const body = JSON.stringify({ hello: "tyvo", path: new URL(request.url).pathname });
    return new Response(body, { headers: { "content-type": "application/json" } });
}
