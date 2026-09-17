import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "jev-orchestrator";
export const SKILL_NAME = "jev-orchestrator";
export const PROJECT_DIR_NAME = ".jev";
export const CONFIG_FILE_NAME = "config.json";
export const SECRETS_FILE_NAME = "secrets.json";
export const WORKTREE_MANIFEST_NAME = "worktrees.json";

/** Environment variables recognised by the CLI. */
export const ENV = {
  typesafeApiKey: "TYPESAFE_API_KEY",
  configHome: "XDG_CONFIG_HOME",
  claudeConfigDir: "CLAUDE_CONFIG_DIR",
  home: "HOME",
} as const;

export interface PathEnv {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
  APPDATA?: string;
}

function resolveHome(env: PathEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

/** User-level config directory: ~/.config/jev-orchestrator (or XDG / APPDATA). */
export function userConfigDir(env: PathEnv = process.env): string {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, APP_NAME);
  }
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, APP_NAME);
  }
  return join(resolveHome(env), ".config", APP_NAME);
}

export function userConfigFile(env: PathEnv = process.env): string {
  return join(userConfigDir(env), CONFIG_FILE_NAME);
}

export function userSecretsFile(env: PathEnv = process.env): string {
  return join(userConfigDir(env), SECRETS_FILE_NAME);
}

/** Claude Code personal config dir: ~/.claude (or CLAUDE_CONFIG_DIR). */
export function claudeUserDir(env: PathEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0) {
    return env.CLAUDE_CONFIG_DIR;
  }
  return join(resolveHome(env), ".claude");
}

export function globalSkillDir(env: PathEnv = process.env): string {
  return join(claudeUserDir(env), "skills", SKILL_NAME);
}

export function projectSkillDir(projectRoot: string): string {
  return join(projectRoot, ".claude", "skills", SKILL_NAME);
}

export function projectJevDir(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIR_NAME);
}

export function projectConfigFile(projectRoot: string): string {
  return join(projectJevDir(projectRoot), CONFIG_FILE_NAME);
}

export function worktreeManifestFile(projectRoot: string): string {
  return join(projectJevDir(projectRoot), WORKTREE_MANIFEST_NAME);
}
