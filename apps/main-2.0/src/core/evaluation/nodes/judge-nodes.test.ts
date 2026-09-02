import { describe, expect, it } from "vitest";
import {
  createLlmJudgeNode,
  createScriptJudgeNode,
  createScriptTrajectoryJudgeNode,
  deterministicJudgeNode,
  renderEvaluationPrompt,
  type DeterministicJudgeConfig,
  type LlmJudgeConfig,
  type ScriptJudgeConfig,
} from "./judge-nodes";
import type {
  EvaluationArtifactValue,
  EvaluationJudgeScriptInput,
  EvaluationJudgeScriptVerdict,
  EvaluationTaskValue,
  EvaluationTrajectoryValue,
} from "./contracts";
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

function artifact(output: string): EvaluationArtifactValue {
  return { output, origin: { kind: "agent_run" }, durationMs: 12 };
}

function runDeterministic(
  config: DeterministicJudgeConfig,
  inputs: { task: EvaluationTaskValue; artifact: EvaluationArtifactValue },
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
  inputs: { task: EvaluationTaskValue; artifact: EvaluationArtifactValue },
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
      { task: task({ expectedOutput: " 4 " }), artifact: artifact("4") },
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
      { task: task({ expectedOutput: "4" }), artifact: artifact("five") },
    );

    expect(result.verdicts?.[0]).toMatchObject({ status: "unmet", raw: 0 });
  });

  it("excuses itself when the dataset has no expected output to compare", async () => {
    // Deciding "unmet" here would grade the dataset rather than the agent.
    const result = await runDeterministic(
      { evaluatorId: "exact", kind: "exact_match", threshold: 1 },
      { task: task(), artifact: artifact("4") },
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
        { task: task(), artifact: artifact('{"answer":4}') },
      ),
    ).resolves.toMatchObject({ status: "pass", verdicts: [{ status: "met" }] });

    await expect(
      runDeterministic(
        { evaluatorId: "json", kind: "json_valid", threshold: 1 },
        { task: task(), artifact: artifact("not json") },
      ),
    ).resolves.toMatchObject({ status: "pass", verdicts: [{ status: "unmet" }] });
  });

  it("honours a threshold below one for a substring check", async () => {
    const result = await runDeterministic(
      { evaluatorId: "contains", kind: "contains", threshold: 0.5 },
      { task: task({ expectedOutput: "4" }), artifact: artifact("the answer is 4") },
    );

    expect(result.verdicts?.[0]).toMatchObject({ status: "met", threshold: 0.5 });
  });
});

