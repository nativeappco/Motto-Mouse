import { getStore } from "@netlify/blobs";
import { BOX_TABLE_ID, getSchema, listRecordsPage } from "./airtable.mjs";
import { BUILTINS, builtinTarget } from "./builtin-mappings.mjs";
import { preview } from "./box-sync.mjs";
import { matchChoices } from "./mapping.mjs";
import { getMetafieldDefinitions, graphql } from "./shopify.mjs";
import { applyChanges } from "./shopify-products.mjs";

// Jobs that work through the whole catalogue in the background (functions/backfill-background.mjs):
//   audit               – read only: what Shopify holds now (old subcategory values, templates, bundle tags)
//   group               – re-syncs every product a box with a REX Description matches: the related product
//                         group, plus the bundle template and tag (`rules`) and any saved mappings asked for
//                         (`targets`, e.g. the subcategories)
//   subcategory-migrate – copies the old free-text subcategory metafield(s) into the new one with preset
//                         choices, through the migration table saved in Mouse
// A run stops before the function's time is up and carries on in a new invocation from where it got to.

export const JOBS = ["audit", "group", "subcategory-migrate"];

// ---------- Storage ----------
function store() {
  return getStore({ name: "backfill", consistency: "strong" });
}

export const loadJob = async (id) => (await store().get(`job/${id}`, { type: "json" })) ?? null;
export const saveJob = (job) => store().setJSON(`job/${job.id}`, { ...job, updatedAt: new Date().toISOString() });

export async function listJobs() {
  const { blobs } = await store().list({ prefix: "job/" });
  const jobs = await Promise.all(blobs.map((b) => store().get(b.key, { type: "json" })));
  return jobs
    .filter(Boolean)
    .map(({ state, report, ...job }) => ({ ...job, counts: report?.counts ?? {} }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Old subcategory value -> the new subcategories it becomes ([] to drop it), as Martin and Motto agree it.
const MIGRATION_KEY = "config/subcategory-migration";
export const loadMigration = async () => (await store().get(MIGRATION_KEY, { type: "json" })) ?? { table: {}, updatedAt: null };
export const saveMigration = (table, username) =>
  store().setJSON(MIGRATION_KEY, { table, updatedAt: new Date().toISOString(), updatedBy: username });

function syncLog() {
  return getStore({ name: "sync-log", consistency: "strong" });
}

// ---------- Report ----------
// Counts by outcome, and one line per box or product (kept to the first MAX_LINES).
const MAX_LINES = 5000;

export function newReport() {
  return { counts: {}, lines: [], truncated: false };
}

export function note(report, outcome, line = {}) {
  report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
  if (report.lines.length < MAX_LINES) report.lines.push({ outcome, ...line });
  else report.truncated = true;
}

const CSV_COLUMNS = ["outcome", "box", "recordId", "productId", "product", "field", "before", "after", "detail"];

export function reportCsv(report) {
  const cell = (v) => {
    const s = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...report.lines.map((l) => CSV_COLUMNS.map((c) => cell(l[c])).join(","))].join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Someone pressed Stop (or Resume started a newer run): the job ends at the next page instead of running out
// its slice.
async function stopRequested(job) {
  const latest = await loadJob(job.id);
  return !latest || latest.status === "stopped" || latest.run !== job.run;
}

// ---------- Audit ----------
// Product metafields worth looking at: the old subcategory field, and any group or bundle field already there.
export const AUDIT_DEFINITION = /sub.?categ|group|related|bundle|badge|swatch/i;
// Tags that look like they drive the bundle badge.
export const AUDIT_TAG = /bundle|2\s*for|blogger|tencel/i;

// The values a metafield holds, one per list item.
export function metafieldItems(raw) {
  if (raw == null || raw === "") return [];
  if (/^\s*\[/.test(raw)) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.map(String);
    } catch {
      // Not JSON after all: counted as it is.
    }
  }
  return [raw];
}

const count = (counts, key) => (counts[key] = (counts[key] ?? 0) + 1);

async function auditStep(job, deadline) {
  const state = job.state;
  if (!state.metafields) {
    const { product } = await getMetafieldDefinitions(true);
    state.metafields = product
      .filter((d) => AUDIT_DEFINITION.test(`${d.name} ${d.namespace}.${d.key}`))
      .slice(0, 20)
      .map((d) => ({ metafield: `${d.namespace}.${d.key}`, name: d.name, type: d.type, choices: d.choices, values: {} }));
    state.templates = {};
    state.tags = {};
    state.products = 0;
  }
  const fields = state.metafields
    .map((m, i) => `m${i}: metafield(namespace: ${JSON.stringify(m.metafield.split(".")[0])}, key: ${JSON.stringify(m.metafield.split(".").slice(1).join("."))}) { value }`)
    .join(" ");
  // A query may cost 1000 points, and each product costs about one per metafield it asks for.
  const pageSize = Math.max(10, Math.min(100, Math.floor(900 / (state.metafields.length + 3))));
  const query = `query Audit($after: String) {
    products(first: ${pageSize}, after: $after) { nodes { templateSuffix tags ${fields} } pageInfo { hasNextPage endCursor } }
  }`;

  while (Date.now() < deadline) {
    const data = await graphql(query, { after: state.cursor ?? null });
    for (const p of data.products.nodes) {
      state.products++;
      count(state.templates, p.templateSuffix || "(default)");
      for (const tag of p.tags) if (AUDIT_TAG.test(tag)) count(state.tags, tag);
      state.metafields.forEach((m, i) => {
        for (const item of metafieldItems(p[`m${i}`]?.value)) count(m.values, item);
      });
    }
    state.cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (!state.cursor || (await stopRequested(job))) break;
  }
  if (state.cursor) return false;

  // Most used first, so the report reads top-down.
  const sorted = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, n]) => ({ value, products: n }));
  job.result = {
    products: state.products,
    templates: sorted(state.templates),
    tags: sorted(state.tags),
    metafields: state.metafields.map(({ values, ...m }) => ({ ...m, values: sorted(values) })),
  };
  for (const m of job.result.metafields) for (const v of m.values) note(job.report, "value", { field: m.metafield, after: v.value, detail: `${v.products} products` });
  for (const v of job.result.templates) note(job.report, "template", { after: v.value, detail: `${v.products} products` });
  for (const v of job.result.tags) note(job.report, "tag", { after: v.value, detail: `${v.products} products` });
  return true;
}

