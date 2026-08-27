import type { EvaluationNodeRecord } from "../../../../core/evaluation/graph/node";

export type { EvaluationNodeRecord } from "../../../../core/evaluation/graph/node";
export type {
  EvaluationFailureAttribution,
  EvaluationFailureType,
  EvaluationPendingReason,
  EvaluationRecordStatus,
  EvaluationVerdict,
  EvaluationVerdictStatus,
} from "../../../../core/evaluation/graph/node";

export interface EvaluationDatasetItem {
  id: string;
  input: string;
  expectedOutput?: string;
  metadata: Record<string, unknown>;
  sequence: number;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  items: EvaluationDatasetItem[];
  createdAt: number;
  updatedAt: number;
}

export type EvaluatorKind = "contains" | "exact_match" | "json_valid" | "llm_judge";

export interface EvaluationEvaluator {
  id: string;
  name: string;
  kind: EvaluatorKind;
  prompt?: string;
  runtimeId?: string;
  threshold: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationExperiment {
  id: string;
  name: string;
  datasetId: string;
  agentId: string;
  evaluatorIds: string[];
  repetitions: number;
  // Skill regression binding (phase four). Null for generic experiments created
  // before skill binding existed. skill_hash is the SKILL.md hash at the
  // time of the most recent run, refreshed before every run so each run is
  // attributed to the version that actually executed it.
  skillName?: string | null;
  skillHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationScore {
  evaluatorId: string;
  score: number;
  passed: boolean;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  durationMs: number;
  tokenCount?: number;
  estimatedCost?: number;
}

export interface EvaluationCaseResult {
  id: string;
  runId: string;
  datasetItemId: string;
  repetition: number;
  input: string;
  expectedOutput?: string;
  output: string;
  error?: string;
  durationMs: number;
  scores: EvaluationScore[];
  /**
   * Per-node execution records from the evaluation graph. Absent on runs
   * recorded before the graph engine existed; those runs keep only the case and
   * score rows they were written with.
   */
  nodes?: EvaluationNodeRecord[];
  /** Session this case's agent execution produced, once indexing linked it. */
  sessionKey?: string;
  /** The skill whose instructions were injected with the task, if any. */
  skillInjection?: {
    skillName: string;
    skillHash: string;
    contentLength: number;
  };
  /**
   * Why this case has no score. Set when nothing was decided — a missing judge
   * runtime, an agent that never answered, a cancelled run — so the absence is
   * never mistaken for a zero.
   */
  unscoredReason?: string;
  /** False when a hard defect closed the case's gate. */
  gatePassed?: boolean;
}

export interface EvaluationRun {
  id: string;
  experimentId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agentRevisionId?: string;
  // SKILL.md fingerprint of the version that executed; null for generic
  // (non-skill) experiments and runs recorded before attribution existed.
  skillHash?: string | null;
  startedAt: number;
  finishedAt?: number;
  averageScore?: number;
  minimumScore?: number;
  passRate?: number;
  totalDurationMs?: number;
  error?: string;
  results: EvaluationCaseResult[];
  /**
   * Marks a run executed by the evaluation graph. Absent means the run predates
   * it, so its scores follow the older rules and carry no node records.
   */
  engine?: "graph";
  /** Cases that produced a score. The score fields average over these only. */
  scoredCaseCount?: number;
  /** Cases that decided nothing; excluded from every score above. */
  unscoredCaseCount?: number;
}

export type EvaluationRunSummary = Omit<EvaluationRun, "results"> & {
  resultCount: number;
  failedResultCount: number;
};

export interface ListEvaluationRunsRequest {
  experimentId?: string;
  offset?: number;
  limit?: number;
}

export interface EvaluationRunPage {
  items: EvaluationRunSummary[];
  total: number;
  offset: number;
  limit: number;
}
