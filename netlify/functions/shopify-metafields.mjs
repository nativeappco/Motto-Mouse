import { getSession, json } from "../lib/auth.mjs";
import { getMetafieldDefinitions, ShopifyNotConfigured } from "../lib/shopify.mjs";

// Lists the product and variant metafield definitions set up in Shopify admin.
export default async (req) => {
  if (!getSession(req)) return json({ error: "Not signed in" }, 401);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const refresh = new URL(req.url).searchParams.has("refresh");
    const definitions = await getMetafieldDefinitions(refresh);
    console.log(
      `[shopify-metafields] product=${definitions.product.length} variant=${definitions.variant.length}${refresh ? " (refreshed)" : ""}`
    );
    return json(definitions);
  } catch (err) {
    if (err instanceof ShopifyNotConfigured) return json({ error: err.message, notConfigured: true }, 503);
    console.error("[shopify-metafields] error", err);
    return json({ error: "Could not load metafield definitions from Shopify. Check the function logs for details." }, 502);
  }
};

export const config = { path: "/api/shopify/metafields" };
