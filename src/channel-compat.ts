import type { CellSpec, ChannelSpec, ScalarSpec } from "./types.js";

function scalarSpecToChannelSpec(spec: ScalarSpec): ChannelSpec {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "rangedInt":
      return { type: "rangedInt", min: spec.min, max: spec.max };
  }
}

/**
 * The channel schema a cell spec provides when bound into an enter channel, or
 * `undefined` for a spec that cannot cross an enter boundary.
 */
export function cellSpecToChannelSpec(spec: CellSpec): ChannelSpec | undefined {
  switch (spec.type) {
    case "boolean":
    case "string":
    case "enum":
    case "rangedInt":
      return scalarSpecToChannelSpec(spec);
    case "dialogCursor":
      return { type: "dialogCursor" };
    case "array":
      return {
        type: "array",
        element: scalarSpecToChannelSpec(spec.element),
      };
    default:
      return undefined;
  }
}

/**
 * Whether two channel schemas are compatible: same base type, with enum members,
 * ranged-integer bounds, and array element shape matching structurally. `index`
 * is compatible only with `index`.
 */
export function channelSpecsCompatible(
  a: ChannelSpec,
  b: ChannelSpec,
): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "enum" && b.type === "enum") {
    return (
      a.values.length === b.values.length &&
      a.values.every((value, index) => value === b.values[index])
    );
  }
  if (a.type === "rangedInt" && b.type === "rangedInt") {
    return a.min === b.min && a.max === b.max;
  }
  if (a.type === "array" && b.type === "array") {
    return channelSpecsCompatible(a.element, b.element);
  }
  return true;
}
