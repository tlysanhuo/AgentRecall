/**
 * Typed ports for the evaluation graph.
 *
 * Port identity is nominal: two ports connect when their `kind` matches. The
 * evaluation node set is closed and internal, so a structural schema match
 * would buy nothing over a declared name while making every mismatch harder to
 * read in a build error.
 */

export interface EvaluationPortSpec<T> {
  readonly kind: string;
  /**
   * Values that only exist for the duration of one case run (a live session
   * handle, an open reader). Persisted node records keep the port name but not
   * the value, so a replayed record can never hand a stale resource downstream.
   */
  readonly ephemeral: boolean;
  /**
   * Boundary validation for values crossing into a node. Ports carrying data
   * produced inside this process may omit it; ports fed from subprocess or
   * model output should not.
   */
  readonly parse?: (value: unknown) => T;
}

export interface EvaluationPortOptions<T> {
  ephemeral?: boolean;
  parse?: (value: unknown) => T;
}

const PORT_KIND = /^[a-z][a-z0-9_.]*$/;

export function defineEvaluationPort<T>(
  kind: string,
  options: EvaluationPortOptions<T> = {},
): EvaluationPortSpec<T> {
  if (!PORT_KIND.test(kind)) {
    throw new Error(`Invalid evaluation port kind: ${kind}`);
  }
  return Object.freeze({
    kind,
    ephemeral: options.ephemeral === true,
    ...(options.parse ? { parse: options.parse } : {}),
  });
}

export type EvaluationPortMap = Record<string, EvaluationPortSpec<unknown>>;

export type InferEvaluationPorts<M extends EvaluationPortMap> = {
  [K in keyof M]: M[K] extends EvaluationPortSpec<infer T> ? T : never;
};

export function arePortsCompatible(
  producer: EvaluationPortSpec<unknown>,
  consumer: EvaluationPortSpec<unknown>,
): boolean {
  return producer.kind === consumer.kind;
}
