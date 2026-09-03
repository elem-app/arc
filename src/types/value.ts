/** Arc value-carrier types and their canonical runtime guards. */

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

/** Element carriers stored by one-level Arc arrays. */
export type ArrayElementValue = PrimitiveValue | ArtifactValue;

/** One-level ordered carrier stored by Arc cells and channels. */
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
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
  // Included for the future addition of the `Struct()` cell type.
  | StructValue;

/** One segment inside host-facing rendered semantic text. */
export type SemanticTextPart =
  | { kind: "text"; value: string }
  | { kind: "entity"; name: "user" | "self" }
  | { kind: "artifact"; path: string }
  | { kind: "hostVar"; module: string; path: string[] };

/** Host-facing rendered semantic text with deferred host-rendered references. */
export type SemanticText = string | SemanticTextPart[];

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "not-plain-object";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "not-plain-object";
  }
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
