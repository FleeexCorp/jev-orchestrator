import { CODEX_LOGIN_COMMAND, type CodexAuthStatus, codexAuthStatus } from "./auth.js";
import { type CodexDetection, codexInstallHint, detectCodex } from "./detect.js";

export const CODEX_API_KEY_LOGIN = "printenv OPENAI_API_KEY | codex login --with-api-key";
export const CODEX_AUTH_HINT = `Sign in with ChatGPT:  ${CODEX_LOGIN_COMMAND}\nOr with an API key:    ${CODEX_API_KEY_LOGIN}`;

export interface CodexStatus {
  detection: CodexDetection;
  auth?: CodexAuthStatus;
  ready: boolean;
}

export type StatusLevel = "ok" | "warn" | "fail";

export interface StatusLine {
  level: StatusLevel;
  label: string;
  fix?: string;
}

/** One probe of the Codex CLI: installed? authenticated? Both spawns run once. */
export async function codexStatus(binary?: string): Promise<CodexStatus> {
  const detection = await detectCodex(binary);
  if (!detection.installed) {
    return { detection, ready: false };
  }
  const auth = await codexAuthStatus(binary);
  return { detection, auth, ready: auth.authenticated };
}

/** Shared rendering for `codex status`, `doctor` and `setup`. */
export function codexStatusLines(
  status: CodexStatus,
  missingLevel: StatusLevel = "fail",
): StatusLine[] {
  if (!status.detection.installed) {
    return [
      { level: missingLevel, label: "Codex CLI not installed (optional)", fix: codexInstallHint() },
    ];
  }
  const lines: StatusLine[] = [
    {
      level: "ok",
      label: `Codex ${status.detection.version ?? status.detection.raw ?? ""}`.trim(),
    },
  ];
  if (!status.auth?.authenticated) {
    lines.push({
      level: missingLevel,
      label: "Codex is installed but not authenticated",
      fix: CODEX_AUTH_HINT,
    });
    return lines;
  }
  lines.push({ level: "ok", label: status.auth.detail });
  lines.push({ level: "ok", label: "codex exec available" });
  return lines;
}
