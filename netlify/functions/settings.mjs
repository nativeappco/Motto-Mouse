import { getSession, json } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getSchema } from "../lib/airtable.mjs";
import {
  groupFields,
  loadLookupSettings,
  recommendedIds,
  resetLookupSettings,
  saveLookupSettings,
  selectedIds,
} from "../lib/settings.mjs";

export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  try {
    const schema = await getSchema(req.method === "GET" && new URL(req.url).searchParams.has("refresh"));
    const table = schema.get(BOX_TABLE_ID);
    if (!table) return json({ error: "Box table not found in Airtable base" }, 500);

    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      const ids = body?.selectedFieldIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        return json({ error: "selectedFieldIds must be a list of field ids" }, 400);
      }
      const valid = new Set(table.fields.map((f) => f.id));
      const clean = [...new Set(ids)].filter((id) => valid.has(id));
      if (clean.length === 0) return json({ error: "Select at least one field" }, 400);
      await saveLookupSettings(clean, session.u);
      console.log(`[settings] ${session.u} saved ${clean.length} lookup fields`);
    } else if (req.method === "DELETE") {
      await resetLookupSettings();
      console.log(`[settings] ${session.u} reset lookup fields to recommended`);
    } else if (req.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const saved = await loadLookupSettings();
    const selected = selectedIds(table, saved);
    const recommended = new Set(recommendedIds(table));

    return json({
      table: table.name,
      usingDefaults: !saved,
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
      groups: groupFields(table).map((g) => ({
        name: g.name,
        fields: g.fields.map((f) => ({
          id: f.id,
          name: f.name.trim(),
          type: f.type,
          selected: selected.has(f.id),
          recommended: recommended.has(f.id),
        })),
      })),
    });
  } catch (err) {
    console.error("[settings] error", err);
    return json({ error: "Could not load settings. Check the function logs for details." }, 502);
  }
};

export const config = { path: "/api/settings" };
