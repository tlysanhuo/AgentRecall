import type {
  BuiltEvaluationGraph,
  BuiltEvaluationNode,
} from "./builder";
import {
  evaluationErrored,
  type EvaluationNodeRecord,
  type EvaluationNodeResult,
  type EvaluationNodeVerdict,
  type EvaluationPendingReason,
  type EvaluationVerdict,
} from "./node";
import type { EvaluationPortMap } from "./ports";

/**
 * Executes one case's graph, layer by layer.
 *
 * Every node ends with a record, including the nodes that never ran: a report
 * that silently omits them cannot distinguish "the judge approved" from "the
 * judge never got a chance". `onNodeRecord` fires as each record is produced so
 * a caller can persist progress and a client can poll a run that is still going.
 */

export interface EvaluationGraphExecutionOptions {
  graph: BuiltEvaluationGraph;
  caseId: string;
  /** Upper bound on nodes running at once inside a layer. Defaults to 4. */
  maxConcurrent?: number;
  signal?: AbortSignal;
  onNodeRecord?: (record: EvaluationNodeRecord) => void;
  now?: () => number;
}

export interface EvaluationGraphExecution {
  caseId: string;
  records: EvaluationNodeRecord[];
  /**
   * Port values produced during this execution, by node id. Process-local and
   * never persisted, so a caller that needs the agent's answer can read it
   * without the record duplicating large payloads into durable storage.
   * Ephemeral ports are omitted: their values do not outlive the run.
   */
  values: Map<string, Map<string, unknown>>;
  /** True when the case was aborted before every layer finished. */
  cancelled: boolean;
}

interface StoredOutput {
  value: unknown;
  ephemeral: boolean;
}

