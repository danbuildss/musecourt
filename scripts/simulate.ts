import { join } from "node:path";
import { loadSkillMarkdown } from "@/api/skill";
import { BANKR_DEFAULT_MODEL, BankrChatModel, BankrCostMeter } from "@/model/bankr";
import { writeSimulationReport } from "@/sim/report";
import { runSimulation } from "@/sim/runner";

/**
 * Phase 4 live simulation on the Bankr LLM Gateway.
 *   BANKR_API_KEY (or BANKR_LLM_KEY)   required; never logged
 *   MUSECOURT_MODEL                    Solon's model (default: gpt-5.4, per Bankr's model table)
 *   MUSECOURT_AGENT_MODEL              the agents' model (default: MUSECOURT_MODEL)
 *   MUSECOURT_LLM_BASE_URL             default https://llm.bankr.bot/v1
 */
if (!process.env.BANKR_API_KEY && !process.env.BANKR_LLM_KEY) {
  console.error("Set BANKR_API_KEY (an API key with LLM Gateway enabled and credits > $0).");
  process.exit(2);
}
const solonModelId = process.env.MUSECOURT_MODEL || BANKR_DEFAULT_MODEL;
const agentModelId = process.env.MUSECOURT_AGENT_MODEL || solonModelId;

const report = await runSimulation({
  skillMarkdown: loadSkillMarkdown(),
  agentModel: () => BankrChatModel.fromEnv(process.env, agentModelId),
  solonChat: BankrChatModel.fromEnv(process.env, solonModelId),
  modelIds: { agent: agentModelId, solon: solonModelId },
  costMeter: BankrCostMeter.fromEnv(),
  log: (line) => console.log(`[sim] ${line}`),
});
const dir = join(process.cwd(), "sim-output", report.startedAt.replace(/[:.]/g, "-"));
const file = await writeSimulationReport(report, dir);
console.log(`\n${report.success ? "SUCCESS" : "FAILED"} — report: ${file}`);
process.exit(report.success ? 0 : 1);
