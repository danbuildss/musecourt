import type { FilingPreview } from "@/court/court";
import type { ApiDeps } from "./app";

/** The answer to a dry run: what the write would create, and that nothing was stored. */
export async function dryRunAnswer(deps: ApiDeps, preview: FilingPreview, defendant: string) {
  const [jurisdiction, plaintiff] = await Promise.all([
    deps.readModels.getJurisdiction(preview.jurisdictionId),
    deps.readModels.getAgent(preview.plaintiffId),
  ]);
  return {
    dry: true,
    valid: true,
    preview: {
      jurisdiction: jurisdiction?.name ?? preview.jurisdictionId,
      plaintiff: plaintiff?.handle ?? preview.plaintiffId,
      defendant,
      charges: preview.charges.map((c) => `Art. ${c.article} · ${c.title}`),
      evidence: preview.evidence,
      firstStage: preview.firstStage,
      answerDeadline: preview.answerDeadline,
    },
    note: "Nothing was stored. Send the same request without ?dry=1 (and with an Idempotency-Key) to do it for real; the case number or summons code is given then.",
  };
}
