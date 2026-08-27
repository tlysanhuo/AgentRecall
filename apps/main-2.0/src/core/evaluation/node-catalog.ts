import { createEvaluationNodeRegistry, type EvaluationNodeRegistry } from "./graph/builder";
import { createEvaluationNodeDefinitions } from "./case-graph";
import type { EvaluationNodeRole } from "./graph/node";
import type { EvaluationPortMap } from "./graph/ports";
import {
  AGENT_EXECUTE_NODE_TYPE,
  EVIDENCE_EXTRACT_NODE_TYPE,
  SESSION_LINK_NODE_TYPE,
  SKILL_PROVISION_NODE_TYPE,
  SKILL_USE_OBSERVE_NODE_TYPE,
  TASK_SOURCE_NODE_TYPE,
} from "./nodes/prepare-nodes";
import {
  DETERMINISTIC_JUDGE_NODE_TYPE,
  LLM_JUDGE_NODE_TYPE,
} from "./nodes/judge-nodes";

/**
 * What an editor needs to know about the node set.
 *
 * Ports are read from the real node definitions rather than restated here, so a
 * palette can never advertise a port the engine does not have. Only the
 * editor-facing parts — display names and which config fields a node takes — are
 * declared, because the engine has no opinion about them.
 */

export type EvaluationConfigFieldKind =
  /** One of the configured execution Agents. */
  | "agent"
  /** An installed skill name, or empty for "inject nothing". */
  | "skill"
  /** One of the saved evaluators; also fills kind, threshold, prompt and runtime. */
  | "evaluator"
  | "number";

export interface EvaluationConfigFieldDescriptor {
  key: string;
  kind: EvaluationConfigFieldKind;
  required: boolean;
  labelEn: string;
  labelZh: string;
}

export interface EvaluationPortDescriptor {
  name: string;
  kind: string;
}

export interface EvaluationNodeCatalogEntry {
  type: string;
  role: EvaluationNodeRole;
  labelEn: string;
  labelZh: string;
  descriptionEn: string;
  descriptionZh: string;
  inputs: EvaluationPortDescriptor[];
  outputs: EvaluationPortDescriptor[];
  configFields: EvaluationConfigFieldDescriptor[];
  /**
   * The task node's config is the case itself, so a run overwrites whatever the
   * editor saved. Marked here so an editor does not offer to fill it in.
   */
  configuredPerCase?: boolean;
}

interface CatalogPresentation {
  labelEn: string;
  labelZh: string;
  descriptionEn: string;
  descriptionZh: string;
  configFields: EvaluationConfigFieldDescriptor[];
  configuredPerCase?: boolean;
}

const PRESENTATION: Record<string, CatalogPresentation> = {
  [TASK_SOURCE_NODE_TYPE]: {
    labelEn: "Task",
    labelZh: "任务",
    descriptionEn: "Emits the case under evaluation.",
    descriptionZh: "产出当前被评测的用例。",
    configFields: [],
    configuredPerCase: true,
  },
  [SKILL_PROVISION_NODE_TYPE]: {
    labelEn: "Skill injection",
    labelZh: "Skill 注入",
    descriptionEn: "Reads a skill's instructions and freezes its version into the run.",
    descriptionZh: "读取 Skill 说明并把其版本固定到本次运行。",
    configFields: [
      { key: "skillName", kind: "skill", required: false, labelEn: "Skill", labelZh: "Skill" },
    ],
  },
  [AGENT_EXECUTE_NODE_TYPE]: {
    labelEn: "Agent run",
    labelZh: "Agent 执行",
    descriptionEn: "Runs the evaluated Agent once on the task.",
    descriptionZh: "让被评测 Agent 执行一次任务。",
    configFields: [
      { key: "agentId", kind: "agent", required: true, labelEn: "Agent", labelZh: "Agent" },
    ],
  },
  [SESSION_LINK_NODE_TYPE]: {
    labelEn: "Session link",
    labelZh: "会话关联",
    descriptionEn: "Links the run to the session it produced, waiting for indexing.",
    descriptionZh: "把运行关联到它产生的会话，会等待索引完成。",
    configFields: [
      { key: "attempts", kind: "number", required: false, labelEn: "Attempts", labelZh: "重试次数" },
      { key: "delayMs", kind: "number", required: false, labelEn: "Delay (ms)", labelZh: "间隔（毫秒）" },
    ],
  },
  [EVIDENCE_EXTRACT_NODE_TYPE]: {
    labelEn: "Trace",
    labelZh: "轨迹提取",
    descriptionEn: "Reads the linked session's turns, tool calls and usage.",
    descriptionZh: "读取关联会话的轮次、工具调用与用量。",
    configFields: [],
  },
  [SKILL_USE_OBSERVE_NODE_TYPE]: {
    labelEn: "Skill use",
    labelZh: "Skill 使用",
    descriptionEn: "Records whether the injected skill was used. Never affects the score.",
    descriptionZh: "记录注入的 Skill 是否被使用，不影响评分。",
    configFields: [],
  },
  [DETERMINISTIC_JUDGE_NODE_TYPE]: {
    labelEn: "Check",
    labelZh: "确定性判定",
    descriptionEn: "Exact match, substring or JSON shape. No model involved.",
    descriptionZh: "精确匹配、包含或 JSON 合法性判定，不调用模型。",
    configFields: [
      { key: "evaluatorId", kind: "evaluator", required: true, labelEn: "Evaluator", labelZh: "评分器" },
    ],
  },
  [LLM_JUDGE_NODE_TYPE]: {
    labelEn: "LLM judge",
    labelZh: "模型评判",
    descriptionEn: "Scores the answer with a judge model.",
    descriptionZh: "用评判模型给答案打分。",
    configFields: [
      { key: "evaluatorId", kind: "evaluator", required: true, labelEn: "Evaluator", labelZh: "评分器" },
    ],
  },
};

/**
 * A registry usable for building and validating a graph, but not for running it.
 *
 * The node factories need host dependencies to execute; structural validation
 * needs only their declared ports. The stubs make the distinction explicit
 * instead of letting an unrunnable registry look like a working one.
 */
export function createEvaluationValidationRegistry(): EvaluationNodeRegistry {
  return createEvaluationNodeRegistry(
    createEvaluationNodeDefinitions({
      executeAgent: () => {
        throw new Error("The validation registry cannot execute nodes.");
      },
    }),
  );
}

export function evaluationNodeCatalog(): EvaluationNodeCatalogEntry[] {
  return createEvaluationValidationRegistry().list().map((definition) => {
    const presentation = PRESENTATION[definition.type];
    if (!presentation) {
      throw new Error(`Evaluation node ${definition.type} has no catalog presentation.`);
    }
    return {
      type: definition.type,
      role: definition.role,
      ...presentation,
      inputs: describePorts(definition.inputs as EvaluationPortMap),
      outputs: describePorts(definition.outputs as EvaluationPortMap),
    };
  });
}

function describePorts(ports: EvaluationPortMap): EvaluationPortDescriptor[] {
  return Object.entries(ports).map(([name, spec]) => ({ name, kind: spec.kind }));
}
