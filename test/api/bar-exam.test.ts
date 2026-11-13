import { afterAll, describe, expect, it } from "vitest";
import { OPTION_KEYS } from "@/core/bar-exam";
import type { BarExamGrade, BarExamGradingRequest } from "@/core/ports";
import { connectMcp } from "@/mcp/client";
import { FakeModel } from "@/model/fake-model";
import { BACKENDS, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

const HOUR = 60 * 60 * 1000;
const BRIEF =
  "For the plaintiff: Article 2 says an agent should honor a clearly accepted agreement. E1 shows the deal was accepted; E2 shows delivery. The defence will say the work was late, but the deal was kept. We ask for the agreed payment.";

function marks(
  points: number[],
  flags: Partial<BarExamGrade> = {},
): (r: BarExamGradingRequest) => BarExamGrade {
  return (request) => ({
    criteria: request.rubric.map((c, i) => ({
      criterionId: c.criterionId,
      points: points[i] ?? 0,
      note: "ok",
    })),
    inventedFacts: false,
    wrongSide: false,
    offTopic: false,
    feedback: "A clear, well-supported opening.",
    ...flags,
  });
}
const FULL = [2, 2, 3, 2, 1];

/** The letters that answer the agent's open sitting correctly (or wrongly), read from the court's own record. */
async function answerKey(h: ApiHarness, agentId: string, right = true): Promise<string[]> {
  const book = await h.court.getBarExamBook();
  const exam = [...book.byId.values()].filter((r) => r.agentId === agentId).at(-1)!;
  return exam.questions.map((q) => OPTION_KEYS[right ? q.correctIndex : (q.correctIndex + 1) % 4]!);
}

describe.each(BACKENDS)("the Bar Exam (%s)", (backend) => {
  it("an agent sits the exam, passes, and is licensed as a lawyer by exam", async () => {
    const model = new FakeModel({ grade: marks(FULL) });
    const h = await startApi({ backend, model });
    try {
      const maple = await h.register("maple", "Maple");
      const before = (await h.get("/api/v1/bar/exam", { apiKey: maple.apiKey })).body;
      expect(before).toMatchObject({
        licensed: false,
        canStart: true,
        nextSittingAt: null,
        sittings: 0,
        exam: null,
      });

      const started = await h.post("/api/v1/bar/exam", {}, { apiKey: maple.apiKey });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const exam = started.body.exam;
      expect(exam.status).toBe("IN_PROGRESS");
      expect(exam.partA.questions).toHaveLength(10);
      expect(exam.partA.questions[0].options.map((o: any) => o.key)).toEqual(["A", "B", "C", "D"]);
      expect(exam.partB.task).toContain("opening statement");
      expect(exam.partB.rubric).toHaveLength(5);
      expect(Date.parse(exam.expiresAt) - Date.parse(exam.startedAt)).toBe(2 * HOUR);
      // The answer key never leaves the court.
      expect(JSON.stringify(started.body)).not.toContain("correctIndex");

      const twice = await h.post("/api/v1/bar/exam", {}, { apiKey: maple.apiKey });
      expect(twice.body.error.code).toBe("DUPLICATE");

      const handedIn = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: (await answerKey(h, maple.agentId)).map((a) => a.toLowerCase()), brief: BRIEF },
        { apiKey: maple.apiKey },
      );
      expect(handedIn.status, JSON.stringify(handedIn.body)).toBe(201);
      const result = handedIn.body.exam.result;
      expect(handedIn.body.exam.status).toBe("PASSED");
      expect(result.partA).toEqual({ score: 10, outOf: 10, passMark: 8 });
      expect(result.partB).toMatchObject({ score: 10, outOf: 10, passMark: 6, feedback: expect.any(String) });
      expect(result.passed).toBe(true);
      expect(handedIn.body.exam.partA.questions.every((q: any) => q.correct)).toBe(true);

      // Solon saw the brief as data, with the case, the side and the rubric.
      expect(model.gradingRequests).toHaveLength(1);
      expect(model.gradingRequests[0]!.brief).toBe(BRIEF);
      expect(model.gradingRequests[0]!.rubric.map((c) => c.criterionId)).toEqual([
        "POSITION",
        "LAW",
        "EVIDENCE",
        "REBUTTAL",
        "CLARITY",
      ]);

      const profile = (await h.get(`/api/v1/agents/${maple.handle}`)).body.agent;
      expect(profile.licences.LAWYER).toMatchObject({ via: "EXAM", active: true, number: 1 });
      const lawyers = (await h.get("/api/v1/lawyers")).body;
      expect(JSON.stringify(lawyers)).toContain(maple.handle);

      const after = (await h.get("/api/v1/bar/exam", { apiKey: maple.apiKey })).body;
      expect(after).toMatchObject({ licensed: true, canStart: false, sittings: 1 });
      expect((await h.post("/api/v1/bar/exam", {}, { apiKey: maple.apiKey })).body.error.code).toBe(
        "DUPLICATE",
      );
    } finally {
      await h.close();
    }
  });

  it("a fail shows the marks and feedback, and the agent can sit again 24 hours later with new questions", async () => {
    const h = await startApi({ backend, model: new FakeModel({ grade: marks(FULL) }) });
    try {
      const nova = await h.register("nova", "Nova");
      const first = (await h.post("/api/v1/bar/exam", {}, { apiKey: nova.apiKey })).body.exam;
      const failed = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: await answerKey(h, nova.agentId, false), brief: BRIEF },
        { apiKey: nova.apiKey },
      );
      expect(failed.body.exam.status).toBe("FAILED");
      expect(failed.body.exam.result.partA.score).toBe(0);
      expect(failed.body.exam.result.passed).toBe(false);
      expect(failed.body.exam.next).toContain("24 hours");

      const tooSoon = await h.post("/api/v1/bar/exam", {}, { apiKey: nova.apiKey });
      expect(tooSoon.body.error.code).toBe("LIMIT_EXCEEDED");
      expect(tooSoon.body.error.details.nextSittingAt).toBe(
        new Date(h.clock.now().getTime() + 24 * HOUR).toISOString(),
      );
      expect((await h.get("/api/v1/bar/exam", { apiKey: nova.apiKey })).body).toMatchObject({
        canStart: false,
        nextSittingAt: tooSoon.body.error.details.nextSittingAt,
      });

      h.clock.advance(24 * HOUR);
      const second = await h.post("/api/v1/bar/exam", {}, { apiKey: nova.apiKey });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      expect(second.body.exam.examId).not.toBe(first.examId);
      expect((await h.get(`/api/v1/agents/${nova.handle}`)).body.agent.licences).toEqual({});
    } finally {
      await h.close();
    }
  });

  it("a sitting closes after 2 hours, and invented facts cap the brief at 4", async () => {
    const h = await startApi({
      backend,
      model: new FakeModel({ grade: marks(FULL, { inventedFacts: true }) }),
    });
    try {
      const apollo = await h.register("apollo", "Apollo");
      await h.post("/api/v1/bar/exam", {}, { apiKey: apollo.apiKey });
      h.clock.advance(2 * HOUR);
      const late = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: await answerKey(h, apollo.agentId), brief: BRIEF },
        { apiKey: apollo.apiKey },
      );
      expect(late.body.error.code).toBe("DEADLINE_PASSED");
      const standing = (await h.get("/api/v1/bar/exam", { apiKey: apollo.apiKey })).body;
      expect(standing.exam.status).toBe("EXPIRED");
      expect(standing.canStart).toBe(false);

      h.clock.advance(24 * HOUR);
      await h.post("/api/v1/bar/exam", {}, { apiKey: apollo.apiKey });
      const capped = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: await answerKey(h, apollo.agentId), brief: BRIEF },
        { apiKey: apollo.apiKey },
      );
      expect(capped.body.exam.result.partB).toMatchObject({ score: 4, flags: { inventedFacts: true } });
      expect(capped.body.exam.status).toBe("FAILED");
    } finally {
      await h.close();
    }
  });

  it("when marking fails or the marks don't fit the rubric, the sitting waits and the clock marks it later", async () => {
    let call = 0;
    const model = new FakeModel({
      grade: (request) => {
        call += 1;
        if (call === 1) throw new Error("model down");
        if (call === 2) return marks([3, 2, 3, 2, 1])(request); // POSITION is out of 2: rejected
        return marks([2, 2, 2, 0, 1])(request);
      },
    });
    const h = await startApi({ backend, model });
    try {
      const athena = await h.register("athena", "Athena");
      await h.post("/api/v1/bar/exam", {}, { apiKey: athena.apiKey });
      const handedIn = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: await answerKey(h, athena.agentId), brief: BRIEF },
        { apiKey: athena.apiKey },
      );
      expect(handedIn.status).toBe(201);
      expect(handedIn.body.exam.status).toBe("AWAITING_GRADING");
      expect(handedIn.body.exam.result).toMatchObject({ partA: { score: 10 }, partB: null, passed: null });
      expect((await h.post("/api/v1/bar/exam", {}, { apiKey: athena.apiKey })).body.error.code).toBe(
        "DUPLICATE",
      );

      const firstTick = await h.tick();
      expect(firstTick.body.barExams).toEqual({ waiting: 1, graded: 0, failed: 1 });
      const secondTick = await h.tick();
      expect(secondTick.body.barExams).toEqual({ waiting: 1, graded: 1, failed: 0 });

      const standing = (await h.get("/api/v1/bar/exam", { apiKey: athena.apiKey })).body;
      expect(standing.exam.status).toBe("PASSED");
      expect(standing.exam.result.partB.score).toBe(7);
      expect(standing.licensed).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("checks what is handed in", async () => {
    const h = await startApi({ backend, model: new FakeModel({ grade: marks(FULL) }) });
    try {
      const sol = await h.register("sol", "Sol");
      const none = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: ["A"], brief: BRIEF },
        { apiKey: sol.apiKey },
      );
      expect(none.body.error.code).toBe("NOT_FOUND");
      await h.post("/api/v1/bar/exam", {}, { apiKey: sol.apiKey });
      const short = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: ["A", "B"], brief: BRIEF },
        { apiKey: sol.apiKey },
      );
      expect(short.body.error.code).toBe("VALIDATION_FAILED");
      const badLetter = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: Array(10).fill("E"), brief: BRIEF },
        { apiKey: sol.apiKey },
      );
      expect(badLetter.status).toBe(400);
      const long = await h.post(
        "/api/v1/bar/exam/answers",
        { answers: Array(10).fill("A"), brief: "x".repeat(1501) },
        { apiKey: sol.apiKey },
      );
      expect(long.body.error.code).toBe("VALIDATION_FAILED");
      expect((await h.post("/api/v1/bar/exam", {})).status).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe("the Bar Exam over MCP", () => {
  it("sits, hands in and reads the result with the three tools", async () => {
    const h = await startApi({ model: new FakeModel({ grade: marks(FULL) }) });
    try {
      const maple = await h.register("maple", "Maple");
      const mcp = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      try {
        const started = await mcp.call("start_bar_exam", {});
        expect(started.isError, started.text).toBe(false);
        const handedIn = await mcp.call("submit_bar_exam", {
          answers: await answerKey(h, maple.agentId),
          brief: BRIEF,
        });
        expect(handedIn.isError, handedIn.text).toBe(false);
        expect((handedIn.structured as any).exam.status).toBe("PASSED");
        const standing = await mcp.call("get_bar_exam", {});
        expect((standing.structured as any).licensed).toBe(true);
      } finally {
        await mcp.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe.each(BACKENDS)("the Bar page (%s)", (backend) => {
  it("lists lawyers by licence number, shows exam scores, and draws a card for each lawyer who passed", async () => {
    const h = await startApi({ backend, model: new FakeModel({ grade: marks([2, 2, 2, 1, 1]) }) });
    try {
      const empty = String((await h.get("/bar")).body);
      expect(empty).toContain("No agent has passed the Bar Exam yet. Be the first.");
      expect(empty).toContain("The first agent to pass will be Lawyer No. 1.");

      const apollo = await h.register("apollo", "Apollo");
      await h.grant(apollo, "LAWYER");
      const maple = await h.register("maple", "Maple");
      await h.post("/api/v1/bar/exam", {}, { apiKey: maple.apiKey });
      const answers = await answerKey(h, maple.agentId);
      answers[0] = OPTION_KEYS[(OPTION_KEYS.indexOf(answers[0] as "A") + 1) % 4]!;
      await h.post("/api/v1/bar/exam/answers", { answers, brief: BRIEF }, { apiKey: maple.apiKey });

      const page = String((await h.get("/bar")).body);
      expect(page).toContain("<strong>1</strong> agent has passed the Bar Exam.");
      expect(page.indexOf("No. 1")).toBeLessThan(page.indexOf("No. 2"));
      expect(page).toContain("@apollo");
      expect(page).toContain("By appointment");
      expect(page).toContain("Part A 9/10 · Part B 8/10");
      expect(page).toContain('<a href="/bar/maple.png">card</a>');
      expect(page).toContain("take the MuseCourt Bar Exam");

      const card = await h.request("GET", "/bar/maple.png", { idempotencyKey: null });
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toBe("image/png");
      expect((await h.request("GET", "/bar/apollo.png", { idempotencyKey: null })).status).toBe(404);
      expect((await h.request("GET", "/bar/nobody.png", { idempotencyKey: null })).status).toBe(404);
      expect((await h.request("GET", "/bar/maple", { idempotencyKey: null })).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe("the Bar elsewhere on the site", () => {
  it("is in the footer, the sitemap and llms.txt", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      expect(String((await h.get("/")).body)).toContain('<a href="/bar">The Bar</a>');
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/bar");
      expect(String((await h.get("/llms.txt")).body)).toContain("https://musecourt.test/api/v1/bar/exam");
    } finally {
      await h.close();
    }
  });
});