// ---------- Related product group ----------
const GROUP = BUILTINS.find((b) => b.key === "related_product_group");
export const GROUP_TARGET = builtinTarget(GROUP);

// Boxes of the same colourway (repeat orders) go to the same product, so only the newest one is synced.
export function colourwayKey(fields) {
  const text = (v) => (Array.isArray(v) ? v.map(text).find(Boolean) ?? "" : v && typeof v === "object" ? text(v.name) : String(v ?? "").trim());
  const sku = text(fields.SKU).toUpperCase().replace(/_+$/, "");
  if (sku) return `sku:${sku}`;
  const pattern = text(fields["PATTERN#"]).toUpperCase();
  const colourway = text(fields.COLOURWAY).toUpperCase();
  return pattern && colourway ? `pc:${pattern}|${colourway}` : null;
}

// The mappings the group backfill applies: the group, the rules when asked for, and the saved mappings to the
// Shopify fields in `targets`. Mappings that read a tech pack PDF are never applied, as that means a Gemini
// call per product.
export const groupMappings = (rules, targets = []) => (m) =>
  m.target === GROUP_TARGET ||
  (rules && Boolean(m.rule)) ||
  (targets.includes(m.target) && !m.rule && !m.builtin && !m.sourceFieldId.startsWith("extract:"));

async function groupStep(job, deadline) {
  const state = job.state;
  const { table } = await boxTableFields();
  const id = (name) => table.fields.find((f) => f.name.trim() === name)?.id;
  const names = ["BOX#", "SKU", "PATTERN#", "COLOURWAY", "REX Description"];
  state.seenColourways ??= [];
  state.seenProducts ??= [];
  state.doneRecords ??= [];
  const colourways = new Set(state.seenColourways);
  const products = new Set(state.seenProducts);
  // Boxes already dealt with, so a page that's fetched again (after a stop, or a restart) isn't done twice.
  const done = new Set(state.doneRecords);

  try {
    while (Date.now() < deadline) {
      let page;
      try {
        page = await listRecordsPage(BOX_TABLE_ID, {
          formula: "NOT({REX Description} = '')",
          fieldIds: names.map(id).filter(Boolean),
          sort: { field: "BOX#", direction: "desc" },
          offset: state.offset ?? null,
        });
      } catch (err) {
        // Airtable's page offsets run out after a while; start the list again and skip the boxes already done.
        if (!state.offset || !/LIST_RECORDS_ITERATOR_NOT_AVAILABLE/.test(err.message)) throw err;
        state.offset = null;
        continue;
      }
      for (const record of page.records) {
        if (done.has(record.id)) continue;
        if (Date.now() >= deadline) return false;
        const fields = Object.fromEntries(names.map((n) => [n, record.fields[id(n)]]));
        const box = String(fields["BOX#"] ?? record.id);
        const key = colourwayKey(fields);
        if (key && colourways.has(key)) {
          note(job.report, "older box", { box, recordId: record.id, detail: "A newer box of this colourway was used" });
        } else {
          // Only a box that found its product stands for the colourway: if the newest box has no product yet,
          // an older one of the same colourway may still have.
          if ((await syncBox(job, record.id, box, products)) && key) colourways.add(key);
          // Airtable allows 5 requests a second, and each box takes one or two.
          await sleep(250);
        }
        done.add(record.id);
      }
      state.offset = page.offset;
      if (!state.offset) return true;
      if (await stopRequested(job)) return false;
    }
    return false;
  } finally {
    state.seenColourways = [...colourways];
    state.seenProducts = [...products];
    state.doneRecords = [...done];
  }
}

