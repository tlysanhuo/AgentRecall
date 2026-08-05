import {
  Activity,
  AlertTriangle,
  Bot,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  CodexObservationEventSummary,
  CodexObservationLiveUpdate,
  CodexObservationSession,
  CodexObservationSessionDetail,
  CodexObservationTurn,
} from "../../../../shared/codex-observation";
import { localize, type LanguageMode } from "../../language";
import { CodexObservationInspector, formatBytes } from "./codex-observation-inspector";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

interface NewSessionDraft {
  workDir: string;
  modelId: string;
  reasoningEffort: "" | ReasoningEffort;
}

export function CodexObservationPage({ language }: { language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const [sessions, setSessions] = useState<CodexObservationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<CodexObservationSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<NewSessionDraft | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [liveUpdate, setLiveUpdate] = useState<CodexObservationLiveUpdate | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await window.sessionSearch.getCodexObservationSession(id);
      if (selectedIdRef.current === id) setDetail(next);
    } catch (cause) {
      if (selectedIdRef.current === id) {
        setDetail(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  const loadSessions = useCallback(async (preferredId?: string): Promise<void> => {
    setError(null);
    try {
      const next = await window.sessionSearch.listCodexObservationSessions();
      setSessions(next);
      const current = preferredId ?? selectedIdRef.current;
      const nextId = current && next.some((session) => session.id === current)
        ? current
        : next[0]?.id ?? null;
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      if (nextId) await loadDetail(nextId);
      else setDetail(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [loadDetail]);

  useEffect(() => {
    void loadSessions();
    return window.sessionSearch.onCodexObservationUpdate((update) => {
      setLiveUpdate(update);
      if (update.kind === "delta" && update.sessionId === selectedIdRef.current && update.turnId && update.delta) {
        setDetail((current) => current ? {
          ...current,
          turns: current.turns.map((turn) => turn.id === update.turnId
            ? { ...turn, assistantText: `${turn.assistantText}${update.delta}` }
            : turn),
        } : current);
        return;
      }
      if (update.kind === "session" || update.kind === "approval") {
        void loadSessions(update.sessionId === selectedIdRef.current ? update.sessionId : undefined);
      }
    });
  }, [loadSessions]);

  const selectSession = useCallback((id: string): void => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setError(null);
    void loadDetail(id);
  }, [loadDetail]);

  async function chooseNewSessionDirectory(): Promise<void> {
    setError(null);
    try {
      const workDir = await window.sessionSearch.chooseCodexObservationDirectory();
      if (workDir) setDraft({ workDir, modelId: "", reasoningEffort: "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function createSession(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await window.sessionSearch.createCodexObservationSession({
        workDir: draft.workDir,
        modelId: draft.modelId.trim() || null,
        reasoningEffort: draft.reasoningEffort || null,
      });
      setDraft(null);
      await loadSessions(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!detail || !prompt.trim() || busy || activeTurn(detail)) return;
    const value = prompt;
    setPrompt("");
    setBusy(true);
    setError(null);
    try {
      await window.sessionSearch.sendCodexObservationMessage(detail.session.id, value);
      await loadSessions(detail.session.id);
    } catch (cause) {
      setPrompt(value);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelTurn(): Promise<void> {
    if (!detail || busy) return;
    setBusy(true);
    try {
      await window.sessionSearch.cancelCodexObservationTurn(detail.session.id);
      await loadSessions(detail.session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function stopSession(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.sessionSearch.stopCodexObservationSession(id);
      await loadSessions(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(session: CodexObservationSession): Promise<void> {
    const confirmed = window.confirm(l(
      `Delete “${session.title}” and its local observation records permanently? The original Codex rollout is retained.`,
      `永久删除“${session.title}”及其本地观测记录？Codex 原始 rollout 会保留。`,
    ));
    if (!confirmed || busy) return;
    setBusy(true);
    try {
      await window.sessionSearch.deleteCodexObservationSession(session.id);
      await loadSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(session: CodexObservationSession): Promise<void> {
    const title = renameTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await window.sessionSearch.renameCodexObservationSession(session.id, title);
      setRenaming(null);
      await loadSessions(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resolveApproval(decision: "approved" | "rejected"): Promise<void> {
    if (!detail?.pendingApproval || busy) return;
    setBusy(true);
    try {
      await window.sessionSearch.resolveCodexObservationApproval({
        sessionId: detail.session.id,
        requestId: detail.pendingApproval.requestId,
        decision,
      });
      await loadSessions(detail.session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const current = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  const runningTurn = detail ? activeTurn(detail) : null;

  return (
    <div className="codex-observation-page">
      <aside className="codex-observation-sidebar">
        <header>
          <div>
            <span className="codex-observation-eyebrow">Codex</span>
            <h2>{l("Observe", "观测")}</h2>
          </div>
          <button
            type="button"
            className="codex-observation-icon-button"
            onClick={() => void chooseNewSessionDirectory()}
            title={l("New observation", "新建观测")}
          ><Plus size={16} /></button>
        </header>
        <p className="codex-observation-privacy">
          <ShieldCheck size={14} />
          {l(
            "Only conversations started here are recorded. Records stay on this device.",
            "只记录从这里启动的对话，数据保存在本机。",
          )}
        </p>
        {draft ? (
          <form className="codex-observation-new-form" onSubmit={(event) => void createSession(event)}>
            <header><strong>{l("New observation", "新建观测")}</strong><button type="button" onClick={() => setDraft(null)}><X size={13} /></button></header>
            <label>
              <span>{l("Directory", "目录")}</span>
              <div className="codex-observation-path"><FolderOpen size={13} /><span title={draft.workDir}>{draft.workDir}</span></div>
            </label>
            <label>
              <span>{l("Model override", "指定模型")}</span>
              <input value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} placeholder={l("Follow Codex", "跟随 Codex")} />
            </label>
            <label>
              <span>{l("Reasoning", "推理强度")}</span>
              <select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as NewSessionDraft["reasoningEffort"] })}>
                <option value="">{l("Follow Codex", "跟随 Codex")}</option>
                {(["low", "medium", "high", "xhigh", "max", "ultra"] as const).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <button type="submit" className="codex-observation-primary" disabled={busy}><Play size={13} />{l("Create", "创建")}</button>
          </form>
        ) : null}
        <div className="codex-observation-session-list">
          {loading ? <p className="codex-observation-empty">{l("Loading…", "加载中…")}</p> : null}
          {!loading && sessions.length === 0 ? (
            <div className="codex-observation-sidebar-empty">
              <Activity size={20} />
              <strong>{l("No observations yet", "还没有观测记录")}</strong>
              <button type="button" onClick={() => void chooseNewSessionDirectory()}><Plus size={13} />{l("Start one", "开始一次")}</button>
            </div>
          ) : null}
          {sessions.map((session) => (
            <article key={session.id} className={`codex-observation-session-row ${selectedId === session.id ? "active" : ""}`}>
              <button type="button" className="codex-observation-session-select" onClick={() => selectSession(session.id)}>
                <span className="codex-observation-session-title">{session.title}</span>
                <span className="codex-observation-session-badges">
                  <StatusBadge state={session.lifecycleState} language={language} />
                  <IntegrityBadge state={session.integrityState} language={language} />
                </span>
                <small>{baseName(session.workDir)} · {session.modelId || l("Codex default", "Codex 默认")}</small>
                <small>{formatTime(session.updatedAt, language)}</small>
              </button>
              <div className="codex-observation-session-actions">
                <button type="button" onClick={() => { setRenaming(session.id); setRenameTitle(session.title); }} title={l("Rename", "重命名")}><Pencil size={12} /></button>
                {(session.lifecycleState === "running" || session.lifecycleState === "awaiting_approval" || session.lifecycleState === "idle") ? (
                  <button type="button" onClick={() => void stopSession(session.id)} title={l("Stop", "停止")}><Square size={12} /></button>
                ) : null}
                <button type="button" onClick={() => void deleteSession(session)} title={l("Delete", "删除")}><Trash2 size={12} /></button>
              </div>
              {renaming === session.id ? (
                <form className="codex-observation-rename" onSubmit={(event) => { event.preventDefault(); void saveRename(session); }}>
                  <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
                  <button type="submit">{l("Save", "保存")}</button>
                  <button type="button" onClick={() => setRenaming(null)}><X size={12} /></button>
                </form>
              ) : null}
            </article>
          ))}
        </div>
      </aside>

      <section className="codex-observation-conversation">
        {error ? <p className="codex-observation-error" role="alert"><AlertTriangle size={14} />{error}</p> : null}
        {!current || !detail ? (
          <div className="codex-observation-welcome">
            <Activity size={28} />
            <h3>{l("A dedicated window into Codex", "一个专门观察 Codex 的窗口")}</h3>
            <p>{l(
              "Start a conversation here to preserve RPC, context, tools, Skills, approvals, usage, and rollout data together.",
              "从这里发起对话，把 RPC、上下文、工具、Skills、审批、用量和 rollout 一起完整记录下来。",
            )}</p>
          </div>
        ) : (
          <>
            <header className="codex-observation-conversation-head">
              <div>
                <h3>{detail.session.title}</h3>
                <p title={detail.session.workDir}>{detail.session.workDir}</p>
              </div>
              <div className="codex-observation-head-meta">
                <span>{detail.session.threadId ? `Thread ${shortId(detail.session.threadId)}` : l("Not started", "尚未启动")}</span>
                <span>{formatBytes(detail.recordBytes)}</span>
              </div>
            </header>
            <div className="codex-observation-turns">
              {detail.turns.length === 0 ? (
                <div className="codex-observation-first-prompt">
                  <Bot size={22} />
                  <strong>{l("Send the first prompt", "发送第一条提示词")}</strong>
                  <p>{l("AgentRecall starts a separate Codex app-server thread and records it from the first RPC message.", "AgentRecall 会启动独立的 Codex app-server thread，并从第一条 RPC 开始记录。")}</p>
                </div>
              ) : detail.turns.map((turn) => <ObservationTurnCard key={turn.id} turn={turn} language={language} />)}
            </div>
            {detail.pendingApproval ? (
              <section className="codex-observation-approval">
                <AlertTriangle size={16} />
                <div><strong>{l("Codex requests approval", "Codex 请求审批")}</strong><p>{detail.pendingApproval.content}</p></div>
                <button type="button" disabled={busy} onClick={() => void resolveApproval("rejected")}>{l("Reject", "拒绝")}</button>
                <button type="button" className="codex-observation-primary" disabled={busy} onClick={() => void resolveApproval("approved")}>{l("Approve once", "批准一次")}</button>
              </section>
            ) : null}
            <form className="codex-observation-composer" onSubmit={(event) => void sendMessage(event)}>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={runningTurn ? l("Codex is working…", "Codex 正在处理…") : l("Message Codex…", "给 Codex 发消息…")}
                disabled={Boolean(runningTurn)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {runningTurn ? (
                <button type="button" className="codex-observation-cancel" disabled={busy} onClick={() => void cancelTurn()}><Square size={14} />{l("Cancel", "取消")}</button>
              ) : (
                <button type="submit" className="codex-observation-primary" disabled={busy || !prompt.trim()}><Send size={14} />{l("Send", "发送")}</button>
              )}
            </form>
          </>
        )}
      </section>

      {detail ? <CodexObservationInspector detail={detail} language={language} liveUpdate={liveUpdate} /> : (
        <aside className="codex-observation-inspector codex-observation-inspector-empty">
          <Activity size={22} /><span>{l("Select an observation", "选择一条观测记录")}</span>
        </aside>
      )}
    </div>
  );
}

function ObservationTurnCard({ turn, language }: { turn: CodexObservationTurn; language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  return (
    <article className="codex-observation-turn">
      <div className="codex-observation-message is-user">
        <span><UserRound size={13} />{l("You", "你")}</span>
        <p>{turn.prompt}</p>
      </div>
      <div className={`codex-observation-message is-assistant is-${turn.status}`}>
        <span><Bot size={13} />Codex <i>{turnStatus(turn.status, language)}</i></span>
        <p>{turn.assistantText || (turn.status === "running" ? l("Thinking…", "思考中…") : "—")}</p>
        {turn.error ? <small className="codex-observation-turn-error">{turn.error}</small> : null}
        {turn.usage ? <small className="codex-observation-usage">{formatUsage(turn.usage, language)}</small> : null}
      </div>
      <TurnEvents sessionId={turn.sessionId} turnId={turn.id} language={language} />
    </article>
  );
}

function TurnEvents({ sessionId, turnId, language }: { sessionId: string; turnId: string; language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const [events, setEvents] = useState<CodexObservationEventSummary[] | null>(null);
  return (
    <details
      className="codex-observation-turn-events"
      onToggle={(event) => {
        if (!event.currentTarget.open || events !== null) return;
        void window.sessionSearch.getCodexObservationEvents(sessionId, "timeline", 0, 200)
          .then((page) => setEvents(page.events.filter((item) => item.turnId === turnId)))
          .catch(() => setEvents([]));
      }}
    >
      <summary>{l("Turn timeline", "本轮时间线")}</summary>
      {events === null ? <p>{l("Open to load", "展开后加载")}</p> : events.length === 0 ? <p>{l("No derived events", "没有派生事件")}</p> : (
        <ol>{events.map((event) => <li key={event.seq}><span>#{event.seq}</span><strong>{event.kind}</strong><small>{event.preview}</small></li>)}</ol>
      )}
    </details>
  );
}

function StatusBadge({ state, language }: { state: CodexObservationSession["lifecycleState"]; language: LanguageMode }): ReactElement {
  const labels = {
    idle: localize(language, "Idle", "空闲"),
    running: localize(language, "Running", "运行中"),
    awaiting_approval: localize(language, "Approval", "待审批"),
    stopped: localize(language, "Stopped", "已停止"),
    error: localize(language, "Error", "异常"),
  };
  return <i className={`codex-observation-badge is-${state}`}>{labels[state]}</i>;
}

function IntegrityBadge({ state, language }: { state: CodexObservationSession["integrityState"]; language: LanguageMode }): ReactElement {
  const labels = {
    pending: localize(language, "Recording", "记录中"),
    complete: localize(language, "Complete", "完整"),
    incomplete: localize(language, "Incomplete", "不完整"),
  };
  return <i className={`codex-observation-badge is-${state}`}>{labels[state]}</i>;
}

function activeTurn(detail: CodexObservationSessionDetail): CodexObservationTurn | null {
  return detail.turns.find((turn) => turn.status === "running") ?? null;
}

function turnStatus(status: CodexObservationTurn["status"], language: LanguageMode): string {
  if (status === "running") return localize(language, "Running", "运行中");
  if (status === "completed") return localize(language, "Completed", "已完成");
  if (status === "cancelled") return localize(language, "Cancelled", "已取消");
  if (status === "interrupted") return localize(language, "Interrupted", "已中断");
  return localize(language, "Failed", "失败");
}

function formatUsage(usage: Record<string, number>, language: LanguageMode): string {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  return localize(
    language,
    `${input.toLocaleString()} input · ${output.toLocaleString()} output${reasoning ? ` · ${reasoning.toLocaleString()} reasoning` : ""}`,
    `输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()}${reasoning ? ` · 推理 ${reasoning.toLocaleString()}` : ""}`,
  );
}

function formatTime(value: string, language: LanguageMode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function baseName(value: string): string {
  return value.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || value;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
