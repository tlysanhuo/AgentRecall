import { describe, expect, it } from "vitest";
import { buildEvaluationGraph, createEvaluationNodeRegistry } from "./builder";
import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationFail,
  evaluationPass,
  type AnyEvaluationNodeDefinition,
  type EvaluationNodeRecord,
  type EvaluationNodeResult,
} from "./node";
import { defineEvaluationPort } from "./ports";
import { executeEvaluationGraph } from "./scheduler";

const VALUE_PORT = defineEvaluationPort<string>("test.value");
const LIVE_PORT = defineEvaluationPort<string>("test.live", { ephemeral: true });

function source(type: string, result: () => EvaluationNodeResult) {
  return defineEvaluationNode<
    Record<string, never>,
    { value: typeof VALUE_PORT },
    Record<string, never>
  >({
    type,
    version: 1,
    role: "prepare",
    inputs: {},
    outputs: { value: VALUE_PORT },
    async run() {
      return result();
    },
  });
}

const passingSource = source("passing_source", () =>
  evaluationPass({ outputs: { value: "produced" } }),
);
const failingSource = source("failing_source", () =>
  evaluationFail.model("model_said_no", { outputs: { value: "partial" } }),
);
const throwingSource = defineEvaluationNode<
  Record<string, never>,
  { value: typeof VALUE_PORT },
  Record<string, never>
>({
  type: "throwing_source",
  version: 1,
  role: "prepare",
  inputs: {},
  outputs: { value: VALUE_PORT },
  async run() {
    throw new Error("boom");
  },
});

const relay = defineEvaluationNode<
  { value: typeof VALUE_PORT },
  { value: typeof VALUE_PORT },
  Record<string, never>
>({
  type: "relay",
  version: 1,
  role: "prepare",
  inputs: { value: VALUE_PORT },
  outputs: { value: VALUE_PORT },
  async run(context) {
    return evaluationPass({ outputs: { value: context.in.value } });
  },
});

const observer = defineEvaluationNode<
  { value: typeof VALUE_PORT },
  Record<string, never>,
  Record<string, never>
>({
  type: "observer",
  version: 1,
  role: "prepare",
  inputs: { value: VALUE_PORT },
  outputs: {},
  async run(context) {
    return evaluationPass({ facts: { seen: context.in.value } });
  },
});

function judge(type: string, verdictId: string) {
  return defineEvaluationNode<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>
  >({
    type,
    version: 1,
    role: "judge",
    verdicts: true,
    inputs: {},
    outputs: {},
    async run() {
      return evaluationPass({
        verdicts: [{ verdictId, labels: {}, status: "met", raw: 1 }],
      });
    },
  });
}

async function run(
  nodes: Parameters<typeof buildEvaluationGraph>[0]["nodes"],
  definitions: AnyEvaluationNodeDefinition[],
  options: { signal?: AbortSignal; maxConcurrent?: number } = {},
) {
  const graph = buildEvaluationGraph(
    { name: "test", version: 1, nodes },
    createEvaluationNodeRegistry(definitions),
  );
  const execution = await executeEvaluationGraph({
    graph,
    caseId: "case-1",
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
  });
  const byId = new Map(execution.records.map((record) => [record.nodeId, record]));
  return { execution, record: (id: string) => byId.get(id)! };
}

