import type {
  EvaluationPortMap,
  InferEvaluationPorts,
} from "./ports";

/**
 * Node contract for the evaluation graph.
 *
 * The split that matters here is between a decision the evaluation made and a
 * decision it failed to make. A judge that ran and rejected the answer is a
 * `fail`/`unmet` result the score must reflect; a judge that could not run —
 * missing runtime, unparseable model output, aborted case — is `excused` and
 * must stay out of the score entirely. Collapsing the two is what makes an
 * evaluation report a confident zero for its own broken plumbing.
 */

export type EvaluationNodeRole = "prepare" | "judge";

/** Terminal status a node's own execution can reach. */
export type EvaluationNodeStatus = "pass" | "fail" | "excused" | "error";

/**
 * Status of a node inside a finished case. Adds the two states a node can end
 * in without ever executing, which a run report has to distinguish from a
 * failure.
 */
export type EvaluationRecordStatus = EvaluationNodeStatus | "pending" | "disabled";

export type EvaluationPendingReason =
  /** An input producer failed, was excused, errored, or never decided. */
  | "upstream_not_pass"
  /** An input producer was disabled, so nothing failed anywhere upstream. */
  | "upstream_skipped"
  /** The case was cancelled or aborted before this node's turn. */
  | "not_decided";

export type EvaluationFailureType =
  /** The evaluated agent itself produced the wrong outcome. Scores as a loss. */
  | "model_failure"
  /** AgentRecall, the runtime, or the machine failed. Excluded from scoring. */
  | "infra_failure"
  /** The evaluator could not reach a decision. Excluded from scoring. */
  | "judge_failure"
  /** The case is outside what this evaluation can judge. Excluded from scoring. */
  | "unsupported";

export interface EvaluationFailureAttribution {
  type: EvaluationFailureType;
  reason: string;
  details?: string[];
}

export type EvaluationVerdictStatus = "met" | "unmet" | "uncertain";

export interface EvaluationVerdict {
  /** Unique within one case; duplicates are rejected by the scheduler. */
  verdictId: string;
  /** Set when the verdict came from a configured evaluator. */
  evaluatorId?: string;
  labels: Record<string, string>;
  status: EvaluationVerdictStatus;
  /** Normalized 0..1 value when the evaluator produced one. */
  raw?: number;
  threshold?: number;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  sourceNodeId: string;
  sourceNodeType: string;
  durationMs?: number;
}

/**
 * What a node returns. The scheduler stamps the source node, so a node cannot
 * attribute its verdict to a different one.
 */
export type EvaluationNodeVerdict = Omit<
  EvaluationVerdict,
  "sourceNodeId" | "sourceNodeType"
>;

export interface EvaluationNodePassResult {
  status: "pass";
  outputs?: Record<string, unknown>;
  verdicts?: EvaluationNodeVerdict[];
  facts?: Record<string, unknown>;
}

export interface EvaluationNodeFailureResult {
  status: "fail" | "excused" | "error";
  attribution: EvaluationFailureAttribution;
  outputs?: Record<string, unknown>;
  verdicts?: EvaluationNodeVerdict[];
  facts?: Record<string, unknown>;
}

export type EvaluationNodeResult =
  | EvaluationNodePassResult
  | EvaluationNodeFailureResult;

type ResultExtra = Omit<EvaluationNodeFailureResult, "status" | "attribution">;

export function evaluationPass(
  value: Omit<EvaluationNodePassResult, "status"> = {},
): EvaluationNodePassResult {
  return { status: "pass", ...value };
}

function failure(
  status: EvaluationNodeFailureResult["status"],
  attribution: EvaluationFailureAttribution,
  extra: ResultExtra,
): EvaluationNodeFailureResult {
  return { status, attribution, ...extra };
}

