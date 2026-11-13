import { describe, expect, it } from "vitest";
import { BAR_EXAM, drawBarExam, optionIndex, partBScore } from "@/core/bar-exam";
import { PART_A_POOL, PART_B_POOL, PART_B_RUBRIC } from "@/core/bar-exam-pool";

describe("the Bar Exam pool", () => {
  it("has 40 distinct questions with four distinct options each, and six cases", () => {
    expect(PART_A_POOL).toHaveLength(40);
    expect(new Set(PART_A_POOL.map((q) => q.questionId)).size).toBe(40);
    for (const q of PART_A_POOL) {
      expect(new Set([q.correct, ...q.wrong]).size, q.questionId).toBe(4);
    }
    expect(PART_B_POOL).toHaveLength(6);
    for (const c of PART_B_POOL) {
      expect(c.evidence.length, c.caseId).toBeGreaterThan(0);
      expect(["agreements", "property"]).toContain(c.law.lawId);
    }
  });

  it("marks Part B out of 10", () => {
    expect(PART_B_RUBRIC.reduce((sum, c) => sum + c.points, 0)).toBe(BAR_EXAM.partBMax);
  });
});

describe("drawing a sitting", () => {
  it("draws 10 different questions, shuffles the options and keeps the right answer's position", () => {
    const exam = drawBarExam("seed_1");
    expect(exam.questions).toHaveLength(10);
    expect(new Set(exam.questions.map((q) => q.questionId)).size).toBe(10);
    for (const q of exam.questions) {
      const source = PART_A_POOL.find((p) => p.questionId === q.questionId)!;
      expect(q.options[q.correctIndex]).toBe(source.correct);
      expect([...q.options].sort()).toEqual([source.correct, ...source.wrong].sort());
    }
    expect(PART_B_POOL.map((c) => c.caseId)).toContain(exam.case.caseId);
    expect(["PLAINTIFF", "DEFENCE"]).toContain(exam.side);
  });

  it("is the same for the same seed and varies across seeds", () => {
    expect(drawBarExam("seed_1")).toEqual(drawBarExam("seed_1"));
    const draws = Array.from({ length: 30 }, (_, i) => drawBarExam(`seed_${i}`));
    expect(new Set(draws.map((d) => d.questions.map((q) => q.questionId).join())).size).toBeGreaterThan(25);
    expect(new Set(draws.map((d) => d.case.caseId)).size).toBeGreaterThan(3);
    expect(new Set(draws.map((d) => d.side)).size).toBe(2);
    expect(new Set(draws.flatMap((d) => d.questions.map((q) => q.correctIndex))).size).toBe(4);
  });
});

describe("marking rules", () => {
  it("reads answers as letters or indexes", () => {
    expect(optionIndex("b")).toBe(1);
    expect(optionIndex(" D ")).toBe(3);
    expect(optionIndex(0)).toBe(0);
    expect(optionIndex("E")).toBeNull();
    expect(optionIndex(4)).toBeNull();
    expect(optionIndex(null)).toBeNull();
  });

  it("adds up the criteria, caps invented facts at 4, and scores the wrong side or off topic 0", () => {
    const full = [{ points: 2 }, { points: 2 }, { points: 3 }, { points: 2 }, { points: 1 }];
    const none = { inventedFacts: false, wrongSide: false, offTopic: false };
    expect(partBScore(full, none)).toBe(10);
    expect(partBScore(full, { ...none, inventedFacts: true })).toBe(4);
    expect(partBScore([{ points: 3 }], { ...none, inventedFacts: true })).toBe(3);
    expect(partBScore(full, { ...none, wrongSide: true })).toBe(0);
    expect(partBScore(full, { ...none, offTopic: true })).toBe(0);
  });
});
