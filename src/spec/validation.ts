import type { HostModuleSpecIssue, SpecViolation } from "../types/spec.js";

type HostSpecValidationContext = "argument" | "result";

type HostSpecValidationState = {
  visiting: WeakSet<object>;
};

/** Validates the exact normalized public shape of one host-module spec. */
export function validateHostModuleSpec(
  value: unknown,
): readonly HostModuleSpecIssue[] {
  const issues: HostModuleSpecIssue[] = [];
  validateHostNamespace(value, "$", issues, { visiting: new WeakSet() });
  return issues;
}

function validateHostNamespace(
  value: unknown,
  path: string,
  issues: HostModuleSpecIssue[],
  state: HostSpecValidationState,
): void {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object) return;
  if (!enterHostSpecObject(object, path, issues, state)) return;
  try {
    if (!exactHostSpecKeys(object, ["kind", "members"], path, issues)) return;
    if (object.kind !== "namespace") {
      hostSpecIssue(issues, `${path}.kind`, 'expected "namespace"');
      return;
    }
    const membersPath = `${path}.members`;
    const members = inspectHostSpecObject(object.members, membersPath, issues);
    if (!members) return;
    for (const [name, member] of Object.entries(members)) {
      if (name.length === 0 || name.startsWith("$")) {
        hostSpecIssue(
          issues,
          `${membersPath}[${JSON.stringify(name)}]`,
          "member names must be nonempty and cannot begin with $",
        );
        continue;
      }
      const memberPath = `${membersPath}[${JSON.stringify(name)}]`;
      const memberObject = inspectHostSpecObject(member, memberPath, issues);
      if (!memberObject) continue;
      if (memberObject.kind === "namespace") {
        validateHostNamespace(member, memberPath, issues, state);
      } else if (memberObject.kind === "operation") {
        validateHostOperation(member, memberPath, issues, state);
      } else {
        hostSpecIssue(
          issues,
          `${memberPath}.kind`,
          "expected namespace or operation",
        );
      }
    }
  } finally {
    state.visiting.delete(object);
  }
}

function validateHostOperation(
  value: unknown,
  path: string,
  issues: HostModuleSpecIssue[],
  state: HostSpecValidationState,
): void {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object) return;
  if (!enterHostSpecObject(object, path, issues, state)) return;
  try {
    if (
      !exactHostSpecKeys(
        object,
        ["kind", "parameters", "returns"],
        path,
        issues,
        ["returns"],
      )
    ) {
      return;
    }
    if (object.kind !== "operation") {
      hostSpecIssue(issues, `${path}.kind`, 'expected "operation"');
      return;
    }
    const parameters = inspectHostSpecArray(
      object.parameters,
      `${path}.parameters`,
      issues,
    );
    if (!parameters) return;
    parameters.forEach((parameter, index) => {
      const parameterPath = `${path}.parameters[${index}]`;
      validateHostParameterSpec(
        parameter,
        parameterPath,
        "argument",
        issues,
        state,
      );
    });
    if (Object.hasOwn(object, "returns")) {
      validateHostParameterSpec(
        object.returns,
        `${path}.returns`,
        "result",
        issues,
        state,
      );
    }
  } finally {
    state.visiting.delete(object);
  }
}

function validateHostParameterSpec(
  value: unknown,
  path: string,
  context: HostSpecValidationContext,
  issues: HostModuleSpecIssue[],
  state: HostSpecValidationState,
): void {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object) return;
  if (!enterHostSpecObject(object, path, issues, state)) return;
  try {
    const type = object.type;
    if (typeof type !== "string") {
      hostSpecIssue(issues, `${path}.type`, "spec type must be a string");
      return;
    }
    if (type === "array") {
      if (!exactHostSpecKeys(object, ["type", "element"], path, issues)) {
        return;
      }
      if (context === "result") {
        const element = inspectHostSpecObject(
          object.element,
          `${path}.element`,
          issues,
        );
        if (!element) return;
        if (
          element.type !== "boolean" &&
          element.type !== "string" &&
          element.type !== "enum" &&
          element.type !== "number" &&
          element.type !== "artifact"
        ) {
          hostSpecIssue(
            issues,
            `${path}.element`,
            "result array element must be a scalar or Artifact Arc spec",
          );
          return;
        }
        validateHostParameterSpec(
          object.element,
          `${path}.element`,
          "result",
          issues,
          state,
        );
        return;
      }
      validateHostParameterSpec(
        object.element,
        `${path}.element`,
        context,
        issues,
        state,
      );
      return;
    }
    if (type === "tuple") {
      if (context === "result") {
        hostSpecIssue(issues, path, "tuple specs are parameter-only");
        return;
      }
      if (!exactHostSpecKeys(object, ["type", "elements"], path, issues)) {
        return;
      }
      const elements = inspectHostSpecArray(
        object.elements,
        `${path}.elements`,
        issues,
      );
      elements?.forEach((element, index) =>
        validateHostParameterSpec(
          element,
          `${path}.elements[${index}]`,
          context,
          issues,
          state,
        ),
      );
      return;
    }
    if (type === "semanticText") {
      if (context === "result") {
        hostSpecIssue(issues, path, "semanticText specs are parameter-only");
        return;
      }
      exactHostSpecKeys(object, ["type"], path, issues);
      return;
    }
    if (type === "enum") {
      if (!exactHostSpecKeys(object, ["type", "values"], path, issues)) {
        return;
      }
      const values = inspectHostSpecArray(
        object.values,
        `${path}.values`,
        issues,
      );
      if (!values) return;
      if (values.some((entry) => typeof entry !== "string")) {
        hostSpecIssue(issues, `${path}.values`, "Enum values must be strings");
        return;
      }
    } else if (
      type === "boolean" ||
      type === "string" ||
      type === "number" ||
      type === "index" ||
      type === "artifact" ||
      type === "dialogCursor"
    ) {
      if (!exactHostSpecKeys(object, ["type"], path, issues)) return;
    } else {
      hostSpecIssue(
        issues,
        `${path}.type`,
        `unsupported spec type ${JSON.stringify(type)}`,
      );
      return;
    }
    const violation = validateSpec(object);
    if (violation) hostSpecIssue(issues, path, violation.detail);
  } finally {
    state.visiting.delete(object);
  }
}

