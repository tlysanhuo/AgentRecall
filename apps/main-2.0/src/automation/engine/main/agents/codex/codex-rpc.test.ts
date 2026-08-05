import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import {
  CodexRpcClient,
  type CodexRpcObservation,
} from "./codex-rpc";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("CodexRpcClient raw observer", () => {
  it("reports exact outbound and inbound lines before protocol normalization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-codex-rpc-"));
    temporaryDirectories.push(directory);
    const executable = await writeNodeCliLauncher(directory, "codex-raw-fake", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write("this-is-not-json\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  } else if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } }) + "\\n");
  }
});
`);
    const observed: CodexRpcObservation[] = [];
    const client = new CodexRpcClient({
      executable,
      cwd: directory,
      onEvent: () => undefined,
      onRawMessage: (event) => observed.push(event),
    });

    await client.start();
    await client.request("thread/start", {});
    await client.shutdown();

    expect(observed.some((event) => (
      event.direction === "client_to_server"
      && event.message?.method === "initialize"
      && event.line === JSON.stringify(event.message)
    ))).toBe(true);
    expect(observed.some((event) => (
      event.direction === "server_to_client"
      && event.line === "this-is-not-json"
      && event.parseError
    ))).toBe(true);
    expect(observed.some((event) => (
      event.direction === "server_to_client"
      && typeof event.message?.result === "object"
      && event.line === JSON.stringify(event.message)
    ))).toBe(true);
  });
});
