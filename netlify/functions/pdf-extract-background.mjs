import { getSession } from "../lib/auth.mjs";
import { BOX_TABLE_ID, getRecord } from "../lib/airtable.mjs";
import { askAboutPdf, GeminiNotConfigured, GeminiQuotaExceeded, MODEL } from "../lib/gemini.mjs";
import { EXTRACTS, MAX_PDF_BYTES, promptHash, stripFences } from "../lib/pdf-extract.mjs";
import { loadPdfExtractJob, savePdfExtractJob } from "../lib/pdf-extract-jobs.mjs";
import { loadExtractPrompt, saveExtractResult } from "../lib/pdf-extract-store.mjs";

export default async (req) => {
  const session = getSession(req);
  if (!session || req.method !== "POST") return;

  const { jobId } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId ?? "")) return;

  const job = await loadPdfExtractJob(jobId);
  if (!job || job.owner !== session.u || job.status === "done") return;

  const started = Date.now();
  const logTiming = (stage) => console.log(`[pdf-extract] ${stage} ${Date.now() - started}ms`);
  await savePdfExtractJob(jobId, { ...job, status: "processing", startedAt: new Date().toISOString() });

  try {
    const spec = EXTRACTS[job.extract];
    if (!spec) throw new Error("Unknown extract type");

    logTiming("airtable lookup started");
    const record = await getRecord(BOX_TABLE_ID, job.recordId);
    logTiming("airtable lookup completed");
    const attachment = [].concat(record.fields[job.fieldId] ?? []).find((item) => item?.id === job.attachmentId);
    if (!attachment) throw new Error("Attachment not found on this record");
    if (attachment.type !== "application/pdf") throw new Error("Attachment is not a PDF");
    if (attachment.size > MAX_PDF_BYTES) throw new Error("PDF is too large to process");

    logTiming("attachment download started");
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Downloading attachment failed (${response.status})`);
    const pdf = await response.arrayBuffer();
    logTiming(`attachment download completed bytes=${pdf.byteLength}`);

    // The prompt is the one saved in Settings, read now so an edit applies to jobs already queued.
    const { prompt } = await loadExtractPrompt(job.extract);
    logTiming(`gemini request started model=${MODEL}`);
    const { text, usage, model } = await askAboutPdf(pdf, prompt);
    logTiming(`gemini request completed model=${model} tokens=${usage?.totalTokenCount ?? "?"}`);
    const result = {
      extract: job.extract,
      label: spec.label,
      filename: attachment.filename,
      model,
      markdown: stripFences(text),
    };
    // Kept per PDF so a Shopify sync can use it without reading the PDF again.
    await saveExtractResult(job.extract, attachment.id, { ...result, promptHash: promptHash(prompt) });
    await savePdfExtractJob(jobId, { ...job, status: "done", result, completedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[pdf-extract] error after ${Date.now() - started}ms`, err);
    const knownError = [
      "Unknown extract type",
      "Attachment not found on this record",
      "Attachment is not a PDF",
      "PDF is too large to process",
    ].includes(err.message);
    await savePdfExtractJob(jobId, {
      ...job,
      status: "error",
      error: err instanceof GeminiNotConfigured || err instanceof GeminiQuotaExceeded || knownError
        ? err.message
        : "Could not extract content from the PDF. Check the function logs for details.",
      completedAt: new Date().toISOString(),
    });
  }
};

export const config = { path: "/api/pdf/extract/run", background: true };