import { randomUUID } from "node:crypto";

import type { WorkflowNode } from "../../automation/engine/shared/workflow/model";
import { validateWorkflowNodeOutputs } from "../../automation/engine/shared/workflow/output";

interface PendingWorkflowOutput {
  workflowId: string;
  runId: string;
  node: WorkflowNode;
  outputs?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function failure(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function validOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/**
 * One-shot handoff between the Runtime's workflow_node_complete tool call and
 * the Core Workflow executor that owns the node attempt.
 *
 * The output is kept in memory only until the Agent exits. The Workflow engine
 * remains the durable owner: it validates again and saves the node result with
 * the run after execute() returns.
 */
export class WorkflowCoreOutputBroker {
  private readonly pending = new Map<string, PendingWorkflowOutput>();

  begin(input: { workflowId: string; runId: string; node: WorkflowNode }): string {
    const executionId = randomUUID();
    this.pending.set(executionId, {
      workflowId: input.workflowId,
      runId: input.runId,
      node: structuredClone(input.node),
    });
    return executionId;
  }

  submit(value: unknown): Record<string, unknown> | undefined {
    const input = record(value);
    const executionId = typeof input.executionId === "string" ? input.executionId : "";
    const pending = this.pending.get(executionId);
    // Unknown executions may belong to the V2 Workflow engine, so let the
    // bridge continue routing instead of claiming them as Core runs.
    if (!pending) return undefined;
    if (
      input.workflowId !== pending.workflowId
      || input.runId !== pending.runId
      || input.nodeId !== pending.node.id
    ) {
      return failure("INVALID_ARGUMENT", "Workflow output submission identity does not match the active node execution.");
    }
    if (pending.outputs) {
      return failure("INVALID_STATE", "This Workflow node already submitted its output.");
    }
    if (typeof input.summary !== "string" || !input.summary.trim()) {
      return failure("INVALID_ARGUMENT", "workflow_node_complete requires a non-empty summary.");
    }
    if (!input.outputs || typeof input.outputs !== "object" || Array.isArray(input.outputs)) {
      return failure("INVALID_ARGUMENT", "workflow_node_complete requires outputs to be an object.");
    }
    if (!Array.isArray(input.proposals) || input.proposals.length > 0) {
      return failure("INVALID_ARGUMENT", "Core Workflow does not accept proposals; use an empty array.");
    }
    if (!validOptionalStringArray(input.evidence)
      || !validOptionalStringArray(input.risks)
      || !validOptionalStringArray(input.nextStepSuggestions)) {
      return failure("INVALID_ARGUMENT", "Workflow output evidence, risks, and nextStepSuggestions must be string arrays when provided.");
    }
    const outputs = input.outputs as Record<string, unknown>;
    const issues = validateWorkflowNodeOutputs(pending.node, outputs);
    if (issues.length > 0) {
      return failure("INVALID_ARGUMENT", `${issues[0]!.path}: ${issues[0]!.message}`);
    }
    pending.outputs = structuredClone(outputs);
    return {
      ok: true,
      data: {
        status: "submitted",
        nodeId: pending.node.id,
        outputs: structuredClone(outputs),
      },
    };
  }

  finish(executionId: string): Record<string, unknown> | undefined {
    const pending = this.pending.get(executionId);
    this.pending.delete(executionId);
    return pending?.outputs ? structuredClone(pending.outputs) : undefined;
  }

  cancel(executionId: string): void {
    this.pending.delete(executionId);
  }
}
