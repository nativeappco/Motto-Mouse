import { checkCredentials, createSessionCookie, json } from "../lib/auth.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (!checkCredentials(username, password)) {
    console.log(`[login] failed attempt for "${username.slice(0, 50)}"`);
    // Small delay to slow down guessing.
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: "Incorrect username or password" }, 401);
  }

  console.log(`[login] success for "${username}"`);
  return json({ ok: true, username }, 200, { "Set-Cookie": createSessionCookie(req, username) });
};

export const config = { path: "/api/login" };
