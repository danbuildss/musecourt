import { afterAll, describe, expect, it } from "vitest";
import { loadMuseworldGuide, renderGuide } from "@/api/guides";
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
      // The proof must name exactly the origin MuseCourt checks identity proofs against.
      expect(html).toContain("node agent-client.mjs prove https://musecourt.test $NONCE");
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
    expect(guide).not.toContain("identity.json");
  });

  it("escapes the origin it is given", () => {
    expect(renderGuide("<p>{{ORIGIN}}</p>", 'https://x"<y>').html).toBe("<p>https://x&quot;&lt;y&gt;</p>");
  });
});
