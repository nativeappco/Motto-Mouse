const API = "https://api.airtable.com/v0";

export const BASE_ID = process.env.AIRTABLE_BASE_ID || "appE7udaN5hKssxQC";
export const BOX_TABLE_ID = process.env.AIRTABLE_BOX_TABLE_ID || "tblbpKSpR9bAfLBG5";

async function request(path, params) {
  const key = process.env.AIRTABLE_KEY;
  if (!key) throw new Error("AIRTABLE_KEY is not configured");
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of params ?? []) url.searchParams.append(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Schema rarely changes; cache per warm function instance.
let schemaCache = null;
let schemaFetchedAt = 0;
export async function getSchema(force = false) {
  if (!force && schemaCache && Date.now() - schemaFetchedAt < 10 * 60 * 1000) return schemaCache;
  const data = await request(`meta/bases/${BASE_ID}/tables`);
  schemaCache = new Map(data.tables.map((t) => [t.id, t]));
  schemaFetchedAt = Date.now();
  return schemaCache;
}

export async function listRecords(tableId, { formula, fieldIds, maxRecords = 50, sort } = {}) {
  const params = [
    ["returnFieldsByFieldId", "true"],
    ["maxRecords", String(maxRecords)],
    ["pageSize", String(Math.min(maxRecords, 100))],
  ];
  if (formula) params.push(["filterByFormula", formula]);
  for (const id of fieldIds ?? []) params.push(["fields[]", id]);
  if (sort) {
    params.push(["sort[0][field]", sort.field], ["sort[0][direction]", sort.direction || "asc"]);
  }
  const data = await request(`${BASE_ID}/${tableId}`, params);
  return data.records;
}

export async function getRecord(tableId, recordId) {
  return request(`${BASE_ID}/${tableId}/${recordId}`, [["returnFieldsByFieldId", "true"]]);
}

// Resolve linked record IDs to their primary-field display value.
export async function resolveLinks(schema, idsByTable) {
  const names = new Map();
  await Promise.all(
    [...idsByTable].map(async ([tableId, ids]) => {
      const table = schema.get(tableId);
      if (!table || ids.size === 0) return;
      const all = [...ids];
      for (let i = 0; i < all.length; i += 50) {
        const chunk = all.slice(i, i + 50);
        const formula = `OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(",")})`;
        const recs = await listRecords(tableId, {
          formula,
          fieldIds: [table.primaryFieldId],
          maxRecords: chunk.length,
        });
        for (const r of recs) names.set(r.id, displayValue(r.fields[table.primaryFieldId]) ?? r.id);
      }
    })
  );
  return names;
}

function displayValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(displayValue).filter(Boolean).join(", ");
  if (typeof v === "object") return v.name ?? v.error ?? JSON.stringify(v);
  return String(v).trim();
}
