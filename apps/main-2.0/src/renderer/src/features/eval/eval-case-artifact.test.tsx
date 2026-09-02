// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationCaseResult } from "../../../../automation/contracts";
import { EvalCaseArtifact } from "./eval-case-artifact";

const openEvaluationArtifactFile = vi.fn();

/**
 * The artifact is what makes a score arguable, so what these tests pin down is
 * the honesty of it: an unobserved file list must not read as an empty one, and an
 * answer that came back empty must say so rather than showing a blank box.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  openEvaluationArtifactFile.mockReset().mockResolvedValue("/tmp/case.md");
  Object.assign(window, {
    sessionSearch: {
      automation: { openEvaluationArtifactFile },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function result(overrides: Partial<EvaluationCaseResult> = {}): EvaluationCaseResult {
  return {
    id: "case-1",
    runId: "run-1",
    datasetItemId: "item-1",
    repetition: 1,
    input: "fix the bug",
    output: "done",
    durationMs: 10,
    scores: [],
    ...overrides,
  };
}

async function render(
  value: EvaluationCaseResult,
  onOpenSession?: (key: string) => void,
): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalCaseArtifact, {
      language: "zh",
      result: value,
      ...(onOpenSession ? { onOpenSession } : {}),
    }));
  });
}

describe("EvalCaseArtifact", () => {
  it("shows the answer, where it came from, and the files it touched", async () => {
    await render(result({
      artifact: {
        origin: { kind: "agent_run", reference: "claude:thread-9" },
        files: [
          { path: "src/a.ts", status: "added" },
          { path: "src/b.ts", status: "modified" },
          { path: "src/c.ts", status: "deleted" },
        ],
      },
    }));

    expect(container.querySelector(".eval-artifact-output")?.textContent).toBe("done");
    expect(container.textContent).toContain("新跑一次");
    expect(container.textContent).toContain("claude:thread-9");
    const files = [...container.querySelectorAll(".eval-artifact-file")];
    expect(files.map((file) => file.className.split("is-")[1])).toEqual([
      "added",
      "modified",
      "deleted",
    ]);
    expect(files[0]!.textContent).toContain("src/a.ts");
  });

  it("says a file list was never observed rather than saying there were none", async () => {
    // A judge that never saw a file is a gap in the evaluation; a run that wrote
    // nothing may be the correct outcome. The two must not read the same.
    await render(result({ artifact: { origin: { kind: "agent_run" } } }));

    expect(container.textContent).toContain("没有观察到文件变更");
    expect(container.querySelector(".eval-artifact-file")).toBeNull();
  });

  it("names an empty answer as undecidable instead of showing a blank box", async () => {
    await render(result({ output: "   ", artifact: { origin: { kind: "agent_run" } } }));

    expect(container.querySelector(".eval-artifact-output")).toBeNull();
    expect(container.textContent).toContain("无法判定");
  });

  it("cuts a long answer down and offers the rest", async () => {
    const long = "x".repeat(900);
    await render(result({ output: long }));

    expect(container.querySelector(".eval-artifact-output")?.textContent).toHaveLength(401);
    await act(async () => {
      (container.querySelector(".eval-artifact-more") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".eval-artifact-output")?.textContent).toHaveLength(900);
  });

  it("materializes and opens the exact case output as a file", async () => {
    await render(result());

    const button = container.querySelector(".eval-artifact-open") as HTMLButtonElement;
    expect(button.textContent).toContain("打开文件");
    expect(button.title).toContain("Markdown");
    await act(async () => {
      button.click();
    });

    expect(openEvaluationArtifactFile).toHaveBeenCalledWith("run-1", "case-1");
  });

  it("does not offer a file for an empty answer", async () => {
    await render(result({ output: "   " }));

    expect(container.querySelector(".eval-artifact-open")).toBeNull();
  });

  it("opens the session the artifact came from", async () => {
    const onOpenSession = vi.fn();
    await render(
      result({ artifact: { origin: { kind: "session", reference: "codex:thread-3" } } }),
      onOpenSession,
    );

    await act(async () => {
      (container.querySelector(".eval-trigger-session") as HTMLButtonElement).click();
    });

    expect(onOpenSession).toHaveBeenCalledWith("codex:thread-3");
  });

  it("offers no session for a folder artifact, because there is none", async () => {
    await render(
      result({ artifact: { origin: { kind: "folder", reference: "/tmp/out" } } }),
      vi.fn(),
    );

    expect(container.textContent).toContain("磁盘目录");
    expect(container.querySelector(".eval-trigger-session")).toBeNull();
  });

  it("still shows the answer of a run recorded before artifacts were stored", async () => {
    await render(result({ sessionKey: "claude:thread-1" }));

    expect(container.querySelector(".eval-artifact-output")?.textContent).toBe("done");
    expect(container.textContent).not.toContain("新跑一次");
  });
});
