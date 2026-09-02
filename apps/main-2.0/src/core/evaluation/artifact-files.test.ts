import { describe, expect, it } from "vitest";

import { artifactFilesFromTrace } from "./artifact-files";

/**
 * The file list is an observation, and the tests that matter are the ones that
 * pin down what it refuses to claim: a tool it does not recognise contributes
 * nothing, and no path is invented from a truncated argument.
 */

function call(title: string, detail?: string, attributes?: Record<string, unknown>) {
  return {
    kind: "tool_call",
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

describe("artifactFilesFromTrace", () => {
  it("reads a written file from the tool's path argument", () => {
    expect(artifactFilesFromTrace([
      call("Write · src/a.ts", JSON.stringify({ file_path: "src/a.ts", content: "x" })),
    ])).toEqual([{ path: "src/a.ts", status: "added" }]);
  });

  it("separates a change to an existing file from a new one", () => {
    expect(artifactFilesFromTrace([
      call("Edit · src/b.ts", JSON.stringify({ file_path: "src/b.ts" })),
    ])).toEqual([{ path: "src/b.ts", status: "modified" }]);
  });

  it("keeps a file the run created as added even after it edits it", () => {
    // The question a judge asks is "did the run produce this file", and it did.
    expect(artifactFilesFromTrace([
      call("Write · src/c.ts", JSON.stringify({ file_path: "src/c.ts" })),
      call("Edit · src/c.ts", JSON.stringify({ file_path: "src/c.ts" })),
    ])).toEqual([{ path: "src/c.ts", status: "added" }]);
  });

  it("reports a path deleted at the end as deleted", () => {
    expect(artifactFilesFromTrace([
      call("Write · tmp.ts", JSON.stringify({ file_path: "tmp.ts" })),
      call("delete_file · tmp.ts", JSON.stringify({ path: "tmp.ts" })),
    ])).toEqual([{ path: "tmp.ts", status: "deleted" }]);
  });

  it("falls back to the title when the argument JSON was truncated for display", () => {
    // Trace details are cut for display, so the parse fails on a large write.
    expect(artifactFilesFromTrace([
      call("Write · src/long.ts", '{"file_path":"src/long.ts","content":"aaaaaa'),
    ])).toEqual([{ path: "src/long.ts", status: "added" }]);
  });

  it("reads an apply_patch body, which is how Codex writes files", () => {
    const patch = [
      "apply_patch <<'EOF'",
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/old.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
      "EOF",
    ].join("\n");
    expect(artifactFilesFromTrace([
      { kind: "tool_call", title: "shell · apply_patch", attributes: { input: { command: patch } } },
    ])).toEqual([
      { path: "src/gone.ts", status: "deleted" },
      { path: "src/new.ts", status: "added" },
      { path: "src/old.ts", status: "modified" },
    ]);
  });

  it("says nothing about a tool it does not recognise", () => {
    // A shell redirect writes a file too, and reporting nothing is the honest
    // answer — the artifact contract reads an absent list as "not observed".
    expect(artifactFilesFromTrace([
      call("shell · echo hi > out.txt", JSON.stringify({ command: "echo hi > out.txt" })),
      call("Read · src/a.ts", JSON.stringify({ file_path: "src/a.ts" })),
      call("Bash · npm test", JSON.stringify({ command: "npm test" })),
    ])).toEqual([]);
  });

  it("ignores everything that is not a tool call", () => {
    expect(artifactFilesFromTrace([
      { kind: "tool_result", title: "tool result", detail: '{"file_path":"src/a.ts"}' },
      { kind: "event", title: "Write · src/a.ts" },
    ])).toEqual([]);
  });

  it("does not invent a path when neither the argument nor the title has one", () => {
    expect(artifactFilesFromTrace([call("Write", "not json at all")])).toEqual([]);
  });
});
