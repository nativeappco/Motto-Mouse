import { getStore } from "@netlify/blobs";
import { findBySku, findByVendor, getSummary } from "./shopify-products.mjs";

// Works out which Shopify product an Airtable box belongs to. There's no shared id: Shopify holds the
// pattern number as the vendor, with one product per colour, and the colour names don't always agree.

// ---------- Box values used for matching ----------
function text(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return text(v.find((x) => text(x)));
  if (typeof v === "object") return text(v.name);
  return String(v).trim();
}

export const MATCH_FIELDS = ["BOX#", "SKU", "PATTERN#", "COLOURWAY"];

// `record` is a record from loadRecordDetail (record.mjs).
export function boxKeys(record) {
  const field = (name) => text(record.fields.find((f) => f.name === name)?.value);
  return { box: field("BOX#"), sku: field("SKU"), pattern: field("PATTERN#"), colourway: field("COLOURWAY") };
}

// ---------- Colour comparison ----------
// Upper-case, without Pantone codes ("EARTHY BROWN 19-0912") or punctuation.
export function normaliseColour(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/\b\d{2}-\d{4}(\s*T[CP][XG])?\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// 3 = same colour, 2 = one is an abbreviation of the other (CHOC / CHOCOLATE), 1 = shares a word, 0 = unrelated.
export function colourScore(colourway, colours) {
  const a = normaliseColour(colourway);
  if (!a) return 0;
  let best = 0;
  for (const colour of colours) {
    const b = normaliseColour(colour);
    if (!b) continue;
    if (a === b) return 3;
    if (a.startsWith(b) || b.startsWith(a)) best = Math.max(best, 2);
    else if (a.split(" ").some((w) => b.split(" ").includes(w))) best = Math.max(best, 1);
  }
  return best;
}

// Only link without asking when exactly one product has exactly this colour.
export function pickAuto(colourway, candidates) {
  const exact = candidates.filter((c) => colourScore(colourway, c.colours) === 3);
  return exact.length === 1 ? exact[0] : null;
}

export function rankCandidates(colourway, candidates) {
  return candidates
    .map((c) => ({ ...c, score: colourScore(colourway, c.colours) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// ---------- Saved links (Airtable record id -> Shopify product) ----------
function store() {
  return getStore({ name: "shopify-links", consistency: "strong" });
}

export async function saveLink(recordId, productId, username) {
  await store().setJSON(recordId, { productId, method: "chosen", linkedAt: new Date().toISOString(), linkedBy: username });
}

export async function clearLink(recordId) {
  await store().delete(recordId);
}

// ---------- Matching ----------
// The products this box could belong to, and how they were found.
export async function findCandidates(box) {
  if (box.sku) {
    const bySku = await findBySku(box.sku);
    if (bySku.length) return { method: "sku", candidates: bySku };
  }
  return { method: "pattern", candidates: box.pattern ? await findByVendor(box.pattern) : [] };
}

// Returns { status, method, product, candidates, reason }.
// status: "linked" (chosen earlier), "auto" (unambiguous), "choose" (the user must pick) or "none".
// `choose` ignores any saved link and unambiguous match, for when the user wants to pick a different product.
export async function matchProduct(recordId, box, { choose = false } = {}) {
  if (!choose) {
    const link = await store().get(recordId, { type: "json" });
    const product = link && (await getSummary(link.productId));
    if (product) return { status: "linked", method: link.method, product, candidates: [], linkedBy: link.linkedBy };
  }

  const { method, candidates } = await findCandidates(box);
  if (candidates.length === 0) {
    const reason = box.pattern
      ? `No Shopify product has ${box.pattern} as its vendor`
      : "This box has no pattern number or SKU to match on";
    return { status: "none", method, product: null, candidates: [], reason };
  }

  if (!choose) {
    // A SKU that's filled in but not found in Shopify is a warning sign, so ask rather than guess from the colour.
    const auto =
      method === "sku" ? (candidates.length === 1 ? candidates[0] : null) : box.sku ? null : pickAuto(box.colourway, candidates);
    if (auto) return { status: "auto", method, product: auto, candidates: [] };
  }
  return { status: "choose", method, product: null, candidates: rankCandidates(box.colourway, candidates) };
}
