import { executeEvaluationRun } from "../../../core/evaluation/run";
import type { EvaluationPlanEvaluator } from "../../../core/evaluation/case-graph";
import type {
  EvaluationEvidenceValue,
  EvaluationExecutionValue,
  EvaluationNodeDependencies,
  EvaluationSessionValue,
  EvaluationTaskValue,
} from "../../../core/evaluation/nodes/contracts";
import type { EvaluationCaseOutcome } from "../../../core/evaluation/run";
import type {
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationScore,
} from "../shared/evaluation/types";

/**
 * Adapter between the stored experiment shape and the evaluation graph.
 *
 * The engine itself lives in `src/core/evaluation`; everything here is
 * translation: an experiment becomes a run plan, and each case outcome becomes
 * the case/score rows the store and the existing clients already understand,
 * plus the node records that explain how the case got there.
 */

export type EvaluationExecutionRequest = {
  configuredAgentId: string;
  prompt: string;
  developerInstructions?: string;
};

export type EvaluationExecutionResult = EvaluationExecutionValue;

export interface RunEvaluationInput {
  experiment: EvaluationExperiment;
  dataset: EvaluationDataset;
  evaluators: EvaluationEvaluator[];
  agentRevisionId?: string;
  // Stable id assigned before execution starts so callers can persist and poll
  // the run immediately; generated when omitted.
  runId?: string;
  // Skill version fingerprint attributed to every snapshot of this run.
  skillHash?: string | null;
  // Cooperative cancellation. Checked between cases and forwarded to the
  // executor; an aborted run finalizes as "cancelled" with partial results.
  signal?: AbortSignal;
  // Receives a snapshot at start ("running"), after every finished case, and at
  // the end, so persistence and progress polling share one source of truth.
  onRunUpdate?: (run: EvaluationRun) => Promise<void>;
  execute: (
    request: EvaluationExecutionRequest,
    signal?: AbortSignal,
  ) => Promise<EvaluationExecutionResult>;
  executeJudge?: (
    runtimeId: string,
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
  /** Reads the SKILL.md bytes and hash of the skill this experiment injects. */
  readSkill?: (skillName: string) => Promise<{ content: string; hash: string } | null>;
  /** Resolves a runtime session id to the indexed AgentRecall session. */
  resolveSession?: (rawId: string) => Promise<EvaluationSessionValue | null>;
  readTrace?: (sessionKey: string) => Promise<EvaluationEvidenceValue | null>;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationRun> {
  const startedAt = Date.now();
  const runId = input.runId ?? `eval-run-${startedAt}`;
  const repetitions = Math.max(1, Math.min(5, input.experiment.repetitions));
  const results: EvaluationCaseResult[] = [];

  const cases: EvaluationTaskValue[] = [];
  for (const item of input.dataset.items) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      cases.push({
        caseId: `${runId}:${item.id}:${repetition}`,
        datasetItemId: item.id,
        repetition,
        input: item.input,
        ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
        ...(typeof item.metadata.context === "string"
          ? { context: item.metadata.context }
          : {}),
        metadata: item.metadata,
      });
    }
  }

  const dependencies: EvaluationNodeDependencies = {
    executeAgent: (request, signal) =>
      input.execute(
        {
          configuredAgentId: request.agentId,
          prompt: request.prompt,
          ...(request.developerInstructions
            ? { developerInstructions: request.developerInstructions }
            : {}),
        },
        signal,
      ),
    ...(input.executeJudge
      ? {
          executeJudge: (request, signal) =>
            input.executeJudge!(request.runtimeId, request.prompt, signal),
        }
      : {}),
    ...(input.readSkill ? { readSkill: input.readSkill } : {}),
    ...(input.resolveSession ? { resolveSession: input.resolveSession } : {}),
    ...(input.readTrace ? { readTrace: input.readTrace } : {}),
    ...(input.wait ? { wait: input.wait } : {}),
  };

  let snapshotScore: EvaluationRunSnapshotScore = {};
  const snapshot = (status: EvaluationRun["status"]): EvaluationRun => ({
    id: runId,
    experimentId: input.experiment.id,
    status,
    engine: "graph",
    ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
    ...(input.skillHash ? { skillHash: input.skillHash } : {}),
    startedAt,
    ...(status === "running" ? {} : { finishedAt: Date.now() }),
    ...snapshotScore,
    totalDurationMs: Date.now() - startedAt,
    results: [...results],
  });
  const publish = async (status: EvaluationRun["status"]) => {
    await input.onRunUpdate?.(snapshot(status));
  };

  await publish("running");

