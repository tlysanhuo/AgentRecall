import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStatus,
} from "../../../../automation/contracts";

export interface WorkbenchWorkflowItem {
  workflow: {
    workflowId: string;
    title: string;
  };
  nodeCount: number;
  status: WorkflowStatus;
  updatedAt: number;
}

const STATUS_PRIORITY: Record<WorkflowStatus, number> = {
  waiting_for_user: 0,
  running: 1,
  failed: 2,
  draft: 3,
  stopped: 4,
  completed: 5,
};

export function selectWorkbenchWorkflows(
  workflows: WorkflowDefinition[],
  runs: WorkflowRun[],
  limit = 5,
): WorkbenchWorkflowItem[] {
  return workflows
    .map((workflow) => {
      const workflowRuns = runs
        .filter((run) => run.workflowId === workflow.id)
        .sort((left, right) => right.startedAt - left.startedAt);
      const activeRun = workflowRuns.find((run) => run.status === "waiting" || run.status === "running");
      const latestRun = activeRun ?? workflowRuns[0];
      return {
        workflow: {
          workflowId: workflow.id,
          title: workflow.name,
        },
        nodeCount: workflow.nodes.length,
        status: activeRun ? workbenchStatus(activeRun.status) : "draft",
        updatedAt: Math.max(workflow.updatedAt, latestRun?.finishedAt ?? latestRun?.startedAt ?? 0),
      };
    })
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      return priority || right.updatedAt - left.updatedAt;
    })
    .slice(0, Math.max(0, limit));
}

function workbenchStatus(status: WorkflowRunStatus): WorkflowStatus {
  if (status === "waiting") return "waiting_for_user";
  if (status === "paused" || status === "cancelled") return "stopped";
  return status;
}
