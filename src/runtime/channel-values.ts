import { admitValue } from "../spec/resolution.js";
import type { ChannelNamespace } from "../types/parser.js";
import type { ChannelSpec } from "../types/spec.js";
import type { CellValue } from "../types/value.js";
import { runtimeError } from "./report-validation.js";

export type ChannelValueUse = "return-write" | "arc-entry";

/**
 * Validates one concrete value against a declared channel schema.
 *
 * The same runtime assertion serves authored return writes and direct Arc
 * arguments so their value domains and numeric refinements stay identical.
 */
export function assertAssignableChannelValue(
  namespace: ChannelNamespace,
  key: string,
  spec: ChannelSpec,
  value: unknown,
  use: ChannelValueUse,
): asserts value is CellValue {
  const label =
    use === "return-write"
      ? `${namespace}.${key}.$set()`
      : `${namespace}.${key} supplied to Runtime.enterArc()`;
  const invalidValueReasonCode =
    use === "return-write" ? "invalid-return-value" : "invalid-arc-argument";
  const admission = admitValue(spec, value);
  if (admission.admitted) return;

  const { code, detail, path } = admission.violation;
  if (code === "non-finite-number") {
    const consumer =
      use === "return-write" ? "return write" : "direct Arc entry";
    throw runtimeError(
      "non-finite-number",
      `Numeric value must be finite before ${consumer}${path === "$" ? "" : ` at ${path}`}`,
    );
  }
  if (code === "invalid-enum") {
    throw runtimeError(
      use === "return-write" ? "invalid-enum-value" : invalidValueReasonCode,
      `${label} must satisfy its Enum constraint: ${detail}${path === "$" ? "" : ` at ${path}`}`,
    );
  }
  if (code === "invalid-dialog-cursor") {
    throw runtimeError(
      use === "return-write" ? "invalid-dialog-cursor" : invalidValueReasonCode,
      `${label} must be a valid Dialog cursor`,
    );
  }
  if (code === "invalid-artifact") {
    throw runtimeError(
      invalidValueReasonCode,
      `${label} requires a valid Artifact value${path === "$" ? "" : ` at ${path}`}: ${detail}`,
    );
  }
  if (code === "invalid-index") {
    throw runtimeError(
      invalidValueReasonCode,
      `${label} requires a non-negative integer`,
    );
  }
  if (code === "unset") {
    throw runtimeError(invalidValueReasonCode, `${label} requires a set value`);
  }
  if (code === "invalid-string") {
    throw runtimeError(
      invalidValueReasonCode,
      `${label} requires a string value`,
    );
  }
  if (code === "invalid-boolean") {
    throw runtimeError(
      invalidValueReasonCode,
      `${label} requires a boolean value`,
    );
  }
  if (code === "invalid-number") {
    throw runtimeError(
      invalidValueReasonCode,
      `${label} requires a numeric value`,
    );
  }
  throw runtimeError(
    invalidValueReasonCode,
    `${label} is incompatible with its declared ${spec.type} constraint${path === "$" ? "" : ` at ${path}`}`,
  );
}

export { isDialogCursorValue } from "../types/value.js";
