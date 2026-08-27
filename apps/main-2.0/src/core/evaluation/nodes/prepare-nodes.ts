import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationPass,
} from "../graph/node";
import {
  EVIDENCE_PORT,
  EXECUTION_PORT,
  INSTRUCTIONS_PORT,
  SESSION_PORT,
  TASK_PORT,
  type EvaluationEvidenceValue,
  type EvaluationNodeDependencies,
  type EvaluationTaskValue,
} from "./contracts";

/**
 * The `prepare` half of the evaluation graph: everything that produces facts
 * for judges to decide on. None of these may emit a verdict.
 *
 * Their shared discipline: when a step cannot be completed for a reason that
 * has nothing to do with the agent under evaluation, it is `excused`. The
 * judges downstream then record `pending` with that reason instead of scoring
 * an empty answer as a failure.
 */

export const TASK_SOURCE_NODE_TYPE = "task_source";
export const SKILL_PROVISION_NODE_TYPE = "skill_provision";
export const AGENT_EXECUTE_NODE_TYPE = "agent_execute";
export const SESSION_LINK_NODE_TYPE = "session_link";
export const EVIDENCE_EXTRACT_NODE_TYPE = "evidence_extract";
export const SKILL_USE_OBSERVE_NODE_TYPE = "skill_use_observe";

/** Emits the case under evaluation. Its config is the case itself. */
export const taskSourceNode = defineEvaluationNode<
  Record<string, never>,
  { task: typeof TASK_PORT },
  EvaluationTaskValue
>({
  type: TASK_SOURCE_NODE_TYPE,
  version: 1,
  role: "prepare",
  inputs: {},
  outputs: { task: TASK_PORT },
  async run(context) {
    return evaluationPass({ outputs: { task: context.config } });
  },
});

export interface SkillProvisionConfig {
  /** Null when the experiment injects no skill. */
  skillName: string | null;
}

/**
 * Freezes the selected skill's instructions into this run.
 *
 * The content is read at execution time and reported with its hash, so a run
 * can always be attributed to the exact skill text that produced it rather than
 * to whatever the file says later.
 */
export function createSkillProvisionNode(
  dependencies: Pick<EvaluationNodeDependencies, "readSkill">,
) {
  return defineEvaluationNode<
    Record<string, never>,
    { instructions: typeof INSTRUCTIONS_PORT },
    SkillProvisionConfig
  >({
    type: SKILL_PROVISION_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: {},
    outputs: { instructions: INSTRUCTIONS_PORT },
    async run(context) {
      const skillName = context.config.skillName?.trim();
      if (!skillName) {
        return evaluationPass({ outputs: { instructions: { text: null } } });
      }
      if (!dependencies.readSkill) {
        return evaluationExcused.infra("skill_reader_unavailable", {
          facts: { skillName },
        });
      }
      const skill = await dependencies.readSkill(skillName);
      if (!skill) {
        return evaluationExcused.infra("skill_not_readable", { facts: { skillName } });
      }
      return evaluationPass({
        outputs: {
          instructions: {
            text: skill.content,
            skill: {
              skillName,
              skillHash: skill.hash,
              contentLength: skill.content.length,
            },
          },
        },
        facts: { skillName, skillHash: skill.hash },
      });
    },
  });
}

export interface AgentExecuteConfig {
  agentId: string;
}

/**
 * Runs the evaluated agent once.
 *
 * A throw here means the agent never answered — a missing runtime, a crashed
 * CLI, a cancelled run. That is `excused`, not a zero: an agent that could not
 * be launched has told us nothing, and scoring it as a failure would blame the
 * model for AgentRecall's own plumbing.
 */
export function createAgentExecuteNode(
  dependencies: Pick<EvaluationNodeDependencies, "executeAgent">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; instructions: typeof INSTRUCTIONS_PORT },
    { execution: typeof EXECUTION_PORT },
    AgentExecuteConfig
  >({
    type: AGENT_EXECUTE_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { task: TASK_PORT, instructions: INSTRUCTIONS_PORT },
    outputs: { execution: EXECUTION_PORT },
    async run(context) {
      const { task, instructions } = context.in;
      try {
        const execution = await dependencies.executeAgent(
          {
            agentId: context.config.agentId,
            prompt: task.input,
            ...(instructions.text ? { developerInstructions: instructions.text } : {}),
          },
          context.signal,
        );
        return evaluationPass({
          outputs: { execution },
          facts: {
            outputLength: execution.output.length,
            ...(instructions.skill ? { injectedSkill: instructions.skill.skillName } : {}),
            ...(execution.executionReference?.sessionId
              ? { runtimeSessionId: execution.executionReference.sessionId }
              : {}),
          },
        });
      } catch (cause) {
        return evaluationExcused.infra(
          cause instanceof Error ? cause.message : String(cause),
          { facts: { agentId: context.config.agentId } },
        );
      }
    },
  });
}

