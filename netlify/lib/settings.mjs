import { getStore } from "@netlify/blobs";

// Recommended fields from Motto's "Airtable Online Description Data" brief, in their order.
export const RECOMMENDED_GROUPS = [
  {
    name: "Core identifiers",
    fields: [
      "BOX#",
      "PO#",
      "Description",
      "PATTERN#",
      "Category",
      "Sub-Category",
      "Range Tag",
      "COLOURWAY",
      "IMAGE (from PO#) (from COLOURWAY TAG LINK)",
      "PDF BULK TECH PACK",
    ],
  },
  {
    name: "Fabric & product description",
    fields: [
      "Fabric Tag",
      "Fabric Code",
      "Fiber Comp %",
      "Stretch Rating",
      "Fabric Weight",
      "Handfeel",
      "Sizing Advice",
      "Sizing / Description Notes",
      "Size Set",
      "OLD ONLINE DESC",
    ],
  },
];
export const OTHER_GROUP = "Other fields";

const STORE = "settings";
const KEY = "lookup-fields";

function store() {
  return getStore({ name: STORE, consistency: "strong" });
}

export async function loadLookupSettings() {
  const saved = await store().get(KEY, { type: "json" });
  return saved ?? null;
}

export async function saveLookupSettings(selectedFieldIds, username) {
  const value = { selectedFieldIds, updatedAt: new Date().toISOString(), updatedBy: username };
  await store().setJSON(KEY, value);
  return value;
}

export async function resetLookupSettings() {
  await store().delete(KEY);
}

// Groups every field in the table: recommended groups first (in brief order), then the rest in Airtable order.
export function groupFields(table) {
  const byName = new Map(table.fields.map((f) => [f.name.trim(), f]));
  const used = new Set();
  const groups = RECOMMENDED_GROUPS.map((g) => ({
    name: g.name,
    fields: g.fields
      .map((n) => byName.get(n))
      .filter(Boolean)
      .map((f) => (used.add(f.id), f)),
  }));
  groups.push({ name: OTHER_GROUP, fields: table.fields.filter((f) => !used.has(f.id)) });
  return groups;
}

export function recommendedIds(table) {
  return groupFields(table)
    .filter((g) => g.name !== OTHER_GROUP)
    .flatMap((g) => g.fields.map((f) => f.id));
}

// Selected ids from saved settings, or the recommended defaults. Ignores fields that no longer exist.
export function selectedIds(table, saved) {
  const valid = new Set(table.fields.map((f) => f.id));
  const ids = saved?.selectedFieldIds ?? recommendedIds(table);
  return new Set(ids.filter((id) => valid.has(id)));
}
