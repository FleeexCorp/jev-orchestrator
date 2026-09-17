import type {
  Answers,
  ChoiceQuestion,
  DecisionEngine,
  DecisionRequest,
  DecisionResult,
  DecisionSchema,
  Question,
} from "./types.js";

/** Scripted answers keyed by question id: a choice option or a noul probability. */
export type MockScript = Record<string, string | number>;

const DEFAULT_TOP_PROBABILITY = 0.9;
const NOUL_DEFAULT = 0.5;
const MOCK_LATENCY_MS = 12;

function spread<O extends string>(
  question: ChoiceQuestion<O>,
  top: O,
  topP: number,
): Record<O, number> {
  const options = Object.keys(question.criteria) as O[];
  const rest = options.length > 1 ? (1 - topP) / (options.length - 1) : 0;
  const out = {} as Record<O, number>;
  for (const option of options) {
    out[option] = option === top ? topP : rest;
  }
  return out;
}

/**
 * Deterministic engine for tests and the offline demo. Never contacts the
 * network. Unscripted choices pick the first option with modest confidence.
 */
export class MockDecisionEngine implements DecisionEngine {
  readonly id = "mock";
  readonly requests: DecisionRequest<DecisionSchema>[] = [];
  #script: MockScript;
  #topProbability: number;

  constructor(script: MockScript = {}, topProbability = DEFAULT_TOP_PROBABILITY) {
    this.#script = script;
    this.#topProbability = topProbability;
  }

  set(script: MockScript): void {
    this.#script = { ...this.#script, ...script };
  }

  async decide<T extends DecisionSchema>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    this.requests.push(request as DecisionRequest<DecisionSchema>);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(request.questions) as [string, Question][]) {
      answers[id] = this.#answer(id, question);
    }
    return {
      id: request.id,
      model: "mock",
      answers: answers as Answers<T>,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: MOCK_LATENCY_MS,
    };
  }

  #answer(id: string, question: Question): unknown {
    const scripted = this.#script[id];
    if (question.type === "noul") {
      const p = typeof scripted === "number" ? scripted : NOUL_DEFAULT;
      return { type: "noul", probability: p };
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const top =
        typeof scripted === "string" && options.includes(scripted) ? scripted : options[0];
      if (top === undefined) {
        throw new Error(`Choice "${id}" has no options`);
      }
      const probabilities = spread(question, top, this.#topProbability);
      return { type: "choice", choice: top, probabilities, confidence: this.#topProbability };
    }
    const level = typeof scripted === "number" ? scripted : 0;
    const legend: Record<string, string> = {};
    const probabilities: Record<string, number> = {};
    question.criteria.forEach((label, index) => {
      legend[String(index)] = label;
      probabilities[String(index)] = index === Math.round(level) ? 1 : 0;
    });
    return { type: "score", score: level, probabilities, legend, confidence: this.#topProbability };
  }
}
