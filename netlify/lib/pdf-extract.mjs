export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export const EXTRACTS = {
  "tech-pack": {
    label: "Tech pack",
    prompt: `This PDF is a garment tech pack. Extract its measurements, its sewing / construction instructions, and its bill of materials.

Output GitHub-flavoured Markdown, and nothing else (no code fences, no commentary), with exactly these three "##" sections in this order:

## Measurements
From the page titled "SPEC SHEET" (the graded measurement spec) or any other measurement / POM table:
1. A table with the columns "Field" and "Value" holding the header details (Style number, Style name, Purchase order no., Supplier, Season, and any other labelled header fields that are present).
2. The measurement table, with one column per REF, POINT OF MEASURE, each size, GRADE and TOLERANCE (whichever are present). Keep the column headings exactly as shown, and include any section rows (e.g. "Approximate finished garment measurements") as a row with only the point of measure filled.
3. Any notes or footer text on the page, as plain paragraphs.
If there are several measurement tables (e.g. per garment piece or per stage), give each one a "###" heading with its title.

## Construction
Every sewing instruction and construction method in the document: seam types, stitch types and SPI, seam allowances, finishes (overlock, bind, hem, topstitch), interfacing, pressing, labels and label placement, and any callouts written on the technical sketches. Group them under "###" headings by garment area or by the heading used in the PDF (e.g. "Neckline", "Sleeves", "Hem", "General"), as bullet points. Where an instruction is a callout pointing at a sketch, say which view it belongs to (front, back, detail) if that is clear.

## Bill of materials
Every fabric, lining, interfacing, trim, thread, button, zip, label, tag and packaging item. Output a table using the column headings exactly as printed in the PDF's BOM / trims / fabric list (e.g. Item, Description, Composition, Colour, Supplier, Ref, Size, Placement, Quantity, Consumption). If materials are only listed in text or callouts rather than a table, build a table with the columns "Item", "Description", "Placement" and "Quantity".

Rules for every section:
- Copy every value and instruction exactly as printed, including decimals, units and codes. Do not summarise, paraphrase, translate or invent anything.
- Do not add bold or other formatting inside table cells. Leave blank cells empty and omit fully empty rows.
- If the PDF has none of a section's content, keep the heading and put underneath it only: _Not found in this PDF._`,
  },
};

export function stripFences(text) {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return match ? match[1].trim() : text;
}
