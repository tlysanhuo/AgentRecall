import { describe, expect, it } from "vitest";
import {
  buildEvaluationGraph,
  createEvaluationNodeRegistry,
  EvaluationGraphBuildError,
  type EvaluationGraphSpec,
} from "./builder";
import {
  defineEvaluationNode,
  evaluationPass,
  type AnyEvaluationNodeDefinition,
} from "./node";
import { defineEvaluationPort } from "./ports";

const NUMBER_PORT = defineEvaluationPort<number>("test.number");
const TEXT_PORT = defineEvaluationPort<string>("test.text");

const numberSource = defineEvaluationNode<
  Record<string, never>,
  { value: typeof NUMBER_PORT },
  Record<string, never>
>({
  type: "number_source",
  version: 1,
  role: "prepare",
  inputs: {},
  outputs: { value: NUMBER_PORT },
  async run() {
    return evaluationPass({ outputs: { value: 1 } });
  },
});

const secondNumberSource = defineEvaluationNode<
  Record<string, never>,
  { value: typeof NUMBER_PORT },
  Record<string, never>
>({
  type: "other_number_source",
  version: 1,
  role: "prepare",
  inputs: {},
  outputs: { value: NUMBER_PORT },
  async run() {
    return evaluationPass({ outputs: { value: 2 } });
  },
});

const numberConsumer = defineEvaluationNode<
  { value: typeof NUMBER_PORT },
  Record<string, never>,
  Record<string, never>
>({
  type: "number_consumer",
  version: 1,
  role: "prepare",
  inputs: { value: NUMBER_PORT },
  outputs: {},
  async run() {
    return evaluationPass();
  },
});

const textConsumer = defineEvaluationNode<
  { label: typeof TEXT_PORT },
  Record<string, never>,
  Record<string, never>
>({
  type: "text_consumer",
  version: 1,
  role: "prepare",
  inputs: { label: TEXT_PORT },
  outputs: {},
  async run() {
    return evaluationPass();
  },
});

/** Passes a number straight through, so a cycle can be expressed. */
const numberRelay = defineEvaluationNode<
  { value: typeof NUMBER_PORT },
  { value: typeof NUMBER_PORT },
  Record<string, never>
>({
  type: "number_relay",
  version: 1,
  role: "prepare",
  inputs: { value: NUMBER_PORT },
  outputs: { value: NUMBER_PORT },
  async run(context) {
    return evaluationPass({ outputs: { value: context.in.value } });
  },
});

function registry(...definitions: AnyEvaluationNodeDefinition[]) {
  return createEvaluationNodeRegistry(
    definitions.length > 0
      ? definitions
      : [numberSource, secondNumberSource, numberConsumer, textConsumer, numberRelay],
  );
}

function spec(nodes: EvaluationGraphSpec["nodes"]): EvaluationGraphSpec {
  return { name: "test", version: 1, nodes };
}

function buildError(
  nodes: EvaluationGraphSpec["nodes"],
  definitions: AnyEvaluationNodeDefinition[] = [],
): EvaluationGraphBuildError {
  try {
    buildEvaluationGraph(spec(nodes), registry(...definitions));
  } catch (error) {
    if (error instanceof EvaluationGraphBuildError) return error;
    throw error;
  }
  throw new Error("expected the graph build to fail");
}