describe("evaluation graph scheduler", () => {
  it("reports a node blocked by a failed producer as pending, not failed", () => {
    return run(
      [
        { id: "source", type: "failing_source" },
        { id: "sink", type: "observer", in: { value: "source.value" } },
      ],
      [failingSource, observer],
    ).then(({ record }) => {
      expect(record("source")).toMatchObject({
        status: "fail",
        attribution: { type: "model_failure", reason: "model_said_no" },
      });
      expect(record("sink")).toMatchObject({
        status: "pending",
        pendingReason: "upstream_not_pass",
        pendingUpstream: ["source"],
      });
    });
  });

  it("distinguishes a disabled chain from a failure, at every hop", async () => {
    const { record } = await run(
      [
        { id: "source", type: "passing_source", enabled: false },
        { id: "middle", type: "relay", in: { value: "source.value" } },
        { id: "sink", type: "observer", in: { value: "middle.value" } },
      ],
      [passingSource, relay, observer],
    );

    expect(record("source").status).toBe("disabled");
    expect(record("middle")).toMatchObject({
      status: "pending",
      pendingReason: "upstream_skipped",
    });
    // Past the first hop nothing has failed anywhere, so calling this a failure
    // would send triage after a problem that does not exist.
    expect(record("sink")).toMatchObject({
      status: "pending",
      pendingReason: "upstream_skipped",
    });
  });

  it("lets an onFailure binding read a producer that did not pass", async () => {
    const { record } = await run(
      [
        { id: "source", type: "failing_source" },
        {
          id: "sink",
          type: "observer",
          in: { value: { from: "source.value", onFailure: true } },
        },
      ],
      [failingSource, observer],
    );

    expect(record("sink")).toMatchObject({ status: "pass", facts: { seen: "partial" } });
  });

  it("turns a throwing node into an errored record instead of crashing the case", async () => {
    const { record } = await run(
      [
        { id: "source", type: "throwing_source" },
        { id: "sink", type: "observer", in: { value: "source.value" } },
      ],
      [throwingSource, observer],
    );

    expect(record("source")).toMatchObject({
      status: "error",
      attribution: { type: "judge_failure", reason: "boom" },
    });
    expect(record("sink").status).toBe("pending");
  });

  it("marks every node of an already-aborted case as undecided", async () => {
    const controller = new AbortController();
    controller.abort();
    const { execution, record } = await run(
      [
        { id: "source", type: "passing_source" },
        { id: "sink", type: "observer", in: { value: "source.value" } },
      ],
      [passingSource, observer],
      { signal: controller.signal },
    );

    expect(execution.cancelled).toBe(true);
    expect(record("source")).toMatchObject({ status: "pending", pendingReason: "not_decided" });
    expect(record("sink")).toMatchObject({ status: "pending", pendingReason: "not_decided" });
  });

  it("rejects a duplicate verdict id so two judges cannot claim one decision", async () => {
    const { record } = await run(
      [
        { id: "first", type: "first_judge" },
        { id: "second", type: "second_judge" },
      ],
      [judge("first_judge", "shared"), judge("second_judge", "shared")],
    );

    expect(record("first").status).toBe("pass");
    expect(record("second")).toMatchObject({
      status: "error",
      attribution: { reason: "Node second returned duplicate verdict id shared" },
    });
    expect(record("second").verdicts).toBeUndefined();
  });

  it("refuses verdicts from a prepare node", async () => {
    const smuggler = defineEvaluationNode<
      Record<string, never>,
      Record<string, never>,
      Record<string, never>
    >({
      type: "smuggler",
      version: 1,
      role: "prepare",
      inputs: {},
      outputs: {},
      async run() {
        return {
          status: "pass",
          verdicts: [{ verdictId: "sneaky", labels: {}, status: "met" }],
        };
      },
    });

    const { record } = await run([{ id: "smuggler", type: "smuggler" }], [smuggler]);

    expect(record("smuggler")).toMatchObject({
      status: "error",
      attribution: { reason: "Node smuggler is a prepare node and returned verdicts" },
    });
  });

  it("stamps the source node onto every verdict", async () => {
    const { record } = await run(
      [{ id: "only", type: "first_judge" }],
      [judge("first_judge", "v1")],
    );

    expect(record("only").verdicts).toEqual([
      {
        verdictId: "v1",
        labels: {},
        status: "met",
        raw: 1,
        sourceNodeId: "only",
        sourceNodeType: "first_judge",
      },
    ]);
  });

  it("holds concurrency inside a layer to the configured bound", async () => {
    let active = 0;
    let peak = 0;
    const slow = defineEvaluationNode<
      Record<string, never>,
      Record<string, never>,
      Record<string, never>
    >({
      type: "slow",
      version: 1,
      role: "prepare",
      inputs: {},
      outputs: {},
      async run() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return evaluationPass();
      },
    });

    await run(
      Array.from({ length: 6 }, (_unused, index) => ({ id: `n${index}`, type: "slow" })),
      [slow],
      { maxConcurrent: 2 },
    );

    expect(peak).toBe(2);
  });

  it("emits each record as it lands so a caller can persist progress", async () => {
    const graph = buildEvaluationGraph(
      {
        name: "test",
        version: 1,
        nodes: [
          { id: "source", type: "passing_source" },
          { id: "sink", type: "observer", in: { value: "source.value" } },
        ],
      },
      createEvaluationNodeRegistry([passingSource, observer]),
    );
    const seen: EvaluationNodeRecord[] = [];

    await executeEvaluationGraph({
      graph,
      caseId: "case-1",
      onNodeRecord: (record) => seen.push(record),
    });

    expect(seen.map((record) => record.nodeId)).toEqual(["source", "sink"]);
  });

  it("keeps ephemeral port values out of the returned value map", async () => {
    const live = defineEvaluationNode<
      Record<string, never>,
      { handle: typeof LIVE_PORT; value: typeof VALUE_PORT },
      Record<string, never>
    >({
      type: "live_source",
      version: 1,
      role: "prepare",
      inputs: {},
      outputs: { handle: LIVE_PORT, value: VALUE_PORT },
      async run() {
        return evaluationPass({ outputs: { handle: "open", value: "kept" } });
      },
    });

    const { execution, record } = await run([{ id: "live", type: "live_source" }], [live]);

    expect(record("live").producedOutputs).toEqual(["handle", "value"]);
    expect([...execution.values.get("live")!.keys()]).toEqual(["value"]);
  });

  it("drops an output the node never declared", async () => {
    const chatty = defineEvaluationNode<
      Record<string, never>,
      { value: typeof VALUE_PORT },
      Record<string, never>
    >({
      type: "chatty",
      version: 1,
      role: "prepare",
      inputs: {},
      outputs: { value: VALUE_PORT },
      async run() {
        return evaluationPass({ outputs: { value: "declared", extra: "undeclared" } });
      },
    });

    const { record } = await run([{ id: "chatty", type: "chatty" }], [chatty]);

    expect(record("chatty").producedOutputs).toEqual(["value"]);
  });

  it("keeps an excused producer from feeding its consumer", async () => {
    const excusedSource = source("excused_source", () =>
      evaluationExcused.infra("runtime_missing", { outputs: { value: "leftover" } }),
    );
    const { record } = await run(
      [
        { id: "source", type: "excused_source" },
        { id: "sink", type: "observer", in: { value: "source.value" } },
      ],
      [excusedSource, observer],
    );

    expect(record("source").status).toBe("excused");
    expect(record("sink")).toMatchObject({
      status: "pending",
      pendingReason: "upstream_not_pass",
    });
  });
});
