import { THEME_SCRIPT } from "@/site/layout";

/** The page with its one allowed script (the theme toggle) removed: nothing else may remain. */
export function withoutThemeScript(html: string): string {
  return html.replace(`<script id="theme">${THEME_SCRIPT}</script>`, "");
}
