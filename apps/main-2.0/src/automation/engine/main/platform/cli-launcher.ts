import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CliPlatformOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
}

export interface CliSpawnRequest extends SpawnOptions {
  executable: string;
  args?: string[];
}

export interface CliExecRequest extends Omit<ExecFileOptionsWithStringEncoding, "encoding"> {
  executable: string;
  args?: string[];
}

function shouldUseWindowsCmd(executable: string, platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const normalized = executable.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.endsWith(".cmd") || normalized.endsWith(".bat")) return true;
  return !/[\\/]/.test(normalized) && !/\.[a-z0-9]+$/i.test(normalized);
}

function quoteForWindowsCmd(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function buildWindowsCmdInvocation(executable: string, args: string[], comspec: string): { file: string; args: string[] } {
  const command = `""${executable}"${args.length > 0 ? ` ${args.map(quoteForWindowsCmd).join(" ")}` : ""}"`;
  return {
    file: comspec,
    args: ["/d", "/s", "/c", command],
  };
}

export function resolveCliInvocation(executable: string, args?: string[]): {
  file: string;
  args: string[];
  viaWindowsCmd: boolean;
  windowsVerbatimArguments?: true;
};
export function resolveCliInvocation(executable: string, args: string[] | undefined, options: CliPlatformOptions): {
  file: string;
  args: string[];
  viaWindowsCmd: boolean;
  windowsVerbatimArguments?: true;
};
export function resolveCliInvocation(executable: string, args: string[] = [], options: CliPlatformOptions = {}): {
  file: string;
  args: string[];
  viaWindowsCmd: boolean;
  windowsVerbatimArguments?: true;
} {
  const platform = options.platform ?? process.platform;
  const comspec = options.comspec ?? process.env.comspec ?? "cmd.exe";

  if (!shouldUseWindowsCmd(executable, platform)) {
    return {
      file: executable,
      args,
      viaWindowsCmd: false,
    };
  }

  const invocation = buildWindowsCmdInvocation(executable, args, comspec);
  return {
    ...invocation,
    viaWindowsCmd: true,
    windowsVerbatimArguments: true,
  };
}

export function spawnCli(request: CliSpawnRequest): ChildProcess {
  const { executable, args = [], ...options } = request;
  const invocation = resolveCliInvocation(executable, args);
  return spawn(invocation.file, invocation.args, {
    ...options,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export function terminateCliProcessTree(
  pid: number | undefined,
  options: {
    platform?: NodeJS.Platform;
    kill?: typeof process.kill;
    spawnKiller?: (file: string, args: string[]) => void;
  } = {},
): void {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawnKiller = options.spawnKiller ?? ((file: string, args: string[]) => {
      const killer = spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    });
    spawnKiller("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }

  const kill = options.kill ?? process.kill.bind(process);
  try {
    kill(-pid, "SIGTERM");
  } catch {
    try {
      kill(pid, "SIGTERM");
    } catch {
      // The exact owned process already exited.
    }
  }
}

export async function execCli(request: CliExecRequest): Promise<{ stdout: string; stderr: string }> {
  const { executable, args = [], ...options } = request;
  const invocation = resolveCliInvocation(executable, args);
  return execFileAsync(invocation.file, invocation.args, {
    ...options,
    encoding: "utf8",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
