import { graphql } from "./shopify.mjs";
import { shopDomain } from "./shopify-auth.mjs";
import { PRODUCT_FIELDS, VARIANT_FIELDS } from "./shopify-fields.mjs";

// ---------- Finding products ----------
const SUMMARY = `
  id title handle status vendor
  featuredMedia { preview { image { url } } }
  options { name optionValues { name } }
  variants(first: 3) { nodes { sku } }`;

function summarise(p) {
  const colour = p.options.find((o) => /colou?r/i.test(o.name));
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    colours: colour ? colour.optionValues.map((v) => v.name) : [],
    sku: p.variants.nodes.find((v) => v.sku)?.sku ?? null,
    adminUrl: `https://admin.shopify.com/store/${shopDomain().replace(".myshopify.com", "")}/products/${p.id.split("/").pop()}`,
  };
}

export async function getSummary(id) {
  const data = await graphql(`query ProductSummary($id: ID!) { product(id: $id) { ${SUMMARY} } }`, { id });
  return data.product ? summarise(data.product) : null;
}

// Motto stores the pattern number as the product's vendor, one product per colour.
export async function findByVendor(pattern) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/.test(pattern)) return [];
  const data = await graphql(
    `query ProductsByVendor($q: String!) { products(first: 50, query: $q) { nodes { ${SUMMARY} } } }`,
    { q: `vendor:"${pattern}"` }
  );
  // Shopify's search is loose, so keep only exact vendor matches.
  return data.products.nodes
    .filter((p) => p.vendor.trim().toUpperCase() === pattern.toUpperCase())
    .map(summarise);
}

// Variant SKUs look like "9175_8" (number_size). Airtable holds the part before the size, written "9175_".
export function skuMatches(variantSku, value) {
  const wanted = String(value).trim().toUpperCase().replace(/_+$/, "");
  const sku = String(variantSku ?? "").toUpperCase();
  return wanted !== "" && (sku === wanted || sku.startsWith(`${wanted}_`));
}

export async function findBySku(value) {
  const prefix = String(value).trim().replace(/_+$/, "");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(prefix)) return [];
  const data = await graphql(
    `query VariantsBySku($q: String!) { productVariants(first: 50, query: $q) { nodes { sku product { ${SUMMARY} } } } }`,
    { q: `sku:${prefix}*` }
  );
  const products = new Map();
  for (const v of data.productVariants.nodes) {
    if (skuMatches(v.sku, value)) products.set(v.product.id, summarise(v.product));
  }
  return [...products.values()];
}

// ---------- Reading a product ----------
// Where a field is read from when that differs from the `path` it's written to.
const READ = {
  category: (p) => p.category?.id ?? null,
  cost: (v) => v.inventoryItem.unitCost?.amount ?? null,
  weight: (v) => toKilograms(v.inventoryItem.measurement?.weight),
};

const KG_PER_UNIT = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523125 };
function toKilograms(weight) {
  if (weight?.value == null) return null;
  return Number((weight.value * (KG_PER_UNIT[weight.unit] ?? 1)).toFixed(4));
}

function getPath(node, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), node) ?? null;
}

function nativeValues(node, fields) {
  return Object.fromEntries(fields.map((f) => [f.key, READ[f.key] ? READ[f.key](node) : getPath(node, f.path)]));
}

function metafieldMap(connection) {
  const out = {};
  // With a `keys` filter Shopify returns the key as "namespace.key".
  for (const m of connection?.nodes ?? []) {
    out[m.key.includes(".") ? m.key : `${m.namespace}.${m.key}`] = { type: m.type, value: m.value };
  }
  return out;
}

