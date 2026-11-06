/** Arc value-carrier types and their guards, validation, and cloning. */

/** Whether a value is a plain or null-prototype object record. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Scalar carrier shared by Arc expressions, typed slots, and host payloads. */
export type PrimitiveValue = string | number | boolean;

export function isPrimitiveValue(value: unknown): value is PrimitiveValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** One-level ordered primitive carrier used by observation and rendering. */
export type PrimitiveArrayValue = PrimitiveValue[];

export function isPrimitiveArrayValue(
  value: unknown,
): value is PrimitiveArrayValue {
  return Array.isArray(value) && value.every(isPrimitiveValue);
}

/**
 * Exact `{ path }` carrier used under Artifact authority. Shape alone does not
 * select that authority.
 */
export type ArtifactValue = {
  readonly path: string;
};

/** Concrete invariant violated by an Artifact path. */
export type ArtifactPathIssue =
  | "non-string"
  | "empty"
  | "absolute"
  | "dot-segment";

/** Concrete carrier or path invariant violated by an Artifact value. */
export type ArtifactValueIssue =
  | "not-plain-object"
  | "invalid-keys"
  | "invalid-properties"
  | ArtifactPathIssue;

/** Classifies an Artifact path without constructing a value. */
export function classifyArtifactPath(
  path: unknown,
): ArtifactPathIssue | undefined {
  if (typeof path !== "string") return "non-string";
  if (path.length === 0) return "empty";
  if (path.startsWith("/")) return "absolute";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "dot-segment";
  }
  return undefined;
}

/** Validates the exact concrete carrier required under Artifact authority. */
export function classifyArtifactValue(
  value: unknown,
): ArtifactValueIssue | undefined {
  try {
    return classifyArtifactValueShape(value);
  } catch {
    return "not-plain-object";
  }
}

function classifyArtifactValueShape(
  value: unknown,
): ArtifactValueIssue | undefined {
  if (!isPlainRecord(value)) return "not-plain-object";
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || !keys.includes("path")) return "invalid-keys";
  const path = Object.getOwnPropertyDescriptor(value, "path");
  if (!path || !("value" in path) || !path.enumerable) {
    return "invalid-properties";
  }
  return classifyArtifactPath(path.value);
}

/** Carrier-shape guard; callers still need separate Artifact authority. */
export function isArtifactValue(value: unknown): value is ArtifactValue {
  return classifyArtifactValue(value) === undefined;
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

/** Element carriers stored by Arc arrays. */
export type ArrayElementValue = PrimitiveValue | ArtifactValue | StructValue;

/** Ordered carrier stored by Arc cells and channels. */
export type ArrayValue = ArrayElementValue[];

/** Recursively nested object carrier in an Arc-host payload. */
export type StructValue = {
  readonly [key: string]: PayloadValue;
};

/**
 * TypeScript representation of values passed across the Arc-host boundary.
 * Runtime carrier shape, numeric durability, and consumer-specific constraints
 * are validated separately.
 */
export type PayloadValue =
  | PrimitiveValue
  | undefined
  | PayloadValue[]
  | StructValue;

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

/** Carrier of a struct record, keyed by field name. */
export type ObservedStructValue = { [field: string]: ObservedValue };

/**
 * Carrier of an observable position's value across the brief/report boundary:
 * a scalar, a scalar list, a struct record keyed by field name, or a list of
 * records. Admission under the position's spec establishes that each record
 * carries exactly its declared fields.
 */
export type ObservedValue =
  | PrimitiveValue
  | PrimitiveArrayValue
  | ObservedStructValue
  | ObservedStructValue[];

/**
 * Opaque dialog turn coordinate supplied by the host for the scoped visible
 * dialog. A cursor is bound to the view it was read from: `view` is stamped at
 * read time from the supplied dialog's `view`, travels with stored snapshots,
 * and only cursors of the same view are comparable. An absent `view` is the
 * host's default view.
 */
export type DialogCursor = {
  user: number;
  self: number;
  view?: string;
};

export function isDialogCursorValue(value: unknown): value is DialogCursor {
  try {
    if (!isPlainRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "user" && key !== "self" && key !== "view"),
      ) ||
      !keys.includes("user") ||
      !keys.includes("self")
    ) {
      return false;
    }
    const fields = Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]),
    );
    const user = fields.user;
    const self = fields.self;
    const view = fields.view;
    if (
      !user ||
      !self ||
      !("value" in user) ||
      !("value" in self) ||
      !user.enumerable ||
      !self.enumerable ||
      (view && (!("value" in view) || !view.enumerable))
    ) {
      return false;
    }
    return (
      Number.isSafeInteger(user.value) &&
      Number.isSafeInteger(self.value) &&
      user.value >= 0 &&
      self.value >= 0 &&
      (!view || view.value === undefined || typeof view.value === "string")
    );
  } catch {
    return false;
  }
}

/**
 * Carrier shapes usable in typed Arc value slots. A slot's spec supplies the
 * read/write guarantee; membership in this union does not.
 */
export type CellValue =
  | PrimitiveValue
  | ArtifactValue
  | DialogCursor
  | ArrayValue
  | StructValue;

/** One segment inside host-facing rendered semantic text. */
export type SemanticTextPart =
  | { kind: "text"; value: string }
  | { kind: "entity"; name: "user" | "self" }
  | { kind: "artifact"; path: string }
  | { kind: "hostVar"; module: string; path: string[] };

/** Host-facing rendered semantic text with deferred host-rendered references. */
export type SemanticText = string | SemanticTextPart[];

/** Validates the carrier shape of rendered host-facing semantic text. */
export function isRenderedSemanticText(value: unknown): value is SemanticText {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    switch (record.kind) {
      case "text":
        return (
          hasExactKeys(record, ["kind", "value"]) &&
          typeof record.value === "string"
        );
      case "entity":
        return (
          hasExactKeys(record, ["kind", "name"]) &&
          (record.name === "user" || record.name === "self")
        );
      case "artifact":
        return (
          hasExactKeys(record, ["kind", "path"]) &&
          typeof record.path === "string" &&
          classifyArtifactPath(record.path) === undefined
        );
      case "hostVar":
        return (
          hasExactKeys(record, ["kind", "module", "path"]) &&
          typeof record.module === "string" &&
          record.module.length > 0 &&
          Array.isArray(record.path) &&
          record.path.length > 0 &&
          record.path.every(
            (segment: unknown) =>
              typeof segment === "string" && segment.length > 0,
          )
        );
      default:
        return false;
    }
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** A single conversation turn with role attribution. */
export type DialogTurn = {
  role: "self" | "user";
  message: string;
};

/** Host-supplied dialog projection for one runtime operation. */
export type Dialog = {
  lastTurns: DialogTurn[];
  cursor: DialogCursor;
  /** The host-projected view associated with the supplied dialog. */
  view?: string;
};
