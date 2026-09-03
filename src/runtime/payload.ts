/** Deep-clones plain Arc data without applying numeric canonicalization. */
export function clonePreservingNumbers<T>(value: T): T {
  return clonePreservingNumbersAt(value, "$");
}

function clonePreservingNumbersAt<T>(value: T, path: string): T {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      clonePreservingNumbersAt(item, `${path}[${index}]`),
    ) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        clonePreservingNumbersAt(item, `${path}[${JSON.stringify(key)}]`),
      ]),
    ) as T;
  }
  return value;
}

/** Canonicalizes negative zero throughout a mutable plain Arc data graph. */
export function canonicalizeNegativeZeroInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === "number" && Object.is(item, -0)) value[index] = 0;
      else canonicalizeNegativeZeroInPlace(item);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      const item = object[key];
      if (typeof item === "number" && Object.is(item, -0)) object[key] = 0;
      else canonicalizeNegativeZeroInPlace(item);
    }
  }
}
