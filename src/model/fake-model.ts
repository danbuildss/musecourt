import type {
  BarExamGrade,
  BarExamGradingRequest,
  CourtModel,
  HouseJudgmentDraft,
  HouseJudgmentRequest,
} from "@/core/ports";

type Responder<Req, Res> = (request: Req) => Res | Promise<Res>;

/** Scriptable model for tests and offline simulations. Records every request. */
export class FakeModel implements CourtModel {
  readonly judgmentRequests: HouseJudgmentRequest[] = [];
  readonly gradingRequests: BarExamGradingRequest[] = [];

  constructor(
    private readonly responders: {
      judgment?: Responder<HouseJudgmentRequest, HouseJudgmentDraft>;
      grade?: Responder<BarExamGradingRequest, BarExamGrade>;
    } = {},
  ) {}

  async draftHouseJudgment(request: HouseJudgmentRequest): Promise<HouseJudgmentDraft> {
    this.judgmentRequests.push(request);
    if (!this.responders.judgment) throw new Error("FakeModel: no judgment responder configured");
    return this.responders.judgment(request);
  }

  async gradeBarExam(request: BarExamGradingRequest): Promise<BarExamGrade> {
    this.gradingRequests.push(request);
    if (!this.responders.grade) throw new Error("FakeModel: no grading responder configured");
    return this.responders.grade(request);
  }
}
