// Turns the graded spec table read out of a tech pack into one line per point of measure: the base size's
// measurement and how it changes from size to size. Whatever writes customer copy from these lines only has
// to pick, relabel and order them, never work a number out.

// Column headings that are sizes: 8, 10 … 20, XS … XL, S/M, M/L, L/XL and one-size.
const LETTER = "(?:X{0,3}S|M|X{0,3}L)";
const ONE_SIZE = /^(?:ONE\s*SIZE|O\/S|OS|OSFA)$/;
const SIZE = new RegExp(`^(?:\\d{1,2}|${LETTER}|${LETTER}\\s*/\\s*${LETTER}|ONE\\s*SIZE|O/S|OS|OSFA)$`);

// Measurements are compared to this many cm, so 0.6 + 0.6 + 0.6 reads as a steady 0.6 grade.
const TOLERANCE = 0.051;

const sizeOf = (heading) => heading.toUpperCase().replace(/^SIZE\s+/, "").replace(/\s+/g, " ").trim();
const round = (n) => Math.round(n * 100) / 100;
const cm = (n) => `${round(n)}cm`;

function number(cell) {
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:cm)?$/i.exec(String(cell ?? "").trim());
  return m ? Number(m[1]) : null;
}

// The Markdown tables in `markdown`, each with the "###" heading above it (if any) and its rows of cells.
function tables(markdown) {
  const out = [];
  let current = null;
  let heading = null;
  for (const line of markdown.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("|")) {
      current = null;
      const h = /^#{3,}\s+(.+)$/.exec(text);
      if (h) heading = h[1].trim();
      continue;
    }
    const cells = text.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!current) out.push((current = { heading, rows: [] }));
    current.rows.push(cells);
  }
  return out;
}

// "Size 8" for a numbered or lettered size; a combined size (S/M) reads better without the word.
const named = (size) => (size.includes("/") ? size : `Size ${size}`);

function line(label, sizes, values, printedGrade) {
  const present = sizes.map((size, i) => ({ size, value: values[i] })).filter((x) => x.value != null);
  if (present.length === 0) return null;
  if (sizes.length === 1 && ONE_SIZE.test(sizes[0])) return `${label}: ${cm(present[0].value)}`;

  const each = (sep, join) => present.map((x) => join(x)).join(sep);
  // Combined sizes are few and don't grade evenly, so each one is given.
  if (sizes.every((s) => s.includes("/"))) return `${label}: ${each(", ", (x) => `${cm(x.value)} for ${x.size}`)}`;

  const base = present.find((x) => x.size === "8") ?? present.find((x) => x.size === "S") ?? present[0];
  const steps = present.slice(1).map((x, i) => round(x.value - present[i].value));
  const steady = steps.every((s) => Math.abs(s - steps[0]) < TOLERANCE);
  // A size left blank in the middle of the run would make its neighbours look like a double step.
  const complete = present.length === sizes.length;
  const grade = steps.length === 0 ? printedGrade : steady && complete ? steps[0] : null;
  const agrees = printedGrade == null || grade == null || Math.abs(printedGrade - grade) < TOLERANCE;
  if (grade == null || !agrees) {
    const note = !agrees ? `the grade column says ${cm(printedGrade)}, the sizes don't follow it` : "the grade varies between sizes";
    return `${label}: ${each(", ", (x) => `${x.size} = ${cm(x.value)}`)} (${note})`;
  }
  const change = Math.abs(grade) < TOLERANCE ? "same in all sizes" : `${grade > 0 ? "+" : "-"}${cm(Math.abs(grade))} per size`;
  return `${label}: ${cm(base.value)} for ${named(base.size)}, ${change}`;
}

// Returns the lines as text, or null when `markdown` has no measurement table with size columns.
export function measurementLines(markdown) {
  const blocks = [];
  for (const table of tables(markdown ?? "")) {
    const [head, ...rows] = table.rows;
    const sizes = head.map(sizeOf);
    const sizeCols = sizes.flatMap((s, i) => (SIZE.test(s) ? [i] : []));
    if (sizeCols.length === 0) continue;
    const gradeCol = head.findIndex((h) => /grade/i.test(h));
    const titled = head.findIndex((h) => /point of measure|\bpom\b|measurement|description/i.test(h));
    const labelCol = titled >= 0 ? titled : head.findIndex((h, i) => !sizeCols.includes(i) && i !== gradeCol && !/^(ref|tol)/i.test(h));
    if (labelCol < 0) continue;

    const lines = rows.flatMap((cells) => {
      const label = cells[labelCol]?.trim();
      if (!label) return [];
      const text = line(label, sizeCols.map((i) => sizes[i]), sizeCols.map((i) => number(cells[i])), gradeCol >= 0 ? number(cells[gradeCol]) : null);
      return text ? [text] : [];
    });
    if (lines.length) blocks.push({ heading: table.heading, lines });
  }
  if (blocks.length === 0) return null;
  // Several tables (one per garment piece, say) keep their headings so the lines can be told apart.
  return blocks.map((b) => [...(blocks.length > 1 && b.heading ? [`${b.heading}:`] : []), ...b.lines].join("\n")).join("\n\n");
}
