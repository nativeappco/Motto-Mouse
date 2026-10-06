import { getStore } from "@netlify/blobs";
import { extractSources } from "./pdf-extract.mjs";
import { metafieldKind, nativeField } from "./shopify-fields.mjs";

// ---------- Update modes ----------
// merge   – append to what's already in Shopify (tags, list metafields, text); for JSON, add or update keys
// replace – overwrite whatever is in Shopify
// new     – only fill the field if it's currently empty in Shopify
export const MODES = ["merge", "replace", "new"];

// Kinds where appending is meaningful. Everything else is a single value, so only replace/new apply.
const MERGEABLE = new Set(["list", "text", "multiline", "html"]);

export function modesFor(kind) {
  return MERGEABLE.has(kind) || kind === "json" ? MODES : ["replace", "new"];
}

// ---------- Targets ----------
// Target ids: "product:<key>", "variant:<key>", "product:metafield:<namespace>.<key>", "variant:metafield:<namespace>.<key>"
export function parseTarget(target) {
  const m = /^(product|variant):(?:metafield:([^.\s]+)\.(\S+)|(\w+))$/.exec(String(target ?? ""));
  if (!m) return null;
  const [, owner, namespace, key, native] = m;
  return native ? { owner, type: "native", key: native } : { owner, type: "metafield", namespace, key };
}

// Resolves a target id against the native field list and fetched metafield definitions.
// `definitions` may be null when Shopify isn't reachable; metafield targets then resolve to null.
export function resolveTarget(target, definitions) {
  const t = parseTarget(target);
  if (!t) return null;
  if (t.type === "native") {
    const f = nativeField(t.owner, t.key);
    return f && { ...t, id: target, label: f.label, kind: f.kind, choices: f.choices ?? null };
  }
  const def = definitions?.[t.owner]?.find((d) => d.namespace === t.namespace && d.key === t.key);
  return def && {
    ...t,
    id: target,
    label: def.name,
    kind: metafieldKind(def.type),
    metafieldType: def.type,
    choices: def.choices,
  };
}

// ---------- Storage ----------
const STORE = "settings";
const KEY = "shopify-mappings";

function store() {
  return getStore({ name: STORE, consistency: "strong" });
}

export async function loadMappings() {
  return (await store().get(KEY, { type: "json" })) ?? { mappings: [], updatedAt: null, updatedBy: null };
}

export async function saveMappings(mappings, username) {
  const value = { mappings, updatedAt: new Date().toISOString(), updatedBy: username };
  await store().setJSON(KEY, value);
  return value;
}

// Checks a list of mappings from the client. Returns { mappings } or { error }.
export function validateMappings(input, table, definitions) {
  if (!Array.isArray(input)) return { error: "mappings must be a list" };
  if (input.length > 200) return { error: "Too many mappings" };
  const sourceIds = new Set([...table.fields.map((f) => f.id), ...extractSources(table).map((s) => s.id)]);
  const out = [];
  const byTarget = new Map();

  for (const [i, m] of input.entries()) {
    const row = `Row ${i + 1}`;
    if (!m || typeof m !== "object") return { error: `${row}: invalid mapping` };
    if (!sourceIds.has(m.sourceFieldId)) return { error: `${row}: choose an Airtable field` };
    const t = parseTarget(m.target);
    if (!t) return { error: `${row}: choose a Shopify field` };
    if (t.type === "metafield" && !definitions) {
      return { error: `${row}: can't check metafields because Shopify isn't reachable` };
    }
    const target = resolveTarget(m.target, definitions);
    if (!target) return { error: `${row}: “${m.target}” is not a Shopify field or metafield definition` };
    if (!modesFor(target.kind).includes(m.mode)) {
      return { error: `${row}: ${target.label} can't use “${m.mode}”; choose ${modesFor(target.kind).join(" or ")}` };
    }
    const id = typeof m.id === "string" && /^[\w-]{1,40}$/.test(m.id) ? m.id : crypto.randomUUID();
    out.push({ id, sourceFieldId: m.sourceFieldId, target: m.target, mode: m.mode });
    if (!byTarget.has(m.target)) byTarget.set(m.target, []);
    byTarget.get(m.target).push({ row: i + 1, mode: m.mode, label: target.label, kind: target.kind });
  }

  for (const rows of byTarget.values()) {
    if (rows.length < 2) continue;
    // A JSON metafield takes any number of Airtable fields as one object, written in a single mode.
    if (rows[0].kind === "json") {
      if (rows.some((r) => r.mode !== rows[0].mode)) {
        return {
          error: `Rows ${rows.map((r) => r.row).join(", ")} are combined into ${rows[0].label}, so they need the same “Existing data” setting.`,
        };
      }
      continue;
    }
    // Several Airtable fields can feed any other Shopify field only if they all append to it.
    if (rows.some((r) => r.mode !== "merge")) {
      return {
        error: `Rows ${rows.map((r) => r.row).join(", ")} all write to ${rows[0].label}. Set them all to Merge, or remove the extras.`,
      };
    }
  }
  return { mappings: out };
}

