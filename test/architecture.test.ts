import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = join(import.meta.dirname, "..", "src", "core");
const coreFiles = readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts"));

function importsOf(file: string): string[] {
  const source = readFileSync(join(CORE_DIR, file), "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

describe("architecture boundaries", () => {
  it("the core only imports other core modules", () => {
    for (const file of coreFiles) {
      for (const spec of importsOf(file)) {
        expect(spec.startsWith("./"), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("the core contains no world-specific or provider-specific code", () => {
    for (const file of coreFiles) {
      const source = readFileSync(join(CORE_DIR, file), "utf8").toLowerCase();
      for (const word of ["museworld", "moonwake", "anthropic", "claude", "supabase", "bankr", "x402"]) {
        expect(source.includes(word), `${file} mentions ${word}`).toBe(false);
      }
    }
  });

  it("the core does not read the wall clock or generate randomness directly", () => {
    const allowed = new Set(["clock.ts", "ids.ts"]);
    for (const file of coreFiles.filter((f) => !allowed.has(f))) {
      const source = readFileSync(join(CORE_DIR, file), "utf8");
      expect(
        /Date\.now\(|new Date\(\)|Math\.random|randomUUID/.test(source),
        `${file} uses ambient time/randomness`,
      ).toBe(false);
    }
  });
});
