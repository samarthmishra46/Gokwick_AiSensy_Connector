/**
 * Flexible field extraction for GoKwik abandoned-cart payloads.
 *
 * GoKwik does not publish its payload format, so for every field we try:
 *   1. an explicit MAP_* override path (env var), if set
 *   2. the candidate dot-paths below, in order
 *   3. a deep, case-insensitive key-name search (depth <= 6, shallowest match wins)
 *
 * After running discovery mode against a real payload, edit FIELD_CONFIG (or set
 * MAP_* env vars) so the first candidate hits the right field.
 */

export const FIELD_CONFIG = {
  phone: {
    paths: [
      "phone",
      "mobile",
      "phone_number",
      "customer.phone",
      "customer_phone",
      "user.phone",
      "customer.mobile",
      "shipping_address.phone",
      "billing_address.phone",
      "address.phone",
    ],
    deepKeys: ["phone", "mobile", "phone_number", "customer_phone", "mobile_number", "phone_no"],
  },
  firstName: {
    paths: [
      "first_name",
      "customer.first_name",
      "shipping_address.first_name",
      "billing_address.first_name",
      "address.first_name",
      "name",
      "customer.name",
    ],
    // No bare "name" here: deep-searching "name" would pick up product names.
    deepKeys: ["first_name", "firstname", "customer_name", "full_name"],
  },
  link: {
    paths: [
      "kwik_link",
      "abc_link",
      "abandoned_checkout_url",
      "checkout_url",
      "recovery_url",
      "cart_url",
      "link",
    ],
    deepKeys: [
      "kwik_link",
      "abc_link",
      "abandoned_checkout_url",
      "checkout_url",
      "recovery_url",
      "cart_url",
    ],
  },
  cartId: {
    paths: ["cart_id", "id", "request_id", "abc_request_id", "token"],
    // No bare "id"/"token" here: they'd match customer or line-item ids.
    deepKeys: ["cart_id", "request_id", "abc_request_id", "checkout_id"],
  },
  total: {
    paths: ["total_price", "amount", "cart_value", "total"],
    deepKeys: ["total_price", "cart_value", "cart_total", "grand_total"],
  },
  items: {
    paths: ["line_items", "items", "cart.items", "cart.line_items", "products", "cart_items"],
    deepKeys: ["line_items", "cart_items", "products"],
    titleKeys: ["title", "name", "product_title", "product_name", "variant_title"],
  },
} as const;

/** Keys that wrap one or many carts, e.g. `{ data: [...] }` or `{ carts: [...] }`. */
const WRAPPER_KEYS = [
  "data",
  "carts",
  "abandoned_carts",
  "checkouts",
  "records",
  "results",
  "payload",
  "body",
];

const MAX_DEPTH = 6;

export type FieldName = "phone" | "firstName" | "link" | "cartId" | "total" | "itemsSummary";
export type PickSource = "override" | "candidate" | "deep";
export interface Picked {
  value: string;
  path: string;
  via: PickSource;
}
export type Extraction = Partial<Record<FieldName, Picked>>;

export interface FieldOverrides {
  phone?: string;
  name?: string;
  link?: string;
  cartId?: string;
  total?: string;
}

export interface CartEntry {
  cart: Record<string, unknown>;
  /** Where the cart sat in the request body, e.g. "$", "$.data.0". */
  at: string;
}

type Obj = Record<string, unknown>;
type Accept = (v: unknown) => string | undefined;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "Phone_Number", "phoneNumber" and "phone-number" all compare equal. */
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findKey(o: Obj, key: string): string | undefined {
  if (key in o) return key;
  const n = normKey(key);
  return Object.keys(o).find((k) => normKey(k) === n);
}

