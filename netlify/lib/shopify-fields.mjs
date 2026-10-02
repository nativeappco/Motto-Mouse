// Native Shopify product and variant fields that can be mapped to.
// `path` is where the value goes in ProductSetInput / ProductVariantsBulkInput when syncing.
// `kind` drives value coercion and which update modes make sense (see mapping.mjs).
export const PRODUCT_FIELDS = [
  { key: "title", label: "Title", kind: "text", path: "title" },
  { key: "descriptionHtml", label: "Description", kind: "html", path: "descriptionHtml" },
  { key: "handle", label: "Handle (URL)", kind: "text", path: "handle" },
  { key: "vendor", label: "Vendor", kind: "text", path: "vendor" },
  { key: "productType", label: "Product type", kind: "text", path: "productType" },
  { key: "tags", label: "Tags", kind: "list", path: "tags" },
  { key: "status", label: "Status", kind: "enum", path: "status", choices: ["ACTIVE", "DRAFT", "ARCHIVED"] },
  { key: "seoTitle", label: "SEO title", kind: "text", path: "seo.title" },
  { key: "seoDescription", label: "SEO description", kind: "multiline", path: "seo.description" },
  { key: "templateSuffix", label: "Theme template", kind: "text", path: "templateSuffix" },
  { key: "category", label: "Product category (taxonomy ID)", kind: "text", path: "category" },
];

export const VARIANT_FIELDS = [
  { key: "sku", label: "SKU", kind: "text", path: "inventoryItem.sku" },
  { key: "barcode", label: "Barcode", kind: "text", path: "barcode" },
  { key: "price", label: "Price", kind: "money", path: "price" },
  { key: "compareAtPrice", label: "Compare-at price", kind: "money", path: "compareAtPrice" },
  { key: "cost", label: "Cost per item", kind: "money", path: "inventoryItem.cost" },
  { key: "taxable", label: "Charge tax", kind: "boolean", path: "taxable" },
  { key: "inventoryPolicy", label: "Sell when out of stock", kind: "enum", path: "inventoryPolicy", choices: ["DENY", "CONTINUE"] },
  { key: "tracked", label: "Track inventory", kind: "boolean", path: "inventoryItem.tracked" },
  { key: "requiresShipping", label: "Physical product (requires shipping)", kind: "boolean", path: "inventoryItem.requiresShipping" },
  { key: "weight", label: "Weight (kg)", kind: "number", path: "inventoryItem.measurement.weight.value" },
  { key: "countryCodeOfOrigin", label: "Country of origin (ISO code)", kind: "text", path: "inventoryItem.countryCodeOfOrigin" },
  { key: "harmonizedSystemCode", label: "HS tariff code", kind: "text", path: "inventoryItem.harmonizedSystemCode" },
];

export const NATIVE_FIELDS = { product: PRODUCT_FIELDS, variant: VARIANT_FIELDS };

export function nativeField(owner, key) {
  return NATIVE_FIELDS[owner]?.find((f) => f.key === key) ?? null;
}

// Map a metafield definition type (e.g. "list.single_line_text_field") to a value kind.
export function metafieldKind(type) {
  if (type.startsWith("list.")) return "list";
  switch (type) {
    case "single_line_text_field":
    case "url":
    case "color":
      return "text";
    case "multi_line_text_field":
      return "multiline";
    case "rich_text_field":
      return "rich_text";
    case "number_integer":
    case "number_decimal":
      return "number";
    case "money":
      return "money";
    case "boolean":
      return "boolean";
    default:
      // date, date_time, json, dimension/weight/volume, references, rating, etc.
      return "other";
  }
}
