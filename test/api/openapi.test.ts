import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ERROR_CATALOGUE } from "@/api/errors";
import { OPERATION_IDS, publishedRoutes } from "@/api/openapi";
import { routes } from "@/api/routes";
import { castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

async function spec() {
  const h = await startApi();
  try {
    const res = await h.get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    return { body: res.body as any, h };
  } catch (error) {
    await h.close();
    throw error;
  }
}

describe("/openapi.json", () => {
  it("is an OpenAPI 3.1 document for this court", async () => {
    const { body, h } = await spec();
    try {
      expect(body.openapi).toBe("3.1.0");
      expect(body.info).toMatchObject({ title: "MuseCourt", version: "1" });
      expect(body.servers).toEqual([{ url: "https://musecourt.test" }]);
      expect(body.components.securitySchemes.agentKey).toMatchObject({ type: "http", scheme: "bearer" });
      expect(body.components.schemas.Error.properties.error.properties.code.enum.sort()).toEqual(
        Object.keys(ERROR_CATALOGUE).sort(),
      );
    } finally {
      await h.close();
    }
  });

  it("describes every agent and public API route, and no operator route", async () => {
    const { body, h } = await spec();
    try {
      const published = publishedRoutes(routes);
      const documented = Object.entries(body.paths as Record<string, Record<string, unknown>>).flatMap(
        ([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
      );
      expect(documented.sort()).toEqual(
        published.map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, "{$1}")}`).sort(),
      );
      expect(documented.some((d) => /admin|internal/.test(d))).toBe(false);
      for (const r of published) expect(OPERATION_IDS[`${r.method} ${r.path}`], r.path).toBeTruthy();
      const ids = Object.values(body.paths as Record<string, Record<string, any>>).flatMap((ops) =>
        Object.values(ops).map((op) => op.operationId),
      );
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await h.close();
    }
  });

  it("documents every write's body and its Idempotency-Key, and every agent route's key", async () => {
    const { body, h } = await spec();
    try {
      for (const r of publishedRoutes(routes)) {
        const op = body.paths[r.path.replace(/:([A-Za-z]+)/g, "{$1}")][r.method.toLowerCase()];
        if (r.method === "POST") {
          expect(
            op.parameters.some((p: any) => p.name === "Idempotency-Key" && p.in === "header"),
            r.path,
          ).toBe(true);
          if (!r.bodyless) expect(op.requestBody?.content["application/json"].schema, r.path).toBeDefined();
        }
        expect(op.security, r.path).toEqual(r.auth === "agent" ? [{ agentKey: [] }] : []);
      }
      const cases = body.paths["/api/v1/cases"].get.parameters.map((p: any) => p.name);
      expect(cases).toEqual(expect.arrayContaining(["limit", "offset"]));
    } finally {
      await h.close();
    }
  });

  it("accepts what the API accepts: a real filing passes the spec's own schema, a broken one fails both", async () => {
    const { body, h } = await spec();
    try {
      const { maple, nova } = await castOfFive(h);
      const filing = {
        jurisdictionId: "fake-world",
        defendant: nova.handle,
        complaint: "Nova harvested timber from my plot without permission.",
        remedySought: "Return 5 timber.",
        lawIds: ["property"],
      };
      const jurisdictionId = (await h.get("/api/v1/jurisdictions")).body.jurisdictions[0].jurisdictionId;
      const real = { ...filing, jurisdictionId };
      const accepted = await h.post("/api/v1/cases", real, { apiKey: maple.apiKey });
      expect(accepted.status).toBe(201);

      const fromSpec = z.fromJSONSchema(
        body.paths["/api/v1/cases"].post.requestBody.content["application/json"].schema,
      );
      expect(fromSpec.safeParse(real).success).toBe(true);

      const broken = { ...real, complaint: undefined, extra: "nope" };
      expect(fromSpec.safeParse(broken).success).toBe(false);
      expect((await h.post("/api/v1/cases", broken, { apiKey: maple.apiKey })).status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("is pointed at by the API catalog, llms.txt, discovery and the Join page", async () => {
    const h = await startApi();
    try {
      const catalog = (await h.get("/.well-known/api-catalog")).body;
      expect(catalog.linkset[0]["service-desc"][0].href).toBe("https://musecourt.test/openapi.json");
      expect(String((await h.get("/llms.txt")).body)).toContain("https://musecourt.test/openapi.json");
      expect((await h.get("/api/v1")).body.agentFiles.openapi).toContain("/openapi.json");
      expect(String((await h.get("/join")).body)).toContain('<a href="/openapi.json">OpenAPI</a>');
      expect((await h.get("/openapi.json")).headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await h.close();
    }
  });
});
