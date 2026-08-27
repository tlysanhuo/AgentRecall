import {
  arePortsCompatible,
  type EvaluationPortMap,
  type EvaluationPortSpec,
} from "./ports";
import type { AnyEvaluationNodeDefinition } from "./node";

/**
 * Builds an executable evaluation graph from a declarative spec.
 *
 * Every structural mistake is caught here rather than at execution time: a
 * graph that builds is one whose every node has a producer of the right type
 * for each input, with no cycle. That is the difference between "the run failed
 * at node seven" and "this experiment could never have run".
 */

export type EvaluationGraphErrorCode =
  | "spec_invalid"
  | "duplicate_node_id"
  | "unknown_node_type"
  | "unknown_input"
  | "unwired_input"
  | "ambiguous_input"
  | "type_mismatch"
  | "dangling_ref"
  | "cycle_detected"
  | "prepare_declares_verdicts";

export class EvaluationGraphBuildError extends Error {
  constructor(
    readonly code: EvaluationGraphErrorCode,
    readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "EvaluationGraphBuildError";
  }
}

export type EvaluationInputBinding = string | { from: string; onFailure?: boolean };

export interface EvaluationGraphNodeSpec {
  id: string;
  type: string;
  enabled?: boolean;
  config?: unknown;
  in?: Record<string, EvaluationInputBinding>;
  after?: string[];
}

export interface EvaluationGraphSpec {
  name: string;
  version: number;
  nodes: EvaluationGraphNodeSpec[];
}

export interface EvaluationResolvedInput {
  input: string;
  producerId: string;
  output: string;
  /** Accept the producer's value even when the producer did not pass. */
  onFailure: boolean;
  /** Resolved by unique type match rather than an explicit binding. */
  auto: boolean;
}

export interface BuiltEvaluationNode {
  id: string;
  type: string;
  enabled: boolean;
  definition: AnyEvaluationNodeDefinition;
  config: unknown;
  inputs: Record<string, EvaluationResolvedInput>;
  after: string[];
}

export interface EvaluationGraphEdge {
  from: string;
  to: string;
  kind: "data" | "order";
  input?: string;
  output?: string;
}

export interface BuiltEvaluationGraph {
  spec: EvaluationGraphSpec;
  nodes: Map<string, BuiltEvaluationNode>;
  /** Topological layers; every node in a layer may run concurrently. */
  layers: string[][];
  edges: EvaluationGraphEdge[];
}

export interface EvaluationNodeRegistry {
  get(type: string): AnyEvaluationNodeDefinition | undefined;
  list(): AnyEvaluationNodeDefinition[];
}

export function createEvaluationNodeRegistry(
  definitions: readonly AnyEvaluationNodeDefinition[],
): EvaluationNodeRegistry {
  const nodes = new Map<string, AnyEvaluationNodeDefinition>();
  for (const definition of definitions) {
    if (nodes.has(definition.type)) {
      throw new Error(`Duplicate evaluation node type: ${definition.type}`);
    }
    nodes.set(definition.type, definition);
  }
  return {
    get: (type) => nodes.get(type),
    list: () => [...nodes.values()].sort((left, right) => left.type.localeCompare(right.type)),
  };
}

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function parseBinding(binding: EvaluationInputBinding): {
  producerId: string;
  output: string;
  onFailure: boolean;
} {
  const from = typeof binding === "string" ? binding : binding.from;
  const split = from.lastIndexOf(".");
  if (split <= 0 || split === from.length - 1) {
    throw new EvaluationGraphBuildError("dangling_ref", { ref: from });
  }
  return {
    producerId: from.slice(0, split),
    output: from.slice(split + 1),
    onFailure: typeof binding === "string" ? false : binding.onFailure === true,
  };
}

function assertSpec(spec: EvaluationGraphSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new EvaluationGraphBuildError("spec_invalid", { message: "spec must be an object" });
  }
  if (typeof spec.name !== "string" || spec.name.trim() === "") {
    throw new EvaluationGraphBuildError("spec_invalid", { message: "spec.name is required" });
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new EvaluationGraphBuildError("spec_invalid", { version: spec.version });
  }
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new EvaluationGraphBuildError("spec_invalid", { message: "spec.nodes must not be empty" });
  }
}

