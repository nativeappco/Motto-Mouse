import { getSession, json } from "../lib/auth.mjs";
import { EXTRACTS } from "../lib/pdf-extract.mjs";
import { MAX_PROMPT_CHARS, MIN_PROMPT_CHARS, loadExtractPrompt, saveExtractPrompt } from "../lib/pdf-extract-store.mjs";

// The prompts sent to Gemini with a PDF. GET lists them, PUT saves one, DELETE puts one back to its default.
export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  try {
    if (req.method === "PUT" || req.method === "DELETE") {
      const body = await req.json().catch(() => null);
      const extract = body?.extract;
      if (typeof extract !== "string" || !Object.hasOwn(EXTRACTS, extract)) return json({ error: "Unknown extract type" }, 400);

      if (req.method === "DELETE") {
        await saveExtractPrompt(extract, null, session.u);
        console.log(`[pdf-prompts] ${session.u} reset the ${extract} prompt`);
      } else {
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (prompt.length < MIN_PROMPT_CHARS) return json({ error: "The prompt is too short to be useful" }, 400);
        if (prompt.length > MAX_PROMPT_CHARS) return json({ error: `The prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString("en-AU")} characters` }, 400);
        // Saving the default text as-is keeps following the default, including any later change to it.
        await saveExtractPrompt(extract, prompt === EXTRACTS[extract].prompt ? null : prompt, session.u);
        console.log(`[pdf-prompts] ${session.u} saved the ${extract} prompt (${prompt.length} chars)`);
      }
    } else if (req.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const extracts = await Promise.all(
      Object.entries(EXTRACTS).map(async ([id, spec]) => ({
        id,
        label: spec.label,
        field: spec.field,
        defaultPrompt: spec.prompt,
        ...(await loadExtractPrompt(id)),
      }))
    );
    return json({ extracts, maxChars: MAX_PROMPT_CHARS });
  } catch (err) {
    console.error("[pdf-prompts] error", err);
    return json({ error: "Could not load the PDF prompts. Check the function logs for details." }, 502);
  }
};

export const config = { path: "/api/pdf/prompts" };
