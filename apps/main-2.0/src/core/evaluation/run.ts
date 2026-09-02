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
  type EvaluationScoringConfig,
} from "./graph/scorer";
import type { EvaluationNodeRecord } from "./graph/node";
import type { EvaluationGraphSpec } from "./graph/builder";
import {
  AGENT_NODE_ID,
  buildEvaluationCaseGraph,
  SESSION_NODE_ID,
  SKILL_NODE_ID,
  SOURCE_NODE_ID,
  type EvaluationArtifactSourceKind,
  type EvaluationCasePlan,
  type EvaluationPlanEvaluator,
} from "./case-graph";
import type {
  EvaluationArtifactValue,
  EvaluationInstructionsValue,
  EvaluationNodeDependencies,
  EvaluationSkillInjection,
  EvaluationTaskValue,
  EvaluationTrajectoryValue,
} from "./nodes/contracts";

/**
 * Runs every case of an experiment through its own graph.
 *
 * Cases are independent graphs rather than one large one: a judge for case two
 * has no reason to wait on case one, and an isolated graph means one case's
 * infrastructure failure cannot mark another case's nodes as blocked.
 */

export interface EvaluationRunPlan {
  /** Where each case's artifact comes from. */
  source: EvaluationArtifactSourceKind;
  agentId: string;
  skillName: string | null;
  evaluators: readonly EvaluationPlanEvaluator[];
  cases: readonly EvaluationTaskValue[];
  /** Attach the session-link step to a fresh run so it gains a trajectory. */
  linkTrajectory: boolean;
  sessionLink?: { attempts?: number; delayMs?: number };
  scoring?: EvaluationScoringConfig;
  /**
   * Cases executed at once. Defaults to 1 when the source runs an agent, since a
   * case then spawns a real agent and the runtimes do not promise to tolerate
   * several at once in one working directory. Judging an artifact that already
   * exists has no such constraint.
   */
  maxConcurrentCases?: number;
  maxConcurrentNodes?: number;
  savedSpec?: EvaluationGraphSpec;
}

export interface EvaluationCaseOutcome {
  caseId: string;
  task: EvaluationTaskValue;
  aggregate: EvaluationCaseAggregate;
  score: EvaluationCaseScore;
  /** The artifact's answer text; empty when no artifact was produced. */
  output: string;
  /**
   * Everything else the artifact is: where it came from and which files it
   * consists of. Absent when the source failed before producing one, which is
   * what distinguishes "the agent answered with nothing" from "there was no
   * artifact to judge".
   */
  artifact?: EvaluationArtifactValue;
  durationMs: number;
  sessionKey?: string;
  skill?: EvaluationSkillInjection;
  /** Evaluators this source could not judge, so their absence stays visible. */
  skippedEvaluatorIds: string[];
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
  const maxConcurrentCases = Math.max(
    1,
    plan.maxConcurrentCases ?? (plan.source === "run_agent" ? 1 : 4),
  );
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
    source: plan.source,
    agentId: plan.agentId,
    skillName: plan.skillName,
    evaluators: plan.evaluators,
    linkTrajectory: plan.linkTrajectory,
    ...(plan.sessionLink ? { sessionLink: plan.sessionLink } : {}),
    ...(plan.savedSpec ? { savedSpec: plan.savedSpec } : {}),
  };
  const { graph, skippedEvaluatorIds } = buildEvaluationCaseGraph(casePlan, dependencies);
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
  const score = scoreEvaluationCase(aggregate, plan.scoring ?? {});
  const rawArtifact = firstValue<EvaluationArtifactValue>(execution.values, "artifact");
  const trajectory = firstValue<EvaluationTrajectoryValue>(execution.values, "trajectory");
  const artifact = await completeArtifact(rawArtifact, trajectory, dependencies);
  const instructions = execution.values.get(SKILL_NODE_ID)?.get("instructions") as
    | EvaluationInstructionsValue
    | undefined;

  return {
    caseId: task.caseId,
    task,
    aggregate,
    score,
    output: artifact?.output ?? "",
    ...(artifact ? { artifact } : {}),
    durationMs: artifact?.durationMs ?? trajectory?.durationMs ?? 0,
    ...(trajectory?.sessionKey ? { sessionKey: trajectory.sessionKey } : {}),
    ...(instructions?.skill ? { skill: instructions.skill } : {}),
    skippedEvaluatorIds,
    ...(score.score === null
      ? { unscoredReason: unscoredReason(execution.records, execution.cancelled) }
      : {}),
    cancelled: execution.cancelled,
  };
}

/**
 * Fills in the half of a fresh run's artifact that only its session can tell us.
 *
 * A run produces its answer before the session that recorded it has been found,
 * so at the moment `run_agent` returns there is no way to know which files were
 * written. Once the session-link step has a session key, both are available, and
 * this is where they are put back together — the artifact a judge and a report
 * read is then the same shape whether it came from a fresh run, a stored session
 * or a folder.
 *
 * A reader that fails is ignored on purpose. Files are an observation, and losing
 * one must not cost the case its answer.
 */
async function completeArtifact(
  artifact: EvaluationArtifactValue | undefined,
  trajectory: EvaluationTrajectoryValue | undefined,
  dependencies: EvaluationNodeDependencies,
): Promise<EvaluationArtifactValue | undefined> {
  if (!artifact || artifact.origin.kind !== "agent_run") return artifact;
  const sessionKey = trajectory?.sessionKey?.trim();
  if (!sessionKey) return artifact;
  const files = artifact.files ?? await readFilesQuietly(dependencies, sessionKey);
  return {
    ...artifact,
    ...(files && files.length > 0 ? { files } : {}),
    // A fresh run's artifact does live somewhere once it has been linked, and a
    // reader that cannot say where would send anyone verifying a score back to
    // the run log.
    origin: { ...artifact.origin, reference: sessionKey },
  };
}

async function readFilesQuietly(
  dependencies: EvaluationNodeDependencies,
  sessionKey: string,
): Promise<EvaluationArtifactValue["files"]> {
  if (!dependencies.readArtifactFiles) return undefined;
  try {
    return await dependencies.readArtifactFiles(sessionKey) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a port from whichever node produced it.
 *
 * The producing node differs by source — a fresh run yields the artifact from
 * `agent`, a session or folder from `source` — and the caller only wants the
 * value.
 */
function firstValue<T>(
  values: Map<string, Map<string, unknown>>,
  port: string,
): T | undefined {
  for (const nodeId of [AGENT_NODE_ID, SOURCE_NODE_ID, SESSION_NODE_ID]) {
    const value = values.get(nodeId)?.get(port);
    if (value !== undefined) return value as T;
  }
  for (const ports of values.values()) {
    const value = ports.get(port);
    if (value !== undefined) return value as T;
  }
  return undefined;
}

/**
 * Names the first thing that stopped this case from being scored.
 *
 * Nodes are inspected in graph order so the answer is the earliest cause rather
 * than the last symptom: a judge left `pending` is worth far less to a reader
 * than the source failure that blocked it.
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
