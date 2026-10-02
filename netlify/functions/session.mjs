import { getSession, json } from "../lib/auth.mjs";

export default async (req) => {
  const session = getSession(req);
  if (!session) return json({ authenticated: false }, 401);
  return json({ authenticated: true, username: session.u });
};

export const config = { path: "/api/session" };
