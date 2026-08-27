import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationPass,
  type EvaluationNodeVerdict,
  type EvaluationVerdictStatus,
} from "../graph/node";
import {
  EXECUTION_PORT,
  TASK_PORT,
  type EvaluationNodeDependencies,
} from "./contracts";

/**
 * The `judge` half of the evaluation graph.
 *
 * The rule these all follow: a judge either decides, or says it could not.
 * "Could not" is `excused` and is excluded from the score — a judge with no
 * runtime, or one whose model returned prose instead of JSON, has learned
 * nothing about the agent, and recording that as a zero is how an evaluation
 * ends up blaming the agent for its own broken plumbing.
 */

export const DETERMINISTIC_JUDGE_NODE_TYPE = "deterministic_judge";
export const LLM_JUDGE_NODE_TYPE = "llm_judge";

export type DeterministicEvaluatorKind = "exact_match" | "contains" | "json_valid";

export interface DeterministicJudgeConfig {
  evaluatorId: string;
  kind: DeterministicEvaluatorKind;
  threshold: number;
}

function verdictStatus(raw: number, threshold: number): EvaluationVerdictStatus {
  return raw >= threshold ? "met" : "unmet";
}

function buildVerdict(input: {
  nodeId: string;
  evaluatorId: string;
  raw: number;
  threshold: number;
  labels: Record<string, string>;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  durationMs?: number;
}): EvaluationNodeVerdict {
  return {
    verdictId: `${input.nodeId}:${input.evaluatorId}`,
    evaluatorId: input.evaluatorId,
    labels: input.labels,
    status: verdictStatus(input.raw, input.threshold),
    raw: input.raw,
    threshold: input.threshold,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
    ...(input.failedCriteria && input.failedCriteria.length > 0
      ? { failedCriteria: input.failedCriteria }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/** Exact-match, substring and JSON-shape checks. No model involved. */
export const deterministicJudgeNode = defineEvaluationNode<
  { task: typeof TASK_PORT; execution: typeof EXECUTION_PORT },
  Record<string, never>,
  DeterministicJudgeConfig
>({
  type: DETERMINISTIC_JUDGE_NODE_TYPE,
  version: 1,
  role: "judge",
  verdicts: true,
  inputs: { task: TASK_PORT, execution: EXECUTION_PORT },
  outputs: {},
  async run(context) {
    const { kind, evaluatorId, threshold } = context.config;
    const output = context.in.execution.output;
    const expected = context.in.task.expectedOutput;

    if (kind !== "json_valid" && expected === undefined) {
      // Without a ground truth there is nothing to compare against; deciding
      // "unmet" here would grade the dataset, not the agent.
      return evaluationExcused.judge("expected_output_missing", {
        facts: { evaluatorId, kind },
      });
    }

    let raw = 0;
    let reason: string | undefined;
    if (kind === "exact_match") {
      raw = output.trim() === (expected ?? "").trim() ? 1 : 0;
      reason = raw === 1 ? "output matched the expected value" : "output differed from the expected value";
    } else if (kind === "contains") {
      raw = expected && output.includes(expected) ? 1 : 0;
      reason = raw === 1 ? "output contained the expected value" : "output did not contain the expected value";
    } else {
      try {
        JSON.parse(output);
        raw = 1;
        reason = "output parsed as JSON";
      } catch {
        raw = 0;
        reason = "output did not parse as JSON";
      }
    }

    return evaluationPass({
      verdicts: [
        buildVerdict({
          nodeId: context.nodeId,
          evaluatorId,
          raw,
          threshold,
          reason,
          labels: { dimension: "output", evaluator: kind },
        }),
      ],
    });
  },
});

export interface LlmJudgeConfig {
  evaluatorId: string;
  runtimeId: string;
  prompt: string;
  threshold: number;
}

const JUDGE_RETURN_CONTRACT =
  '\n\nReturn JSON only: {"score": number, "reason": string, "evidence": [string], "failedCriteria": [string]}';

export function renderEvaluationPrompt(
  template: string,
  values: { input: string; output: string; ground_truth?: string; context?: string },
): string {
  return template.replace(
    /\{\{(input|output|ground_truth|context)\}\}/g,
    (_match, key: keyof typeof values) => values[key] ?? "(not provided)",
  );
}

export function createLlmJudgeNode(
  dependencies: Pick<EvaluationNodeDependencies, "executeJudge">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; execution: typeof EXECUTION_PORT },
    Record<string, never>,
    LlmJudgeConfig
  >({
    type: LLM_JUDGE_NODE_TYPE,
    version: 1,
    role: "judge",
    verdicts: true,
    inputs: { task: TASK_PORT, execution: EXECUTION_PORT },
    outputs: {},
    async run(context) {
      const { evaluatorId, runtimeId, threshold } = context.config;
      if (!runtimeId.trim()) {
        return evaluationExcused.infra("judge_runtime_not_configured", { facts: { evaluatorId } });
      }
      if (!dependencies.executeJudge) {
        return evaluationExcused.infra("judge_executor_unavailable", { facts: { evaluatorId } });
      }

      const { task, execution } = context.in;
      const template = context.config.prompt || "Score the answer from 0 to 1.";
      const usesPlaceholders = /\{\{(?:input|output|ground_truth|context)\}\}/.test(template);
      let prompt = renderEvaluationPrompt(template, {
        input: task.input,
        output: execution.output,
        ...(task.expectedOutput !== undefined ? { ground_truth: task.expectedOutput } : {}),
        ...(task.context !== undefined ? { context: task.context } : {}),
      });
      if (!usesPlaceholders) {
        prompt += `\n\nInput: ${task.input}\n\nAnswer: ${execution.output}\n\nGround truth: ${task.expectedOutput ?? "(none)"}\n\nContext: ${task.context ?? "(none)"}`;
      }
      if (!prompt.includes('"failedCriteria"')) prompt += JUDGE_RETURN_CONTRACT;

      let judged: { output: string; durationMs: number };
      try {
        judged = await dependencies.executeJudge({ runtimeId, prompt }, context.signal);
      } catch (cause) {
        return evaluationExcused.infra(
          cause instanceof Error ? cause.message : String(cause),
          { facts: { evaluatorId, runtimeId } },
        );
      }

      const parsed = parseJudgeOutput(judged.output);
      if (!parsed) {
        return evaluationExcused.judge("judge_output_unparseable", {
          facts: { evaluatorId, outputLength: judged.output.length },
        });
      }
      if (parsed.score === null) {
        return evaluationExcused.judge("judge_score_missing", {
          facts: { evaluatorId, ...(parsed.reason ? { judgeReason: parsed.reason } : {}) },
        });
      }

      return evaluationPass({
        verdicts: [
          buildVerdict({
            nodeId: context.nodeId,
            evaluatorId,
            raw: parsed.score,
            threshold,
            labels: { dimension: "output", evaluator: "llm_judge" },
            ...(parsed.reason ? { reason: parsed.reason } : {}),
            ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
            ...(parsed.failedCriteria ? { failedCriteria: parsed.failedCriteria } : {}),
            durationMs: judged.durationMs,
          }),
        ],
      });
    },
  });
}

interface ParsedJudgeOutput {
  score: number | null;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
}

function parseJudgeOutput(output: string): ParsedJudgeOutput | null {
  const block = output.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawScore = Number(record.score);
  return {
    // A judge that answered without a usable number has not scored anything.
    // Coercing that to 0, as the previous runner did, is indistinguishable from
    // a judge that deliberately failed the answer.
    score: Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : null,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(stringArray(record.evidence) ? { evidence: stringArray(record.evidence)! } : {}),
    ...(stringArray(record.failedCriteria)
      ? { failedCriteria: stringArray(record.failedCriteria)! }
      : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}
