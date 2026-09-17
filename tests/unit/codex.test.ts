import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAuthStatus } from "../../src/codex/auth.js";
import { detectCodex } from "../../src/codex/detect.js";
import { parseCodexJsonl } from "../../src/codex/parser.js";
import { buildPrompt, CodexWorkerAdapter } from "../../src/codex/worker.js";
import { redact } from "../../src/security/secrets.js";
import { makeTmpDir, removeTmpDir } from "../helpers/tmp.js";

const FAKE = join(process.cwd(), "tests", "fixtures", "fake-codex.sh");
const MISSING = join(process.cwd(), "tests", "fixtures", "no-such-codex");

function withMode(mode: string, extra: Record<string, string> = {}): () => void {
  const previous = { ...process.env };
  process.env.FAKE_CODEX_MODE = mode;
  Object.assign(process.env, extra);
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
  };
}

describe("parser", () => {
  it("extracts messages, files, commands and usage from a real event stream", async () => {
    const text = await readFile(
      join(process.cwd(), "tests", "fixtures", "codex-events.jsonl"),
      "utf8",
    );
    const run = parseCodexJsonl(text);
    expect(run.threadId).toBe("01a0aeb4-bb54-7ca2-84ac-7d2d2878c16d");
    expect(run.finalMessage).toBe("done");
    expect(run.messages).toHaveLength(2);
    expect(run.changedFiles).toEqual(["/repo/hello.txt"]);
    expect(run.commandsRun).toBe(1);
    expect(run.failedCommands).toBe(0);
    expect(run.turnCompleted).toBe(true);
    expect(run.usage).toEqual({ inputTokens: 32469, outputTokens: 71 });
    expect(run.malformedLines).toBe(0);
  });

  it("counts malformed lines and ignores unknown events", () => {
    const run = parseCodexJsonl(
      'garbage\n{"type":"thread.started"\n{"type":"future.event"}\n{"type":"turn.failed","error":{"message":"boom"}}\n',
    );
    expect(run.malformedLines).toBe(2);
    expect(run.turnFailed).toBe(true);
    expect(run.errors).toEqual(["boom"]);
  });
});

describe("detection and auth", () => {
  let restore: () => void;

  afterEach(() => restore?.());

  it("reports a missing binary without throwing", async () => {
    restore = withMode("ok");
    const detection = await detectCodex(MISSING);
    expect(detection.installed).toBe(false);
    expect(detection.error).toMatch(/not found/);
    const auth = await codexAuthStatus(MISSING);
    expect(auth.authenticated).toBe(false);
  });

  it("parses the version", async () => {
    restore = withMode("ok");
    const detection = await detectCodex(FAKE);
    expect(detection).toMatchObject({ installed: true, version: "9.9.9" });
  });

  it("detects unauthenticated and authenticated states", async () => {
    restore = withMode("login-none");
    expect(await codexAuthStatus(FAKE)).toMatchObject({
      authenticated: false,
      detail: "Not logged in",
    });
    restore();
    restore = withMode("login-ok");
    expect(await codexAuthStatus(FAKE)).toMatchObject({ authenticated: true, method: "chatgpt" });
  });
});

