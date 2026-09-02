import type { ReactElement } from "react";

import { localize, type LanguageMode } from "../../language";

/**
 * One dimension, as a card.
 *
 * A dimension is the unit an evaluation is read in: it carries its own score, and
 * dimensions combine by weight rather than by counting checks. So the card is what
 * the ring and the trend belong to.
 *
 * Three readings, kept apart by colour the same way step statuses are: met (green),
 * unmet (red), and nothing decided (grey). The last one matters most — a dimension
 * whose judge could not decide has no score, and painting that red would blame the
 * model for the evaluation's own gap.
 */

const RING_SIZE = 54;
const RING_STROKE = 5;
const TREND_SLOTS = 6;

export interface DimensionCardData {
  dimension: string;
  /** Weighted mean of this dimension's checks; null when nothing was decided. */
  score: number | null;
  weight: number;
  priority?: "must" | "should";
  /** Score a check in this dimension has to reach. */
  threshold?: number;
  /** How this dimension decides, in words: "LLM"、"脚本"、"LLM · 脚本 2 条". */
  method?: string;
  /** Oldest first; a null score means this run decided nothing. */
  trend?: Array<{ score: number | null; startedAt?: number }>;
}

export function EvalDimensionCard({
  language,
  data,
  selected,
  onClick,
}: {
  language: LanguageMode;
  data: DimensionCardData;
  selected?: boolean;
  onClick?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const state = dimensionState(data);
  const body = (
    <>
      <header>
        <span className="eval-dimension-card-name">{data.dimension}</span>
        {data.priority ? (
          <span className={`eval-dimension-priority is-${data.priority}`}>
            {data.priority === "must" ? l("must", "必须") : l("should", "应该")}
          </span>
        ) : null}
        {data.weight !== 1 ? (
          <span
            className="eval-dimension-card-weight"
            title={l(
              `Counts ${data.weight} times when dimensions are combined into the total score.`,
              `汇总总分时按普通维度的 ${data.weight} 倍计入。`,
            )}
          >
            {l(`weight ${data.weight}`, `权重 ${data.weight}`)}
          </span>
        ) : null}
      </header>
      <ScoreRing score={data.score} state={state} />
      <span className="eval-dimension-card-method">
        {data.score === null
          ? l("not decided", "未判定")
          : data.method ?? l("judged", "已判定")}
      </span>
      {data.trend ? (
        <Trend
          language={language}
          trend={data.trend}
          threshold={data.threshold ?? 0.6}
        />
      ) : null}
    </>
  );
  const className = `eval-dimension-card is-${state} ${selected ? "is-selected" : ""}`;
  return onClick
    ? (
      <button
        type="button"
        className={className}
        aria-pressed={selected ?? false}
        onClick={onClick}
      >
        {body}
      </button>
    )
    : <div className={className}>{body}</div>;
}

/** met / unmet / undecided — the three things a dimension can be. */
export function dimensionState(data: DimensionCardData): "met" | "unmet" | "undecided" {
  if (data.score === null) return "undecided";
  return data.score >= (data.threshold ?? 0.6) ? "met" : "unmet";
}

function ScoreRing({
  score,
  state,
}: {
  score: number | null;
  state: "met" | "unmet" | "undecided";
}): ReactElement {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      className="eval-dimension-ring"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle
        className="eval-dimension-ring-track"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        strokeWidth={RING_STROKE}
      />
      {/*
        No arc at all when nothing was decided: a zero-length arc would read as a
        score of zero, which is the one thing an undecided dimension is not.
      */}
      {score === null ? null : (
        <circle
          className="eval-dimension-ring-value"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          strokeWidth={RING_STROKE}
          strokeDasharray={`${circumference * Math.max(0, Math.min(1, score))} ${circumference}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      )}
      <text className="eval-dimension-ring-text" x="50%" y="50%" data-state={state}>
        {score === null ? "—" : score.toFixed(2).replace(/^0/, "")}
      </text>
    </svg>
  );
}

/**
 * The last few runs of this dimension.
 *
 * A run in which the dimension decided nothing gets an empty slot rather than
 * being skipped: dropping it would slide an older score into its place and read as
 * "it scored low then", when in fact it was never judged.
 */
function Trend({
  language,
  trend,
  threshold,
}: {
  language: LanguageMode;
  trend: ReadonlyArray<{ score: number | null; startedAt?: number }>;
  threshold: number;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const slots = trend.slice(-TREND_SLOTS);
  const padding = Array.from<{ score: number | null; startedAt?: number } | undefined>({
    length: Math.max(0, TREND_SLOTS - slots.length),
  });
  return (
    <div className="eval-dimension-trend-block">
      <span className="eval-dimension-trend-label">{l("Last 6 runs", "最近 6 次运行")}</span>
      <ul className="eval-dimension-trend" aria-label={l("Scores from the last 6 runs", "最近 6 次运行得分")}>
        {[...padding, ...slots].map((point, index) => {
          const score = point?.score;
          const state = score === null || score === undefined
            ? "empty"
            : score >= threshold ? "met" : "unmet";
          let title: string;
          if (point === undefined) {
            title = l("No earlier run", "暂无更早运行");
          } else if (point.score === null) {
            title = `${formatTrendTime(language, point.startedAt)} · ${l("not decided", "未判定")}`;
          } else {
            title = `${formatTrendTime(language, point.startedAt)} · ${l("score", "得分")} ${point.score.toFixed(2)} · ${state === "met" ? l("met", "达标") : l("unmet", "未达标")}`;
          }
          return (
            <li key={index} className={`is-${state}`} title={title}>
              <span
                style={score === null || score === undefined
                  ? undefined
                  : { height: `${Math.max(6, Math.min(100, score * 100))}%` }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatTrendTime(language: LanguageMode, startedAt?: number): string {
  if (startedAt === undefined) return localize(language, "run", "该次运行");
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startedAt);
}
