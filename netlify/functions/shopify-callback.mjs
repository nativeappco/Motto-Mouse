import { getSession } from "../lib/auth.mjs";
import { exchangeCode, readState, stateCookie, validCallback } from "../lib/shopify-auth.mjs";

// Shopify sends the user back here after they approve the app. Swaps the one-time code for an Admin API token.
export default async (req) => {
  const session = getSession(req);
  if (!session) return page(req, 401, "Not signed in", "Sign in to Motto Mouse, then connect Shopify again.");

  const params = new URL(req.url).searchParams;
  try {
    const state = readState(req);
    if (!state || state !== params.get("state")) {
      return page(req, 400, "Connection expired", "That connection attempt has expired. Start it again from Motto Mouse.");
    }
    if (!params.get("code") || !validCallback(params)) {
      return page(req, 400, "Connection failed", "The response didn't come from the expected Shopify store.");
    }

    const token = await exchangeCode(params.get("code"), session.u);
    console.log(`[shopify-callback] ${session.u} connected ${token.shop} scopes=${token.scope}`);
    return page(req, 200, "Shopify connected", `Motto Mouse can now reach ${token.shop}. Access granted: ${token.scope}.`);
  } catch (err) {
    console.error("[shopify-callback] error", err);
    return page(req, 502, "Connection failed", "Shopify didn't issue a token. Check the function logs for details.");
  }
};

function page(req, status, title, message) {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} – Motto Mouse</title>
<link rel="stylesheet" href="/styles.css">
<main style="max-width: 32rem; margin: 4rem auto; padding: 0 1rem">
  <h1>${escape(title)}</h1>
  <p>${escape(message)}</p>
  <p><a href="/">Back to Motto Mouse</a></p>
</main>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": stateCookie(req, ""),
    },
  });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const config = { path: "/api/shopify/callback" };