/** Resolve a dot-path like "customer.phone" or "line_items.0.title" (keys case-insensitive). */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".").filter(Boolean)) {
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
    } else if (isObj(cur)) {
      const k = findKey(cur, seg);
      cur = k === undefined ? undefined : cur[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Breadth-first search for the shallowest key matching one of `keys`. */
function deepFind(root: unknown, keys: readonly string[], accept: Accept) {
  const wanted = new Set(keys.map(normKey));
  const queue: { node: unknown; path: string; depth: number }[] = [
    { node: root, path: "", depth: 0 },
  ];
  while (queue.length) {
    const { node, path, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    if (Array.isArray(node)) {
      node.forEach((child, i) =>
        queue.push({ node: child, path: path ? `${path}.${i}` : String(i), depth: depth + 1 }),
      );
    } else if (isObj(node)) {
      for (const [k, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${k}` : k;
        if (wanted.has(normKey(k))) {
          const value = accept(child);
          if (value !== undefined) return { value, path: childPath };
        }
        queue.push({ node: child, path: childPath, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

function resolve(
  cart: unknown,
  override: string | undefined,
  paths: readonly string[],
  deepKeys: readonly string[],
  accept: Accept,
): Picked | undefined {
  if (override) {
    const value = accept(getPath(cart, override));
    if (value !== undefined) return { value, path: override, via: "override" };
  }
  for (const path of paths) {
    const value = accept(getPath(cart, path));
    if (value !== undefined) return { value, path, via: "candidate" };
  }
  const hit = deepFind(cart, deepKeys, accept);
  return hit && { ...hit, via: "deep" };
}

const acceptScalar: Accept = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
};

const acceptText: Accept = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const acceptUrl: Accept = (v) => {
  const s = acceptText(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : undefined;
  } catch {
    return undefined;
  }
};

/** "PRIYA SHARMA" (from a full-name field) -> "Priya"; "anjali" -> "Anjali". */
function cleanFirstName(value: string, path: string): string | undefined {
  const lastKey = normKey(path.split(".").pop() ?? "");
  const isFirstNameField = lastKey === "firstname";
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const name = isFirstNameField ? words.join(" ") : (words[0] ?? "");
  if (!name || /[@\d]/.test(name)) return undefined; // looks like an email/phone, not a name
  const lower = name.toLowerCase();
  return name === name.toUpperCase() || name === lower
    ? lower.replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase())
    : name;
}

function itemsSummary(cart: unknown): Picked | undefined {
  const cfg = FIELD_CONFIG.items;
  const acceptList: Accept = (v) => (Array.isArray(v) && v.length ? "list" : undefined);
  const where = resolve(cart, undefined, cfg.paths, cfg.deepKeys, acceptList);
  if (!where) return undefined;
  const list = getPath(cart, where.path) as unknown[];
  const first = list[0];
  if (!isObj(first)) return undefined;
  const title = cfg.titleKeys
    .map((k) => acceptText(getPath(first, k)))
    .find((t): t is string => t !== undefined);
  if (!title) return undefined;
  const more = list.length - 1;
  return {
    value: more > 0 ? `${title} and ${more} more` : title,
    path: where.path,
    via: where.via,
  };
}

export function extractFields(cart: unknown, overrides: FieldOverrides = {}): Extraction {
  const out: Extraction = {};
  const f = FIELD_CONFIG;

  out.phone = resolve(cart, overrides.phone, f.phone.paths, f.phone.deepKeys, acceptScalar);

  const name = resolve(cart, overrides.name, f.firstName.paths, f.firstName.deepKeys, acceptText);
  const firstName = name && cleanFirstName(name.value, name.path);
  if (name && firstName) out.firstName = { ...name, value: firstName };

  out.link = resolve(cart, overrides.link, f.link.paths, f.link.deepKeys, acceptUrl);
  out.cartId = resolve(cart, overrides.cartId, f.cartId.paths, f.cartId.deepKeys, acceptScalar);
  out.total = resolve(cart, overrides.total, f.total.paths, f.total.deepKeys, acceptScalar);
  out.itemsSummary = itemsSummary(cart);

  for (const k of Object.keys(out) as FieldName[]) if (!out[k]) delete out[k];
  return out;
}

/** Does this object itself look like a cart (rather than a wrapper around carts)? */
function looksLikeCart(o: Obj): boolean {
  return [...FIELD_CONFIG.phone.paths, ...FIELD_CONFIG.link.paths].some(
    (p) => acceptScalar(getPath(o, p)) !== undefined,
  );
}

/**
 * Split a webhook body into carts. Handles a single cart, an array of carts, and
 * wrappers like `{ data: [...] }`, `{ carts: [...] }` or `{ data: { ...cart } }`.
 */
export function splitCarts(body: unknown, at = "$", depth = 0): CartEntry[] {
  if (depth > 3) return [];
  if (Array.isArray(body)) {
    return body.flatMap((item, i) => splitCarts(item, `${at}.${i}`, depth + 1));
  }
  if (!isObj(body)) return [];
  if (!looksLikeCart(body)) {
    for (const w of WRAPPER_KEYS) {
      const k = findKey(body, w);
      if (k === undefined) continue;
      const inner = body[k];
      if (Array.isArray(inner) || isObj(inner)) {
        const carts = splitCarts(inner, `${at}.${k}`, depth + 1);
        if (carts.length) return carts;
      }
    }
  }
  return [{ cart: body, at }];
}
