import { createHash } from "node:crypto";
import { applyMode, coerce, parseTarget, resolveTarget } from "./mapping.mjs";
import { nativeField } from "./shopify-fields.mjs";

// Works out what a sync would change: applies the saved mappings to an Airtable record and compares the
// result with what the Shopify product holds now. Nothing here talks to Shopify or Airtable.

// Metafield types the value rules in mapping.mjs can produce. Others (dates, references, JSON, rich text) are skipped.
const METAFIELD_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "url",
  "color",
  "number_integer",
  "number_decimal",
  "boolean",
  "money",
  "list.single_line_text_field",
]);

// The metafields ("namespace.key") the mappings write to, so only those are fetched from Shopify.
export function mappedKeys(mappings) {
  const keys = new Set();
  const variantKeys = new Set();
  for (const m of mappings) {
    const t = parseTarget(m.target);
    if (t?.type === "metafield") (t.owner === "variant" ? variantKeys : keys).add(`${t.namespace}.${t.key}`);
  }
  return { keys: [...keys], variantKeys: [...variantKeys] };
}

// ---------- Values ----------
// Shopify's current value in the same shape coerce() produces, so the two can be compared.
function current(subject, target) {
  if (target.type === "metafield") {
    const raw = subject.metafields[`${target.namespace}.${target.key}`]?.value;
    if (raw == null) return null;
    try {
      if (target.kind === "list") return JSON.parse(raw);
      if (target.kind === "money") return Number(JSON.parse(raw).amount).toFixed(2);
    } catch {
      return null;
    }
    if (target.kind === "number") return Number(raw);
    if (target.kind === "boolean") return raw === "true";
    return raw;
  }
  const v = subject.values[target.key];
  if (v == null) return null;
  if (target.kind === "money") return Number(v).toFixed(2);
  if (target.kind === "number") return Number(v);
  return v;
}

// A reason the incoming value can't be written to this target, or null if it can.
function rejected(target, value) {
  if (target.metafieldType === "number_integer" && !Number.isInteger(value)) return "Shopify needs a whole number here";
  if (target.key === "countryCodeOfOrigin" && !/^[A-Z]{2}$/.test(value)) return "Shopify needs a 2-letter country code here";
  return null;
}

// The string metafieldsSet expects for a value.
function serialise(value, type, currency) {
  if (type.startsWith("list.")) return JSON.stringify(value);
  if (type === "money") return JSON.stringify({ amount: value, currency_code: currency });
  return String(value);
}

function display(value) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  const s = Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

const distinct = (values) => [...new Set(values.map((v) => v ?? ""))].map((v) => v || null);

// ---------- Preview ----------
// Returns { rows, changes, changeCount, fingerprint }.
// rows are for showing to the user (one per Shopify field); changes are what applyChanges (shopify-products.mjs) writes.
export function buildPreview(record, product, mappings, definitions) {
  const byTarget = new Map();
  for (const m of mappings) {
    if (!byTarget.has(m.target)) byTarget.set(m.target, []);
    byTarget.get(m.target).push(m);
  }

  const rows = [];
  const changes = [];
  for (const [targetId, group] of byTarget) {
    const target = resolveTarget(targetId, definitions);
    const sources = group.map((m) => record.fields.find((f) => f.id === m.sourceFieldId));
    const row = {
      target: targetId,
      label: target?.label ?? targetId,
      owner: parseTarget(targetId)?.owner ?? "product",
      sources: sources.map((s) => s?.name ?? "Missing Airtable field"),
      modes: group.map((m) => m.mode),
    };
    const skip = (reason) => rows.push({ ...row, action: "skip", reason, current: [], next: [], changing: 0 });

    if (!target) {
      skip("This Shopify field no longer exists");
      continue;
    }
    if (target.type === "metafield" && !METAFIELD_TYPES.has(target.metafieldType)) {
      skip(`Metafield type “${target.metafieldType}” isn't supported yet`);
      continue;
    }

    const path = target.type === "native" ? nativeField(target.owner, target.key).path : null;
    const subjects = target.owner === "variant" ? product.variants : [product];
    const outcomes = subjects.map((subject) => {
      const before = current(subject, target);
      // Several Airtable fields can feed one Shopify field (all in merge mode), so apply them in turn.
      let value = before;
      let changed = false;
      const reasons = [];
      group.forEach((m, i) => {
        if (!sources[i]) return reasons.push("The Airtable field no longer exists");
        let incoming = coerce(sources[i].value, target.kind, target.choices);
        if (incoming != null && target.key === "countryCodeOfOrigin") incoming = incoming.toUpperCase();
        const problem = incoming == null ? null : rejected(target, incoming);
        if (problem) return reasons.push(problem);
        const result = applyMode(m.mode, target.kind, value, incoming);
        if (result.action === "set") {
          value = result.value;
          changed = true;
        } else if (result.action === "skip") {
          reasons.push(result.reason);
        }
      });
      if (!changed) return { before, after: before, action: reasons.length === group.length ? "skip" : "unchanged", reason: reasons[0] };

      changes.push({
        target: targetId,
        owner: target.owner,
        ownerId: subject.id,
        type: target.type,
        ...(target.type === "native"
          ? { path, value }
          : {
              namespace: target.namespace,
              key: target.key,
              metafieldType: target.metafieldType,
              value: serialise(value, target.metafieldType, product.currency),
            }),
        before: display(before),
        after: display(value),
      });
      return { before, after: value, action: "set" };
    });

    const changing = outcomes.filter((o) => o.action === "set").length;
    const action = changing ? "set" : outcomes.length && outcomes.every((o) => o.action === "skip") ? "skip" : "unchanged";
    rows.push({
      ...row,
      action,
      reason: action === "skip" ? outcomes[0].reason : null,
      // Variants can each hold a different value, so these are lists of the distinct values.
      current: distinct(outcomes.map((o) => display(o.before))),
      next: action === "set" ? distinct(outcomes.filter((o) => o.action === "set").map((o) => display(o.after))) : [],
      changing,
      of: outcomes.length,
    });
  }

  return {
    rows,
    changes,
    changeCount: rows.filter((r) => r.action === "set").length,
    // Identifies exactly what would be written, so an update can be refused if things moved since the preview.
    fingerprint: createHash("sha256")
      .update(JSON.stringify([product.id, changes.map((c) => [c.ownerId, c.target, c.value])]))
      .digest("hex"),
  };
}
