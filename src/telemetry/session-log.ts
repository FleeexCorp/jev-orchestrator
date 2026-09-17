import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { userConfigDir } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { ensureExcluded } from "../git/exclude.js";
import type {
  Answers,
  DecisionEngine,
  DecisionRequest,
  DecisionResult,
  DecisionSchema,
  DecisionState,
  Question,
} from "../jev/types.js";
import { JevError } from "../jev/types.js";

export const SESSION_ENV = "JEV_SESSION";
const TOKENS_PER_MTOK = 1_000_000;
const SESSION_FILE_EXT = ".jsonl";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

/** One Jev HTTP call as seen by the recording engine. */
export interface JevCallRecord {
  requestId: string;
  engine: string;
  model?: string;
  questions: Record<string, { type: Question["type"]; options?: string[] }>;
  stateBytes: number;
  state?: DecisionState;
  answers?: Answers<DecisionSchema>;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  error?: { kind: string; message: string };
}

export interface DecisionRecord {
  type: "decision";
  at: string;
  session: string;
  kind: string;
  calls: JevCallRecord[];
  /** What the CLI told Claude, after policy. */
  outcome?: {
    recommendation?: string;
    confidence?: number;
    tier?: string;
    policyNotes?: string[];
    /** For multi-assignment decisions (parallel, worker). */
    assignments?: { id: string; choice: string }[];
  };
  error?: { kind: string; message: string };
}

export interface WorkerRecord {
  type: "worker";
  at: string;
  session: string;
  id: string;
  adapter: string;
  model?: string;
  sandbox: string;
  status: string;
  durationMs: number;
  changedFiles: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export type SessionRecord = DecisionRecord | WorkerRecord;

/** Session id: --session flag, then JEV_SESSION, then today's date. */
export function resolveSessionId(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate =
    flag ?? env[SESSION_ENV] ?? new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  if (!SESSION_ID_PATTERN.test(candidate)) {
    throw new Error(
      `Invalid session id "${candidate}"; use letters, digits, dot, dash or underscore.`,
    );
  }
  return candidate;
}

/**
 * Wraps any engine and records every call: questions, answers, tokens,
 * latency, errors. The wrapped engine's behaviour is unchanged.
 */
export class RecordingEngine implements DecisionEngine {
  readonly id: string;
  readonly calls: JevCallRecord[] = [];
  readonly #inner: DecisionEngine;
  readonly #recordState: boolean;

  constructor(inner: DecisionEngine, recordState = false) {
    this.#inner = inner;
    this.id = inner.id;
    this.#recordState = recordState;
  }

