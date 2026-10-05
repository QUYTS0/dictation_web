/** Real SDK error handling with fetch mocked: no provider call or quota spend. */
import { GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { callGeminiAdmitted, type GeminiCallRequest } from "@/lib/ai/geminiCall";
import { geminiErrorDiagnostics, geminiFailureMessage } from "@/lib/ai/geminiErrors";
import { OVERVIEW_SCHEMA } from "@/lib/ai/assessmentPrompt";

const SECRET = "test-secret-that-must-not-be-logged";
const LEARNER_TEXT = "private learner text that must not be logged";
const request: GeminiCallRequest = {
  apiKey: SECRET,
  model: "gemini-test-model",
  prompt: LEARNER_TEXT,
  responseSchema: OVERVIEW_SCHEMA,
  maxOutputTokens: 8192,
  timeoutMs: 55_000,
  admission: { operationType: "assessment", operationId: "test-operation", attempt: 1, userId: "user-1" },
  logTag: "ai/assessment",
};
const admit = jest.fn(async () => ({ status: "admitted" as const, key: "test-admission" }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  // No real network is possible, including if a test forgets its response.
  jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("reproduces why the original SDK log printed only Error", () => {
  const error = new GoogleGenerativeAIFetchError("quota exceeded", 429, "Too Many Requests");
  expect(error.name).toBe("Error");
  expect(geminiErrorDiagnostics(error, false)).toEqual({
    httpStatus: 429, reason: "quota", apiReason: null, errorType: "GoogleGenerativeAIFetchError",
  });
});

it.each([
  [400, "invalid_request"], [401, "credentials"], [403, "permission_denied"],
  [404, "model_not_found"], [429, "quota"], [500, "unavailable"], [503, "unavailable"],
] as const)("retains upstream HTTP %i diagnostics through the real SDK without exposing its raw error", async (httpStatus, reason) => {
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    error: {
      message: `rejected ${LEARNER_TEXT}, API key ${SECRET}`,
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: LEARNER_TEXT, metadata: { key: SECRET } }],
    },
  }), { status: httpStatus }));
  const result = await callGeminiAdmitted(request, { admit });
  expect(result).toMatchObject({
    status: "provider_error", timedOut: false,
    diagnostics: { httpStatus, reason, errorType: "GoogleGenerativeAIFetchError", apiReason: null },
  });
  expect(admit).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith("[gemini] ai/assessment provider error:", expect.objectContaining({
    httpStatus, reason, model: request.model, attempt: 1, structuredOutput: true, hint: expect.any(String),
  }));
  const logAndResult = JSON.stringify([jest.mocked(console.error).mock.calls, result]);
  expect(logAndResult).not.toContain(SECRET);
  expect(logAndResult).not.toContain(LEARNER_TEXT);
  expect(logAndResult).not.toContain("generativelanguage.googleapis.com");
});

it("recognizes an invalid key reported as HTTP 400 without logging arbitrary ErrorInfo metadata", async () => {
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    error: { message: `API key not valid: ${SECRET}`, details: [{ reason: "API_KEY_INVALID", metadata: { key: SECRET } }] },
  }), { status: 400 }));
  const result = await callGeminiAdmitted(request, { admit });
  expect(result).toMatchObject({ diagnostics: { httpStatus: 400, reason: "credentials", apiReason: "API_KEY_INVALID" } });
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(SECRET);
});

it("distinguishes SDK-wrapped network failure without an HTTP response", async () => {
  const result = await callGeminiAdmitted(request, { admit });
  expect(result).toMatchObject({ diagnostics: { httpStatus: null, reason: "network", errorType: "GoogleGenerativeAIError" } });
});

it("distinguishes local timeout and makes no automatic provider retry", async () => {
  jest.useFakeTimers();
  jest.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const result = callGeminiAdmitted({ ...request, timeoutMs: 50 }, { admit });
  await jest.advanceTimersByTimeAsync(51);
  expect(await result).toMatchObject({ status: "provider_error", timedOut: true, diagnostics: { reason: "timeout" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("denied app admission still makes no SDK request or provider-error log", async () => {
  const result = await callGeminiAdmitted(request, { admit: async () => ({ status: "denied", reason: "rpd", retryAfterSec: 60 }) });
  expect(result.status).toBe("not_admitted");
  expect(fetch).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it("unknown exceptions remain generic; public messages distinguish provider quota from the app counter", () => {
  expect(geminiErrorDiagnostics({ status: "secret", message: LEARNER_TEXT }, false)).toEqual({
    httpStatus: null, reason: "unknown", apiReason: null, errorType: "Error",
  });
  const message = geminiFailureMessage(geminiErrorDiagnostics({ status: 429, message: SECRET }, false));
  expect(message).toContain("separate from the app's displayed limit");
  expect(message).toContain("Earlier results are kept");
  expect(message).not.toContain(SECRET);
});
