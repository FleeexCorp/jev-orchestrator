/** JSON-compatible value accepted as decision state. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Top-level state accepted by the API: text or structured data. */
export type DecisionState = string | JsonObject | JsonValue[];

/** Yes/no question. Answer is the probability of "yes". */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

/** Pick one option from a fixed set. Answer carries the full distribution. */
export interface ChoiceQuestion<Option extends string = string> {
  type: "choice";
  instructions: string;
  /** Option -> rubric. `null` means the option needs no description. */
  criteria: Record<Option, string | null>;
}

/** Ordered rubric; answer is a probability-weighted level index. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: readonly [string, string, ...string[]];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type DecisionSchema = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** Probability that the answer is yes, 0..1. */
  probability: number;
}

export interface ChoiceAnswer<Option extends string = string> {
  type: "choice";
  choice: Option;
  probabilities: Record<Option, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
  confidence: number;
}

export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type Answers<T extends DecisionSchema> = { [K in keyof T]: AnswerFor<T[K]> };

export interface DecisionRequest<T extends DecisionSchema> {
  /** Stable identifier for logs; not sent to the model. */
  id: string;
  state: DecisionState;
  questions: T;
  model?: string;
  timeoutMs?: number;
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult<T extends DecisionSchema> {
  id: string;
  model: string;
  answers: Answers<T>;
  usage: DecisionUsage;
  latencyMs: number;
}

/**
 * The only thing orchestration code depends on. TypeSafe Jev is the first
 * implementation; a mock engine backs tests and the offline demo.
 */
export interface DecisionEngine {
  readonly id: string;
  decide<T extends DecisionSchema>(request: DecisionRequest<T>): Promise<DecisionResult<T>>;
}

export type JevErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "bad_request"
  | "malformed_response"
  | "unknown";

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status: number | undefined;
  /** True when a later retry could succeed without changing the request. */
  readonly retryable: boolean;

  constructor(
    kind: JevErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JevError";
    this.kind = kind;
    this.status = options.status;
    this.retryable =
      kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "server";
  }
}

/** Short builders keep decision definitions readable. */
export const noul = (instructions: string, criteria?: NoulQuestion["criteria"]): NoulQuestion =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

export const choice = <const O extends string>(
  instructions: string,
  criteria: Record<O, string | null>,
): ChoiceQuestion<O> => ({ type: "choice", instructions, criteria });

export const score = (
  instructions: string,
  criteria: ScoreQuestion["criteria"],
): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});
