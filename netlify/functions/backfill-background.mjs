import { getSession } from "../lib/auth.mjs";
import { loadJob, runJob, saveJob, startRun } from "../lib/backfill.mjs";

// Works on a backfill job (lib/backfill.mjs) for up to 12 of the 15 minutes a background function gets, then
// saves where it got to and starts itself again until the job is finished.
const SLICE_MS = 12 * 60 * 1000;

export default async (req) => {
  const session = getSession(req);
  if (!session || req.method !== "POST") return;
  const { id, run } = await req.json().catch(() => ({}));
  const job = typeof id === "string" && (await loadJob(id));
  // `run` stops a second invocation of the same slice from working on the job alongside the first.
  if (!job || job.run !== run || !["queued", "running"].includes(job.status)) return;

  job.status = "running";
  job.startedAt ??= new Date().toISOString();
  await saveJob(job);

  try {
    const finished = await runJob(job, Date.now() + SLICE_MS);
    if (!finished) {
      const latest = await loadJob(job.id);
      // Resume started a newer run while this one was finishing a page; that one carries on.
      if (!latest || latest.run !== job.run) return;
      // Stop was pressed while this slice ran: keep what was done, and don't start another slice.
      if (latest.status === "stopped") {
        job.status = "stopped";
        job.stoppedBy = latest.stoppedBy;
        await saveJob(job);
        console.log(`[backfill] ${job.type} ${job.id} stopped by request`);
        return;
      }
    }
    if (finished) {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      // What a job needed to carry on is no use once it's finished, and can be large.
      job.state = {};
      await saveJob(job);
      console.log(`[backfill] ${job.type} ${job.id} done: ${JSON.stringify(job.report.counts)}`);
      return;
    }
    job.run += 1;
    await saveJob(job);
    console.log(`[backfill] ${job.type} ${job.id} continuing (slice ${job.run})`);
    await startRun(req, job);
  } catch (err) {
    console.error(`[backfill] ${job.type} ${job.id} failed`, err);
    if ((await loadJob(job.id).catch(() => null))?.run !== job.run) return;
    job.status = "failed";
    job.error = err.message;
    await saveJob(job);
  }
};

export const config = { path: "/api/backfill/run", background: true };
