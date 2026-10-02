import { getStore } from "@netlify/blobs";

function store() {
  return getStore({ name: "pdf-extract-jobs", consistency: "strong" });
}

export async function loadPdfExtractJob(jobId) {
  return (await store().get(jobId, { type: "json" })) ?? null;
}

export async function savePdfExtractJob(jobId, job) {
  await store().setJSON(jobId, job);
}