import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import type {
  EvaluationJudgeScript,
  EvaluationJudgeScriptInput,
  EvaluationJudgeScriptVerdict,
} from "./nodes/contracts";

/**
 * Runs judges the user wrote, so a rubric that is easier to express as code than
 * as a prompt does not need a model at all.
 *
 * Two modes, two different trust stories:
 *
 * - **Inline JS** runs in a fresh `node:vm` context with the subject and nothing
 *   else — no `require`, no `process`, no filesystem, no network. A judge is
 *   supposed to look at the artifact, and taking capabilities away is what makes
 *   it safe to paste one in from anywhere.
 * - **A command** is a real process and can do anything the user can, so it stays
 *   behind a setting that is off until it is turned on. When it is off the judge
 *   is *excused* and says so, rather than disappearing from the report.
 *
 * Every failure path here rejects. That is the contract the judge nodes rely on:
 * a script that throws, times out, exits non-zero or prints something that is not
 * a verdict has learned nothing about the agent, and the node turns the rejection
 * into `excused: judge_failure` instead of a zero.
 */

const DEFAULT_INLINE_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Enough of a script's own logging to explain a failure, not enough to flood a row. */
const MAX_CAPTURED_LOG = 2_000;

export interface JudgeScriptRunnerOptions {
  /**
   * Whether spawning a command judge is allowed. Off by default because a
   * command runs unsandboxed with the user's own privileges.
   */
  commandsEnabled?: () => boolean;
  /** Working directory for command judges when the script does not name one. */
  defaultCwd?: string;
  /** Injected so tests do not spawn processes. */
  spawnCommand?: typeof spawn;
}

export type JudgeScriptRunner = (
  input: EvaluationJudgeScriptInput,
) => Promise<{ verdicts: EvaluationJudgeScriptVerdict[]; durationMs: number }>;

export function createJudgeScriptRunner(
  options: JudgeScriptRunnerOptions = {},
): JudgeScriptRunner {
  return async (input) => {
    const startedAt = Date.now();
    const raw = input.script.mode === "command"
      ? await runCommandJudge(input, options)
      : await runInlineJudge(input);
    return { verdicts: normalizeJudgeScriptResult(raw), durationMs: Date.now() - startedAt };
  };
}

function timeoutFor(script: EvaluationJudgeScript, fallback: number): number {
  const requested = script.timeoutMs;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/** The subject, in the shape both modes hand to the script. */
function judgeSubject(input: EvaluationJudgeScriptInput): {
  task: unknown;
  artifact: unknown;
  trajectory: unknown;
} {
  return {
    task: structuredClone(input.task),
    artifact: input.artifact ? structuredClone(input.artifact) : null,
    trajectory: input.trajectory ? structuredClone(input.trajectory) : null,
  };
}

class JudgeScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`script_timed_out_after_${timeoutMs}ms`);
    this.name = "JudgeScriptTimeoutError";
  }
}

