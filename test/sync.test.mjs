import assert from "node:assert/strict";
import { test } from "node:test";
import { boxKeys, colourScore, normaliseColour, pickAuto, rankCandidates } from "../netlify/lib/shopify-match.mjs";
import { buildPreview, mappedKeys } from "../netlify/lib/sync.mjs";

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
