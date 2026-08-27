import { describe, expect, it } from "vitest";
import { executeEvaluationRun, type EvaluationRunPlan } from "./run";
import type {
  EvaluationEvidenceValue,
  EvaluationNodeDependencies,
  EvaluationTaskValue,
} from "./nodes/contracts";
import type { EvaluationNodeRecord } from "./graph/node";

function task(id: string, overrides: Partial<EvaluationTaskValue> = {}): EvaluationTaskValue {
  return {
    caseId: id,
    datasetItemId: id,
    repetition: 1,
    input: `input for ${id}`,
    expectedOutput: "4",
    metadata: {},
    ...overrides,
  };
}

function evidence(overrides: Partial<EvaluationEvidenceValue> = {}): EvaluationEvidenceValue {
  return {
    turnCount: 2,
    toolCallCount: 1,
    toolFailureCount: 0,
    failedToolNames: [],
    totalTokens: 500,
    errorCount: 0,
    usedSkillNames: [],
    skillUsageObservable: true,
    ...overrides,
  };
}

function plan(overrides: Partial<EvaluationRunPlan> = {}): EvaluationRunPlan {
  return {
    agentId: "agent-1",
    skillName: null,
    evaluators: [{ id: "exact", kind: "exact_match", threshold: 1 }],
    cases: [task("case-1")],
    linkSessions: false,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<EvaluationNodeDependencies> = {},
): EvaluationNodeDependencies {
  return {
    executeAgent: async () => ({ output: "4", durationMs: 10 }),
    wait: async () => undefined,
    ...overrides,
  };
}

function statuses(records: readonly EvaluationNodeRecord[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.nodeId, record.status]));
}

