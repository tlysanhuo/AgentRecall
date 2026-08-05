import { describe, expect, it, vi } from "vitest";
import { terminateCliProcessTree } from "./cli-launcher";

describe("terminateCliProcessTree", () => {
  it("terminates the owned POSIX process group and falls back to the exact pid", () => {
    const kill = vi.fn<(pid: number, signal?: string | number) => true>()
      .mockImplementationOnce(() => {
        throw new Error("no process group");
      })
      .mockReturnValue(true);

    terminateCliProcessTree(4321, { platform: "darwin", kill });

    expect(kill).toHaveBeenNthCalledWith(1, -4321, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, 4321, "SIGTERM");
  });

  it("uses taskkill for the exact owned Windows process tree", () => {
    const kill = vi.fn();
    const spawnKiller = vi.fn();

    terminateCliProcessTree(9876, { platform: "win32", kill, spawnKiller });

    expect(spawnKiller).toHaveBeenCalledWith("taskkill", ["/pid", "9876", "/T", "/F"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does nothing without a valid owned pid", () => {
    const kill = vi.fn();
    const spawnKiller = vi.fn();

    terminateCliProcessTree(undefined, { kill, spawnKiller });
    terminateCliProcessTree(0, { kill, spawnKiller });

    expect(kill).not.toHaveBeenCalled();
    expect(spawnKiller).not.toHaveBeenCalled();
  });
});
