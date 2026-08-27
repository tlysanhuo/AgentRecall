import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createJudgeScriptRunner, normalizeJudgeScriptResult } from "./judge-script-runner";
import type { EvaluationJudgeScriptInput } from "./nodes/contracts";

function subject(): Omit<EvaluationJudgeScriptInput, "script"> {
  return {
    task: {
      caseId: "case-1",
      datasetItemId: "item-1",
      repetition: 1,
      input: "add 2 and 2",
      expectedOutput: "4",
      metadata: {},
    },
    artifact: { output: "the answer is 4", origin: { kind: "agent_run" } },
    trajectory: {
      turnCount: 3,
      toolCallCount: 4,
      toolFailureCount: 1,
      failedToolNames: ["bash"],
      totalTokens: 1200,
      errorCount: 0,
      usedSkillNames: [],
      skillUsageObservable: true,
    },
  };
}

function inline(source: string, timeoutMs?: number): EvaluationJudgeScriptInput {
  return {
    ...subject(),
    script: { mode: "inline_js", source, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
  };
}

describe("inline judge scripts", () => {
  const run = createJudgeScriptRunner();

  it("scores the artifact with the user's own code", async () => {
    const result = await run(inline(`
      const correct = artifact.output.includes(task.expectedOutput);
      return { score: correct ? 1 : 0, reason: correct ? "found it" : "missing" };
    `));

    expect(result.verdicts).toEqual([{ score: 1, reason: "found it" }]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a bare number, because that is what a one-line judge returns", async () => {
    const result = await run(inline("return artifact.output.length > 3 ? 0.75 : 0;"));

    expect(result.verdicts).toEqual([{ score: 0.75 }]);
  });

  it("lets one script score several dimensions in one pass", async () => {
    const result = await run(inline(`
      return [
        { score: 1, dimension: "correctness" },
        { score: trajectory.toolFailureCount === 0 ? 1 : 0, dimension: "cleanliness" },
      ];
    `));

    expect(result.verdicts).toEqual([
      { score: 1, dimension: "correctness" },
      { score: 0, dimension: "cleanliness" },
    ]);
  });

  it("reads the trajectory when that is what the script was given", async () => {
    const result = await run({
      ...subject(),
      artifact: undefined,
      script: { mode: "inline_js", source: "return { score: 1 / trajectory.turnCount };" },
    });

    expect(result.verdicts[0]!.score).toBeCloseTo(1 / 3);
  });

  it("awaits an async judge", async () => {
    const result = await run(inline("return Promise.resolve({ score: 0.5 });"));

    expect(result.verdicts).toEqual([{ score: 0.5 }]);
  });

  it("rejects rather than scoring zero when the script throws", async () => {
    // The whole point of the excuse path: a bug in the judge must not read as
    // "the agent answered badly".
    await expect(run(inline("throw new Error('my judge is broken');")))
      .rejects.toThrow(/my judge is broken/);
  });

  it("includes the script's own logging in the failure", async () => {
    await expect(run(inline(`
      console.log("checked", { seen: artifact.output });
      throw new Error("gave up");
    `))).rejects.toThrow(/checked \{"seen":"the answer is 4"\}/);
  });

  it("rejects a script that returns nothing", async () => {
    await expect(run(inline("const unused = 1;"))).rejects.toThrow(/script_returned_no_verdict/);
  });

  it("rejects a score that is not a number", async () => {
    await expect(run(inline("return { score: 'great' };")))
      .rejects.toThrow(/script_score_is_not_a_number/);
  });

  it("rejects an empty script instead of passing everything", async () => {
    await expect(run(inline("   "))).rejects.toThrow(/script_is_empty/);
  });

  it("stops a synchronous loop that never ends", async () => {
    await expect(run(inline("while (true) {}", 40))).rejects.toThrow();
  });

  it("stops an async judge that never settles", async () => {
    await expect(run(inline("return new Promise(() => {});", 40)))
      .rejects.toThrow(/script_timed_out/);
  });
});

describe("the inline sandbox", () => {
  const run = createJudgeScriptRunner();

  it("has no module loader, filesystem or network", async () => {
    const absent = ["require", "process", "fetch", "Buffer", "globalThis.process"];
    const result = await run(inline(
      `return { score: [${absent.map((name) => `typeof ${name}`).join(", ")}]
        .every((kind) => kind === "undefined") ? 1 : 0 };`,
    ));

    expect(result.verdicts).toEqual([{ score: 1 }]);
  });

  it("cannot generate more code at run time", async () => {
    await expect(run(inline("return { score: eval('1') };"))).rejects.toThrow();
  });

  it("cannot mutate the values it was given", async () => {
    // Each script gets a copy, so a judge that edits the artifact cannot change
    // what the next judge sees.
    const input = inline("artifact.output = 'rewritten'; return { score: 1 };");
    await run(input);

    expect(input.artifact!.output).toBe("the answer is 4");
  });
});

describe("command judge scripts", () => {
  function fakeSpawn(behaviour: {
    stdout?: string;
    stderr?: string;
    code?: number;
    spawnError?: Error;
    hang?: boolean;
  }) {
    const stdinChunks: string[] = [];
    const spawnCommand = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = { end: (chunk: string) => { stdinChunks.push(chunk); } };
      child.kill = () => {
        setImmediate(() => child.emit("close", null));
        return true;
      };
      setImmediate(() => {
        if (behaviour.hang) return;
        if (behaviour.spawnError) child.emit("error", behaviour.spawnError);
        if (behaviour.stdout) stdout.emit("data", behaviour.stdout);
        if (behaviour.stderr) stderr.emit("data", behaviour.stderr);
        child.emit("close", behaviour.code ?? 0);
      });
      return child;
    });
    return { spawnCommand: spawnCommand as never, stdinChunks, calls: spawnCommand };
  }

  function commandInput(overrides: Record<string, unknown> = {}): EvaluationJudgeScriptInput {
    return {
      ...subject(),
      script: { mode: "command", command: "./judge.sh", args: ["--strict"], ...overrides } as never,
    };
  }

  it("hands the subject to the command on stdin and reads its verdict from stdout", async () => {
    const fake = fakeSpawn({ stdout: '{"score": 0.9, "dimension": "style"}' });
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: fake.spawnCommand,
      defaultCwd: "/tmp/eval",
    });

    const result = await run(commandInput());

    expect(result.verdicts).toEqual([{ score: 0.9, dimension: "style" }]);
    expect(JSON.parse(fake.stdinChunks[0]!)).toMatchObject({
      task: { input: "add 2 and 2" },
      artifact: { output: "the answer is 4" },
    });
    const [command, args, spawnOptions] = fake.calls.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("./judge.sh");
    expect(args).toEqual(["--strict"]);
    expect(spawnOptions).toMatchObject({ cwd: "/tmp/eval", shell: false });
  });

  it("takes the last JSON block, so a judge may print progress first", async () => {
    const fake = fakeSpawn({ stdout: 'checking...\nstill checking\n[{"score": 1}]' });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    expect((await run(commandInput())).verdicts).toEqual([{ score: 1 }]);
  });

  it("refuses to spawn anything while command judges are switched off", async () => {
    const fake = fakeSpawn({ stdout: '{"score": 1}' });
    const run = createJudgeScriptRunner({ commandsEnabled: () => false, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_commands_not_enabled/);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit with the command's own stderr", async () => {
    const fake = fakeSpawn({ code: 2, stderr: "cannot open the rubric" });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput()))
      .rejects.toThrow(/script_command_exited_2: cannot open the rubric/);
  });

  it("reports output that is not a verdict", async () => {
    const fake = fakeSpawn({ stdout: "looks fine to me" });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_output_not_json/);
  });

  it("reports a command that printed nothing", async () => {
    const fake = fakeSpawn({});
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_printed_nothing/);
  });

  it("reports a command that could not be spawned at all", async () => {
    const fake = fakeSpawn({ spawnError: new Error("ENOENT"), code: 1 });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_failed: ENOENT/);
  });

  it("kills a command that overruns its timeout", async () => {
    const fake = fakeSpawn({ hang: true });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput({ timeoutMs: 20 }))).rejects.toThrow(/script_timed_out/);
  });

  it("stops when the run is cancelled", async () => {
    const fake = fakeSpawn({ hang: true });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });
    const controller = new AbortController();
    const pending = run({ ...commandInput(), signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/script_aborted/);
  });
});

describe("normalizeJudgeScriptResult", () => {
  it("clamps nothing and keeps the fields a report shows", () => {
    expect(normalizeJudgeScriptResult({
      score: 1.4,
      reason: "over the top",
      evidence: ["line 3"],
      failedCriteria: [],
    })).toEqual([{ score: 1.4, reason: "over the top", evidence: ["line 3"] }]);
  });

  it("rejects an empty list, which is a judge that decided nothing", () => {
    expect(() => normalizeJudgeScriptResult([])).toThrow(/script_returned_no_verdict/);
  });
});
