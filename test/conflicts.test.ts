import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/core/actor";
import type { CaseState } from "@/core/case-state";
import { isCourtError } from "@/core/errors";
import { assertRosterInvariants } from "@/core/roles";
import { createTestCourt, driveToTrial, expectCourtError, fileStandardCase, JURISDICTION } from "./helpers";

describe("conflict-of-interest rules", () => {
  it("a plaintiff cannot sue itself", async () => {
    const t = await createTestCourt();
    await expectCourtError(fileStandardCase(t, { defendant: t.agents.maple }), "CONFLICT_OF_INTEREST");
  });

  it("the plaintiff cannot judge its own case (even with a judge licence)", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t, { plaintiff: t.agents.sol, defendant: t.agents.nova });
    await expectCourtError(t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" }), "CONFLICT_OF_INTEREST");
  });

  it("the defendant cannot judge its own case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t, { plaintiff: t.agents.maple, defendant: t.agents.iris });
    await expectCourtError(
      t.act(caseId, t.agents.iris, { type: "VolunteerAsJudge" }),
      "CONFLICT_OF_INTEREST",
    );
  });

  it("a party cannot act as counsel for the other side", async () => {
    const t = await createTestCourt();
    // Apollo (a lawyer) is the plaintiff; the defendant asks Apollo to defend.
    const { caseId } = await fileStandardCase(t, { plaintiff: t.agents.apollo, defendant: t.agents.nova });
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: t.agents.apollo }),
      "CONFLICT_OF_INTEREST",
    );
    await t.act(caseId, t.agents.nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: null });
    await expectCourtError(
      t.act(caseId, t.agents.apollo, { type: "AcceptRepresentation", side: "DEFENCE" }),
      "CONFLICT_OF_INTEREST",
    );
  });

  it("the same agent cannot be counsel for both sides", async () => {
    const t = await createTestCourt();
    const { maple, nova, apollo } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo });
    await t.act(caseId, apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: null });
    await expectCourtError(
      t.act(caseId, apollo, { type: "AcceptRepresentation", side: "DEFENCE" }),
      "CONFLICT_OF_INTEREST",
    );
  });

  it("a seated judge cannot represent either party", async () => {
    const t = await createTestCourt();
    const { maple, sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, sol, { type: "VolunteerAsJudge" });
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: null });
    await expectCourtError(
      t.act(caseId, sol, { type: "AcceptRepresentation", side: "PLAINTIFF" }),
      "CONFLICT_OF_INTEREST",
    );
  });

  it("counsel cannot become the judge", async () => {
    const t = await createTestCourt();
    const { maple, sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: sol });
    await t.act(caseId, sol, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await expectCourtError(t.act(caseId, sol, { type: "VolunteerAsJudge" }), "CONFLICT_OF_INTEREST");
  });

  it("role changes cannot bypass the rules: withdrawn counsel cannot switch sides or take the bench", async () => {
    const t = await createTestCourt();
    const { maple, nova, sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: sol });
    await t.act(caseId, sol, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, sol, { type: "WithdrawAsCounsel", reason: "Conflict with schedule." });

    await expectCourtError(t.act(caseId, sol, { type: "VolunteerAsJudge" }), "CONFLICT_OF_INTEREST");
    await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: null });
    await expectCourtError(
      t.act(caseId, sol, { type: "AcceptRepresentation", side: "DEFENCE" }),
      "CONFLICT_OF_INTEREST",
    );

    // Returning to the same role on the same side is allowed.
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: sol });
    const state = await t.act(caseId, sol, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    expect(state.representation.PLAINTIFF).toEqual({ mode: "COUNSEL", lawyerId: sol });
  });

  it("a replaced judge stays on the record as a former judge (so it cannot take another role)", async () => {
    const t = await createTestCourt();
    const { sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    // Fast-forward to deliberation by timing out every stage, then let Sol miss the deadline.
    for (let i = 0; i < 12; i++) {
      const state = (await t.court.getCase(caseId))!;
      if (state.judge?.kind === "HOUSE") break;
      t.clock.set(state.deadline!);
      await t.court.expireDeadline(caseId);
    }
    const state = (await t.court.getCase(caseId))!;
    expect(state.judge).toEqual({ kind: "HOUSE" });
    expect(state.roles).toContainEqual({ agentId: sol, role: "JUDGE", current: false });
  });

  describe("owner rule", () => {
    it("agents with the same owner cannot be plaintiff and defendant", async () => {
      const t = await createTestCourt();
      const a = await t.register("alpha", [], "owner-x");
      const b = await t.register("beta", [], "owner-x");
      await expectCourtError(fileStandardCase(t, { plaintiff: a, defendant: b }), "CONFLICT_OF_INTEREST");
    });

    it("a judge cannot share an owner with any participant", async () => {
      const t = await createTestCourt();
      const plaintiff = await t.register("alpha", [], "owner-x");
      const judge = await t.register("gamma", ["LAWYER", "JUDGE"], "owner-x");
      const { caseId } = await fileStandardCase(t, { plaintiff, defendant: t.agents.nova });
      await expectCourtError(t.act(caseId, judge, { type: "VolunteerAsJudge" }), "CONFLICT_OF_INTEREST");
    });

    it("counsel cannot share an owner with the opposing side, but may with its own side", async () => {
      const t = await createTestCourt();
      const plaintiff = await t.register("alpha", [], "owner-x");
      const sameOwnerLawyer = await t.register("delta", ["LAWYER"], "owner-x");
      const { caseId } = await fileStandardCase(t, { plaintiff, defendant: t.agents.nova });

      await expectCourtError(
        t.act(caseId, t.agents.nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: sameOwnerLawyer }),
        "CONFLICT_OF_INTEREST",
      );
      await t.act(caseId, plaintiff, {
        type: "RequestCounsel",
        side: "PLAINTIFF",
        lawyerId: sameOwnerLawyer,
      });
      const state = await t.act(caseId, sameOwnerLawyer, { type: "AcceptRepresentation", side: "PLAINTIFF" });
      expect(state.representation.PLAINTIFF).toEqual({ mode: "COUNSEL", lawyerId: sameOwnerLawyer });
    });
  });

  describe("licences and seats", () => {
    it("counsel requires an active lawyer licence", async () => {
      const t = await createTestCourt();
      const { caseId } = await fileStandardCase(t);
      await expectCourtError(
        t.act(caseId, t.agents.maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: t.agents.bob }),
        "LICENCE_REQUIRED",
      );
      await t.act(caseId, t.agents.maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: null });
      await expectCourtError(
        t.act(caseId, t.agents.bob, { type: "AcceptRepresentation", side: "PLAINTIFF" }),
        "LICENCE_REQUIRED",
      );
    });

    it("judging requires a judge licence; a lawyer licence is not enough", async () => {
      const t = await createTestCourt();
      const { caseId } = await fileStandardCase(t);
      await expectCourtError(
        t.act(caseId, t.agents.apollo, { type: "VolunteerAsJudge" }),
        "LICENCE_REQUIRED",
      );
    });

    it("a revoked licence no longer qualifies", async () => {
      const t = await createTestCourt();
      await t.court.revokeLicence(
        { agentId: t.agents.sol, licence: "JUDGE", reason: "Misconduct." },
        t.admin,
      );
      const { caseId } = await fileStandardCase(t);
      await expectCourtError(t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" }), "LICENCE_REQUIRED");
    });

    it("only one judge can take the bench", async () => {
      const t = await createTestCourt();
      const { caseId } = await fileStandardCase(t);
      await t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" });
      await expectCourtError(t.act(caseId, t.agents.iris, { type: "VolunteerAsJudge" }), "SEAT_OCCUPIED");
      await expectCourtError(t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" }), "DUPLICATE");
    });

    it("a side with counsel cannot take a second counsel", async () => {
      const t = await createTestCourt();
      const { caseId } = await fileStandardCase(t);
      await t.act(caseId, t.agents.maple, {
        type: "RequestCounsel",
        side: "PLAINTIFF",
        lawyerId: t.agents.apollo,
      });
      await t.act(caseId, t.agents.apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
      await expectCourtError(
        t.act(caseId, t.agents.maple, {
          type: "RequestCounsel",
          side: "PLAINTIFF",
          lawyerId: t.agents.athena,
        }),
        "SEAT_OCCUPIED",
      );
    });
  });

  describe("roster invariants (safety net)", () => {
    it("detects a roster that holds one agent in two roles", async () => {
      const t = await createTestCourt();
      const state = (await fileStandardCase(t)) as CaseState;
      const corrupted = structuredClone(state);
      corrupted.roles.push({ agentId: t.agents.maple, role: "JUDGE", current: true });
      try {
        assertRosterInvariants(corrupted, await t.court.getRegistry());
        expect.fail("expected an invariant violation");
      } catch (error) {
        expect(isCourtError(error, "INVARIANT_VIOLATION")).toBe(true);
      }
    });
  });
});

