import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadRemoteLiveSessions } from "./remote-session-activity";
import type { SessionEnvironment } from "./types";

const wslEnvironment: SessionEnvironment = {
  id: "wsl-ubuntu",
  kind: "wsl",
  label: "Ubuntu",
  wslDistribution: "Ubuntu",
  hostAlias: null,
  host: null,
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
  syncState: "idle",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
};

function sshEnvironment(index: number): SessionEnvironment {
  return {
    ...wslEnvironment,
    id: `ssh-${index}`,
    kind: "ssh",
    label: `ssh-${index}`,
    wslDistribution: undefined,
    hostAlias: `ssh-${index}`,
  };
}

describe("remote live session deletion guards", () => {
  it("loads Claude sessions from WSL", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () =>
      '{"family":"claude","rawId":"remote-claude","pid":43}')).resolves.toEqual([
      { family: "claude", rawId: "remote-claude", pid: 43, environmentId: "wsl-ubuntu" },
    ]);
  });

  it("fails closed when WSL inspection fails", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () => {
      throw new Error("offline");
    })).rejects.toThrow("Could not inspect live sessions in WSL environment Ubuntu: offline");
  });

  it("bounds concurrent remote probes", async () => {
    let active = 0;
    let maximumActive = 0;

    await loadRemoteLiveSessions(Array.from({ length: 8 }, (_, index) => sshEnvironment(index)), async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "";
    });

    expect(maximumActive).toBe(3);
  });

  it("does not unlock saved SSH passwords during passive detection", async () => {
    let called = false;

    await expect(loadRemoteLiveSessions([
      { ...sshEnvironment(1), authMode: "password" },
    ], async () => {
      called = true;
      return "";
    })).resolves.toEqual([]);

    expect(called).toBe(false);
  });

  it("includes password-authenticated SSH when a fresh safety check requires it", async () => {
    await expect(loadRemoteLiveSessions([
      { ...sshEnvironment(1), authMode: "password" },
    ], async () => '{"family":"codex","rawId":"remote-codex","pid":42}', {
      includePasswordAuthenticated: true,
    })).resolves.toEqual([
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "ssh-1" },
    ]);
  });

  it("maps persisted Codex and Claude processes without confusing helper or historical sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-remote-persisted-live-"));
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
      const sessions = await loadRemoteLiveSessions([sshEnvironment(1)], (_remoteEnvironment, remoteCommand) =>
        executeRemotePayloadWithReadlinkFixtures(remoteCommand, {
          HOME: home,
          USERPROFILE: home,
          AGENT_RECALL_PROC_ROOT: procRoot,
        }));

      expect(sessions).toEqual([
        { family: "codex", rawId: activeId, pid: 801, environmentId: "ssh-1" },
        { family: "codex", rawId: idleNewestId, pid: 802, environmentId: "ssh-1" },
        { family: "codex", rawId: "explicit-codex-resume", pid: 803, environmentId: "ssh-1" },
        { family: "claude", rawId: metadataClaudeId, pid: 805, environmentId: "ssh-1" },
        { family: "claude", rawId: fdClaudeId, pid: 806, environmentId: "ssh-1" },
        { family: "claude", rawId: "explicit-claude-resume", pid: 807, environmentId: "ssh-1" },
        { family: "codex", rawId: appServerId, pid: 808, environmentId: "ssh-1" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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
