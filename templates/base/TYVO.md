# {{name}} — Tyvo guide

Tyvo is a TypeScript-only web framework: file-system routing for APIs and React Server Component pages,
typed guards and middlewares, zod validation, and **no hidden defaults** — every setting lives in `config.ts`.

```
npm run dev      # development server; rebuilds and updates open pages on every change
npm run build    # type-check (tyvo check), bundle into .tyvo/ and prerender static pages
npm run start    # run the production build
npm run check    # type-check and validate the Tyvo conventions only
```

## Project structure

```
.tyvo/               build output (generated, git-ignored)
TYVO.md              this guide
config.ts            every framework setting (required, all exports required)
.env.local           secrets for this machine (git-ignored)
public/              optional: files served as-is at the site root (robots.txt, favicon.ico)
src/
  app/               routes and pages — the folder structure is the URL structure
    layout.tsx       root layout: <html> and <body>
    page.tsx         "/"
    not-found.tsx    404 page
    globals.css      site-wide styles (imported by layout.tsx)
  guards/            guard() definitions (authentication, permissions)
  middlewares/       middleware() definitions
  lib/               shared server code (database, services, ...)
  components/        React components
```

Files in `public/` are served at the site root (`public/robots.txt` is `/robots.txt`), streamed from disk with
`ETag` / `Last-Modified` (browsers revalidate and get `304 Not Modified`) and byte ranges (`206`, for video and audio
seeking). Routes and pages are matched first, so a public file whose URL a route or page also serves (e.g.
`public/users/me.png` next to `src/app/users/[id]/page.tsx`) would never be sent: `tyvo check` reports it.

`@/` points to `src/`: `import { webAuth } from "@/guards"`.

Only `.ts` and `.tsx` are allowed. JavaScript files inside `src/app/` fail the build.

`src/app/` only holds `route.ts`, `proxy.ts`, `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx` and `*.css`
(`globals.css`, `*.module.css`). Any other file there is an error — put it in `src/lib/`, `src/components/` or a
`_private` folder.

## Routing

| File | Meaning |
|---|---|
| `src/app/users/route.ts` | API endpoint `/users` (exports `GET`, `POST`, ...) |
| `src/app/users/page.tsx` | page `/users` |
| `src/app/users/[id]/...` | dynamic segment, `params.id` |
| `src/app/docs/[...slug]/...` | catch-all, `params.slug: string[]` |
| `src/app/shop/[[...slug]]/...` | optional catch-all |
| `src/app/(group)/...` | folder ignored in the URL |
| `src/app/_private/...` | not routed |
| `proxy.ts` | wraps every `route.ts` below it: guards and middlewares before, modifiers after (pages are not affected) |
| `layout.tsx` | wraps every page below it |
| `loading.tsx` | shown while a page below it is rendering (Suspense) |
| `error.tsx` | client component (`"use client"`) shown when rendering below it throws |
| `not-found.tsx` | shown by `notFound()` and for unknown URLs (404) |

A folder can have a `route.ts` or a `page.tsx`, not both.

## API routes

A route export is any `(request: Request, context) => Response`:

```ts
// src/app/api/hello/route.ts
export function GET(request: Request) {
    return Response.json({ hello: "world" });
}
```

`route()` adds rate limiting, guards, body parsing, validation, middlewares and modifiers:

```ts
// src/app/api/users/[id]/route.ts
import { z } from "@tyvo/core";
import { webAuth } from "@/guards";
import { auditTrail } from "@/middlewares";
import { route } from "./$types";                    // route() bound to this folder (generated)

export const PATCH = route({
    guards: [webAuth],                                // before the body is read and the schemas run
    middlewares: [auditTrail],                        // after the schemas: they see the validated request
    paramSchema: z.object({ id: z.union([z.number(), z.literal("me")]) }), // /api/users/42 or /api/users/me
    querySchema: z.object({ dryRun: z.boolean().default(false) }),
    bodySchema: z.object({ name: z.string().min(1) }),
    ratelimit: { timeWindow: 10_000, max: 5 },        // overrides fields of defaultRatelimit
    cors: { origin: ["https://app.example.com"] },    // overrides defaultCORS
    handler: async (request, response) => {
        // every field below is typed from the schemas, guards and middlewares
        return response.json({ id: request.params.id, name: request.body.name, by: request.user.name });
    },
});
```

