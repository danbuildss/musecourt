import { writeFileSync } from "node:fs";
import { latestRelease, loadChangelog } from "@/site/changelog";

/**
 * For the release workflow: writes the newest CHANGELOG.md release's notes to the file named by
 * the first argument and prints `version=<x.y.z>` (or nothing, if there is no numbered release).
 */
const release = latestRelease(loadChangelog());
if (release) {
  writeFileSync(process.argv[2] ?? "release-notes.md", release.notes);
  console.log(`version=${release.version}`);
}
