import { validateHostModuleSpec } from "../spec/validation.js";
import type {
  ChannelSpec,
  HostModuleSpec,
  HostOperationSpec,
  HostParameterSpec,
} from "../types/spec.js";

/** Validates and privately clones a runtime's complete injected registry. */
export function cloneHostModuleRegistry(
  modules: ReadonlyMap<string, HostModuleSpec> | undefined,
): ReadonlyMap<string, HostModuleSpec> {
  if (modules === undefined) return new Map();
  if (!(modules instanceof Map)) {
    throw new Error(
      "INVALID_HOST_MODULE_SPEC: hostModules must be a ReadonlyMap",
    );
  }
  const result = new Map<string, HostModuleSpec>();
  for (const [name, spec] of modules) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        "INVALID_HOST_MODULE_SPEC: host module names must be nonempty strings",
      );
    }
    const issue = validateHostModuleSpec(spec)[0];
    if (issue) {
      throw new Error(
        `INVALID_HOST_MODULE_SPEC: module ${JSON.stringify(name)} at ${issue.path}: ${issue.detail}`,
      );
    }
    result.set(name, cloneHostModuleSpec(spec));
  }
  return result;
}

function cloneHostModuleSpec(spec: HostModuleSpec): HostModuleSpec {
  return {
    kind: "namespace",
    members: Object.fromEntries(
      Object.entries(spec.members).map(([name, member]) => [
        name,
        member.kind === "namespace"
          ? cloneHostModuleSpec(member)
          : cloneOperation(member),
      ]),
    ),
  };
}

function cloneOperation(operation: HostOperationSpec): HostOperationSpec {
  return {
    kind: "operation",
    parameters: operation.parameters.map(cloneParameterSpec),
    ...(operation.returns
      ? { returns: cloneChannelSpec(operation.returns) }
      : {}),
  };
}

function cloneParameterSpec(spec: HostParameterSpec): HostParameterSpec {
  switch (spec.type) {
    case "enum":
      return { type: "enum", values: [...spec.values] };
    case "array":
      return { type: "array", element: cloneParameterSpec(spec.element) };
    case "tuple":
      return {
        type: "tuple",
        elements: spec.elements.map(cloneParameterSpec),
      };
    default:
      return { type: spec.type };
  }
}

function cloneChannelSpec(spec: ChannelSpec): ChannelSpec {
  switch (spec.type) {
    case "enum":
      return { type: "enum", values: [...spec.values] };
    case "array":
      return {
        type: "array",
        element: cloneParameterSpec(spec.element),
      } as ChannelSpec;
    default:
      return { type: spec.type };
  }
}
