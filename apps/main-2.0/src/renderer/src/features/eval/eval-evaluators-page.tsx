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

/**
 * Evaluator authoring.
 *
 * Kinds split into groups that behave differently at run time: the deterministic
 * ones decide from the expected output alone, an LLM judge needs a Runtime
 * channel and a rubric, and a script judge is code the user wrote. None of them
 * can fail a case by breaking — a missing channel, a script that throws, a
 * trajectory that never arrived all report as unscored rather than as a zero, and
 * the form says so where the choice is made.
 *
 * Dimension and priority are asked for on every kind, because they decide how the
 * verdict is combined: scores are averaged inside a dimension before dimensions
 * are combined, so two checks sharing a dimension do not quietly double that
 * dimension's say.
 */

const KIND_LABELS: Record<EvaluatorKind, [string, string]> = {
  exact_match: ["Exact match", "精确匹配"],
  contains: ["Contains", "包含"],
  json_valid: ["JSON valid", "JSON 合法性"],
  llm_judge: ["LLM judge", "模型评判"],
  tool_failures: ["Tool failures", "工具失败"],
  script: ["Script", "脚本评判"],
};

const KIND_HINTS: Record<EvaluatorKind, [string, string]> = {
  exact_match: [
    "Needs an expected output; a case without one is reported as undecidable.",
    "需要期望输出；用例没有期望输出时会记为无法判定。",
  ],
  contains: [
    "Passes when the answer contains the expected output.",
    "答案包含期望输出即通过。",
  ],
  json_valid: ["Passes when the answer parses as JSON.", "答案能被解析为 JSON 即通过。"],
  llm_judge: [
    "Needs a Runtime channel. Without one the case is unscored, not failed.",
    "需要 Runtime 通道；没有通道时该用例记为未评分，而不是不通过。",
  ],
  tool_failures: [
    "Judges the trajectory, so it needs a source that has one; a folder artifact does not.",
    "判定轨迹，因此需要有轨迹的产物来源；产物文件夹没有轨迹。",
  ],
  script: [
    "Your own code decides. A script that breaks is reported as unscored, never as a zero.",
    "由你自己写的代码判定。脚本本身出错会记为未评分，不会算成 0 分。",
  ],
};

const BUILTIN_PREFIX = "builtin-judge-";

