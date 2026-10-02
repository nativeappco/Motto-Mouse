const API = "https://generativelanguage.googleapis.com/v1beta";

export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
// Gemini quotas are counted per model, so when MODEL's daily allowance runs out we fall back to
// a model with its own allowance. Set GEMINI_FALLBACK_MODEL to "none" to turn this off.
export const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

// How long we'll keep waiting out rate limits. The background function has 15 minutes and the
// Gemini call itself takes a minute or two, so this leaves plenty of headroom.
const RETRY_BUDGET_MS = 8 * 60 * 1000;

export class GeminiNotConfigured extends Error {}
export class GeminiQuotaExceeded extends Error {
  constructor(message, { daily = false } = {}) {
    super(message);
    this.daily = daily;
  }
}

// Sends a PDF inline with a text prompt and returns the model's text reply, plus which model answered.
export async function askAboutPdf(pdf, prompt) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new GeminiNotConfigured("GEMINI_KEY is not configured");

  const models = [MODEL, FALLBACK_MODEL].filter((m, i, all) => m && m !== "none" && all.indexOf(m) === i);
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (const [i, model] of models.entries()) {
    try {
      return await generate(key, model, pdf, prompt, deadline);
    } catch (err) {
      if (!(err instanceof GeminiQuotaExceeded && err.daily) || i === models.length - 1) throw err;
      console.warn(`[gemini] ${model} daily quota used up, falling back to ${models[i + 1]}`);
    }
  }
}

async function generate(key, model, pdf, prompt, deadline) {
  const request = () => fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
            { text: prompt },
          ],
        },
      ],
      // Transcription doesn't need deep reasoning, and minimal thinking keeps us inside the function timeout.
      generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING || "minimal" } },
    }),
  });

  let dailyHits = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await request();
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error(`Gemini returned no text (finishReason: ${candidate?.finishReason ?? "unknown"})`);
      return { text, usage: data.usageMetadata ?? null, model };
    }

    const detail = `Gemini ${model} ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 1500)}`;
    let wait = null;
    if (res.status === 429) {
      // A per-minute limit clears if we wait for the delay Gemini suggests. A per-day limit resets at
      // midnight Pacific time, but in practice it sometimes lets a request through after the suggested
      // delay, so we try that once before giving up on this model.
      const quota = quotaInfo(data.error);
      console.warn(`[gemini] ${model} 429 on attempt ${attempt} quotas=${quota.ids.join(",") || "unknown"} retryIn=${quota.delayMs ?? "?"}ms`);
      if (quota.daily && ++dailyHits > 1) {
        console.error(detail);
        throw new GeminiQuotaExceeded(
          `Gemini's daily limit for ${model} is used up. It resets at midnight Pacific time.`,
          { daily: true }
        );
      }
      wait = (quota.delayMs ?? 30_000) + 1000;
    } else if (res.status === 503 || res.status === 500) {
      // The model is briefly overloaded; a short pause usually gets through.
      wait = Math.min(2000 * 2 ** (attempt - 1), 30_000);
    }

    if (wait == null) throw new Error(detail);
    if (Date.now() + wait > deadline) {
      console.error(detail);
      if (res.status === 429) {
        throw new GeminiQuotaExceeded(`Gemini's rate limit for ${model} is still exceeded after several minutes of retrying. Try again shortly.`);
      }
      throw new Error(detail);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

// Pulls the suggested retry delay and the exceeded quota ids out of a Gemini 429 error body.
function quotaInfo(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  const ofType = (type) => details.find((d) => String(d?.["@type"] ?? "").endsWith(type));
  const ids = (ofType("QuotaFailure")?.violations ?? []).map((v) => v?.quotaId).filter(Boolean);
  const seconds = parseFloat(ofType("RetryInfo")?.retryDelay ?? error?.message?.match(/retry in ([\d.]+)s/i)?.[1]);
  return {
    ids,
    daily: ids.some((id) => /PerDay/i.test(id)),
    delayMs: Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null,
  };
}
