import assert from "node:assert/strict";
import { test } from "node:test";
import { boxKeys, colourScore, normaliseColour, pickAuto, rankCandidates } from "../netlify/lib/shopify-match.mjs";
import { jsonValue, validateMappings } from "../netlify/lib/mapping.mjs";
import { addFirstOfFields, BUILTINS, builtinMappings, describeBuiltins, withBuiltins } from "../netlify/lib/builtin-mappings.mjs";
import { measurementLines } from "../netlify/lib/measurements.mjs";
import { EXTRACTS, extractSources, firstPdf, promptHash, sectionText, sourceText } from "../netlify/lib/pdf-extract.mjs";
import { applyChanges, buildRequests, skuMatches } from "../netlify/lib/shopify-products.mjs";
import { buildPreview, mappedKeys } from "../netlify/lib/sync.mjs";

test("an Airtable SKU matches every size of that product and nothing else", () => {
  for (const value of ["9166_", "9166", " 9166_ "]) {
    assert.equal(skuMatches("9166_8", value), true);
    assert.equal(skuMatches("9166_10", value), true);
    assert.equal(skuMatches("91667_8", value), false);
    assert.equal(skuMatches("9167_8", value), false);
    assert.equal(skuMatches(null, value), false);
  }
  assert.equal(skuMatches("9166_8", "9166_8"), true);
  assert.equal(skuMatches("9166_8", "_"), false);
});

const candidate = (title, ...colours) => ({ id: title, title, colours });

test("colours are compared without case, punctuation or Pantone codes", () => {
  assert.equal(normaliseColour(" Earthy Brown 19-0912 "), "EARTHY BROWN");
  assert.equal(normaliseColour("IVORY/BLACK"), "IVORY BLACK");
  assert.equal(colourScore("black", ["BLACK"]), 3);
  assert.equal(colourScore("CHOC", ["CHOCOLATE"]), 2);
  assert.equal(colourScore("IVORY/BLACK", ["IVORY STRIPE"]), 1);
  assert.equal(colourScore("COBALT", ["KHAKI"]), 0);
  assert.equal(colourScore("", ["BLACK"]), 0);
});

test("a product is only picked automatically on one exact colour match", () => {
  const products = [candidate("Khaki", "KHAKI"), candidate("Black", "BLACK"), candidate("Chocolate", "CHOCOLATE")];
  assert.equal(pickAuto("BLACK", products)?.title, "Black");
  assert.equal(pickAuto("CHOC", products), null);
  assert.equal(pickAuto("BLACK", [...products, candidate("Black again", "BLACK")]), null);
  assert.deepEqual(rankCandidates("CHOC", products).map((c) => c.title), ["Chocolate", "Black", "Khaki"]);
});

test("box values come from the record's fields, whatever shape Airtable gives them", () => {
  const record = {
    fields: [
      { name: "BOX#", value: "B6781 " },
      { name: "PATTERN#", value: ["10511"] },
      { name: "COLOURWAY", value: [{ linkId: "rec1", name: "CHOC" }] },
      { name: "SKU", value: null },
    ],
  };
  assert.deepEqual(boxKeys(record), { box: "B6781", sku: "", pattern: "10511", colourway: "CHOC" });
});

const definitions = {
  product: [
    { namespace: "custom", key: "stretch", name: "Stretch", type: "multi_line_text_field", choices: null },
    { namespace: "custom", key: "colour", name: "Colour", type: "list.metaobject_reference", choices: null },
  ],
  variant: [],
};
const record = {
  fields: [
    { id: "fldTags", name: "Sub-Category", value: ["Wrap", "Cami"] },
    { id: "fldRange", name: "Range Tag", value: "tops" },
    { id: "fldStretch", name: "Stretch Rating", value: "High stretch" },
    { id: "fldPrice", name: "Confirmed RRP", value: 99.95 },
    { id: "fldEmpty", name: "Handfeel", value: null },
  ],
};
const product = () => ({
  id: "gid://shopify/Product/1",
  currency: "AUD",
  values: { title: "Chocolate Tencel Liv Top", tags: ["tops", "lmtbyb"], vendor: "10511" },
  metafields: { "custom.stretch": { type: "multi_line_text_field", value: "Old text" } },
  variants: [
    { id: "gid://shopify/ProductVariant/1", values: { price: "99.95" }, metafields: {} },
    { id: "gid://shopify/ProductVariant/2", values: { price: "89.95" }, metafields: {} },
  ],
});
const mapping = (sourceFieldId, target, mode) => ({ id: `${sourceFieldId}-${target}`, sourceFieldId, target, mode });

