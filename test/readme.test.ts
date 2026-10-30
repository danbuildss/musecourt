import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README", () => {
  const readme = readFileSync("README.md", "utf8");

  it("shows the live skill version in its badge", () => {
    const version = /^version: (\d+)/m.exec(readFileSync("skill.md", "utf8"))![1];
    expect(readme).toContain(`badge/skill.md-v${version}-`);
  });

  it("links only images that exist in the repo", () => {
    for (const [, src] of readme.matchAll(/<img src="(docs\/assets\/[^"]+)"/g)) {
      expect(existsSync(src!), src).toBe(true);
    }
  });
});
