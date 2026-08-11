import { describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowRun } from "../../../../automation/contracts";
import { selectWorkbenchWorkflows } from "./workbench-workflows";

const definition: WorkflowDefinition = {
  id: "workflow-current",
  name: "当前 Workflow",
  description: "",
  inputs: [],
  nodes: [],
  createdAt: 10,
  updatedAt: 20,
};

describe("selectWorkbenchWorkflows", () => {
  it("使用当前 Workflow Core 定义和运行生成工作台卡片", () => {
    const run: WorkflowRun = {
      id: "run-current",
      workflowId: definition.id,
      definition,
      inputs: {},
      status: "waiting",
      nodeRuns: {},
      events: [],
      startedAt: 30,
    };

    expect(selectWorkbenchWorkflows([definition], [run])).toEqual([{
      workflow: { workflowId: definition.id, title: definition.name },
      nodeCount: 0,
      status: "waiting_for_user",
      updatedAt: 30,
    }]);
  });
});
