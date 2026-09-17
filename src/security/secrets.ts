import { chmod, rm } from "node:fs/promises";
import { ENV, type PathEnv, userSecretsFile } from "../config/paths.js";
import { MODE_PRIVATE_DIR, MODE_PRIVATE_FILE, readJson, writeJson } from "../util/fs.js";

export const TYPESAFE_API_KEY_SECRET = "typesafeApiKey";

export type SecretName = typeof TYPESAFE_API_KEY_SECRET;

/**
 * Storage for secrets the CLI needs across sessions. Implementations must
 * never write secrets inside a repository. A native keychain implementation
 * can be added later behind this interface.
 */
export interface SecretStore {
  readonly id: string;
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  /** Human-readable location, for doctor output. Never the secret itself. */
  describe(): string;
}

type SecretFile = Partial<Record<SecretName, string>>;

/** JSON file under the user config dir, mode 0600, directory 0700. */
export class FileSecretStore implements SecretStore {
  readonly id = "file";
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  static forEnv(env: PathEnv = process.env): FileSecretStore {
    return new FileSecretStore(userSecretsFile(env));
  }

  describe(): string {
    return this.#file;
  }

  async #read(): Promise<SecretFile> {
    return (await readJson<SecretFile>(this.#file)) ?? {};
  }

  async #write(data: SecretFile): Promise<void> {
    await writeJson(this.#file, data, { fileMode: MODE_PRIVATE_FILE, dirMode: MODE_PRIVATE_DIR });
    // writeFile's mode is ignored for existing files; force it.
    await chmod(this.#file, MODE_PRIVATE_FILE);
  }

  async get(name: SecretName): Promise<string | undefined> {
    const value = (await this.#read())[name];
    return value && value.length > 0 ? value : undefined;
  }

  async set(name: SecretName, value: string): Promise<void> {
    const data = await this.#read();
    data[name] = value;
    await this.#write(data);
  }

  async delete(name: SecretName): Promise<void> {
    const data = await this.#read();
    delete data[name];
    if (Object.keys(data).length === 0) {
      await rm(this.#file, { force: true });
      return;
    }
    await this.#write(data);
  }
}

export type ApiKeySource = "env" | "store";

export interface ResolvedApiKey {
  value: string;
  source: ApiKeySource;
}

/** Environment variable first, then the secret store. */
export async function resolveApiKey(
  store: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedApiKey | undefined> {
  const fromEnv = env[ENV.typesafeApiKey];
  if (fromEnv && fromEnv.trim().length > 0) {
    return { value: fromEnv.trim(), source: "env" };
  }
  const stored = await store.get(TYPESAFE_API_KEY_SECRET);
  if (stored) {
    return { value: stored, source: "store" };
  }
  return undefined;
}

const VISIBLE_SUFFIX = 4;
const MASK = "****";

/** `****abcd` style, never more than the last four characters. */
export function maskSecret(value: string): string {
  if (value.length <= VISIBLE_SUFFIX) {
    return MASK;
  }
  return `${MASK}${value.slice(-VISIBLE_SUFFIX)}`;
}

export const REDACTED = "[REDACTED]";

/** Replace any occurrence of known secrets inside a text before it is logged. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length === 0) {
      continue;
    }
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Copy of the environment with the TypeSafe key removed, for child processes. */
export function envWithoutSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[ENV.typesafeApiKey];
  return copy;
}
