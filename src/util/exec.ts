import { spawn } from "node:child_process";

const KILL_GRACE_MS = 5_000;

/** Result of a finished child process. */
export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type StdoutCapture = "buffer" | "stream_only";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to the child's stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
  /** Called for each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called for each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
  /** `stream_only` skips accumulating stdout when the caller consumes it via onStdout. */
  stdout?: StdoutCapture;
  signal?: AbortSignal;
}

/** Thrown when the binary cannot be started at all (typically ENOENT). */
export class ExecSpawnError extends Error {
  readonly code: string | undefined;

  constructor(command: string, cause: NodeJS.ErrnoException) {
    super(`Failed to start "${command}": ${cause.message}`);
    this.name = "ExecSpawnError";
    this.code = cause.code;
  }
}

/**
 * Run a command with an argument array. Never builds a shell string, so
 * untrusted text (task prompts, file names) cannot inject arguments.
 *
 * The child gets its own process group so that a timeout or abort kills its
 * descendants too (a worker's test runner, for instance), not only the direct child.
 */
export function exec(command: string, args: readonly string[], options: ExecOptions = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        if (process.platform === "win32") {
          child.kill(sig);
        } else {
          process.kill(-child.pid, sig);
        }
      } catch {
        /* already gone */
      }
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const terminate = () => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const onAbort = () => terminate();

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(terminate, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (options.stdout !== "stream_only") {
        stdout += chunk;
      }
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(new ExecSpawnError(command, err)));
    });
    child.on("close", (exitCode, signal) => {
      finish(() => resolve({ exitCode, signal, stdout, stderr }));
    });

    if (options.input !== undefined) {
      child.stdin.on("error", () => {
        /* child exited before reading stdin; the close handler reports it */
      });
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Run a command and return trimmed stdout, or undefined when it fails or is missing. */
export async function tryExec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<string | undefined> {
  try {
    const result = await exec(command, args, options);
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}
