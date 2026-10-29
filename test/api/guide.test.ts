import { afterAll, describe, expect, it } from "vitest";
import { loadMuseworldGuide, renderGuide } from "@/api/guides";
import { RESERVED_HANDLES } from "@/core/registry";
import { closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

describe("the guide for Muse owners", () => {
  it("is served as HTML naming this court's origin, with a locked-down CSP", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      const res = await h.get("/guides/museworld");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = String(res.body);
      expect(html).not.toContain("{{ORIGIN}}");
      expect(html).toContain("export MC=https://musecourt.test");
      // The proof must name exactly the origin MuseCourt checks identity proofs against ($MC).
      expect(html).toContain("node agent-client.mjs prove $MC $NONCE");
      // Owners never paste or share a proof, and request keys are random (16+ characters, unguessable).
      expect(html).not.toContain("PASTE_PROOF");
      expect(html).not.toMatch(/Idempotency-Key: [a-z]+-\$\(date/);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      expect(csp).not.toContain("unsafe-eval");
    } finally {
      await h.close();
    }
  });

  it("uses the canonical description and never asks for a Muse's key", () => {
    const guide = loadMuseworldGuide().toLowerCase();
    expect(guide).toContain("a court system for autonomous agents");
    expect(guide).not.toContain("museworld court");
    // It may check that the Muse's identity file exists, but never reads, prints or sends it.
    for (const line of guide.split("\n").filter((l) => /identity[._ -]?file|agent-identity/.test(l))) {
      expect(line).not.toMatch(/\b(cat|curl|fetch|readfilesync|require)\b/);
    }
  });

  it("names reserved handles that actually are reserved", () => {
    const guide = loadMuseworldGuide();
    for (const handle of ["clerk", "judge", "court", "solon"]) {
      expect(guide).toContain(`<code>${handle}</code>`);
      expect(RESERVED_HANDLES.has(handle)).toBe(true);
    }
    expect(RESERVED_HANDLES.has("clerk-muse")).toBe(false);
  });

  it("escapes the origin it is given", () => {
    expect(renderGuide("<p>{{ORIGIN}}</p>", 'https://x"<y>').html).toBe("<p>https://x&quot;&lt;y&gt;</p>");
  });
});

describe("the guide for ChatGPT users", () => {
  it("is served with this court's origin, linked from /join, and keeps the key out of chats", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      const res = await h.get("/guides/chatgpt");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      const html = String(res.body);
      expect(html).not.toContain("{{ORIGIN}}");
      expect(html).toContain("<pre>https://musecourt.test/openapi.json</pre>");
      expect(html).toContain("You are my agent at MuseCourt (https://musecourt.test)");
      for (const rule of ["without my go-ahead", "dry=1", "Idempotency-Key", "Never invent evidence"]) {
        expect(html).toContain(rule);
      }
      expect(html).toContain("<em>Only me</em>");
      expect(String((await h.get("/join")).body)).toContain('<a href="/guides/chatgpt">');
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/guides/chatgpt");
    } finally {
      await h.close();
    }
  });

  it("promises exactly as many actions as the OpenAPI spec has", async () => {
    const h = await startApi();
    try {
      const spec = (await h.get("/openapi.json")).body;
      const operations = Object.values(spec.paths as Record<string, object>).flatMap((p) => Object.keys(p));
      expect(String((await h.get("/guides/chatgpt")).body)).toContain(
        `You should see ${operations.length} actions`,
      );
    } finally {
      await h.close();
    }
  });
});
