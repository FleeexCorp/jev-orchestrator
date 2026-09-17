import { readdir, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSecretStore,
  maskSecret,
  redact,
  resolveApiKey,
  TYPESAFE_API_KEY_SECRET,
} from "../../src/security/secrets.js";
import { type FakeHome, makeFakeHome, removeTmpDir } from "../helpers/tmp.js";

describe("FileSecretStore", () => {
  let fake: FakeHome;

  beforeEach(async () => {
    fake = await makeFakeHome();
  });

  afterEach(async () => {
    await removeTmpDir(fake.home);
  });

  it("stores with mode 0600 under the user config dir", async () => {
    const store = FileSecretStore.forEnv(fake.env);
    await store.set(TYPESAFE_API_KEY_SECRET, "ts-secret-123");
    expect(await store.get(TYPESAFE_API_KEY_SECRET)).toBe("ts-secret-123");
    const mode = (await stat(store.describe())).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.describe().startsWith(fake.home)).toBe(true);
  });

  it("deletes and removes the file when empty", async () => {
    const store = FileSecretStore.forEnv(fake.env);
    await store.set(TYPESAFE_API_KEY_SECRET, "x".repeat(12));
    await store.delete(TYPESAFE_API_KEY_SECRET);
    expect(await store.get(TYPESAFE_API_KEY_SECRET)).toBeUndefined();
    await expect(stat(store.describe())).rejects.toThrow();
  });

  it("resolveApiKey prefers the environment variable", async () => {
    const store = FileSecretStore.forEnv(fake.env);
    await store.set(TYPESAFE_API_KEY_SECRET, "stored-key-1234");
    expect(await resolveApiKey(store, { TYPESAFE_API_KEY: " env-key-5678 " })).toEqual({
      value: "env-key-5678",
      source: "env",
    });
    expect(await resolveApiKey(store, {})).toEqual({ value: "stored-key-1234", source: "store" });
    await store.delete(TYPESAFE_API_KEY_SECRET);
    expect(await resolveApiKey(store, { TYPESAFE_API_KEY: "" })).toBeUndefined();
  });

  it("never writes anything into a project directory", async () => {
    const store = FileSecretStore.forEnv(fake.env);
    await store.set(TYPESAFE_API_KEY_SECRET, "stored-key-1234");
    const entries = await readdir(fake.home);
    expect(entries).toEqual([".config"]);
  });
});

describe("masking", () => {
  it("shows at most four trailing characters", () => {
    expect(maskSecret("abcdefgh")).toBe("****efgh");
    expect(maskSecret("ab")).toBe("****");
  });

  it("redacts every occurrence", () => {
    expect(redact("key=abc and abc again", ["abc", ""])).toBe(
      "key=[REDACTED] and [REDACTED] again",
    );
  });
});