export interface SessionLinkConfig {
  /** Lookup attempts while the session file is still being indexed. */
  attempts?: number;
  delayMs?: number;
}

/**
 * Links the execution to the indexed AgentRecall session it produced.
 *
 * Indexing is asynchronous, so the session a run just created may not be
 * queryable yet. The node retries within a bound and then excuses itself — it
 * never reports a link it does not have, because a missing link must not read
 * as "this run had no session".
 */
export function createSessionLinkNode(
  dependencies: Pick<EvaluationNodeDependencies, "resolveSession" | "wait">,
) {
  return defineEvaluationNode<
    { execution: typeof EXECUTION_PORT },
    { session: typeof SESSION_PORT },
    SessionLinkConfig
  >({
    type: SESSION_LINK_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { execution: EXECUTION_PORT },
    outputs: { session: SESSION_PORT },
    async run(context) {
      const rawId = context.in.execution.executionReference?.sessionId?.trim();
      if (!rawId) {
        return evaluationExcused.infra("runtime_reported_no_session");
      }
      if (!dependencies.resolveSession) {
        return evaluationExcused.infra("session_lookup_unavailable", { facts: { rawId } });
      }
      const attempts = Math.max(1, Math.min(30, context.config.attempts ?? 10));
      const delayMs = Math.max(0, Math.min(10_000, context.config.delayMs ?? 1_000));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (context.signal.aborted) {
          return evaluationExcused.infra("cancelled_before_session_link", {
            facts: { rawId, attempt },
          });
        }
        const session = await dependencies.resolveSession(rawId);
        if (session) {
          return evaluationPass({
            outputs: { session },
            facts: { rawId, sessionKey: session.sessionKey, attempt },
          });
        }
        if (attempt < attempts && dependencies.wait) await dependencies.wait(delayMs);
      }
      return evaluationExcused.infra("session_not_indexed", { facts: { rawId, attempts } });
    },
  });
}

/** Reads the linked session's trajectory so judges can decide on behavior. */
export function createEvidenceExtractNode(
  dependencies: Pick<EvaluationNodeDependencies, "readTrace">,
) {
  return defineEvaluationNode<
    { session: typeof SESSION_PORT },
    { evidence: typeof EVIDENCE_PORT },
    Record<string, never>
  >({
    type: EVIDENCE_EXTRACT_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { session: SESSION_PORT },
    outputs: { evidence: EVIDENCE_PORT },
    async run(context) {
      if (!dependencies.readTrace) {
        return evaluationExcused.infra("trace_reader_unavailable");
      }
      const evidence = await dependencies.readTrace(context.in.session.sessionKey);
      if (!evidence) {
        return evaluationExcused.infra("trace_not_available", {
          facts: { sessionKey: context.in.session.sessionKey },
        });
      }
      return evaluationPass({
        outputs: { evidence },
        facts: evidenceFacts(evidence),
      });
    },
  });
}

function evidenceFacts(evidence: EvaluationEvidenceValue): Record<string, unknown> {
  return {
    turnCount: evidence.turnCount,
    toolCallCount: evidence.toolCallCount,
    toolFailureCount: evidence.toolFailureCount,
    ...(evidence.totalTokens !== null ? { totalTokens: evidence.totalTokens } : {}),
    ...(evidence.usedSkillNames.length > 0 ? { usedSkillNames: evidence.usedSkillNames } : {}),
  };
}

/**
 * Records whether the injected skill was actually used.
 *
 * Deliberately verdict-free. The supported policy is `available` — the skill is
 * offered, not mandated — so whether the agent reached for it is an observation
 * about the skill's description, and letting it move the score would silently
 * turn an observation into a requirement.
 *
 * `used` is null when usage is not observable for this session at all. Reporting
 * false there would accuse the agent of ignoring a skill on the strength of a
 * missing hook.
 */
export const skillUseObserveNode = defineEvaluationNode<
  { instructions: typeof INSTRUCTIONS_PORT; evidence: typeof EVIDENCE_PORT },
  Record<string, never>,
  Record<string, never>
>({
  type: SKILL_USE_OBSERVE_NODE_TYPE,
  version: 1,
  role: "prepare",
  inputs: { instructions: INSTRUCTIONS_PORT, evidence: EVIDENCE_PORT },
  outputs: {},
  async run(context) {
    const injected = context.in.instructions.skill;
    if (!injected) return evaluationPass({ facts: { injected: false } });
    const evidence = context.in.evidence;
    const used = evidence.skillUsageObservable
      ? evidence.usedSkillNames.some(
          (name) => name.trim().toLowerCase() === injected.skillName.trim().toLowerCase(),
        )
      : null;
    return evaluationPass({
      facts: {
        injected: true,
        skillName: injected.skillName,
        skillHash: injected.skillHash,
        observable: evidence.skillUsageObservable,
        used,
      },
    });
  },
});
