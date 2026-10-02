import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

// Shopify OAuth (authorization code grant) and storage of the Admin API token it returns.
// The app lives in our own Dev Dashboard organisation rather than the store's, so Shopify refuses the
// client credentials grant ("shop_not_permitted") and the app has to be approved once in the browser.

// Shopify grants whatever scopes are set on the app version in the Dev Dashboard, regardless of what's
// asked for here, so change them there (then reconnect) and keep this list in step.
const SCOPES = "write_products,write_product_listings,write_product_feeds";

// Shopify keeps only one expiring token per app and store, so connecting from a second environment
// (e.g. localhost) would disconnect the live site. Non-expiring tokens don't have that problem and are
// still allowed for custom apps. Set to true for 1-hour tokens, which are then refreshed automatically.
const EXPIRING_TOKENS = false;

const STORE = "shopify-auth";
const KEY = "token";
const STATE_COOKIE = "mm_shopify_state";

export class ShopifyNotConfigured extends Error {}

export function shopDomain() {
  const raw = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_DOMAIN || "";
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d) throw new ShopifyNotConfigured("SHOPIFY_STORE_DOMAIN is not configured");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) {
    throw new ShopifyNotConfigured("SHOPIFY_STORE_DOMAIN must look like your-store.myshopify.com");
  }
  return d;
}

function credentials() {
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) throw new ShopifyNotConfigured("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are not configured");
  return { id, secret };
}

function store() {
  return getStore({ name: STORE, consistency: "strong" });
}

// ---------- Authorisation ----------
export function authorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({ client_id: credentials().id, scope: SCOPES, redirect_uri: redirectUri, state });
  return `https://${shopDomain()}/admin/oauth/authorize?${params}`;
}

// The state value is kept in a short-lived cookie and must come back unchanged from Shopify.
export function stateCookie(req, value) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/api/shopify; HttpOnly; SameSite=Lax; Max-Age=${value ? 600 : 0}${secure}`;
}

export function readState(req) {
  const header = req.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return match ? match.slice(STATE_COOKIE.length + 1) : null;
}

// Checks that the callback really came from Shopify (signed with our client secret) and is for our store.
export function validCallback(params) {
  const message = [...params]
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const expected = Buffer.from(createHmac("sha256", credentials().secret).update(message).digest("hex"));
  const given = Buffer.from(params.get("hmac") || "");
  return given.length === expected.length && timingSafeEqual(given, expected) && params.get("shop") === shopDomain();
}

async function tokenRequest(body) {
  const { id, secret } = credentials();
  return fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }),
  });
}

function toRecord(data, extra) {
  const now = Date.now();
  return {
    shop: shopDomain(),
    accessToken: data.access_token,
    scope: data.scope,
    // The expiry and refresh fields are only present for expiring tokens.
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshToken: data.refresh_token ?? null,
    refreshTokenExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
    ...extra,
  };
}

export async function exchangeCode(code, username) {
  const res = await tokenRequest({ code, expiring: EXPIRING_TOKENS ? "1" : "0" });
  if (!res.ok) throw new Error(`Shopify token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const token = toRecord(await res.json(), { connectedAt: new Date().toISOString(), connectedBy: username });
  await store().setJSON(KEY, token);
  cache = token;
  return token;
}

// ---------- Access token ----------
// Cached per warm function instance; expiring tokens are renewed a little early.
let cache = null;
const fresh = (t) => !t.expiresAt || t.expiresAt > Date.now() + 5 * 60 * 1000;

// `force` skips the cache and renews an expiring token, for when Shopify has just rejected the one we had.
export async function accessToken({ force = false } = {}) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (!force && cache && fresh(cache)) return cache.accessToken;

  let token = await store().get(KEY, { type: "json" });
  if (!token || token.shop !== shopDomain()) {
    throw new ShopifyNotConfigured("the app hasn't been authorised for this store yet");
  }
  if (token.refreshToken && (force || !fresh(token))) token = await refresh(token);
  cache = token;
  return token.accessToken;
}

async function refresh(token) {
  const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken });
  if (!res.ok) {
    // Another function instance may have refreshed first, which retires the refresh token we were holding.
    const latest = await store().get(KEY, { type: "json" });
    if (latest && latest.refreshToken !== token.refreshToken && fresh(latest)) return latest;
    if (res.status === 429 || res.status >= 500) throw new Error(`Shopify token refresh ${res.status}`);
    throw new ShopifyNotConfigured("the saved authorisation has expired, so the app needs to be connected again");
  }
  const next = toRecord(await res.json(), { connectedAt: token.connectedAt, connectedBy: token.connectedBy });
  await store().setJSON(KEY, next);
  return next;
}