- `"./$types"` is generated for every folder with a route.ts, page.tsx or layout.tsx (into `.tyvo/types/`; tsconfig's
  `rootDirs` and the build resolve it). Its `route` and `page` know the folder: `request.params` is typed from the path
  (`{ id: string }`) without `paramSchema`, what the folder's `proxy.ts` guards and middlewares add is typed, and a `paramSchema`
  key that is not a segment of the folder is a type error right in the file. It also exports `Params`, `PageProps`
  and `LayoutProps` for the folder. (`route` from `@tyvo/core` works too, untyped params.)
- Query, params and cookies are strings in the request. Before validation each value is converted to what the schema
  expects at its place, strictly, so a value has one spelling: numbers are canonical decimals (`42`, `-1.5`; not
  `042`, `0x2A`, `4.2e1`, `1.50`), booleans `true`/`false` (not `1`/`0`), bigints integers, dates ISO 8601, and a single
  value becomes an array where one is expected. Unions, optional, default and literals are followed. Anything else
  stays a string and fails validation.

- The handler must return a `TyvoResponse`: `response.json()`, `.text()`, `.html()`, `.binary()`, `.redirect()`, `.empty()`,
  combined with `.status()` and `.header()`.
- `response.stream(source)` streams a `ReadableStream` or async iterable of strings/bytes;
  `response.sse(source, { keepAlive })` sends server-sent events (see below).
- Validation runs every schema; all failures come back together as one `400` with `issues`.
- Schemas: `bodySchema`, `querySchema`, `paramSchema`, `headerSchema`, `cookieSchema`, and `schema`
  (the rest of the request).
- `responseSchema` checks what the route sends: the handler must return the schema's input type (a type error
  otherwise), the JSON body of every 2xx response is parsed with it before it goes out (transforms apply), and a body
  that does not match is a 500 (logged with the issues). `api()` types `data` with its output. Send errors by throwing
  (`HttpError`, `notFound()`), not by returning another shape.
- Throw `new HttpError(status)`, `redirect(url)` or `notFound()` anywhere.

### Request

`request.method`, `url`, `headers` (plain object, lower-case names), `query` (plain object), `params`, `body`
(parsed by `defaultParser`), `cookies`, `ip` (from `getIp()` in config.ts), `signal`, `raw` (the Web `Request`).

### Cookies

```ts
request.cookies.get("theme");
request.cookies.set("session", { userId: 1 }, { signed: true, maxAge: 86_400 }); // JSON values; signed with cookieSecret
request.cookies.delete("old");
```

Changes are sent as `Set-Cookie` with the response. Options default to `defaultCookie` in config.ts.

### Streaming and server-sent events

```ts
import { setTimeout } from "node:timers/promises";
import { route } from "./$types";

// Read in the browser with new EventSource("/api/clock").
export const GET = route({
    handler: (request, response) =>
        response.sse(
            (async function* () {
                while (!request.signal.aborted) {
                    yield { event: "time", data: { now: Date.now() } }; // data: string as-is, anything else as JSON
                    await setTimeout(1000);
                }
            })(),
            { keepAlive: 15_000 },                       // ": keep-alive" comment while idle; default false
        ),
});
```

Events are `{ data, event?, id?, retry? }`. `content-type: text/event-stream` and `cache-control: no-cache` are set.
When the client disconnects, the generator is closed (its `finally` runs) and `request.signal` aborts.

## Proxies (`proxy.ts`)

A `proxy.ts` wraps every `route.ts` in its folder and the folders below it, the way a layout wraps pages — but for
routes only (pages are not affected). Use it for what a whole branch of the API shares: authentication, headers, logging.

