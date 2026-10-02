// Shopify Admin GraphQL client.
// Auth: either a static Admin API token (SHOPIFY_ADMIN_TOKEN), or the token saved when the app was
// connected to the store through /api/shopify/connect (see shopify-auth.mjs).
import { ShopifyNotConfigured, accessToken, shopDomain } from "./shopify-auth.mjs";

export { ShopifyNotConfigured };

export const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

export async function graphql(query, variables = {}, attempt = 0, retriedAuth = false) {
  const res = await fetch(`https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await accessToken({ force: retriedAuth }),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    // The token was revoked or ran out early: fetch a current one and try once more before giving up.
    if (!retriedAuth) return graphql(query, variables, attempt, true);
    throw new ShopifyNotConfigured("Shopify rejected the saved token, so the app needs to be connected again");
  }
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();

  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return graphql(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  }
  return body.data;
}

// ---------- Metafield definitions ----------
export const OWNER_TYPES = { product: "PRODUCT", variant: "PRODUCTVARIANT" };

const DEFINITIONS_QUERY = `
  query Definitions($ownerType: MetafieldOwnerType!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $after, sortKey: NAME) {
      nodes {
        id
        name
        namespace
        key
        description
        type { name category }
        validations { name value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

async function fetchDefinitions(ownerType) {
  const out = [];
  let after = null;
  do {
    const data = await graphql(DEFINITIONS_QUERY, { ownerType, after });
    const page = data.metafieldDefinitions;
    out.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out.map((d) => ({
    id: d.id,
    name: d.name,
    namespace: d.namespace,
    key: d.key,
    description: d.description || null,
    type: d.type.name,
    category: d.type.category,
    // "choices" validation holds the allowed values for a text metafield with a preset list.
    choices: parseChoices(d.validations),
  }));
}

function parseChoices(validations) {
  const v = validations?.find((x) => x.name === "choices");
  if (!v) return null;
  try {
    return JSON.parse(v.value);
  } catch {
    return null;
  }
}

// Definitions rarely change; cache per warm function instance.
let definitionsCache = null;
let definitionsFetchedAt = 0;
export async function getMetafieldDefinitions(force = false) {
  if (!force && definitionsCache && Date.now() - definitionsFetchedAt < 10 * 60 * 1000) return definitionsCache;
  const [product, variant] = await Promise.all([
    fetchDefinitions(OWNER_TYPES.product),
    fetchDefinitions(OWNER_TYPES.variant),
  ]);
  definitionsCache = { product, variant, fetchedAt: new Date().toISOString() };
  definitionsFetchedAt = Date.now();
  return definitionsCache;
}
