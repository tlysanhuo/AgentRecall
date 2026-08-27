import { describe, expect, it } from "vitest";
import {
  createLlmJudgeNode,
  deterministicJudgeNode,
  renderEvaluationPrompt,
  type DeterministicJudgeConfig,
  type LlmJudgeConfig,
} from "./judge-nodes";
import type { EvaluationExecutionValue, EvaluationTaskValue } from "./contracts";
import type { EvaluationNodeResult } from "../graph/node";

function task(overrides: Partial<EvaluationTaskValue> = {}): EvaluationTaskValue {
  return {
    caseId: "case-1",
    datasetItemId: "item-1",
    repetition: 1,
    input: "what is 2 + 2?",
    metadata: {},
    ...overrides,
  };
}

function execution(output: string): EvaluationExecutionValue {
  return { output, durationMs: 12 };
}

function runDeterministic(
  config: DeterministicJudgeConfig,
  inputs: { task: EvaluationTaskValue; execution: EvaluationExecutionValue },
): Promise<EvaluationNodeResult> {
  return deterministicJudgeNode.run({
    nodeId: "judge-1",
    nodeType: deterministicJudgeNode.type,
    caseId: "case-1",
    config,
    in: inputs,
    signal: new AbortController().signal,
  });
}

function runLlmJudge(
  config: LlmJudgeConfig,
  inputs: { task: EvaluationTaskValue; execution: EvaluationExecutionValue },
  executeJudge?: (
    input: { runtimeId: string; prompt: string },
  ) => Promise<{ output: string; durationMs: number }>,
): Promise<EvaluationNodeResult> {
  const node = createLlmJudgeNode(executeJudge ? { executeJudge } : {});
  return node.run({
    nodeId: "judge-1",
    nodeType: node.type,
    caseId: "case-1",
    config,
    in: inputs,
    signal: new AbortController().signal,
  });
}

describe("deterministic judge", () => {
  it("decides an exact match against the expected output", async () => {
    const result = await runDeterministic(
      { evaluatorId: "exact", kind: "exact_match", threshold: 1 },
      { task: task({ expectedOutput: " 4 " }), execution: execution("4") },
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts?.[0]).toMatchObject({
      verdictId: "judge-1:exact",
      evaluatorId: "exact",
      status: "met",
      raw: 1,
    });
  });

  it("marks a mismatch unmet", async () => {
    const result = await runDeterministic(
      { evaluatorId: "exact", kind: "exact_match", threshold: 1 },
      { task: task({ expectedOutput: "4" }), execution: execution("five") },
    );

    expect(result.verdicts?.[0]).toMatchObject({ status: "unmet", raw: 0 });
  });

  it("excuses itself when the dataset has no expected output to compare", async () => {
    // Deciding "unmet" here would grade the dataset rather than the agent.
    const result = await runDeterministic(
      { evaluatorId: "exact", kind: "exact_match", threshold: 1 },
      { task: task(), execution: execution("4") },
    );

    expect(result.status).toBe("excused");
    expect(result).toMatchObject({
      attribution: { type: "judge_failure", reason: "expected_output_missing" },
    });
    expect(result.verdicts).toBeUndefined();
  });

  it("checks JSON shape without needing an expected output", async () => {
    await expect(
      runDeterministic(
        { evaluatorId: "json", kind: "json_valid", threshold: 1 },
        { task: task(), execution: execution('{"answer":4}') },
      ),
    ).resolves.toMatchObject({ status: "pass", verdicts: [{ status: "met" }] });

    await expect(
      runDeterministic(
        { evaluatorId: "json", kind: "json_valid", threshold: 1 },
        { task: task(), execution: execution("not json") },
      ),
    ).resolves.toMatchObject({ status: "pass", verdicts: [{ status: "unmet" }] });
  });

  it("honours a threshold below one for a substring check", async () => {
    const result = await runDeterministic(
      { evaluatorId: "contains", kind: "contains", threshold: 0.5 },
      { task: task({ expectedOutput: "4" }), execution: execution("the answer is 4") },
    );

    expect(result.verdicts?.[0]).toMatchObject({ status: "met", threshold: 0.5 });
  });
});

describe("LLM judge", () => {
  it("scores the answer and reports the model's reasoning", async () => {
    const prompts: string[] = [];
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "Judge {{output}}", threshold: 0.6 },
      { task: task({ expectedOutput: "4" }), execution: execution("4") },
      async ({ prompt }) => {
        prompts.push(prompt);
        return {
          output: '{"score": 0.9, "reason": "correct", "evidence": ["says 4"], "failedCriteria": []}',
          durationMs: 30,
        };
      },
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts?.[0]).toMatchObject({
      status: "met",
      raw: 0.9,
      threshold: 0.6,
      reason: "correct",
      evidence: ["says 4"],
      durationMs: 30,
    });
    expect(prompts[0]).toContain("Judge 4");
    // The template used a placeholder, so the fallback block must not be appended.
    expect(prompts[0]).not.toContain("Ground truth:");
  });

  it("marks a low score unmet without excusing the judge", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("wrong") },
      async () => ({ output: '{"score": 0.1, "reason": "off topic"}', durationMs: 5 }),
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts?.[0]).toMatchObject({ status: "unmet", raw: 0.1 });
  });

  it("excuses a missing runtime instead of scoring the agent zero", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "  ", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
      async () => ({ output: '{"score": 1}', durationMs: 1 }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
    });
    expect(result.verdicts).toBeUndefined();
  });

  it("excuses an unavailable judge executor", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "infra_failure", reason: "judge_executor_unavailable" },
    });
  });

  it("excuses a judge whose call threw", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
      async () => {
        throw new Error("channel unreachable");
      },
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "infra_failure", reason: "channel unreachable" },
    });
  });

  it("excuses unparseable judge output rather than reading it as a zero", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
      async () => ({ output: "I think it looks fine, honestly.", durationMs: 5 }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "judge_failure", reason: "judge_output_unparseable" },
    });
    expect(result.verdicts).toBeUndefined();
  });

  it("excuses judge output that carries no usable score", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
      async () => ({ output: '{"reason": "cannot tell"}', durationMs: 5 }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "judge_failure", reason: "judge_score_missing" },
    });
  });

  it("clamps a score outside the unit range", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), execution: execution("4") },
      async () => ({ output: '{"score": 7}', durationMs: 5 }),
    );

    expect(result.verdicts?.[0]).toMatchObject({ raw: 1 });
  });

  it("appends the task context when the template has no placeholders", async () => {
    let seen = "";
    await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "Be strict.", threshold: 0.6 },
      { task: task({ expectedOutput: "4", context: "arithmetic" }), execution: execution("4") },
      async ({ prompt }) => {
        seen = prompt;
        return { output: '{"score": 1}', durationMs: 1 };
      },
    );

    expect(seen).toContain("Be strict.");
    expect(seen).toContain("Ground truth: 4");
    expect(seen).toContain("Context: arithmetic");
    expect(seen).toContain('"failedCriteria"');
  });
});

describe("renderEvaluationPrompt", () => {
  it("substitutes the known placeholders and marks the missing ones", () => {
    expect(
      renderEvaluationPrompt("{{input}} / {{output}} / {{ground_truth}} / {{context}}", {
        input: "in",
        output: "out",
      }),
    ).toBe("in / out / (not provided) / (not provided)");
  });
});
