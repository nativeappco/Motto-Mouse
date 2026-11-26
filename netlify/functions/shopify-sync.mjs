import { getStore } from "@netlify/blobs";
import { getSession, json } from "../lib/auth.mjs";
import { DRY_RUN_ONLY, boxTable, loadRecord, preview } from "../lib/box-sync.mjs";
import { ShopifyNotConfigured } from "../lib/shopify.mjs";
import { boxKeys, clearLink, findCandidates, saveLink } from "../lib/shopify-match.mjs";
import { applyChanges } from "../lib/shopify-products.mjs";

// Pushes an Airtable box's mapped fields to its Shopify product.
// GET previews (matches the box to a product and lists what would change), PUT remembers which product a
// box belongs to, POST applies the previewed changes. Only POST writes to Shopify, and not when it's a
// dry run: that goes through every step and returns the exact requests, but doesn't send them.

export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ error: "Not signed in" }, 401);

  try {
    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const recordId = params.get("id");
      if (!isRecordId(recordId)) return json({ error: "Invalid record id" }, 400);
      return json(await preview(recordId, { choose: params.has("choose") }));
    }

    const body = await req.json().catch(() => null);
    const recordId = body?.recordId;
    const productId = body?.productId ?? null;
    if (!isRecordId(recordId)) return json({ error: "Invalid record id" }, 400);
    if (productId !== null && !isProductId(productId)) return json({ error: "Invalid product id" }, 400);

    if (req.method === "PUT") {
      if (productId === null) {
        await clearLink(recordId);
      } else {
        // Only products this box could plausibly belong to can be linked.
        const { candidates } = await findCandidates(boxKeys((await loadRecord(await boxTable(), recordId, [])).record));
        if (!candidates.some((c) => c.id === productId)) return json({ error: "That product isn't a match for this box" }, 400);
        await saveLink(recordId, productId, session.u);
      }
      console.log(`[shopify-sync] ${session.u} linked ${recordId} -> ${productId}`);
      return json(await preview(recordId));
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    // Recompute everything rather than trusting the browser, and refuse if it's no longer what the user saw.
    const state = await preview(recordId, { withChanges: true });
    if (state.match.product?.id !== productId || state.preview?.fingerprint !== body?.fingerprint) {
      return json({ error: "Shopify or Airtable changed since this preview was made. Check the refreshed preview and try again." }, 409);
    }
    if (state.preview.changes.length === 0) return json({ error: "There is nothing to update" }, 400);

    const dryRun = DRY_RUN_ONLY || body?.dryRun === true;
    const { results, requests } = await applyChanges(productId, state.preview.changes, { dryRun });
    const changes = state.preview.changes.map((c) => ({
      target: c.target,
      ownerId: c.ownerId,
      before: c.before,
      after: c.after,
      error: results.get(c) ?? null,
    }));
    const failed = changes.filter((c) => c.error);
    const saved = changes.length - failed.length;
    if (dryRun) {
      console.log(`[shopify-sync] ${session.u} dry run for ${productId} from ${recordId}: ${saved} values in ${requests.length} requests, nothing sent`);
      const { changes: _, ...rest } = state.preview;
      return json({ ...state, preview: rest, result: { dryRun: true, saved, failed: 0, errors: {}, requests } });
    }

    await store().setJSON(`${new Date().toISOString()}_${recordId}`, {
      by: session.u,
      recordId,
      box: state.box,
      productId,
      productTitle: state.match.product.title,
      changes,
    });
    console.log(`[shopify-sync] ${session.u} updated ${productId} from ${recordId}: ${saved} saved, ${failed.length} failed`);

    // Per Shopify field: the error if any of its changes failed.
    const errors = Object.fromEntries(failed.map((c) => [c.target, c.error]));
    return json({ ...(await preview(recordId)), result: { dryRun: false, saved, failed: failed.length, errors } });
  } catch (err) {
    if (err instanceof ShopifyNotConfigured) {
      // A GET still succeeds so the page can show how to connect.
      return req.method === "GET" ? json({ connected: false, error: err.message }) : json({ error: err.message, notConfigured: true }, 503);
    }
    console.error("[shopify-sync] error", err);
    if (/^Airtable 429/.test(err.message)) {
      return json({ error: "Airtable is limiting requests. Wait 30 seconds and try again." }, 503);
    }
    return json({ error: "Shopify sync failed. Check the function logs for details." }, 502);
  }
};

function store() {
  return getStore({ name: "sync-log", consistency: "strong" });
}

function isRecordId(v) {
  return /^rec[A-Za-z0-9]{14}$/.test(v ?? "");
}

function isProductId(v) {
  return /^gid:\/\/shopify\/Product\/\d+$/.test(v ?? "");
}

export const config = { path: "/api/shopify/sync" };
