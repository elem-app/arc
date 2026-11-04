import type {
  HostModuleSpecIssue,
  HostParameterSpec,
  SpecViolation,
} from "../types/spec.js";
import { isPlainRecord } from "../value-utils.js";
import { isHostStructFieldName } from "./host-parameters.js";
import { isStructFieldName } from "./struct.js";

type HostSpecValidationContext = "parameter" | "field" | "argument" | "result";

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
    const parameterIssueCount = issues.length;
    parameters.forEach((parameter, index) => {
      const parameterPath = `${path}.parameters[${index}]`;
      validateHostParameterSpec(
        parameter,
        parameterPath,
        "parameter",
        issues,
        state,
      );
    });
    if (issues.length === parameterIssueCount) {
      let omittable = false;
      (parameters as HostParameterSpec[]).forEach((parameter, index) => {
        if (parameter.type === "omittable") {
          omittable = true;
        } else if (omittable) {
          hostSpecIssue(
            issues,
            `${path}.parameters[${index}]`,
            "required parameters cannot follow omittable parameters",
          );
        }
      });
    }
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
    if (type === "omittable") {
      if (context !== "parameter" && context !== "field") {
        hostSpecIssue(
          issues,
          path,
          "omittable specs are only valid around a whole parameter or Struct field",
        );
        return;
      }
      if (!exactHostSpecKeys(object, ["type", "spec"], path, issues)) return;
      validateHostParameterSpec(
        object.spec,
        `${path}.spec`,
        "argument",
        issues,
        state,
      );
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
          element.type !== "artifact" &&
          element.type !== "struct"
        ) {
          hostSpecIssue(
            issues,
            `${path}.element`,
            "result array element must be a scalar, Artifact, or Struct Arc spec",
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
        "argument",
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
          "argument",
          issues,
          state,
        ),
      );
      return;
    }
    if (type === "struct") {
      if (!exactHostSpecKeys(object, ["type", "fields"], path, issues)) return;
      if (context === "result") {
        validateHostStructResultSpec(object, path, issues, state);
        return;
      }
      const fields = inspectHostSpecObject(
        object.fields,
        `${path}.fields`,
        issues,
      );
      if (!fields) return;
      for (const [name, field] of Object.entries(fields)) {
        const fieldPath = `${path}.fields[${JSON.stringify(name)}]`;
        if (!isHostStructFieldName(name)) {
          hostSpecIssue(
            issues,
            fieldPath,
            "Struct field names must be nonempty and cannot be __proto__, prototype, or constructor",
          );
          continue;
        }
        validateHostParameterSpec(field, fieldPath, "field", issues, state);
      }
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

/**
 * Validates a Struct result: every field is an observable Arc field — a
 * scalar, an array of scalars or Structs, or a nested Struct — so a complete
 * result can land on an observable Struct cell.
 */
function validateHostStructResultSpec(
  object: Record<string, unknown>,
  path: string,
  issues: HostModuleSpecIssue[],
  state: HostSpecValidationState,
): void {
  const fields = inspectHostSpecObject(object.fields, `${path}.fields`, issues);
  if (!fields) return;
  for (const [name, field] of Object.entries(fields)) {
    const fieldPath = `${path}.fields[${JSON.stringify(name)}]`;
    if (!isStructFieldName(name)) {
      hostSpecIssue(issues, fieldPath, "invalid Struct result field name");
      continue;
    }
    const fieldObject = inspectHostSpecObject(field, fieldPath, issues);
    if (!fieldObject) continue;
    const elementType =
      fieldObject.type === "array" && isPlainRecord(fieldObject.element)
        ? fieldObject.element.type
        : undefined;
    if (
      fieldObject.type === "artifact" ||
      fieldObject.type === "dialogCursor" ||
      fieldObject.type === "index" ||
      fieldObject.type === "omittable" ||
      elementType === "artifact"
    ) {
      hostSpecIssue(
        issues,
        fieldPath,
        "Struct result fields must be observable scalars, observable arrays, or Structs",
      );
      continue;
    }
    validateHostParameterSpec(field, fieldPath, "result", issues, state);
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
  if (unknown !== undefined) {
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
      elementType !== "artifact" &&
      elementType !== "struct"
    ) {
      return {
        code: "invalid-spec-shape",
        detail: "Array element spec must be scalar, Artifact, or Struct",
      };
    }
    return undefined;
  }
  if (object.type === "struct") {
    return validateStructSpec(object);
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

/**
 * Validates a Struct spec: safe field names, each field an observable scalar,
 * an observable array of scalars or Structs, or a nested Struct.
 */
function validateStructSpec(
  object: Record<string, unknown>,
): SpecViolation | undefined {
  const fields = object.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {
      code: "invalid-spec-shape",
      detail: "Struct spec requires a fields record",
    };
  }
  for (const [name, field] of Object.entries(fields)) {
    if (!isStructFieldName(name)) {
      return {
        code: "invalid-spec-shape",
        detail: `Invalid Struct field name ${JSON.stringify(name)}`,
      };
    }
    const violation = validateSpec(field);
    if (violation) return violation;
    if (!isPlainRecord(field)) continue;
    const elementType =
      field.type === "array" && isPlainRecord(field.element)
        ? field.element.type
        : undefined;
    if (
      field.type === "artifact" ||
      field.type === "dialogCursor" ||
      field.type === "index" ||
      elementType === "artifact"
    ) {
      return {
        code: "invalid-spec-shape",
        detail: `Struct field ${JSON.stringify(name)} must be observable`,
      };
    }
  }
  return undefined;
}
