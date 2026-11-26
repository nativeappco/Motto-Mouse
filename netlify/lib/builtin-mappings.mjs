import { jsonValue } from "./mapping.mjs";

// Mappings that are always on: the source data Product Pelican reads when it writes Motto's product copy, and
// the related product group the theme links colourways by. Rules (further down) are set up in Mapping.
// They need no setup in Mapping, only a metafield definition in Shopify for each (namespace.key, of `type`).
// A mapping saved in Mapping for the same Shopify field takes over from the built-in one.
export const NAMESPACE = "mmm";

// `name` is what the definition should be called in Shopify: Pelican labels the value with it, and its prompts
// refer to the value by that name.
// `fields` are Airtable field names, saved together as one JSON object keyed by name. Where several names are
// given, the first one with a value is used, under the first name.
// `source` is a single mapping source (see extractSources in pdf-extract.mjs).
// `namespace` is NAMESPACE unless given.
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
  // Every colourway of a style has the same REX Description, so the theme can find a product's other colours
  // (swatches, filters, collections) by this value. A new colourway joins its group without touching the others.
  {
    namespace: "custom",
    key: "related_product_group",
    name: "Related product group",
    type: "single_line_text_field",
    fields: ["REX Description"],
  },
];

export const builtinMetafield = (b) => `${b.namespace ?? NAMESPACE}.${b.key}`;
export const builtinTarget = (b) => `product:metafield:${builtinMetafield(b)}`;

// ---------- "First of" sources ----------
// A source id of the form "first:<field id>,<field id>" stands for the first of those Airtable fields that has
// a value. A name that isn't in the table gets "missing:<name>", which matches nothing and so shows as missing.
const FIRST = "first:";

function sourceId(names, byName) {
  const ids = [].concat(names).map((n) => byName.get(n)?.id).filter(Boolean);
  if (ids.length === 0) return `missing:${[].concat(names)[0]}`;
  return ids.length === 1 ? ids[0] : `${FIRST}${ids.join(",")}`;
}

// The Airtable field ids behind a "first of" source, so they can be loaded with the record.
export function underlyingIds(sourceFieldId) {
  if (sourceFieldId.startsWith(FIRST)) return sourceFieldId.slice(FIRST.length).split(",");
  return [];
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

// ---------- Rules ----------
// A mapping in "rules" mode holds if-statements on its Airtable field, saved in Mapping:
//   { sourceFieldId, mode: "rules", rules: [{ is: "Blogger", target: "product:templateSuffix", value: "blogger-shirt" }] }
// When the field holds `is` (ignoring case and surrounding spaces; any item of a list), `value` is written to
// `target`. Rules from every row that write to the same Shopify field become one mapping at sync time:
// a list (tags, list metafields) gets the value of every rule met, any other field the first one's.
const RULES = "rules:";

// Rules only ever add tags; a template is only changed from the default or another rule's template (so one chosen
// by hand stays); anything else is overwritten.
export const ruleWriteMode = (target) => (target === "product:tags" ? "merge" : "replace");
const GUARDED = new Set(["product:templateSuffix"]);

// Every Shopify field a saved mapping writes to (a rules row can write to several).
export const mappingTargets = (m) => (m?.mode === "rules" ? (Array.isArray(m.rules) ? m.rules.map((r) => r?.target) : []) : [m?.target]);

export function ruleMappings(saved) {
  const byTarget = new Map();
  for (const m of saved) {
    if (m.mode !== "rules") continue;
    for (const r of m.rules ?? []) {
      if (!byTarget.has(r.target)) byTarget.set(r.target, []);
      byTarget.get(r.target).push({ fieldId: m.sourceFieldId, is: r.is, value: r.value });
    }
  }
  return [...byTarget].map(([target, rules]) => ({
    id: `${RULES}${target}`,
    sourceFieldId: `${RULES}${target}`,
    target,
    mode: ruleWriteMode(target),
    rule: { name: "Rules" },
    rules,
    ...(GUARDED.has(target) ? { replaces: [...new Set(rules.map((r) => r.value))] } : {}),
  }));
}

const comparable = (s) => String(s ?? "").trim().toLowerCase();

// Every text in an Airtable cell (lookups arrive as lists, selects as { name }).
function texts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (typeof value === "object") return texts(value.name ?? null);
  return [String(value)].filter((t) => t.trim());
}

// What a rules mapping writes for this record: { value (the values of the rules met, or null), reason }.
export function ruleValue(rules, record) {
  const field = (id) => record.fields.find((f) => f.id === id);
  const out = [];
  for (const r of rules) {
    const met = texts(field(r.fieldId)?.value).some((t) => comparable(t) === comparable(r.is));
    if (met && !out.some((v) => comparable(v) === comparable(r.value))) out.push(r.value);
  }
  if (out.length) return { value: out, reason: null };
  const held = [...new Set(rules.map((r) => r.fieldId))].flatMap((id) => texts(field(id)?.value));
  return { value: null, reason: held.length ? `No rule for “${[...new Set(held)].join(", ")}”` : "The Airtable field is empty" };
}

// The Airtable fields the rules mappings read, so they're loaded with the record.
export const ruleFieldIds = (mappings) => mappings.flatMap((m) => m.rules?.map((r) => r.fieldId) ?? []);

// Adds a field to the record for each rules mapping, holding what its rules write.
export function addRuleFields(record, mappings) {
  for (const m of mappings) {
    if (!m.rules) continue;
    const names = [...new Set(m.rules.map((r) => record.fields.find((f) => f.id === r.fieldId)?.name).filter(Boolean))];
    const { value, reason } = ruleValue(m.rules, record);
    record.fields.push({ id: m.sourceFieldId, name: `Rules on ${names.join(", ") || "a missing field"}`, value, emptyReason: reason });
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

// Every mapping a sync applies: the built-in ones, those saved in Mapping, then one per Shopify field the rules
// write to. A built-in gives way to anything saved for its Shopify field.
export function withBuiltins(saved, table) {
  const direct = saved.filter((m) => m.mode !== "rules");
  const taken = new Set(saved.flatMap(mappingTargets));
  return [...builtinMappings(table).filter((m) => !taken.has(m.target)), ...direct, ...ruleMappings(saved)];
}

// The built-in mappings as the Mapping page lists them, with where each one stands in Shopify.
export function describeBuiltins(saved, definitions) {
  const taken = new Set(saved.flatMap(mappingTargets));
  return BUILTINS.map((b) => {
    const namespace = b.namespace ?? NAMESPACE;
    const definition = definitions?.product.find((d) => d.namespace === namespace && d.key === b.key);
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
      metafield: builtinMetafield(b),
      type: b.type,
      status,
      foundType: definition?.type ?? null,
      sources: b.source ? [b.name] : b.fields.map((names) => [].concat(names).join(", or ")),
    };
  });
}
