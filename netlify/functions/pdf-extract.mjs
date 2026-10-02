import { randomUUID } from "node:crypto";
import { getSession, json } from "../lib/auth.mjs";
import { EXTRACTS } from "../lib/pdf-extract.mjs";
import { loadPdfExtractJob, savePdfExtractJob } from "../lib/pdf-extract-jobs.mjs";

export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  if (req.method === "GET") {
    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!isJobId(jobId)) return json({ error: "Invalid job id" }, 400);
    try {
      const job = await loadPdfExtractJob(jobId);
      if (!job || job.owner !== session.u) return json({ error: "Extraction job not found" }, 404);
      return json({ status: job.status, result: job.result, error: job.error });
    } catch (err) {
      console.error("[pdf-extract] status error", err);
      return json({ error: "Could not load extraction status" }, 502);
    }
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const { recordId, fieldId, attachmentId, extract = "tech-pack" } = body;
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId ?? "")) return json({ error: "Invalid record id" }, 400);
  if (!/^fld[A-Za-z0-9]{14}$/.test(fieldId ?? "")) return json({ error: "Invalid field id" }, 400);
  if (!/^att[A-Za-z0-9]{14}$/.test(attachmentId ?? "")) return json({ error: "Invalid attachment id" }, 400);
  if (typeof extract !== "string" || !Object.hasOwn(EXTRACTS, extract)) return json({ error: "Unknown extract type" }, 400);

  try {
    const jobId = randomUUID();
    await savePdfExtractJob(jobId, {
      owner: session.u,
      status: "queued",
      recordId,
      fieldId,
      attachmentId,
      extract,
      createdAt: new Date().toISOString(),
    });
    return json({ jobId, status: "queued" }, 202);
  } catch (err) {
    console.error("[pdf-extract] could not queue job", err);
    return json({ error: "Could not start PDF extraction" }, 502);
  }
};

function isJobId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}

export const config = { path: "/api/pdf/extract" };
