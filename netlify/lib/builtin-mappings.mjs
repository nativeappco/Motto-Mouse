import { jsonValue } from "./mapping.mjs";

// Mappings that are always on: the source data Product Pelican reads when it writes Motto's product copy.
// They need no setup in Mapping, only a metafield definition in Shopify for each (NAMESPACE.key, of `type`).
// A mapping saved in Mapping for the same Shopify field takes over from the built-in one.
export const NAMESPACE = "mmm";

// `name` is what the definition should be called in Shopify: Pelican labels the value with it, and its prompts
// refer to the value by that name.
// `fields` are Airtable field names, saved together as one JSON object keyed by name. Where several names are
// given, the first one with a value is used, under the first name.
// `source` is a single mapping source (see extractSources in pdf-extract.mjs).
export const BUILTINS = [
  {
    key: "source_identity",
    name: "Source: Identity",
    type: "json",
    fields: [["REX Description", "Description"], ["REX Col Name", "COLOURWAY"], "Category", "Sub-Category", "Super-Category", "PO#"],
  },
  {
    key: "source_fabric",
    name: "Source: Fabric",
    type: "json",
    fields: ["Fiber Comp %", "Fabric Weight", "Handfeel & Finish", "Stretch Rating", "Fabric Tag"],
  },
  {
    key: "source_sizing",
    name: "Source: Sizing",
    type: "json",
    fields: ["Size Set", "ACTIVE SIZES", "Sizing Advice", "Fit Type", "Sizing / Description Notes"],
  },
  { key: "techpack_design", name: "Tech pack: Design", type: "multi_line_text_field", source: "extract:tech-pack#design" },
  { key: "techpack_construction", name: "Tech pack: Construction", type: "multi_line_text_field", source: "extract:tech-pack#construction" },
  { key: "techpack_bom", name: "Tech pack: BOM", type: "multi_line_text_field", source: "extract:tech-pack#bom" },
  { key: "techpack_care_label", name: "Tech pack: Care label", type: "multi_line_text_field", source: "extract:tech-pack#care" },
  { key: "techpack_measurements", name: "Tech pack: Measurements", type: "multi_line_text_field", source: "extract:tech-pack#measurements" },
];

export const builtinTarget = (b) => `product:metafield:${NAMESPACE}.${b.key}`;

// ---------- "First of" sources ----------
// A source id of the form "first:<field id>,<field id>" stands for the first of those Airtable fields that has
// a value. A name that isn't in the table gets "missing:<name>", which matches nothing and so shows as missing.
const FIRST = "first:";

function sourceId(names, byName) {
  const ids = [].concat(names).map((n) => byName.get(n)?.id).filter(Boolean);
  if (ids.length === 0) return `missing:${[].concat(names)[0]}`;
  return ids.length === 1 ? ids[0] : `${FIRST}${ids.join(",")}`;
}

// The Airtable field ids behind a mapping source, so they can be loaded with the record.
export function underlyingIds(sourceFieldId) {
  return sourceFieldId.startsWith(FIRST) ? sourceFieldId.slice(FIRST.length).split(",") : [];
}

// Adds a field to the record for each "first of" source in `sourceIds`, holding the value that was found.
export function addFirstOfFields(record, sourceIds) {
  for (const id of new Set(sourceIds)) {
    const fields = underlyingIds(id).map((x) => record.fields.find((f) => f.id === x)).filter(Boolean);
    if (fields.length === 0) continue;
    const found = fields.find((f) => jsonValue(f.value) !== undefined);
    record.fields.push({ id, name: fields[0].name, value: found?.value ?? null });
  }
}

// ---------- Mappings ----------
// The built-in mappings for this table, in the shape saved ones have, each marked with the definition it needs.
export function builtinMappings(table) {
  const byName = new Map(table.fields.map((f) => [f.name.trim(), f]));
  return BUILTINS.flatMap((b) => {
    const sources = b.source ? [b.source] : b.fields.map((names) => sourceId(names, byName));
    return sources.map((sourceFieldId) => ({
      id: `builtin:${b.key}:${sourceFieldId}`,
      sourceFieldId,
      target: builtinTarget(b),
      mode: "replace",
      builtin: { name: b.name, type: b.type },
    }));
  });
}

// Every mapping a sync applies: the built-in ones, then those saved in Mapping.
export function withBuiltins(saved, table) {
  const taken = new Set(saved.map((m) => m.target));
  return [...builtinMappings(table).filter((m) => !taken.has(m.target)), ...saved];
}

// The built-in mappings as the Mapping page lists them, with where each one stands in Shopify.
export function describeBuiltins(saved, definitions) {
  const taken = new Set(saved.map((m) => m.target));
  return BUILTINS.map((b) => {
    const definition = definitions?.product.find((d) => d.namespace === NAMESPACE && d.key === b.key);
    const status = taken.has(builtinTarget(b))
      ? "overridden"
      : !definitions
        ? "unknown"
        : !definition
          ? "missing"
          : definition.type !== b.type
            ? "wrong-type"
            : "ready";
    return {
      name: b.name,
      metafield: `${NAMESPACE}.${b.key}`,
      type: b.type,
      status,
      foundType: definition?.type ?? null,
      sources: b.source ? [b.name] : b.fields.map((names) => [].concat(names).join(", or ")),
    };
  });
}