export async function executeEvaluationGraph(
  options: EvaluationGraphExecutionOptions,
): Promise<EvaluationGraphExecution> {
  const maxConcurrent = options.maxConcurrent ?? 4;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const { graph, caseId, signal } = options;
  const records = new Map<string, EvaluationNodeRecord>();
  const outputs = new Map<string, Map<string, StoredOutput>>();
  const verdictIds = new Set<string>();
  let cancelled = signal?.aborted === true;
  const onAbort = () => {
    cancelled = true;
  };
  signal?.addEventListener("abort", onAbort);

  const commit = (record: EvaluationNodeRecord): void => {
    records.set(record.nodeId, record);
    options.onNodeRecord?.(record);
  };

  try {
    for (const layer of graph.layers) {
      const queue = [...layer];
      const workers = Array.from(
        { length: Math.min(maxConcurrent, queue.length) },
        async () => {
          for (;;) {
            const nodeId = queue.shift();
            if (nodeId === undefined) return;
            await runNode(graph.nodes.get(nodeId)!);
          }
        },
      );
      await Promise.all(workers);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    caseId,
    records: graph.spec.nodes.map((instance) => records.get(instance.id)!).filter(Boolean),
    values: durableValues(),
    cancelled,
  };

  function durableValues(): Map<string, Map<string, unknown>> {
    const exposed = new Map<string, Map<string, unknown>>();
    for (const [nodeId, ports] of outputs) {
      const kept = new Map<string, unknown>();
      for (const [name, stored] of ports) {
        if (stored.ephemeral) continue;
        kept.set(name, stored.value);
      }
      if (kept.size > 0) exposed.set(nodeId, kept);
    }
    return exposed;
  }

  async function runNode(node: BuiltEvaluationNode): Promise<void> {
    const base: EvaluationNodeRecord = {
      nodeId: node.id,
      nodeType: node.type,
      nodeVersion: node.definition.version,
      role: node.definition.role,
      status: "pending",
    };

    if (!node.enabled) {
      commit({ ...base, status: "disabled" });
      return;
    }
    if (cancelled) {
      commit({ ...base, status: "pending", pendingReason: "not_decided" });
      return;
    }

    const gate = collectInputs(node);
    if (gate.blocked) {
      commit({
        ...base,
        status: "pending",
        pendingReason: gate.reason,
        pendingUpstream: gate.upstream,
      });
      return;
    }

    const startedAt = now();
    let result: EvaluationNodeResult;
    try {
      result = await node.definition.run({
        nodeId: node.id,
        nodeType: node.type,
        caseId,
        config: node.config as never,
        in: gate.values,
        signal: signal ?? new AbortController().signal,
      });
    } catch (cause) {
      result = evaluationErrored(cause instanceof Error ? cause.message : String(cause));
    }
    const finishedAt = now();

    const validation = validateResult(node, result);
    const effective = validation.result;
    const produced = storeOutputs(node, effective.outputs);

    commit({
      ...base,
      status: effective.status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ...("attribution" in effective ? { attribution: effective.attribution } : {}),
      ...(produced.length > 0 ? { producedOutputs: produced } : {}),
      ...(effective.facts ? { facts: effective.facts } : {}),
      ...(validation.verdicts.length > 0 ? { verdicts: validation.verdicts } : {}),
    });
  }

  function collectInputs(node: BuiltEvaluationNode):
    | { blocked: false; values: Record<string, unknown> }
    | { blocked: true; reason: EvaluationPendingReason; upstream: string[] } {
    const values: Record<string, unknown> = {};
    const upstream: string[] = [];
    let blockedByFailure = false;
    let blockedBySkip = false;

    for (const [inputName, edge] of Object.entries(node.inputs)) {
      const producer = records.get(edge.producerId);
      const stored = outputs.get(edge.producerId)?.get(edge.output);
      if (producer?.status === "disabled") {
        blockedBySkip = true;
        upstream.push(edge.producerId);
        continue;
      }
      const usable =
        stored !== undefined &&
        (producer?.status === "pass" ||
          (edge.onFailure && producer !== undefined && producer.status !== "pending"));
      if (usable) {
        values[inputName] = stored.value;
        continue;
      }
      // A producer that is itself pending blocks us for its own reason. Past the
      // first hop of a disabled chain nothing has failed, so reporting a failure
      // there would send triage after a problem that does not exist.
      if (producer?.status === "pending" && producer.pendingReason === "upstream_skipped") {
        blockedBySkip = true;
      } else {
        blockedByFailure = true;
      }
      upstream.push(edge.producerId);
    }

    if (upstream.length === 0) return { blocked: false, values };
    return {
      blocked: true,
      reason: blockedByFailure || !blockedBySkip ? "upstream_not_pass" : "upstream_skipped",
      upstream: [...new Set(upstream)].sort(),
    };
  }

  function validateResult(
    node: BuiltEvaluationNode,
    result: EvaluationNodeResult,
  ): { result: EvaluationNodeResult; verdicts: EvaluationVerdict[] } {
    const emitted = result.verdicts ?? [];
    if (emitted.length > 0 && node.definition.role !== "judge") {
      return {
        result: evaluationErrored(
          `Node ${node.id} is a prepare node and returned verdicts`,
          { ...(result.facts ? { facts: result.facts } : {}) },
        ),
        verdicts: [],
      };
    }
    const stamped: EvaluationVerdict[] = [];
    for (const verdict of emitted) {
      const duplicate = verdictIds.has(verdict.verdictId);
      if (duplicate) {
        return {
          result: evaluationErrored(
            `Node ${node.id} returned duplicate verdict id ${verdict.verdictId}`,
            { ...(result.facts ? { facts: result.facts } : {}) },
          ),
          verdicts: [],
        };
      }
      verdictIds.add(verdict.verdictId);
      stamped.push(stampVerdict(node, verdict));
    }
    return { result, verdicts: stamped };
  }

  function stampVerdict(
    node: BuiltEvaluationNode,
    verdict: EvaluationNodeVerdict,
  ): EvaluationVerdict {
    return { ...verdict, sourceNodeId: node.id, sourceNodeType: node.type };
  }

  function storeOutputs(
    node: BuiltEvaluationNode,
    values: Record<string, unknown> | undefined,
  ): string[] {
    if (!values) return [];
    const declared = node.definition.outputs as EvaluationPortMap;
    const stored = outputs.get(node.id) ?? new Map<string, StoredOutput>();
    const produced: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      const spec = declared[name];
      // An undeclared output cannot be consumed by anything the builder wired,
      // so dropping it keeps the record honest about what this node produced.
      if (!spec || value === undefined) continue;
      stored.set(name, { value, ephemeral: spec.ephemeral });
      produced.push(name);
    }
    outputs.set(node.id, stored);
    return produced.sort();
  }
}
