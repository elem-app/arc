/**
 * Shared rules for Struct declarations and stored Struct values. A Struct cell
 * holds a complete record of its declared fields, or is unset.
 */

import { isPlainRecord, type PayloadValue } from "../types/value.js";
import { isHostStructFieldName } from "./host-parameters.js";

/**
 * Field names admitted by authored Struct declarations: safe record names that
 * do not collide with the `isUnset()` check.
 */
export function isStructFieldName(name: string): boolean {
  return isHostStructFieldName(name) && name !== "isUnset";
}

/**
 * Reads the stored value at a field path of a Struct value. An unset Struct
 * reads every field path as unset.
 */
export function fieldValueAt(
  value: PayloadValue,
  path: readonly string[],
): PayloadValue {
  let current = value;
  for (const name of path) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, name)) {
      return undefined;
    }
    current = current[name];
  }
  return current;
}