  const outcome = await executeEvaluationRun(
    {
      agentId: input.experiment.agentId,
      skillName: input.experiment.skillName ?? null,
      evaluators: planEvaluators(input.experiment, input.evaluators),
      cases,
      // Session linkage costs a lookup and a bounded wait per case, so it only
      // runs where the host actually wired both halves of it.
      linkSessions: Boolean(input.resolveSession && input.readTrace),
      sessionLink: { attempts: 6, delayMs: 500 },
      // An experiment with an authored graph runs that graph instead of the
      // derived shape; the runner only rewrites its per-case and evaluator config.
      ...(input.experiment.graph?.spec ? { savedSpec: input.experiment.graph.spec } : {}),
    },
    dependencies,
    {
      ...(input.signal ? { signal: input.signal } : {}),
      onCaseComplete: async (caseOutcome) => {
        results.push(caseResult(runId, caseOutcome));
        snapshotScore = partialScore(results);
        await publish("running");
      },
    },
  );

  snapshotScore = {
    ...(outcome.score.averageScore !== null ? { averageScore: outcome.score.averageScore } : {}),
    ...(outcome.score.minimumScore !== null ? { minimumScore: outcome.score.minimumScore } : {}),
    ...(outcome.score.passRate !== null ? { passRate: outcome.score.passRate } : {}),
    scoredCaseCount: outcome.score.scoredCaseCount,
    unscoredCaseCount: outcome.score.unscoredCaseCount,
  };

  const status: EvaluationRun["status"] = outcome.cancelled
    ? "cancelled"
    : results.some((result) => result.unscoredReason !== undefined)
      ? "failed"
      : "completed";
  await publish(status);
  return snapshot(status);
}

interface EvaluationRunSnapshotScore {
  averageScore?: number;
  minimumScore?: number;
  passRate?: number;
  scoredCaseCount?: number;
  unscoredCaseCount?: number;
}

/**
 * Score of the cases finished so far, so a polling client sees the run move.
 * Recomputed from case rows rather than accumulated, so a retried case cannot
 * be counted twice.
 */
function partialScore(results: readonly EvaluationCaseResult[]): EvaluationRunSnapshotScore {
  const scored = results.filter((result) => result.unscoredReason === undefined);
  const values = scored.map((result) =>
    result.scores.length > 0
      ? result.scores.reduce((total, score) => total + score.score, 0) / result.scores.length
      : 0,
  );
  const passed = scored.filter(
    (result) => result.gatePassed !== false && result.scores.every((score) => score.passed),
  ).length;
  return {
    ...(values.length > 0
      ? {
          averageScore: values.reduce((left, right) => left + right, 0) / values.length,
          minimumScore: Math.min(...values),
          passRate: passed / scored.length,
        }
      : {}),
    scoredCaseCount: scored.length,
    unscoredCaseCount: results.length - scored.length,
  };
}

function planEvaluators(
  experiment: EvaluationExperiment,
  evaluators: readonly EvaluationEvaluator[],
): EvaluationPlanEvaluator[] {
  return evaluators
    .filter(
      (evaluator) => experiment.evaluatorIds.includes(evaluator.id) && evaluator.enabled,
    )
    .map((evaluator) => ({
      id: evaluator.id,
      kind: evaluator.kind,
      threshold: evaluator.threshold,
      ...(evaluator.runtimeId ? { runtimeId: evaluator.runtimeId } : {}),
      ...(evaluator.prompt ? { prompt: evaluator.prompt } : {}),
    }));
}

function caseResult(runId: string, outcome: EvaluationCaseOutcome): EvaluationCaseResult {
  const scores: EvaluationScore[] = outcome.aggregate.nodes
    .filter((record) => record.role === "judge" && record.status !== "excused" && record.status !== "error")
    .flatMap((record) => record.verdicts ?? [])
    .filter((verdict) => verdict.evaluatorId !== undefined)
    .map((verdict) => ({
      evaluatorId: verdict.evaluatorId!,
      score: verdict.raw ?? 0,
      passed: verdict.status === "met",
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
      ...(verdict.failedCriteria ? { failedCriteria: verdict.failedCriteria } : {}),
      durationMs: verdict.durationMs ?? 0,
    }));

  return {
    id: outcome.caseId,
    runId,
    datasetItemId: outcome.task.datasetItemId,
    repetition: outcome.task.repetition,
    input: outcome.task.input,
    ...(outcome.task.expectedOutput !== undefined
      ? { expectedOutput: outcome.task.expectedOutput }
      : {}),
    output: outcome.output,
    // The legacy `error` field is what older clients read to spot a case that
    // did not evaluate; keep it in step with the graph's own reason.
    ...(outcome.unscoredReason ? { error: outcome.unscoredReason } : {}),
    durationMs: outcome.durationMs,
    scores,
    nodes: outcome.aggregate.nodes,
    ...(outcome.sessionKey ? { sessionKey: outcome.sessionKey } : {}),
    ...(outcome.skill ? { skillInjection: outcome.skill } : {}),
    ...(outcome.unscoredReason ? { unscoredReason: outcome.unscoredReason } : {}),
    gatePassed: outcome.aggregate.gate.passed,
  };
}
