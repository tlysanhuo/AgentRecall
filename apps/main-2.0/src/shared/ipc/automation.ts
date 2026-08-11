import type {
  RegisteredArtifact,
  TaskRun,
  WorkflowDraftState,
  WorkflowNodeConversation,
  WorkflowStoreState,
} from "../../automation/contracts";

export const AUTOMATION_CHANNELS = {
  health: "automation:health",
  snapshot: "automation:snapshot",
  snapshotChanged: "automation:snapshot-changed",
  change: "automation:change",
  runtimeSaveChannels: "automation:runtime:save-channels",
  runtimeSaveAgents: "automation:runtime:save-agents",
  runtimeDeleteAgent: "automation:runtime:delete-agent",
  runtimeTestChannel: "automation:runtime:test-channel",
  runtimeTestAgent: "automation:runtime:test-agent",
  runtimeTestEvent: "automation:runtime:test-event",
  runtimeBalance: "automation:runtime:balance",
  runtimeLoadCodexDefault: "automation:runtime:load-codex-default",
  runtimeLoadClaudeDefault: "automation:runtime:load-claude-default",
  runtimeImportLocal: "automation:runtime:import-local",
  runtimeRefreshModels: "automation:runtime:refresh-models",
  runtimeListCodexPlugins: "automation:runtime:list-codex-plugins",
  workDirSet: "automation:workdir:set",
  workDirChoose: "automation:workdir:choose",
  directoryPick: "automation:directory:pick",
  mcpList: "automation:mcp:list",
  mcpSave: "automation:mcp:save",
  mcpTest: "automation:mcp:test",
  mcpDelete: "automation:mcp:delete",
  mcpSetupStatus: "automation:mcp:setup-status",
  mcpInstalledList: "automation:mcp:installed-list",
  mcpAgentList: "automation:mcp:agent-list",
  mcpAgentInstall: "automation:mcp:agent-install",
  mcpAgentUninstall: "automation:mcp:agent-uninstall",
  evaluationDatasetList: "automation:evaluation:datasets:list",
  evaluationDatasetSave: "automation:evaluation:datasets:save",
  evaluationDatasetDelete: "automation:evaluation:datasets:delete",
  evaluationEvaluatorList: "automation:evaluation:evaluators:list",
  evaluationEvaluatorSave: "automation:evaluation:evaluators:save",
  evaluationEvaluatorDelete: "automation:evaluation:evaluators:delete",
  evaluationExperimentList: "automation:evaluation:experiments:list",
  evaluationExperimentSave: "automation:evaluation:experiments:save",
  evaluationExperimentDelete: "automation:evaluation:experiments:delete",
  evaluationExperimentRun: "automation:evaluation:experiments:run",
  evaluationRunList: "automation:evaluation:runs:list",
  evaluationRunGet: "automation:evaluation:runs:get",
  evaluationRunDelete: "automation:evaluation:runs:delete",
  workflowCoreGet: "automation:workflow:get",
  workflowDefinitionSave: "automation:workflow:definition:save",
  workflowDefinitionDelete: "automation:workflow:definition:delete",
  workflowRunStart: "automation:workflow:run:start",
  workflowRunPause: "automation:workflow:run:pause",
  workflowRunResume: "automation:workflow:run:resume",
  workflowRunCancel: "automation:workflow:run:cancel",
  workflowRunStream: "automation:workflow:run:stream",
  workflowNodeRetry: "automation:workflow:node:retry",
  workflowApprovalResolve: "automation:workflow:approval:resolve",
  approvalResolve: "automation:approval:resolve",
} as const;

export const AUTOMATION_CHANGE_PROTOCOL_VERSION = 1 as const;

export interface WorkflowAutomationProjection {
  workflowStore: WorkflowStoreState;
  workflowNodeConversations: WorkflowNodeConversation[];
  workflowDraft: WorkflowDraftState | undefined;
  tasks: TaskRun[];
  artifacts: RegisteredArtifact[];
}

export interface AutomationEntityPatch<T> {
  upsert: T[];
  remove: string[];
}

export interface WorkflowAutomationPatch {
  activeWorkflowId?: string | null;
  readinessByWorkflowId?: WorkflowStoreState["readinessByWorkflowId"];
  workflows?: AutomationEntityPatch<WorkflowDraftState>;
  runs?: AutomationEntityPatch<WorkflowStoreState["runs"][number]>;
  conversations?: AutomationEntityPatch<WorkflowNodeConversation>;
  tasks?: AutomationEntityPatch<TaskRun>;
  artifacts?: AutomationEntityPatch<RegisteredArtifact>;
}

export interface AutomationChange {
  protocolVersion: typeof AUTOMATION_CHANGE_PROTOCOL_VERSION;
  sequence: number;
  detectedAt: number;
  domain: "workflow";
  entityId: "workflow-state";
  operation: "patch";
  payload: WorkflowAutomationPatch;
}

export interface AutomationHealth {
  state: "idle" | "initializing" | "ready" | "error" | "stopped";
  error?: string;
}