```ts
// src/app/api/admin/proxy.ts
import { proxy } from "@tyvo/core";
import { webAuth, adminOnly } from "@/guards";
import { noStore } from "@/modifiers";

export default proxy({ guards: [webAuth, adminOnly], modifiers: [noStore] });
```

- Order for `src/app/api/admin/users/route.ts`: CORS, rate limit; the guards of `app/proxy.ts`, `app/api/proxy.ts`,
  `app/api/admin/proxy.ts` (outer first), then the route's own; body parsing and the route's schemas; the proxies'
  middlewares (outer first), then the route's own; the handler; the route's modifiers, then the proxies' (inner
  first). A guard or middleware listed by a proxy and the route runs once.
- A guard or middleware that returns a response ends the request there; the modifiers still run on it.
- Hand-written route functions are wrapped too (their `Response` goes through the modifiers).
- With `route` from `"./$types"`, what proxy guards and middlewares add is typed in the handler (`request.user` from `webAuth` above).
- Proxies follow folders, like layouts: one in `(group)/` wraps only that group.

## Guards and middlewares

Both run before the handler, and every path of their handler returns one of two things: a `TyvoResponse` ends the
request, `response.proceed(added)` passes it on with `added` merged into the request (typed for everything after;
`response.proceed()` adds nothing). A path that returns nothing is a type error, and a handler that makes a response
(`response.status(401).json(...)`) but then returns `proceed()` — a forgotten `return` — fails with a 500 instead of
passing the request on. They differ in **when** they run:

| | runs | sees | for |
|---|---|---|---|
| `guard()` in `guards` | before the body is read and any schema runs | headers, cookies, raw params/query (strings); **no body** (a type error) | authentication, permissions |
| `middleware()` in `middlewares` | after the schemas | the validated request | loading data, auditing, anything that needs the body |

A request a guard rejects costs no body parsing and never gets a 400 describing the schemas.

```ts
// src/guards/index.ts
import { guard } from "@tyvo/core";

export const parseAuth = guard({
    handler: async (request, response) => response.proceed({ session: await findSession(request.cookies.get("sid")) }),
});

export const webAuth = guard({
    requires: [parseAuth],                            // runs first; request.session is guaranteed below
    handler: async (request, response) => {
        if (!request.session) return response.status(401).json({ error: "Unauthorized" }); // ends the request
        return response.proceed({ user: request.session.user }); // passed on, with request.user (typed)
    },
});
```

```ts
// src/middlewares/index.ts
import { middleware, z } from "@tyvo/core";
import { webAuth } from "@/guards";

export const loadTeam = middleware({
    requires: [webAuth],                              // a guard that already ran is not run again
    bodySchema: z.object({ teamId: z.number() }),     // middlewares may validate too
    handler: async (request, response) => response.proceed({ team: await db.teams.find(request.body.teamId, request.user.id) }),
});
```

- `requires` of a guard lists guards; `requires` of a middleware lists middlewares or guards. Each runs at most once
  per request, however many list it.
- Pass only what you add (`proceed({ user })`). Every key is added, the request's own included: `proceed({ params })`
  replaces the params, with the type you passed. `proceed({ ...request, user })` would therefore replace every field
  with the type this handler saw (e.g. an unvalidated body).
- `response.proceed()` is not a response: a status or headers set on that builder are not sent, and a route handler
  cannot return it (a type error).
- `guards` and `middlewares` exist on `route()`, `page()` and `proxy()`; a guard in `middlewares` (or the opposite) is
  a type error.

## Modifiers

The opposite of a middleware: they run after the handler on the outgoing response.

```ts
import { modifier } from "@tyvo/core";
export const noStore = modifier({ handler: (request, response) => response.header("cache-control", "no-store") });
// route({ modifiers: [noStore], ... })
```

Every path returns the response to send: `response` itself to keep it, one made from it (`response.header(...)`) or a
new one to replace it. A path that returns nothing is a type error, so a `response.header(...)` without `return` is
caught instead of silently dropped.

## Pages (React Server Components)

