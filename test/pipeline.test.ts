// route(): the order of guards, body parsing, schemas, middlewares, handler and modifiers, and their contracts.
import { describe, expect, it } from "vitest";
import { HttpError, TyvoResponse, guard, middleware, modifier, notFound, proxy, redirect, route, z } from "../src/index.js";
import { app, json } from "./helpers.js";

const auth = guard({
    handler: (request, response) =>
        request.headers.authorization === "Bearer ok" ? response.proceed({ user: { id: 1, name: "ada" } }) : response.status(401).json({ error: "Unauthorized" }),
});

describe("guards run before the body and the schemas", () => {
    const client = () =>
        app({
            "/api/items": {
                POST: route({
                    guards: [auth],
                    bodySchema: z.object({ name: z.string().min(1) }),
                    handler: (request, response) => response.status(201).json({ name: request.body.name, by: request.user.name }),
                }),
            },
        });

    it("rejects without reading a malformed body", async () => {
        const response = await client().post("/api/items", { body: "{bad", headers: { "content-type": "application/json" } });
        expect(response.status).toBe(401);
    });

    it("rejects without revealing the schema", async () => {
        const response = await client().post("/api/items", { body: { name: "" } });
        expect(response.status).toBe(401);
        expect(await json(response)).toEqual({ error: "Unauthorized" });
    });

    it("validates once the guard let the request through", async () => {
        const response = await client().post("/api/items", { body: { name: "" }, headers: { authorization: "Bearer ok" } });
        expect(response.status).toBe(400);
        expect((await json(response)).issues[0]).toMatchObject({ in: "body", path: ["name"] });
    });

    it("passes what the guard adds to the handler", async () => {
        const response = await client().post("/api/items", { body: { name: "pen" }, headers: { authorization: "Bearer ok" } });
        expect(response.status).toBe(201);
        expect(await json(response)).toEqual({ name: "pen", by: "ada" });
    });
});

describe("middlewares", () => {
    it("see the validated request", async () => {
        const double = middleware({ handler: (request, response) => response.proceed({ doubled: (request.query as { n: number }).n * 2 }) });
        const client = app({
            "/api/n": { GET: route({ querySchema: z.object({ n: z.number() }), middlewares: [double], handler: (request, response) => response.json(request.doubled) }) },
        });
        expect(await json(await client.get("/api/n?n=21"))).toBe(42);
    });

    it("run once per request, however many list them", async () => {
        let runs = 0;
        const counted = guard({ handler: (request, response) => (runs++, response.proceed()) });
        const needsCounted = middleware({ requires: [counted], handler: (request, response) => response.proceed() });
        const client = app(
            { "/api/x": { GET: route({ guards: [counted], middlewares: [needsCounted], handler: (request, response) => response.json(runs) }) } },
            { proxies: { "/api": { default: proxy({ guards: [counted] }) } } },
        );
        expect(await json(await client.get("/api/x"))).toBe(1);
    });

    it("run in order: proxy guards (outer first), route guards, schemas, proxy middlewares, route middlewares", async () => {
        const order: string[] = [];
        const step = (name: string, kind: "guard" | "middleware") =>
            kind === "guard"
                ? guard({ handler: (request, response) => (order.push(name), response.proceed()) })
                : middleware({ handler: (request, response) => (order.push(name), response.proceed()) });
        const client = app(
            {
                "/api/a/b": {
                    POST: route({
                        guards: [step("route guard", "guard") as never],
                        middlewares: [step("route middleware", "middleware") as never],
                        bodySchema: z.unknown().transform((body) => (order.push("schemas"), body)),
                        handler: (request, response) => response.json(order),
                    }),
                },
            },
            {
                proxies: {
                    "/api": { default: proxy({ guards: [step("outer guard", "guard") as never], middlewares: [step("outer middleware", "middleware") as never] }) },
                    "/api/a": { default: proxy({ guards: [step("inner guard", "guard") as never], middlewares: [step("inner middleware", "middleware") as never] }) },
                },
            },
        );
        expect(await json(await client.post("/api/a/b", { body: {} }))).toEqual([
            "outer guard",
            "inner guard",
            "route guard",
            "schemas",
            "outer middleware",
            "inner middleware",
            "route middleware",
        ]);
    });

    it("can replace the request's own fields with what they proceed with", async () => {
        const replace = middleware({ handler: (request, response) => response.proceed({ params: { id: 7 } }) });
        const client = app({ "/api/[id]": { GET: route({ middlewares: [replace], handler: (request, response) => response.json(request.params) }) } });
        expect(await json(await client.get("/api/1"))).toEqual({ id: 7 });
    });
});

