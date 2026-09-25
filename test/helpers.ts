import { expect } from "vitest";
import { FakeWorld } from "@/connectors/fake-world";
import { adminActor, agentActor, type Actor } from "@/core/actor";
import type { CaseCommand, EvidenceInput } from "@/core/case-decide";
import type { CaseState } from "@/core/case-state";
import { isCourtError, type CourtErrorCode } from "@/core/errors";
import type { LicenceType } from "@/core/events";
import type { DeadlinePolicy, Stage } from "@/core/procedure";
import { Court } from "@/court/court";
import { CourtClock } from "@/court/court-clock";
import { HouseJudgeService } from "@/court/house-judge-service";
import type { CourtModel } from "@/core/ports";
import { createMemoryBackend, type Backend } from "@/infra/backends";
import { FOUNDING_LAWS } from "@/seed/laws";
import { FakeClock } from "@/testing/fake-clock";
import { SequentialIds } from "@/testing/sequential-ids";

export const JURISDICTION = "fake";

export interface TestCourtOptions {
  policy?: DeadlinePolicy;
  backend?: Backend;
}

/**
 * A court with the Fake World jurisdiction, the five founding laws and a cast:
 *  - maple, nova, bob: ordinary agents
 *  - apollo, athena: licensed lawyers
 *  - sol, iris: licensed lawyers and judges
 */
export async function createTestCourt(options: TestCourtOptions = {}) {
  const backend = options.backend ?? createMemoryBackend();
  const { store, readModels } = backend;
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const world = new FakeWorld();
  const court = new Court({
    store,
    readModels,
    clock,
    ids,
    connectors: [world],
    deadlinePolicy: options.policy,
  });
  const admin = adminActor("admin_1");

  await court.establishJurisdiction(
    { jurisdictionId: JURISDICTION, name: "Fake World", casePrefix: "FW", connectorId: world.id },
    admin,
  );
  for (const law of FOUNDING_LAWS) await court.enactLaw(JURISDICTION, law, admin);

  const register = async (handle: string, licences: LicenceType[] = [], ownerRef?: string) => {
    const agent = await court.registerAgent({
      handle,
      displayName: handle[0]!.toUpperCase() + handle.slice(1),
      ownerRef: ownerRef ?? null,
    });
    for (const licence of licences) await court.grantLicence({ agentId: agent.agentId, licence }, admin);
    return agent.agentId;
  };

  const agents = {
    maple: await register("maple"),
    nova: await register("nova"),
    bob: await register("bob"),
    apollo: await register("apollo", ["LAWYER"]),
    athena: await register("athena", ["LAWYER"]),
    sol: await register("sol", ["LAWYER", "JUDGE"]),
    iris: await register("iris", ["LAWYER", "JUDGE"]),
  };

  const as = (agentId: string): Actor => agentActor(agentId);
  const act = (caseId: string, agentId: string, command: CaseCommand) =>
    court.act(caseId, as(agentId), command);

  /** A court clock over this court; pass a model to let Solon rule. */
  const courtClock = (options: { model?: CourtModel; lease?: boolean } = {}) =>
    new CourtClock({
      court,
      readModels,
      clock,
      houseJudge: options.model ? new HouseJudgeService(court, options.model, readModels) : undefined,
      lease: options.lease === false ? undefined : backend.clockLease,
    });

  return {
    court,
    backend,
    store,
    readModels,
    clock,
    ids,
    world,
    admin,
    agents,
    register,
    as,
    act,
    courtClock,
  };
}

export type TestCourt = Awaited<ReturnType<typeof createTestCourt>>;

/** Maple sues Nova for taking timber, citing the Fake World harvest event. */
export async function fileStandardCase(
  t: TestCourt,
  overrides: { evidence?: EvidenceInput[]; lawIds?: string[]; plaintiff?: string; defendant?: string } = {},
): Promise<CaseState> {
  return t.court.fileCase(t.as(overrides.plaintiff ?? t.agents.maple), {
    jurisdictionId: JURISDICTION,
    defendantId: overrides.defendant ?? t.agents.nova,
    complaint: "Nova harvested timber from my plot without permission.",
    remedySought: "Return 5 timber.",
    lawIds: overrides.lawIds ?? ["property"],
    evidence: overrides.evidence ?? [{ kind: "WORLD_EVENT", eventId: "action_72882" }],
  });
}

/** Defendant answers; Apollo (plaintiff) and Athena (defence) are appointed; Sol takes the bench. */
export async function driveToTrial(t: TestCourt, caseId: string): Promise<CaseState> {
  const { maple, nova, apollo, athena, sol } = t.agents;
  await t.act(caseId, nova, { type: "RespondToComplaint", response: "I had permission to gather there." });
  await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo });
  await t.act(caseId, apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
  await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: athena });
  await t.act(caseId, athena, { type: "AcceptRepresentation", side: "DEFENCE" });
  return t.act(caseId, sol, { type: "VolunteerAsJudge" });
}

/** Runs the whole trial to DELIBERATION with counsel speaking and Sol asking both sides a question. */
export async function driveToDeliberation(t: TestCourt, caseId: string): Promise<CaseState> {
  const { apollo, athena, sol } = t.agents;
  await driveToTrial(t, caseId);
  await t.act(caseId, apollo, { type: "MakeStatement", text: "Nova took Maple's timber." });
  await t.act(caseId, athena, { type: "MakeStatement", text: "Nova had permission." });
  await t.act(caseId, apollo, { type: "ConcludeStage" });
  await t.act(caseId, athena, { type: "ConcludeStage" });
  await t.act(caseId, sol, {
    type: "MakeStatement",
    text: "Was permission ever recorded?",
    addressedTo: ["DEFENCE", "PLAINTIFF"],
  });
  await t.act(caseId, athena, { type: "MakeStatement", text: "It was given verbally." });
  await t.act(caseId, apollo, { type: "MakeStatement", text: "No permission exists in the record." });
  await t.act(caseId, apollo, { type: "MakeStatement", text: "The record shows an unpermitted harvest." });
  return t.act(caseId, athena, {
    type: "MakeStatement",
    text: "The plaintiff has not proven lack of consent.",
  });
}

export async function expectCourtError(promise: Promise<unknown>, code: CourtErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (isCourtError(error)) {
      expect(error.code, error.message).toBe(code);
      return;
    }
    throw error;
  }
  expect.fail(`Expected CourtError ${code}, but the action succeeded.`);
}

export function stageOf(state: CaseState | null): Stage | null {
  return state?.stage ?? null;
}