// Returns true when the box found its product.
async function syncBox(job, recordId, box, products, attempt = 0) {
  let state;
  try {
    state = await preview(recordId, { withChanges: true, only: groupMappings(job.options.rules, job.options.targets) });
  } catch (err) {
    // Airtable asks for 30 seconds' rest after too many requests.
    if (/^Airtable 429/.test(err.message) && attempt < 3) {
      await sleep(30_000);
      return syncBox(job, recordId, box, products, attempt + 1);
    }
    note(job.report, "error", { box, recordId, detail: err.message });
    return false;
  }
  const { match } = state;
  if (!match.product) {
    const detail = match.status === "choose" ? `${match.candidates.length} possible products; choose one on the sync page` : match.reason;
    note(job.report, match.status === "choose" ? "needs a choice" : "no product", { box, recordId, detail });
    return false;
  }
  const line = { box, recordId, productId: match.product.id, product: match.product.title };
  if (products.has(match.product.id)) {
    note(job.report, "older box", { ...line, detail: "A newer box for this product was used" });
    return true;
  }
  products.add(match.product.id);

  const changes = state.preview?.changes ?? [];
  if (changes.length === 0) {
    const skipped = state.preview?.rows.find((r) => r.action === "skip");
    note(job.report, skipped ? "skipped" : "unchanged", { ...line, field: skipped?.label, detail: skipped?.reason });
  } else {
    await write(job, line, match.product.id, changes);
  }
  return true;
}

// Saves (or, on a dry run, only reports) one product's changes, and logs them as a sync from the page would be.
async function write(job, line, productId, changes) {
  const { results } = await applyChanges(productId, changes, { dryRun: job.dryRun });
  for (const c of changes) {
    const error = results.get(c) ?? null;
    note(job.report, error ? "error" : job.dryRun ? "would write" : "written", {
      ...line,
      field: c.target,
      before: c.before,
      after: c.after,
      detail: error,
    });
  }
  if (!job.dryRun) {
    await syncLog().setJSON(`${new Date().toISOString()}_backfill_${productId.split("/").pop()}`, {
      by: job.owner,
      backfill: job.id,
      recordId: line.recordId ?? null,
      box: line.box ?? null,
      productId,
      productTitle: line.product,
      changes: changes.map((c) => ({ target: c.target, ownerId: c.ownerId, before: c.before, after: c.after, error: results.get(c) ?? null })),
    });
  }
}

let boxTableCache = null;
async function boxTableFields() {
  boxTableCache ??= { table: (await getSchema()).get(BOX_TABLE_ID) };
  if (!boxTableCache.table) throw new Error("Box table not found in Airtable base");
  return boxTableCache;
}

// ---------- Subcategory migration ----------
const choiceKey = (s) => String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

// An old value split into its parts, for old fields that hold several subcategories as "Midi, Wrap".
export function splitItems(items, split) {
  if (!split) return items;
  return items.flatMap((item) => item.split(/[,;\n|]/)).map((x) => x.trim()).filter(Boolean);
}

// The new subcategories for a product's old values: { items, unmapped (old values not in the table), invalid
// (table values that aren't among the new metafield's choices) }. Items already in the new field are kept.
export function migrateValues(oldItems, existing, table, choices) {
  const byKey = new Map(Object.entries(table).map(([from, to]) => [choiceKey(from), [].concat(to ?? [])]));
  const unmapped = [];
  const wanted = [];
  for (const item of oldItems) {
    const to = byKey.get(choiceKey(item));
    if (to) wanted.push(...to);
    else unmapped.push(item);
  }
  const { items, unknown } = choices?.length ? matchChoices(wanted, choices) : { items: wanted, unknown: [] };
  const merged = [...existing];
  for (const item of items) if (!merged.some((x) => choiceKey(x) === choiceKey(item))) merged.push(item);
  return { items: merged, unmapped, invalid: unknown };
}

