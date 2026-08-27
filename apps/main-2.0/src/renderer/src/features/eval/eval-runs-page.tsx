import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, ExternalLink, History, RefreshCw } from "lucide-react";

import type {
  EvaluationExperiment,
  EvaluationNodeRecord,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
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
 * Run history with each case's execution graph.
 *
 * What a score alone cannot say is which step produced the result and which
 * steps never ran: a run whose judge had no Runtime channel and a run whose
 * agent answered badly used to read as the same low number, and here they are
 * two visibly different graphs.
 */
export function EvalRunsPage({
  language,
  onOpenSession,
}: {
  language: LanguageMode;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [runs, setRuns] = useState<EvaluationRunSummary[] | null>(null);
  const [experiments, setExperiments] = useState<Map<string, string>>(new Map());
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

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><History size={14} /> {l("Runs", "运行")}</h4>
        <button type="button" className="eval-run-button" onClick={() => void reload()}>
          <RefreshCw size={13} />{l("Refresh", "刷新")}
        </button>
      </header>
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
