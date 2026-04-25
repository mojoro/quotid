type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function transformKeys(input: Json, fn: (k: string) => string): Json {
  if (Array.isArray(input)) return input.map((v) => transformKeys(v, fn));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [fn(k), transformKeys(v as Json, fn)])
    );
  }
  return input;
}

export const toSnake = (v: Json) => transformKeys(v, camelToSnake);
export const toCamel = (v: Json) => transformKeys(v, snakeToCamel);
