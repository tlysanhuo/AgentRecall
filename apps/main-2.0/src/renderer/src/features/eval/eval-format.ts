import { localize, type LanguageMode } from "../../language";
import type { EvaluationNodeRecord } from "../../../../automation/contracts";

/**
 * Formatting shared by the Eval pages.
 *
 * Kept separate from the page components so the graph page and the skill page
 * can both use it without importing each other.
 */

export function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = value / 1000;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

export function formatRatio(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function runStatusText(language: LanguageMode, status: string): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (status === "completed") return l("Completed", "完成");
  if (status === "failed") return l("Failed", "失败");
  if (status === "cancelled") return l("Cancelled", "已取消");
  if (status === "running") return l("Running", "运行中");
  return l("Pending", "等待中");
}

const NODE_LABELS: Record<string, [string, string]> = {
  task_source: ["Task", "任务"],
  skill_provision: ["Skill", "Skill 注入"],
  agent_execute: ["Agent run", "Agent 执行"],
  session_link: ["Session link", "会话关联"],
  evidence_extract: ["Trace", "轨迹提取"],
  skill_use_observe: ["Skill use", "Skill 使用"],
  deterministic_judge: ["Check", "确定性判定"],
  llm_judge: ["LLM judge", "模型评判"],
};

export function nodeLabel(language: LanguageMode, node: EvaluationNodeRecord): string {
  const label = NODE_LABELS[node.nodeType];
  return label ? localize(language, label[0], label[1]) : node.nodeType;
}

export function nodeStatusText(
  language: LanguageMode,
  status: EvaluationNodeRecord["status"],
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (status === "pass") return l("done", "完成");
  if (status === "fail") return l("failed", "失败");
  if (status === "excused") return l("excused", "无法判定");
  if (status === "error") return l("error", "出错");
  if (status === "disabled") return l("off", "已停用");
  return l("skipped", "未执行");
}

export function nodeStatusClass(status: EvaluationNodeRecord["status"]): string {
  if (status === "pass") return "eval-badge-current";
  if (status === "fail") return "eval-badge-warn";
  return "eval-badge-dim";
}

/**
 * Human wording for why a node produced nothing.
 *
 * The distinction the copy has to preserve: an excused step means the
 * evaluation could not judge, not that the agent did badly.
 */
export function nodeReasonText(language: LanguageMode, reason: string): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const known: Record<string, [string, string]> = {
    case_cancelled: ["the run was cancelled", "运行已取消"],
    judge_runtime_not_configured: ["the judge has no Runtime channel", "评判器未配置 Runtime 通道"],
    judge_executor_unavailable: ["no execution Agent for the judge", "评判器没有可用的执行 Agent"],
    judge_output_unparseable: ["the judge did not return usable JSON", "评判器没有返回可解析的 JSON"],
    judge_score_missing: ["the judge returned no score", "评判器没有给出分数"],
    expected_output_missing: ["the case has no expected output", "该用例没有期望输出"],
    skill_not_readable: ["the selected skill could not be read", "读不到所选的 Skill"],
    skill_reader_unavailable: ["skill injection is unavailable", "Skill 注入不可用"],
    runtime_reported_no_session: ["the runtime reported no session", "Runtime 没有返回会话标识"],
    session_not_indexed: ["the session was not indexed in time", "会话尚未完成索引"],
    session_lookup_unavailable: ["session lookup is unavailable", "会话查询不可用"],
    trace_not_available: ["the session trace is unavailable", "读不到会话轨迹"],
    trace_reader_unavailable: ["trace reading is unavailable", "轨迹读取不可用"],
    cancelled_before_session_link: ["cancelled before linking the session", "关联会话前已取消"],
    upstream_not_pass: ["an earlier step did not pass", "上游步骤未通过"],
    upstream_skipped: ["an earlier step was skipped", "上游步骤被跳过"],
    not_decided: ["the run ended first", "运行提前结束"],
  };
  const match = known[reason];
  return match ? l(match[0], match[1]) : reason;
}

/** Observation text for the verdict-free skill-use node. */
export function skillUseText(
  language: LanguageMode,
  facts: Record<string, unknown> | undefined,
): string | null {
  if (!facts || facts.injected !== true) return null;
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (facts.used === true) return l("skill was used", "使用了该 Skill");
  if (facts.used === false) return l("skill went unused", "未使用该 Skill");
  return l("skill use is not observable", "无法观测是否使用");
}
