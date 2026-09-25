import { describe, expect, it } from "vitest";
import { restoreOriginalUrl } from "@/vercel/handler";

describe("Vercel entry: URL restoration", () => {
  it("restores the original path and query from the catch-all rewrite", () => {
    expect(restoreOriginalUrl("/api?__path=api/v1")).toBe("/api/v1");
    expect(restoreOriginalUrl("/api?__path=api/v1/cases&status=OPEN&limit=5")).toBe(
      "/api/v1/cases?status=OPEN&limit=5",
    );
    expect(restoreOriginalUrl("/api?__path=")).toBe("/");
    expect(restoreOriginalUrl("/api?__path=debug/cases/case_1")).toBe("/debug/cases/case_1");
  });

  it("leaves URLs that were not rewritten untouched", () => {
    expect(restoreOriginalUrl("/api/v1/agents?x=1")).toBe("/api/v1/agents?x=1");
  });
});
