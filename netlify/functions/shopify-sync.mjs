import { getStore } from "@netlify/blobs";
import { getSession, json } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getSchema } from "../lib/airtable.mjs";
import { addFirstOfFields, underlyingIds, withBuiltins } from "../lib/builtin-mappings.mjs";
import { loadMappings, resolveTarget } from "../lib/mapping.mjs";
import { MAX_PDF_BYTES, extractSources, firstPdf, promptHash, sourceText } from "../lib/pdf-extract.mjs";
import { loadExtractPrompt, loadExtractResult } from "../lib/pdf-extract-store.mjs";
import { loadRecordDetail } from "../lib/record.mjs";
import { getMetafieldDefinitions, ShopifyNotConfigured } from "../lib/shopify.mjs";
import { MATCH_FIELDS, boxKeys, clearLink, findCandidates, matchProduct, saveLink } from "../lib/shopify-match.mjs";
import { applyChanges, loadProduct } from "../lib/shopify-products.mjs";
import { buildPreview, mappedKeys } from "../lib/sync.mjs";

// Pushes an Airtable box's mapped fields to its Shopify product.
// GET previews (matches the box to a product and lists what would change), PUT remembers which product a
// box belongs to, POST applies the previewed changes. Only POST writes to Shopify, and not when it's a
// dry run: that goes through every step and returns the exact requests, but doesn't send them.

// Set SHOPIFY_DRY_RUN=true to make every update a dry run, e.g. on a site that's still being tested.
const DRY_RUN_ONLY = /^(1|true|yes)$/i.test(process.env.SHOPIFY_DRY_RUN ?? "");

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
        const { candidates } = await findCandidates(boxKeys((await loadRecord(await boxTable(), recordId, [])).record));
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

    const dryRun = DRY_RUN_ONLY || body?.dryRun === true;
    const { results, requests } = await applyChanges(productId, state.preview.changes, { dryRun });
    const changes = state.preview.changes.map((c) => ({
      target: c.target,
      ownerId: c.ownerId,
      before: c.before,
      after: c.after,
      error: results.get(c) ?? null,
    }));
    const failed = changes.filter((c) => c.error);
    const saved = changes.length - failed.length;
    if (dryRun) {
      console.log(`[shopify-sync] ${session.u} dry run for ${productId} from ${recordId}: ${saved} values in ${requests.length} requests, nothing sent`);
      const { changes: _, ...rest } = state.preview;
      return json({ ...state, preview: rest, result: { dryRun: true, saved, failed: 0, errors: {}, requests } });
    }

    await store().setJSON(`${new Date().toISOString()}_${recordId}`, {
      by: session.u,
      recordId,
      box: state.box,
      productId,
      productTitle: state.match.product.title,
      changes,
    });
    console.log(`[shopify-sync] ${session.u} updated ${productId} from ${recordId}: ${saved} saved, ${failed.length} failed`);

    // Per Shopify field: the error if any of its changes failed.
    const errors = Object.fromEntries(failed.map((c) => [c.target, c.error]));
    return json({ ...(await preview(recordId)), result: { dryRun: false, saved, failed: failed.length, errors } });
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

async function boxTable() {
  const schema = await getSchema();
  const table = schema.get(BOX_TABLE_ID);
  if (!table) throw new Error("Box table not found in Airtable base");
  return { schema, table };
}

// Loads just the fields used for matching plus the mapped ones, to keep Airtable requests down.
// Returns { record, extracts }: extracts are the PDFs that mapped sources read from, and each of those
// sources is added to the record as a field.
async function loadRecord({ schema, table }, recordId, mappings) {
  const mapped = new Set(mappings.map((m) => m.sourceFieldId));
  const sources = extractSources(table).filter((s) => mapped.has(s.id));
  const only = new Set([...mapped, ...[...mapped].flatMap(underlyingIds), ...sources.map((s) => s.fieldId)]);
  for (const f of table.fields) if (MATCH_FIELDS.includes(f.name.trim())) only.add(f.id);
  const record = await loadRecordDetail(schema, table, recordId, { only });
  addFirstOfFields(record, mapped);

  // One PDF is read once, however many of its sections are mapped.
  const perExtract = new Map(sources.map((s) => [s.extract, s]));
  const extracts = await Promise.all([...perExtract.values()].map((source) => loadExtract(record, source)));
  for (const source of sources) {
    const e = extracts.find((x) => x.extract === source.extract);
    const text = e.markdown == null ? { value: null, reason: e.reason } : sourceText(source, e.markdown);
    record.fields.push({ id: source.id, name: source.section ? source.name : source.label, value: text.value, emptyReason: text.reason });
  }
  for (const e of extracts) delete e.markdown;
  return { record, extracts };
}

// Where a mapped PDF extract stands for this record: "ready" (read earlier, with the prompt now in Settings),
// "needed" (the page has it read, then previews again) or "missing" (no PDF that can be read).
async function loadExtract(record, source) {
  const out = { extract: source.extract, label: source.label, fieldId: source.fieldId, markdown: null };
  const pdf = firstPdf(record.fields.find((f) => f.id === source.fieldId)?.value);
  if (!pdf) return { ...out, status: "missing", reason: `This box has no PDF in ${source.fieldName}` };
  if (pdf.size > MAX_PDF_BYTES) return { ...out, status: "missing", reason: `The PDF in ${source.fieldName} is too large to read` };

  const [{ prompt }, saved] = await Promise.all([loadExtractPrompt(source.extract), loadExtractResult(source.extract, pdf.id)]);
  const about = { ...out, attachmentId: pdf.id, filename: pdf.filename ?? "PDF" };
  if (saved?.markdown && saved.promptHash === promptHash(prompt)) {
    return { ...about, status: "ready", markdown: saved.markdown, extractedAt: saved.extractedAt };
  }
  return { ...about, status: "needed", reason: `The ${source.label.toLowerCase()} PDF hasn't been read yet` };
}

// Matches the box to a product and, if there is one, works out what the saved mappings would change.
async function preview(recordId, { choose = false, withChanges = false } = {}) {
  const [saved, definitions, airtable] = await Promise.all([loadMappings(), getMetafieldDefinitions(), boxTable()]);
  // The built-in mappings apply to every box, on top of whatever is saved in Mapping.
  const mappings = withBuiltins(saved.mappings, airtable.table);
  // Sources of mappings that can't be written (no such Shopify field) aren't loaded, so a PDF isn't read for nothing.
  const { record, extracts } = await loadRecord(airtable, recordId, mappings.filter((m) => resolveTarget(m.target, definitions)));
  const box = boxKeys(record);
  const match = await matchProduct(recordId, box, { choose });
  const out = { connected: true, dryRunOnly: DRY_RUN_ONLY, box: box.box, mappingCount: mappings.length, match, extracts, preview: null };
  if (!match.product || mappings.length === 0) return out;

  const product = await loadProduct(match.product.id, mappedKeys(mappings));
  if (!product) return out;
  const { changes, ...rest } = buildPreview(record, product, mappings, definitions);
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
