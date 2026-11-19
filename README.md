# Tyvo

A TypeScript-only, file-system routed web framework for Node.js — typed API routes, guards and middlewares, zod validation,
rate limiting and React Server Component pages, with **no hidden defaults**: every setting lives in your `config.ts`.

```bash
npm install -g @tyvo/core
tyvo init my-app
cd my-app
npm run dev
```

## Features

- **File-system routing** — `src/app/users/[id]/route.ts` is `/users/:id`. Dynamic, catch-all, optional catch-all,
  route groups `(group)` and private folders `_private`.
- **Typed routes** — `route()` validates params, query, body, headers and cookies with zod; the handler's `request`
  is typed from the schemas and from what each middleware adds. URL strings are converted strictly per schema
  (unions included; `042`, `0x2A`, `1`/`0` for booleans are rejected, not guessed).
- **Typed paths end to end** — params are typed from the folder (`route` / `page` / `PageProps` from the generated
  `"./$types"` of each folder) and converted by `paramSchema` / `querySchema` in routes and pages alike;
  `<Link href>`, `router.push()` and `redirect()` only accept URLs a page serves; `href()` builds them;
  `api()` from `@tyvo/core/client` calls route.ts endpoints with their request and response types (like tRPC / Hono RPC).
- **Guards, middlewares and modifiers** — composable, typed, run at most once per request (`requires` declares
  dependencies). Guards (authentication, permissions) run before the body is read and the schemas, so a rejected
  request costs no parsing and learns nothing about them; middlewares run after the schemas and see the validated
  request; modifiers post-process responses.
- **`proxy.ts`** — wraps every `route.ts` below its folder (like a layout, but for API routes only) with guards, middlewares
  and modifiers; what they add is typed in the routes.
- **Response validation** — `route({ responseSchema })` types and checks what a handler sends.
- **React Server Components** — `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`,
  `"use client"` components, server actions (`"use server"`), metadata, CSS / CSS Modules and asset imports.
- **Prerendering and revalidation** — `export const prerender = true`, `staticParams()`, `revalidate`, plus a
  tagged data `cache()` with `revalidateTag()` / `revalidatePath()`.
- **Security built in** — rate limiting (pluggable storage), CORS, Content-Security-Policy with per-page nonces,
  signed cookies, server action origin checks.
- **Streaming** — `response.stream()` and server-sent events with `response.sse()`.
- **Pluggable logging** — a pipeline of loggers to filter, rewrite or forward entries; `nextLogger()` prints
  Next.js-style output.
- **In-memory testing** — `@tyvo/core/testing` calls the app without a server or port, from any test runner.
- **Generated checks** — every Tyvo rule is generated into `.tyvo/types/check.ts` as plain TypeScript, so any editor,
  `tsc` and CI report broken conventions with no plugin or editor setup.

## Requirements

- Node.js **18.17** or newer
- TypeScript 5+
- React 19 (`react`, `react-dom`, `react-server-dom-turbopack`) for pages — optional for API-only projects

## Getting started

Install the CLI globally once:

```bash
npm install -g @tyvo/core
tyvo -v                          # check the installed version
```

Then create a project:

```bash
tyvo init my-app                 # scaffold and run npm install
tyvo init my-app --example       # also add example routes, pages, middlewares and server actions
tyvo init                        # scaffold into the current directory
```

The project also gets `@tyvo/core` as a local dependency, so `npm run dev` / `build` / `start` use the version
pinned in its `package.json`, not the global one.

The generated project has its own `TYVO.md` — the full guide to routing, pages, config, logging and testing
(source: [templates/base/TYVO.md](templates/base/TYVO.md)).

```
config.ts            every framework setting (all exports required)
.env.local           secrets for this machine (git-ignored)
public/              files served as-is at the site root
src/
  app/               routes and pages — the folder structure is the URL structure
  guards/            guard() definitions
  middlewares/       middleware() definitions
  lib/               shared server code
  components/        React components
```

`@/` points to `src/`. Only `.ts` and `.tsx` files are allowed in `src/app/`.

## Examples

### API route

