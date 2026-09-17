import type { Config } from "../config/schema.js";
import type { SecretStore } from "../security/secrets.js";
import { resolveApiKey } from "../security/secrets.js";
import { TypeSafeDecisionEngine } from "./client.js";

/** The one place that turns config plus a key into a TypeSafe engine. */
export function engineForKey(config: Config, apiKey: string): TypeSafeDecisionEngine {
  return new TypeSafeDecisionEngine({
    apiKey,
    model: config.jev.model,
    timeoutMs: config.jev.timeoutMs,
    ...(config.jev.baseUrl ? { baseUrl: config.jev.baseUrl } : {}),
  });
}

/** Resolve credentials (env first, then store) and build the engine, or undefined without a key. */
export async function createEngine(
  config: Config,
  store: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TypeSafeDecisionEngine | undefined> {
  const key = await resolveApiKey(store, env);
  if (!key) {
    return undefined;
  }
  return engineForKey(config, key.value);
}
