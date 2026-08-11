import type { IpcMain } from "electron";
import { z } from "zod";
import type {
  AgentChannel,
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  ResolveRuntimeApprovalRequest,
  McpServerDefinition,
} from "../../automation/contracts";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";
import type { WorkflowDefinition } from "../../automation/engine/shared/workflow/model";
import { loadClaudeDefaultConfig, loadCodexDefaultConfig } from "../../automation/engine/main/channels/model-config";
import { AUTOMATION_CHANNELS } from "../../shared/ipc/automation";
import type { NativeAutomationService } from "../services/automation-service";

const idSchema = z.string().trim().min(1).max(256);
const pathSchema = z.string().trim().min(1).max(8_192);
const runtimeIdSchema = z.enum(["codex", "claude", "api", "hermes", "opencode", "openclaw"]);
const channelSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(200),
  agentId: runtimeIdSchema,
  models: z.array(z.object({
    id: idSchema,
    label: z.string().trim().min(1).max(200),
  }).passthrough()).max(500),
}).passthrough();
const agentSchema = z.object({
  id: idSchema,
  agentType: z.enum(["execution", "composed"]).optional(),
  name: z.string().trim().min(1).max(200),
  instructions: z.string().max(500_000).optional(),
  baseAgentId: idSchema.optional(),
  runtimeAgentId: runtimeIdSchema,
  channelId: idSchema,
  modelId: idSchema,
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(20_000),
  tags: z.array(z.string().max(200)).max(200),
  mcpBindings: z.array(z.object({
    serverId: idSchema,
    toolAllowlist: z.array(z.string().trim().min(1).max(512)).max(1_000),
  }).strict()).max(200).optional(),
  currentRevisionId: idSchema.optional(),
  revision: z.number().int().positive().max(1_000_000_000).optional(),
  managed: z.boolean().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict();
const timestampSchema = z.number().finite().nonnegative();

function isBoundedJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 200_000;
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((item) => isBoundedJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 500 && entries.every(
    ([key, item]) => key.length <= 200 && isBoundedJsonValue(item, depth + 1),
  );
}

const evaluationMetadataSchema = z.record(z.string().max(200), z.unknown()).refine(
  (value) => isBoundedJsonValue(value),
  "Evaluation metadata must be bounded JSON data.",
);
const evaluationDatasetSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  items: z.array(z.object({
    id: idSchema,
    input: z.string().min(1).max(200_000),
    expectedOutput: z.string().max(200_000).optional(),
    metadata: evaluationMetadataSchema,
    sequence: z.number().int().nonnegative(),
  }).strict()).max(5_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationEvaluatorSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["contains", "exact_match", "json_valid", "llm_judge"]),
  prompt: z.string().max(500_000).optional(),
  runtimeId: idSchema.optional(),
  threshold: z.number().finite().min(0).max(1),
  enabled: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationExperimentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  datasetId: idSchema,
  agentId: idSchema,
  evaluatorIds: z.array(idSchema).max(500),
  repetitions: z.number().int().min(1).max(5),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
const evaluationRunListSchema = z.object({
  experimentId: idSchema.optional(),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const workflowIdSchema = z.object({ workflowId: idSchema });
const boundedWorkflowObjectSchema = z.record(z.string().max(200), z.unknown()).refine(
  (value) => isBoundedJsonValue(value),
  "Workflow data must be bounded JSON data.",
);
const workflowDefinitionSchema = boundedWorkflowObjectSchema;
const workflowCoreRunSchema = z.object({
  workflowId: idSchema,
  inputs: boundedWorkflowObjectSchema,
}).strict();
const workflowCoreRunIdSchema = z.object({ runId: idSchema }).strict();
const workflowCoreNodeSchema = workflowCoreRunIdSchema.extend({ nodeId: idSchema }).strict();
const workflowCoreApprovalSchema = workflowCoreNodeSchema.extend({ outputs: boundedWorkflowObjectSchema }).strict();
const mcpInstallSchema = z.object({
  agentId: idSchema,
  catalogId: idSchema,
  allowedPath: pathSchema.optional(),
  token: z.string().max(20_000).optional(),
});
const mcpToolSchema = z.object({
  name: idSchema,
  description: z.string().max(20_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
const mcpServerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().max(8_192).optional(),
  args: z.array(z.string().max(8_192)).max(200),
  url: z.string().trim().max(8_192).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(512)),
  headers: z.record(z.string().max(512), z.string().max(512)).optional(),
  enabled: z.boolean(),
  tools: z.array(mcpToolSchema).max(5_000),
  disabledTools: z.array(z.string().max(8_192)).max(5_000).optional(),
  status: z.enum(["untested", "connected", "error"]),
  lastError: z.string().max(20_000).optional(),
  lastTestedAt: z.number().finite().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).superRefine((server, context) => {
  if (server.transport === "stdio" && !server.command) {
    context.addIssue({ code: "custom", path: ["command"], message: "MCP stdio command is required." });
  }
  if (server.transport === "http") {
    try {
      const protocol = new URL(server.url ?? "").protocol;
      if (protocol !== "http:" && protocol !== "https:") throw new Error("unsupported");
    } catch {
      context.addIssue({ code: "custom", path: ["url"], message: "MCP URL must use http or https." });
    }
  }
});

interface RegisterAutomationIpcOptions {
  ipc: Pick<IpcMain, "handle">;
  service: NativeAutomationService;
  send: (channel: string, payload: unknown) => void;
  pickDirectory?: (defaultPath?: string) => Promise<string | undefined>;
}

export function registerAutomationIpc({
  ipc,
  service,
  send,
  pickDirectory,
}: RegisterAutomationIpcOptions): () => void {
  const ready = <Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipc.handle(channel, async (_event, ...args: Args) => {
      await service.requireReady();
      return handler(...args);
    });
  };
  const prepared = <Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipc.handle(channel, async (_event, ...args: Args) => {
      await service.requirePrepared();
      return handler(...args);
    });
  };

  ipc.handle(AUTOMATION_CHANNELS.health, () => service.health());
  prepared(AUTOMATION_CHANNELS.snapshot, () => service.snapshot());
  ready(AUTOMATION_CHANNELS.runtimeSaveChannels, (value: unknown) =>
    service.runtime.saveModelChannels(
      z.array(channelSchema).max(500).parse(value) as AgentChannel[],
      { validateDeletedChannelReferences: true },
    ));
  ready(AUTOMATION_CHANNELS.runtimeSaveAgents, (value: unknown) =>
    service.updateConfiguredAgents(
      z.array(agentSchema).max(500).parse(value) as ConfiguredAgent[],
      { detectDeletedManagedAgents: true },
    ));
  ready(AUTOMATION_CHANNELS.runtimeDeleteAgent, (value: unknown) =>
    service.deleteConfiguredAgent(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeTestChannel, (value: unknown) =>
    service.runtime.testRuntimeChannel(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeTestAgent, (value: unknown) =>
    service.runtime.testConfiguredAgent(idSchema.parse(value), (event) => send(AUTOMATION_CHANNELS.runtimeTestEvent, event)));
  ready(AUTOMATION_CHANNELS.runtimeBalance, (value: unknown) => service.runtime.queryRuntimeChannelBalance(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeLoadCodexDefault, () => loadCodexDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeLoadClaudeDefault, () => loadClaudeDefaultConfig());
  ready(AUTOMATION_CHANNELS.runtimeImportLocal, (value: unknown) => {
    const request = z.object({ runtimeId: runtimeIdSchema, channelId: idSchema.optional() }).parse(value);
    return service.runtime.importRuntimeLocalConfig(request.runtimeId, request.channelId);
  });
  ready(AUTOMATION_CHANNELS.runtimeRefreshModels, (value: unknown) => service.runtime.refreshModelCatalog(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.runtimeListCodexPlugins, () => service.runtime.listCodexPluginCatalog());
  ready(AUTOMATION_CHANNELS.workDirSet, (value: unknown) => {
    service.runtime.setWorkDir(pathSchema.parse(value));
    return service.runtime.snapshot();
  });
  ready(AUTOMATION_CHANNELS.workDirChoose, async () => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const selected = await pickDirectory(service.runtime.getWorkDir());
    if (selected) service.runtime.setWorkDir(pathSchema.parse(selected));
    return service.runtime.snapshot();
  });
  ready(AUTOMATION_CHANNELS.directoryPick, async (value: unknown) => {
    if (!pickDirectory) throw new Error("Directory picker is unavailable.");
    const defaultPath = value === undefined || value === "" ? undefined : pathSchema.parse(value);
    return pickDirectory(defaultPath);
  });

  ready(AUTOMATION_CHANNELS.mcpList, () => service.mcp.list());
  ready(AUTOMATION_CHANNELS.mcpSave, (value: unknown) =>
    service.mcp.save(mcpServerSchema.parse(value) as McpServerDefinition));
  ready(AUTOMATION_CHANNELS.mcpTest, (value: unknown) =>
    service.mcp.test(mcpServerSchema.parse(value) as McpServerDefinition));
  ready(AUTOMATION_CHANNELS.mcpDelete, (value: unknown) =>
    service.mcp.delete(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpSetupStatus, () => service.mcp.setupStatus());
  ready(AUTOMATION_CHANNELS.mcpInstalledList, () => service.mcp.listInstalled());
  ready(AUTOMATION_CHANNELS.mcpAgentList, (value: unknown) => service.mcp.listForAgent(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.mcpAgentInstall, (value: unknown) => service.mcp.install(mcpInstallSchema.parse(value) as McpInstallRequest));
  ready(AUTOMATION_CHANNELS.mcpAgentUninstall, (value: unknown) => service.mcp.uninstall(mcpInstallSchema.parse(value) as McpInstallRequest));

  ready(AUTOMATION_CHANNELS.evaluationDatasetList, () => service.evaluations.listDatasets());
  ready(AUTOMATION_CHANNELS.evaluationDatasetSave, (value: unknown) =>
    service.evaluations.saveDataset(evaluationDatasetSchema.parse(value) as EvaluationDataset));
  ready(AUTOMATION_CHANNELS.evaluationDatasetDelete, (value: unknown) =>
    service.evaluations.deleteDataset(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorList, () => service.evaluations.listEvaluators());
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorSave, (value: unknown) =>
    service.evaluations.saveEvaluator(evaluationEvaluatorSchema.parse(value) as EvaluationEvaluator));
  ready(AUTOMATION_CHANNELS.evaluationEvaluatorDelete, (value: unknown) =>
    service.evaluations.deleteEvaluator(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationExperimentList, () => service.evaluations.listExperiments());
  ready(AUTOMATION_CHANNELS.evaluationExperimentSave, (value: unknown) =>
    service.evaluations.saveExperiment(evaluationExperimentSchema.parse(value) as EvaluationExperiment));
  ready(AUTOMATION_CHANNELS.evaluationExperimentDelete, (value: unknown) =>
    service.evaluations.deleteExperiment(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationExperimentRun, (value: unknown) => {
    const request = z.object({ experimentId: idSchema }).strict().parse(value);
    return service.evaluations.runExperiment(request.experimentId);
  });
  ready(AUTOMATION_CHANNELS.evaluationRunList, (value: unknown) =>
    service.evaluations.listRuns(value === undefined ? undefined : evaluationRunListSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationRunGet, (value: unknown) =>
    service.evaluations.getRun(idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.evaluationRunDelete, (value: unknown) =>
    service.evaluations.deleteRun(idSchema.parse(value)));

  ready(AUTOMATION_CHANNELS.workflowCoreGet, (value: unknown) =>
    service.workflowCore.snapshot(value === undefined ? undefined : idSchema.parse(value)));
  ready(AUTOMATION_CHANNELS.workflowDefinitionSave, (value: unknown) =>
    service.workflowCore.saveDefinition(workflowDefinitionSchema.parse(value) as unknown as WorkflowDefinition));
  ready(AUTOMATION_CHANNELS.workflowDefinitionDelete, (value: unknown) => {
    const request = workflowIdSchema.strict().parse(value);
    return service.workflowCore.deleteDefinition(request.workflowId);
  });
  ready(AUTOMATION_CHANNELS.workflowRunStart, (value: unknown) => {
    const request = workflowCoreRunSchema.parse(value);
    return service.workflowCore.startRun(request.workflowId, request.inputs);
  });
  ready(AUTOMATION_CHANNELS.workflowRunPause, (value: unknown) =>
    service.workflowCore.pauseRun(workflowCoreRunIdSchema.parse(value).runId));
  ready(AUTOMATION_CHANNELS.workflowRunResume, (value: unknown) =>
    service.workflowCore.resumeRun(workflowCoreRunIdSchema.parse(value).runId));
  ready(AUTOMATION_CHANNELS.workflowRunCancel, (value: unknown) =>
    service.workflowCore.cancelRun(workflowCoreRunIdSchema.parse(value).runId));
  ready(AUTOMATION_CHANNELS.workflowNodeRetry, (value: unknown) => {
    const request = workflowCoreNodeSchema.parse(value);
    return service.workflowCore.retryNode(request.runId, request.nodeId);
  });
  ready(AUTOMATION_CHANNELS.workflowApprovalResolve, (value: unknown) => {
    const request = workflowCoreApprovalSchema.parse(value);
    return service.workflowCore.resolveApproval(request.runId, request.nodeId, request.outputs);
  });

  ready(AUTOMATION_CHANNELS.approvalResolve, (value: unknown) => {
    const request = z.object({
      ownerId: idSchema,
      requestId: idSchema,
      decision: z.enum(["approved", "rejected"]),
    }).parse(value) as ResolveRuntimeApprovalRequest;
    return service.resolveRuntimeApproval(request);
  });

  const unsubscribeSnapshot = service.subscribe((snapshot) => send(AUTOMATION_CHANNELS.snapshotChanged, snapshot));
  const unsubscribeChanges = service.subscribeChanges((change) => send(AUTOMATION_CHANNELS.change, change));
  const unsubscribeWorkflowRunStream = service.subscribeWorkflowRunStream((event) =>
    send(AUTOMATION_CHANNELS.workflowRunStream, event));
  return () => {
    unsubscribeSnapshot();
    unsubscribeChanges();
    unsubscribeWorkflowRunStream();
  };
}
