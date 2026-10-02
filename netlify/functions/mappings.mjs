import { getSession, json } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getSchema } from "../lib/airtable.mjs";
import { groupFields } from "../lib/settings.mjs";
import { getMetafieldDefinitions, ShopifyNotConfigured } from "../lib/shopify.mjs";
import { NATIVE_FIELDS, metafieldKind } from "../lib/shopify-fields.mjs";
import { loadMappings, modesFor, resolveTarget, saveMappings, validateMappings } from "../lib/mapping.mjs";

// Airtable field → Shopify field mappings. GET returns the mappings plus everything the editor needs
// (Airtable fields, native Shopify fields, metafield definitions); PUT replaces the whole list.
export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  try {
    const refresh = req.method === "GET" && new URL(req.url).searchParams.has("refresh");
    const [schema, shopify] = await Promise.all([getSchema(refresh), loadDefinitions(refresh)]);
    const table = schema.get(BOX_TABLE_ID);
    if (!table) return json({ error: "Box table not found in Airtable base" }, 500);

    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      const result = validateMappings(body?.mappings, table, shopify.definitions);
      if (result.error) return json({ error: result.error }, 400);
      await saveMappings(result.mappings, session.u);
      console.log(`[mappings] ${session.u} saved ${result.mappings.length} mappings`);
    } else if (req.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const saved = await loadMappings();
    const fieldIds = new Set(table.fields.map((f) => f.id));

    return json({
      table: table.name,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
      shopify: { connected: Boolean(shopify.definitions), error: shopify.error },
      mappings: saved.mappings.map((m) => ({
        ...m,
        // Flag mappings whose Airtable field or Shopify definition has since been removed.
        sourceMissing: !fieldIds.has(m.sourceFieldId),
        targetMissing: Boolean(shopify.definitions) && !resolveTarget(m.target, shopify.definitions),
      })),
      sources: groupFields(table).map((g) => ({
        name: g.name,
        fields: g.fields.map((f) => ({ id: f.id, name: f.name.trim(), type: f.type })),
      })),
      targets: buildTargets(shopify.definitions),
    });
  } catch (err) {
    console.error("[mappings] error", err);
    return json({ error: "Could not load mappings. Check the function logs for details." }, 502);
  }
};

// Shopify being down or unconfigured shouldn't stop native-field mappings from being edited.
async function loadDefinitions(force) {
  try {
    return { definitions: await getMetafieldDefinitions(force), error: null };
  } catch (err) {
    if (!(err instanceof ShopifyNotConfigured)) console.error("[mappings] metafield definitions", err);
    return { definitions: null, error: err instanceof ShopifyNotConfigured ? err.message : "Shopify is not reachable" };
  }
}

function buildTargets(definitions) {
  const native = (owner, name) => ({
    name,
    fields: NATIVE_FIELDS[owner].map((f) => ({
      id: `${owner}:${f.key}`,
      label: f.label,
      kind: f.kind,
      modes: modesFor(f.kind),
    })),
  });
  const metafields = (owner, name) => ({
    name,
    fields: (definitions?.[owner] ?? []).map((d) => {
      const kind = metafieldKind(d.type);
      return {
        id: `${owner}:metafield:${d.namespace}.${d.key}`,
        label: d.name,
        detail: `${d.namespace}.${d.key} · ${d.type}`,
        kind,
        modes: modesFor(kind),
      };
    }),
  });
  return [
    native("product", "Product fields"),
    metafields("product", "Product metafields"),
    native("variant", "Variant fields (applied to every variant)"),
    metafields("variant", "Variant metafields (applied to every variant)"),
  ];
}

export const config = { path: "/api/mappings" };