```ts
// src/app/api/users/[id]/route.ts
import { z } from "@tyvo/core";
import { webAuth } from "@/guards";
import { route } from "./$types";            // generated for this folder: request.params is { id: string }

export const PATCH = route({
    guards: [webAuth],                       // before the body is read and the schemas run
    paramSchema: z.object({ id: z.union([z.number(), z.literal("me")]) }), // /api/users/42 or /api/users/me
    bodySchema: z.object({ name: z.string().min(1) }),
    ratelimit: { timeWindow: 10_000, max: 5 },
    handler: async (request, response) => {
        return response.json({ id: request.params.id, name: request.body.name, by: request.user.name });
    },
});
```

A plain `(request: Request) => Response` export works too. `"./$types"` is generated for every folder with a route,
page or layout: its `route` / `page` already know the folder, so params (and what proxies add) are typed and a wrong
`paramSchema` key is an error right there. A `proxy.ts` next to (or above) route files wraps them all:

```ts
// src/app/api/users/proxy.ts — every route.ts in src/app/api/users/ and below
export default proxy({ guards: [webAuth], modifiers: [noStore] });
```

Call a route from anywhere with its types:

```ts
import { api } from "@tyvo/core/client";

const result = await api("/api/users/[id]").PATCH({ params: { id: 42 }, body: { name: "Ada" } });
if (result.ok) result.data.name; // string — what the handler returns
```

### Guard and middleware

```ts
// src/guards/index.ts — runs before the body is read and the schemas: no body here (a type error)
import { guard } from "@tyvo/core";

export const webAuth = guard({
    handler: async (request, response) => {
        const session = await findSession(request.cookies.get("sid"));
        if (!session) return response.status(401).json({ error: "Unauthorized" }); // ends the request
        return response.proceed({ user: session.user });                           // passed on; typed below
    },
});
```

Every path returns: a `TyvoResponse` ends the request, `response.proceed(added)` passes it on. A path without a
return is a type error; a response made but not returned (`if (!user) response.status(401)...` then `proceed()`) fails
closed with a 500 instead of letting the request through. `middleware()` is the same, but runs after the schemas and sees the validated request (body included).

### Page

```tsx
// src/app/users/[id]/page.tsx
import { notFound } from "@tyvo/core";
import { page } from "./$types";

export default page({
    loader: async (request) => {
        const user = await db.users.find(request.params.id);
        if (!user) notFound();
        return { user };
    },
    metadata: ({ user }) => ({ title: user.name }),
    component: ({ user }) => <h1>{user.name}</h1>,
});
```

Client-side navigation comes from `@tyvo/core/router`: `Link`, `router.push()`, `href()`, `usePathname()`, `useParams()`,
`useQuery()`, `useSearchParams()`, `useNavigation()`. Link targets (and `redirect()`) are checked against the app's pages
segment by segment: a literal must be a URL a page serves, anything computed must come from `href()`
(`router.push(href("/users/[id]", { id }))`), which takes the page's `paramSchema` / `querySchema` input types.
The route types are generated into `.tyvo/types/` by `tyvo dev`, `build`, `check` and `typegen`.

### Testing

```ts
import { buildTestClient } from "@tyvo/core/testing";

const client = await buildTestClient();
const res = await client.post("/api/session", { body: { name: "kim" } });
expect(res.status).toBe(201);
```

## Configuration

Tyvo has no implicit defaults. `config.ts` must export every one of these (the generated checks and `tyvo check`
enforce it); `tyvo init` generates sensible values, spelled out in the file. Settings are values; the hooks Tyvo
calls per request (`getIp`, `onError`, `defaultRatelimit.key`) are functions:

| Export | Purpose |
|---|---|
| `defaultParser` | request body parser, e.g. `bodyParser({ limit })` |
| `defaultRatelimit` | `{ timeWindow, max, key }` for every endpoint, or `false`; `key(request, { pattern })` picks the bucket |
| `ratelimitStorage` | where rate-limit counters live (`memoryStorage()` or your own) |
| `cacheStorage` | where `cache()` results live (`memoryCache()` or your own, e.g. Redis) |
| `defaultCORS` | CORS for every endpoint, or `false` |
| `defaultCSP` | Content-Security-Policy, with a per-page nonce |
| `defaultCookie` | options for `request.cookies.set()` |
| `cookieSecret` | key for signed cookies |
| `serverActions` | body limit and allowed origins for server actions |
| `getIp(request, socketIp)` | `request.ip`; must return an IP (`normalizeIp`, `isIp` help) |
| `onError(error, request, response)` | turns every error into a response |
| `port` | port to listen on |
| `trailingSlash` | `/users/7/`: 308 to `/users/7`, 404, or served too |
| `server` | hostname, timeouts and header size limit of the HTTP server |
| `staticCacheControl` | Cache-Control of `public/` files and build assets |
| `prefetch` | how long prefetched pages stay usable |
| `loggers` | log pipeline |