describe("evaluation graph builder", () => {
  it("wires an explicit binding and layers producers before consumers", () => {
    const graph = buildEvaluationGraph(
      spec([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer", in: { value: "source.value" } },
      ]),
      registry(numberSource, numberConsumer),
    );

    expect(graph.layers).toEqual([["source"], ["sink"]]);
    expect(graph.nodes.get("sink")!.inputs.value).toMatchObject({
      producerId: "source",
      output: "value",
      auto: false,
    });
  });

  it("auto-wires an input when exactly one producer offers the port kind", () => {
    const graph = buildEvaluationGraph(
      spec([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer" },
      ]),
      registry(numberSource, numberConsumer),
    );

    expect(graph.nodes.get("sink")!.inputs.value).toMatchObject({
      producerId: "source",
      auto: true,
    });
  });

  it("puts independent consumers of one producer in the same layer", () => {
    const graph = buildEvaluationGraph(
      spec([
        { id: "source", type: "number_source" },
        { id: "first", type: "number_consumer", in: { value: "source.value" } },
        { id: "second", type: "number_consumer", in: { value: "source.value" } },
      ]),
      registry(numberSource, numberConsumer),
    );

    expect(graph.layers).toEqual([["source"], ["first", "second"]]);
  });

  it("keeps a node that is both a data and an order dependent reachable", () => {
    // Counting the pair twice would leave the consumer one decrement short of
    // ready and the build would report a cycle that does not exist.
    const graph = buildEvaluationGraph(
      spec([
        { id: "source", type: "number_source" },
        {
          id: "sink",
          type: "number_consumer",
          in: { value: "source.value" },
          after: ["source"],
        },
      ]),
      registry(numberSource, numberConsumer),
    );

    expect(graph.layers).toEqual([["source"], ["sink"]]);
  });

  it("rejects a duplicate node id", () => {
    expect(
      buildError([
        { id: "source", type: "number_source" },
        { id: "source", type: "number_source" },
      ]).code,
    ).toBe("duplicate_node_id");
  });

  it("rejects an unknown node type", () => {
    expect(buildError([{ id: "source", type: "nope" }]).code).toBe("unknown_node_type");
  });

  it("rejects a binding for an input the node does not declare", () => {
    expect(
      buildError([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer", in: { missing: "source.value" } },
      ]).code,
    ).toBe("unknown_input");
  });

  it("rejects a binding whose port kinds differ", () => {
    const error = buildError([
      { id: "source", type: "number_source" },
      { id: "sink", type: "text_consumer", in: { label: "source.value" } },
    ]);

    expect(error.code).toBe("type_mismatch");
    expect(error.details).toMatchObject({ expected: "test.text", received: "test.number" });
  });

  it("rejects an ambiguous auto-wire rather than guessing a producer", () => {
    const error = buildError([
      { id: "first", type: "number_source" },
      { id: "second", type: "other_number_source" },
      { id: "sink", type: "number_consumer" },
    ]);

    expect(error.code).toBe("ambiguous_input");
    expect(error.details.candidates).toEqual(["first.value", "second.value"]);
  });

  it("rejects an input no node can supply", () => {
    expect(buildError([{ id: "sink", type: "number_consumer" }]).code).toBe("unwired_input");
  });

  it("rejects a binding that points at a missing node or port", () => {
    expect(
      buildError([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer", in: { value: "ghost.value" } },
      ]).code,
    ).toBe("dangling_ref");
    expect(
      buildError([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer", in: { value: "source.ghost" } },
      ]).code,
    ).toBe("dangling_ref");
    expect(
      buildError([
        { id: "source", type: "number_source" },
        { id: "sink", type: "number_consumer", after: ["ghost"] },
      ]).code,
    ).toBe("dangling_ref");
  });

  it("rejects a cycle", () => {
    const error = buildError([
      { id: "left", type: "number_relay", in: { value: "right.value" } },
      { id: "right", type: "number_relay", in: { value: "left.value" } },
    ]);

    expect(error.code).toBe("cycle_detected");
    expect(error.details.nodes).toEqual(["left", "right"]);
  });

  it("rejects a prepare node that declares verdicts", () => {
    const smuggled = {
      ...numberSource,
      type: "smuggled",
      role: "prepare",
      verdicts: true,
    } as AnyEvaluationNodeDefinition;

    expect(buildError([{ id: "source", type: "smuggled" }], [smuggled]).code).toBe(
      "prepare_declares_verdicts",
    );
    expect(() =>
      defineEvaluationNode({ ...numberSource, type: "rejected", verdicts: true }),
    ).toThrow("cannot declare verdicts");
  });

  it("rejects a spec with no nodes", () => {
    expect(buildError([]).code).toBe("spec_invalid");
  });
});
