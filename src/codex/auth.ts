import { ExecSpawnError, exec } from "../util/exec.js";
import { CODEX_BINARY } from "./detect.js";

const STATUS_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 60_000;

export type CodexAuthMethod = "chatgpt" | "api_key" | "unknown";

export interface CodexAuthStatus {
  authenticated: boolean;
  method: CodexAuthMethod;
  /** Text from `codex login status`, never containing tokens. */
  detail: string;
}

/**
 * `codex login status` exits 0 when logged in ("Logged in using ChatGPT" /
 * "Logged in using an API key") and 1 with "Not logged in" otherwise.
 * We never read ~/.codex/auth.json.
 */
export async function codexAuthStatus(binary = CODEX_BINARY): Promise<CodexAuthStatus> {
  try {
    const result = await exec(binary, ["login", "status"], { timeoutMs: STATUS_TIMEOUT_MS });
    const detail = (result.stdout + result.stderr).trim().split("\n").pop() ?? "";
    if (result.exitCode !== 0) {
      return { authenticated: false, method: "unknown", detail: detail || "Not logged in" };
    }
    const lower = detail.toLowerCase();
    const method: CodexAuthMethod = lower.includes("chatgpt")
      ? "chatgpt"
      : lower.includes("api key")
        ? "api_key"
        : "unknown";
    return { authenticated: true, method, detail };
  } catch (err) {
    const detail = err instanceof ExecSpawnError ? err.message : (err as Error).message;
    return { authenticated: false, method: "unknown", detail };
  }
}

/**
 * Store an API key in Codex's own credential store via stdin. The key never
 * appears in argv or in jev-orchestrator's config.
 */
export async function codexLoginWithApiKey(
  apiKey: string,
  binary = CODEX_BINARY,
): Promise<boolean> {
  const result = await exec(binary, ["login", "--with-api-key"], {
    input: `${apiKey}\n`,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

/** Command the user runs themselves for the browser-based ChatGPT flow. */
export const CODEX_LOGIN_COMMAND = "codex login";