describe("LLM judge", () => {
  it("scores the answer and reports the model's reasoning", async () => {
    const prompts: string[] = [];
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "Judge {{output}}", threshold: 0.6 },
      { task: task({ expectedOutput: "4" }), artifact: artifact("4") },
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
      { task: task(), artifact: artifact("wrong") },
      async () => ({ output: '{"score": 0.1, "reason": "off topic"}', durationMs: 5 }),
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts?.[0]).toMatchObject({ status: "unmet", raw: 0.1 });
  });

  it("records one independently labelled verdict per contracted LLM dimension", async () => {
    const prompt = `<DimensionContract>[{"name":"事实准确","priority":"must"},{"name":"表达清晰","priority":"should"}]</DimensionContract>
Judge {{output}} and return {"verdicts": [{"dimension": string, "score": number, "reason": string, "evidence": [], "failedCriteria": []}]}`;
    const result = await runLlmJudge(
      { evaluatorId: "tutorial", runtimeId: "claude", prompt, threshold: 0.75 },
      { task: task(), artifact: artifact("draft") },
      async () => ({
        output: JSON.stringify({
          verdicts: [
            { dimension: "事实准确", score: 0.5, reason: "one claim is unsupported" },
            { dimension: "表达清晰", score: 1, reason: "easy to follow" },
          ],
        }),
        durationMs: 30,
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts).toEqual([
      expect.objectContaining({
        verdictId: "judge-1:tutorial:事实准确",
        labels: { dimension: "事实准确", evaluator: "llm_judge", priority: "must" },
        raw: 0.5,
        status: "unmet",
        durationMs: 30,
      }),
      expect.objectContaining({
        verdictId: "judge-1:tutorial:表达清晰",
        labels: { dimension: "表达清晰", evaluator: "llm_judge", priority: "should" },
        raw: 1,
        status: "met",
        durationMs: 0,
      }),
    ]);
  });

  it("excuses an incomplete contracted dimension set instead of hiding missing scores", async () => {
    const prompt = `<DimensionContract>[{"name":"事实准确"},{"name":"表达清晰"}]</DimensionContract>
Return {"verdicts": [{"dimension": string, "score": number, "failedCriteria": []}]}`;
    const result = await runLlmJudge(
      { evaluatorId: "tutorial", runtimeId: "claude", prompt, threshold: 0.75 },
      { task: task(), artifact: artifact("draft") },
      async () => ({
        output: '{"verdicts":[{"dimension":"事实准确","score":1}]}',
        durationMs: 4,
      }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "judge_failure", reason: "judge_dimensions_incomplete" },
    });
    expect(result.verdicts).toBeUndefined();
  });

  it("excuses a missing runtime instead of scoring the agent zero", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "  ", prompt: "", threshold: 0.6 },
      { task: task(), artifact: artifact("4") },
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
      { task: task(), artifact: artifact("4") },
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "infra_failure", reason: "judge_executor_unavailable" },
    });
  });

  it("excuses a judge whose call threw", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), artifact: artifact("4") },
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
      { task: task(), artifact: artifact("4") },
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
      { task: task(), artifact: artifact("4") },
      async () => ({ output: '{"reason": "cannot tell"}', durationMs: 5 }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "judge_failure", reason: "judge_score_missing" },
    });
  });

  it("does not coerce a null judge score into a deliberate zero", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), artifact: artifact("4") },
      async () => ({ output: '{"score":null,"reason":"not enough evidence"}', durationMs: 5 }),
    );

    expect(result).toMatchObject({
      status: "excused",
      attribution: { type: "judge_failure", reason: "judge_score_missing" },
    });
  });

  it("clamps a score outside the unit range", async () => {
    const result = await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "", threshold: 0.6 },
      { task: task(), artifact: artifact("4") },
      async () => ({ output: '{"score": 7}', durationMs: 5 }),
    );

    expect(result.verdicts?.[0]).toMatchObject({ raw: 1 });
  });

  it("appends the task context when the template has no placeholders", async () => {
    let seen = "";
    await runLlmJudge(
      { evaluatorId: "judge", runtimeId: "claude", prompt: "Be strict.", threshold: 0.6 },
      { task: task({ expectedOutput: "4", context: "arithmetic" }), artifact: artifact("4") },
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

function trajectory(
  overrides: Partial<EvaluationTrajectoryValue> = {},
): EvaluationTrajectoryValue {
  return {
    turnCount: 4,
    toolCallCount: 6,
    toolFailureCount: 0,
    failedToolNames: [],
    totalTokens: 900,
    errorCount: 0,
    usedSkillNames: [],
    skillUsageObservable: true,
    ...overrides,
  };
}

function scriptConfig(overrides: Partial<ScriptJudgeConfig> = {}): ScriptJudgeConfig {
  return {
    evaluatorId: "my-check",
    threshold: 0.6,
    script: { mode: "inline_js", source: "return 1;" },
    ...overrides,
  };
}

function runScriptJudge(
  config: ScriptJudgeConfig,
  runJudgeScript?: (
    input: EvaluationJudgeScriptInput,
  ) => Promise<{ verdicts: EvaluationJudgeScriptVerdict[]; durationMs: number }>,
): Promise<EvaluationNodeResult> {
  const node = createScriptJudgeNode(runJudgeScript ? { runJudgeScript } : {});
  return node.run({
    nodeId: "judge-script",
    nodeType: node.type,
    caseId: "case-1",
    config,
    in: { task: task({ expectedOutput: "4" }), artifact: artifact("4") },
    signal: new AbortController().signal,
  });
}

describe("script judge", () => {
  it("turns the script's verdict into a decision on its dimension", async () => {
    const result = await runScriptJudge(
      scriptConfig({ dimension: "格式", priority: "must" }),
      async () => ({ verdicts: [{ score: 0.8, reason: "shape is right" }], durationMs: 7 }),
    );

    expect(result.status).toBe("pass");
    expect(result.verdicts).toEqual([{
      verdictId: "judge-script:my-check",
      evaluatorId: "my-check",
      labels: { dimension: "格式", evaluator: "script", priority: "must" },
      status: "met",
      raw: 0.8,
      threshold: 0.6,
      reason: "shape is right",
      durationMs: 7,
    }]);
  });

  it("hands the script the task and the artifact it is judging", async () => {
    const seen: EvaluationJudgeScriptInput[] = [];
    await runScriptJudge(scriptConfig(), async (input) => {
      seen.push(input);
      return { verdicts: [{ score: 1 }], durationMs: 1 };
    });

    expect(seen[0]!.task.expectedOutput).toBe("4");
    expect(seen[0]!.artifact!.output).toBe("4");
    expect(seen[0]!.script).toEqual({ mode: "inline_js", source: "return 1;" });
  });

  it("records one verdict per dimension the script returned", async () => {
    const result = await runScriptJudge(scriptConfig(), async () => ({
      verdicts: [
        { score: 1, dimension: "正确性" },
        { score: 0.2, dimension: "简洁性" },
      ],
      durationMs: 3,
    }));

    expect(result.verdicts?.map((verdict) => [verdict.verdictId, verdict.labels.dimension, verdict.status]))
      .toEqual([
        ["judge-script:my-check:正确性", "正确性", "met"],
        ["judge-script:my-check:简洁性", "简洁性", "unmet"],
      ]);
  });

  it("excuses itself when the script fails instead of scoring the agent zero", async () => {
    // This is the whole reason a script judge is allowed to reject: a broken
    // rubric must not look like a wrong answer.
    const result = await runScriptJudge(scriptConfig(), async () => {
      throw new Error("script_timed_out_after_5000ms");
    });

    expect(result.status).toBe("excused");
    expect(result).toMatchObject({
      attribution: { type: "judge_failure", reason: "script_timed_out_after_5000ms" },
    });
    expect(result.verdicts).toBeUndefined();
  });

  it("excuses itself when the script decided nothing", async () => {
    const result = await runScriptJudge(
      scriptConfig(),
      async () => ({ verdicts: [], durationMs: 1 }),
    );

    expect(result.status).toBe("excused");
    expect(result).toMatchObject({
      attribution: { type: "judge_failure", reason: "script_returned_no_verdict" },
    });
  });

  it("excuses itself when the host cannot run scripts at all", async () => {
    const result = await runScriptJudge(scriptConfig());

    expect(result.status).toBe("excused");
    expect(result).toMatchObject({
      attribution: { type: "infra_failure", reason: "script_runner_unavailable" },
    });
  });

  it("clamps a score the script put out of range", async () => {
    const result = await runScriptJudge(
      scriptConfig(),
      async () => ({ verdicts: [{ score: 4 }], durationMs: 1 }),
    );

    expect(result.verdicts?.[0]!.raw).toBe(1);
  });
});

describe("script trajectory judge", () => {
  it("judges how the work was done, not what came out", async () => {
    const seen: EvaluationJudgeScriptInput[] = [];
    const node = createScriptTrajectoryJudgeNode({
      runJudgeScript: async (input) => {
        seen.push(input);
        return { verdicts: [{ score: 0.9, dimension: "效率" }], durationMs: 2 };
      },
    });

    const result = await node.run({
      nodeId: "judge-traj",
      nodeType: node.type,
      caseId: "case-1",
      config: scriptConfig(),
      in: { task: task(), trajectory: trajectory({ toolCallCount: 12 }) },
      signal: new AbortController().signal,
    });

    expect(seen[0]!.trajectory!.toolCallCount).toBe(12);
    expect(seen[0]!.artifact).toBeUndefined();
    expect(result.verdicts?.[0]!.labels.dimension).toBe("效率");
  });
});