```tsx
// src/app/users/[id]/page.tsx
import { notFound, z } from "@tyvo/core";
import { parseAuth } from "@/guards";
import { page } from "./$types";                     // page() bound to this folder: params is { id: string }

export default page({
    paramSchema: z.object({ id: z.number() }),        // /users/42 -> { id: 42 }; /users/abc -> not-found.tsx (404)
    querySchema: z.object({ tab: z.enum(["posts", "likes"]).default("posts") }),
    guards: [parseAuth],
    loader: async (request) => {
        const user = await db.users.find(request.params.id); // number
        if (!user) notFound();
        return { user, tab: request.query.tab };      // becomes the component's props (typed)
    },
    metadata: ({ user }) => ({ title: user.name }),
    component: ({ user, tab }) => <h1>{user.name} · {tab}</h1>,
});
```

- `paramSchema` / `querySchema` convert URL strings exactly like `route()`'s (strict numbers, booleans, dates...).
  Params that do not validate render the nearest `not-found.tsx` with 404 (the URL names nothing); an invalid query is
  a 400 through `onError`. Their outputs type `params` / `query` in the loader, the component, `metadata`,
  `useParams(path)` / `useQuery(path)`, and their inputs type what `href()` and literal links accept for the page.
  Outputs reach the browser (for the hooks), so keep them plain data (strings, numbers, booleans, dates, arrays, objects).
- Layouts always get the raw segments of their folder (`LayoutProps`): the schemas belong to the page.

A plain component works too: `export default async function Page({ params, query }: PageProps) { ... }` with
`import type { PageProps } from "./$types"` (`params` typed from the folder; `LayoutProps` likewise for layout.tsx).

- Pages and layouts are server components: they run only on the server and can be `async`.
- Add `"use client"` at the top of a component file to make it interactive (state, effects, events).
- `export const metadata` / `export async function generateMetadata({ params, query })` in layouts and pages
  set `<title>` and `<meta>`. A layout's `title: { default, template: "%s | Site" }` wraps the titles below it.
- CSS: `import "./globals.css"` (added to every page) or CSS Modules `import styles from "./x.module.css"`.
- Assets: `import logo from "./logo.png"` gives a URL.

### Navigation (client components)

```tsx
"use client";
import { href, Link, router, usePathname, useParams, useQuery, useSearchParams, useNavigation } from "@tyvo/core/router";

<Link href="/users/1">User 1</Link>                    // prefetches on hover
router.push(href("/users/[id]", { id: 2 }, { query: { tab: "likes" } })); // also replace, back, forward, refresh, prefetch
const { id } = useParams("/users/[id]");              // id: number (the page's paramSchema output)
const { tab } = useQuery("/users/[id]");              // tab: "posts" | "likes"
const raw = useParams();                               // raw segments of whatever page is shown
```

Every link target — `<Link href>`, `router.push/replace/prefetch`, `redirect()` and `response.redirect()` — is checked
against the app's pages:

- A **literal** must be a URL some page serves: `"/users/1"`, `"/users/1?tab=a#top"`. Each segment is checked, so
  `"/users/1/2"`, `"/users/"` or `"/nope"` are type errors.
- A **computed** URL must come from `href(path, params, { query, hash })` (from `@tyvo/core` in server code,
  `@tyvo/core/router` in client components): a plain `string` is a type error. For a page with schemas, `href()` takes
  their input types (`{ id: number }`, and `query` is required when the schema has required keys).
- `"#top"` and absolute URL literals (`https://...`, `mailto:`) are fine; an external address built at runtime is passed
  as a `URL` object: `redirect(new URL(authorizeUrl))`.

`useParams(path)` / `useQuery(path)` name the page they are used on and throw when another page is shown (a mistake the
types cannot see); components that render on several pages call them without a path (raw strings) or take props.

The routes come from `.tyvo/types/`, which `tyvo dev`, `build`, `check` and `typegen` write from `src/app/`.

### Typed API client

```ts
import { api, createApi } from "@tyvo/core/client";

const result = await api("/api/users/[id]").PATCH({ params: { id: 42 }, body: { name: "Ada" } });
if (result.ok) result.data.name;                      // typed from the route's handler: response.json({ ... })
else result.status;                                   // errors (400 with issues, 401, ...) as onError sends them

const server = createApi({ baseUrl: "http://localhost:3000" }); // absolute URLs outside the browser
```

