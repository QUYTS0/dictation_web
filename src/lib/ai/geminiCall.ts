/**
 * Learning Reports P5 — the ONLY place that calls Gemini (a static test
 * asserts no other module calls `generateContent`). SERVER-ONLY.
 *
 * Every call is admitted first (quota.ts), with its own attempt number, so
 * no retry or fallback can run without an admission of its own. A call is
 * never made inside a database transaction (callers commit `begin` first).
 *
 * Usage metadata and the finish reason are returned for logging/coverage;
 * learner text is never logged here.
 */
import { GoogleGenerativeAI, type GenerationConfig, type Schema } from "@google/generative-ai";
import { admitGeminiAttempt, type AdmissionRequest, type AdmissionResult } from "@/lib/ai/quota";

export interface GeminiUsage {
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export type GeminiCallResult =
  | { status: "ok"; text: string; finishReason: string | null; truncated: boolean; usage: GeminiUsage }
  | { status: "not_admitted"; admission: Exclude<AdmissionResult, { status: "admitted" } | { status: "unmetered" }> }
  /** The provider may or may not have done (and charged for) the work. */
  | { status: "provider_error"; timedOut: boolean };

export interface GeminiCallRequest {
  apiKey: string;
  model: string;
  prompt: string;
  systemInstruction?: string;
  responseSchema?: Schema;
  maxOutputTokens?: number;
  timeoutMs: number;
  admission: AdmissionRequest;
  /** Label for logs (route name); never learner text. */
  logTag: string;
}

export async function callGeminiAdmitted(
  req: GeminiCallRequest,
  deps: { admit?: typeof admitGeminiAttempt } = {}
): Promise<GeminiCallResult> {
  const admission = await (deps.admit ?? admitGeminiAttempt)(req.admission);
  if (admission.status !== "admitted" && admission.status !== "unmetered") {
    return { status: "not_admitted", admission };
  }

  const generationConfig: GenerationConfig = {
    responseMimeType: "application/json",
    ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
    ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
  };
  const model = new GoogleGenerativeAI(req.apiKey).getGenerativeModel({
    model: req.model,
    generationConfig,
    ...(req.systemInstruction ? { systemInstruction: req.systemInstruction } : {}),
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  try {
    const result = await model.generateContent(req.prompt, { signal: controller.signal });
    const response = result.response;
    const finishReason = (response.candidates?.[0]?.finishReason as string | undefined) ?? null;
    const usage: GeminiUsage = {
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount ?? null,
    };
    let text = "";
    try {
      text = response.text().trim();
    } catch {
      text = "";
    }
    const truncated = finishReason === "MAX_TOKENS";
    console.log(
      `[gemini] ${req.logTag} ${req.admission.operationType} attempt=${req.admission.attempt} finish=${finishReason ?? "unknown"} tokens=${usage.promptTokens ?? "?"}/${usage.outputTokens ?? "?"}`
    );
    return { status: "ok", text, finishReason, truncated, usage };
  } catch (err) {
    console.error(`[gemini] ${req.logTag} provider error${timedOut ? " (timeout)" : ""}:`, err instanceof Error ? err.name : "error");
    return { status: "provider_error", timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Strips a stray ```json fence and parses; null when it isn't JSON. */
export function parseJsonText(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    return null;
  }
}

/** User-facing message + HTTP status for an admission that didn't allow a call. */
export function admissionFailure(a: Exclude<AdmissionResult, { status: "admitted" } | { status: "unmetered" }>): {
  status: number;
  error: string;
  code: string;
  retryAfterSec?: number;
} {
  switch (a.status) {
    case "denied":
      return a.reason === "rpm"
        ? { status: 429, code: "quota_rpm", error: "AI is handling too many requests right now. Try again in a minute.", retryAfterSec: a.retryAfterSec }
        : a.reason === "user_rpd"
          ? { status: 429, code: "quota_user_rpd", error: "You've used today's AI requests. Saved results stay available.", retryAfterSec: a.retryAfterSec }
          : { status: 429, code: "quota_rpd", error: "Today's AI requests (shared app limit) are used up. Saved results stay available.", retryAfterSec: a.retryAfterSec };
    case "duplicate":
      return { status: 409, code: "unknown_outcome", error: "This AI request was already sent once and its outcome is unknown. Starting again uses a new request." };
    case "unavailable":
      return { status: 503, code: "quota_unavailable", error: "AI is temporarily unavailable. Saved results stay available." };
  }
}
