import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { AlertTriangle, Check, Plus, Trash2, X } from "lucide-react";

import type {
  ConfiguredAgent,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationExperimentGraph,
  EvaluationGraphNodeSpec,
  EvaluationGraphSpec,
} from "../../../../automation/contracts";
import {
  buildEvaluationGraph,
  EvaluationGraphBuildError,
  type BuiltEvaluationGraph,
} from "../../../../core/evaluation/graph/builder";
import { buildEvaluationCaseSpec } from "../../../../core/evaluation/case-graph";
import {
  createEvaluationValidationRegistry,
  evaluationNodeCatalog,
  type EvaluationNodeCatalogEntry,
} from "../../../../core/evaluation/node-catalog";
import { localize, type LanguageMode } from "../../language";

/**
 * Canvas editor for an experiment's evaluation graph.
 *
 * Validation is the real thing: every edit is run through the same builder the
 * runner uses, so an unwireable graph is refused here rather than at run time.
 * Edges are drawn from the built result, which means the inputs the builder
 * resolved on its own are visible instead of looking unconnected.
 */

const NODE_WIDTH = 184;
const HEADER_HEIGHT = 30;
const PORT_SPACING = 18;
const PORT_TOP = HEADER_HEIGHT + 12;
const GRAPH_VERSION = 1;

interface EditorNode {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  in: Record<string, string>;
  x: number;
  y: number;
}

type Validation =
  | { ok: true; graph: BuiltEvaluationGraph }
  | { ok: false; code: string; details: Record<string, unknown> };

