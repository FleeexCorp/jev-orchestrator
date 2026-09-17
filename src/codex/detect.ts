import { ExecSpawnError, exec } from "../util/exec.js";

export const CODEX_BINARY = "codex";
export const CODEX_INSTALL_NPM = "npm install -g @openai/codex";
export const CODEX_INSTALL_BREW = "brew install --cask codex";
export const CODEX_DOCS_URL = "https://developers.openai.com/codex/cli";

const VERSION_TIMEOUT_MS = 10_000;

export interface CodexDetection {
  installed: boolean;
  /** e.g. "0.145.0" */
  version?: string;
  raw?: string;
  error?: string;
}

/** Runs `codex --version`. Missing binary is not an error, just `installed: false`. */
export async function detectCodex(binary = CODEX_BINARY): Promise<CodexDetection> {
  try {
    const result = await exec(binary, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      return { installed: false, error: result.stderr.trim() || `exit code ${result.exitCode}` };
    }
    const raw = result.stdout.trim();
    const match = raw.match(/(\d+\.\d+\.\d+[^\s]*)/);
    return { installed: true, raw, ...(match?.[1] ? { version: match[1] } : {}) };
  } catch (err) {
    if (err instanceof ExecSpawnError && err.code === "ENOENT") {
      return { installed: false, error: "codex binary not found on PATH" };
    }
    return { installed: false, error: (err as Error).message };
  }
}

export const codexInstallHint = (): string =>
  [
    "Install the Codex CLI with one of:",
    `  ${CODEX_INSTALL_NPM}`,
    `  ${CODEX_INSTALL_BREW}`,
    `Docs: ${CODEX_DOCS_URL}`,
  ].join("\n");
