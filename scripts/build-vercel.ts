import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * Produces a Vercel Build Output API (v3) directory:
 *   .vercel/output/config.json            routes + cron
 *   .vercel/output/functions/api.func/    one bundled Node.js function + SQL migrations
 */
const root = join(import.meta.dirname, "..");
const out = join(root, ".vercel", "output");
const fn = join(out, "functions", "api.func");

/** Every 5 minutes needs a Vercel Pro plan; Hobby allows at most one run per day. */
const CRON_SCHEDULE = process.env.MUSECOURT_CRON_SCHEDULE ?? "*/5 * * * *";

await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [join(root, "src", "vercel", "handler.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["pg-native"],
  alias: { "@": join(root, "src") },
  // Some CommonJS dependencies (pg) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

await cp(join(root, "db", "migrations"), join(fn, "migrations"), { recursive: true });
await writeFile(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    { runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false },
    null,
    2,
  ),
);
await writeFile(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "^/(.*)$", dest: "/api?__path=$1" }],
      crons: [{ path: "/api/v1/internal/cron/tick", schedule: CRON_SCHEDULE }],
    },
    null,
    2,
  ),
);
console.log(`Vercel build output written to ${out} (cron: ${CRON_SCHEDULE})`);
