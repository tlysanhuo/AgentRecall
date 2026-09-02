import { describe, expect, test } from "vitest";

import type { WorkflowReviewNode } from "../../automation/engine/shared/workflow/model";
import { WorkflowCoreOutputBroker } from "./workflow-core-output-broker";

function reviewNode(): WorkflowReviewNode {
  return {
    id: "review",
    kind: "review",
    title: "Review",
    goal: "Review the result",
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: [],
    targetNodeIds: [],
    outputs: [
      { key: "verdict", name: "Verdict", description: "pass or revise", type: "text", required: true },
      { key: "feedback", name: "Feedback", description: "Review feedback", type: "text", required: true },
    ],
    acceptanceCriteria: [],
    criteria: [],
    maxRevisions: 2,
    onReject: "stop",
  };
}

describe("WorkflowCoreOutputBroker", () => {
  test("accepts one contract-valid tool submission and consumes it once", () => {
    const broker = new WorkflowCoreOutputBroker();
    const executionId = broker.begin({ workflowId: "workflow", runId: "run", node: reviewNode() });
    const result = broker.submit({
      workflowId: "workflow",
      runId: "run",
      nodeId: "review",
      executionId,
      summary: "Review passed",
      outputs: { verdict: "pass", feedback: "Grounded" },
      proposals: [],
    });

    expect(result).toMatchObject({ ok: true, data: { status: "submitted" } });
    expect(broker.finish(executionId)).toEqual({ verdict: "pass", feedback: "Grounded" });
    expect(broker.finish(executionId)).toBeUndefined();
  });

  test("returns actionable validation errors and allows a corrected submission", () => {
    const broker = new WorkflowCoreOutputBroker();
    const executionId = broker.begin({ workflowId: "workflow", runId: "run", node: reviewNode() });
    const invalid = broker.submit({
      workflowId: "workflow",
      runId: "run",
      nodeId: "review",
      executionId,
      summary: "Needs correction",
      outputs: { verdict: "yes" },
      proposals: [],
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "outputs.feedback: Required output is missing." },
    });

    expect(broker.submit({
      workflowId: "workflow",
      runId: "run",
      nodeId: "review",
      executionId,
      summary: "Review corrected",
      outputs: { verdict: "pass", feedback: "Corrected" },
      proposals: [],
    })).toMatchObject({ ok: true });
  });

  test("leaves unknown executions for the V2 Workflow handler", () => {
    expect(new WorkflowCoreOutputBroker().submit({ executionId: "v2-execution" })).toBeUndefined();
  });
});
