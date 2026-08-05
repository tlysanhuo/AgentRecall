import { Check, Clipboard, Database, FileJson2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type {
  CodexObservationEventSummary,
  CodexObservationLiveUpdate,
  CodexObservationSessionDetail,
  CodexObservationStream,
} from "../../../../shared/codex-observation";
import { localize, type LanguageMode } from "../../language";

type InspectorTab = "context" | "timeline" | "raw";

export function CodexObservationInspector({
  detail,
  language,
  liveUpdate,
}: {
  detail: CodexObservationSessionDetail;
  language: LanguageMode;
  liveUpdate: CodexObservationLiveUpdate | null;
}): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const [tab, setTab] = useState<InspectorTab>("context");
  const [rawStream, setRawStream] = useState<Extract<CodexObservationStream, "rpc" | "rollout">>("rpc");
  const [events, setEvents] = useState<CodexObservationEventSummary[]>([]);
  const [nextAfterSeq, setNextAfterSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CodexObservationEventSummary | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const stream: CodexObservationStream = tab === "timeline" ? "timeline" : rawStream;

  const loadEvents = useCallback(async (reset: boolean): Promise<void> => {
    if (tab === "context") return;
    setLoading(true);
    setError(null);
    try {
      const afterSeq = reset ? 0 : nextAfterSeq ?? 0;
      const page = await window.sessionSearch.getCodexObservationEvents(
        detail.session.id,
        stream,
        afterSeq,
        100,
      );
      setEvents((current) => {
        if (reset) return page.events;
        return [
          ...current,
          ...page.events.filter((event) => !current.some((candidate) => candidate.seq === event.seq)),
        ].sort((left, right) => left.seq - right.seq);
      });
      setNextAfterSeq(page.nextAfterSeq);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [detail.session.id, nextAfterSeq, stream, tab]);

  useEffect(() => {
    setEvents([]);
    setNextAfterSeq(null);
    setSelectedEvent(null);
    setPayload(null);
    if (tab !== "context") void loadEvents(true);
    // Reset is keyed only by the selected source; pagination state must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.session.id, stream, tab]);

  useEffect(() => {
    const event = liveUpdate?.event;
    if (!event || liveUpdate?.sessionId !== detail.session.id || event.stream !== stream || tab === "context") return;
    setEvents((current) => current.some((candidate) => candidate.seq === event.seq)
      ? current
      : [...current, event].sort((left, right) => left.seq - right.seq));
  }, [detail.session.id, liveUpdate, stream, tab]);

  const readPayload = useCallback(async (event: CodexObservationEventSummary): Promise<void> => {
    setSelectedEvent(event);
    setPayload(null);
    setCopied(false);
    setPayloadLoading(true);
    try {
      setPayload(await window.sessionSearch.getCodexObservationPayload(
        detail.session.id,
        event.stream,
        event.seq,
      ));
    } catch (cause) {
      setPayload(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPayloadLoading(false);
    }
  }, [detail.session.id]);

  const toolsJson = useMemo(
    () => detail.context.tools.map((tool) => JSON.stringify(tool, null, 2)),
    [detail.context.tools],
  );

  return (
    <aside className="codex-observation-inspector">
      <header className="codex-observation-inspector-head">
        <div>
          <span className="codex-observation-eyebrow">Inspector</span>
          <strong>{l("Captured context", "捕获内容")}</strong>
        </div>
        <span className="codex-observation-size">{formatBytes(detail.recordBytes)}</span>
      </header>
      <nav className="codex-observation-inspector-tabs" aria-label={l("Observation detail", "观测详情")}>
        <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}>Context</button>
        <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>{l("Timeline", "时间线")}</button>
        <button className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>{l("Raw", "原始记录")}</button>
      </nav>

      {tab === "context" ? (
        <div className="codex-observation-inspector-body codex-observation-context">
          <ContextSummary detail={detail} language={language} toolsJson={toolsJson} />
        </div>
      ) : (
        <div className="codex-observation-inspector-body codex-observation-event-browser">
          {tab === "raw" ? (
            <div className="codex-observation-source-toggle">
              <button className={rawStream === "rpc" ? "active" : ""} onClick={() => setRawStream("rpc")}>RPC</button>
              <button className={rawStream === "rollout" ? "active" : ""} onClick={() => setRawStream("rollout")}>Rollout</button>
            </div>
          ) : null}
          {tab === "raw" ? (
            <p className="codex-observation-warning">
              <ShieldCheck size={13} />
              {l(
                "Credential-shaped fields are redacted. Tool output may still contain local source code or command data.",
                "凭据类字段已脱敏；工具输出仍可能包含本地源码或命令数据。",
              )}
            </p>
          ) : null}
          {error ? <p className="codex-observation-error" role="alert">{error}</p> : null}
          <div className="codex-observation-event-list">
            {events.map((event) => (
              <button
                type="button"
                key={`${event.stream}-${event.seq}`}
                className={selectedEvent?.seq === event.seq ? "active" : ""}
                onClick={() => void readPayload(event)}
              >
                <span className={`codex-observation-direction is-${event.direction}`}>{directionLabel(event.direction)}</span>
                <span className="codex-observation-event-main">
                  <strong>#{event.seq} · {event.method || event.kind}</strong>
                  <small>{event.preview}</small>
                </span>
                {event.redacted ? <ShieldCheck size={12} aria-label={l("Redacted", "已脱敏")} /> : null}
              </button>
            ))}
            {!loading && events.length === 0 ? (
              <p className="codex-observation-empty">{l("No captured events yet.", "暂时还没有记录。")}</p>
            ) : null}
          </div>
          {nextAfterSeq !== null ? (
            <button
              type="button"
              className="codex-observation-load-more"
              disabled={loading}
              onClick={() => void loadEvents(false)}
            >
              {loading ? l("Loading…", "加载中…") : l("Load more", "加载更多")}
            </button>
          ) : null}
          {selectedEvent ? (
            <section className="codex-observation-payload">
              <header>
                <span><FileJson2 size={13} /> #{selectedEvent.seq}</span>
                <button
                  type="button"
                  disabled={!payload || payloadLoading}
                  onClick={() => {
                    if (!payload) return;
                    void navigator.clipboard.writeText(payload).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1_500);
                    });
                  }}
                >
                  {copied ? <Check size={12} /> : <Clipboard size={12} />}
                  {copied ? l("Copied", "已复制") : l("Copy", "复制")}
                </button>
              </header>
              <pre>{payloadLoading ? l("Loading payload…", "正在读取载荷…") : payload}</pre>
            </section>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function ContextSummary({
  detail,
  language,
  toolsJson,
}: {
  detail: CodexObservationSessionDetail;
  language: LanguageMode;
  toolsJson: string[];
}): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const context = detail.context;
  if (context.status !== "available") {
    return (
      <div className="codex-observation-context-unavailable">
        <Database size={20} />
        <strong>{context.status === "pending" ? l("Waiting for rollout", "正在等待 rollout") : l("Rollout unavailable", "Rollout 不可用")}</strong>
        <p>{l(
          "RPC traffic remains visible. Context appears only when Codex exposes its local rollout file.",
          "RPC 流量仍可查看；只有 Codex 暴露本地 rollout 文件后，Context 才会出现。",
        )}</p>
      </div>
    );
  }
  return (
    <>
      <section className="codex-observation-context-meta">
        <dl>
          <div><dt>Codex</dt><dd>{context.codexVersion || "—"}</dd></div>
          <div><dt>Thread</dt><dd>{detail.session.threadId || "—"}</dd></div>
          <div><dt>{l("Turns", "轮次")}</dt><dd>{detail.turns.length}</dd></div>
          <div><dt>{l("Source", "源文件")}</dt><dd>{context.sourcePathAvailable ? l("Available", "可用") : l("Copied only", "仅副本")}</dd></div>
        </dl>
      </section>
      <ContextBlock title={l("System instructions", "系统提示词")} text={context.systemInstructions} />
      {context.developerInstructions.map((text, index) => (
        <ContextBlock
          key={`${index}-${text.slice(0, 32)}`}
          title={`${l("Developer instructions", "Developer 提示词")} #${index + 1}`}
          text={text}
        />
      ))}
      <ChipSection title={l("Available Skills", "可用 Skills")} items={context.availableSkills} empty={l("No catalog captured", "未捕获到清单")} />
      <ChipSection title={l("Used Skills", "已调用 Skills")} items={context.usedSkills} empty={l("No Skill call captured", "未捕获到 Skill 调用")} />
      <section className="codex-observation-context-section">
        <h4>{l("Tools", "工具")}</h4>
        {toolsJson.length > 0 ? toolsJson.map((tool, index) => <pre key={index}>{tool}</pre>) : (
          <p>{l("No dynamic tool definitions captured.", "未捕获到动态工具定义。")}</p>
        )}
      </section>
    </>
  );
}

function ContextBlock({ title, text }: { title: string; text: string }): ReactElement {
  return (
    <details className="codex-observation-context-section" open>
      <summary>{title}</summary>
      <pre>{text || "—"}</pre>
    </details>
  );
}

function ChipSection({ title, items, empty }: { title: string; items: string[]; empty: string }): ReactElement {
  return (
    <section className="codex-observation-context-section">
      <h4>{title}</h4>
      {items.length > 0 ? (
        <div className="codex-observation-chips">{items.map((item) => <span key={item}>{item}</span>)}</div>
      ) : <p>{empty}</p>}
    </section>
  );
}

function directionLabel(direction: CodexObservationEventSummary["direction"]): string {
  if (direction === "client_to_server") return "→";
  if (direction === "server_to_client") return "←";
  return "•";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
