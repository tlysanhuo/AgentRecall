import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main process wiring", () => {
  it("migrates SSH sessions through remote writeback and SSH Resume", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('source?.environmentKind === "wsl" || source?.environmentKind === "ssh"');
    expect(source).toContain('request.target !== sshMigrationTarget(migrationSource.source.source)');
    expect(source).toContain('allowSsh: migrationSource.source.environmentKind === "ssh"');
    expect(source).toContain("createSourceRemoteRestoreDependencies(environment, progress)");
    expect(source).toContain('environment.kind === "ssh" ? inspectSshMigrationCli(environment, target)');
    expect(source).toContain("getRemoteMigrationCliVersionCommand(command, args)");
    expect(source).toContain('const sshArgs = buildRemoteInteractiveSshArgs(environment, "").slice(0, -1)');
    expect(source).toContain("await openResumeInTerminal(session, getSettings(), { sshArgs })");
  });

  it("uses Electron networking for direct summary providers", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("fetch: electronSummaryFetch");
    expect(source).toContain("net.fetch(input, init)");
  });
});
