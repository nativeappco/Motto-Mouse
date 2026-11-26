import { randomUUID } from "node:crypto";
import { getSession, json } from "../lib/auth.mjs";
import { DRY_RUN_ONLY } from "../lib/box-sync.mjs";
import { JOBS, listJobs, loadJob, loadMigration, newReport, reportCsv, saveJob, saveMigration, startRun } from "../lib/backfill.mjs";

// Starts and reports on catalogue-wide jobs (lib/backfill.mjs); the work itself is done by backfill-background.mjs.
//   GET  /api/backfill                    – recent jobs
//   GET  /api/backfill?id=…               – one job: counts, result and the first lines of its report
//   GET  /api/backfill?id=…&format=csv    – the whole report as CSV
//   POST /api/backfill                    – { type: "audit" | "group" | "subcategory-migrate", dryRun, options }
//                                           Writing jobs are dry runs unless dryRun is false.
//   POST /api/backfill                    – { stop: id } ends a job after its current page;
//                                           { resume: id } carries on a stopped, failed or stuck job from where it got to
//   GET/PUT /api/backfill/migration       – the old -> new subcategory table: { table: { "old value": ["New"] } }

const METAFIELD = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;

export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);
  const url = new URL(req.url);

  try {
    if (url.pathname.endsWith("/migration")) return migration(req, session);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ jobs: await listJobs() });
      const job = isJobId(id) && (await loadJob(id));
      if (!job) return json({ error: "Job not found" }, 404);
      if (url.searchParams.get("format") === "csv") {
        return new Response(reportCsv(job.report), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="mouse-${job.type}-${job.dryRun ? "dry-run-" : ""}${job.createdAt.slice(0, 10)}.csv"`,
          },
        });
      }
      const { state, report, ...rest } = job;
      return json({ ...rest, counts: report.counts, truncated: report.truncated, lines: report.lines.slice(0, 200) });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) ?? {};
    if (body.stop || body.resume) return control(req, session, body);
    if (!JOBS.includes(body.type)) return json({ error: `type must be one of ${JOBS.join(", ")}` }, 400);

    const options = {};
    if (body.type === "group") {
      options.rules = body.options?.rules === true;
      const targets = [].concat(body.options?.targets ?? []);
      if (targets.length > 50 || !targets.every((t) => typeof t === "string" && /^(product|variant):/.test(t))) {
        return json({ error: "options.targets must be a list of Shopify fields from Mapping" }, 400);
      }
      options.targets = targets;
    }
    if (body.type === "subcategory-migrate") {
      const from = [].concat(body.options?.from ?? []);
      const to = body.options?.to ?? "";
      if (from.length === 0 || from.length > 5 || !from.every((f) => METAFIELD.test(f)) || !METAFIELD.test(to) || from.includes(to)) {
        return json({ error: "options.from must be 1 to 5 metafields and options.to another one, each as namespace.key" }, 400);
      }
      Object.assign(options, { from, to, split: body.options?.split === true });
    }

    const busy = await runningJob();
    if (busy) return json({ error: `The ${busy.type} job started at ${busy.createdAt} is still running` }, 409);

    const job = {
      id: randomUUID(),
      type: body.type,
      // The audit only reads; the others write only when asked to, and never where SHOPIFY_DRY_RUN is set.
      dryRun: body.type === "audit" || DRY_RUN_ONLY || body.dryRun !== false,
      options,
      owner: session.u,
      status: "queued",
      run: 1,
      createdAt: new Date().toISOString(),
      state: {},
      report: newReport(),
    };
    await saveJob(job);
    await startRun(req, job);
    console.log(`[backfill] ${session.u} started ${job.type} ${job.id}${job.dryRun ? " (dry run)" : ""}`);
    return json({ id: job.id, type: job.type, dryRun: job.dryRun, status: job.status }, 202);
  } catch (err) {
    console.error("[backfill] error", err);
    return json({ error: "Backfill request failed. Check the function logs for details." }, 502);
  }
};

// One at a time: two jobs writing the same products would trip over each other.
// A job not heard from in 20 minutes has stopped without saying so (its function was cut off).
const STALE_MS = 20 * 60 * 1000;
const isLive = (j) => (j.status === "queued" || j.status === "running") && Date.now() - Date.parse(j.updatedAt) < STALE_MS;
const runningJob = async () => (await listJobs()).find(isLive) ?? null;

async function control(req, session, body) {
  const id = body.stop ?? body.resume;
  const job = isJobId(id) && (await loadJob(id));
  if (!job) return json({ error: "Job not found" }, 404);

  if (body.stop) {
    if (!["queued", "running"].includes(job.status)) return json({ error: `The job is already ${job.status}` }, 409);
    job.status = "stopped";
    job.stoppedBy = session.u;
    await saveJob(job);
    console.log(`[backfill] ${session.u} stopped ${job.type} ${job.id}`);
    return json({ id: job.id, status: job.status });
  }

  if (job.status === "done") return json({ error: "The job has finished" }, 409);
  if (isLive(job)) return json({ error: "The job is still running" }, 409);
  const busy = await runningJob();
  if (busy) return json({ error: `The ${busy.type} job started at ${busy.createdAt} is still running` }, 409);
  // A new run number turns away the slice that was cut off, should it ever wake up.
  job.run += 1;
  job.status = "queued";
  job.error = null;
  await saveJob(job);
  await startRun(req, job);
  console.log(`[backfill] ${session.u} resumed ${job.type} ${job.id}`);
  return json({ id: job.id, status: job.status }, 202);
}

async function migration(req, session) {
  if (req.method === "GET") return json(await loadMigration());
  if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  const table = (await req.json().catch(() => null))?.table;
  const valid =
    table &&
    typeof table === "object" &&
    !Array.isArray(table) &&
    Object.keys(table).length <= 2000 &&
    Object.entries(table).every(([from, to]) => from.trim() && [].concat(to ?? []).every((v) => typeof v === "string" && v.trim()));
  if (!valid) return json({ error: 'table must map each old value to a new value or a list of them, e.g. { "elastic waist": ["Pants"] }' }, 400);
  const clean = Object.fromEntries(Object.entries(table).map(([from, to]) => [from.trim(), [].concat(to ?? []).map((v) => v.trim())]));
  const saved = await saveMigration(clean, session.u);
  return json(saved ?? { table: clean });
}

function isJobId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}

export const config = { path: ["/api/backfill", "/api/backfill/migration"] };
