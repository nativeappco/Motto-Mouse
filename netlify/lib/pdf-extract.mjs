import { createHash } from "node:crypto";
import { measurementLines } from "./measurements.mjs";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

// `field` is the Airtable field whose PDF is read when the extract is mapped to Shopify.
// `prompt` is the default; the one in use can be edited in Settings (see pdf-extract-store.mjs).
// `sections` are the "##" headings the prompt asks for. Each can be mapped to Shopify by itself, so a
// metafield holds only the part it's for; `format` reworks a section's text before it's sent.
export const EXTRACTS = {
  "tech-pack": {
    label: "Tech pack",
    field: "PDF BULK TECH PACK",
    sections: [
      { id: "design", heading: "Design" },
      { id: "construction", heading: "Construction" },
      { id: "bom", heading: "Bill of materials", label: "BOM" },
      { id: "care", heading: "Care label" },
      { id: "measurements", heading: "Measurements", format: measurementLines },
    ],
    prompt: `This PDF is a garment tech pack. Extract five things from it: its design details, the construction a customer would notice, its bill of materials, its care label and its graded measurements. Ignore everything else in the document.

Output GitHub-flavoured Markdown, and nothing else (no code fences, no commentary), with exactly these five "##" sections in this order:

## Design
1. A table with the columns "Field" and "Value" holding the header details (Style number, Style name, Purchase order no., Supplier, Season, and any other labelled header fields that are present).
2. Under a "### Sketches" heading, bullet points describing what the cover, styling and technical sketch pages show of the finished garment: overall shape and length, neckline or collar, sleeves and shoulders, waist, closures, pockets, and visible trims or decorative details. Describe only what is drawn or labelled, say which view a detail is on (front, back, detail) when that is clear, and leave out anything that can't be seen.

## Construction
Only the construction a customer would notice, or that affects how the garment fits or adjusts: pockets, closures (zips, buttons, ties), waist construction (elastic, drawcords, shirring), adjustable or removable parts, lining, pleats, tucks, gathers, splits, hems, visible topstitching and other design details. Use bullet points, grouped under "###" headings by garment area or by the heading used in the PDF (e.g. "Neckline", "Sleeves", "Hem", "General").
Leave out production-only instructions: seam allowances, SPI, fusing and interfacing, the order of sewing, quality, testing and compulsory construction requirements, label placement, branding, and packing or carton instructions.

## Bill of materials
The fabrics, linings and trims that end up visible on the garment: buttons, zips, eyelets, buckles, elastic, tapes and decorative components. Output a table using the column headings exactly as printed in the PDF's BOM / trims / fabric list (e.g. Item, Description, Colour, Supplier, Ref, Size, Placement, Quantity). If materials are only listed in text or callouts rather than a table, build a table with the columns "Item", "Description", "Placement" and "Quantity".
Leave out fusing, sewing thread, labels, swing tags and packaging.

## Care label
The washing and care wording to be printed on the care label, copied as written, one instruction per line. Leave out the brand name, web address, country of origin and fibre content.

## Measurements
From the page titled "SPEC SHEET" (the graded measurement spec) or any other measurement / POM table: the measurement table, with one column per REF, POINT OF MEASURE, each size, GRADE and TOLERANCE (whichever are present). Keep the column headings exactly as shown, and include any section rows (e.g. "Approximate finished garment measurements") as a row with only the point of measure filled. Put any notes or footer text on the page underneath, as plain paragraphs.
If there are several measurement tables (e.g. per garment piece or per stage), give each one a "###" heading with its title.

Rules for every section:
- Copy every value and instruction exactly as printed, including decimals, units and codes. Do not summarise, paraphrase, translate or invent anything. The one exception is "### Sketches", which describes the drawings in plain words.
- Do not give fibre composition percentages anywhere.
- Do not add bold or other formatting inside table cells. Leave blank cells empty and omit fully empty rows.
- If the PDF has none of a section's content, keep the heading and put underneath it only: _Not found in this PDF._`,
  },
};

export function stripFences(text) {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1].trim() : text;
}

// ---------- Extracts as mapping sources ----------
// An extract can be mapped to Shopify like an Airtable field. Its mapping source id is "extract:<name>" for
// the whole text, or "extract:<name>#<section>" for one section of it.
const SOURCE_PREFIX = "extract:";

// The extracts this table can feed into Shopify: those whose PDF field exists in it.
// `label` names the extract (one PDF read, whatever is mapped from it); `name` names the source.
export function extractSources(table) {
  return Object.entries(EXTRACTS).flatMap(([extract, spec]) => {
    const field = table.fields.find((f) => f.name.trim() === spec.field);
    if (!field) return [];
    const source = { extract, label: spec.label, fieldId: field.id, fieldName: spec.field };
    return [
      { id: `${SOURCE_PREFIX}${extract}`, ...source, name: `${spec.label} text` },
      ...(spec.sections ?? []).map((s) => ({ id: `${SOURCE_PREFIX}${extract}#${s.id}`, ...source, name: `${spec.label}: ${s.label ?? s.heading}`, section: s.id })),
    ];
  });
}

// The text under a "## <heading>" line, up to the next "##" heading. Null if there's no such heading.
export function sectionText(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n").trim();
}

// What a source sends to Shopify out of an extract's text: { value } or { value: null, reason }.
export function sourceText(source, markdown) {
  if (!source.section) return { value: markdown };
  const section = EXTRACTS[source.extract].sections.find((s) => s.id === source.section);
  const body = sectionText(markdown, section.heading);
  const what = (section.label ?? section.heading).toLowerCase();
  if (body == null) {
    return { value: null, reason: `The ${source.label.toLowerCase()} text has no “${section.heading}” section. Reset its prompt in Settings to get one` };
  }
  if (!body || /^_?not found in this pdf\.?_?$/i.test(body)) return { value: null, reason: `The ${source.label.toLowerCase()} has no ${what}` };
  // When there's nothing to rework (no table, say), the text goes as it was read rather than being lost.
  return { value: section.format?.(body) ?? body };
}

// The first PDF in an attachment field's value, which is the one an extract reads.
export function firstPdf(value) {
  return [].concat(value ?? []).find((a) => a?.id && a.type === "application/pdf") ?? null;
}

// Identifies the prompt an extraction was made with, so a result is redone once the prompt is edited.
export function promptHash(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}
