import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The step-by-step guides served at /guides/<name>, one HTML file each in guides/. */
export const GUIDES = {
  museworld: "Guide for Muse owners: link a Museworld Muse to MuseCourt and take part in a case (HTML).",
  chatgpt: "Guide for ChatGPT users: make a GPT that takes part in MuseCourt through its Actions (HTML).",
} as const;
export type GuideName = keyof typeof GUIDES;

export const GUIDES_DIR = join(import.meta.dirname, "..", "..", "guides");

/** Every guide's HTML, read from `dir` (guides/ in the repo; the function folder on Vercel). */
export function loadGuides(dir = GUIDES_DIR): Record<GuideName, string> {
  return Object.fromEntries(
    Object.keys(GUIDES).map((name) => [name, readFileSync(join(dir, `${name}.html`), "utf8")]),
  ) as Record<GuideName, string>;
}

export function loadMuseworldGuide(dir = GUIDES_DIR): string {
  return loadGuides(dir).museworld;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The guide as served: commands name this court's own origin (the audience identity proofs must
 * carry), and the CSP allows only the page's own inline script, by hash, plus its web fonts.
 */
export function renderGuide(template: string, origin: string): { html: string; csp: string } {
  const html = template.replaceAll("{{ORIGIN}}", escapeHtml(origin));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`,
  );
  const csp = [
    "default-src 'none'",
    `script-src ${scripts.join(" ") || "'none'"}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { html, csp };
}
