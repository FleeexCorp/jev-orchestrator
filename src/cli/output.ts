import pc from "picocolors";
import type { Decision, Signal } from "../orchestration/decision.js";
import type { ParallelizationDecision } from "../orchestration/parallel.js";
import type { WorkerDecision } from "../orchestration/worker.js";
import type { WorkerCandidate } from "../workers/catalog.js";

export type OutputMode = "normal" | "verbose" | "json";

const PROB_WIDTH = 4;
const LABEL_WIDTH = 26;
const YES_NO_WIDTH = 4;
const SYMBOL = { ok: pc.green("✓"), fail: pc.red("✗"), warn: pc.yellow("!"), info: pc.dim("·") };

export interface OutputOptions {
  mode: OutputMode;
  stream?: NodeJS.WriteStream;
}

/** All human-facing printing goes through here so `--json` stays parseable. */
export class Reporter {
  readonly mode: OutputMode;
  readonly #out: NodeJS.WriteStream;

  constructor(options: OutputOptions) {
    this.mode = options.mode;
    this.#out = options.stream ?? process.stdout;
  }

  get json(): boolean {
    return this.mode === "json";
  }

  get verbose(): boolean {
    return this.mode === "verbose";
  }

  line(text = ""): void {
    if (this.json) {
      return;
    }
    this.#out.write(`${text}\n`);
  }

  title(text: string): void {
    this.line(pc.bold(text));
  }

  section(text: string): void {
    this.line();
    this.line(pc.bold(text));
  }

  ok(text: string): void {
    this.line(`${SYMBOL.ok} ${text}`);
  }

  #annotated(symbol: string, text: string, fix?: string): void {
    this.line(`${symbol} ${text}`);
    if (fix) {
      for (const l of fix.split("\n")) {
        this.line(`  ${pc.dim(l)}`);
      }
    }
  }

  /** In json mode an error is still emitted, as `{ "error": ..., "fix": ... }`. */
  fail(text: string, fix?: string): void {
    if (this.json) {
      this.emitJson({ error: text, ...(fix ? { fix } : {}) });
      return;
    }
    this.#annotated(SYMBOL.fail, text, fix);
  }

  warn(text: string, fix?: string): void {
    this.#annotated(SYMBOL.warn, text, fix);
  }

  info(text: string): void {
    this.line(`${SYMBOL.info} ${text}`);
  }

  /** Emit JSON regardless of mode (used for `--json`). */
  emitJson(value: unknown): void {
    this.#out.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * JEV  execution_strategy
   *      parallel_codex     0.89
   *      single_codex       0.07
   */
  jevBlock(id: string, probabilities: Record<string, number>, top?: string): void {
    this.line(`${pc.cyan("JEV ")} ${id}`);
    const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    for (const [option, p] of sorted) {
      const text = `     ${option.padEnd(LABEL_WIDTH)}${p.toFixed(2).padStart(PROB_WIDTH)}`;
      this.line(option === top ? pc.bold(text) : pc.dim(text));
    }
  }

  signalBlock(signals: Record<string, Signal>): void {
    for (const [id, s] of Object.entries(signals)) {
      const yesNo = (s.yes ? "yes" : "no").padEnd(YES_NO_WIDTH);
      this.line(pc.dim(`     ${id.padEnd(LABEL_WIDTH)}${yesNo}${s.probability.toFixed(2)}`));
    }
  }

  codexBlock(id: string, status: string, detail?: string): void {
    this.line(`${pc.magenta("CODEX")} ${id}`);
    this.line(`      ${status.padEnd(LABEL_WIDTH - YES_NO_WIDTH)}${detail ? pc.dim(detail) : ""}`);
  }

  decision(d: Decision): void {
    if (this.json) {
      this.emitJson(d);
      return;
    }
    if (this.verbose) {
      this.jevBlock(d.kind, d.probabilities, d.recommendation);
      this.signalBlock(d.signals);
      this.line();
    }
    this.line(
      `${pc.bold(d.recommendation)}  ${tierBadge(d.tier)} ${pc.dim(d.confidence.toFixed(2))}`,
    );
    this.line(pc.dim(d.guidance));
    for (const note of d.policyNotes) {
      this.line(`${SYMBOL.warn} ${note}`);
    }
  }

  workers(d: WorkerDecision): void {
    if (this.json) {
      this.emitJson(d);
      return;
    }
    for (const a of d.assignments) {
      if (this.verbose) {
        this.jevBlock(`worker_${a.taskId}`, a.probabilities, a.candidateId);
        this.line(
          pc.dim(
            `     difficulty${" ".repeat(LABEL_WIDTH - "difficulty".length)}${a.difficulty.toFixed(1)}`,
          ),
        );
      }
      this.line(
        `${pc.bold(a.taskId.padEnd(16))} ${a.candidateId.padEnd(24)} ${tierBadge(a.tier)} ${pc.dim(a.confidence.toFixed(2))}`,
      );
      this.line(pc.dim(`  ${a.dispatch}`));
      for (const note of a.policyNotes) {
        this.line(`  ${SYMBOL.warn} ${note}`);
      }
    }
  }

  catalog(candidates: WorkerCandidate[]): void {
    if (this.json) {
      this.emitJson(candidates);
      return;
    }
    for (const c of candidates) {
      this.line(
        `${c.id.padEnd(28)} ${c.tier.padEnd(9)} ${pc.dim(c.source.padEnd(12))} ${c.description}`,
      );
    }
  }

  parallel(d: ParallelizationDecision): void {
    if (this.json) {
      this.emitJson(d);
      return;
    }
    if (this.verbose) {
      this.line(`${pc.cyan("JEV ")} parallelization`);
      this.signalBlock({ independent: d.independent, parallel_worthwhile: d.worthwhile });
      this.line();
    }
    const mode = d.runInParallel ? "parallel" : "sequential";
    this.line(
      `${pc.bold(mode)}  ${tierBadge(d.tier)} ${pc.dim(d.confidence.toFixed(2))}  workers: ${d.recommendedWorkers}`,
    );
    for (const s of d.subtasks) {
      const owner = s.suggestedWorker === "codex" ? pc.magenta("codex ") : pc.green("claude");
      const probs = `codex ${s.codexSuitable.probability.toFixed(2)} claude ${s.needsClaude.probability.toFixed(2)}`;
      this.line(`  ${owner} ${s.id.padEnd(16)} ${pc.dim(probs)}`);
    }
    this.line(pc.dim(d.guidance));
    for (const note of d.policyNotes) {
      this.line(`${SYMBOL.warn} ${note}`);
    }
  }
}

export function tierBadge(tier: Decision["tier"]): string {
  switch (tier) {
    case "autonomous":
      return pc.green("[autonomous]");
    case "advisory":
      return pc.yellow("[advisory]");
    case "fallback":
      return pc.red("[fallback]");
  }
}

export function modeFrom(opts: { json?: boolean; verbose?: boolean }): OutputMode {
  if (opts.json) {
    return "json";
  }
  return opts.verbose ? "verbose" : "normal";
}

/** Parse a CLI integer option; undefined when absent, throws on junk. */
export function intOption(
  value: string | undefined,
  name: string,
  min: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}".`);
  }
  return n;
}
