import {
  buildEvaluationGraph,
  createEvaluationNodeRegistry,
  type BuiltEvaluationGraph,
  type EvaluationGraphNodeSpec,
  type EvaluationGraphSpec,
} from "./graph/builder";
import type { AnyEvaluationNodeDefinition } from "./graph/node";
import {
  createAgentExecuteNode,
  createEvidenceExtractNode,
  createSessionLinkNode,
  createSkillProvisionNode,
  skillUseObserveNode,
  taskSourceNode,
  AGENT_EXECUTE_NODE_TYPE,
  EVIDENCE_EXTRACT_NODE_TYPE,
  SESSION_LINK_NODE_TYPE,
  SKILL_PROVISION_NODE_TYPE,
  SKILL_USE_OBSERVE_NODE_TYPE,
  TASK_SOURCE_NODE_TYPE,
} from "./nodes/prepare-nodes";
import {
  createLlmJudgeNode,
  deterministicJudgeNode,
  DETERMINISTIC_JUDGE_NODE_TYPE,
  LLM_JUDGE_NODE_TYPE,
} from "./nodes/judge-nodes";
import type { EvaluationNodeDependencies, EvaluationTaskValue } from "./nodes/contracts";

/**
 * Assembles the graph for a single evaluation case.
 *
 * One graph per case, so per-case data lives in node config and every case gets
 * an isolated set of records. Node ids are stable across runs of the same
 * experiment, which is what lets two runs be compared node by node.
 */

export const TASK_NODE_ID = "task";
export const SKILL_NODE_ID = "skill";
export const AGENT_NODE_ID = "agent";
export const SESSION_NODE_ID = "session";
export const EVIDENCE_NODE_ID = "evidence";
export const SKILL_USE_NODE_ID = "skill-use";

export interface EvaluationPlanEvaluator {
  id: string;
  kind: "exact_match" | "contains" | "json_valid" | "llm_judge";
  threshold: number;
  runtimeId?: string;
  prompt?: string;
}

export interface EvaluationCasePlan {
  task: EvaluationTaskValue;
  agentId: string;
  skillName: string | null;
  evaluators: readonly EvaluationPlanEvaluator[];
  /** Add the session-link, evidence and skill-use observation nodes. */
  linkSessions: boolean;
  sessionLink?: { attempts?: number; delayMs?: number };
  /**
   * A graph authored in the editor. When present it replaces the derived shape,
   * and only the per-case and evaluator parts of its config are rewritten.
   */
  savedSpec?: EvaluationGraphSpec;
}

export function createEvaluationNodeDefinitions(
  dependencies: EvaluationNodeDependencies,
): AnyEvaluationNodeDefinition[] {
  return [
    taskSourceNode,
    createSkillProvisionNode(dependencies),
    createAgentExecuteNode(dependencies),
    createSessionLinkNode(dependencies),
    createEvidenceExtractNode(dependencies),
    skillUseObserveNode,
    deterministicJudgeNode,
    createLlmJudgeNode(dependencies),
  ];
}

export function buildEvaluationCaseSpec(plan: EvaluationCasePlan): EvaluationGraphSpec {
  const nodes: EvaluationGraphNodeSpec[] = [
    { id: TASK_NODE_ID, type: TASK_SOURCE_NODE_TYPE, config: plan.task },
    {
      id: SKILL_NODE_ID,
      type: SKILL_PROVISION_NODE_TYPE,
      config: { skillName: plan.skillName },
    },
    {
      id: AGENT_NODE_ID,
      type: AGENT_EXECUTE_NODE_TYPE,
      config: { agentId: plan.agentId },
      in: { task: `${TASK_NODE_ID}.task`, instructions: `${SKILL_NODE_ID}.instructions` },
    },
  ];

  if (plan.linkSessions) {
    nodes.push(
      {
        id: SESSION_NODE_ID,
        type: SESSION_LINK_NODE_TYPE,
        config: plan.sessionLink ?? {},
        in: { execution: `${AGENT_NODE_ID}.execution` },
      },
      {
        id: EVIDENCE_NODE_ID,
        type: EVIDENCE_EXTRACT_NODE_TYPE,
        in: { session: `${SESSION_NODE_ID}.session` },
      },
      {
        id: SKILL_USE_NODE_ID,
        type: SKILL_USE_OBSERVE_NODE_TYPE,
        in: {
          instructions: `${SKILL_NODE_ID}.instructions`,
          evidence: `${EVIDENCE_NODE_ID}.evidence`,
        },
      },
    );
  }

  const usedIds = new Set(nodes.map((node) => node.id));
  for (const evaluator of plan.evaluators) {
    const id = evaluatorNodeId(evaluator.id, usedIds);
    usedIds.add(id);
    nodes.push(
      evaluator.kind === "llm_judge"
        ? {
            id,
            type: LLM_JUDGE_NODE_TYPE,
            config: {
              evaluatorId: evaluator.id,
              runtimeId: evaluator.runtimeId ?? "",
              prompt: evaluator.prompt ?? "",
              threshold: evaluator.threshold,
            },
            in: {
              task: `${TASK_NODE_ID}.task`,
              execution: `${AGENT_NODE_ID}.execution`,
            },
          }
        : {
            id,
            type: DETERMINISTIC_JUDGE_NODE_TYPE,
            config: {
              evaluatorId: evaluator.id,
              kind: evaluator.kind,
              threshold: evaluator.threshold,
            },
            in: {
              task: `${TASK_NODE_ID}.task`,
              execution: `${AGENT_NODE_ID}.execution`,
            },
          },
    );
  }

  return { name: `evaluation-case:${plan.task.caseId}`, version: 1, nodes };
}

