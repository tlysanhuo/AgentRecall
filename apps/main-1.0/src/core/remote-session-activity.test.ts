import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { loadRemoteLiveSessions } from "./remote-session-activity";
import type { SessionEnvironment } from "./types";

function environment(overrides: Partial<SessionEnvironment> = {}): SessionEnvironment {
  return {
    id: "ssh-devbox",
    kind: "ssh",
    label: "devbox",
    hostAlias: "devbox",
    host: null,
    user: null,
    port: null,
    authMode: "none",
    identityFile: null,
    enabled: true,
    syncState: "watching",
    lastSyncedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("remote live session detection", () => {
  it("queries enabled SSH and WSL environments and isolates malformed or failed SSH responses", async () => {
    const runner = vi.fn(async (remoteEnvironment: SessionEnvironment) => {
      if (remoteEnvironment.id === "ssh-broken") throw new Error("offline");
      return [
        '{"family":"codex","rawId":"remote-codex","pid":42}',
        '{"family":"codex","rawId":"remote-codex","pid":42}',
        '{"family":"claude","rawId":"remote-claude","pid":43}',
        "not-json",
      ].join("\n");
    });

    const sessions = await loadRemoteLiveSessions([
      environment(),
      environment({ id: "wsl-ubuntu", kind: "wsl", hostAlias: null, wslDistribution: "Ubuntu" }),
      environment({ id: "ssh-disabled", enabled: false }),
      environment({ id: "ssh-password", authMode: "password" }),
      environment({ id: "local", kind: "local", hostAlias: null }),
      environment({ id: "ssh-broken" }),
    ], runner);

    expect(runner.mock.calls.map(([remoteEnvironment]) => remoteEnvironment.id)).toEqual([
      "ssh-devbox",
      "wsl-ubuntu",
      "ssh-broken",
    ]);
    expect(sessions).toEqual([
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "ssh-devbox" },
      { family: "claude", rawId: "remote-claude", pid: 43, environmentId: "ssh-devbox" },
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "wsl-ubuntu" },
      { family: "claude", rawId: "remote-claude", pid: 43, environmentId: "wsl-ubuntu" },
    ]);
  });

  it("fails closed when a WSL live-session scan fails", async () => {
    await expect(loadRemoteLiveSessions([
      environment({ id: "wsl-ubuntu", kind: "wsl", hostAlias: null, wslDistribution: "Ubuntu" }),
    ], async () => {
      throw new Error("python3 is unavailable");
    })).rejects.toThrow("Could not inspect live sessions in WSL environment devbox: python3 is unavailable");
  });

  it("includes password-authenticated SSH only for fresh safety checks", async () => {
    const passwordEnvironment = environment({ id: "ssh-password", authMode: "password" });
    const runner = vi.fn(async () => '{"family":"codex","rawId":"remote-codex","pid":42}');

    await expect(loadRemoteLiveSessions([passwordEnvironment], runner)).resolves.toEqual([]);
    await expect(loadRemoteLiveSessions([passwordEnvironment], runner, {
      includePasswordAuthenticated: true,
    })).resolves.toEqual([
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "ssh-password" },
    ]);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("bounds concurrent remote probes", async () => {
    let active = 0;
    let maximumActive = 0;
    const environments = Array.from({ length: 8 }, (_, index) => environment({
      id: `ssh-${index}`,
      label: `ssh-${index}`,
    }));

    await loadRemoteLiveSessions(environments, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "";
    });

    expect(maximumActive).toBe(3);
  });

  it("maps persisted Codex and Claude processes without confusing helper or historical sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-remote-persisted-live-"));
    const home = path.join(root, "home");
    const persistedCodex = path.join(root, "persisted", "codex");
    const persistedClaude = path.join(root, "persisted", "claude");
    const procRoot = path.join(root, "proc");
    const codexSessions = path.join(persistedCodex, "sessions", "2026", "08", "29");
    const claudeMetaDir = path.join(persistedClaude, "sessions");
    const claudeMetaProject = path.join(persistedClaude, "projects", "-work-meta");
    const claudeFdProject = path.join(persistedClaude, "projects", "-work-fd");
    const similarCodexRoot = path.join(root, "persisted", "codex", "sessions-evil");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(codexSessions, { recursive: true });
    fs.mkdirSync(claudeMetaDir, { recursive: true });
    fs.mkdirSync(claudeMetaProject, { recursive: true });
    fs.mkdirSync(claudeFdProject, { recursive: true });
    fs.mkdirSync(similarCodexRoot, { recursive: true });
    fs.symlinkSync(persistedCodex, path.join(home, ".codex"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(persistedClaude, path.join(home, ".claude"), process.platform === "win32" ? "junction" : "dir");

    const activeId = "11111111-1111-4111-8111-111111111111";
    const completedId = "22222222-2222-4222-8222-222222222222";
    const idleOlderId = "33333333-3333-4333-8333-333333333333";
    const idleNewestId = "44444444-4444-4444-8444-444444444444";
    const helperId = "55555555-5555-4555-8555-555555555555";
    const appServerId = "66666666-6666-4666-8666-666666666666";
    const similarPrefixId = "77777777-7777-4777-8777-777777777777";
    const activeFile = codexRollout(codexSessions, activeId, "task_started");
    const completedFile = codexRollout(codexSessions, completedId, "task_complete");
    const idleOlderFile = codexRollout(codexSessions, idleOlderId, "task_complete");
    const idleNewestFile = codexRollout(codexSessions, idleNewestId, "task_complete");
    const helperFile = codexRollout(codexSessions, helperId, "task_started");
    const appServerFile = codexRollout(codexSessions, appServerId, "task_started");
    const similarPrefixFile = codexRollout(similarCodexRoot, similarPrefixId, "task_started");
    const older = new Date(Date.now() - 60_000);
    const newer = new Date(Date.now() - 30_000);
    fs.utimesSync(idleOlderFile, older, older);
    fs.utimesSync(idleNewestFile, newer, newer);

    const metadataClaudeId = "claude-from-pid-metadata";
    const wrongClaudeId = "claude-wrong-time-fallback";
    const fdClaudeId = "claude-from-canonical-fd";
    const wrongClaudeFile = path.join(claudeMetaProject, `${wrongClaudeId}.jsonl`);
    const fdClaudeFile = path.join(claudeFdProject, `${fdClaudeId}.jsonl`);
    fs.writeFileSync(wrongClaudeFile, "{}\n");
    fs.writeFileSync(fdClaudeFile, "{}\n");

    writeSyntheticProcess(procRoot, 801, ["/usr/bin/codex"], [activeFile, completedFile, similarPrefixFile]);
    writeSyntheticProcess(procRoot, 802, ["/usr/bin/codex"], [idleOlderFile, idleNewestFile]);
    writeSyntheticProcess(procRoot, 803, ["/usr/bin/codex", "resume", "explicit-codex-resume"], [helperFile]);
    writeSyntheticProcess(
      procRoot,
      804,
      ["/opt/lib/node_modules/@openai/codex/vendor/bin/codex-code-mode-host"],
      [helperFile],
    );
    writeSyntheticProcess(procRoot, 805, ["/usr/bin/claude"], [wrongClaudeFile], "/work/meta");
    writeSyntheticProcess(procRoot, 806, ["/usr/bin/claude"], [fdClaudeFile], "/work/missing");
    writeSyntheticProcess(procRoot, 807, ["/usr/bin/claude", "--resume", "explicit-claude-resume"], [], "/work/meta");
    writeSyntheticProcess(
      procRoot,
      808,
      ["/usr/bin/node", "/usr/bin/codex", "app-server", "--listen", "stdio://"],
      [appServerFile, completedFile],
    );
    writeSyntheticProcess(procRoot, 809, ["/usr/bin/node", "/usr/bin/codex"], [helperFile]);
    fs.writeFileSync(
      path.join(claudeMetaDir, "805.json"),
      JSON.stringify({ sessionId: metadataClaudeId, cwd: "/work/meta" }),
    );
    fs.writeFileSync(path.join(claudeMetaDir, "806.json"), "{not-json");
    fs.writeFileSync(
      path.join(claudeMetaDir, "807.json"),
      JSON.stringify({ sessionId: "metadata-must-not-override-resume" }),
    );

    try {
      const sessions = await loadRemoteLiveSessions([environment()], (_remoteEnvironment, remoteCommand) =>
        executeRemotePayloadWithReadlinkFixtures(remoteCommand, {
          HOME: home,
          USERPROFILE: home,
          AGENT_RECALL_PROC_ROOT: procRoot,
        }));

      expect(sessions).toEqual([
        { family: "codex", rawId: activeId, pid: 801, environmentId: "ssh-devbox" },
        { family: "codex", rawId: idleNewestId, pid: 802, environmentId: "ssh-devbox" },
        { family: "codex", rawId: "explicit-codex-resume", pid: 803, environmentId: "ssh-devbox" },
        { family: "claude", rawId: metadataClaudeId, pid: 805, environmentId: "ssh-devbox" },
        { family: "claude", rawId: fdClaudeId, pid: 806, environmentId: "ssh-devbox" },
        { family: "claude", rawId: "explicit-claude-resume", pid: 807, environmentId: "ssh-devbox" },
        { family: "codex", rawId: appServerId, pid: 808, environmentId: "ssh-devbox" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("detects active Codex and Claude sessions from a synthetic remote process tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-remote-live-"));
    const home = path.join(root, "home");
    const procRoot = path.join(root, "proc");
    const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "29");
    const activeId = "019fad24-234a-7013-bbd3-662513771e3d";
    const completeId = "019fad24-234a-7013-bbd3-662513771e3e";
    const abortedId = "019fad24-234a-7013-bbd3-662513771e3f";
    const staleId = "019fad24-234a-7013-bbd3-662513771e40";
    const claudeSubagentsDir = path.join(home, ".claude", "projects", "-work-app", "parent", "subagents");
    const claudeFallbackDir = path.join(home, ".claude", "projects", "-work-fallback");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(claudeSubagentsDir, { recursive: true });
    fs.mkdirSync(claudeFallbackDir, { recursive: true });

    const activeFile = path.join(sessionsDir, `rollout-active-${activeId}.jsonl`);
    const completeFile = path.join(sessionsDir, `rollout-complete-${completeId}.jsonl`);
    const abortedFile = path.join(sessionsDir, `rollout-aborted-${abortedId}.jsonl`);
    const staleFile = path.join(sessionsDir, `rollout-stale-${staleId}.jsonl`);
    const claudeChildFile = path.join(claudeSubagentsDir, "agent-child-id.jsonl");
    const claudeFallbackFile = path.join(claudeFallbackDir, "fallback-session.jsonl");
    fs.writeFileSync(activeFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", payload: { text: `${"x".repeat(70_000)} task_complete` } }),
    ].join("\n") + "\n");
    fs.writeFileSync(completeFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(abortedFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }),
    ].join("\n") + "\n");
    fs.writeFileSync(staleFile, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
    fs.writeFileSync(claudeChildFile, "{}\n");
    fs.writeFileSync(claudeFallbackFile, "{}\n");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, staleTime, staleTime);

    const appServerProc = path.join(procRoot, "701");
    const resumeProc = path.join(procRoot, "702");
    const claudeResumeProc = path.join(procRoot, "703");
    const claudePlainProc = path.join(procRoot, "704");
    const claudeFallbackProc = path.join(procRoot, "705");
    const claudeGuardProc = path.join(procRoot, "706");
    fs.mkdirSync(path.join(appServerProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(resumeProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(claudeResumeProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(claudePlainProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(claudeFallbackProc, "fd"), { recursive: true });
    fs.mkdirSync(path.join(claudeGuardProc, "fd"), { recursive: true });
    fs.writeFileSync(
      path.join(appServerProc, "cmdline"),
      Buffer.from("/usr/bin/node\0/usr/bin/codex\0-c\0features.code_mode_host=true\0app-server\0--listen\0unix://\0"),
    );
    fs.writeFileSync(path.join(resumeProc, "cmdline"), Buffer.from("/usr/bin/codex\0resume\0remote-resume-id\0"));
    fs.writeFileSync(path.join(claudeResumeProc, "cmdline"), Buffer.from("/usr/bin/claude\0--resume\0remote-claude-resume\0"));
    fs.writeFileSync(path.join(claudePlainProc, "cmdline"), Buffer.from("/usr/bin/node\0/usr/bin/claude\0"));
    fs.writeFileSync(path.join(claudeFallbackProc, "cmdline"), Buffer.from("/usr/bin/claude\0"));
    fs.writeFileSync(path.join(claudeGuardProc, "cmdline"), Buffer.from("/usr/bin/claude\0"));
    fs.symlinkSync("/work/fallback", path.join(claudeFallbackProc, "cwd"));
    for (const [index, sessionFile] of [activeFile, completeFile, abortedFile, staleFile].entries()) {
      fs.symlinkSync(sessionFile, path.join(appServerProc, "fd", String(index + 10)));
    }
    fs.symlinkSync(claudeChildFile, path.join(claudePlainProc, "fd", "10"));

    try {
      const sessions = await loadRemoteLiveSessions([environment()], (_remoteEnvironment, remoteCommand) =>
        executeRemoteCommand(remoteCommand, { HOME: home, AGENT_RECALL_PROC_ROOT: procRoot }));

      expect(sessions).toEqual([
        { family: "codex", rawId: activeId, pid: 701, environmentId: "ssh-devbox" },
        { family: "codex", rawId: "remote-resume-id", pid: 702, environmentId: "ssh-devbox" },
        { family: "claude", rawId: "remote-claude-resume", pid: 703, environmentId: "ssh-devbox" },
        { family: "claude", rawId: "child-id", pid: 704, environmentId: "ssh-devbox" },
        { family: "claude", rawId: "fallback-session", pid: 705, environmentId: "ssh-devbox" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function executeRemoteCommand(remoteCommand: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-lc", remoteCommand], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function codexRollout(directory: string, rawId: string, eventType: "task_started" | "task_complete"): string {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-08-29T00-00-00-${rawId}.jsonl`);
  fs.writeFileSync(filePath, JSON.stringify({ type: "event_msg", payload: { type: eventType } }) + "\n");
  return filePath;
}

function writeSyntheticProcess(
  procRoot: string,
  pid: number,
  tokens: string[],
  openFiles: string[],
  cwd?: string,
): void {
  const processRoot = path.join(procRoot, String(pid));
  const fdRoot = path.join(processRoot, "fd");
  fs.mkdirSync(fdRoot, { recursive: true });
  fs.writeFileSync(path.join(processRoot, "cmdline"), Buffer.from(`${tokens.join("\0")}\0`));
  openFiles.forEach((filePath, index) => {
    fs.writeFileSync(path.join(fdRoot, String(index + 10)), filePath);
  });
  if (cwd) fs.writeFileSync(path.join(processRoot, "cwd"), cwd);
}

function executeRemotePayloadWithReadlinkFixtures(
  remoteCommand: string,
  env: Record<string, string>,
): Promise<string> {
  const payload = remoteCommand.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
  if (!payload) return Promise.reject(new Error("Remote activity payload was not found."));
  const script = inflateRawSync(Buffer.from(payload, "base64")).toString("utf8");
  const readlinkFixture = String.raw`
import os
from pathlib import Path

_agent_recall_real_readlink = os.readlink
def _agent_recall_fixture_readlink(value):
  candidate = Path(value)
  if os.environ.get("AGENT_RECALL_PROC_ROOT") and candidate.is_file():
    return candidate.read_text(encoding="utf-8")
  return _agent_recall_real_readlink(value)
os.readlink = _agent_recall_fixture_readlink
`;
  const executable = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve, reject) => {
    execFile(executable, ["-c", `${readlinkFixture}\n${script}`], {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
