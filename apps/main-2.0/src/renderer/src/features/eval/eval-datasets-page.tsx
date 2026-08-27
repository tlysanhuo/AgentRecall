import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Database, FolderInput, FolderOutput, Plus, Trash2, Upload } from "lucide-react";

import type {
  EvaluationDataset,
  EvaluationDatasetItem,
  EvaluationExperiment,
} from "../../../../automation/contracts";
import { DATASET_TEMPLATES } from "../../../../automation/engine/shared/evaluation-templates";
import { localize, type LanguageMode } from "../../language";
import { parseDatasetCases } from "./eval-case-import";

/**
 * Dataset authoring.
 *
 * The two things the previous workspace could not do are the two that decide
 * whether a dataset gets written at all: entering many cases at once, and
 * setting the `context` a judge reads. Both are first-class here.
 */

interface EditorCase {
  id: string;
  input: string;
  expectedOutput: string;
  context: string;
  metadata: Record<string, unknown>;
}

export function EvalDatasetsPage({
  language,
  onDirtyChange,
}: {
  language: LanguageMode;
  onDirtyChange?: (dirty: boolean) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [datasets, setDatasets] = useState<EvaluationDataset[] | null>(null);
  const [experiments, setExperiments] = useState<EvaluationExperiment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cases, setCases] = useState<EditorCase[]>([]);
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (keepId?: string) => {
    setError(null);
    try {
      const [nextDatasets, nextExperiments] = await Promise.all([
        window.sessionSearch.automation.listEvaluationDatasets(),
        window.sessionSearch.automation.listEvaluationExperiments(),
      ]);
      setDatasets(nextDatasets);
      setExperiments(nextExperiments);
      setSelectedId((current) => keepId ?? current ?? nextDatasets[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const selected = useMemo(
    () => datasets?.find((item) => item.id === selectedId) ?? null,
    [datasets, selectedId],
  );

  // Loading a different dataset replaces the draft; an unsaved edit is called
  // out before that happens rather than vanishing.
  useEffect(() => {
    if (!selected) {
      setName("");
      setDescription("");
      setCases([]);
      setDirty(false);
      return;
    }
    setName(selected.name);
    setDescription(selected.description);
    setCases(selected.items.map(toEditorCase));
    setDirty(false);
  }, [selected]);

  const usageOf = useCallback(
    (datasetId: string) => experiments.filter((item) => item.datasetId === datasetId),
    [experiments],
  );

  const createDataset = useCallback(async (
    input: { name: string; description: string; items: Array<Omit<EvaluationDatasetItem, "id" | "sequence">> },
  ) => {
    setError(null);
    try {
      const now = Date.now();
      const created = await window.sessionSearch.automation.saveEvaluationDataset({
        id: `dataset-${now}`,
        name: input.name,
        description: input.description,
        items: input.items.map((item, index) => ({
          ...item,
          id: `case-${now}-${index}`,
          sequence: index,
        })),
        createdAt: now,
        updatedAt: now,
      });
      await reload(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [reload]);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.sessionSearch.automation.saveEvaluationDataset({
        ...selected,
        name: name.trim() || selected.name,
        description: description.trim(),
        items: cases.map((item, index) => toDatasetItem(item, index)),
        updatedAt: Date.now(),
      });
      await reload(saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [cases, description, name, reload, selected]);

  const remove = useCallback(async () => {
    if (!selected) return;
    const used = usageOf(selected.id);
    const confirmed = window.confirm(used.length > 0
      ? l(
        `${used.length} experiment(s) use "${selected.name}". Delete it anyway?`,
        `有 ${used.length} 个实验正在使用「${selected.name}」，仍要删除吗？`,
      )
      : l(`Delete dataset "${selected.name}"?`, `删除数据集「${selected.name}」？`));
    if (!confirmed) return;
    setError(null);
    try {
      await window.sessionSearch.automation.deleteEvaluationDataset(selected.id);
      setSelectedId(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l, reload, selected, usageOf]);

  const importPreview = useMemo(() => parseDatasetCases(importText), [importText]);

  const applyImport = useCallback((mode: "append" | "replace") => {
    if (importPreview.cases.length === 0) {
      setImportErrors(importPreview.errors.length > 0 ? importPreview.errors : [l("Nothing to import.", "没有可导入的内容。")]);
      return;
    }
    const now = Date.now();
    const imported = importPreview.cases.map((item, index): EditorCase => ({
      id: `case-${now}-${index}`,
      input: item.input,
      expectedOutput: item.expectedOutput ?? "",
      context: item.context ?? "",
      metadata: {},
    }));
    setCases((current) => mode === "append" ? [...current, ...imported] : imported);
    setDirty(true);
    setImportErrors(importPreview.errors);
    setImportText("");
    setImporting(false);
  }, [importPreview, l]);

  const importFolder = useCallback(async () => {
    setError(null);
    setFolderNote(null);
    try {
      const result = await window.sessionSearch.automation.importEvaluationDatasetFolder();
      // Null means the picker was dismissed, which is not a failure to report.
      if (!result) return;
      setFolderNote(l(
        `Imported ${result.dataset.items.length} case(s) from ${result.directory}`,
        `已从 ${result.directory} 导入 ${result.dataset.items.length} 条用例`,
      ));
      // Unreadable case files are named rather than dropped, so a partial import
      // never looks complete.
      setImportErrors(result.errors);
      await reload(result.dataset.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l, reload]);

  const exportFolder = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setFolderNote(null);
    try {
      const result = await window.sessionSearch.automation
        .exportEvaluationDatasetFolder(selected.id);
      if (!result) return;
      setFolderNote(l(
        `Wrote ${result.caseCount} case file(s) to ${result.directory}`,
        `已把 ${result.caseCount} 个用例文件写入 ${result.directory}`,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l, selected]);

  const updateCase = useCallback((id: string, patch: Partial<EditorCase>) => {
    setCases((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setDirty(true);
  }, []);

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><Database size={14} /> {l("Datasets", "数据集")}</h4>
        <div className="eval-editor-actions">
          <button
            type="button"
            className="eval-run-button"
            onClick={() => void createDataset({
              name: l("Untitled dataset", "未命名数据集"),
              description: "",
              items: [{ input: "", metadata: {} }],
            })}
          >
            <Plus size={13} />{l("New dataset", "新建数据集")}
          </button>
          <select
            value=""
            onChange={(event) => {
              const template = DATASET_TEMPLATES.find((item) => item.id === event.target.value);
              if (template) {
                void createDataset({
                  name: template.name,
                  description: template.description,
                  items: template.items,
                });
              }
            }}
          >
            <option value="">{l("From template...", "从模板创建...")}</option>
            {DATASET_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.items.length}
              </option>
            ))}
          </select>
          <button type="button" className="eval-icon-button" onClick={() => void importFolder()}>
            <FolderInput size={12} />{l("Import folder", "导入文件夹")}
          </button>
          <button
            type="button"
            className="eval-icon-button"
            disabled={!selected}
            onClick={() => void exportFolder()}
          >
            <FolderOutput size={12} />{l("Export folder", "导出文件夹")}
          </button>
        </div>
      </header>
      <p className="eval-muted">
        {l(
          "A dataset folder holds dataset.md for the overview and cases/*.json for one case each, so both a person and an agent can read and edit it in place. Importing the same folder again updates the same dataset.",
          "数据集文件夹用 dataset.md 写总览、cases/*.json 每个文件一条用例，人和 AI 都能直接读写。再次导入同一个文件夹会更新同一个数据集。",
        )}
      </p>
      {folderNote ? <p className="eval-muted">{folderNote}</p> : null}
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <div className="eval-graph-body">
        <ul className="eval-graph-run-list">
          {datasets === null ? (
            <li className="eval-muted">{l("Loading...", "加载中...")}</li>
          ) : datasets.length === 0 ? (
            <li className="eval-muted">{l("No datasets yet.", "还没有数据集。")}</li>
          ) : datasets.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`eval-graph-run-row ${item.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="eval-graph-run-name">{item.name}</span>
                <span className="eval-graph-run-meta">
                  <span className="eval-muted">
                    {l(`${item.items.length} cases`, `${item.items.length} 条用例`)}
                  </span>
                  {usageOf(item.id).length > 0 ? (
                    <span className="eval-badge eval-badge-dim">
                      {l(`used by ${usageOf(item.id).length}`, `被 ${usageOf(item.id).length} 个实验使用`)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="eval-graph-detail">
          {!selected ? (
            <p className="eval-muted">{l("Select a dataset.", "选择一个数据集。")}</p>
          ) : (
            <>
              <div className="eval-dataset-meta">
                <label className="eval-editor-field">
                  <span>{l("Name", "名称")}</span>
                  <input
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <label className="eval-editor-field">
                  <span>{l("Description", "说明")}</span>
                  <input
                    value={description}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <div className="eval-editor-actions">
                  <button type="button" className="eval-run-button" disabled={saving || !dirty} onClick={() => void save()}>
                    {saving ? l("Saving...", "保存中...") : dirty ? l("Save", "保存") : l("Saved", "已保存")}
                  </button>
                  <button type="button" className="eval-icon-button" onClick={() => setImporting((value) => !value)}>
                    <Upload size={12} />{l("Paste cases", "批量粘贴")}
                  </button>
                  <button type="button" className="eval-icon-button" onClick={() => void remove()}>
                    <Trash2 size={12} />{l("Delete", "删除")}
                  </button>
                </div>
              </div>
              {importing ? (
                <div className="eval-dataset-import">
                  <p className="eval-muted">
                    {l(
                      "Paste a JSON array, or one case per line with tab-separated input, expected output and context.",
                      "支持粘贴 JSON 数组，或每行一条、用制表符分隔的「输入 / 期望输出 / 上下文」。",
                    )}
                  </p>
                  <textarea
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    rows={6}
                    placeholder={'[{"input": "...", "expectedOutput": "..."}]'}
                  />
                  <div className="eval-editor-actions">
                    <span className="eval-muted">
                      {importPreview.cases.length > 0
                        ? l(`${importPreview.cases.length} cases detected`, `识别到 ${importPreview.cases.length} 条用例`)
                        : l("nothing detected yet", "尚未识别到用例")}
                    </span>
                    <button
                      type="button"
                      className="eval-run-button"
                      disabled={importPreview.cases.length === 0}
                      onClick={() => applyImport("append")}
                    >
                      {l("Append", "追加")}
                    </button>
                    <button
                      type="button"
                      className="eval-icon-button"
                      disabled={importPreview.cases.length === 0}
                      onClick={() => applyImport("replace")}
                    >
                      {l("Replace all", "整体替换")}
                    </button>
                  </div>
                  {importPreview.errors.length > 0 ? (
                    <ul className="eval-dataset-import-errors">
                      {importPreview.errors.map((message) => <li key={message}>{message}</li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {importErrors.length > 0 ? (
                <ul className="eval-dataset-import-errors">
                  {importErrors.map((message) => <li key={message}>{message}</li>)}
                </ul>
              ) : null}
              <ol className="eval-dataset-cases">
                {cases.map((item, index) => (
                  <li key={item.id}>
                    <header>
                      <span className="eval-graph-case-title">{l(`Case ${index + 1}`, `用例 ${index + 1}`)}</span>
                      <button
                        type="button"
                        className="eval-icon-button"
                        onClick={() => {
                          setCases((current) => current.filter((entry) => entry.id !== item.id));
                          setDirty(true);
                        }}
                        aria-label={l("Remove case", "删除用例")}
                      >
                        <Trash2 size={11} />
                      </button>
                    </header>
                    <label className="eval-editor-field">
                      <span>{l("Input", "输入")}</span>
                      <textarea
                        value={item.input}
                        rows={2}
                        onChange={(event) => updateCase(item.id, { input: event.target.value })}
                      />
                    </label>
                    <label className="eval-editor-field">
                      <span>{l("Expected output", "期望输出")}</span>
                      <textarea
                        value={item.expectedOutput}
                        rows={2}
                        placeholder={l("optional; needed by exact match and contains", "可选；精确匹配与包含判定需要它")}
                        onChange={(event) => updateCase(item.id, { expectedOutput: event.target.value })}
                      />
                    </label>
                    <label className="eval-editor-field">
                      <span>{l("Context for judges", "评判上下文")}</span>
                      <textarea
                        value={item.context}
                        rows={2}
                        placeholder={l("optional; handed to LLM judges", "可选；会随任务交给模型评判器")}
                        onChange={(event) => updateCase(item.id, { context: event.target.value })}
                      />
                    </label>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="eval-icon-button"
                onClick={() => {
                  setCases((current) => [...current, {
                    id: `case-${Date.now()}-${current.length}`,
                    input: "",
                    expectedOutput: "",
                    context: "",
                    metadata: {},
                  }]);
                  setDirty(true);
                }}
              >
                <Plus size={12} />{l("Add case", "添加用例")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function toEditorCase(item: EvaluationDatasetItem): EditorCase {
  const { context: _context, ...metadata } = item.metadata;
  return {
    id: item.id,
    input: item.input,
    expectedOutput: item.expectedOutput ?? "",
    context: typeof item.metadata.context === "string" ? item.metadata.context : "",
    // Metadata a template or an import carried travels back out untouched.
    metadata,
  };
}

function toDatasetItem(item: EditorCase, index: number): EvaluationDatasetItem {
  const context = item.context.trim();
  return {
    id: item.id,
    input: item.input,
    ...(item.expectedOutput.trim() ? { expectedOutput: item.expectedOutput } : {}),
    metadata: { ...item.metadata, ...(context ? { context } : {}) },
    sequence: index,
  };
}
