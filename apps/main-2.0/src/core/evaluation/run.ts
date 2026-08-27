import {
  aggregateEvaluationCase,
  type EvaluationCaseAggregate,
} from "./graph/aggregate";
import { executeEvaluationGraph } from "./graph/scheduler";
import {
  scoreEvaluationCase,
  scoreEvaluationRun,
  type EvaluationCaseScore,
  type EvaluationRunScore,
} from "./graph/scorer";
import type { EvaluationNodeRecord } from "./graph/node";
import {
  AGENT_NODE_ID,
  buildEvaluationCaseGraph,
  SESSION_NODE_ID,
  SKILL_NODE_ID,
  type EvaluationCasePlan,
  type EvaluationPlanEvaluator,
} from "./case-graph";
import type {
  EvaluationExecutionValue,
  EvaluationInstructionsValue,
  EvaluationNodeDependencies,
  EvaluationSessionValue,
  EvaluationSkillInjection,
  EvaluationTaskValue,
} from "./nodes/contracts";

/**
 * Runs every case of an experiment through its own graph.
 *
 * Cases are independent graphs rather than one large one: a judge for case two
 * has no reason to wait on case one, and an isolated graph means one case's
 * infrastructure failure cannot mark another case's nodes as blocked.
 */

export interface EvaluationRunPlan {
  agentId: string;
  skillName: string | null;
  evaluators: readonly EvaluationPlanEvaluator[];
  cases: readonly EvaluationTaskValue[];
  linkSessions: boolean;
  sessionLink?: { attempts?: number; delayMs?: number };
  /**
   * Cases executed at once. Defaults to 1: a case spawns a real agent, and
   * running several against one working directory is not something the runtimes
   * promise to tolerate. Judges inside a case still run concurrently.
   */
  maxConcurrentCases?: number;
  maxConcurrentNodes?: number;
}

export interface EvaluationCaseOutcome {
  caseId: string;
  task: EvaluationTaskValue;
  aggregate: EvaluationCaseAggregate;
  score: EvaluationCaseScore;
  /** The agent's answer; empty when it never produced one. */
  output: string;
  durationMs: number;
  sessionKey?: string;
  skill?: EvaluationSkillInjection;
  /** Why this case produced no score, when it produced none. */
  unscoredReason?: string;
  cancelled: boolean;
}

export interface EvaluationRunOutcome {
  cases: EvaluationCaseOutcome[];
  score: EvaluationRunScore;
  cancelled: boolean;
}

export interface EvaluationRunOptions {
  signal?: AbortSignal;
  onCaseComplete?: (outcome: EvaluationCaseOutcome) => Promise<void> | void;
  onNodeRecord?: (caseId: string, record: EvaluationNodeRecord) => void;
  now?: () => number;
}

export async function executeEvaluationRun(
  plan: EvaluationRunPlan,
  dependencies: EvaluationNodeDependencies,
  options: EvaluationRunOptions = {},
): Promise<EvaluationRunOutcome> {
  const maxConcurrentCases = Math.max(1, plan.maxConcurrentCases ?? 1);
  const outcomes = new Map<string, EvaluationCaseOutcome>();
  const queue = [...plan.cases];
  let cancelled = options.signal?.aborted === true;

  const workers = Array.from(
    { length: Math.min(maxConcurrentCases, Math.max(1, queue.length)) },
    async () => {
      for (;;) {
        const task = queue.shift();
        if (!task) return;
        if (options.signal?.aborted) {
          cancelled = true;
          // Remaining cases are dropped rather than recorded: they were never
          // planned into a graph, so there is nothing to report about them.
          return;
        }
        const outcome = await runCase(task, plan, dependencies, options);
        if (outcome.cancelled) cancelled = true;
        outcomes.set(task.caseId, outcome);
        await options.onCaseComplete?.(outcome);
      }
    },
  );
  await Promise.all(workers);

  const ordered = plan.cases
    .map((task) => outcomes.get(task.caseId))
    .filter((outcome): outcome is EvaluationCaseOutcome => outcome !== undefined);
  return {
    cases: ordered,
    score: scoreEvaluationRun(ordered.map((outcome) => outcome.score)),
    cancelled,
  };
}

async function runCase(
  task: EvaluationTaskValue,
  plan: EvaluationRunPlan,
  dependencies: EvaluationNodeDependencies,
  options: EvaluationRunOptions,
): Promise<EvaluationCaseOutcome> {
  const casePlan: EvaluationCasePlan = {
    task,
    agentId: plan.agentId,
    skillName: plan.skillName,
    evaluators: plan.evaluators,
    linkSessions: plan.linkSessions,
    ...(plan.sessionLink ? { sessionLink: plan.sessionLink } : {}),
  };
  const graph = buildEvaluationCaseGraph(casePlan, dependencies);
  const execution = await executeEvaluationGraph({
    graph,
    caseId: task.caseId,
    ...(plan.maxConcurrentNodes ? { maxConcurrent: plan.maxConcurrentNodes } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onNodeRecord
      ? { onNodeRecord: (record: EvaluationNodeRecord) => options.onNodeRecord!(task.caseId, record) }
      : {}),
  });

  const aggregate = aggregateEvaluationCase(task.caseId, execution.records, {
    cancelled: execution.cancelled,
  });
  const score = scoreEvaluationCase(aggregate);
  const agentExecution = execution.values.get(AGENT_NODE_ID)?.get("execution") as
    | EvaluationExecutionValue
    | undefined;
  const session = execution.values.get(SESSION_NODE_ID)?.get("session") as
    | EvaluationSessionValue
    | undefined;
  const instructions = execution.values.get(SKILL_NODE_ID)?.get("instructions") as
    | EvaluationInstructionsValue
    | undefined;

  return {
    caseId: task.caseId,
    task,
    aggregate,
    score,
    output: agentExecution?.output ?? "",
    durationMs: agentExecution?.durationMs ?? 0,
    ...(session ? { sessionKey: session.sessionKey } : {}),
    ...(instructions?.skill ? { skill: instructions.skill } : {}),
    ...(score.score === null
      ? { unscoredReason: unscoredReason(execution.records, execution.cancelled) }
      : {}),
    cancelled: execution.cancelled,
  };
}

/**
 * Names the first thing that stopped this case from being scored.
 *
 * Nodes are inspected in graph order so the answer is the earliest cause rather
 * than the last symptom: a judge left `pending` is worth far less to a reader
 * than the agent failure that blocked it.
 */
function unscoredReason(
  records: readonly EvaluationNodeRecord[],
  cancelled: boolean,
): string {
  if (cancelled) return "case_cancelled";
  for (const record of records) {
    if (record.status === "excused" || record.status === "error") {
      return record.attribution?.reason ?? record.status;
    }
    if (record.status === "fail") return record.attribution?.reason ?? "failed";
  }
  const pending = records.find((record) => record.status === "pending");
  if (pending) return pending.pendingReason ?? "not_decided";
  return "no_evaluator_decided";
}
