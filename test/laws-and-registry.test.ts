import { describe, expect, it } from "vitest";
import { currentLaws } from "@/core/jurisdiction";
import { FOUNDING_LAWS } from "@/seed/laws";
import {
  createTestCourt,
  driveToDeliberation,
  expectCourtError,
  fileStandardCase,
  JURISDICTION,
} from "./helpers";

describe("versioned laws", () => {
  it("seeds the five founding laws at version 1", async () => {
    const t = await createTestCourt();
    const laws = currentLaws((await t.court.getJurisdiction(JURISDICTION))!);
    expect(laws.map((l) => [l.article, l.lawId, l.title, l.version])).toEqual([
      [1, "property", "Property", 1],
      [2, "agreements", "Agreements", 1],
      [3, "fraud", "Fraud", 1],
      [4, "interference", "Interference", 1],
      [5, "court-integrity", "Court Integrity", 1],
    ]);
    expect(laws[0]!.text).toBe(FOUNDING_LAWS[0]!.text);
  });

  it("amending a law creates a new version and keeps the old one", async () => {
    const t = await createTestCourt();
    const j = await t.court.enactLaw(
      JURISDICTION,
      {
        lawId: "property",
        article: 1,
        title: "Property",
        text: "An agent must not take another agent's things.",
      },
      t.admin,
    );
    expect(j.laws.get("property")!.map((l) => l.version)).toEqual([1, 2]);
  });

  it("a case keeps the law version in force when it was filed", async () => {
    const t = await createTestCourt();
    const before = await fileStandardCase(t);
    await t.court.enactLaw(
      JURISDICTION,
      { lawId: "property", article: 1, title: "Property", text: "Amended: taking is fine on weekends." },
      t.admin,
    );
    const after = await fileStandardCase(t, { evidence: [] });

    const oldCase = (await t.court.getCase(before.caseId))!;
    expect(oldCase.charges[0]).toMatchObject({ lawId: "property", version: 1, text: FOUNDING_LAWS[0]!.text });
    expect(after.charges[0]).toMatchObject({
      lawId: "property",
      version: 2,
      text: "Amended: taking is fine on weekends.",
    });
  });

  it("a verdict can only cite laws charged in the case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    await expectCourtError(
      t.act(caseId, t.agents.sol, {
        type: "IssueVerdict",
        finding: "LIABLE",
        reasoning: "Fraud!",
        sentence: [{ kind: "WARNING", description: "Don't." }],
        citedLawIds: ["fraud"],
      }),
      "VALIDATION_FAILED",
    );
  });

  it("rejects unknown laws, empty charges and duplicate charges when filing", async () => {
    const t = await createTestCourt();
    await expectCourtError(fileStandardCase(t, { lawIds: ["theft"] }), "NOT_FOUND");
    await expectCourtError(fileStandardCase(t, { lawIds: [] }), "VALIDATION_FAILED");
    await expectCourtError(fileStandardCase(t, { lawIds: ["property", "property"] }), "VALIDATION_FAILED");
  });

  it("rejects bad law definitions", async () => {
    const t = await createTestCourt();
    const enact = (input: { lawId: string; article: number; title: string; text: string }) =>
      t.court.enactLaw(JURISDICTION, input, t.admin);
    await expectCourtError(
      enact({ lawId: "new-law", article: 1, title: "Clash", text: "Uses article one." }),
      "DUPLICATE",
    );
    await expectCourtError(
      enact({ lawId: "property", article: 7, title: "Property", text: "Moves the article." }),
      "VALIDATION_FAILED",
    );
    await expectCourtError(
      enact({ lawId: "property", article: 1, title: "Property", text: FOUNDING_LAWS[0]!.text }),
      "DUPLICATE",
    );
    await expectCourtError(
      enact({ lawId: "Bad Id", article: 9, title: "X", text: "Some valid text." }),
      "VALIDATION_FAILED",
    );
    await expectCourtError(t.court.enactLaw("nowhere", FOUNDING_LAWS[0]!, t.admin), "NOT_FOUND");
  });

  it("validates jurisdictions", async () => {
    const t = await createTestCourt();
    await expectCourtError(
      t.court.establishJurisdiction(
        { jurisdictionId: JURISDICTION, name: "Again", casePrefix: "AG" },
        t.admin,
      ),
      "DUPLICATE",
    );
    await expectCourtError(
      t.court.establishJurisdiction({ jurisdictionId: "x", name: "X", casePrefix: "lower" }, t.admin),
      "VALIDATION_FAILED",
    );
  });
});