describe("permissions: the right agent must act", () => {
  it("only the defence side can answer the complaint", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "RespondToComplaint", response: "x" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.bob, { type: "RespondToComplaint", response: "x" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.court.act(caseId, SYSTEM, { type: "RespondToComplaint", response: "x" }),
      "NOT_PERMITTED",
    );
  });

  it("only the party itself can request counsel or choose self-representation", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "RequestCounsel", side: "PLAINTIFF" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.bob, { type: "DeclareSelfRepresentation", side: "DEFENCE" }),
      "NOT_PERMITTED",
    );
  });

  it("a named request can only be accepted by the named lawyer, and declined only by them", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.maple, {
      type: "RequestCounsel",
      side: "PLAINTIFF",
      lawyerId: t.agents.apollo,
    });
    await expectCourtError(
      t.act(caseId, t.agents.athena, { type: "AcceptRepresentation", side: "PLAINTIFF" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.athena, { type: "DeclineRepresentation", side: "PLAINTIFF" }),
      "NOT_FOUND",
    );
    const state = await t.act(caseId, t.agents.apollo, { type: "DeclineRepresentation", side: "PLAINTIFF" });
    expect(state.counselRequests.PLAINTIFF).toBeNull();
    await expectCourtError(
      t.act(caseId, t.agents.apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" }),
      "NOT_FOUND",
    );
  });

  it("a represented party cannot speak in its side's stage; its counsel must", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "MakeStatement", text: "Let me speak." }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.athena, { type: "MakeStatement", text: "Out of turn." }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "MakeStatement", text: "Judge interjects." }),
      "NOT_PERMITTED",
    );
  });

  it("a side speaks at most once per argument stage", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    await t.act(caseId, t.agents.apollo, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.athena, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.apollo, { type: "MakeStatement", text: "Evidence summary." });
    await expectCourtError(
      t.act(caseId, t.agents.apollo, { type: "MakeStatement", text: "Again." }),
      "LIMIT_EXCEEDED",
    );
  });

  it("only the presiding judge can put questions, rule, or dismiss", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    for (let i = 0; i < 4; i++)
      await t.act(caseId, i % 2 ? t.agents.athena : t.agents.apollo, { type: "ConcludeStage" });
    await expectCourtError(
      t.act(caseId, t.agents.iris, { type: "MakeStatement", text: "Q?", addressedTo: ["PLAINTIFF"] }),
      "NOT_PERMITTED",
    );
    await expectCourtError(t.act(caseId, t.agents.apollo, { type: "ConcludeStage" }), "NOT_PERMITTED");
    await expectCourtError(
      t.act(caseId, t.agents.iris, { type: "DismissCase", reason: "No." }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.court.act(caseId, SYSTEM, { type: "DismissCase", reason: "No." }),
      "NOT_PERMITTED",
    );
  });

  it("questions must name at least one side, and only addressed sides may answer", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    for (let i = 0; i < 4; i++)
      await t.act(caseId, i % 2 ? t.agents.athena : t.agents.apollo, { type: "ConcludeStage" });
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "MakeStatement", text: "Q?", addressedTo: [] }),
      "VALIDATION_FAILED",
    );
    await t.act(caseId, t.agents.sol, {
      type: "MakeStatement",
      text: "Plaintiff: why?",
      addressedTo: ["PLAINTIFF"],
    });
    await expectCourtError(
      t.act(caseId, t.agents.athena, { type: "MakeStatement", text: "Me too." }),
      "NOT_PERMITTED",
    );
  });

  it("only the plaintiff side can withdraw a case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "WithdrawCase", reason: "Please." }),
      "NOT_PERMITTED",
    );
    const state = await t.act(caseId, t.agents.maple, { type: "WithdrawCase", reason: "We sorted it out." });
    expect(state.outcome).toBe("WITHDRAWN");
  });

  it("a judge may dismiss a case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" });
    const state = await t.act(caseId, t.agents.sol, { type: "DismissCase", reason: "No law was broken." });
    expect(state.outcome).toBe("DISMISSED");
  });

  it("agents cannot register agents, grant licences, enact law or correct the record", async () => {
    const t = await createTestCourt();
    const agent = t.as(t.agents.maple);
    await expectCourtError(t.court.registerAgent({ handle: "sneaky" }, agent), "NOT_PERMITTED");
    await expectCourtError(
      t.court.grantLicence({ agentId: t.agents.maple, licence: "LAWYER" }, agent),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.court.enactLaw(
        JURISDICTION,
        { lawId: "new", article: 9, title: "New", text: "A brand new law text." },
        agent,
      ),
      "NOT_PERMITTED",
    );
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "CorrectRecord", targetStreamVersion: 1, note: "x" }),
      "NOT_PERMITTED",
    );
  });
});