const splitMetafield = (key) => {
  const [namespace, ...rest] = key.split(".");
  return { namespace, key: rest.join(".") };
};

async function migrateStep(job, deadline) {
  const state = job.state;
  const { to, split } = job.options;
  const from = [].concat(job.options.from);
  const definitions = await getMetafieldDefinitions(true);
  const target = definitions.product.find((d) => `${d.namespace}.${d.key}` === to);
  if (!target) throw new Error(`Create the metafield definition ${to} in Shopify first`);
  if (target.type !== "list.single_line_text_field") throw new Error(`${to} is a ${target.type} metafield; it has to be list.single_line_text_field`);
  const { table } = await loadMigration();
  if (Object.keys(table).length === 0) throw new Error("Save the subcategory migration table first");

  const t = splitMetafield(to);
  const olds = from
    .map(splitMetafield)
    .map((f, i) => `old${i}: metafield(namespace: ${JSON.stringify(f.namespace)}, key: ${JSON.stringify(f.key)}) { value }`)
    .join("\n        ");
  const query = `query Migrate($after: String) {
    products(first: 100, after: $after) {
      nodes {
        id title
        ${olds}
        next: metafield(namespace: ${JSON.stringify(t.namespace)}, key: ${JSON.stringify(t.key)}) { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  while (Date.now() < deadline) {
    const data = await graphql(query, { after: state.cursor ?? null });
    const changes = [];
    const lines = new Map();
    for (const p of data.products.nodes) {
      const all = splitItems(from.flatMap((_, i) => metafieldItems(p[`old${i}`]?.value)), split);
      const oldItems = all.filter((x, i) => all.findIndex((y) => choiceKey(y) === choiceKey(x)) === i);
      if (oldItems.length === 0) continue;
      const line = { productId: p.id, product: p.title, field: to };
      const existing = metafieldItems(p.next?.value);
      const { items, unmapped, invalid } = migrateValues(oldItems, existing, table, target.choices);
      for (const value of unmapped) note(job.report, "unmapped", { ...line, before: value, detail: "Not in the migration table" });
      for (const value of invalid) note(job.report, "invalid", { ...line, after: value, detail: `The table maps to a value that isn't one of ${to}'s choices` });
      if (items.length === existing.length) {
        note(job.report, "unchanged", { ...line, before: oldItems });
        continue;
      }
      const change = {
        target: `product:metafield:${to}`,
        owner: "product",
        ownerId: p.id,
        type: "metafield",
        namespace: t.namespace,
        key: t.key,
        metafieldType: target.type,
        value: JSON.stringify(items),
        before: existing.join(", ") || null,
        after: items.join(", "),
      };
      changes.push(change);
      lines.set(change, { ...line, before: oldItems.join(", ") });
    }
    // metafieldsSet takes 25 at a time (applyChanges batches them), for any mix of products.
    if (changes.length) {
      const { results } = await applyChanges(null, changes, { dryRun: job.dryRun });
      for (const c of changes) {
        const error = results.get(c) ?? null;
        note(job.report, error ? "error" : job.dryRun ? "would write" : "written", { ...lines.get(c), after: c.after, detail: error });
        if (!job.dryRun && !error) {
          await syncLog().setJSON(`${new Date().toISOString()}_backfill_${c.ownerId.split("/").pop()}`, {
            by: job.owner,
            backfill: job.id,
            productId: c.ownerId,
            productTitle: lines.get(c).product,
            changes: [{ target: c.target, ownerId: c.ownerId, before: c.before, after: c.after, error: null }],
          });
        }
      }
    }
    state.cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (!state.cursor) return true;
    if (await stopRequested(job)) return false;
  }
  return false;
}

// ---------- Running ----------
// Hands the job to the background function (functions/backfill-background.mjs), signed in as the user whose
// request this is.
export async function startRun(req, job) {
  const res = await fetch(new URL("/api/backfill/run", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: req.headers.get("cookie") ?? "" },
    body: JSON.stringify({ id: job.id, run: job.run }),
  });
  if (!res.ok) throw new Error(`Could not start the background job (${res.status})`);
}

const STEPS = { audit: auditStep, group: groupStep, "subcategory-migrate": migrateStep };

// Runs the job until it's finished or `deadline` (ms timestamp) passes. Returns true when it's finished.
export async function runJob(job, deadline) {
  return STEPS[job.type](job, deadline);
}
