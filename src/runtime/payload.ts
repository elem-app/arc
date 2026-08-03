import type { PayloadValue } from "../types.js";

export function clonePayloadValue(value: PayloadValue): PayloadValue {
  if (Array.isArray(value)) return value.map((item) => clonePayloadValue(item));
  if (value !== null && typeof value === "object") {
    return clonePayloadObject(value);
  }
  return value;
}

export function clonePayloadObject(
  value: Record<string, PayloadValue>,
): Record<string, PayloadValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clonePayloadValue(item)]),
  );
}

/**
 * Returns a cloned payload where `override` takes precedence over `base`.
 *
 * If `override` is `undefined`, it is treated as absent and the cloned `base`
 * value is returned. If both values are plain payload objects, their fields are
 * shallow-merged and fields from `override` replace fields from `base`. If
 * either value is not a plain payload object, the cloned `override` value is
 * returned.
 */
export function mergeAndClonePayload(
  base: PayloadValue,
  override: PayloadValue,
): PayloadValue {
  if (override === undefined) return clonePayloadValue(base);
  if (isPayloadObject(base) && isPayloadObject(override)) {
    return {
      ...clonePayloadObject(base),
      ...clonePayloadObject(override),
    };
  }
  return clonePayloadValue(override);
}

function isPayloadObject(
  value: PayloadValue,
): value is Record<string, PayloadValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
