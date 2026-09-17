/**
 * Parser for `codex exec --json` JSONL output (Codex CLI 0.1xx).
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"...","kind":"add"}],"status":"completed"}}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"...","exit_code":0,...}}
 *   {"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *
 * Unknown event and item types are ignored so newer Codex versions degrade
 * gracefully; unparsable lines are counted, not thrown.
 */

export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ParsedCodexRun {
  threadId?: string;
  messages: string[];
  /** Last agent message, the closest thing to a worker summary. */
  finalMessage?: string;
  changedFiles: string[];
  commandsRun: number;
  failedCommands: number;
  turnCompleted: boolean;
  turnFailed: boolean;
  errors: string[];
  usage?: CodexUsage;
  malformedLines: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  status?: string;
  command?: string;
  exit_code?: number;
  changes?: { path?: string; kind?: string }[];
  message?: string;
}

export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function emptyRun(): ParsedCodexRun {
  return {
    messages: [],
    changedFiles: [],
    commandsRun: 0,
    failedCommands: 0,
    turnCompleted: false,
    turnFailed: false,
    errors: [],
    malformedLines: 0,
  };
}

/** Feed one JSONL line; returns the parsed event when it was valid JSON. */
export function applyLine(run: ParsedCodexRun, line: string): CodexEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    run.malformedLines += 1;
    return undefined;
  }
  if (!isRecord(event)) {
    run.malformedLines += 1;
    return undefined;
  }
  const ev = event as CodexEvent;
  switch (ev.type) {
    case "thread.started":
      if (typeof ev.thread_id === "string") {
        run.threadId = ev.thread_id;
      }
      break;
    case "turn.completed":
      run.turnCompleted = true;
      if (ev.usage) {
        run.usage = {
          inputTokens: ev.usage.input_tokens ?? 0,
          outputTokens: ev.usage.output_tokens ?? 0,
        };
      }
      break;
    case "turn.failed":
      run.turnFailed = true;
      run.errors.push(errorText(ev));
      break;
    case "error":
      run.errors.push(errorText(ev));
      break;
    case "item.completed":
      applyItem(run, ev.item);
      break;
    default:
      break;
  }
  return ev;
}

function errorText(ev: CodexEvent): string {
  if (typeof ev.error === "string") {
    return ev.error;
  }
  return ev.error?.message ?? ev.message ?? "unknown error";
}

function applyItem(run: ParsedCodexRun, item: CodexItem | undefined): void {
  if (!item) {
    return;
  }
  switch (item.type) {
    case "agent_message":
      if (typeof item.text === "string" && item.text.length > 0) {
        run.messages.push(item.text);
        run.finalMessage = item.text;
      }
      break;
    case "command_execution":
      run.commandsRun += 1;
      if (typeof item.exit_code === "number" && item.exit_code !== 0) {
        run.failedCommands += 1;
      }
      break;
    case "file_change":
      for (const change of item.changes ?? []) {
        if (typeof change.path === "string" && !run.changedFiles.includes(change.path)) {
          run.changedFiles.push(change.path);
        }
      }
      break;
    case "error":
      run.errors.push(item.message ?? item.text ?? "unknown error");
      break;
    default:
      break;
  }
}

export function parseCodexJsonl(text: string): ParsedCodexRun {
  const run = emptyRun();
  for (const line of text.split("\n")) {
    applyLine(run, line);
  }
  return run;
}
