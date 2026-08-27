import { scorableVerdicts, type EvaluationCaseAggregate } from "./aggregate";

/**
 * Turns neutral aggregates into scores.
 *
 * Two rules carry the weight:
 *   - a case with no scorable verdict has no score, rather than a zero. The
 *     evaluation learned nothing about the agent, and a zero would read as "the
 *     agent failed" for what was AgentRecall's or the judge's own failure;
 *   - pass rate is counted per case, not per verdict. A case passes only when
 *     its gate is open and every decision that was made came back met, so one
 *     evaluator passing out of three can never contribute a partial pass.
 */

export interface EvaluationCaseScore {
  caseId: string;
  /** Mean of scorable verdict values; null when nothing was decided. */
  score: number | null;
  passed: boolean;
  gatePassed: boolean;
  decided: number;
  notDecided: number;
}

export interface EvaluationRunScore {
  averageScore: number | null;
  minimumScore: number | null;
  /** Passed cases over scored cases; null when no case produced a score. */
  passRate: number | null;
  scoredCaseCount: number;
  unscoredCaseCount: number;
  passedCaseCount: number;
}

export function scoreEvaluationCase(aggregate: EvaluationCaseAggregate): EvaluationCaseScore {
  const verdicts = scorableVerdicts(aggregate);
  const values = verdicts
    .map((verdict) => verdict.raw)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const score = values.length > 0
    ? values.reduce((left, right) => left + right, 0) / values.length
    : null;
  return {
    caseId: aggregate.caseId,
    score,
    passed:
      aggregate.gate.passed &&
      verdicts.length > 0 &&
      verdicts.every((verdict) => verdict.status === "met"),
    gatePassed: aggregate.gate.passed,
    decided: verdicts.length,
    notDecided: aggregate.completeness.notDecided,
  };
}

export function scoreEvaluationRun(
  cases: readonly EvaluationCaseScore[],
): EvaluationRunScore {
  const scored = cases.filter((item) => item.score !== null);
  const values = scored.map((item) => item.score!);
  return {
    averageScore: values.length > 0
      ? values.reduce((left, right) => left + right, 0) / values.length
      : null,
    minimumScore: values.length > 0 ? Math.min(...values) : null,
    passRate: scored.length > 0
      ? scored.filter((item) => item.passed).length / scored.length
      : null,
    scoredCaseCount: scored.length,
    unscoredCaseCount: cases.length - scored.length,
    passedCaseCount: cases.filter((item) => item.passed).length,
  };
}
