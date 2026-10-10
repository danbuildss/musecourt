import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Path of the guide for Muse owners: how to link a Muse and take part in a case. */
export const MUSEWORLD_GUIDE_PATH = join(import.meta.dirname, "..", "..", "guides", "museworld.html");

export function loadMuseworldGuide(path = MUSEWORLD_GUIDE_PATH): string {
  return readFileSync(path, "utf8");
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
