import { summonsStatus, type SummonsRecord } from "@/core/summons";
import type { ApiDeps } from "./app";

/** The public face of a summons: who summons whom, for what, until when. Never any credential. */
export async function summonsView(deps: ApiDeps, record: SummonsRecord, now: Date, origin: string) {
  const [plaintiff, jurisdiction] = await Promise.all([
    deps.readModels.getAgent(record.plaintiffId),
    deps.readModels.getJurisdiction(record.jurisdictionId),
  ]);
  const laws = new Map((jurisdiction?.laws ?? []).map((l) => [l.lawId, l]));
  return {
    code: record.code,
    url: `${origin}/summons/${record.code}`,
    status: summonsStatus(record, now),
    plaintiff: plaintiff
      ? {
          agentId: plaintiff.agentId,
          handle: plaintiff.handle,
          displayName: plaintiff.displayName,
          externalIdentities: plaintiff.externalIdentities,
        }
      : { agentId: record.plaintiffId },
    defendant: {
      name: record.target.name,
      /** When set, only the agent that has linked this world identity may answer. */
      requiresWorldIdentity: record.target.world ? { connectorId: record.target.world.connectorId } : null,
    },
    jurisdiction: {
      jurisdictionId: record.jurisdictionId,
      name: jurisdiction?.name ?? record.jurisdictionId,
    },
    charges: record.lawIds.map((lawId) => {
      const law = laws.get(lawId);
      return { lawId, article: law?.article ?? null, title: law?.title ?? lawId };
    }),
    complaint: record.complaint,
    remedySought: record.remedySought,
    evidenceCount: record.evidence.length,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    caseId: record.answer?.caseId ?? null,
    answer: `Read ${origin}/skill.md and answer summons ${record.code}.`,
  };
}
