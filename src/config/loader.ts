import { z } from "zod";
import { readJson } from "../util/fs.js";
import { ENV, type PathEnv, projectConfigFile, userConfigFile } from "./paths.js";
import { type Config, configSchema, FORBIDDEN_CONFIG_KEYS } from "./schema.js";

export class ConfigError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
    this.file = file;
  }
}

export interface LoadedConfig {
  config: Config;
  sources: { user?: string; project?: string };
}

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Recursive merge where `override` wins; arrays and scalars replace wholesale. */
export function deepMerge(base: PlainObject, override: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function findForbiddenKey(value: unknown, path: string[] = []): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.includes(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenKey(child, [...path, key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

async function readConfigFile(file: string): Promise<PlainObject | undefined> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (err) {
    throw new ConfigError(file, `invalid JSON (${(err as Error).message})`);
  }
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(file, "must be a JSON object");
  }
  const forbidden = findForbiddenKey(raw);
  if (forbidden) {
    throw new ConfigError(
      file,
      `key "${forbidden}" looks like a secret. Use the ${ENV.typesafeApiKey} environment variable instead.`,
    );
  }
  return raw;
}

function validate(file: string, merged: PlainObject): Config {
  const result = configSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  throw new ConfigError(file, z.prettifyError(result.error));
}

export interface LoadConfigOptions {
  projectRoot?: string;
  env?: PathEnv;
}

/** Load user config, then overlay project config (`.jev/config.json`) when present. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const userFile = userConfigFile(env);
  const userRaw = await readConfigFile(userFile);
  let merged: PlainObject = userRaw ?? {};
  const sources: LoadedConfig["sources"] = {};
  if (userRaw) {
    sources.user = userFile;
    validate(userFile, userRaw);
  }

  if (options.projectRoot) {
    const projectFile = projectConfigFile(options.projectRoot);
    const projectRaw = await readConfigFile(projectFile);
    if (projectRaw) {
      sources.project = projectFile;
      validate(projectFile, projectRaw);
      merged = deepMerge(merged, projectRaw);
    }
  }

  const config = validate(sources.project ?? sources.user ?? userFile, merged);
  return { config, sources };
}
