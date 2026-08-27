import { defineEvaluationPort } from "../graph/ports";

/**
 * Values that flow between evaluation nodes, and the ports that carry them.
 *
 * Port kinds are the graph's type system: the builder refuses to connect a
 * session port to an evidence input, so a wiring mistake surfaces before any
 * agent is spawned.
 */

export interface EvaluationTaskValue {
  caseId: string;
  datasetItemId: string;
  repetition: number;
  input: string;
  expectedOutput?: string;
  context?: string;
  metadata: Record<string, unknown>;
}

export interface EvaluationSkillInjection {
  skillName: string;
  /** sha256 of the SKILL.md bytes that were injected. */
  skillHash: string;
  contentLength: number;
}

export interface EvaluationInstructionsValue {
  /** Developer instructions handed to the agent; null when nothing is injected. */
  text: string | null;
  skill?: EvaluationSkillInjection;
}

export interface EvaluationExecutionReference {
  sessionId?: string;
  turnId?: string;
}

export interface EvaluationExecutionValue {
  output: string;
  durationMs: number;
  executionReference?: EvaluationExecutionReference;
}

export interface EvaluationSessionValue {
  sessionKey: string;
  source: string;
  rawId: string;
}

export interface EvaluationEvidenceValue {
  turnCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  failedToolNames: string[];
  totalTokens: number | null;
  errorCount: number;
  /** Names of skills the trace shows the agent actually invoked. */
  usedSkillNames: string[];
  /**
   * False when skill usage cannot be observed for this session at all — the
   * usage hook may not be installed for the agent that ran. An empty
   * `usedSkillNames` then means "unknown", not "the skill went unused".
   */
  skillUsageObservable: boolean;
}

export const TASK_PORT = defineEvaluationPort<EvaluationTaskValue>("eval.task");
export const INSTRUCTIONS_PORT =
  defineEvaluationPort<EvaluationInstructionsValue>("eval.instructions");
export const EXECUTION_PORT = defineEvaluationPort<EvaluationExecutionValue>("eval.execution");
export const SESSION_PORT = defineEvaluationPort<EvaluationSessionValue>("eval.session");
export const EVIDENCE_PORT = defineEvaluationPort<EvaluationEvidenceValue>("eval.evidence");

/** Dependencies the node implementations need from the host process. */
export interface EvaluationNodeDependencies {
  /** Reads the current SKILL.md bytes and their hash for an installed skill. */
  readSkill?: (
    skillName: string,
  ) => Promise<{ content: string; hash: string } | null>;
  executeAgent: (
    input: { agentId: string; prompt: string; developerInstructions?: string },
    signal?: AbortSignal,
  ) => Promise<EvaluationExecutionValue>;
  executeJudge?: (
    input: { runtimeId: string; prompt: string },
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
  /** Resolves a runtime-native session id to an indexed AgentRecall session. */
  resolveSession?: (rawId: string) => Promise<EvaluationSessionValue | null>;
  readTrace?: (sessionKey: string) => Promise<EvaluationEvidenceValue | null>;
  /** Delay between session-link attempts; injected so tests stay deterministic. */
  wait?: (milliseconds: number) => Promise<void>;
}
