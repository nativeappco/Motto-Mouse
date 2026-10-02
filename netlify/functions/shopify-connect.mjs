import { randomBytes } from "node:crypto";
import { getSession, json } from "../lib/auth.mjs";
import { ShopifyNotConfigured, authorizeUrl, stateCookie } from "../lib/shopify-auth.mjs";

// Starts the one-time Shopify authorisation by sending the signed-in user to Shopify's approval screen.
export default async (req) => {
  if (!getSession(req)) return json({ error: "Not signed in" }, 401);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const state = randomBytes(16).toString("hex");
    const redirectUri = new URL("/api/shopify/callback", req.url).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl(redirectUri, state),
        "Set-Cookie": stateCookie(req, state),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ShopifyNotConfigured) return json({ error: err.message, notConfigured: true }, 503);
    console.error("[shopify-connect] error", err);
    return json({ error: "Could not start the Shopify connection. Check the function logs for details." }, 500);
  }
};

export const config = { path: "/api/shopify/connect" };
