import { useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronRight, ExternalLink, FileOutput, FileText } from "lucide-react";

import type { EvaluationCaseResult } from "../../../../automation/contracts";
import { localize, type LanguageMode } from "../../language";

/**
 * What a case produced.
 *
 * A score without the thing it scored is unauditable: the only way to disagree
 * with a judge is to read the answer it read. So the artifact is shown next to
 * the verdicts — where it came from, the answer text, and which files the run
 * touched.
 *
 * The file list is an observation and is labelled as one. An absent list means
 * "not observed" rather than "nothing was touched", and the two must not look the
 * same, because a judge that never saw a file is a gap in the evaluation while a
 * run that wrote nothing may be the correct outcome.
 */

const PREVIEW_LIMIT = 400;

const STATUS_LABELS: Record<string, [string, string]> = {
  added: ["added", "新增"],
  modified: ["changed", "修改"],
  deleted: ["deleted", "删除"],
};

const ORIGIN_LABELS: Record<string, [string, string]> = {
  agent_run: ["fresh run", "新跑一次"],
  session: ["stored session", "已有会话"],
  folder: ["folder on disk", "磁盘目录"],
};

export function EvalCaseArtifact({
  language,
  result,
  onOpenSession,
}: {
  language: LanguageMode;
  result: EvaluationCaseResult;
  onOpenSession?: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [open, setOpen] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const artifact = result.artifact;
  const output = result.output ?? "";
  const long = output.length > PREVIEW_LIMIT;
  const shown = open || !long ? output : `${output.slice(0, PREVIEW_LIMIT)}…`;
  const reference = artifact?.origin.reference;
  const sessionKey = artifact?.origin.kind === "folder" ? undefined : reference ?? result.sessionKey;

  const openFile = async (): Promise<void> => {
    setOpeningFile(true);
    setFileError(null);
    try {
      await window.sessionSearch.automation.openEvaluationArtifactFile(result.runId, result.id);
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningFile(false);
    }
  };

  return (
    <section className="eval-artifact">
      <header>
        <FileText size={12} />
        <span className="eval-artifact-title">{l("Produced", "产物")}</span>
        {artifact ? (
          <span className="eval-badge eval-badge-dim">
            {localize(language, ...(ORIGIN_LABELS[artifact.origin.kind] ?? ["unknown", "未知"]))}
          </span>
        ) : null}
        {reference ? (
          <span className="eval-artifact-origin" title={reference}>{reference}</span>
        ) : null}
        {sessionKey && onOpenSession ? (
          <button
            type="button"
            className="eval-trigger-session"
            onClick={() => onOpenSession(sessionKey)}
          >
            <ExternalLink size={11} />{l("Session", "会话")}
          </button>
        ) : null}
        {output.trim() ? (
          <button
            type="button"
            className="eval-artifact-open"
            aria-label={l("Open artifact file", "打开产物文件")}
            title={l(
              "Save the exact judged answer as Markdown and open it with the system app.",
              "将评判时读取的原始答案保存为 Markdown，并用系统默认应用打开。",
            )}
            disabled={openingFile}
            onClick={() => void openFile()}
          >
            <FileOutput size={11} />
            {openingFile ? l("Opening...", "正在打开…") : l("Open file", "打开文件")}
          </button>
        ) : null}
      </header>
      {fileError ? <p className="eval-error" role="alert">{fileError}</p> : null}
      {output.trim() ? (
        <>
          <pre className="eval-artifact-output">{shown}</pre>
          {long ? (
            <button
              type="button"
              className="eval-artifact-more"
              onClick={() => setOpen(!open)}
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {open
                ? l("Show less", "收起")
                : l(`Show all ${output.length} characters`, `展开全部 ${output.length} 字`)}
            </button>
          ) : null}
        </>
      ) : (
        <p className="eval-muted">
          {l(
            "No answer text. A judge that reads the answer reports this as undecidable.",
            "没有答案文本。读答案的判定会记为无法判定。",
          )}
        </p>
      )}
      {artifact?.files?.length ? (
        <ul className="eval-artifact-files">
          {artifact.files.map((file) => (
            <li key={file.path} className={`eval-artifact-file is-${file.status}`}>
              <span className="eval-artifact-file-path" title={file.path}>{file.path}</span>
              <span className="eval-artifact-file-status">
                {localize(language, ...(STATUS_LABELS[file.status] ?? ["touched", "变更"]))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="eval-muted">
          {/*
            Said in full because the short version — "no files" — is a different
            claim, and the one AgentRecall cannot make.
          */}
          {l(
            "No file changes were observed. Writes AgentRecall does not recognise, such as a shell redirect, are not reported.",
            "没有观察到文件变更。AgentRecall 不认识的写入方式（例如 shell 重定向）不会被记录。",
          )}
        </p>
      )}
    </section>
  );
}
