import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Gauge, Lock, Plus, Trash2 } from "lucide-react";

import type {
  AgentChannel,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluatorKind,
} from "../../../../automation/contracts";
import { EVALUATOR_TEMPLATES } from "../../../../automation/engine/shared/evaluation-templates";
import { localize, type LanguageMode } from "../../language";
import {
  EvalCheckEditor,
  isManagedCheck,
  KIND_LABELS,
} from "./eval-check-editor";
import { dimensionsOf, methodText } from "./eval-dimensions";

/**
 * Where dimensions and their checks are authored.
 *
 * A dimension is not a stored object — it is the checks that share its label —
 * so this page lists checks grouped by dimension, and the form on the right is
 * one check. That form is `EvalCheckEditor`, shared with the plan page's dialog,
 * so a check edited from either place is the same check with the same fields.
 *
 * Dimension and priority are asked for on every kind, because they decide how the
 * verdict is combined: scores are averaged inside a dimension before dimensions
 * are combined, so two checks sharing a dimension do not quietly double that
 * dimension's say.
 */

export function EvalEvaluatorsPage({
  language,
  onDirtyChange,
}: {
  language: LanguageMode;
  onDirtyChange?: (dirty: boolean) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[] | null>(null);
  const [channels, setChannels] = useState<AgentChannel[]>([]);
  const [experiments, setExperiments] = useState<EvaluationExperiment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvaluationEvaluator | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (keepId?: string) => {
    setError(null);
    try {
      const [nextEvaluators, snapshot, nextExperiments] = await Promise.all([
        window.sessionSearch.automation.listEvaluationEvaluators(),
        window.sessionSearch.automation.getSnapshot(),
        window.sessionSearch.automation.listEvaluationExperiments(),
      ]);
      setEvaluators(nextEvaluators);
      setChannels(snapshot.channels);
      setExperiments(nextExperiments);
      setSelectedId((current) => keepId ?? current ?? nextEvaluators[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = useMemo(
    () => evaluators?.find((item) => item.id === selectedId) ?? null,
    [evaluators, selectedId],
  );
  const dimensions = useMemo(() => dimensionsOf(evaluators ?? []), [evaluators]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selected]);

  const managed = Boolean(draft && isManagedCheck(draft.id));
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const usageOf = useCallback(
    (evaluatorId: string) => experiments.filter((item) => item.evaluatorIds.includes(evaluatorId)),
    [experiments],
  );

  const create = useCallback(async (
    input: Partial<EvaluationEvaluator> & { name: string; kind: EvaluatorKind },
  ) => {
    setError(null);
    try {
      const now = Date.now();
      const created = await window.sessionSearch.automation.saveEvaluationEvaluator({
        id: `evaluator-${now}`,
        name: input.name,
        kind: input.kind,
        threshold: input.threshold ?? 0.6,
        enabled: true,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        // A new check belongs to the dimension it was added under; without this it
        // would become a dimension of its own named after itself.
        ...(input.dimension ? { dimension: input.dimension } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await reload(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [reload]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.sessionSearch.automation.saveEvaluationEvaluator({
        ...draft,
        name: draft.name.trim() || draft.id,
        updatedAt: Date.now(),
      });
      await reload(saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, reload]);

  const remove = useCallback(async () => {
    if (!selected) return;
    const used = usageOf(selected.id);
    const confirmed = window.confirm(used.length > 0
      ? l(
        `${used.length} experiment(s) use "${selected.name}". Delete it anyway?`,
        `有 ${used.length} 个实验正在使用「${selected.name}」，仍要删除吗？`,
      )
      : l(`Delete evaluator "${selected.name}"?`, `删除评分器「${selected.name}」？`));
    if (!confirmed) return;
    setError(null);
    try {
      await window.sessionSearch.automation.deleteEvaluationEvaluator(selected.id);
      setSelectedId(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l, reload, selected, usageOf]);

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><Gauge size={14} /> {l("Dimensions", "维度")}</h4>
        <div className="eval-editor-actions">
          <button
            type="button"
            className="eval-run-button"
            onClick={() => void create({
              name: l("Untitled dimension", "未命名维度"),
              kind: "contains",
              dimension: l("Untitled dimension", "未命名维度"),
            })}
          >
            <Plus size={13} />{l("New dimension", "新建维度")}
          </button>
          <select
            value=""
            onChange={(event) => {
              const template = EVALUATOR_TEMPLATES.find((item) => item.id === event.target.value);
              if (template) {
                void create({
                  name: template.name,
                  kind: template.kind,
                  threshold: template.threshold,
                  ...(template.prompt ? { prompt: template.prompt } : {}),
                });
              }
            }}
          >
            <option value="">{l("From template...", "从模板创建...")}</option>
            {EVALUATOR_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {localize(language, ...KIND_LABELS[template.kind])}
              </option>
            ))}
          </select>
        </div>
      </header>
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <div className="eval-graph-body">
        <ul className="eval-graph-run-list">
          {evaluators === null ? (
            <li className="eval-muted">{l("Loading...", "加载中...")}</li>
          ) : evaluators.length === 0 ? (
            <li className="eval-muted">{l("No dimensions yet.", "还没有维度。")}</li>
          ) : dimensions.map((dimension) => (
            <li key={dimension.name} className="eval-dimension-group">
              <header>
                <span className="eval-dimension-group-name">{dimension.name}</span>
                {dimension.priority ? (
                  <span className={`eval-dimension-priority is-${dimension.priority}`}>
                    {dimension.priority === "must" ? l("must", "必须") : l("should", "应该")}
                  </span>
                ) : null}
                <span className="eval-muted">{methodText(language, dimension)}</span>
                <button
                  type="button"
                  className="eval-icon-button"
                  aria-label={l("Add a check", "添加检查")}
                  title={l(
                    "Another check on this dimension. Scores inside a dimension are averaged before dimensions combine.",
                    "给这个维度再加一条检查。同一维度内先取平均，再与其它维度合并。",
                  )}
                  onClick={() => void create({
                    name: l("Untitled check", "未命名检查"),
                    kind: "contains",
                    dimension: dimension.name,
                  })}
                >
                  <Plus size={12} />
                </button>
              </header>
              {dimension.checks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`eval-graph-run-row ${item.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="eval-graph-run-name">{item.name}</span>
                <span className="eval-graph-run-meta">
                  <span className="eval-badge eval-badge-dim">
                    {localize(language, ...KIND_LABELS[item.kind])}
                  </span>
                  <span className="eval-muted">≥ {item.threshold.toFixed(2)}</span>
                  {isManagedCheck(item.id) ? (
                    <span className="eval-badge eval-badge-dim"><Lock size={10} />{l("managed", "内置")}</span>
                  ) : null}
                </span>
              </button>
              ))}
            </li>
          ))}
        </ul>
        <div className="eval-graph-detail">
          {!draft ? (
            <p className="eval-muted">{l("Select an evaluator.", "选择一个评分器。")}</p>
          ) : (
            <>
              <EvalCheckEditor
                language={language}
                draft={draft}
                managed={managed}
                channels={channels}
                onChange={setDraft}
              />
              <div className="eval-editor-actions">
                <button
                  type="button"
                  className="eval-run-button"
                  disabled={saving || managed || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? l("Saving...", "保存中...") : dirty ? l("Save", "保存") : l("Saved", "已保存")}
                </button>
                <button type="button" className="eval-icon-button" disabled={managed} onClick={() => void remove()}>
                  <Trash2 size={12} />{l("Delete", "删除")}
                </button>
                {usageOf(draft.id).length > 0 ? (
                  <span className="eval-muted">
                    {l(
                      `used by ${usageOf(draft.id).length} experiment(s)`,
                      `被 ${usageOf(draft.id).length} 个实验使用`,
                    )}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