// ---------- Value handling (used when syncing) ----------

// Turn a raw Airtable cell value into the shape Shopify expects for `kind`. Returns null when there's nothing to write.
export function coerce(value, kind, choices = null) {
  const parts = flatten(value);
  if (parts.length === 0) return null;
  switch (kind) {
    case "list": {
      const items = parts.flatMap((p) => p.split(/[,\n]/)).map((s) => s.trim()).filter(Boolean);
      return items.length ? dedupe(items) : null;
    }
    case "text":
      return parts.join(", ");
    case "multiline":
      return parts.join("\n");
    case "html":
      return parts.map((p) => (/<[a-z][\s\S]*>/i.test(p) ? p : textToHtml(p))).join("\n");
    case "number":
    case "money": {
      const n = Number(String(parts[0]).replace(/[^0-9.\-]/g, ""));
      if (!Number.isFinite(n) || parts[0].trim() === "") return null;
      return kind === "money" ? n.toFixed(2) : n;
    }
    case "boolean":
      return /^(true|yes|y|1|checked)$/i.test(parts[0]);
    case "enum": {
      const v = parts[0].toUpperCase().replace(/\s+/g, "_");
      return choices?.includes(v) ? v : null;
    }
    default:
      if (choices?.length) return choices.includes(parts[0]) ? parts[0] : null;
      return parts.join(", ");
  }
}

// An Airtable cell value as it goes into a JSON metafield, keeping numbers, booleans and lists as they are.
// Returns undefined when there's nothing to write.
export function jsonValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(jsonValue).filter((v) => v !== undefined);
    // Lookups arrive as lists even when they hold one value.
    return items.length === 0 ? undefined : items.length === 1 ? items[0] : items;
  }
  if (typeof value === "object") {
    // Selects, collaborators and linked records have a name; attachments a filename (their URLs expire).
    return jsonValue(value.name ?? value.filename ?? value.email ?? null);
  }
  if (typeof value === "string") return value.trim() || undefined;
  return value;
}

// Decide what to write, given the current Shopify value, the incoming (coerced) value and the mode.
// Returns { action: "set" | "unchanged" | "skip", value?, reason? }.
export function applyMode(mode, kind, existing, incoming) {
  if (isBlank(incoming)) return { action: "skip", reason: "Airtable field is empty" };

  if (kind === "json") {
    if (mode === "new" && !isBlank(existing)) return { action: "skip", reason: "Shopify already has a value" };
    let value = incoming;
    if (mode === "merge" && !isBlank(existing)) {
      if (!isObject(existing)) return { action: "skip", reason: "Shopify holds JSON that isn't an object, so there's nothing to merge into. Use Replace" };
      value = { ...existing, ...incoming };
    }
    return canonical(existing) === canonical(value) ? { action: "unchanged" } : { action: "set", value };
  }

  if (mode === "new") {
    if (!isBlank(existing)) return { action: "skip", reason: "Shopify already has a value" };
    return { action: "set", value: incoming };
  }

  if (mode === "replace") {
    return same(existing, incoming) ? { action: "unchanged" } : { action: "set", value: incoming };
  }

  if (mode === "merge") {
    if (kind === "list") {
      const current = Array.isArray(existing) ? existing : [];
      const merged = dedupe([...current, ...incoming]);
      return merged.length === current.length ? { action: "unchanged" } : { action: "set", value: merged };
    }
    if (MERGEABLE.has(kind)) {
      const current = isBlank(existing) ? "" : String(existing);
      // Don't append the same text again on repeat syncs.
      if (current.includes(incoming)) return { action: "unchanged" };
      const sep = kind === "text" ? " " : "\n";
      return { action: "set", value: current ? `${current}${sep}${incoming}` : incoming };
    }
  }
  return { action: "skip", reason: `“${mode}” isn't supported for this field` };
}

function flatten(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(flatten);
  if (typeof v === "object") {
    // Selects/collaborators have name, linked records (resolved) have name, attachments have url.
    const s = v.name ?? v.url ?? v.email ?? null;
    return s == null ? [] : flatten(s);
  }
  const s = String(v).trim();
  return s ? [s] : [];
}

// Case-insensitive, first spelling wins (Shopify treats tags case-insensitively).
function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => {
    const k = String(x).toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

function isObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isBlank(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return false;
}

// JSON with object keys in a fixed order, so two values can be compared whatever order their keys came in.
function canonical(v) {
  return JSON.stringify(v, (_, x) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = [].concat(a ?? []).map((s) => String(s).toLowerCase()).sort();
    const y = [].concat(b ?? []).map((s) => String(s).toLowerCase()).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return String(a ?? "") === String(b ?? "");
}

function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