// Loads the current values of every native field, plus the metafields named in `keys` ("namespace.key").
export async function loadProduct(id, { keys = [], variantKeys = [] } = {}) {
  // Metafields are only selected (and their variables only declared) when some are mapped.
  const metafields = (n, arg) => (n ? `metafields(first: ${n}, keys: $${arg}) { nodes { namespace key type value } }` : "");
  const declare = (n, arg) => (n ? `$${arg}: [String!], ` : "");
  const variables = { id, ...(keys.length && { keys }), ...(variantKeys.length && { variantKeys }) };
  // A query may cost at most 1000 points, and each variant costs roughly one point per nested field.
  const pageSize = Math.max(5, Math.min(100, Math.floor(700 / (variantKeys.length + 4))));
  const query = `
    query ProductForSync($id: ID!, ${declare(keys.length, "keys")}${declare(variantKeys.length, "variantKeys")}$first: Int!, $after: String) {
      shop { currencyCode }
      product(id: $id) {
        id title descriptionHtml handle vendor productType tags status templateSuffix
        seo { title description } category { id }
        ${metafields(keys.length, "keys")}
        variants(first: $first, after: $after) {
          nodes {
            id title barcode price compareAtPrice taxable inventoryPolicy
            ${metafields(variantKeys.length, "variantKeys")}
            inventoryItem {
              sku tracked requiresShipping countryCodeOfOrigin harmonizedSystemCode
              unitCost { amount } measurement { weight { value unit } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;

  let product = null;
  const variants = [];
  let after = null;
  do {
    const data = await graphql(query, { ...variables, first: pageSize, after });
    if (!data.product) return null;
    product ??= {
      id: data.product.id,
      title: data.product.title,
      currency: data.shop.currencyCode,
      values: nativeValues(data.product, PRODUCT_FIELDS),
      metafields: metafieldMap(data.product.metafields),
    };
    for (const v of data.product.variants.nodes) {
      variants.push({ id: v.id, title: v.title, values: nativeValues(v, VARIANT_FIELDS), metafields: metafieldMap(v.metafields) });
    }
    const page = data.product.variants.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return { ...product, variants };
}

// ---------- Writing ----------
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

const messages = (errors) => errors.map((e) => e.message).join("; ");

// The Shopify requests that save the changes built by buildPreview (sync.mjs), without sending them.
// Each is { name, query, variables, changes (the ones it carries), errors (reads userErrors from its response) }.
export function buildRequests(productId, changes) {
  const requests = [];

  const productNative = changes.filter((c) => c.type === "native" && c.owner === "product");
  if (productNative.length) {
    const product = { id: productId };
    for (const c of productNative) setPath(product, c.path, c.value);
    requests.push({
      name: "productUpdate",
      query: `mutation ProductUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) { product { id } userErrors { field message } }
      }`,
      variables: { product },
      changes: productNative,
      errors: (data) => data.productUpdate.userErrors,
    });
  }

  const variantNative = changes.filter((c) => c.type === "native" && c.owner === "variant");
  if (variantNative.length) {
    const byId = new Map();
    for (const c of variantNative) {
      if (!byId.has(c.ownerId)) byId.set(c.ownerId, { id: c.ownerId });
      setPath(byId.get(c.ownerId), c.path, c.value);
      // Weights are mapped in kilograms.
      if (c.path.endsWith("weight.value")) setPath(byId.get(c.ownerId), c.path.replace(/value$/, "unit"), "KILOGRAMS");
    }
    requests.push({
      name: "productVariantsBulkUpdate",
      query: `mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
      }`,
      variables: { productId, variants: [...byId.values()] },
      changes: variantNative,
      errors: (data) => data.productVariantsBulkUpdate.userErrors,
    });
  }

  // metafieldsSet takes 25 at a time and saves none of them if any one is rejected.
  const metafields = changes.filter((c) => c.type === "metafield");
  for (let i = 0; i < metafields.length; i += 25) {
    const chunk = metafields.slice(i, i + 25);
    requests.push({
      name: "metafieldsSet",
      query: `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
      }`,
      variables: {
        metafields: chunk.map((c) => ({ ownerId: c.ownerId, namespace: c.namespace, key: c.key, type: c.metafieldType, value: c.value })),
      },
      changes: chunk,
      errors: (data) => data.metafieldsSet.userErrors,
    });
  }
  return requests;
}

// Sends the requests for these changes. Returns { results, requests }: results is a Map of
// change -> error message (null if saved); requests is what was sent, as { name, variables }.
// One request failing doesn't stop the others. With `dryRun` nothing is sent to Shopify at all.
export async function applyChanges(productId, changes, { dryRun = false } = {}) {
  const results = new Map();
  const requests = buildRequests(productId, changes);
  for (const request of requests) {
    let error = null;
    if (!dryRun) {
      try {
        const errors = request.errors(await graphql(request.query, request.variables));
        if (errors.length) error = messages(errors);
      } catch (err) {
        error = err.message;
      }
    }
    for (const c of request.changes) results.set(c, error);
  }
  return { results, requests: requests.map(({ name, variables }) => ({ name, variables })) };
}
