import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "mm_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is missing or too short");
  return s;
}

// Hash both sides first so the comparison is constant-time regardless of length.
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function checkCredentials(username, password) {
  const u = process.env.APP_USERNAME;
  const p = process.env.APP_PASSWORD;
  if (!u || !p) throw new Error("APP_USERNAME / APP_PASSWORD are not configured");
  // Evaluate both so timing doesn't reveal which one was wrong.
  const userOk = safeEqual(username ?? "", u);
  const passOk = safeEqual(password ?? "", p);
  return userOk && passOk;
}

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionCookie(req, username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS })
  ).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  return cookie(req, token, MAX_AGE_SECONDS);
}

export function clearSessionCookie(req) {
  return cookie(req, "", 0);
}

function cookie(req, value, maxAge) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function getSession(req) {
  const header = req.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const [payload, sig] = match.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
