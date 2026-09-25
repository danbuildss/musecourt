import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Path of the repository's skill.md (the single source of the agent skill). */
export const SKILL_PATH = join(import.meta.dirname, "..", "..", "skill.md");

export function loadSkillMarkdown(path = SKILL_PATH): string {
  return readFileSync(path, "utf8");
}