async function runInlineJudge(input: EvaluationJudgeScriptInput): Promise<unknown> {
  if (input.script.mode !== "inline_js") throw new Error("Expected an inline script.");
  const source = input.script.source.trim();
  if (!source) throw new Error("script_is_empty");
  throwIfAborted(input.signal);

  const timeoutMs = timeoutFor(input.script, DEFAULT_INLINE_TIMEOUT_MS);
  const subject = judgeSubject(input);
  const logs: string[] = [];
  const capture = (...parts: unknown[]) => {
    if (logs.join("").length < MAX_CAPTURED_LOG) {
      logs.push(parts.map((part) => (typeof part === "string" ? part : safeStringify(part))).join(" "));
    }
  };

  let result: unknown;
  try {
    result = runInNewContext(
      // A bare `return` is what a judge naturally writes, so the source becomes a
      // function body rather than an expression.
      `"use strict"; (function (task, artifact, trajectory) {\n${source}\n})(task, artifact, trajectory)`,
      {
        ...subject,
        console: { log: capture, warn: capture, error: capture, info: capture, debug: capture },
        JSON,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Date,
        RegExp,
        Map,
        Set,
        Error,
        isNaN,
        isFinite,
        parseInt,
        parseFloat,
      },
      {
        timeout: timeoutMs,
        // A judge has no business generating more code, and the timeout above
        // cannot interrupt an eval'd loop the way it interrupts this one.
        contextCodeGeneration: { strings: false, wasm: false },
      },
    );
  } catch (cause) {
    throw withLogs(cause, logs);
  }

  // The vm timeout only covers synchronous execution; an async judge needs its own.
  if (!isPromiseLike(result)) return result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new JudgeScriptTimeoutError(timeoutMs)), timeoutMs);
      }),
      abortPromise(input.signal),
    ]);
  } catch (cause) {
    throw withLogs(cause, logs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCommandJudge(
  input: EvaluationJudgeScriptInput,
  options: JudgeScriptRunnerOptions,
): Promise<unknown> {
  if (input.script.mode !== "command") throw new Error("Expected a command script.");
  const command = input.script.command.trim();
  if (!command) throw new Error("script_command_is_empty");
  if (options.commandsEnabled && !options.commandsEnabled()) {
    throw new Error("script_commands_not_enabled");
  }
  throwIfAborted(input.signal);

  const timeoutMs = timeoutFor(input.script, DEFAULT_COMMAND_TIMEOUT_MS);
  const spawnCommand = options.spawnCommand ?? spawn;
  const cwd = input.script.cwd ?? options.defaultCwd;
  const args = input.script.args ?? [];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnCommand(command, args, {
      ...(cwd ? { cwd } : {}),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let spawnError: Error | undefined;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) {
        reject(new JudgeScriptTimeoutError(timeoutMs));
        return;
      }
      if (input.signal?.aborted) {
        reject(new Error("script_aborted"));
        return;
      }
      if (spawnError) {
        reject(new Error(`script_command_failed: ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `script_command_exited_${code}${err.trim() ? `: ${err.trim().slice(0, MAX_CAPTURED_LOG)}` : ""}`,
        ));
        return;
      }
      resolve(out);
    });

    // The subject goes in on stdin, so a judge never has to be told where to
    // find it and the same script works for any case.
    try {
      child.stdin?.end(`${JSON.stringify(judgeSubject(input))}\n`);
    } catch (cause) {
      cleanup();
      child.kill("SIGKILL");
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });

  const block = stdout.trim();
  if (!block) throw new Error("script_command_printed_nothing");
  try {
    return JSON.parse(lastJsonBlock(block));
  } catch {
    throw new Error("script_command_output_not_json");
  }
}

/**
 * Reads whatever the script returned as verdicts.
 *
 * A number, one object, or a list of objects are all accepted — the strictest
 * form is not worth the friction, and a judge that returns `0.8` means one thing
 * only. Anything else rejects, so a script that returns `undefined` because a
 * branch forgot to return is a judge failure rather than a silent zero.
 */
export function normalizeJudgeScriptResult(value: unknown): EvaluationJudgeScriptVerdict[] {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) throw new Error("script_returned_no_verdict");
  return items.map((item) => {
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("script_score_is_not_a_number");
      return { score: item };
    }
    if (!item || typeof item !== "object") throw new Error("script_returned_no_verdict");
    const record = item as Record<string, unknown>;
    const score = Number(record.score ?? record.value);
    if (!Number.isFinite(score)) throw new Error("script_score_is_not_a_number");
    return {
      score,
      ...(typeof record.dimension === "string" && record.dimension.trim()
        ? { dimension: record.dimension.trim() }
        : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(stringList(record.evidence) ? { evidence: stringList(record.evidence)! } : {}),
      ...(stringList(record.failedCriteria)
        ? { failedCriteria: stringList(record.failedCriteria)! }
        : {}),
    };
  });
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * The last JSON object or array in the output.
 *
 * A command judge often prints progress before its result, and taking the last
 * block means that noise does not have to be suppressed to get a verdict.
 */
function lastJsonBlock(output: string): string {
  const closing = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
  if (closing < 0) return output;
  const opener = output[closing] === "}" ? "{" : "[";
  const opening = output.indexOf(opener);
  return opening >= 0 && opening < closing ? output.slice(opening, closing + 1) : output;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("script_aborted");
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => reject(new Error("script_aborted")), { once: true });
  });
}

/** Puts the script's own logging into the failure, which is where it is read. */
function withLogs(cause: unknown, logs: string[]): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const tail = logs.join("\n").slice(-MAX_CAPTURED_LOG).trim();
  return new Error(tail ? `${message}\n${tail}` : message);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