/**
 * Rewrites a saved graph for one case.
 *
 * Three things a stored graph must not freeze: the case (the task node's config
 * *is* the case), the target agent, and an evaluator's settings. Hydrating them
 * at run time means editing a threshold or a judge prompt takes effect on the
 * next run instead of silently keeping whatever the graph was saved with.
 */
export function hydrateEvaluationCaseSpec(
  saved: EvaluationGraphSpec,
  context: {
    task: EvaluationTaskValue;
    agentId: string;
    skillName: string | null;
    evaluators: readonly EvaluationPlanEvaluator[];
  },
): EvaluationGraphSpec {
  const evaluatorsById = new Map(context.evaluators.map((item) => [item.id, item]));
  return {
    ...saved,
    nodes: saved.nodes.map((node) => {
      const config = (node.config ?? {}) as Record<string, unknown>;
      if (node.type === TASK_SOURCE_NODE_TYPE) {
        return { ...node, config: context.task };
      }
      if (node.type === AGENT_EXECUTE_NODE_TYPE) {
        const agentId = typeof config.agentId === "string" && config.agentId.trim()
          ? config.agentId
          : context.agentId;
        return { ...node, config: { ...config, agentId } };
      }
      if (node.type === SKILL_PROVISION_NODE_TYPE) {
        const skillName = typeof config.skillName === "string" && config.skillName.trim()
          ? config.skillName
          : context.skillName;
        return { ...node, config: { ...config, skillName } };
      }
      if (node.type === DETERMINISTIC_JUDGE_NODE_TYPE || node.type === LLM_JUDGE_NODE_TYPE) {
        const evaluatorId = typeof config.evaluatorId === "string" ? config.evaluatorId : "";
        const evaluator = evaluatorsById.get(evaluatorId);
        // A judge whose evaluator was deleted keeps its saved id and is disabled,
        // so the run reports a skipped step instead of failing to build.
        if (!evaluator) return { ...node, enabled: false, config: { ...config, evaluatorId } };
        return {
          ...node,
          config: node.type === LLM_JUDGE_NODE_TYPE
            ? {
                evaluatorId,
                threshold: evaluator.threshold,
                runtimeId: evaluator.runtimeId ?? "",
                prompt: evaluator.prompt ?? "",
              }
            : { evaluatorId, kind: evaluator.kind, threshold: evaluator.threshold },
        };
      }
      return node;
    }),
  };
}

export function buildEvaluationCaseGraph(
  plan: EvaluationCasePlan,
  dependencies: EvaluationNodeDependencies,
): BuiltEvaluationGraph {
  const spec = plan.savedSpec
    ? hydrateEvaluationCaseSpec(plan.savedSpec, {
        task: plan.task,
        agentId: plan.agentId,
        skillName: plan.skillName,
        evaluators: plan.evaluators,
      })
    : buildEvaluationCaseSpec(plan);
  return buildEvaluationGraph(
    spec,
    createEvaluationNodeRegistry(createEvaluationNodeDefinitions(dependencies)),
  );
}

/**
 * Derives a node id from an evaluator id.
 *
 * Evaluator ids are user data and may contain characters a node id cannot — a
 * dot in particular would be read as the producer/port separator in an input
 * binding, silently pointing a judge at a node that does not exist.
 */
export function evaluatorNodeId(evaluatorId: string, taken: ReadonlySet<string>): string {
  const slug = evaluatorId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "") || "evaluator";
  const base = `judge-${slug}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