  async decide<T extends DecisionSchema>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const started = Date.now();
    const record: JevCallRecord = {
      requestId: request.id,
      engine: this.#inner.id,
      ...(request.model ? { model: request.model } : {}),
      questions: describeQuestions(request.questions),
      stateBytes: Buffer.byteLength(JSON.stringify(request.state), "utf8"),
      ...(this.#recordState ? { state: request.state } : {}),
      latencyMs: 0,
    };
    this.calls.push(record);
    try {
      const result = await this.#inner.decide(request);
      record.model = result.model;
      record.answers = result.answers as Answers<DecisionSchema>;
      record.usage = result.usage;
      record.latencyMs = result.latencyMs;
      return result;
    } catch (err) {
      record.latencyMs = Date.now() - started;
      record.error =
        err instanceof JevError
          ? { kind: err.kind, message: err.message }
          : { kind: "unknown", message: (err as Error).message };
      throw err;
    }
  }
}

function describeQuestions(questions: DecisionSchema): JevCallRecord["questions"] {
  const out: JevCallRecord["questions"] = {};
  for (const [id, q] of Object.entries(questions)) {
    out[id] =
      q.type === "choice" ? { type: q.type, options: Object.keys(q.criteria) } : { type: q.type };
  }
  return out;
}

export interface SessionSummary {
  session: string;
  decisions: number;
  failedDecisions: number;
  byKind: Record<string, number>;
  byTier: Record<string, number>;
  policyOverrides: number;
  jevCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, from `sessions.inputPricePerMtok`; output tokens are free per TypeSafe pricing. */
  estimatedCostUsd: number;
  totalJevLatencyMs: number;
  meanJevLatencyMs: number;
  mockCalls: number;
  workers: {
    runs: number;
    byStatus: Record<string, number>;
    totalDurationMs: number;
    inputTokens: number;
    outputTokens: number;
  };
  firstAt?: string;
  lastAt?: string;
}

export function summarize(
  session: string,
  records: SessionRecord[],
  inputPricePerMtok: number,
): SessionSummary {
  const s: SessionSummary = {
    session,
    decisions: 0,
    failedDecisions: 0,
    byKind: {},
    byTier: {},
    policyOverrides: 0,
    jevCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalJevLatencyMs: 0,
    meanJevLatencyMs: 0,
    mockCalls: 0,
    workers: { runs: 0, byStatus: {}, totalDurationMs: 0, inputTokens: 0, outputTokens: 0 },
  };
  for (const r of records) {
    s.firstAt = s.firstAt ?? r.at;
    s.lastAt = r.at;
    if (r.type === "worker") {
      s.workers.runs += 1;
      s.workers.byStatus[r.status] = (s.workers.byStatus[r.status] ?? 0) + 1;
      s.workers.totalDurationMs += r.durationMs;
      s.workers.inputTokens += r.usage?.inputTokens ?? 0;
      s.workers.outputTokens += r.usage?.outputTokens ?? 0;
      continue;
    }
    s.decisions += 1;
    s.byKind[r.kind] = (s.byKind[r.kind] ?? 0) + 1;
    if (r.error) {
      s.failedDecisions += 1;
    }
    if (r.outcome?.tier) {
      s.byTier[r.outcome.tier] = (s.byTier[r.outcome.tier] ?? 0) + 1;
    }
    if ((r.outcome?.policyNotes?.length ?? 0) > 0) {
      s.policyOverrides += 1;
    }
    for (const c of r.calls) {
      s.jevCalls += 1;
      s.totalJevLatencyMs += c.latencyMs;
      if (c.engine === "mock") {
        s.mockCalls += 1;
        continue;
      }
      s.inputTokens += c.usage?.inputTokens ?? 0;
      s.outputTokens += c.usage?.outputTokens ?? 0;
    }
  }
  s.meanJevLatencyMs = s.jevCalls > 0 ? Math.round(s.totalJevLatencyMs / s.jevCalls) : 0;
  s.estimatedCostUsd = (s.inputTokens / TOKENS_PER_MTOK) * inputPricePerMtok;
  return s;
}

/** Append-only JSONL, one file per session. */
export class SessionLog {
  readonly directory: string;
  readonly #root: string | undefined;

  constructor(directory: string, root?: string) {
    this.directory = directory;
    this.#root = root;
  }

  /** `.jev/sessions` under the repo root, or the user config dir outside a repo. */
  static forConfig(
    config: Config,
    projectRoot: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): SessionLog {
    const configured = config.sessions.directory;
    if (isAbsolute(configured)) {
      return new SessionLog(configured);
    }
    if (projectRoot) {
      return new SessionLog(resolve(projectRoot, configured), projectRoot);
    }
    return new SessionLog(join(userConfigDir(env), "sessions"));
  }

  file(session: string): string {
    return join(this.directory, `${session}${SESSION_FILE_EXT}`);
  }

  async append(record: SessionRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if (this.#root) {
      await ensureExcluded(this.#root, this.directory);
    }
    await appendFile(this.file(record.session), `${JSON.stringify(record)}\n`, "utf8");
  }

  async read(session: string): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(session), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: SessionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        out.push(JSON.parse(line) as SessionRecord);
      } catch {
        /* a torn line from a crashed write; skip it */
      }
    }
    return out;
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.directory);
      return names
        .filter((n) => n.endsWith(SESSION_FILE_EXT))
        .map((n) => basename(n, SESSION_FILE_EXT))
        .sort();
    } catch {
      return [];
    }
  }
}
