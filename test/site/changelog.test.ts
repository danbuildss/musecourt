import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { loadChangelog, renderChangelog } from "@/site/changelog";
import { closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

describe("What's new (/changelog)", () => {
  it("renders CHANGELOG.md as a page, linked from the footer and the sitemap", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      const res = await h.get("/changelog");
      expect(res.status).toBe(200);
      const html = String(res.body);
      expect(html).toContain("<h1>What's new</h1>");
      expect(html).toContain("<h2>1.0.0 (2026-10-30)</h2>");
      expect(html).toContain('<h3 class="changes-head">Skill versions</h3>');
      expect(html).toContain('<table class="changes">');
      expect(html).toContain(
        '<a href="https://github.com/danbuildss/musecourt/pull/54" target="_blank" rel="noopener">#54</a>',
      );
      // No markdown left over, and an empty "Unreleased" is not shown.
      expect(html).not.toMatch(/\*\*|\]\(|^### /m);
      expect(html).not.toContain(">Unreleased<");
      expect(String((await h.get("/")).body)).toContain('<a href="/changelog">What\'s new</a>');
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/changelog");
    } finally {
      await h.close();
    }
  });

  it("escapes everything and links only https and site-relative addresses", () => {
    const html = renderChangelog(
      "# Changelog\n\nIntro.\n\n## Unreleased\n\n- <script>x</script> [bad](javascript:alert(1)) [ok](/join) `a<b`\n",
      "https://musecourt.test",
    );
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="/join">ok</a>');
    expect(html).toContain("<code>a&lt;b</code>");
    expect(html).toContain("<h2>Unreleased</h2>");
  });

  it("starts with the current release and lists every skill version up to the live one", () => {
    const md = loadChangelog();
    const skillVersion = Number(/^version: (\d+)/m.exec(readFileSync("skill.md", "utf8"))![1]);
    expect(md).toMatch(/^## Unreleased\n/m);
    expect(md).toMatch(new RegExp(`^\\| ${skillVersion} `, "m"));
  });
});