describe("agent registry", () => {
  it("registers agents with unique, case-insensitive handles", async () => {
    const t = await createTestCourt();
    await expectCourtError(t.court.registerAgent({ handle: "MAPLE" }), "DUPLICATE");
    await expectCourtError(t.court.registerAgent({ handle: "has space" }), "VALIDATION_FAILED");
    await expectCourtError(t.court.registerAgent({ handle: "x" }), "VALIDATION_FAILED");
    const agent = await t.court.registerAgent({ handle: "newbie" });
    expect(agent).toMatchObject({ handle: "newbie", displayName: "newbie", ownerRef: null, licences: {} });
  });

  it("links a world identity at most once", async () => {
    const t = await createTestCourt();
    const world = { connectorId: "fake-world", worldAgentId: "nova" };
    await t.court.registerAgent({ handle: "nova-mc", world });
    await expectCourtError(t.court.registerAgent({ handle: "nova-copy", world }), "DUPLICATE");
  });

  it("numbers licences sequentially per type", async () => {
    const t = await createTestCourt();
    const registry = await t.court.getRegistry();
    const lawyerNumbers = [...registry.agents.values()].flatMap((a) =>
      a.licences.LAWYER ? [a.licences.LAWYER.number] : [],
    );
    expect(lawyerNumbers).toEqual([1, 2, 3, 4]);
    expect(registry.agents.get(t.agents.iris)!.licences.JUDGE).toMatchObject({ number: 2, via: "ADMIN" });
  });

  it("a judge licence requires a lawyer licence; licences cannot be granted twice", async () => {
    const t = await createTestCourt();
    await expectCourtError(
      t.court.grantLicence({ agentId: t.agents.bob, licence: "JUDGE" }, t.admin),
      "LICENCE_REQUIRED",
    );
    await expectCourtError(
      t.court.grantLicence({ agentId: t.agents.apollo, licence: "LAWYER" }, t.admin),
      "DUPLICATE",
    );
    await expectCourtError(
      t.court.grantLicence({ agentId: "agent_missing", licence: "LAWYER" }, t.admin),
      "NOT_FOUND",
    );
  });

  it("revoking a lawyer licence also ends a judge licence; only admins revoke", async () => {
    const t = await createTestCourt();
    await expectCourtError(
      t.court.revokeLicence({ agentId: t.agents.sol, licence: "LAWYER", reason: "x" }, t.as(t.agents.maple)),
      "NOT_AUTHORIZED",
    );
    const sol = await t.court.revokeLicence(
      { agentId: t.agents.sol, licence: "LAWYER", reason: "Fabricated evidence." },
      t.admin,
    );
    expect(sol.licences.LAWYER!.revokedAt).not.toBeNull();
    expect(sol.licences.JUDGE!.revokedAt).not.toBeNull();
    await expectCourtError(
      t.court.revokeLicence({ agentId: t.agents.sol, licence: "LAWYER", reason: "Again." }, t.admin),
      "NOT_FOUND",
    );
  });

  it("the system actor grants licences as EXAM (reserved for the Bar Exam in Phase 7)", async () => {
    const t = await createTestCourt();
    const bob = await t.court.grantLicence({ agentId: t.agents.bob, licence: "LAWYER" }, { kind: "system" });
    expect(bob.licences.LAWYER!.via).toBe("EXAM");
  });

  it("cannot file against an unregistered agent", async () => {
    const t = await createTestCourt();
    await expectCourtError(fileStandardCase(t, { defendant: "agent_ghost" }), "NOT_FOUND");
  });
});

describe("handle normalisation", () => {
  it("stores the NFKC lower-case form and rejects reserved names", async () => {
    const t = await createTestCourt();
    const agent = await t.court.registerAgent({ handle: "  Ｗｉｌｌｏｗ " });
    expect(agent.handle).toBe("willow");
    for (const reserved of ["Solon", "admin", "MUSECOURT", "house-judge", "system", "me"]) {
      await expectCourtError(t.court.registerAgent({ handle: reserved }), "VALIDATION_FAILED");
    }
    await expectCourtError(
      t.court.registerAgent({ handle: "fine", displayName: "bad\u0007bell" }),
      "VALIDATION_FAILED",
    );
  });
});
