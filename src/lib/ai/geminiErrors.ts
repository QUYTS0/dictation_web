/** Safe provider diagnostics: never return/log raw errors, URLs or response bodies. */
export type GeminiFailureReason =
  | "timeout"
  | "credentials"
  | "permission_denied"
  | "quota"
  | "model_not_found"
  | "invalid_request"
  | "unavailable"
  | "network"
  | "unknown";

export interface GeminiErrorDiagnostics {
  httpStatus: number | null;
  reason: GeminiFailureReason;
  /** Allowlisted Google ErrorInfo reason, never arbitrary provider text. */
  apiReason: string | null;
  errorType: string;
}

const API_REASONS = new Set([
  "API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED",
  "SERVICE_DISABLED", "BILLING_DISABLED", "CONSUMER_INVALID",
  "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "ACCESS_TOKEN_EXPIRED",
]);
const ERROR_TYPES = new Set([
  "GoogleGenerativeAIFetchError", "GoogleGenerativeAIRequestInputError",
  "GoogleGenerativeAIAbortError", "GoogleGenerativeAIError",
  "Error", "TypeError", "DOMException",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function geminiErrorDiagnostics(error: unknown, timedOut: boolean): GeminiErrorDiagnostics {
  const err = record(error);
  const httpStatus = typeof err.status === "number" && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : null;
  // The installed SDK inherits Error.name ("Error"), but its constructor
  // identifies fetch/input/abort errors. Duck typing also handles test doubles.
  const constructorName = error instanceof Error ? error.constructor.name : "";
  const errorType = ERROR_TYPES.has(constructorName) ? constructorName : "Error";
  const details = Array.isArray(err.errorDetails) ? err.errorDetails : [];
  const apiReason = details.map((d) => record(d).reason).find((r): r is string => typeof r === "string" && API_REASONS.has(r)) ?? null;
  // Inspect messages only for known conditions. Do not emit any of the text:
  // SDK errors can contain echoed request data, credentials and project IDs.
  const message = typeof err.message === "string" ? err.message : "";
  let reason: GeminiFailureReason = "unknown";
  if (timedOut || errorType === "GoogleGenerativeAIAbortError" || err.name === "AbortError") reason = "timeout";
  else if (httpStatus === 401 || apiReason === "API_KEY_INVALID" || apiReason === "API_KEY_EXPIRED"
    || /API key not valid|API key (?:was |has been )?(?:reported as leaked|expired)/i.test(message)) reason = "credentials";
  else if (httpStatus === 403) reason = "permission_denied";
  else if (httpStatus === 429) reason = "quota";
  else if (httpStatus === 404) reason = "model_not_found";
  else if (httpStatus === 400 || errorType === "GoogleGenerativeAIRequestInputError") reason = "invalid_request";
  else if (httpStatus !== null && httpStatus >= 500) reason = "unavailable";
  else if (httpStatus === null && /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) reason = "network";
  return { httpStatus, reason, apiReason, errorType };
}

/** Static operator guidance, logged only on the server. */
export const GEMINI_ERROR_HINTS: Record<GeminiFailureReason, string> = {
  timeout: "Gemini did not finish before the request deadline.",
  credentials: "Check the Gemini API key's validity and restrictions in Google AI Studio.",
  permission_denied: "Check API-key restrictions, project API access, billing and regional availability.",
  quota: "Check the model's request/token limits and remaining quota in Google AI Studio; the app's Redis counter is separate.",
  model_not_found: "Check GEMINI_MODEL and whether this project can use it with generateContent on v1beta.",
  invalid_request: "Check responseSchema, generation parameters and model support; also check project prerequisites such as billing/region.",
  unavailable: "Gemini returned a server error. Retry later; no automatic provider retry was made.",
  network: "Check server connectivity to generativelanguage.googleapis.com, DNS, proxy and TLS settings.",
  unknown: "Gemini failed without an HTTP status or recognized error reason.",
};

/** Public messages contain only fixed text, never the SDK's raw error. */
export function geminiFailureMessage(diagnostics?: GeminiErrorDiagnostics): string {
  const messages: Record<GeminiFailureReason, string> = {
    timeout: "Gemini took too long to respond. Try again later.",
    credentials: "The AI service could not authenticate. Its API key needs to be checked.",
    permission_denied: "Gemini denied access. The server's AI configuration needs to be checked.",
    quota: "Gemini's own quota or rate limit was reached. Try again later; this is separate from the app's displayed limit.",
    model_not_found: "The configured Gemini model was not found or is unavailable for this request.",
    invalid_request: "Gemini rejected the assessment request. The server's AI configuration or request format needs to be checked.",
    unavailable: "Gemini is temporarily unavailable. Try again later.",
    network: "The server could not connect to Gemini. Try again later.",
    unknown: "The AI service failed.",
  };
  return `${messages[diagnostics?.reason ?? "unknown"]} The request may still count toward today's limit. Earlier results are kept.`;
}