function enterHostSpecObject(
  object: object,
  path: string,
  issues: HostModuleSpecIssue[],
  state: HostSpecValidationState,
): boolean {
  if (state.visiting.has(object)) {
    hostSpecIssue(
      issues,
      path,
      "cyclic host-module spec shapes are unsupported",
    );
    return false;
  }
  state.visiting.add(object);
  return true;
}

function inspectHostSpecObject(
  value: unknown,
  path: string,
  issues: HostModuleSpecIssue[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    hostSpecIssue(issues, path, "expected a plain object");
    return undefined;
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    hostSpecIssue(issues, path, "object shape could not be inspected");
    return undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    hostSpecIssue(issues, path, "expected a plain object");
    return undefined;
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      hostSpecIssue(issues, path, "symbol keys are unsupported");
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      hostSpecIssue(
        issues,
        `${path}[${JSON.stringify(key)}]`,
        "fields must be enumerable data properties",
      );
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function inspectHostSpecArray(
  value: unknown,
  path: string,
  issues: HostModuleSpecIssue[],
): unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    hostSpecIssue(issues, path, "expected an ordinary array");
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      hostSpecIssue(
        issues,
        `${path}[${index}]`,
        "arrays must be dense enumerable data",
      );
      return undefined;
    }
  }
  const extra = Reflect.ownKeys(value).find((key) => {
    if (key === "length") return false;
    if (typeof key !== "string") return true;
    const index = Number(key);
    return (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== key ||
      index >= value.length
    );
  });
  if (extra !== undefined) {
    hostSpecIssue(issues, path, "arrays cannot contain non-element properties");
    return undefined;
  }
  return value;
}

function exactHostSpecKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: HostModuleSpecIssue[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(object);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown) {
    hostSpecIssue(
      issues,
      `${path}[${JSON.stringify(unknown)}]`,
      "unsupported field",
    );
    return false;
  }
  const missing = allowed.find(
    (key) => !optional.includes(key) && !Object.hasOwn(object, key),
  );
  if (missing) {
    hostSpecIssue(issues, `${path}.${missing}`, "required field is missing");
    return false;
  }
  return true;
}

function hostSpecIssue(
  issues: HostModuleSpecIssue[],
  path: string,
  detail: string,
): void {
  issues.push({ code: "invalid-host-module-spec", path, detail });
}

/** Validates invariants the representational TypeScript union cannot express. */
export function validateSpec(spec: unknown): SpecViolation | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {
      code: "invalid-spec-shape",
      detail: "Spec must be an object",
    };
  }
  const object = spec as Record<string, unknown>;
  if (object.type === "array") {
    if (!("element" in object)) {
      return {
        code: "invalid-spec-shape",
        detail: "Array spec requires an element spec",
      };
    }
    const elementViolation = validateSpec(object.element);
    if (elementViolation) return elementViolation;
    const elementType = (object.element as Record<string, unknown>).type;
    if (
      elementType !== "boolean" &&
      elementType !== "string" &&
      elementType !== "enum" &&
      elementType !== "number" &&
      elementType !== "artifact"
    ) {
      return {
        code: "invalid-spec-shape",
        detail: "Array element spec must be scalar or Artifact",
      };
    }
    return undefined;
  }
  if (object.type === "enum") {
    if (
      !Array.isArray(object.values) ||
      object.values.some((value) => typeof value !== "string")
    ) {
      return {
        code: "invalid-spec-shape",
        detail: "Enum values must be an array of strings",
      };
    }
    if (object.values.length === 0) {
      return { code: "empty-enum", detail: "Enum requires at least one value" };
    }
    const seen = new Set<string>();
    for (const value of object.values) {
      if (seen.has(value)) {
        return {
          code: "duplicate-enum-value",
          detail: `Enum contains duplicate value ${JSON.stringify(value)}`,
        };
      }
      seen.add(value);
    }
    return undefined;
  }
  if (
    object.type !== "boolean" &&
    object.type !== "string" &&
    object.type !== "number" &&
    object.type !== "index" &&
    object.type !== "artifact" &&
    object.type !== "dialogCursor"
  ) {
    return {
      code: "invalid-spec-shape",
      detail: `Unsupported spec type ${JSON.stringify(object.type)}`,
    };
  }
  return undefined;
}
