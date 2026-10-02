import { getSession, json } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getSchema, listRecords } from "../lib/airtable.mjs";
import { loadRecordDetail } from "../lib/record.mjs";

// Fields used for searching and for the results list, looked up by name
// (names are trimmed because some Airtable field names have trailing spaces).
const F = {
  box: "BOX#",
  po: "BACK-UP PO#",
  pattern: "PATTERN#",
  description: "Description",
  colourway: "COLOURWAY",
  released: "Released",
  boxNumber: "B# Finder",
  image: "IMAGE (from PO#) (from COLOURWAY TAG LINK)",
};

export default async (req) => {
  if (!getSession(req)) return json({ error: "Not signed in" }, 401);

  const url = new URL(req.url);
  try {
    const schema = await getSchema();
    const table = schema.get(BOX_TABLE_ID);
    if (!table) return json({ error: "Box table not found in Airtable base" }, 500);
    const byName = new Map(table.fields.map((f) => [f.name.trim(), f]));

    const id = url.searchParams.get("id");
    if (id) {
      if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return json({ error: "Invalid record id" }, 400);
      return json({ record: await loadRecordDetail(schema, table, id) });
    }

    const raw = (url.searchParams.get("q") || "").trim();
    if (!raw) return json({ error: "Enter a SKU, box, PO or pattern number" }, 400);
    // Only allow characters that appear in identifiers, which also rules out formula injection.
    if (!/^[A-Za-z0-9 #\-/.]{1,40}$/.test(raw)) {
      return json({ error: "Use letters, numbers, spaces, # - / . only" }, 400);
    }

    const q = raw.toUpperCase().replace(/^#/, "").trim();
    const formula = buildFormula(q);
    const summaryFieldIds = Object.values(F)
      .map((n) => byName.get(n)?.id)
      .filter(Boolean);

    const records = await listRecords(BOX_TABLE_ID, {
      formula,
      fieldIds: summaryFieldIds,
      maxRecords: 50,
      sort: { field: F.boxNumber, direction: "desc" },
    });

    console.log(`[lookup] q="${q}" matches=${records.length}`);

    const results = records.map((r) => summarise(r, byName));
    const detail = results.length === 1 ? await loadRecordDetail(schema, table, results[0].id) : null;
    return json({ query: q, results, record: detail, capped: records.length === 50 });
  } catch (err) {
    console.error("[lookup] error", err);
    return json({ error: "Lookup failed. Check the function logs for details." }, 502);
  }
};

function buildFormula(q) {
  const clauses = [];
  const boxMatch = q.match(/^B?\s*(\d{2,6})$/);
  if (boxMatch) {
    // A bare number could be a box number or a PO number, so check both.
    clauses.push(`UPPER(TRIM({${F.box}}))="B${boxMatch[1]}"`);
    clauses.push(`TRIM({${F.po}}&"")="${boxMatch[1]}"`);
  }
  if (q.length >= 3) {
    clauses.push(`FIND("${q}", UPPER(ARRAYJOIN({${F.pattern}}, ",")))`);
  }
  clauses.push(`UPPER(TRIM({${F.box}}))="${q}"`);
  return `OR(${clauses.join(",")})`;
}

function summarise(r, byName) {
  const get = (name) => r.fields[byName.get(name)?.id];
  const first = (v) => (Array.isArray(v) ? v.find((x) => x != null && x !== "") : v);
  const img = first(get(F.image));
  return {
    id: r.id,
    box: clean(get(F.box)),
    po: clean(get(F.po)),
    pattern: clean(first(get(F.pattern))),
    description: clean(first(get(F.description))),
    colourway: clean(first(get(F.colourway))),
    released: Boolean(get(F.released)),
    thumbnail: img?.thumbnails?.small?.url ?? null,
  };
}

function clean(v) {
  if (v == null) return null;
  return String(v).trim();
}

export const config = { path: "/api/lookup" };
