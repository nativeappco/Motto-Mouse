import { jsonValue } from "./mapping.mjs";

// Mappings that are always on: the source data Product Pelican reads when it writes Motto's product copy, and
// the related product group the theme links colourways by.
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

// The Airtable field ids behind a mapping source, so they can be loaded with the record.
export function underlyingIds(sourceFieldId) {
  if (sourceFieldId.startsWith(FIRST)) return sourceFieldId.slice(FIRST.length).split(",");
  if (sourceFieldId.startsWith(RULE)) return [...parseRuleSource(sourceFieldId).fieldIds.values()];
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
// Values Mouse works out from a box rather than copying a field: Blogger and Tencel Basic products get their
// bundle template and the tag the theme's "2 for $30" badge looks for (which used to come from Rex).
// A value left as null switches that part of the rule off until it's known.
//
// To add another bundle: add a condition to CONDITIONS (the Airtable field and the value that marks the
// product), then give its id a template in TEMPLATES and/or a tag in BUNDLE_TAGS. The template must exist in
// the live theme (templates/product.<suffix>.json). The Mapping page lists the result.
export const TEMPLATES = {
  blogger: "blogger-shirt", // templates/product.blogger-shirt.json
  tencel: "tencel-template", // templates/product.tencel-template.json
};
export const BUNDLE_TAGS = {
  blogger: null, // the exact tag the theme's bundle badge expects on Blogger products
  tencel: null, // the exact tag for Tencel Basic products
};

// A box meets a condition when the Airtable field holds the value (ignoring case and surrounding spaces).
export const CONDITIONS = [
  { id: "blogger", field: "Sub-Category", is: "Blogger" },
  { id: "tencel", field: "Fabric Tag", is: "Tencel Basic" },
];

// `pick`: "first" writes the value of the first condition met (in CONDITIONS order), "all" writes every one.
export const RULES = [
  { key: "template", name: "Bundle template", target: "product:templateSuffix", mode: "replace", values: TEMPLATES, pick: "first" },
  { key: "bundle-tags", name: "Bundle tag", target: "product:tags", mode: "merge", values: BUNDLE_TAGS, pick: "all" },
];

// A rule's source id names the Airtable field behind each condition: "rule:<key>:<condition>=<field id>,…".
const RULE = "rule:";

function ruleSourceId(rule, byName) {
  const pairs = CONDITIONS.map((c) => byName.get(c.field)).map((f, i) => (f ? `${CONDITIONS[i].id}=${f.id}` : null));
  return `${RULE}${rule.key}:${pairs.filter(Boolean).join(",")}`;
}

function parseRuleSource(id) {
  const [key, list = ""] = id.slice(RULE.length).split(":");
  const fieldIds = new Map(list.split(",").filter(Boolean).map((pair) => pair.split("=")));
  return { rule: RULES.find((r) => r.key === key), fieldIds };
}

const comparable = (s) => String(s ?? "").trim().toLowerCase();

// Every text in an Airtable cell (lookups arrive as lists, selects as { name }).
function texts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (typeof value === "object") return texts(value.name ?? null);
  return [String(value)];
}

// What a rule writes for this record: { value, reason } (value null with the reason when there's nothing to write).
export function ruleValue(rule, record, fieldIds) {
  const met = CONDITIONS.filter((c) => {
    const field = record.fields.find((f) => f.id === fieldIds.get(c.id));
    return texts(field?.value).some((t) => comparable(t) === comparable(c.is));
  });
  if (met.length === 0) return { value: null, reason: `Not a ${CONDITIONS.map((c) => c.is).join(" or ")} product` };
  const chosen = rule.pick === "first" ? met.slice(0, 1) : met;
  const values = chosen.map((c) => rule.values[c.id]).filter(Boolean);
  if (values.length === 0) return { value: null, reason: `${rule.name} for ${chosen.map((c) => c.is).join(" and ")} isn't set in Mouse yet` };
  return { value: rule.pick === "first" ? values[0] : values, reason: null };
}

// Adds a field to the record for each rule source in `sourceIds`, holding what the rule writes.
export function addRuleFields(record, sourceIds) {
  for (const id of new Set(sourceIds)) {
    if (!id.startsWith(RULE)) continue;
    const { rule, fieldIds } = parseRuleSource(id);
    if (!rule) continue;
    const { value, reason } = ruleValue(rule, record, fieldIds);
    record.fields.push({ id, name: rule.name, value, emptyReason: reason });
  }
}

// A rule that replaces a value (the template) only changes the default or another of its own values, so a
// template someone chose by hand (a pre-order page, say) is left alone.
export function ruleMappings(table) {
  const byName = new Map(table.fields.map((f) => [f.name.trim(), f]));
  return RULES.map((rule) => ({
    id: `rule:${rule.key}`,
    sourceFieldId: ruleSourceId(rule, byName),
    target: rule.target,
    mode: rule.mode,
    rule: { name: rule.name },
    ...(rule.mode === "replace" ? { replaces: Object.values(rule.values).filter(Boolean) } : {}),
  }));
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

// A rule gives way to saved mappings on its Shopify field, unless they all add to it as the rule does (tags).
function ruleKept(rule, saved) {
  const same = saved.filter((m) => m.target === rule.target);
  return same.length === 0 || (rule.mode === "merge" && same.every((m) => m.mode === "merge"));
}

// Every mapping a sync applies: the built-in ones, those saved in Mapping, then the rules.
export function withBuiltins(saved, table) {
  const taken = new Set(saved.map((m) => m.target));
  return [
    ...builtinMappings(table).filter((m) => !taken.has(m.target)),
    ...saved,
    ...ruleMappings(table).filter((m) => ruleKept(m, saved)),
  ];
}

// The rules as the Mapping page lists them.
export function describeRules(saved) {
  return RULES.map((rule) => ({
    name: rule.name,
    target: rule.target,
    adds: rule.mode === "merge",
    status: ruleKept(rule, saved) ? (CONDITIONS.some((c) => rule.values[c.id]) ? "ready" : "waiting") : "overridden",
    when: CONDITIONS.map((c) => ({ field: c.field, is: c.is, value: rule.values[c.id] })),
  }));
}

// The built-in mappings as the Mapping page lists them, with where each one stands in Shopify.
export function describeBuiltins(saved, definitions) {
  const taken = new Set(saved.map((m) => m.target));
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
