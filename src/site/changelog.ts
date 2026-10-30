import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml as e } from "@/api/http";
import { page } from "./layout";

/**
 * `/changelog`: "What's new", rendered from the repository's CHANGELOG.md so the site and GitHub
 * always say the same thing. The renderer covers only what that file uses: headings, paragraphs,
 * bullet lists, tables, links, bold and code. Everything is escaped first.
 */

export const CHANGELOG_PATH = join(import.meta.dirname, "..", "..", "CHANGELOG.md");

export function loadChangelog(path = CHANGELOG_PATH): string {
  return readFileSync(path, "utf8");
}

/** Escaped text with `code`, **bold** and [links](https://… or /…). */
function inline(text: string): string {
  return e(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|\/)[^)\s]*)\)/g, (_, label: string, href: string) =>
      href.startsWith("/")
        ? `<a href="${href}">${label}</a>`
        : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`,
    );
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The blocks of one release (or the intro): paragraphs, lists, tables and ### headings. */
function blocks(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("### ")) {
      out.push(`<h3 class="changes-head">${inline(line.slice(4))}</h3>`);
      i++;
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) items.push(lines[i++]!.slice(2));
      out.push(`<ul class="stat-lines">${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
    } else if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(lines[i++]!);
      const [head, , ...body] = rows;
      out.push(
        `<div class="table-scroll"><table class="changes"><thead><tr>${cells(head!)
          .map((c) => `<th scope="col">${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map(
            (r) =>
              `<tr>${cells(r)
                .map((c) => `<td>${inline(c)}</td>`)
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`,
      );
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#|- |\|)/.test(lines[i]!)) para.push(lines[i++]!);
      out.push(`<p class="join-p">${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

export function renderChangelog(markdown: string, origin: string): string {
  const [intro, ...releases] = markdown.replace(/^# .*\n/, "").split(/^## /m);
  const sections = releases
    .map((release) => {
      const [title, ...rest] = release.split("\n");
      const content = blocks(rest);
      if (!content.trim()) return ""; // an empty "Unreleased"
      return `
<section class="section">
  <div class="wrap">
    <div class="section-head"><h2>${inline(title!.trim())}</h2></div>
    ${content}
  </div>
</section>`;
    })
    .join("");
  return page({
    title: "What's new",
    description: "What changed in MuseCourt, release by release.",
    path: "/changelog",
    origin,
    body: `
<section class="page-head">
  <div class="wrap">
    <p class="eyebrow">Changelog</p>
    <h1>What's new</h1>
    <div class="lede">${blocks((intro ?? "").split("\n"))}</div>
    <p class="note">MuseCourt is open source under the Apache License 2.0: <a href="https://github.com/danbuildss/musecourt" target="_blank" rel="noopener">github.com/danbuildss/musecourt</a></p>
  </div>
</section>${sections}`,
  });
}

/**
 * The newest numbered release in CHANGELOG.md, with GitHub release notes made from its section
 * (its ### headings become ##). Null when the changelog has no numbered release yet.
 */
export function latestRelease(markdown: string): { version: string; title: string; notes: string } | null {
  const match = /^## (\d+\.\d+\.\d+) \(([\d-]+)\)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown);
  if (!match) return null;
  const [, version, , section] = match;
  const notes = [
    section!.trim().replace(/^### /gm, "## "),
    "",
    "Full history: [CHANGELOG.md](https://github.com/danbuildss/musecourt/blob/main/CHANGELOG.md) · " +
      "On the site: [musecourt.xyz/changelog](https://www.musecourt.xyz/changelog)",
    "",
  ].join("\n");
  return { version: version!, title: `MuseCourt ${version}`, notes };
}
