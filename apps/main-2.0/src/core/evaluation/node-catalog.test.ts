import { describe, expect, it } from "vitest";
import { buildEvaluationGraph } from "./graph/builder";
import { hydrateEvaluationCaseSpec } from "./case-graph";
import { createEvaluationValidationRegistry, evaluationNodeCatalog } from "./node-catalog";
import type { EvaluationGraphSpec } from "./graph/builder";
import type { EvaluationTaskValue } from "./nodes/contracts";

function task(): EvaluationTaskValue {
  return {
    caseId: "run-1:item-1:1",
    datasetItemId: "item-1",
    repetition: 1,
    input: "the real case input",
    expectedOutput: "4",
    metadata: {},
  };
}

function authoredSpec(): EvaluationGraphSpec {
  return {
    name: "authored",
    version: 1,
    nodes: [
      { id: "task", type: "task_source", config: { caseId: "stale", input: "stale input" } },
      { id: "skill", type: "skill_provision", config: {} },
      {
        id: "agent",
        type: "agent_execute",
        config: {},
        in: { task: "task.task", instructions: "skill.instructions" },
      },
      {
        id: "judge",
        type: "llm_judge",
        config: { evaluatorId: "judge-1", threshold: 0.1, prompt: "stale", runtimeId: "stale" },
        in: { task: "task.task", execution: "agent.execution" },
      },
    ],
  };
}

describe("evaluation node catalog", () => {
  it("describes every registered node with its real ports", () => {
    const catalog = evaluationNodeCatalog();
    const registry = createEvaluationValidationRegistry();

    expect(catalog).toHaveLength(registry.list().length);
    const agent = catalog.find((entry) => entry.type === "agent_execute")!;
    expect(agent.role).toBe("prepare");
    // Ports come from the definition, so a palette cannot advertise one the
    // engine does not have.
    expect(agent.inputs).toEqual([
      { name: "task", kind: "eval.task" },
      { name: "instructions", kind: "eval.instructions" },
    ]);
    expect(agent.outputs).toEqual([{ name: "execution", kind: "eval.execution" }]);
    expect(agent.configFields.map((field) => field.key)).toEqual(["agentId"]);

    const judge = catalog.find((entry) => entry.type === "llm_judge")!;
    expect(judge.role).toBe("judge");
    expect(catalog.find((entry) => entry.type === "task_source")!.configuredPerCase).toBe(true);
  });

  it("validates an authored graph without being able to run it", () => {
    const registry = createEvaluationValidationRegistry();

    expect(() => buildEvaluationGraph(authoredSpec(), registry)).not.toThrow();
    expect(() =>
      buildEvaluationGraph(
        {
          name: "broken",
          version: 1,
          nodes: [
            { id: "task", type: "task_source" },
            // A judge fed the task where it expects an execution.
            {
              id: "judge",
              type: "llm_judge",
              config: { evaluatorId: "e", threshold: 1, prompt: "", runtimeId: "r" },
              in: { task: "task.task", execution: "task.task" },
            },
          ],
        },
        registry,
      ),
    ).toThrow(/type_mismatch/);
  });
});

describe("hydrateEvaluationCaseSpec", () => {
  it("replaces the task node's config with the case being run", () => {
    const hydrated = hydrateEvaluationCaseSpec(authoredSpec(), {
      task: task(),
      agentId: "agent-1",
      skillName: null,
      evaluators: [{ id: "judge-1", kind: "llm_judge", threshold: 0.8, prompt: "current", runtimeId: "claude" }],
    });

    expect(hydrated.nodes.find((node) => node.id === "task")!.config).toEqual(task());
  });

  it("fills the agent and skill a node left unset", () => {
    const hydrated = hydrateEvaluationCaseSpec(authoredSpec(), {
      task: task(),
      agentId: "agent-1",
      skillName: "review",
      evaluators: [{ id: "judge-1", kind: "llm_judge", threshold: 0.8 }],
    });

    expect(hydrated.nodes.find((node) => node.id === "agent")!.config).toMatchObject({
      agentId: "agent-1",
    });
    expect(hydrated.nodes.find((node) => node.id === "skill")!.config).toMatchObject({
      skillName: "review",
    });
  });

  it("keeps an agent the graph names explicitly", () => {
    const spec = authoredSpec();
    spec.nodes.find((node) => node.id === "agent")!.config = { agentId: "agent-chosen" };

    const hydrated = hydrateEvaluationCaseSpec(spec, {
      task: task(),
      agentId: "agent-default",
      skillName: null,
      evaluators: [{ id: "judge-1", kind: "llm_judge", threshold: 0.8 }],
    });

    expect(hydrated.nodes.find((node) => node.id === "agent")!.config).toEqual({
      agentId: "agent-chosen",
    });
  });

  it("takes the evaluator's current settings rather than the saved copy", () => {
    // Editing a threshold or a judge prompt has to take effect on the next run;
    // a graph that froze them would keep scoring against a rubric the user
    // already changed.
    const hydrated = hydrateEvaluationCaseSpec(authoredSpec(), {
      task: task(),
      agentId: "agent-1",
      skillName: null,
      evaluators: [
        { id: "judge-1", kind: "llm_judge", threshold: 0.8, prompt: "current rubric", runtimeId: "claude" },
      ],
    });

    expect(hydrated.nodes.find((node) => node.id === "judge")!.config).toEqual({
      evaluatorId: "judge-1",
      threshold: 0.8,
      prompt: "current rubric",
      runtimeId: "claude",
    });
  });

  it("disables a judge whose evaluator was deleted instead of failing the build", () => {
    const hydrated = hydrateEvaluationCaseSpec(authoredSpec(), {
      task: task(),
      agentId: "agent-1",
      skillName: null,
      evaluators: [],
    });

    const judge = hydrated.nodes.find((node) => node.id === "judge")!;
    expect(judge.enabled).toBe(false);
    expect(() => buildEvaluationGraph(hydrated, createEvaluationValidationRegistry())).not.toThrow();
  });
});
