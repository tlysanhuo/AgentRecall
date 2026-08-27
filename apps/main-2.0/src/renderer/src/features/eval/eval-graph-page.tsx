import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, ExternalLink, Pencil, Plus, RefreshCw, Workflow } from "lucide-react";

import type {
  EvaluationDataset,
  EvaluationExperiment,
  EvaluationNodeRecord,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { EvalGraphEditor } from "./eval-graph-editor";
import {
  formatDuration,
  formatRatio,
  nodeLabel,
  nodeReasonText,
  nodeStatusClass,
  nodeStatusText,
  runStatusText,
  skillUseText,
} from "./eval-format";

/**
 * Execution-graph view for evaluation runs.
 *
 * Its reason for existing is what a score alone cannot say: which step of a
 * case produced the result, and which steps never ran. A run whose judge had no
 * Runtime channel and a run whose agent answered badly both used to read as a
 * low score; here they are two visibly different graphs.
 */
export function EvalGraphPage({
  language,
  onOpenSession,
}: {
  language: LanguageMode;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [runs, setRuns] = useState<EvaluationRunSummary[] | null>(null);
  const [experimentList, setExperimentList] = useState<EvaluationExperiment[]>([]);
  const [experiments, setExperiments] = useState<Map<string, string>>(new Map());
  const [editing, setEditing] = useState<EvaluationExperiment | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [page, experimentList] = await Promise.all([
        window.sessionSearch.automation.listEvaluationRuns({ limit: 50 }),
        window.sessionSearch.automation.listEvaluationExperiments(),
      ]);
      setRuns(page.items);
      setExperimentList(experimentList);
      setExperiments(new Map(
        experimentList.map((item: EvaluationExperiment) => [item.id, item.name || item.id]),
      ));
      setSelectedRunId((current) => current ?? page.items[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    setLoadingRun(true);
    void (async () => {
      try {
        const next = await window.sessionSearch.automation.getEvaluationRun(selectedRunId);
        if (!cancelled) setRun(next ?? null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoadingRun(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  if (editing) {
    return (
      <EvalGraphEditor
        language={language}
        experiment={editing}
        onSaved={(saved) => {
          setEditing(null);
          setExperimentList((current) => current.map((item) => item.id === saved.id ? saved : item));
          void reload();
        }}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><Workflow size={14} /> {l("Execution graph", "执行图")}</h4>
        <div className="eval-editor-actions">
          <button type="button" className="eval-run-button" onClick={() => setCreating(true)}>
            <Plus size={13} />{l("New graph", "新建图")}
          </button>
          <button type="button" className="eval-run-button" onClick={() => void reload()}>
            <RefreshCw size={13} />{l("Refresh", "刷新")}
          </button>
        </div>
      </header>
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
      {experimentList.length > 0 ? (
        <ul className="eval-graph-experiment-list">
          {experimentList.map((item) => (
            <li key={item.id}>
              <span className="eval-graph-run-name">{item.name || item.id}</span>
              <span className={`eval-badge ${item.graph ? "eval-badge-current" : "eval-badge-dim"}`}>
                {item.graph ? l("custom graph", "自定义图") : l("derived", "默认图")}
              </span>
              <button type="button" className="eval-icon-button" onClick={() => setEditing(item)}>
                <Pencil size={12} />{l("Edit graph", "编辑图")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="eval-muted">
        {l(
          "Every evaluation run executes as a graph. Each case shows the steps it went through, and the steps that never ran with the reason why.",
          "每次评测都按图执行。展开任一运行可以看到每个用例走过哪些步骤，以及哪些步骤没有执行、原因是什么。",
        )}
      </p>
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <div className="eval-graph-body">
        <ul className="eval-graph-run-list">
          {runs === null ? (
            <li className="eval-muted">{l("Loading...", "加载中...")}</li>
          ) : runs.length === 0 ? (
            <li className="eval-muted">{l("No runs yet.", "还没有运行记录。")}</li>
          ) : runs.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`eval-graph-run-row ${item.id === selectedRunId ? "active" : ""}`}
                onClick={() => setSelectedRunId(item.id)}
              >
                <span className="eval-graph-run-name">
                  {experiments.get(item.experimentId) ?? item.experimentId}
                </span>
                <span className="eval-graph-run-meta">
                  <span className={`eval-badge ${item.status === "completed" ? "eval-badge-current" : item.status === "running" || item.status === "pending" ? "eval-badge-dim" : "eval-badge-warn"}`}>
                    {runStatusText(language, item.status)}
                  </span>
                  <span className="eval-muted">{formatRelativeTime(item.startedAt, language)}</span>
                  {item.engine === undefined ? (
                    <span className="eval-badge eval-badge-dim">{l("legacy", "旧格式")}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="eval-graph-detail">
          {loadingRun ? <p className="eval-muted">{l("Loading...", "加载中...")}</p>
            : !run ? <p className="eval-muted">{l("Select a run.", "选择一次运行。")}</p>
            : <RunGraph language={language} run={run} onOpenSession={onOpenSession} />}
        </div>
      </div>
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

function RunGraph({
  language,
  run,
  onOpenSession,
}: {
  language: LanguageMode;
  run: EvaluationRun;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <>
      <div className="eval-graph-summary">
        <span className={`eval-badge ${run.status === "completed" ? "eval-badge-current" : "eval-badge-warn"}`}>
          {runStatusText(language, run.status)}
        </span>
        <span>{l("pass", "通过")} {formatRatio(run.passRate ?? null)}</span>
        <span>{l("average", "平均分")} {run.averageScore !== undefined ? run.averageScore.toFixed(2) : "—"}</span>
        {run.scoredCaseCount !== undefined ? (
          <span>{l("scored", "已评分")} {run.scoredCaseCount}</span>
        ) : null}
        {run.unscoredCaseCount ? (
          <span className="eval-badge eval-badge-dim">
            {l("not scored", "未评分")} {run.unscoredCaseCount}
          </span>
        ) : null}
        {run.skillHash ? (
          <span className="eval-muted">Skill @{run.skillHash.slice(0, 8)}</span>
        ) : null}
        <span className="eval-muted">{formatDuration(run.totalDurationMs ?? null)}</span>
      </div>
      {run.error ? <p className="eval-error" role="alert">{run.error}</p> : null}
      {run.engine === undefined ? (
        <p className="eval-muted">
          <AlertTriangle size={12} />{" "}
          {l(
            "This run predates the execution graph, so it has no step records. Run the experiment again to see its graph.",
            "这次运行早于执行图，没有步骤记录。重新跑一次该实验即可看到执行图。",
          )}
        </p>
      ) : run.results.length === 0 ? (
        <p className="eval-muted">{l("No cases were recorded.", "没有记录到用例。")}</p>
      ) : (
        <ol className="eval-graph-cases">
          {run.results.map((result, index) => {
            const unscored = result.unscoredReason !== undefined;
            const passed = !unscored
              && result.gatePassed !== false
              && result.scores.length > 0
              && result.scores.every((score) => score.passed);
            return (
              <li key={result.id} className="eval-graph-case">
                <header>
                  <span className="eval-graph-case-title">
                    {l(`Case ${index + 1}`, `用例 ${index + 1}`)}
                    {run.results.filter((item) => item.datasetItemId === result.datasetItemId).length > 1
                      ? ` · #${result.repetition}`
                      : ""}
                  </span>
                  <span className={`eval-badge ${unscored ? "eval-badge-dim" : passed ? "eval-badge-current" : "eval-badge-warn"}`}>
                    {unscored ? l("Not scored", "未评分") : passed ? l("Passed", "通过") : l("Failed", "未通过")}
                  </span>
                  {result.skillInjection ? (
                    <span className="eval-muted" title={result.skillInjection.skillHash}>
                      Skill {result.skillInjection.skillName}@{result.skillInjection.skillHash.slice(0, 8)}
                    </span>
                  ) : null}
                  {result.sessionKey ? (
                    <button
                      type="button"
                      className="eval-trigger-session"
                      onClick={() => onOpenSession(result.sessionKey!)}
                    >
                      <ExternalLink size={11} />{l("Session", "会话")}
                    </button>
                  ) : null}
                </header>
                <p className="eval-graph-case-input">{result.input}</p>
                {unscored ? (
                  <p className="eval-muted">
                    {l("Nothing was decided", "没有得出任何结论")}
                    {" · "}{nodeReasonText(language, result.unscoredReason!)}
                  </p>
                ) : null}
                {result.nodes?.length ? (
                  <ol className="eval-graph-nodes">
                    {result.nodes.map((node) => (
                      <GraphNodeRow key={node.nodeId} language={language} node={node} />
                    ))}
                  </ol>
                ) : (
                  <p className="eval-muted">{l("No step records.", "没有步骤记录。")}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function GraphNodeRow({
  language,
  node,
}: {
  language: LanguageMode;
  node: EvaluationNodeRecord;
}): ReactElement {
  const reason = node.attribution?.reason ?? node.pendingReason;
  const skillUse = node.nodeType === "skill_use_observe" ? skillUseText(language, node.facts) : null;
  return (
    <li>
      <span className="eval-graph-node-name">{nodeLabel(language, node)}</span>
      <span className={`eval-badge ${nodeStatusClass(node.status)}`}>
        {nodeStatusText(language, node.status)}
      </span>
      <span className="eval-muted">
        {node.durationMs !== undefined ? formatDuration(node.durationMs) : ""}
      </span>
      <span className="eval-muted eval-graph-node-note">
        {[reason ? nodeReasonText(language, reason) : null, skillUse]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </li>
  );
}