describe("CodexWorkerAdapter", () => {
  let dir: string;
  let restore: () => void;

  beforeEach(async () => {
    dir = await makeTmpDir();
  });

  afterEach(async () => {
    restore?.();
    await removeTmpDir(dir);
  });

  it("builds sandboxed exec args, prompt over stdin, never bypass flags", () => {
    const adapter = new CodexWorkerAdapter({ model: "gpt-5-codex" });
    const args = adapter.buildArgs(
      { id: "w", task: "t", cwd: "/w t", sandbox: "read_only" },
      "/tmp/last",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "-C",
      "/w t",
      "--output-last-message",
      "/tmp/last",
      "--model",
      "gpt-5-codex",
      "-",
    ]);
    const write = adapter.buildArgs(
      { id: "w", task: "t", cwd: "/w", sandbox: "workspace_write" },
      "/tmp/last",
    );
    expect(write).toContain("workspace-write");
    expect(write.join(" ")).not.toMatch(/dangerously|full-auto/);
  });

  it("runs a successful worker and reports changed files relative to cwd", async () => {
    const promptFile = join(dir, "prompt.txt");
    restore = withMode("ok", { FAKE_CODEX_PROMPT_FILE: promptFile });
    const adapter = new CodexWorkerAdapter({ binary: FAKE });
    expect(await adapter.isAvailable()).toBe(true);
    const events: string[] = [];
    const result = await adapter.run({
      id: "backend",
      task: "Create hello.txt; $(rm -rf /) `whoami`",
      context: "Only touch hello.txt",
      cwd: dir,
      sandbox: "workspace_write",
      onEvent: (e) => events.push(e.kind),
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.changedFiles).toEqual(["hello.txt"]);
    expect(result.commandsRun).toBe(1);
    expect(result.summary).toMatch(/Created hello.txt/);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(events).toEqual(["message", "file_change", "command", "message"]);
    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("hello\n");
    // The task text reached the worker verbatim through stdin, never through a shell.
    const prompt = await readFile(promptFile, "utf8");
    expect(prompt).toContain("$(rm -rf /) `whoami`");
    expect(prompt).toContain("## Context\nOnly touch hello.txt");
  });

  it("reports a failed worker with the error and exit code", async () => {
    restore = withMode("fail");
    const adapter = new CodexWorkerAdapter({ binary: FAKE });
    const result = await adapter.run({ id: "w", task: "t", cwd: dir, sandbox: "workspace_write" });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe("tests failed");
  });

  it("survives a malformed event stream", async () => {
    restore = withMode("malformed");
    const adapter = new CodexWorkerAdapter({ binary: FAKE });
    const result = await adapter.run({ id: "w", task: "t", cwd: dir, sandbox: "workspace_write" });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("recovered");
  });

  it("strips the TypeSafe key from the worker environment and redacts leaks", async () => {
    const promptFile = join(dir, "prompt.txt");
    restore = withMode("ok", {
      FAKE_CODEX_PROMPT_FILE: promptFile,
      TYPESAFE_API_KEY: "ts-super-secret-key",
    });
    const adapter = new CodexWorkerAdapter({ binary: FAKE });
    const result = await adapter.run({ id: "w", task: "t", cwd: dir, sandbox: "workspace_write" });
    expect(result.status).toBe("completed");
    const childEnv = await readFile(join(dir, "env.txt"), "utf8");
    expect(childEnv).not.toContain("TYPESAFE_API_KEY=");
    expect(redact("key ts-super-secret-key here", [process.env.TYPESAFE_API_KEY])).toBe(
      "key [REDACTED] here",
    );
  });

  it("reports a timed out worker", async () => {
    restore = withMode("slow");
    const adapter = new CodexWorkerAdapter({ binary: FAKE });
    const result = await adapter.run({
      id: "w",
      task: "t",
      cwd: dir,
      sandbox: "workspace_write",
      timeoutMs: 200,
    });
    expect(result.status).toBe("timed_out");
  });

  it("reports a missing binary as a failed worker with install hint", async () => {
    const adapter = new CodexWorkerAdapter({ binary: MISSING });
    expect(await adapter.isAvailable()).toBe(false);
    const result = await adapter.run({ id: "w", task: "t", cwd: dir, sandbox: "workspace_write" });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/npm install -g @openai\/codex/);
  });

  it("buildPrompt puts the task first and asks for a summary", () => {
    const prompt = buildPrompt({ id: "w", task: "Do X", cwd: ".", sandbox: "read_only" });
    expect(prompt.startsWith("Do X\n")).toBe(true);
    expect(prompt).toMatch(/## Reporting/);
  });
});