test("merge mappings to the same field are applied one after another", () => {
  const { rows, changes } = buildPreview(
    record,
    product(),
    [mapping("fldTags", "product:tags", "merge"), mapping("fldRange", "product:tags", "merge")],
    definitions
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "set");
  assert.deepEqual(changes[0].value, ["tops", "lmtbyb", "Wrap", "Cami"]);
  assert.equal(changes[0].path, "tags");
});

test("replace, new and empty values behave as the modes describe", () => {
  const { rows, changes } = buildPreview(
    record,
    product(),
    [
      mapping("fldStretch", "product:metafield:custom.stretch", "replace"),
      mapping("fldStretch", "product:vendor", "new"),
      mapping("fldEmpty", "product:title", "replace"),
    ],
    definitions
  );
  const byTarget = Object.fromEntries(rows.map((r) => [r.target, r]));
  assert.equal(byTarget["product:metafield:custom.stretch"].action, "set");
  assert.deepEqual(byTarget["product:metafield:custom.stretch"].current, ["Old text"]);
  assert.equal(byTarget["product:vendor"].action, "skip");
  assert.equal(byTarget["product:title"].action, "skip");
  assert.equal(changes.length, 1);
  assert.deepEqual(
    { type: changes[0].type, namespace: changes[0].namespace, key: changes[0].key, value: changes[0].value },
    { type: "metafield", namespace: "custom", key: "stretch", value: "High stretch" }
  );
});

test("variant fields only change on the variants that differ", () => {
  const { rows, changes } = buildPreview(record, product(), [mapping("fldPrice", "variant:price", "replace")], definitions);
  assert.equal(rows[0].changing, 1);
  assert.equal(rows[0].of, 2);
  assert.deepEqual(rows[0].current, ["99.95", "89.95"]);
  assert.deepEqual(rows[0].next, ["99.95"]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].ownerId, "gid://shopify/ProductVariant/2");
});

