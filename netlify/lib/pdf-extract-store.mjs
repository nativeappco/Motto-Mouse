import { getStore } from "@netlify/blobs";
import { EXTRACTS } from "./pdf-extract.mjs";

// ---------- Prompts ----------
// The prompt each extract sends with its PDF. Editable in Settings; the default is in pdf-extract.mjs.
const SETTINGS = "settings";
const PROMPTS_KEY = "pdf-extract-prompts";
export const MIN_PROMPT_CHARS = 20;
export const MAX_PROMPT_CHARS = 20000;

function settings() {
  return getStore({ name: SETTINGS, consistency: "strong" });
}

// Returns { prompt, isDefault, updatedAt, updatedBy } for an extract.
export async function loadExtractPrompt(extract) {
  const saved = (await settings().get(PROMPTS_KEY, { type: "json" }))?.[extract];
  return saved?.prompt
    ? { prompt: saved.prompt, isDefault: false, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }
    : { prompt: EXTRACTS[extract].prompt, isDefault: true, updatedAt: null, updatedBy: null };
}

// `prompt` null goes back to the default.
export async function saveExtractPrompt(extract, prompt, username) {
  const all = (await settings().get(PROMPTS_KEY, { type: "json" })) ?? {};
  if (prompt == null) delete all[extract];
  else all[extract] = { prompt, updatedAt: new Date().toISOString(), updatedBy: username };
  await settings().setJSON(PROMPTS_KEY, all);
}

// ---------- Results ----------
// The latest result of each extract per PDF, kept so syncing to Shopify doesn't read the PDF again.
// Keyed by the Airtable attachment: boxes on the same PO share one tech pack, so they share its result.
function results() {
  return getStore({ name: "pdf-extracts", consistency: "strong" });
}

const key = (extract, attachmentId) => `${extract}/${attachmentId}`;

// Returns { markdown, filename, model, promptHash, extractedAt } or null.
export async function loadExtractResult(extract, attachmentId) {
  return (await results().get(key(extract, attachmentId), { type: "json" })) ?? null;
}

export async function saveExtractResult(extract, attachmentId, result) {
  await results().setJSON(key(extract, attachmentId), { ...result, extractedAt: new Date().toISOString() });
}
