/** Arc spec type vocabulary, basic guards, and structural conversions. */

import { fieldAtPath, type StructShape, type UnionShape } from "./shape.js";

/** Numeric constraints applied only when accepting an observation result. */
export type NumberObserveAsConstraint =
  | { kind: "number"; min?: number; max?: number }
  | { kind: "integer"; min?: number; max?: number };

/** Scalar constraints shared by cell and channel guarantees. */
export type ScalarSpec =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "enum"; values: string[] }
  | { type: "number"; observeAs?: NumberObserveAsConstraint };

/** Ordered scalar alternatives eligible at an observable value position. */
export type UnionSpec = UnionShape<ScalarSpec>;

/** Whether a spec may be a union member. */
export function isUnionMemberSpec(spec: {
  type?: unknown;
}): spec is ScalarSpec {
  return (
    spec.type === "boolean" ||
    spec.type === "string" ||
    spec.type === "enum" ||
    spec.type === "number"
  );
}

/** Guarantee declared by an Artifact cell or channel. */
export type ArtifactSpec = { type: "artifact" };

/** Non-negative integer guarantee declared by an `Index()` channel. */
export type IndexSpec = { type: "index" };

/** Guarantee declared by a dialog-cursor cell or channel. */
export type DialogCursorSpec = { type: "dialogCursor" };

/**
 * Immediate element guarantees supported by Arc arrays: scalar, union, Artifact,
 * or struct. Every struct element is a complete record.
 */
export type ArrayElementSpec =
  | ScalarSpec
  | UnionSpec
  | ArtifactSpec
  | StructSpec;

/** Element guarantee of an array whose values may be semantically observed. */
export type ObservableElementSpec = ScalarSpec | UnionSpec | StructSpec;

/** Array guarantee whose values may be semantically observed. */
export type ObservableArraySpec = {
  type: "array";
  element: ObservableElementSpec;
};

/** One-level stored Artifact-array guarantee. */
export type ArtifactArraySpec = {
  type: "array";
  element: ArtifactSpec;
};

/** Authored array guarantee. */
export type ArraySpec = {
  type: "array";
  element: ArrayElementSpec;
};

/**
 * Named-field record guarantee whose fields are recursively observable. A
 * value carries exactly the declared fields, each with a concrete value.
 */
export type StructSpec = StructShape<ObservableFieldSpec>;

/**
 * Guarantee declared by a semantically observable cell.
 */
export type ObservableCellSpec =
  | ScalarSpec
  | UnionSpec
  | ObservableArraySpec
  | StructSpec;

/**
 * Guarantee declared by one field of an observable struct. A cell and a struct
 * field admit the same observable guarantees.
 */
export type ObservableFieldSpec = ObservableCellSpec;

/** Guarantee declared by a local-only cell. */
export type LocalCellSpec = DialogCursorSpec | ArtifactSpec;

/** Read/write guarantee declared by an Arc cell. */
export type CellSpec = ObservableCellSpec | ArtifactArraySpec | LocalCellSpec;

/** Read/write guarantee declared by an Arc channel. */
export type ChannelSpec =
  | ScalarSpec
  | UnionSpec
  | ArtifactSpec
  | DialogCursorSpec
  | IndexSpec
  | ArraySpec
  | StructSpec;

/** Value guarantee accepted by a supplied host-operation argument. */
export type HostParameterValueSpec =
  | ScalarSpec
  | UnionSpec
  | ArtifactSpec
  | DialogCursorSpec
  | IndexSpec
  | { type: "array"; element: HostParameterValueSpec }
  | { type: "tuple"; elements: HostParameterValueSpec[] }
  | StructShape<HostParameterSpec>
  | { type: "semanticText" };

/** Required or omittable host parameter or named struct field. */
export type HostParameterSpec =
  | HostParameterValueSpec
  | { type: "omittable"; spec: HostParameterValueSpec };

/** Callable member selected by an authored host action. */
export type HostOperationSpec = {
  kind: "operation";
  parameters: HostParameterSpec[];
  returns?: ChannelSpec;
};

