import {
  classifyArtifactPath,
  type ArtifactPathIssue,
  type ArtifactValue,
  type ArtifactValueIssue,
  type PayloadValue,
  type StructValue,
} from "./types/value.js";

/** First structural violation found while inspecting a host payload carrier. */
export type PayloadValueIssue = {
  path: string;
  code: "invalid-struct-value";
  detail: string;
};

/**
 * Finds the first structural violation of the Arc-host payload carrier grammar.
 * Numeric finiteness and semantic spec admission are separate checks.
 */
export function firstInvalidPayloadValue(
  value: unknown,
  path = "$",
): PayloadValueIssue | undefined {
  try {
    return firstInvalidPayloadValueShape(value, path, true);
  } catch {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload value shape could not be inspected",
    };
  }
}

function firstInvalidPayloadValueShape(
  value: unknown,
  path: string,
  allowUndefined: boolean,
): PayloadValueIssue | undefined {
  if (value === undefined) {
    return allowUndefined
      ? undefined
      : {
          path,
          code: "invalid-struct-value",
          detail: "nested payload values cannot be undefined",
        };
  }
  if (value === null) {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload values cannot be null",
    };
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return {
        path,
        code: "invalid-struct-value",
        detail: "payload arrays must use the ordinary Array prototype",
      };
    }
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return {
          path: `${path}[${index}]`,
          code: "invalid-struct-value",
          detail: "payload arrays must be dense enumerable data values",
        };
      }
      const issue = firstInvalidPayloadValueShape(
        descriptor.value,
        `${path}[${index}]`,
        false,
      );
      if (issue) return issue;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !Number.isSafeInteger(Number(key)) ||
        Number(key) < 0 ||
        String(Number(key)) !== key ||
        Number(key) >= value.length
      ) {
        return {
          path:
            typeof key === "string" ? `${path}[${JSON.stringify(key)}]` : path,
          code: "invalid-struct-value",
          detail: "payload arrays cannot contain non-element properties",
        };
      }
    }
    return undefined;
  }
  if (typeof value !== "object") {
    return {
      path,
      code: "invalid-struct-value",
      detail: `unsupported payload value type ${typeof value}`,
    };
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload struct shape could not be inspected",
    };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload structs must be plain objects",
    };
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      return {
        path,
        code: "invalid-struct-value",
        detail: "payload structs cannot contain symbol keys",
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return {
        path: `${path}[${JSON.stringify(key)}]`,
        code: "invalid-struct-value",
        detail: "payload struct fields must be enumerable data properties",
      };
    }
    const issue = firstInvalidPayloadValueShape(
      descriptor.value,
      `${path}[${JSON.stringify(key)}]`,
      false,
    );
    if (issue) return issue;
  }
  return undefined;
}

/** Validates and recursively clones an Arc-host payload carrier. */
export function clonePayloadValue(value: PayloadValue): PayloadValue {
  assertPayloadValue(value);
  if (Array.isArray(value)) return value.map((item) => clonePayloadValue(item));
  if (typeof value === "object") {
    return clonePayloadObject(value);
  }
  return value;
}

/** Validates and recursively clones one payload struct. */
export function clonePayloadObject(value: StructValue): StructValue {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clonePayloadValue(item)]),
  ) as StructValue;
}

/** Finds the canonical path of the first nested non-finite number. */
export function firstNonFiniteNumberPath(
  value: unknown,
  path = "$",
): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = firstNonFiniteNumberPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = firstNonFiniteNumberPath(
        (value as Record<string, unknown>)[key],
        `${path}[${JSON.stringify(key)}]`,
      );
      if (found) return found;
    }
  }
  return undefined;
}

/** Deep-clones an admitted carrier while canonicalizing negative zero. */
export function cloneWithCanonicalNumbers<T>(value: T): T {
  if (typeof value === "number") {
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneWithCanonicalNumbers(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneWithCanonicalNumbers(item),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Returns a cloned payload where `override` takes precedence over `base`.
 * Plain payload objects shallow-merge; every other override replaces the base.
 */
export function mergeAndClonePayload(
  base: PayloadValue,
  override: PayloadValue,
): PayloadValue {
  assertPayloadValue(base);
  assertPayloadValue(override);
  if (override === undefined) return clonePayloadValue(base);
  if (isPayloadObject(base) && isPayloadObject(override)) {
    return {
      ...clonePayloadObject(base),
      ...clonePayloadObject(override),
    };
  }
  return clonePayloadValue(override);
}

function isPayloadObject(value: PayloadValue): value is StructValue {
  return typeof value === "object" && !Array.isArray(value);
}

function assertPayloadValue(value: unknown): asserts value is PayloadValue {
  const issue = firstInvalidPayloadValue(value);
  if (issue) throw payloadValueError(issue);
}

function payloadValueError(issue: PayloadValueIssue): Error {
  return Object.assign(
    new Error(`Invalid payload value at ${issue.path}: ${issue.detail}`),
    { reasonCode: issue.code },
  );
}

/** Constructs an Artifact carrier after enforcing its concrete path invariant. */
export function createArtifactValue(path: string): ArtifactValue {
  const issue = classifyArtifactPath(path);
  if (issue !== undefined) {
    throw Object.assign(
      new Error(`Invalid Artifact path: ${describeArtifactPathIssue(issue)}`),
      { reasonCode: "invalid-artifact-path" },
    );
  }
  return { path };
}

/** Renders one Artifact path issue for a boundary-specific diagnostic. */
export function describeArtifactPathIssue(issue: ArtifactPathIssue): string {
  switch (issue) {
    case "non-string":
      return "path must be a string";
    case "empty":
      return "path cannot be empty";
    case "absolute":
      return "path must be relative";
    case "dot-segment":
      return 'path cannot contain "." or ".." segments';
  }
}

/** Renders one Artifact carrier issue for a boundary-specific diagnostic. */
export function describeArtifactValueIssue(issue: ArtifactValueIssue): string {
  switch (issue) {
    case "not-plain-object":
      return "value must be a plain object";
    case "invalid-keys":
      return "value must contain exactly path";
    case "invalid-properties":
      return "path must be an enumerable data property";
    default:
      return describeArtifactPathIssue(issue);
  }
}