Paths, methods, params, `query` and `body` are checked — params, query and body take the route's schemas' input types
(`params: { id: number | "me" }` for a `paramSchema` like the one above); `data` is what the handler returns.

### Prerendering (static pages)

```tsx
// src/app/blog/[slug]/page.tsx
import type { StaticParams } from "@tyvo/core";
import { page } from "./$types";

export const prerender = true;   // rendered by `tyvo build`, served as built
export const revalidate = 3600;  // optional: regenerate in the background when older than this (seconds)

// Required for dynamic segments: the pages to generate. Other slugs are rendered per request as usual.
export async function staticParams(): Promise<StaticParams> {
    return (await db.posts.all()).map((post) => ({ slug: post.slug }));
}

export default page({ loader: async (request) => ({ post: await getPost(request.params.slug) }), component: ... });
```

- Guards, middlewares and the loader run at build time with a request for `http://localhost/<path>` (no cookies, no query,
  no rate limit). Do not prerender pages that depend on who is asking.
- A prerendered page may render (200), call `notFound()` (404) or redirect; anything else fails the build.
- Each response still gets a fresh CSP nonce. `tyvo dev` never prerenders.
- Regenerated pages live in memory; a restart serves the build's version until it is revalidated again.

### Data cache

```ts
// src/lib/posts.ts
import { cache } from "@tyvo/core";

export const getPost = cache(async (slug: string) => db.posts.find(slug), {
    key: "posts.get",                  // names these results in cacheStorage: unique and stable
    revalidate: 60,                    // seconds a result stays fresh, or false
    tags: (slug) => ["post:" + slug],  // optional
});
```

```ts
import { revalidatePath, revalidateTag } from "@tyvo/core";
await revalidateTag("post:" + slug); // drops tagged results and regenerates prerendered pages that read them
await revalidatePath("/about");      // regenerates one prerendered page
```

Results are cached per arguments (compared as JSON) in `cacheStorage` from config.ts. `memoryCache()` keeps them in
the memory of one server process; with several instances, export a shared storage (Redis, a database, ...) so every
instance sees the same results and `revalidateTag()` drops them everywhere. A shared storage must serialize the values.
Prerendered pages are regenerated only by the instance that calls `revalidateTag()` / `revalidatePath()`.
`getPost.invalidate(slug)` and `getPost.clear()` drop one or all results of a function.

## Server actions

```ts
// src/lib/likes.ts
"use server";
export async function like(postId: number): Promise<number> { ... }
```

Import and call it from a client component; it runs on the server. Arguments and results must be serializable.
The current page is re-rendered after each action. Configure limits in `serverActions` (config.ts).

## config.ts

Every export is required; the generated checks and `tyvo check` enforce it. The generated values are the defaults: nothing is
decided behind your back. Settings are values; the hooks Tyvo calls per request (`getIp`, `onError`,
`defaultRatelimit.key`) are functions.

| Export | Purpose |
|---|---|
| `defaultParser` | request body parser, e.g. `bodyParser({ limit })` |
| `defaultRatelimit` | `{ timeWindow, max, key }` for every endpoint, or `false`; `key(request, { pattern })` picks the bucket |
| `ratelimitStorage` | where rate-limit counters live (`memoryStorage()` or your own get/set) |
| `cacheStorage` | where `cache()` results live (`memoryCache()` or your own get/set/delete/deleteTag) |
| `defaultCORS` | CORS for every endpoint, or `false` |
| `defaultCSP` | Content-Security-Policy, with a per-page nonce |
| `defaultCookie` | options for `request.cookies.set()` |
| `cookieSecret` | key for signed cookies (from `.env.local`) |
| `serverActions` | body limit and allowed origins for server actions |
| `getIp(request, socketIp)` | `request.ip`; must return an IPv4/IPv6 address (`normalizeIp`, `isIp` help) |
| `onError(error, request, response)` | turns every error (including 400/404/405/413/429) into a response |
| `port` | port to listen on (`PORT` and `--port` take precedence) |
| `trailingSlash` | a route or page URL ending in `/`: `"redirect"` (308 to the URL without it), `"strict"` (404) or `"ignore"` (served too) |
| `server` | hostname (`HOST` takes precedence), request/headers/keep-alive timeouts and header size limit |
| `staticCacheControl` | Cache-Control of `public/` files and build assets in production |
| `prefetch` | how long a page prefetched by `<Link>` / `router.prefetch()` stays usable |
| `loggers` | functions every log entry runs through (requests, ready, warnings, errors) |