/** Nested namespace within a host module. */
export type HostNamespaceSpec = {
  kind: "namespace";
  members: Record<string, HostOperationSpec | HostNamespaceSpec>;
};

/** Normalized callable surface of one injected `host:*` module. */
export type HostModuleSpec = HostNamespaceSpec;

/** Exact normalized host-module shape violation. */
export type HostModuleSpecIssue = {
  code: "invalid-host-module-spec";
  path: string;
  detail: string;
};

/** Semantic spec-shape violation not excluded by the TypeScript union. */
export type SpecViolation = {
  code: "invalid-spec-shape" | "empty-enum" | "duplicate-enum-value";
  detail: string;
};

export function isObservableCellSpec(
  spec: CellSpec,
): spec is ObservableCellSpec {
  return (
    spec.type !== "dialogCursor" &&
    spec.type !== "artifact" &&
    (spec.type !== "array" || spec.element.type !== "artifact")
  );
}

/** Whether a channel guarantee may declare a struct field. */
export function isObservableFieldSpec(
  spec: ChannelSpec,
): spec is ObservableFieldSpec {
  switch (spec.type) {
    case "artifact":
    case "dialogCursor":
    case "index":
      return false;
    case "array":
      return spec.element.type !== "artifact";
    default:
      return true;
  }
}

export function isSettableCellSpec(spec: CellSpec): boolean {
  return (
    isObservableCellSpec(spec) ||
    spec.type === "array" ||
    spec.type === "dialogCursor" ||
    spec.type === "artifact"
  );
}

/** Projects a cell guarantee into the corresponding channel-shaped guarantee. */
export function cellSpecToChannelSpec(spec: CellSpec): ChannelSpec {
  switch (spec.type) {
    case "union":
      return unionSpecOf(spec);
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "number":
      return { type: "number" };
    case "dialogCursor":
      return { type: "dialogCursor" };
    case "artifact":
      return { type: "artifact" };
    case "array":
      return {
        type: "array",
        element: arrayElementSpecToChannelSpec(spec.element),
      };
    case "struct":
      return structSpecOf(spec);
  }
}

/** Resolves the guarantee of a non-empty field path inside a struct. */
export function fieldSpecAt(
  spec: StructSpec,
  path: readonly string[],
): ObservableFieldSpec | undefined {
  return fieldAtPath(spec, path, (field) =>
    field.type === "struct" ? field : undefined,
  );
}

/** Projects a struct declaration into its bare recursive value guarantee. */
export function structSpecOf(spec: StructSpec): StructSpec {
  return {
    type: "struct",
    fields: Object.fromEntries(
      Object.entries(spec.fields).map(([name, field]) => [
        name,
        fieldSpecOf(field),
      ]),
    ),
  };
}

/** Projects one struct field declaration into its bare value guarantee. */
export function fieldSpecOf(spec: ObservableFieldSpec): ObservableFieldSpec {
  switch (spec.type) {
    case "union":
      return unionSpecOf(spec);
    case "struct":
      return structSpecOf(spec);
    case "array":
      return { type: "array", element: observableElementSpecOf(spec.element) };
    default:
      return scalarSpecOf(spec);
  }
}

function arrayElementSpecToChannelSpec(
  spec: ArrayElementSpec,
): ArrayElementSpec {
  return spec.type === "artifact"
    ? { type: "artifact" }
    : observableElementSpecOf(spec);
}

function observableElementSpecOf(
  spec: ObservableElementSpec,
): ObservableElementSpec {
  return spec.type === "struct"
    ? structSpecOf(spec)
    : spec.type === "union"
      ? unionSpecOf(spec)
      : scalarSpecOf(spec);
}

function unionSpecOf(spec: UnionSpec): UnionSpec {
  return { type: "union", members: spec.members.map(scalarSpecOf) };
}

function scalarSpecOf(spec: ScalarSpec): ScalarSpec {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "number":
      return { type: "number" };
  }
}
