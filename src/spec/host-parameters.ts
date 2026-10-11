import type {
  HostOperationSpec,
  HostParameterSpec,
  HostParameterValueSpec,
} from "../types/spec.js";

/** Field names admitted by host Struct declarations and authored objects. */
export function isHostStructFieldName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "__proto__" &&
    name !== "prototype" &&
    name !== "constructor"
  );
}

/** Returns the accepted argument-count range of a validated host operation. */
export function hostOperationArity(operation: HostOperationSpec): {
  min: number;
  max: number;
} {
  const firstOmittable = operation.parameters.findIndex(
    (parameter) => parameter.type === "omittable",
  );
  return {
    min: firstOmittable < 0 ? operation.parameters.length : firstOmittable,
    max: operation.parameters.length,
  };
}

/** Checks an argument count against a validated host operation. */
export function acceptsHostArgumentCount(
  operation: HostOperationSpec,
  count: number,
): boolean {
  const { min, max } = hostOperationArity(operation);
  return Number.isInteger(count) && count >= min && count <= max;
}

/** Returns the value guarantee enforced whenever this parameter is supplied. */
export function hostParameterValueSpec(
  parameter: HostParameterSpec,
): HostParameterValueSpec {
  return parameter.type === "omittable" ? parameter.spec : parameter;
}

/** Copies a validated parameter spec into independent ownership. */
export function cloneParameterSpec(
  spec: HostParameterValueSpec,
): HostParameterValueSpec;
export function cloneParameterSpec(spec: HostParameterSpec): HostParameterSpec;
export function cloneParameterSpec(spec: HostParameterSpec): HostParameterSpec {
  switch (spec.type) {
    case "omittable":
      return { type: "omittable", spec: cloneParameterSpec(spec.spec) };
    case "enum":
      return { type: "enum", values: [...spec.values] };
    case "array":
      return { type: "array", element: cloneParameterSpec(spec.element) };
    case "tuple":
      return {
        type: "tuple",
        elements: spec.elements.map((element) => cloneParameterSpec(element)),
      };
    case "struct":
      return {
        type: "struct",
        fields: Object.fromEntries(
          Object.entries(spec.fields).map(([name, field]) => [
            name,
            cloneParameterSpec(field),
          ]),
        ),
      };
    default:
      return { type: spec.type };
  }
}
