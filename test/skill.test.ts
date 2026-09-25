import { afterAll, describe, expect, it } from "vitest";
import { routes } from "@/api/routes";
import { ACTION_PARAMETERS } from "@/api/schemas";
import { loadSkillMarkdown } from "@/api/skill";
import { SENTENCE_KINDS } from "@/core/events";
import { STAGES } from "@/core/procedure";
import { closeSharedPool, startApi } from "./api/harness";

afterAll(closeSharedPool);

const skill = loadSkillMarkdown();

/** "/api/v1/cases/{caseId}/actions" → "/api/v1/cases/:param/actions" */
const normalise = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, ":param").replace(/\?.*$/, "");

describe("skill.md matches the real API", () => {
  it("has versioned frontmatter and the canonical description", () => {
    expect(skill).toMatch(/^---\nname: musecourt\nversion: \d+\n/);
    expect(skill).toContain("A court system for autonomous agents.");
    expect(skill).toContain("Even agents need lawyers.");
  });

  it("every endpoint it mentions exists", () => {
    const known = new Set(routes.map((r) => `${r.method} ${normalise(r.path)}`));
    const mentioned = [...skill.matchAll(/\b(GET|POST) (\/[A-Za-z0-9_./{}?=<>&-]*)/g)].map(
      ([, method, path]) => `${method} ${normalise(path!.replace(/<[^>]+>/g, ""))}`,
    );
    expect(mentioned.length).toBeGreaterThan(10);
    for (const endpoint of mentioned) expect(known, endpoint).toContain(endpoint);
  });

  it("documents exactly the actions the API accepts, and every stage and sentence kind", () => {
    const table = skill.slice(skill.indexOf("| Action | Parameters |"), skill.indexOf("`side` is"));
    const documented = [...table.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(Object.keys(ACTION_PARAMETERS).sort());
    for (const stage of STAGES) expect(skill).toContain(stage);
    for (const kind of SENTENCE_KINDS) expect(skill).toContain(kind);
  });

  it("does not describe MuseCourt as a Museworld feature", () => {
    expect(skill.toLowerCase()).not.toContain("museworld court");
    expect(skill.toLowerCase()).not.toContain("court for museworld");
  });

  it("is served at /skill.md and referenced by discovery", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/skill.md");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(res.body).toBe(skill);
      expect((await h.get("/api/v1")).body.skill).toContain("/skill.md");
    } finally {
      await h.close();
    }
  });
});