### Logging

Every log line goes through `loggers`, in order, like middlewares. A logger returns nothing to pass the entry on,
a changed entry to replace it for the loggers after it, or `false` to drop it:

```ts
export const loggers: Logger[] = [
    (entry) => (entry.type === "request" && entry.path.startsWith("/health") ? false : undefined), // filter
    (entry) => (entry.type === "request" ? { ...entry, path: entry.path.split("?")[0]! } : undefined), // rewrite
    nextLogger({ colors: !!process.stdout.isTTY, requests: process.env.NODE_ENV === "development", internalRequests: false }),
    (entry) => void sendToLogService(entry),                                    // forward (async is fine)
];
```

Entries (`LogEntry`, all with `level` and `time`):

| `type` | When | Fields |
|---|---|---|
| `"request"` | each response is ready | `method`, `path`, `status`, `duration`, `ip`, `kind`, `pattern`, `action`, `prerendered`, `request` |
| `"ready"` | the server listens | `url`, `version`, `dev`, `restart`, `duration`, `envFiles`, `routes` |
| `"message"` | warnings and errors (a throwing handler, a failed render, ...) | `message`, `error?`, `request?` |

`nextLogger()` prints them like Next.js (` GET /users/1 200 in 23ms`, ` ✓ Ready in 412ms`, ` ⨯ Error: ...`).
Errors a handler throws are logged before `onError` turns them into the response; `HttpError`s are not logged.

## Environment variables

Loaded into `process.env` by `tyvo dev` (mode `development`) and `tyvo build` / `tyvo start` (mode `production`):

```
.env.<mode>.local  >  .env.local  >  .env.<mode>  >  .env      (real environment variables always win)
```

`.env*.local` files are git-ignored; keep secrets there.

## Testing

`@tyvo/core/testing` calls the app in memory — no server, no port — with any test runner:

```ts
import { buildTestClient } from "@tyvo/core/testing";

const client = await buildTestClient();              // builds like `tyvo build` into .tyvo/test/ (once per file)

const created = await client.post("/api/session", { body: { name: "kim" } }); // objects are sent as JSON
expect(created.status).toBe(201);
expect(client.cookies.get("session")).toBeDefined(); // Set-Cookie is kept for the next requests

const page = await client.get("/users/1", { headers: { accept: "text/html" }, query: { tab: "posts" } });
expect(await page.text()).toContain("User 1");
```

- Loads `.env.test.local`, `.env.local`, `.env.test`, `.env` first. `{ prerender: true }` serves prerendered pages as
  `tyvo start` does. Every response is a standard `Response`.
- `createTestClient({ config, routes: { "src/app/api/hello/route.ts": await import("...") } })` skips the build for
  route modules your runner already loaded (e.g. Vitest); pages need `buildTestClient()`.

## Editor

Tyvo's rules are plain TypeScript, no plugin: `tyvo dev`, `build`, `check` and `typegen` write `.tyvo/types/check.ts`,
where every rule is a line that is `"ok"` or a type error naming the file and what to change (invalid route exports,
a missing default export, prerender exports, `config.ts` settings, files that may not live in
`src/app/`, route/page conflicts, `"use client"` in pages, ...). `.vscode/settings.json` turns on project diagnostics,
so VS Code shows them in the Problems panel without opening the file; `tsc` and CI report them too, and `tyvo dev`
prints the file-system ones on every rebuild. Run `tyvo typegen` after adding files while `tyvo dev` is not running.