test("metafield types that can't be written are skipped with a reason", () => {
  const { rows, changes } = buildPreview(record, product(), [mapping("fldRange", "product:metafield:custom.colour", "replace")], definitions);
  assert.equal(rows[0].action, "skip");
  assert.match(rows[0].reason, /isn't supported/);
  assert.equal(changes.length, 0);
});

test("the fingerprint changes when what would be written changes", () => {
  const mappings = [mapping("fldTags", "product:tags", "merge")];
  const a = buildPreview(record, product(), mappings, definitions);
  const b = buildPreview(record, product(), mappings, definitions);
  const changed = product();
  changed.values.tags = ["tops"];
  const c = buildPreview(record, changed, mappings, definitions);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("only mapped metafields are requested from Shopify", () => {
  assert.deepEqual(
    mappedKeys([
      mapping("a", "product:metafield:custom.stretch", "replace"),
      mapping("b", "variant:metafield:custom.size", "new"),
      mapping("c", "product:title", "replace"),
    ]),
    { keys: ["custom.stretch"], variantKeys: ["custom.size"] }
  );
});

const PRODUCT = "gid://shopify/Product/1";
const variantId = (n) => `gid://shopify/ProductVariant/${n}`;
const metafield = (n) => ({ type: "metafield", owner: "product", ownerId: PRODUCT, namespace: "custom", key: `k${n}`, metafieldType: "single_line_text_field", value: `v${n}` });
const sampleChanges = () => [
  { type: "native", owner: "product", ownerId: PRODUCT, path: "tags", value: ["tops", "Wrap"] },
  { type: "native", owner: "product", ownerId: PRODUCT, path: "seo.title", value: "Wrap Cami" },
  { type: "native", owner: "variant", ownerId: variantId(1), path: "price", value: "99.95" },
  { type: "native", owner: "variant", ownerId: variantId(1), path: "inventoryItem.measurement.weight.value", value: 0.2 },
  { type: "native", owner: "variant", ownerId: variantId(2), path: "price", value: "99.95" },
  ...Array.from({ length: 30 }, (_, i) => metafield(i)),
];

test("changes are grouped into one request per kind, with metafields in batches of 25", () => {
  const requests = buildRequests(PRODUCT, sampleChanges());
  assert.deepEqual(requests.map((r) => r.name), ["productUpdate", "productVariantsBulkUpdate", "metafieldsSet", "metafieldsSet"]);
  assert.deepEqual(requests[0].variables, { product: { id: PRODUCT, tags: ["tops", "Wrap"], seo: { title: "Wrap Cami" } } });
  assert.deepEqual(requests[1].variables.variants, [
    { id: variantId(1), price: "99.95", inventoryItem: { measurement: { weight: { value: 0.2, unit: "KILOGRAMS" } } } },
    { id: variantId(2), price: "99.95" },
  ]);
  assert.deepEqual(requests.slice(2).map((r) => r.variables.metafields.length), [25, 5]);
  assert.deepEqual(requests[2].variables.metafields[0], { ownerId: PRODUCT, namespace: "custom", key: "k0", type: "single_line_text_field", value: "v0" });
});

test("a dry run reports every request without contacting Shopify", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("no network in tests");
  };
  try {
    const changes = sampleChanges();
    const { results, requests } = await applyChanges(PRODUCT, changes, { dryRun: true });
    assert.equal(calls, 0);
    assert.equal(requests.length, 4);
    assert.deepEqual(Object.keys(requests[0]), ["name", "variables"]);
    assert.equal(results.size, changes.length);
    assert.ok([...results.values()].every((error) => error === null));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- JSON metafields ----------
const jsonDefinitions = {
  product: [
    ...definitions.product,
    { namespace: "custom", key: "airtable_data", name: "Airtable Data", type: "json", choices: null },
    { namespace: "custom", key: "tech_pack", name: "Tech Pack", type: "multi_line_text_field", choices: null },
  ],
  variant: [],
};
const AIRTABLE_DATA = "product:metafield:custom.airtable_data";
const jsonMappings = (mode) => ["fldTags", "fldRange", "fldStretch", "fldPrice", "fldEmpty"].map((id) => mapping(id, AIRTABLE_DATA, mode));
const withJson = (value) => {
  const p = product();
  if (value !== undefined) p.metafields["custom.airtable_data"] = { type: "json", value: JSON.stringify(value) };
  return p;
};

test("Airtable values keep their shape in JSON", () => {
  assert.equal(jsonValue("  High stretch "), "High stretch");
  assert.equal(jsonValue(99.95), 99.95);
  assert.equal(jsonValue(false), false);
  assert.equal(jsonValue(0), 0);
  assert.deepEqual(jsonValue(["Wrap", "Cami"]), ["Wrap", "Cami"]);
  // Lookups hold one value in a list; selects and linked records are objects with a name.
  assert.equal(jsonValue(["Tencel Basic"]), "Tencel Basic");
  assert.equal(jsonValue({ name: "High" }), "High");
  assert.deepEqual(jsonValue([{ linkId: "rec1", name: "NAVY" }, { linkId: "rec2", name: "PINK" }]), ["NAVY", "PINK"]);
  assert.equal(jsonValue([{ id: "att1", url: "https://example.com/x.pdf", filename: "PO3788.pdf" }]), "PO3788.pdf");
  for (const empty of [null, undefined, "", "  ", [], [null, ""], { error: "#ERROR!" }]) assert.equal(jsonValue(empty), undefined);
});

test("fields mapped to one JSON metafield are combined into a single object", () => {
  const { rows, changes } = buildPreview(record, product(), jsonMappings("replace"), jsonDefinitions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "set");
  assert.deepEqual(rows[0].combined, { included: 4, of: 5 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].metafieldType, "json");
  // Keyed by Airtable field name, in mapping order, with the empty field left out.
  assert.equal(
    changes[0].value,
    JSON.stringify({ "Sub-Category": ["Wrap", "Cami"], "Range Tag": "tops", "Stretch Rating": "High stretch", "Confirmed RRP": 99.95 })
  );
  const [request] = buildRequests(product().id, changes);
  assert.equal(request.name, "metafieldsSet");
  assert.deepEqual(JSON.parse(request.variables.metafields[0].value)["Sub-Category"], ["Wrap", "Cami"]);
});

test("a JSON metafield is left alone when Shopify already holds the same object", () => {
  const same = { "Confirmed RRP": 99.95, "Stretch Rating": "High stretch", "Range Tag": "tops", "Sub-Category": ["Wrap", "Cami"] };
  const { rows, changes } = buildPreview(record, withJson(same), jsonMappings("replace"), jsonDefinitions);
  assert.equal(rows[0].action, "unchanged");
  assert.equal(changes.length, 0);
});

test("JSON modes: replace drops other keys, merge keeps them, new only fills an empty metafield", () => {
  const existing = { "Range Tag": "old", Note: "kept by hand" };
  const value = (mode, current) => {
    const { rows, changes } = buildPreview(record, withJson(current), jsonMappings(mode), jsonDefinitions);
    return { row: rows[0], value: changes[0] && JSON.parse(changes[0].value) };
  };
  assert.equal(value("replace", existing).value.Note, undefined);
  assert.deepEqual(value("merge", existing).value, {
    "Range Tag": "tops",
    Note: "kept by hand",
    "Sub-Category": ["Wrap", "Cami"],
    "Stretch Rating": "High stretch",
    "Confirmed RRP": 99.95,
  });
  assert.equal(value("new", existing).row.action, "skip");
  assert.equal(value("new", undefined).row.action, "set");
  // There's nothing to merge keys into when Shopify holds a list.
  const list = value("merge", ["a"]);
  assert.equal(list.row.action, "skip");
  assert.match(list.row.reason, /isn't an object/);
});

test("a JSON metafield whose Airtable fields are all empty is skipped", () => {
  const { rows, changes } = buildPreview(record, product(), [mapping("fldEmpty", AIRTABLE_DATA, "replace")], jsonDefinitions);
  assert.equal(rows[0].action, "skip");
  assert.equal(rows[0].reason, "The Airtable fields are empty");
  assert.equal(changes.length, 0);
});

// ---------- Mapping rules ----------
const table = {
  fields: [
    { id: "fldTags", name: "Sub-Category" },
    { id: "fldRange", name: "Range Tag" },
    { id: "fldPdf", name: "PDF BULK TECH PACK " },
  ],
};

test("several rows may share a JSON metafield, but only in one mode", () => {
  const rows = (a, b) => [mapping("fldTags", AIRTABLE_DATA, a), mapping("fldRange", AIRTABLE_DATA, b)];
  assert.equal(validateMappings(rows("replace", "replace"), table, jsonDefinitions).mappings.length, 2);
  assert.equal(validateMappings(rows("new", "new"), table, jsonDefinitions).mappings.length, 2);
  assert.match(validateMappings(rows("replace", "merge"), table, jsonDefinitions).error, /same “Existing data” setting/);
  // Other fields still only take several rows when they all merge.
  const stretch = "product:metafield:custom.stretch";
  assert.match(validateMappings([mapping("fldTags", stretch, "replace"), mapping("fldRange", stretch, "replace")], table, jsonDefinitions).error, /Set them all to Merge/);
});

// ---------- Tech pack ----------
test("the tech pack is a mapping source when its PDF field exists", () => {
  const sources = extractSources(table);
  assert.deepEqual(sources[0], { id: "extract:tech-pack", extract: "tech-pack", label: "Tech pack", name: "Tech pack text", fieldId: "fldPdf", fieldName: "PDF BULK TECH PACK" });
  // Each section of the text is a source too, so a metafield can hold just that part.
  assert.deepEqual(sources.slice(1).map((s) => [s.id, s.name]), [
    ["extract:tech-pack#design", "Tech pack: Design"],
    ["extract:tech-pack#construction", "Tech pack: Construction"],
    ["extract:tech-pack#bom", "Tech pack: BOM"],
    ["extract:tech-pack#care", "Tech pack: Care label"],
    ["extract:tech-pack#measurements", "Tech pack: Measurements"],
  ]);
  assert.deepEqual(extractSources({ fields: table.fields.slice(0, 2) }), []);
  const ok = validateMappings([mapping("extract:tech-pack", "product:metafield:custom.tech_pack", "replace")], table, jsonDefinitions);
  assert.equal(ok.mappings[0].sourceFieldId, "extract:tech-pack");
  assert.match(validateMappings([mapping("extract:nope", "product:title", "replace")], table, jsonDefinitions).error, /choose an Airtable field/);
});

test("the PDF that gets read is the first one in the field", () => {
  const image = { id: "att1", type: "image/png", filename: "sketch.png" };
  const pdf = { id: "att2", type: "application/pdf", filename: "PO3788.pdf" };
  assert.equal(firstPdf([image, pdf, { id: "att3", type: "application/pdf" }]), pdf);
  assert.equal(firstPdf([image]), null);
  assert.equal(firstPdf(null), null);
});

test("tech pack text is written as it was read, and says why when there isn't any", () => {
  const markdown = "## Measurements\n\n| Field | Value |\n| --- | --- |\n| Style number | 10546 |\n\n## Construction\n- Twin needle hem";
  const mappings = [mapping("extract:tech-pack", "product:metafield:custom.tech_pack", "replace")];
  const read = { fields: [...record.fields, { id: "extract:tech-pack", name: "Tech pack", value: markdown }] };
  const { changes } = buildPreview(read, product(), mappings, jsonDefinitions);
  assert.equal(changes[0].metafieldType, "multi_line_text_field");
  assert.equal(changes[0].value, markdown);

  const unread = { fields: [...record.fields, { id: "extract:tech-pack", name: "Tech pack", value: null, emptyReason: "The tech pack PDF hasn't been read yet" }] };
  const { rows, changes: none } = buildPreview(unread, product(), mappings, jsonDefinitions);
  assert.equal(rows[0].action, "skip");
  assert.equal(rows[0].reason, "The tech pack PDF hasn't been read yet");
  assert.equal(none.length, 0);
});

test("editing the prompt makes earlier results out of date", () => {
  const prompt = EXTRACTS["tech-pack"].prompt;
  assert.equal(promptHash(prompt), promptHash(prompt));
  assert.notEqual(promptHash(prompt), promptHash(`${prompt}\nAlso list the care instructions.`));
});


// ---------- Tech pack sections ----------
const techPack = [
  "## Design",
  "### Sketches",
  "- Funnel neck (front)",
  "",
  "## Construction",
  "### Waist",
  "- Elasticated back waist",
  "",
  "## Bill of materials",
  "_Not found in this PDF._",
  "",
  "## Measurements",
  "| REF | POINT OF MEASURE | 8 | 10 | 12 | GRADE (cm) |",
  "| --- | --- | --- | --- | --- | --- |",
  "| | APPROXIMATE FINISHED GARMENT MEASUREMENTS | | | | |",
  "| A | BUST CIRCUMFERENCE AT UNDERARM | 108 | 113.0 | 118.0 | 5.0 |",
  "| B | HPS NECK TO FRONT HEM | 66.6 | 67.2 | 67.8 | 0.6 |",
  "| C | COLLAR HEIGHT | 5.5 | 5.5 | 5.5 | 0.0 |",
  "",
  "These specifications must be adhered to by the Supplier.",
].join("\n");
const section = (id) => extractSources(table).find((s) => s.section === id);

test("a section source sends only its part of the tech pack text", () => {
  assert.equal(sectionText(techPack, "Construction"), "### Waist\n- Elasticated back waist");
  assert.equal(sectionText(techPack, "construction"), "### Waist\n- Elasticated back waist");
  assert.equal(sectionText(techPack, "Care label"), null);
  assert.deepEqual(sourceText(section("design"), techPack), { value: "### Sketches\n- Funnel neck (front)" });
  assert.deepEqual(sourceText(extractSources(table)[0], techPack), { value: techPack });
});

test("a section that's missing or empty says so instead of sending text", () => {
  assert.match(sourceText(section("bom"), techPack).reason, /tech pack has no bom/);
  // Text read with an older prompt has no such heading at all.
  assert.match(sourceText(section("care"), techPack).reason, /no “Care label” section/);
  assert.equal(sourceText(section("care"), techPack).value, null);
});

test("measurements are sent as the base size and its grade, not as a table", () => {
  assert.equal(
    sourceText(section("measurements"), techPack).value,
    [
      "BUST CIRCUMFERENCE AT UNDERARM: 108cm for Size 8, +5cm per size",
      "HPS NECK TO FRONT HEM: 66.6cm for Size 8, +0.6cm per size",
      "COLLAR HEIGHT: 5.5cm for Size 8, same in all sizes",
    ].join("\n")
  );
});

const spec = (head, ...rows) => [`| POINT OF MEASURE | ${head.join(" | ")} |`, `| --- |${head.map(() => " --- |").join("")}`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

test("the base size is 8, or S where sizes are lettered", () => {
  assert.equal(measurementLines(spec(["XS", "S", "M", "L"], ["BUST", 102, 108, 114, 120])), "BUST: 108cm for Size S, +6cm per size");
  assert.equal(measurementLines(spec(["SIZE 8", "SIZE 10"], ["WAIST", "74.0", "79.0"])), "WAIST: 74cm for Size 8, +5cm per size");
  assert.equal(measurementLines(spec(["10", "12", "14"], ["WAIST", 79, 84, 89])), "WAIST: 79cm for Size 10, +5cm per size");
});

test("combined and one-size measurements are given as they are", () => {
  assert.equal(measurementLines(spec(["S/M", "M/L"], ["TOTAL BELT LENGTH", 102, 118])), "TOTAL BELT LENGTH: 102cm for S/M, 118cm for M/L");
  assert.equal(measurementLines(spec(["ONE SIZE"], ["CHAIN LENGTH", "48.0"])), "CHAIN LENGTH: 48cm");
});

test("a grade is only stated when every size follows it", () => {
  // An uneven run, and a printed grade the sizes don't follow, are both spelt out size by size.
  assert.equal(measurementLines(spec(["8", "10", "12"], ["HIP", 100, 105, 112])), "HIP: 8 = 100cm, 10 = 105cm, 12 = 112cm (the grade varies between sizes)");
  assert.equal(
    measurementLines(spec(["8", "10", "12", "GRADE"], ["HIP", 100, 105, 110, 4])),
    "HIP: 8 = 100cm, 10 = 105cm, 12 = 110cm (the grade column says 4cm, the sizes don't follow it)"
  );
  // With only the base size filled in, the printed grade is all there is to go on.
  assert.equal(measurementLines(spec(["8", "10", "12", "GRADE"], ["HIP", 100, "", "", 5])), "HIP: 100cm for Size 8, +5cm per size");
  assert.equal(measurementLines(spec(["8", "10", "12"], ["RISE", 30, 29.5, 29])), "RISE: 30cm for Size 8, -0.5cm per size");
});

test("text without a sized table isn't treated as measurements", () => {
  assert.equal(measurementLines("| Field | Value |\n| --- | --- |\n| Style number | 60387 |"), null);
  assert.equal(measurementLines("No spec sheet in this pack."), null);
  // The section's text is then sent as it was read.
  assert.equal(sourceText(section("measurements"), "## Measurements\nSee supplier sheet.").value, "See supplier sheet.");
});

// ---------- Built-in mappings ----------
const boxTable = {
  fields: [
    ...["REX Description", "Description", "REX Col Name", "COLOURWAY", "Category", "Sub-Category", "Super-Category", "PO#"].map((name, i) => ({ id: `fldId${i}`, name })),
    // Airtable has this one with a trailing space.
    ...["Fiber Comp % ", "Fabric Weight", "Handfeel & Finish", "Stretch Rating", "Fabric Tag"].map((name, i) => ({ id: `fldFab${i}`, name })),
    ...["Size Set", "ACTIVE SIZES", "Sizing Advice", "Fit Type"].map((name, i) => ({ id: `fldSize${i}`, name })),
    { id: "fldPdf", name: "PDF BULK TECH PACK" },
  ],
};
const builtinDefinitions = {
  product: BUILTINS.map((b) => ({ namespace: "mmm", key: b.key, name: b.name, type: b.type, choices: null })),
  variant: [],
};

test("built-in mappings cover every source metafield without anything being saved", () => {
  const mappings = builtinMappings(boxTable);
  assert.deepEqual([...new Set(mappings.map((m) => m.target))], BUILTINS.map((b) => `product:metafield:mmm.${b.key}`));
  assert.ok(mappings.every((m) => m.mode === "replace" && m.builtin));
  const sources = (key) => mappings.filter((m) => m.target === `product:metafield:mmm.${key}`).map((m) => m.sourceFieldId);
  // Fields with a fallback become one "first of" source; a field the table doesn't have is marked missing.
  assert.deepEqual(sources("source_identity"), ["first:fldId0,fldId1", "first:fldId2,fldId3", "fldId4", "fldId5", "fldId6", "fldId7"]);
  assert.deepEqual(sources("source_fabric"), ["fldFab0", "fldFab1", "fldFab2", "fldFab3", "fldFab4"]);
  assert.deepEqual(sources("source_sizing"), ["fldSize0", "fldSize1", "fldSize2", "fldSize3", "missing:Sizing / Description Notes"]);
  assert.deepEqual(sources("techpack_care_label"), ["extract:tech-pack#care"]);
});

test("a fallback field is used only when the first one is empty, and keeps the first one's name", () => {
  const fields = (rex, colourway) => [
    { id: "fldId2", name: "REX Col Name", value: rex },
    { id: "fldId3", name: "COLOURWAY", value: colourway },
  ];
  const first = (rex, colourway) => {
    const r = { fields: fields(rex, colourway) };
    addFirstOfFields(r, ["first:fldId2,fldId3", "fldId4"]);
    return r.fields.at(-1);
  };
  assert.deepEqual(first("BLACK PRINT", ["BLK/WHT"]), { id: "first:fldId2,fldId3", name: "REX Col Name", value: "BLACK PRINT" });
  assert.deepEqual(first(" ", ["BLK/WHT"]), { id: "first:fldId2,fldId3", name: "REX Col Name", value: ["BLK/WHT"] });
  assert.deepEqual(first(null, []), { id: "first:fldId2,fldId3", name: "REX Col Name", value: null });
});

test("built-in fields are saved as one JSON object per source metafield", () => {
  const mappings = builtinMappings(boxTable).filter((m) => m.target.endsWith("source_fabric"));
  const box = {
    fields: [
      { id: "fldFab0", name: "Fiber Comp %", value: "85% Lyocell 15% Nylon" },
      { id: "fldFab1", name: "Fabric Weight", value: { name: "Light" } },
      { id: "fldFab2", name: "Handfeel & Finish", value: "Silky, Smooth" },
      { id: "fldFab3", name: "Stretch Rating", value: { name: "0 – No Stretch" } },
      { id: "fldFab4", name: "Fabric Tag", value: null },
    ],
  };
  const { rows, changes } = buildPreview(box, product(), mappings, builtinDefinitions);
  assert.equal(rows[0].label, "Source: Fabric");
  assert.deepEqual(JSON.parse(changes[0].value), {
    "Fiber Comp %": "85% Lyocell 15% Nylon",
    "Fabric Weight": "Light",
    "Handfeel & Finish": "Silky, Smooth",
    "Stretch Rating": "0 – No Stretch",
  });
});

test("a built-in mapping says which definition it's waiting for", () => {
  const mappings = builtinMappings(boxTable).filter((m) => m.target.endsWith("techpack_care_label"));
  const box = { fields: [{ id: "extract:tech-pack#care", name: "Tech pack: Care label", value: "Cold hand wash" }] };
  const none = buildPreview(box, product(), mappings, { product: [], variant: [] });
  assert.equal(none.rows[0].label, "Tech pack: Care label");
  assert.equal(none.rows[0].reason, "Create the metafield definition mmm.techpack_care_label (multi_line_text_field) in Shopify");
  assert.equal(none.changes.length, 0);

  const wrong = { product: [{ namespace: "mmm", key: "techpack_care_label", name: "Care", type: "single_line_text_field", choices: null }], variant: [] };
  assert.match(buildPreview(box, product(), mappings, wrong).rows[0].reason, /is a single_line_text_field metafield in Shopify, and has to be multi_line_text_field/);
  assert.equal(buildPreview(box, product(), mappings, builtinDefinitions).changes[0].value, "Cold hand wash");
});

test("a mapping saved in Mapping replaces the built-in one for the same Shopify field", () => {
  const saved = [mapping("fldFab0", "product:metafield:mmm.source_fabric", "merge"), mapping("fldId4", "product:tags", "merge")];
  const all = withBuiltins(saved, boxTable);
  assert.deepEqual(all.filter((m) => m.target.endsWith("source_fabric")), [saved[0]]);
  assert.equal(all.at(-1), saved[1]);
  assert.equal(all.filter((m) => m.builtin).length, builtinMappings(boxTable).length - 5);

  const listed = describeBuiltins(saved, { product: builtinDefinitions.product.slice(1), variant: [] });
  assert.deepEqual(listed.slice(0, 3).map((b) => [b.metafield, b.status]), [["mmm.source_identity", "missing"], ["mmm.source_fabric", "overridden"], ["mmm.source_sizing", "ready"]]);
  assert.equal(listed[0].sources[0], "REX Description, or Description");
  assert.equal(describeBuiltins([], null)[0].status, "unknown");
});
