import { describe, expect, it, vi } from "vitest";
import { TypeSafeDecisionEngine } from "../../src/jev/client.js";
import { choice, JevError, noul, score } from "../../src/jev/types.js";

type FetchImpl = typeof globalThis.fetch;

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const okBody = {
  model: "jev-1.13.0",
  answers: {
    strategy: {
      type: "choice",
      choice: "parallel_codex",
      probabilities: { parallel_codex: 0.89, claude_direct: 0.11 },
      confidence: 0.82,
    },
    trivial: { type: "noul", noul: 0.04 },
    risk: {
      type: "score",
      score: 0.4,
      legend: { "0": "low", "1": "high" },
      probabilities: { "0": 0.6, "1": 0.4 },
      confidence: 0.7,
    },
  },
  usage: { input_tokens: 300, output_tokens: 12 },
};

const questions = {
  strategy: choice("Which?", { parallel_codex: null, claude_direct: null }),
  trivial: noul("Trivial?"),
  risk: score("Risk?", ["low", "high"]),
};

function engine(
  fetchImpl: FetchImpl,
  extra: Partial<ConstructorParameters<typeof TypeSafeDecisionEngine>[0]> = {},
) {
  return new TypeSafeDecisionEngine({
    apiKey: "ts-test-key",
    fetch: fetchImpl,
    timeoutMs: 500,
    ...extra,
  });
}

describe("TypeSafeDecisionEngine", () => {
  it("posts to /v1/systemone with bearer auth and maps typed answers", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer ts-test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("jev-latest");
      expect(body.questions.strategy.type).toBe("choice");
      return jsonResponse(200, okBody);
    });
    const result = await engine(fetchImpl).decide({ id: "t", state: { goal: "x" }, questions });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.strategy.choice).toBe("parallel_codex");
    expect(result.answers.strategy.confidence).toBe(0.82);
    expect(result.answers.strategy.probabilities.claude_direct).toBe(0.11);
    expect(result.answers.trivial.probability).toBe(0.04);
    expect(result.answers.risk.score).toBe(0.4);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 12 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to an auth error without retrying", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(401, { error: "bad key" }));
    const err = await engine(fetchImpl)
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe("auth");
    expect((err as JevError).retryable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry 422 bad requests", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse(422, { detail: "criteria missing" }),
    );
    const err = await engine(fetchImpl)
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect((err as JevError).kind).toBe("bad_request");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with backoff then reports rate_limit", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse(429, { error: "slow down" }, { "retry-after-ms": "1" }),
    );
    const err = await engine(fetchImpl, { maxRetries: 2 })
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect((err as JevError).kind).toBe("rate_limit");
    expect((err as JevError).retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, { error: "overloaded" }, { "retry-after-ms": "1" })
        : jsonResponse(200, okBody);
    });
    const result = await engine(fetchImpl, { maxRetries: 2 }).decide({
      id: "t",
      state: "s",
      questions,
    });
    expect(result.answers.strategy.choice).toBe("parallel_codex");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out and reports timeout", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const err = await engine(fetchImpl, { timeoutMs: 30, maxRetries: 0 })
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect((err as JevError).kind).toBe("timeout");
  });

  it("rejects a malformed response body", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse(200, { model: "jev", answers: { strategy: { type: "choice" } } }),
    );
    const err = await engine(fetchImpl)
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect((err as JevError).kind).toBe("malformed_response");
  });

  it("rejects a choice outside the offered options", async () => {
    const body = structuredClone(okBody);
    body.answers.strategy.choice = "gemini";
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, body));
    const err = await engine(fetchImpl)
      .decide({ id: "t", state: "s", questions })
      .catch((e) => e);
    expect((err as JevError).kind).toBe("malformed_response");
  });

  it("listModels hits /v1/models", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/models");
      return jsonResponse(200, {
        models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }],
      });
    });
    expect(await engine(fetchImpl).listModels()).toEqual(["jev-latest"]);
  });
});
