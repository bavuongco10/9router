// Normalize object keys to snake_case so JSON imports using camelCase / PascalCase
// (e.g. refreshToken, RefreshToken) work the same as snake_case (refresh_token).

// refreshToken -> refresh_token, RefreshToken -> refresh_token, profileArn -> profile_arn
export function toSnakeCase(key) {
  return String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2") // ABCWord -> ABC_Word
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")      // fooBar  -> foo_Bar
    .replace(/[-\s]+/g, "_")                     // kebab / spaces -> _
    .toLowerCase();
}

// Shallow-normalize a plain object's keys to snake_case. A key already in exact
// snake_case wins over a camelCase variant that maps onto the same name.
export function snakeifyKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = toSnakeCase(k);
    if (!(nk in out) || k === nk) out[nk] = v;
  }
  return out;
}