describe("the proceed contract fails closed", () => {
    it("a response made but not returned ends the request with 500", async () => {
        const forgotReturn = guard({
            handler: (request, response) => {
                if (!request.headers.authorization) response.status(401).json({ error: "Unauthorized" });
                return response.proceed();
            },
        });
        const client = app({ "/api/x": { GET: route({ guards: [forgotReturn], handler: (request, response) => response.json("passed") }) } });
        expect((await client.get("/api/x")).status).toBe(500);
        expect((await client.get("/api/x", { headers: { authorization: "x" } })).status).toBe(200);
    });

    it("a plain object instead of proceed is an error", async () => {
        const wrong = middleware({ handler: () => ({ user: 1 }) as never });
        const client = app({ "/api/x": { GET: route({ middlewares: [wrong], handler: (request, response) => response.json("passed") }) } });
        expect((await client.get("/api/x")).status).toBe(500);
    });

    it("proceed() only takes a plain object", () => {
        const response = new TyvoResponse();
        expect(() => response.proceed([1, 2] as never)).toThrow(/plain object/);
        expect(() => response.proceed(new Date() as never)).toThrow(/plain object/);
        expect(response.proceed({ a: 1 }).added).toEqual({ a: 1 });
        expect(response.proceed().added).toEqual({});
    });

    it("guards and middlewares cannot be mixed up", () => {
        expect(() => route({ guards: [middleware({ handler: (r, response) => response.proceed() }) as never], handler: (r, response) => response.empty() })).toThrow(/guard/);
        expect(() => route({ middlewares: [auth as never], handler: (r, response) => response.empty() })).toThrow(/middleware/);
        expect(() => guard({ bodySchema: z.object({}), handler: (r, response) => response.proceed() } as never)).toThrow(/schema/);
    });
});

describe("modifiers", () => {
    it("run after the handler: the route's first, then the proxies' (inner first)", async () => {
        const tag = (value: string) => modifier({ handler: (request, response) => response.header("x-order", `${response.headers.get("x-order") ?? ""}${value}`) });
        const client = app(
            { "/api/a/b": { GET: route({ modifiers: [tag("route,")], handler: (request, response) => response.json(null) }) } },
            { proxies: { "/api": { default: proxy({ modifiers: [tag("outer")] }) }, "/api/a": { default: proxy({ modifiers: [tag("inner,")] }) } } },
        );
        expect((await client.get("/api/a/b")).headers.get("x-order")).toBe("route,inner,outer");
    });

    it("also run on responses that ended the chain", async () => {
        const mark = modifier({ handler: (request, response) => response.header("x-mark", "1") });
        const client = app({ "/api/x": { GET: route({ guards: [auth], modifiers: [mark], handler: (request, response) => response.json(null) }) } });
        const response = await client.get("/api/x");
        expect(response.status).toBe(401);
        expect(response.headers.get("x-mark")).toBe("1");
    });

    it("must return the response to send", async () => {
        const forgot = modifier({ handler: ((request: unknown, response: { header(name: string, value: string): unknown }) => void response.header("x", "1")) as never });
        const client = app({ "/api/x": { GET: route({ modifiers: [forgot], handler: (request, response) => response.json(null) }) } });
        expect((await client.get("/api/x")).status).toBe(500);
    });
});

describe("handlers", () => {
    it("errors thrown become responses through onError", async () => {
        const client = app({
            "/api/teapot": { GET: route({ handler: () => { throw new HttpError(418, "I'm a teapot"); } }) },
            "/api/missing": { GET: route({ handler: () => notFound() }) },
            "/api/moved": { GET: route({ handler: () => redirect("https://example.com/") }) },
            "/api/crash": { GET: route({ handler: () => { throw new Error("boom"); } }) },
        });
        expect((await client.get("/api/teapot")).status).toBe(418);
        expect((await client.get("/api/missing")).status).toBe(404);
        const moved = await client.get("/api/moved");
        expect([moved.status, moved.headers.get("location")]).toEqual([307, "https://example.com/"]);
        const crash = await client.get("/api/crash");
        expect([crash.status, await json(crash)]).toEqual([500, { error: "Internal Server Error" }]);
    });

    it("responseSchema checks what goes out", async () => {
        const client = app({
            "/api/good": { GET: route({ responseSchema: z.object({ id: z.number() }), handler: (request, response) => response.json({ id: 1 }) }) },
            "/api/bad": { GET: route({ responseSchema: z.object({ id: z.number() }), handler: (request, response) => response.json({ id: "1" } as never) }) },
        });
        expect((await client.get("/api/good")).status).toBe(200);
        expect((await client.get("/api/bad")).status).toBe(500);
    });

    it("answers 405 with Allow, and HEAD from GET", async () => {
        const client = app({ "/api/x": { GET: route({ handler: (request, response) => response.json({ a: 1 }) }) } });
        const wrong = await client.delete("/api/x");
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get("allow")).toContain("GET");
        const head = await client.head("/api/x");
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
    });
});