const INLINE_JUDGE_EXAMPLE = `// task / artifact / trajectory are in scope.
// Return a score, or a list of scores to cover several dimensions at once.
const answer = artifact.output.trim();
return {
  score: answer.length <= 200 ? 1 : 0,
  reason: \`answer is \${answer.length} characters\`,
};`;

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

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selected]);

  const managed = Boolean(draft?.id.startsWith(BUILTIN_PREFIX));
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const usageOf = useCallback(
    (evaluatorId: string) => experiments.filter((item) => item.evaluatorIds.includes(evaluatorId)),
    [experiments],
  );

  const create = useCallback(async (input: Partial<EvaluationEvaluator> & { name: string; kind: EvaluatorKind }) => {
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
        <h4><Gauge size={14} /> {l("Evaluators", "评分器")}</h4>
        <div className="eval-editor-actions">
          <button
            type="button"
            className="eval-run-button"
            onClick={() => void create({ name: l("Untitled evaluator", "未命名评分器"), kind: "contains" })}
          >
            <Plus size={13} />{l("New evaluator", "新建评分器")}
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
            <li className="eval-muted">{l("No evaluators yet.", "还没有评分器。")}</li>
          ) : evaluators.map((item) => (
            <li key={item.id}>
              <button
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
                  {item.id.startsWith(BUILTIN_PREFIX) ? (
                    <span className="eval-badge eval-badge-dim"><Lock size={10} />{l("managed", "内置")}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="eval-graph-detail">
          {!draft ? (
            <p className="eval-muted">{l("Select an evaluator.", "选择一个评分器。")}</p>
          ) : (
            <>
              {managed ? (
                <p className="eval-muted">
                  <Lock size={12} />{" "}
                  {l(
                    "This judge is managed by AgentRecall and is re-synced from code before each run, so edits here would not survive.",
                    "这个评判器由 AgentRecall 内置管理，每次运行前都会按代码定义同步，在这里的改动不会保留。",
                  )}
                </p>
              ) : null}
              <label className="eval-editor-field">
                <span>{l("Name", "名称")}</span>
                <input
                  value={draft.name}
                  disabled={managed}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <div className="eval-evaluator-kinds">
                {(Object.keys(KIND_LABELS) as EvaluatorKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={draft.kind === kind ? "active" : ""}
                    disabled={managed}
                    onClick={() => setDraft({ ...draft, kind })}
                  >
                    <strong>{localize(language, ...KIND_LABELS[kind])}</strong>
                    <small>{localize(language, ...KIND_HINTS[kind])}</small>
                  </button>
                ))}
              </div>
              <label className="eval-editor-field">
                <span>{l("Pass threshold", "通过阈值")} · {draft.threshold.toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.threshold}
                  disabled={managed}
                  onChange={(event) => setDraft({ ...draft, threshold: Number(event.target.value) })}
                />
              </label>
              <div className="eval-editor-row">
                <label className="eval-editor-field">
                  <span>{l("Dimension", "维度")}</span>
                  <input
                    value={draft.dimension ?? ""}
                    placeholder={l("defaults to this evaluator", "默认使用本评分器")}
                    disabled={managed}
                    onChange={(event) => setDraft({ ...draft, dimension: event.target.value })}
                  />
                </label>
                <label className="eval-editor-field">
                  <span>{l("Priority", "重要程度")}</span>
                  <select
                    value={draft.priority ?? ""}
                    disabled={managed}
                    onChange={(event) => setDraft({
                      ...draft,
                      priority: event.target.value === ""
                        ? undefined
                        : event.target.value as "must" | "should",
                    })}
                  >
                    <option value="">{l("(unset)", "（未设置）")}</option>
                    <option value="must">{l("must", "必须")}</option>
                    <option value="should">{l("should", "应该")}</option>
                  </select>
                </label>
              </div>
              <label className="eval-editor-field">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={managed}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                <span>{l("Enabled", "启用")}</span>
              </label>
              {draft.kind === "tool_failures" ? (
                <label className="eval-editor-field">
                  <span>{l("Tool failures tolerated", "容许的工具失败次数")}</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.maxToolFailures ?? 0}
                    disabled={managed}
                    onChange={(event) => setDraft({
                      ...draft,
                      maxToolFailures: Math.max(0, Number(event.target.value) || 0),
                    })}
                  />
                </label>
              ) : null}
              {draft.kind === "script" ? (
                <ScriptJudgeFields
                  draft={draft}
                  managed={managed}
                  language={language}
                  onChange={setDraft}
                />
              ) : null}
              {draft.kind === "llm_judge" ? (
                <>
                  <label className="eval-editor-field">
                    <span>{l("Judge Runtime channel", "评判 Runtime 通道")}</span>
                    <select
                      value={draft.runtimeId ?? ""}
                      disabled={managed}
                      onChange={(event) => setDraft({ ...draft, runtimeId: event.target.value })}
                    >
                      <option value="">{l("(none — cases stay unscored)", "（未选择 — 用例会记为未评分）")}</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.label} · {channel.agentId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="eval-editor-field">
                    <span>
                      {l("Scoring prompt", "评分 Prompt")}
                      {" · "}
                      {l("placeholders: {{input}} {{output}} {{ground_truth}} {{context}}", "占位符：{{input}} {{output}} {{ground_truth}} {{context}}")}
                    </span>
                    <textarea
                      value={draft.prompt ?? ""}
                      rows={10}
                      disabled={managed}
                      onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                    />
                  </label>
                </>
              ) : null}
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

/**
 * The script judge's own form.
 *
 * The two modes are not interchangeable in what they may do, and the form says
 * which is which: inline JS runs sandboxed with only the case in scope, while a
 * command is a real process and stays behind a setting until it is turned on.
 */
function ScriptJudgeFields({
  draft,
  managed,
  language,
  onChange,
}: {
  draft: EvaluationEvaluator;
  managed: boolean;
  language: LanguageMode;
  onChange: (next: EvaluationEvaluator) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const mode = draft.scriptMode ?? "inline_js";
  return (
    <>
      <div className="eval-editor-row">
        <label className="eval-editor-field">
          <span>{l("How it runs", "运行方式")}</span>
          <select
            value={mode}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              scriptMode: event.target.value as "inline_js" | "command",
            })}
          >
            <option value="inline_js">{l("Inline JavaScript (sandboxed)", "内联 JavaScript（沙箱）")}</option>
            <option value="command">{l("External command", "外部命令")}</option>
          </select>
        </label>
        <label className="eval-editor-field">
          <span>{l("What it judges", "判定对象")}</span>
          <select
            value={draft.subject ?? "artifact"}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              subject: event.target.value as "artifact" | "trajectory",
            })}
          >
            <option value="artifact">{l("The artifact", "产物")}</option>
            <option value="trajectory">{l("The trajectory", "轨迹")}</option>
          </select>
        </label>
        <label className="eval-editor-field">
          <span>{l("Timeout (ms)", "超时（毫秒）")}</span>
          <input
            type="number"
            min={100}
            step={100}
            value={draft.timeoutMs ?? (mode === "command" ? 30000 : 5000)}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              timeoutMs: Math.max(100, Number(event.target.value) || 0),
            })}
          />
        </label>
      </div>
      {mode === "inline_js" ? (
        <label className="eval-editor-field">
          <span>
            {l("Judge code", "评判代码")}
            {" · "}
            {l(
              "task, artifact and trajectory are in scope; no filesystem, network or modules",
              "作用域内有 task、artifact、trajectory；没有文件系统、网络和模块",
            )}
          </span>
          <textarea
            className="eval-code-input"
            value={draft.script ?? ""}
            rows={12}
            spellCheck={false}
            placeholder={INLINE_JUDGE_EXAMPLE}
            disabled={managed}
            onChange={(event) => onChange({ ...draft, script: event.target.value })}
          />
        </label>
      ) : (
        <>
          <p className="eval-muted">
            {l(
              "The case arrives as JSON on stdin; print the verdict as JSON on stdout. A command only runs while external script judges are enabled in Settings.",
              "用例以 JSON 从 stdin 进入，判定结果以 JSON 打印到 stdout。只有在设置里允许外部脚本评判时命令才会执行。",
            )}
          </p>
          <div className="eval-editor-row">
            <label className="eval-editor-field">
              <span>{l("Command", "命令")}</span>
              <input
                value={draft.command ?? ""}
                placeholder="/usr/bin/python3"
                disabled={managed}
                onChange={(event) => onChange({ ...draft, command: event.target.value })}
              />
            </label>
            <label className="eval-editor-field">
              <span>{l("Arguments", "参数")} · {l("one per line", "每行一个")}</span>
              <textarea
                value={(draft.commandArgs ?? []).join("\n")}
                rows={3}
                spellCheck={false}
                disabled={managed}
                onChange={(event) => onChange({
                  ...draft,
                  // Split on newlines rather than spaces: an argument may contain
                  // a space, and quoting rules here would be a second thing to
                  // learn for no benefit.
                  commandArgs: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                })}
              />
            </label>
          </div>
        </>
      )}
    </>
  );
}
