import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import { z } from "zod";
import { DEFAULT_JEV_MODEL, DEFAULT_JEV_TIMEOUT_MS } from "../config/schema.js";
import {
  type Answers,
  type ChoiceQuestion,
  type DecisionEngine,
  type DecisionRequest,
  type DecisionResult,
  type DecisionSchema,
  JevError,
  type Question,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 2;

export interface TypeSafeEngineOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Retries for transient failures only (429, 5xx, timeouts, connection errors). */
  maxRetries?: number;
  /** Injected for tests. */
  fetch?: typeof globalThis.fetch;
}

const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()),
  legend: z.record(z.string(), z.string()),
  confidence: z.number().min(0).max(1),
});
const answerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial(),
});

function mapError(err: unknown): JevError {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new JevError(
      "auth",
      "TypeSafe rejected the API key (401/403). Check TYPESAFE_API_KEY.",
      {
        status: err.status,
        cause: err,
      },
    );
  }
  if (err instanceof RateLimitError) {
    return new JevError("rate_limit", "TypeSafe rate limit reached (429).", {
      status: err.status,
      cause: err,
    });
  }
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    return new JevError("bad_request", `TypeSafe rejected the request: ${err.message}`, {
      status: err.status,
      cause: err,
    });
  }
  if (err instanceof InternalServerError) {
    return new JevError("server", `TypeSafe server error (${err.status}).`, {
      status: err.status,
      cause: err,
    });
  }
  if (err instanceof APIError) {
    return new JevError("unknown", err.message, { status: err.status, cause: err });
  }
  if (err instanceof APITimeoutError) {
    return new JevError("timeout", "TypeSafe request timed out.", { cause: err });
  }
  if (err instanceof APIConnectionError) {
    return new JevError("network", `Could not reach TypeSafe: ${err.message}`, { cause: err });
  }
  if (err instanceof TypeSafeError) {
    return new JevError("bad_request", err.message, { cause: err });
  }
  return new JevError("unknown", err instanceof Error ? err.message : String(err), { cause: err });
}

function assertChoiceCoverage(id: string, question: ChoiceQuestion, choice: string): void {
  if (!(choice in question.criteria)) {
    throw new JevError(
      "malformed_response",
      `Answer "${id}" chose "${choice}", not one of the offered options.`,
    );
  }
}

/** DecisionEngine backed by TypeSafe's `POST /v1/systemone` via the official SDK. */
export class TypeSafeDecisionEngine implements DecisionEngine {
  readonly id = "typesafe";
  readonly #client: TypeSafeClient;
  readonly #model: string;

  constructor(options: TypeSafeEngineOptions) {
    this.#model = options.model ?? DEFAULT_JEV_MODEL;
    this.#client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.#model,
      timeout: options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS,
      logLevel: "off",
      retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async decide<T extends DecisionSchema>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.#client.systemOne(
        {
          state: request.state,
          questions: request.questions,
          model: request.model ?? this.#model,
        },
        request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs },
      );
    } catch (err) {
      throw mapError(err);
    }

    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new JevError(
        "malformed_response",
        `Unexpected TypeSafe response: ${z.prettifyError(parsed.error)}`,
      );
    }

    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(request.questions) as [string, Question][]) {
      const answer = parsed.data.answers[id];
      if (!answer || answer.type !== question.type) {
        throw new JevError(
          "malformed_response",
          `Missing or mistyped answer for question "${id}".`,
        );
      }
      if (answer.type === "noul") {
        answers[id] = { type: "noul", probability: answer.noul };
        continue;
      }
      if (answer.type === "choice") {
        assertChoiceCoverage(id, question as ChoiceQuestion, answer.choice);
        answers[id] = answer;
        continue;
      }
      answers[id] = answer;
    }

    return {
      id: request.id,
      model: parsed.data.model,
      answers: answers as Answers<T>,
      usage: {
        inputTokens: parsed.data.usage.input_tokens ?? 0,
        outputTokens: parsed.data.usage.output_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
    };
  }

  /** `GET /v1/models`; cheap credential and reachability check. */
  async listModels(): Promise<string[]> {
    try {
      const models = await this.#client.models.list();
      return models.map((m) => m.name);
    } catch (err) {
      throw mapError(err);
    }
  }
}
