import { BOX_TABLE_ID, getSchema } from "./airtable.mjs";
import { addFirstOfFields, addRuleFields, underlyingIds, withBuiltins } from "./builtin-mappings.mjs";
import { definitionsFor, loadMappings, resolveTarget } from "./mapping.mjs";
import { MAX_PDF_BYTES, extractSources, firstPdf, promptHash, sourceText } from "./pdf-extract.mjs";
import { loadExtractPrompt, loadExtractResult } from "./pdf-extract-store.mjs";
import { loadRecordDetail } from "./record.mjs";
import { getMetafieldDefinitions } from "./shopify.mjs";
import { MATCH_FIELDS, boxKeys, matchProduct } from "./shopify-match.mjs";
import { loadProduct } from "./shopify-products.mjs";
import { buildPreview, mappedKeys } from "./sync.mjs";

// What syncing one Airtable box would change in Shopify. Used by the sync page (functions/shopify-sync.mjs)
// and by the backfill, which runs the same steps over many boxes.

// Set SHOPIFY_DRY_RUN=true to make every update a dry run, e.g. on a site that's still being tested.
export const DRY_RUN_ONLY = /^(1|true|yes)$/i.test(process.env.SHOPIFY_DRY_RUN ?? "");

export async function boxTable() {
  const schema = await getSchema();
  const table = schema.get(BOX_TABLE_ID);
  if (!table) throw new Error("Box table not found in Airtable base");
  return { schema, table };
}

// Loads just the fields used for matching plus the mapped ones, to keep Airtable requests down.
// Returns { record, extracts }: extracts are the PDFs that mapped sources read from, and each of those
// sources is added to the record as a field.
export async function loadRecord({ schema, table }, recordId, mappings) {
  const mapped = new Set(mappings.map((m) => m.sourceFieldId));
  const sources = extractSources(table).filter((s) => mapped.has(s.id));
  const only = new Set([...mapped, ...[...mapped].flatMap(underlyingIds), ...sources.map((s) => s.fieldId)]);
  for (const f of table.fields) if (MATCH_FIELDS.includes(f.name.trim())) only.add(f.id);
  const record = await loadRecordDetail(schema, table, recordId, { only });
  addFirstOfFields(record, mapped);
  addRuleFields(record, mapped);

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
// `only` narrows the mappings applied (the backfill writes just some fields); `choose` and `withChanges` are as
// the sync page uses them.
export async function preview(recordId, { choose = false, withChanges = false, only = null } = {}) {
  // The definitions are fetched alongside the rest so they're cached by the time the mappings are known.
  const [saved, airtable] = await Promise.all([loadMappings(), boxTable(), getMetafieldDefinitions()]);
  // The built-in mappings apply to every box, on top of whatever is saved in Mapping.
  const all = withBuiltins(saved.mappings, airtable.table);
  const mappings = only ? all.filter(only) : all;
  const definitions = await definitionsFor(mappings);
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
