import { getStore } from "@netlify/blobs";
import { getSession, json } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getSchema } from "../lib/airtable.mjs";
import { loadMappings } from "../lib/mapping.mjs";
import { loadRecordDetail } from "../lib/record.mjs";
import { getMetafieldDefinitions, ShopifyNotConfigured } from "../lib/shopify.mjs";
import { MATCH_FIELDS, boxKeys, clearLink, findCandidates, matchProduct, saveLink } from "../lib/shopify-match.mjs";
import { applyChanges, loadProduct } from "../lib/shopify-products.mjs";
import { buildPreview, mappedKeys } from "../lib/sync.mjs";

// Pushes an Airtable box's mapped fields to its Shopify product.
// GET previews (matches the box to a product and lists what would change), PUT remembers which product a
// box belongs to, POST applies the previewed changes. Only POST writes to Shopify.
export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  try {
    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const recordId = params.get("id");
      if (!isRecordId(recordId)) return json({ error: "Invalid record id" }, 400);
      return json(await preview(recordId, { choose: params.has("choose") }));
    }

    const body = await req.json().catch(() => null);
    const recordId = body?.recordId;
    const productId = body?.productId ?? null;
    if (!isRecordId(recordId)) return json({ error: "Invalid record id" }, 400);
    if (productId !== null && !isProductId(productId)) return json({ error: "Invalid product id" }, 400);

    if (req.method === "PUT") {
      if (productId === null) {
        await clearLink(recordId);
      } else {
        // Only products this box could plausibly belong to can be linked.
        const { candidates } = await findCandidates(boxKeys(await loadRecord(recordId, [])));
        if (!candidates.some((c) => c.id === productId)) return json({ error: "That product isn't a match for this box" }, 400);
        await saveLink(recordId, productId, session.u);
      }
      console.log(`[shopify-sync] ${session.u} linked ${recordId} -> ${productId}`);
      return json(await preview(recordId));
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    // Recompute everything rather than trusting the browser, and refuse if it's no longer what the user saw.
    const state = await preview(recordId, { withChanges: true });
    if (state.match.product?.id !== productId || state.preview?.fingerprint !== body?.fingerprint) {
      return json({ error: "Shopify or Airtable changed since this preview was made. Check the refreshed preview and try again." }, 409);
    }
    if (state.preview.changes.length === 0) return json({ error: "There is nothing to update" }, 400);

    const results = await applyChanges(productId, state.preview.changes);
    const changes = state.preview.changes.map((c) => ({
      target: c.target,
      ownerId: c.ownerId,
      before: c.before,
      after: c.after,
      error: results.get(c) ?? null,
    }));
    const failed = changes.filter((c) => c.error);
    await store().setJSON(`${new Date().toISOString()}_${recordId}`, {
      by: session.u,
      recordId,
      box: state.box,
      productId,
      productTitle: state.match.product.title,
      changes,
    });
    console.log(`[shopify-sync] ${session.u} updated ${productId} from ${recordId}: ${changes.length - failed.length} saved, ${failed.length} failed`);

    // Per Shopify field: the error if any of its changes failed.
    const errors = Object.fromEntries(failed.map((c) => [c.target, c.error]));
    return json({ ...(await preview(recordId)), result: { saved: changes.length - failed.length, failed: failed.length, errors } });
  } catch (err) {
    if (err instanceof ShopifyNotConfigured) {
      // A GET still succeeds so the page can show how to connect.
      return req.method === "GET" ? json({ connected: false, error: err.message }) : json({ error: err.message, notConfigured: true }, 503);
    }
    console.error("[shopify-sync] error", err);
    if (/^Airtable 429/.test(err.message)) {
      return json({ error: "Airtable is limiting requests. Wait 30 seconds and try again." }, 503);
    }
    return json({ error: "Shopify sync failed. Check the function logs for details." }, 502);
  }
};

function store() {
  return getStore({ name: "sync-log", consistency: "strong" });
}

// Loads just the fields used for matching plus the mapped ones, to keep Airtable requests down.
async function loadRecord(recordId, mappings) {
  const schema = await getSchema();
  const table = schema.get(BOX_TABLE_ID);
  if (!table) throw new Error("Box table not found in Airtable base");
  const only = new Set(mappings.map((m) => m.sourceFieldId));
  for (const f of table.fields) if (MATCH_FIELDS.includes(f.name.trim())) only.add(f.id);
  return loadRecordDetail(schema, table, recordId, { only });
}

// Matches the box to a product and, if there is one, works out what the saved mappings would change.
async function preview(recordId, { choose = false, withChanges = false } = {}) {
  const [saved, definitions] = await Promise.all([loadMappings(), getMetafieldDefinitions()]);
  const record = await loadRecord(recordId, saved.mappings);
  const box = boxKeys(record);
  const match = await matchProduct(recordId, box, { choose });
  const out = { connected: true, box: box.box, mappingCount: saved.mappings.length, match, preview: null };
  if (!match.product || saved.mappings.length === 0) return out;

  const product = await loadProduct(match.product.id, mappedKeys(saved.mappings));
  if (!product) return out;
  const { changes, ...rest } = buildPreview(record, product, saved.mappings, definitions);
  out.preview = withChanges ? { changes, ...rest } : rest;
  return out;
}

function isRecordId(v) {
  return /^rec[A-Za-z0-9]{14}$/.test(v ?? "");
}

function isProductId(v) {
  return /^gid:\/\/shopify\/Product\/\d+$/.test(v ?? "");
}

export const config = { path: "/api/shopify/sync" };
