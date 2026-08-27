import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Pencil, Plus, RefreshCw, Workflow } from "lucide-react";

import type {
  EvaluationDataset,
  EvaluationExperiment,
} from "../../../../automation/contracts";
import { localize, type LanguageMode } from "../../language";
import { EvalGraphEditor } from "./eval-graph-editor";

/**
 * Graph authoring: which experiments have a graph of their own, and the entry
 * point for making one. Run results live on the Runs page.
 */
export function EvalGraphPage({
  language,
}: {
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [experimentList, setExperimentList] = useState<EvaluationExperiment[] | null>(null);
  const [editing, setEditing] = useState<EvaluationExperiment | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setExperimentList(await window.sessionSearch.automation.listEvaluationExperiments());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (editing) {
    return (
      <EvalGraphEditor
        language={language}
        experiment={editing}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><Workflow size={14} /> {l("Execution graphs", "执行图")}</h4>
        <div className="eval-editor-actions">
          <button type="button" className="eval-run-button" onClick={() => setCreating(true)}>
            <Plus size={13} />{l("New graph", "新建图")}
          </button>
          <button type="button" className="eval-run-button" onClick={() => void reload()}>
            <RefreshCw size={13} />{l("Refresh", "刷新")}
          </button>
        </div>
      </header>
      <p className="eval-muted">
        {l(
          "A graph is how one case is evaluated: the task, the agent run, the session link, and each judge. An experiment without one runs the standard shape.",
          "执行图定义单个用例怎么评测：任务、Agent 执行、会话关联，以及各个评判器。没有自定义图的实验按默认形状运行。",
        )}
      </p>
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      {creating ? (
        <NewGraphForm
          language={language}
          onCancel={() => setCreating(false)}
          onCreated={(experiment) => {
            setCreating(false);
            setEditing(experiment);
          }}
        />
      ) : null}
      {experimentList === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : experimentList.length === 0 ? (
        <p className="eval-muted">
          {l("No graphs yet. Create one to define how a case is evaluated.", "还没有执行图。新建一个来定义用例的评测流程。")}
        </p>
      ) : (
        <ul className="eval-graph-experiment-list">
          {experimentList.map((item) => (
            <li key={item.id}>
              <span className="eval-graph-run-name">{item.name || item.id}</span>
              <span className={`eval-badge ${item.graph ? "eval-badge-current" : "eval-badge-dim"}`}>
                {item.graph ? l("custom graph", "自定义图") : l("default shape", "默认形状")}
              </span>
              {item.skillName ? (
                <span className="eval-muted">Skill {item.skillName}</span>
              ) : null}
              <button type="button" className="eval-icon-button" onClick={() => setEditing(item)}>
                <Pencil size={12} />{l("Edit graph", "编辑图")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A graph belongs to an experiment, so authoring a new one starts by creating
 * the experiment it will run: which dataset supplies the cases, and which Agent
 * the graph's execute step falls back to.
 */
function NewGraphForm({
  language,
  onCancel,
  onCreated,
}: {
  language: LanguageMode;
  onCancel: () => void;
  onCreated: (experiment: EvaluationExperiment) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [name, setName] = useState("");
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextDatasets, snapshot] = await Promise.all([
          window.sessionSearch.automation.listEvaluationDatasets(),
          window.sessionSearch.automation.getSnapshot(),
        ]);
        if (cancelled) return;
        setDatasets(nextDatasets);
        setDatasetId(nextDatasets[0]?.id ?? "");
        const executionAgents = snapshot.configuredAgents.map((agent) => ({ id: agent.id, name: agent.name }));
        setAgents(executionAgents);
        setAgentId(executionAgents[0]?.id ?? "");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const create = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const created = await window.sessionSearch.automation.saveEvaluationExperiment({
        id: `graph-${now}`,
        name: name.trim() || l("Untitled graph", "未命名图"),
        datasetId,
        agentId,
        evaluatorIds: [],
        repetitions: 1,
        createdAt: now,
        updatedAt: now,
      });
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [agentId, datasetId, l, name, onCreated]);

  return (
    <div className="eval-graph-new">
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <label className="eval-editor-field">
        <span>{l("Name", "名称")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={l("Graph name", "图名称")} />
      </label>
      <label className="eval-editor-field">
        <span>{l("Dataset", "数据集")}</span>
        <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
          {datasets.length === 0 ? <option value="">{l("(no dataset yet)", "（还没有数据集）")}</option> : null}
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>{dataset.name || dataset.id}</option>
          ))}
        </select>
      </label>
      <label className="eval-editor-field">
        <span>{l("Default Agent", "默认 Agent")}</span>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.length === 0 ? <option value="">{l("(no Agent yet)", "（还没有 Agent）")}</option> : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      </label>
      <div className="eval-editor-actions">
        <button
          type="button"
          className="eval-run-button"
          disabled={saving || !datasetId || !agentId}
          onClick={() => void create()}
        >
          {saving ? l("Creating...", "创建中...") : l("Create and edit", "创建并编辑")}
        </button>
        <button type="button" className="eval-icon-button" onClick={onCancel}>
          {l("Cancel", "取消")}
        </button>
      </div>
      {datasets.length === 0 ? (
        <p className="eval-muted">
          {l(
            "A graph runs the cases of a dataset. Create one in the Experiments tab first.",
            "图需要数据集提供用例，请先在「实验」标签页创建一个数据集。",
          )}
        </p>
      ) : null}
    </div>
  );
}