export function buildEvaluationGraph(
  spec: EvaluationGraphSpec,
  registry: EvaluationNodeRegistry,
): BuiltEvaluationGraph {
  assertSpec(spec);
  const nodes = new Map<string, BuiltEvaluationNode>();

  for (const instance of spec.nodes) {
    if (typeof instance.id !== "string" || !NODE_ID.test(instance.id)) {
      throw new EvaluationGraphBuildError("spec_invalid", {
        nodeId: instance.id,
        message: "node id must use letters, digits, _ or -",
      });
    }
    if (nodes.has(instance.id)) {
      throw new EvaluationGraphBuildError("duplicate_node_id", { nodeId: instance.id });
    }
    const definition = registry.get(instance.type);
    if (!definition) {
      throw new EvaluationGraphBuildError("unknown_node_type", {
        nodeId: instance.id,
        type: instance.type,
      });
    }
    if (definition.role === "prepare" && definition.verdicts) {
      throw new EvaluationGraphBuildError("prepare_declares_verdicts", {
        nodeId: instance.id,
        type: instance.type,
      });
    }
    nodes.set(instance.id, {
      id: instance.id,
      type: instance.type,
      enabled: instance.enabled !== false,
      definition,
      config: instance.config ?? {},
      inputs: {},
      after: [...(instance.after ?? [])],
    });
  }

  const edges: EvaluationGraphEdge[] = [];
  for (const instance of spec.nodes) {
    const node = nodes.get(instance.id)!;
    const declared = node.definition.inputs as EvaluationPortMap;
    const declaredNames = new Set(Object.keys(declared));
    for (const inputName of Object.keys(instance.in ?? {})) {
      if (!declaredNames.has(inputName)) {
        throw new EvaluationGraphBuildError("unknown_input", {
          nodeId: node.id,
          input: inputName,
          declared: [...declaredNames].sort(),
        });
      }
    }

    for (const [inputName, inputSpec] of Object.entries(declared)) {
      const explicit = instance.in?.[inputName];
      node.inputs[inputName] = explicit
        ? resolveExplicitInput(node, inputName, inputSpec, explicit, nodes)
        : resolveAutoInput(node, inputName, inputSpec, nodes);
      const binding = node.inputs[inputName]!;
      edges.push({
        from: binding.producerId,
        to: node.id,
        kind: "data",
        input: inputName,
        output: binding.output,
      });
    }

    for (const predecessor of node.after) {
      if (!nodes.has(predecessor)) {
        throw new EvaluationGraphBuildError("dangling_ref", {
          nodeId: node.id,
          after: predecessor,
        });
      }
      edges.push({ from: predecessor, to: node.id, kind: "order" });
    }
  }

  return { spec, nodes, layers: topologicalLayers(nodes, edges), edges };
}

function resolveExplicitInput(
  node: BuiltEvaluationNode,
  inputName: string,
  inputSpec: EvaluationPortSpec<unknown>,
  binding: EvaluationInputBinding,
  nodes: Map<string, BuiltEvaluationNode>,
): EvaluationResolvedInput {
  const reference = parseBinding(binding);
  const producer = nodes.get(reference.producerId);
  const outputSpec = producer?.definition.outputs[reference.output];
  if (!producer || !outputSpec) {
    throw new EvaluationGraphBuildError("dangling_ref", {
      nodeId: node.id,
      input: inputName,
      ref: typeof binding === "string" ? binding : binding.from,
    });
  }
  if (!arePortsCompatible(outputSpec, inputSpec)) {
    throw new EvaluationGraphBuildError("type_mismatch", {
      nodeId: node.id,
      input: inputName,
      expected: inputSpec.kind,
      received: outputSpec.kind,
      producerId: producer.id,
      output: reference.output,
    });
  }
  return { input: inputName, ...reference, auto: false };
}

function resolveAutoInput(
  node: BuiltEvaluationNode,
  inputName: string,
  inputSpec: EvaluationPortSpec<unknown>,
  nodes: Map<string, BuiltEvaluationNode>,
): EvaluationResolvedInput {
  const candidates: Array<{ producerId: string; output: string }> = [];
  for (const producer of nodes.values()) {
    if (producer.id === node.id) continue;
    for (const [output, outputSpec] of Object.entries(
      producer.definition.outputs as EvaluationPortMap,
    )) {
      if (arePortsCompatible(outputSpec, inputSpec)) {
        candidates.push({ producerId: producer.id, output });
      }
    }
  }
  if (candidates.length === 0) {
    throw new EvaluationGraphBuildError("unwired_input", {
      nodeId: node.id,
      input: inputName,
      expected: inputSpec.kind,
    });
  }
  if (candidates.length > 1) {
    throw new EvaluationGraphBuildError("ambiguous_input", {
      nodeId: node.id,
      input: inputName,
      candidates: candidates.map((candidate) => `${candidate.producerId}.${candidate.output}`).sort(),
    });
  }
  return { input: inputName, ...candidates[0]!, onFailure: false, auto: true };
}

function topologicalLayers(
  nodes: Map<string, BuiltEvaluationNode>,
  edges: EvaluationGraphEdge[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of nodes.keys()) {
    adjacency.set(id, new Set());
    indegree.set(id, 0);
  }
  for (const edge of edges) {
    const next = adjacency.get(edge.from)!;
    // Two nodes may be joined by both a data and an order edge; counting that
    // pair twice would leave the consumer permanently short of one decrement.
    if (next.has(edge.to)) continue;
    next.add(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const remaining = new Map(indegree);
  const layers: string[][] = [];
  let ready = [...remaining.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    layers.push(ready);
    const nextReady: string[] = [];
    for (const id of ready) {
      visited += 1;
      for (const next of adjacency.get(id) ?? []) {
        const degree = (remaining.get(next) ?? 0) - 1;
        remaining.set(next, degree);
        if (degree === 0) nextReady.push(next);
      }
    }
    ready = nextReady.sort();
  }
  if (visited !== nodes.size) {
    throw new EvaluationGraphBuildError("cycle_detected", {
      nodes: [...remaining.entries()]
        .filter(([, degree]) => degree > 0)
        .map(([id]) => id)
        .sort(),
    });
  }
  return layers;
}