export function EvalGraphEditor({
  language,
  experiment,
  onSaved,
  onClose,
}: {
  language: LanguageMode;
  experiment: EvaluationExperiment;
  onSaved: (experiment: EvaluationExperiment) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const catalog = useMemo(() => evaluationNodeCatalog(), []);
  const registry = useMemo(() => createEvaluationValidationRegistry(), []);
  const [nodes, setNodes] = useState<EditorNode[]>(() => seedNodes(experiment, registry));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingSource, setPendingSource] = useState<{ nodeId: string; output: string } | null>(null);
  const [agents, setAgents] = useState<ConfiguredAgent[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragging = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [snapshot, nextEvaluators, skillSnapshot] = await Promise.all([
          window.sessionSearch.automation.getSnapshot(),
          window.sessionSearch.automation.listEvaluationEvaluators(),
          window.sessionSearch.listSkills(),
        ]);
        if (cancelled) return;
        setAgents(snapshot.configuredAgents);
        setEvaluators(nextEvaluators.filter((item) => item.enabled));
        setSkills([...new Set(skillSnapshot.skills.map((item) => item.name))].sort());
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const spec = useMemo<EvaluationGraphSpec>(() => ({
    name: experiment.name || experiment.id,
    version: GRAPH_VERSION,
    nodes: nodes.map((node): EvaluationGraphNodeSpec => ({
      id: node.id,
      type: node.type,
      ...(node.enabled ? {} : { enabled: false }),
      config: node.config,
      ...(Object.keys(node.in).length > 0 ? { in: node.in } : {}),
    })),
  }), [experiment.id, experiment.name, nodes]);

  const validation = useMemo<Validation>(() => {
    if (nodes.length === 0) {
      return { ok: false, code: "spec_invalid", details: { message: "the graph has no nodes" } };
    }
    try {
      return { ok: true, graph: buildEvaluationGraph(spec, registry) };
    } catch (cause) {
      if (cause instanceof EvaluationGraphBuildError) {
        return { ok: false, code: cause.code, details: cause.details };
      }
      return { ok: false, code: "spec_invalid", details: { message: String(cause) } };
    }
  }, [nodes.length, registry, spec]);

  const addNode = useCallback((entry: EvaluationNodeCatalogEntry) => {
    setNodes((current) => {
      const id = freeNodeId(entry.type, new Set(current.map((node) => node.id)));
      return [...current, {
        id,
        type: entry.type,
        enabled: true,
        config: {},
        in: {},
        x: 40 + (current.length % 4) * (NODE_WIDTH + 40),
        y: 40 + Math.floor(current.length / 4) * 150,
      }];
    });
    setSelectedId(null);
  }, []);

  const removeNode = useCallback((nodeId: string) => {
    setNodes((current) => current
      .filter((node) => node.id !== nodeId)
      .map((node) => ({
        ...node,
        // Bindings that pointed at the removed node would be dangling refs, so
        // they go with it rather than making the graph unbuildable.
        in: Object.fromEntries(
          Object.entries(node.in).filter(([, from]) => producerOf(from) !== nodeId),
        ),
      })));
    setSelectedId((current) => (current === nodeId ? null : current));
    setPendingSource((current) => (current?.nodeId === nodeId ? null : current));
  }, []);

  const connect = useCallback((consumerId: string, input: string) => {
    setPendingSource((source) => {
      if (!source) return null;
      setNodes((current) => current.map((node) => node.id === consumerId
        ? { ...node, in: { ...node.in, [input]: `${source.nodeId}.${source.output}` } }
        : node));
      return null;
    });
  }, []);

  const disconnect = useCallback((consumerId: string, input: string) => {
    setNodes((current) => current.map((node) => {
      if (node.id !== consumerId) return node;
      const next = { ...node.in };
      delete next[input];
      return { ...node, in: next };
    }));
  }, []);

  const onNodePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, node: EditorNode) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = {
      nodeId: node.id,
      offsetX: event.clientX - node.x,
      offsetY: event.clientY - node.y,
    };
    setSelectedId(node.id);
  }, []);

  const onNodePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = dragging.current;
    if (!active) return;
    const x = Math.max(0, event.clientX - active.offsetX);
    const y = Math.max(0, event.clientY - active.offsetY);
    setNodes((current) => current.map((node) => node.id === active.nodeId ? { ...node, x, y } : node));
  }, []);

  const onNodePointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const save = useCallback(async () => {
    if (!validation.ok) return;
    setSaving(true);
    setError(null);
    try {
      const graph: EvaluationExperimentGraph = {
        version: GRAPH_VERSION,
        spec,
        layout: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      };
      const saved = await window.sessionSearch.automation.saveEvaluationExperiment({
        ...experiment,
        graph,
        updatedAt: Date.now(),
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [experiment, nodes, onSaved, spec, validation.ok]);

  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEntry = selected ? catalog.find((entry) => entry.type === selected.type) ?? null : null;
  const edges = validation.ok
    ? validation.graph.edges.filter((edge) => edge.kind === "data")
    : nodes.flatMap((node) => Object.entries(node.in).map(([input, from]) => ({
      from: producerOf(from),
      to: node.id,
      input,
      output: outputOf(from),
      auto: false,
    })));

  return (
    <div className="eval-editor">
      <header className="eval-editor-header">
        <h4>{l("Graph editor", "图编辑器")} · {experiment.name || experiment.id}</h4>
        <div className="eval-editor-actions">
          {validation.ok ? (
            <span className="eval-badge eval-badge-current">
              <Check size={11} />{l("valid", "校验通过")}
            </span>
          ) : (
            <span className="eval-badge eval-badge-warn" title={JSON.stringify(validation.details)}>
              <AlertTriangle size={11} />{buildErrorText(language, validation.code, validation.details)}
            </span>
          )}
          <button
            type="button"
            className="eval-run-button"
            disabled={!validation.ok || saving}
            onClick={() => void save()}
          >
            {saving ? l("Saving...", "保存中...") : l("Save graph", "保存图")}
          </button>
          <button type="button" className="eval-icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={14} />
          </button>
        </div>
      </header>
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <p className="eval-muted">
        {pendingSource
          ? l("Click an input port to connect.", "点击一个输入端口完成连线。")
          : l(
            "Drag a node to move it. Click an output port, then an input port, to connect. Click a connected input to disconnect.",
            "拖动节点可移动。先点输出端口再点输入端口即可连线，点已连接的输入端口断开。",
          )}
      </p>
      <div className="eval-editor-body">
        <ul className="eval-editor-palette">
          {catalog.map((entry) => (
            <li key={entry.type}>
              <button type="button" onClick={() => addNode(entry)} title={localize(language, entry.descriptionEn, entry.descriptionZh)}>
                <Plus size={11} />{localize(language, entry.labelEn, entry.labelZh)}
                <span className={`eval-badge ${entry.role === "judge" ? "eval-badge-warn" : "eval-badge-dim"}`}>
                  {entry.role === "judge" ? l("judge", "评判") : l("step", "步骤")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="eval-editor-canvas">
          <svg className="eval-editor-edges" aria-hidden="true">
            {edges.map((edge) => {
              const from = nodes.find((node) => node.id === edge.from);
              const to = nodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              const fromEntry = catalog.find((entry) => entry.type === from.type);
              const toEntry = catalog.find((entry) => entry.type === to.type);
              const outputIndex = fromEntry?.outputs.findIndex((port) => port.name === edge.output) ?? 0;
              const inputIndex = toEntry?.inputs.findIndex((port) => port.name === edge.input) ?? 0;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + PORT_TOP + Math.max(0, outputIndex) * PORT_SPACING;
              const x2 = to.x;
              const y2 = to.y + PORT_TOP + Math.max(0, inputIndex) * PORT_SPACING;
              const curve = Math.max(30, Math.abs(x2 - x1) / 2);
              return (
                <path
                  key={`${edge.from}.${edge.output}->${edge.to}.${edge.input}`}
                  className={`eval-editor-edge ${"auto" in edge && edge.auto ? "is-auto" : ""}`}
                  d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
                />
              );
            })}
          </svg>
          {nodes.map((node) => {
            const entry = catalog.find((item) => item.type === node.type);
            return (
              <article
                key={node.id}
                className={`eval-editor-node ${selectedId === node.id ? "is-selected" : ""} ${node.enabled ? "" : "is-disabled"}`}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
              >
                <header
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                >
                  <span>{entry ? localize(language, entry.labelEn, entry.labelZh) : node.type}</span>
                  <button
                    type="button"
                    onClick={() => removeNode(node.id)}
                    aria-label={l("Remove node", "删除节点")}
                  >
                    <Trash2 size={11} />
                  </button>
                </header>
                <div className="eval-editor-node-ports">
                  <ul className="eval-editor-inputs">
                    {(entry?.inputs ?? []).map((port) => {
                      const connected = node.in[port.name] !== undefined;
                      return (
                        <li key={port.name}>
                          <button
                            type="button"
                            className={`eval-editor-port ${connected ? "is-connected" : ""}`}
                            onClick={() => connected ? disconnect(node.id, port.name) : connect(node.id, port.name)}
                            title={port.kind}
                          >
                            ●
                          </button>
                          <span>{port.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <ul className="eval-editor-outputs">
                    {(entry?.outputs ?? []).map((port) => (
                      <li key={port.name}>
                        <span>{port.name}</span>
                        <button
                          type="button"
                          className={`eval-editor-port ${pendingSource?.nodeId === node.id && pendingSource.output === port.name ? "is-pending" : ""}`}
                          onClick={() => setPendingSource({ nodeId: node.id, output: port.name })}
                          title={port.kind}
                        >
                          ●
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <footer>{configSummary(language, entry, node.config)}</footer>
              </article>
            );
          })}
        </div>
        <div className="eval-editor-inspector">
          {!selected || !selectedEntry ? (
            <p className="eval-muted">{l("Select a node.", "选择一个节点。")}</p>
          ) : (
            <>
              <h5>{localize(language, selectedEntry.labelEn, selectedEntry.labelZh)}</h5>
              <p className="eval-muted">
                {localize(language, selectedEntry.descriptionEn, selectedEntry.descriptionZh)}
              </p>
              <label className="eval-editor-field">
                <span>{l("Node id", "节点 id")}</span>
                <code>{selected.id}</code>
              </label>
              <label className="eval-editor-field">
                <input
                  type="checkbox"
                  checked={selected.enabled}
                  onChange={(event) => setNodes((current) => current.map((node) => node.id === selected.id
                    ? { ...node, enabled: event.target.checked }
                    : node))}
                />
                <span>{l("Enabled", "启用")}</span>
              </label>
              {selectedEntry.configuredPerCase ? (
                <p className="eval-muted">
                  {l("Filled from the case at run time.", "运行时由用例填充。")}
                </p>
              ) : null}
              {selectedEntry.configFields.map((field) => (
                <label key={field.key} className="eval-editor-field">
                  <span>{localize(language, field.labelEn, field.labelZh)}</span>
                  {field.kind === "number" ? (
                    <input
                      type="number"
                      value={typeof selected.config[field.key] === "number" ? String(selected.config[field.key]) : ""}
                      onChange={(event) => setConfigValue(setNodes, selected.id, field.key,
                        event.target.value === "" ? undefined : Number(event.target.value))}
                    />
                  ) : (
                    <select
                      value={typeof selected.config[field.key] === "string" ? String(selected.config[field.key]) : ""}
                      onChange={(event) => setConfigValue(setNodes, selected.id, field.key,
                        event.target.value === "" ? undefined : event.target.value)}
                    >
                      <option value="">
                        {field.kind === "skill"
                          ? l("(inject nothing)", "（不注入）")
                          : field.required
                            ? l("(inherit from experiment)", "（沿用实验设置）")
                            : l("(none)", "（无）")}
                      </option>
                      {field.kind === "agent" ? agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>{agent.name}</option>
                      )) : field.kind === "evaluator" ? evaluators
                        .filter((item) => selectedEntry.type === "llm_judge"
                          ? item.kind === "llm_judge"
                          : item.kind !== "llm_judge")
                        .map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        )) : skills.map((skill) => (
                          <option key={skill} value={skill}>{skill}</option>
                        ))}
                    </select>
                  )}
                </label>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function setConfigValue(
  setNodes: React.Dispatch<React.SetStateAction<EditorNode[]>>,
  nodeId: string,
  key: string,
  value: unknown,
): void {
  setNodes((current) => current.map((node) => {
    if (node.id !== nodeId) return node;
    const config = { ...node.config };
    if (value === undefined) delete config[key];
    else config[key] = value;
    return { ...node, config };
  }));
}

function configSummary(
  language: LanguageMode,
  entry: EvaluationNodeCatalogEntry | undefined,
  config: Record<string, unknown>,
): string {
  if (!entry || entry.configFields.length === 0) return "";
  const parts = entry.configFields
    .map((field) => {
      const value = config[field.key];
      if (value === undefined || value === "") return null;
      return `${localize(language, field.labelEn, field.labelZh)}: ${String(value)}`;
    })
    .filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/**
 * Starts from the shape the runner would derive, so a first edit begins from a
 * graph that already works rather than an empty canvas.
 */
function seedNodes(
  experiment: EvaluationExperiment,
  registry: ReturnType<typeof createEvaluationValidationRegistry>,
): EditorNode[] {
  const saved = experiment.graph?.spec;
  const spec = saved ?? buildEvaluationCaseSpec({
    task: {
      caseId: "preview",
      datasetItemId: "preview",
      repetition: 1,
      input: "",
      metadata: {},
    },
    agentId: experiment.agentId,
    skillName: experiment.skillName ?? null,
    evaluators: [],
    linkSessions: true,
  });
  const layout = experiment.graph?.layout ?? autoLayout(spec, registry);
  return spec.nodes.map((node, index) => ({
    id: node.id,
    type: node.type,
    enabled: node.enabled !== false,
    // The seeded task config is a placeholder the runner overwrites per case.
    config: node.type === "task_source" ? {} : { ...(node.config as Record<string, unknown> ?? {}) },
    in: Object.fromEntries(
      Object.entries(node.in ?? {}).map(([input, binding]) => [
        input,
        typeof binding === "string" ? binding : binding.from,
      ]),
    ),
    x: layout[node.id]?.x ?? 40 + (index % 4) * (NODE_WIDTH + 40),
    y: layout[node.id]?.y ?? 40 + Math.floor(index / 4) * 150,
  }));
}

/** Columns by topological layer, so a seeded graph reads left to right. */
function autoLayout(
  spec: EvaluationGraphSpec,
  registry: ReturnType<typeof createEvaluationValidationRegistry>,
): Record<string, { x: number; y: number }> {
  try {
    const graph = buildEvaluationGraph(spec, registry);
    const layout: Record<string, { x: number; y: number }> = {};
    graph.layers.forEach((layer, layerIndex) => {
      layer.forEach((nodeId, indexInLayer) => {
        layout[nodeId] = {
          x: 30 + layerIndex * (NODE_WIDTH + 56),
          y: 30 + indexInLayer * 130,
        };
      });
    });
    return layout;
  } catch {
    // An unbuildable seed still needs somewhere to put its nodes.
    return {};
  }
}

function freeNodeId(type: string, taken: ReadonlySet<string>): string {
  const base = type.replace(/_/g, "-");
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function producerOf(binding: string): string {
  const split = binding.lastIndexOf(".");
  return split > 0 ? binding.slice(0, split) : binding;
}

function outputOf(binding: string): string {
  const split = binding.lastIndexOf(".");
  return split > 0 ? binding.slice(split + 1) : "";
}

/** Build failures in words, since the codes are for logs rather than users. */
export function buildErrorText(
  language: LanguageMode,
  code: string,
  details: Record<string, unknown>,
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const node = typeof details.nodeId === "string" ? details.nodeId : "";
  const input = typeof details.input === "string" ? details.input : "";
  switch (code) {
    case "unwired_input":
      return l(`${node}.${input} has no source`, `${node} 的输入 ${input} 没有来源`);
    case "ambiguous_input":
      return l(`${node}.${input} has more than one possible source`, `${node} 的输入 ${input} 有多个可能来源`);
    case "type_mismatch":
      return l(`${node}.${input} is connected to the wrong kind of output`, `${node} 的输入 ${input} 连到了类型不匹配的输出`);
    case "cycle_detected":
      return l("the graph has a cycle", "图中存在环");
    case "duplicate_node_id":
      return l("two nodes share an id", "有两个节点 id 重复");
    case "dangling_ref":
      return l("a connection points at a missing node", "有连线指向不存在的节点");
    case "unknown_input":
      return l(`${node} has no input named ${input}`, `${node} 没有名为 ${input} 的输入`);
    case "prepare_declares_verdicts":
      return l("a step node returned a verdict", "非评判节点产出了评分");
    default:
      return l("the graph is not valid yet", "图还不合法");
  }
}
