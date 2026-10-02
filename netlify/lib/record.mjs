import { BASE_ID, getRecord, resolveLinks } from "./airtable.mjs";
import { groupFields, loadLookupSettings, selectedIds } from "./settings.mjs";

// Loads one Airtable record with every field of its table, showing linked records by name instead of rec id.
// Each linked table costs an Airtable request, so pass `only` (a Set of field ids) when few fields are needed.
export async function loadRecordDetail(schema, table, recordId, { only = null } = {}) {
  const record = await getRecord(table.id, recordId);
  const wanted = (field) => !only || only.has(field.id);

  // Find every linked record id (direct links and lookups of links) so we can show names instead of rec ids.
  const idsByTable = new Map();
  const linkTableFor = (field) => linkedTableOf(schema, table, field);

  for (const field of table.fields.filter(wanted)) {
    const linked = linkTableFor(field);
    const value = record.fields[field.id];
    if (!linked || !Array.isArray(value)) continue;
    for (const v of value) {
      if (typeof v === "string" && v.startsWith("rec")) {
        if (!idsByTable.has(linked)) idsByTable.set(linked, new Set());
        idsByTable.get(linked).add(v);
      }
    }
  }
  const [linkNames, saved] = await Promise.all([resolveLinks(schema, idsByTable), loadLookupSettings()]);
  const selected = selectedIds(table, saved);

  // Ordered by group (Motto's recommended groups first), each field flagged visible if selected in Settings.
  const fields = groupFields(table).flatMap((group) =>
    group.fields.filter(wanted).map((field) => {
      const value = record.fields[field.id];
      const linked = linkTableFor(field);
      return {
        id: field.id,
        name: field.name.trim(),
        type: field.type,
        group: group.name,
        visible: selected.has(field.id),
        resultType: field.options?.result?.type ?? null,
        linkedTable: linked ? schema.get(linked)?.name ?? null : null,
        value: linked ? mapLinks(value, linkNames) : value ?? null,
      };
    })
  );

  return {
    id: record.id,
    createdTime: record.createdTime,
    table: table.name,
    airtableUrl: `https://airtable.com/${BASE_ID}/${table.id}/${record.id}`,
    fields,
  };
}

// For link fields, and lookups whose values are links (possibly several hops away),
// work out which table the record ids belong to.
function linkedTableOf(schema, table, field, depth = 0) {
  if (!field || depth > 4) return null;
  if (field.type === "multipleRecordLinks") return field.options?.linkedTableId ?? null;
  if (field.type !== "multipleLookupValues" || field.options?.result?.type !== "multipleRecordLinks") {
    return null;
  }
  const viaField = table.fields.find((f) => f.id === field.options.recordLinkFieldId);
  const nextTable = schema.get(viaField?.options?.linkedTableId);
  const nextField = nextTable?.fields.find((f) => f.id === field.options.fieldIdInLinkedTable);
  return linkedTableOf(schema, nextTable, nextField, depth + 1);
}

function mapLinks(value, names) {
  if (!Array.isArray(value)) return value ?? null;
  return value.map((v) =>
    typeof v === "string" && names.has(v) ? { linkId: v, name: names.get(v) } : v
  );
}
