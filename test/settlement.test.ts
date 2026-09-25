import { describe, expect, it } from "vitest";
import {
  createTestCourt,
  driveToDeliberation,
  driveToTrial,
  expectCourtError,
  fileStandardCase,
} from "./helpers";

describe("settlements", () => {
  it("an accepted offer closes the case as SETTLED with no judge needed", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    let state = await t.act(caseId, t.agents.nova, {
      type: "OfferSettlement",
      terms: "I'll return 7 timber and apologise.",
    });
    const offerId = state.offers[0]!.offerId;
    state = await t.act(caseId, t.agents.maple, { type: "RespondToSettlement", offerId, decision: "ACCEPT" });
    expect(state.status).toBe("CLOSED");
    expect(state.outcome).toBe("SETTLED");
    expect(state.judge).toBeNull();
    expect(state.offers[0]!.status).toBe("ACCEPTED");
  });

  it("counsel may negotiate for their side", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    const state = await t.act(caseId, t.agents.athena, {
      type: "OfferSettlement",
      terms: "Return 5 timber.",
    });
    const closed = await t.act(caseId, t.agents.apollo, {
      type: "RespondToSettlement",
      offerId: state.offers[0]!.offerId,
      decision: "ACCEPT",
    });
    expect(closed.outcome).toBe("SETTLED");
  });

  it("settlement is possible right up to the verdict", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    const state = await t.act(caseId, t.agents.maple, {
      type: "OfferSettlement",
      terms: "Split the timber.",
    });
    const closed = await t.act(caseId, t.agents.nova, {
      type: "RespondToSettlement",
      offerId: state.offers[0]!.offerId,
      decision: "ACCEPT",
    });
    expect(closed.outcome).toBe("SETTLED");
  });

  it("a side cannot accept its own offer; outsiders cannot offer or answer", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const state = await t.act(caseId, t.agents.maple, { type: "OfferSettlement", terms: "Pay me back." });
    const offerId = state.offers[0]!.offerId;
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "RespondToSettlement", offerId, decision: "ACCEPT" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.bob, { type: "RespondToSettlement", offerId, decision: "ACCEPT" }),
      "NOT_PERMITTED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.bob, { type: "OfferSettlement", terms: "Me too." }),
      "NOT_PERMITTED",
    );
  });

  it("the judge is not a party to settlement", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" });
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "OfferSettlement", terms: "Settle!" }),
      "NOT_PERMITTED",
    );
  });

  it("rejection keeps the case open; a new offer supersedes the side's previous one", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    let state = await t.act(caseId, t.agents.nova, { type: "OfferSettlement", terms: "Return 2 timber." });
    const first = state.offers[0]!.offerId;
    state = await t.act(caseId, t.agents.maple, {
      type: "RespondToSettlement",
      offerId: first,
      decision: "REJECT",
    });
    expect(state.status).toBe("OPEN");
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "RespondToSettlement", offerId: first, decision: "ACCEPT" }),
      "NOT_FOUND",
    );

    await t.act(caseId, t.agents.nova, { type: "OfferSettlement", terms: "Return 3 timber." });
    state = await t.act(caseId, t.agents.nova, { type: "OfferSettlement", terms: "Return 4 timber." });
    expect(state.offers.map((o) => o.status)).toEqual(["REJECTED", "SUPERSEDED", "OPEN"]);
  });

  it("only the offering side can withdraw an offer", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const state = await t.act(caseId, t.agents.nova, { type: "OfferSettlement", terms: "Return 2 timber." });
    const offerId = state.offers[0]!.offerId;
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "WithdrawSettlementOffer", offerId }),
      "NOT_PERMITTED",
    );
    const after = await t.act(caseId, t.agents.nova, { type: "WithdrawSettlementOffer", offerId });
    expect(after.offers[0]!.status).toBe("WITHDRAWN");
  });

  it("rejects an invalid decision", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const state = await t.act(caseId, t.agents.nova, { type: "OfferSettlement", terms: "Return 2 timber." });
    await expectCourtError(
      t.act(caseId, t.agents.maple, {
        type: "RespondToSettlement",
        offerId: state.offers[0]!.offerId,
        decision: "MAYBE" as "ACCEPT",
      }),
      "VALIDATION_FAILED",
    );
  });
});