/** The evaluated agent is at fault. These count against the score. */
export const evaluationFail = Object.freeze({
  model(reason: string, extra: ResultExtra = {}): EvaluationNodeFailureResult {
    return failure("fail", { type: "model_failure", reason }, extra);
  },
  unsupported(reason: string, extra: ResultExtra = {}): EvaluationNodeFailureResult {
    return failure("fail", { type: "unsupported", reason }, extra);
  },
});

/** Nothing about the agent was learned. These must not reach the score. */
export const evaluationExcused = Object.freeze({
  infra(reason: string, extra: ResultExtra = {}): EvaluationNodeFailureResult {
    return failure("excused", { type: "infra_failure", reason }, extra);
  },
  judge(reason: string, extra: ResultExtra = {}): EvaluationNodeFailureResult {
    return failure("excused", { type: "judge_failure", reason }, extra);
  },
});

/** An unexpected throw inside a node. Excluded from scoring like `excused`. */
export function evaluationErrored(
  reason: string,
  extra: ResultExtra = {},
): EvaluationNodeFailureResult {
  return failure("error", { type: "judge_failure", reason }, extra);
}

export interface EvaluationNodeContext<C, I> {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly caseId: string;
  readonly config: C;
  readonly in: I;
  readonly signal: AbortSignal;
}

export interface EvaluationNodeDefinition<
  I extends EvaluationPortMap = EvaluationPortMap,
  O extends EvaluationPortMap = EvaluationPortMap,
  C = Record<string, never>,
> {
  readonly type: string;
  readonly version: number;
  readonly role: EvaluationNodeRole;
  readonly inputs: I;
  readonly outputs: O;
  /** Declared by judges that may return verdicts; forbidden for `prepare`. */
  readonly verdicts?: boolean;
  run(
    context: EvaluationNodeContext<C, InferEvaluationPorts<I>>,
  ): Promise<EvaluationNodeResult>;
}

export type AnyEvaluationNodeDefinition = EvaluationNodeDefinition<
  EvaluationPortMap,
  EvaluationPortMap,
  // A registry holds nodes with unrelated config shapes; the builder validates
  // each instance against its own definition before execution.
  never
>;

const NODE_TYPE = /^[a-z][a-z0-9_]*$/;
const PORT_NAME = /^[a-z][a-z0-9_]*$/;

export function defineEvaluationNode<
  I extends EvaluationPortMap,
  O extends EvaluationPortMap,
  C,
>(definition: EvaluationNodeDefinition<I, O, C>): EvaluationNodeDefinition<I, O, C> {
  if (!NODE_TYPE.test(definition.type)) {
    throw new Error(`Invalid evaluation node type: ${definition.type}`);
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(
      `Evaluation node ${definition.type} has an invalid version: ${definition.version}`,
    );
  }
  for (const [kind, ports] of [
    ["input", definition.inputs],
    ["output", definition.outputs],
  ] as const) {
    for (const name of Object.keys(ports)) {
      if (!PORT_NAME.test(name)) {
        throw new Error(
          `Invalid ${kind} port "${name}" on evaluation node ${definition.type}`,
        );
      }
    }
  }
  if (definition.role === "prepare" && definition.verdicts) {
    throw new Error(
      `Evaluation node ${definition.type} is a prepare node and cannot declare verdicts`,
    );
  }
  return Object.freeze(definition);
}

export interface EvaluationNodeRecord {
  nodeId: string;
  nodeType: string;
  nodeVersion: number;
  role: EvaluationNodeRole;
  status: EvaluationRecordStatus;
  pendingReason?: EvaluationPendingReason;
  /** Producers that kept this node from running, for triage. */
  pendingUpstream?: string[];
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  attribution?: EvaluationFailureAttribution;
  /** Output port names this node produced; values are not persisted. */
  producedOutputs?: string[];
  facts?: Record<string, unknown>;
  verdicts?: EvaluationVerdict[];
}

/** Statuses whose verdicts and outputs carry no information about the agent. */
export function isEvaluationRecordExcluded(status: EvaluationRecordStatus): boolean {
  return status === "excused" || status === "error";
}