Environment files are loaded in this order (real environment variables always win):
`.env.<mode>.local` > `.env.local` > `.env.<mode>` > `.env`.

## CLI

```
tyvo init [dir]   Scaffold a new project (--example, --no-install, --force)
tyvo dev          Development server; rebuilds and updates open pages on change
tyvo build        Type-check, bundle into .tyvo/ and prerender static pages (--no-check, --minify)
tyvo start        Run the production build
tyvo check        Type-check and validate src/app/ and config.ts
tyvo typegen      Write the route types (.tyvo/types/) without building
```

`dev` and `start` accept `--port <n>` (overrides `PORT` and `config.ts`).

## Editor support (generated checks, no plugin)

Tyvo's rules are plain TypeScript. `tyvo dev`, `build`, `check` and `typegen` write `.tyvo/types/` from `src/app/`
(the project's `tsconfig.json` includes it):

- `src/app/<folder>/$types.ts` — imported as `"./$types"` from that folder (tsconfig `rootDirs` maps it): `route`,
  `page`, `Params`, `PageProps`, `LayoutProps` bound to the folder. Mistakes in typed code (params, `paramSchema` keys,
  `responseSchema`, proxy additions) are errors right in your file.
- `routes.d.ts` — every route and page as a typed path (`href()`, `<Link>`, `api()`) and the `proxy.ts` files around
  each route.
- `check.ts` — what no type in your file can express, one line per rule: `"ok"` or a type error whose message names
  the file and what to change — exports a file may not have (`export const UNKNOWN` in a route.ts), a missing default
  export, prerender exports, `config.ts` settings, files that may not live in `src/app/`, route/page conflicts,
  `"use client"` in pages.

Any editor, `tsc` and CI see these errors without setup. The generated `.vscode/settings.json` turns on
`typescript.tsserver.experimental.enableProjectDiagnostics`, so VS Code lists them in the Problems panel without
opening `check.ts` (in a multi-root `.code-workspace`, set it in the workspace file). `tyvo dev` also prints the
file-system ones on every rebuild. Projects from earlier versions lose the old `plugins` entry automatically.

## Package entry points

| Import | Contents |
|---|---|
| `@tyvo/core` | `route`, `guard`, `middleware`, `modifier`, `page`, `href`, `cache`, `redirect`, `notFound`, `HttpError`, `bodyParser`, `memoryStorage`, `nextLogger`, `z`, types |
| `@tyvo/core/router` | client navigation: `Link`, `router`, `href`, hooks |
| `@tyvo/core/client` | `api()` / `createApi()`: typed calls to route.ts endpoints |
| `@tyvo/core/link` | `Link` only |
| `@tyvo/core/testing` | `buildTestClient`, `createTestClient` |
| `@tyvo/core/server` | low-level server/handler APIs used by the build output |
| `@tyvo/core/assets` | type declarations for CSS, CSS Module and asset imports |

## Developing Tyvo

```bash
npm install
npm run build        # tsup → dist/
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit, and templates/ as a generated project would see them
npm run release -- [patch|minor|major|<version>] [--dry-run]
```

Source layout:

```
src/
  index.ts, route.ts, page.ts, ...   public API (@tyvo/core)
  cli/                               tyvo CLI: init, dev, build, start, check, project templates
  server/                            HTTP handler, router, static/prerendered pages
  react/                             RSC, SSR and browser runtimes; client router
  checks.ts                          the app/ rules as types (used by the generated .tyvo/types/check.ts)
  testing/                           in-memory test client
  shared/                            conventions shared by the CLI, the server and the browser
templates/base/                      files of a new project (tyvo init); TYVO.md is the guide
templates/example/                   copied over base/ by tyvo init --example
templates/tsconfig.json              type-checks both (npm run typecheck); not published
```

## License

MIT