describe("evaluation run", () => {
  it("scores every case and reports the run summary", async () => {
    const outcome = await executeEvaluationRun(
      plan({ cases: [task("case-1"), task("case-2")] }),
      dependencies(),
    );

    expect(outcome.cases.map((item) => item.caseId)).toEqual(["case-1", "case-2"]);
    expect(outcome.cases[0]!.output).toBe("4");
    expect(outcome.score).toMatchObject({
      averageScore: 1,
      passRate: 1,
      scoredCaseCount: 2,
      passedCaseCount: 2,
    });
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toEqual({
      task: "pass",
      skill: "pass",
      agent: "pass",
      "judge-exact": "pass",
    });
  });

  it("reports progress per case and per node while the run is going", async () => {
    const cases: string[] = [];
    const nodes: string[] = [];

    await executeEvaluationRun(plan({ cases: [task("case-1"), task("case-2")] }), dependencies(), {
      onCaseComplete: (outcome) => {
        cases.push(outcome.caseId);
      },
      onNodeRecord: (caseId, record) => {
        nodes.push(`${caseId}/${record.nodeId}`);
      },
    });

    expect(cases).toEqual(["case-1", "case-2"]);
    expect(nodes).toContain("case-1/agent");
    expect(nodes).toContain("case-2/judge-exact");
  });

  it("leaves an agent that never answered unscored instead of scoring it zero", async () => {
    const outcome = await executeEvaluationRun(
      plan(),
      dependencies({
        executeAgent: async () => {
          throw new Error("claude runtime is not configured");
        },
      }),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      agent: "excused",
      "judge-exact": "pending",
    });
    expect(result!.score.score).toBeNull();
    expect(result!.score.passed).toBe(false);
    expect(result!.unscoredReason).toBe("claude runtime is not configured");
    // The gate stays open: nothing here was the agent's fault.
    expect(result!.aggregate.gate.passed).toBe(true);
    expect(outcome.score).toMatchObject({ averageScore: null, passRate: null, unscoredCaseCount: 1 });
  });

  it("injects the selected skill as developer instructions and freezes its hash", async () => {
    const seen: Array<{ prompt: string; developerInstructions?: string }> = [];
    const outcome = await executeEvaluationRun(
      plan({ skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# Teach one point\n", hash: "abc123" }),
        executeAgent: async (input) => {
          seen.push(input);
          return { output: "4", durationMs: 5 };
        },
      }),
    );

    expect(seen[0]!.developerInstructions).toBe("# Teach one point\n");
    expect(outcome.cases[0]!.skill).toEqual({
      skillName: "one-bite-teaching",
      skillHash: "abc123",
      contentLength: 18,
    });
  });

  it("sends no developer instructions when the experiment injects no skill", async () => {
    const seen: Array<{ developerInstructions?: string }> = [];
    await executeEvaluationRun(
      plan(),
      dependencies({
        executeAgent: async (input) => {
          seen.push(input);
          return { output: "4", durationMs: 5 };
        },
      }),
    );

    expect(seen[0]!.developerInstructions).toBeUndefined();
  });

  it("does not run the agent when a requested skill cannot be read", async () => {
    // Running without the skill would evaluate something other than what was
    // configured, so the case reports why it produced nothing instead.
    const outcome = await executeEvaluationRun(
      plan({ skillName: "missing-skill" }),
      dependencies({ readSkill: async () => null }),
    );

    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      skill: "excused",
      agent: "pending",
      "judge-exact": "pending",
    });
    expect(outcome.cases[0]!.unscoredReason).toBe("skill_not_readable");
  });

  it("links the run to the session once indexing catches up", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const outcome = await executeEvaluationRun(
      plan({ linkSessions: true, sessionLink: { attempts: 5, delayMs: 250 } }),
      dependencies({
        executeAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async (rawId) => {
          attempts += 1;
          return attempts < 3
            ? null
            : { sessionKey: `claude:${rawId}`, source: "claude", rawId };
        },
        readTrace: async () => evidence(),
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
    );

    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
    expect(outcome.cases[0]!.sessionKey).toBe("claude:thread-9");
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      session: "pass",
      evidence: "pass",
      "skill-use": "pass",
    });
  });

  it("keeps the output judge deciding when the session never gets indexed", async () => {
    const outcome = await executeEvaluationRun(
      plan({ linkSessions: true, sessionLink: { attempts: 2, delayMs: 0 } }),
      dependencies({
        executeAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async () => null,
        readTrace: async () => evidence(),
      }),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      session: "excused",
      evidence: "pending",
      "skill-use": "pending",
      "judge-exact": "pass",
    });
    // A missing session link must not cost the case its score.
    expect(result!.score.score).toBe(1);
    expect(result!.score.passed).toBe(true);
    expect(result!.sessionKey).toBeUndefined();
  });

  it("excuses the link when the runtime reported no session at all", async () => {
    const outcome = await executeEvaluationRun(
      plan({ linkSessions: true }),
      dependencies({ readTrace: async () => evidence(), resolveSession: async () => null }),
    );

    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "session"),
    ).toMatchObject({
      status: "excused",
      attribution: { reason: "runtime_reported_no_session" },
    });
  });

  it("records whether the injected skill was actually used", async () => {
    const used = await executeEvaluationRun(
      plan({ linkSessions: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        executeAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async (rawId) => ({ sessionKey: "k1", source: "claude", rawId }),
        readTrace: async () => evidence({ usedSkillNames: ["One-Bite-Teaching"] }),
      }),
    );

    expect(
      used.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toEqual({
      injected: true,
      skillName: "one-bite-teaching",
      skillHash: "h1",
      observable: true,
      used: true,
    });

    const unused = await executeEvaluationRun(
      plan({ linkSessions: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        executeAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async (rawId) => ({ sessionKey: "k1", source: "claude", rawId }),
        readTrace: async () => evidence({ usedSkillNames: ["something-else"] }),
      }),
    );

    // Skills are offered, not mandated, so going unused is an observation and
    // must not move the score.
    expect(
      unused.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toMatchObject({ used: false });
    expect(unused.cases[0]!.score.passed).toBe(true);
  });

  it("reports skill use as unknown when the session carries no usage data", async () => {
    // An uninstalled usage hook must not be reported as the agent ignoring the
    // skill.
    const outcome = await executeEvaluationRun(
      plan({ linkSessions: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        executeAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async (rawId) => ({ sessionKey: "k1", source: "claude", rawId }),
        readTrace: async () => evidence({ skillUsageObservable: false }),
      }),
    );

    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toMatchObject({ observable: false, used: null });
  });

  it("stops taking new cases once the run is aborted", async () => {
    const controller = new AbortController();
    const outcome = await executeEvaluationRun(
      plan({ cases: [task("case-1"), task("case-2"), task("case-3")] }),
      dependencies({
        executeAgent: async () => {
          controller.abort();
          return { output: "4", durationMs: 1 };
        },
      }),
      { signal: controller.signal },
    );

    expect(outcome.cancelled).toBe(true);
    expect(outcome.cases.map((item) => item.caseId)).toEqual(["case-1"]);
    // The abort lands while case-1 is still in its agent node, so its judge
    // never gets a turn and the case cannot be reported as a clean pass.
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      agent: "pass",
      "judge-exact": "pending",
    });
    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "judge-exact")!
        .pendingReason,
    ).toBe("not_decided");
    expect(outcome.cases[0]!.aggregate.gate.passed).toBe(false);
    expect(outcome.cases[0]!.score.passed).toBe(false);
    expect(outcome.cases[0]!.unscoredReason).toBe("case_cancelled");
    expect(outcome.score.passRate).toBeNull();
  });

  it("runs several judges of one case concurrently", async () => {
    let active = 0;
    let peak = 0;
    const outcome = await executeEvaluationRun(
      plan({
        evaluators: [
          { id: "exact", kind: "exact_match", threshold: 1 },
          { id: "judge-a", kind: "llm_judge", threshold: 0.5, runtimeId: "claude", prompt: "" },
          { id: "judge-b", kind: "llm_judge", threshold: 0.5, runtimeId: "claude", prompt: "" },
        ],
      }),
      dependencies({
        executeJudge: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { output: '{"score": 1}', durationMs: 5 };
        },
      }),
    );

    expect(peak).toBeGreaterThan(1);
    expect(outcome.cases[0]!.score.decided).toBe(3);
  });

  it("keeps one judge's failure from hiding another's decision", async () => {
    const outcome = await executeEvaluationRun(
      plan({
        evaluators: [
          { id: "exact", kind: "exact_match", threshold: 1 },
          { id: "broken", kind: "llm_judge", threshold: 0.5, runtimeId: "", prompt: "" },
        ],
      }),
      dependencies(),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      "judge-exact": "pass",
      "judge-broken": "excused",
    });
    expect(result!.score.score).toBe(1);
    expect(result!.score.decided).toBe(1);
    expect(result!.aggregate.completeness.notDecided).toBe(1);
  });
});
