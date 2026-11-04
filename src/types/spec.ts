/** Arc spec type vocabulary, basic guards, and structural conversions. */

/** Scalar constraints shared by cell and channel guarantees. */
export type ScalarValueSpec =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "enum"; values: string[] }
  | { type: "number" };

/** Guarantee declared by an Artifact cell or channel. */
export type ArtifactSpec = { type: "artifact" };

/**
 * Immediate element guarantees supported by Arc arrays: a scalar, an Artifact,
 * or a Struct whose every element is a complete record.
 */
export type ArrayElementSpec = ScalarValueSpec | ArtifactSpec | StructSpec;

/** Element guarantee of an array whose values may be semantically observed. */
export type ObservableElementSpec = ScalarValueSpec | StructSpec;

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
export type ArraySpec = ObservableArraySpec | ArtifactArraySpec;

/**
 * Named-field record guarantee whose fields are recursively observable. A
 * value carries exactly the declared fields, each with a concrete value.
 */
export type StructSpec = {
  type: "struct";
  fields: Record<string, ObservableFieldSpec>;
};

/** Guarantee declared by one field of an observable Struct. */
export type ObservableFieldSpec =
  | ScalarValueSpec
  | ObservableArraySpec
  | StructSpec;

/**
 * Guarantee declared by a semantically observable cell. A cell and a Struct
 * field admit the same observable guarantees.
 */
export type ObservableCellSpec = ObservableFieldSpec;

/** Guarantee declared by a dialog-cursor cell or channel. */
export type DialogCursorSpec = { type: "dialogCursor" };

/** Guarantee declared by a local-only cell. */
export type LocalCellSpec = DialogCursorSpec | ArtifactSpec;

/** Read/write guarantee declared by an Arc cell. */
export type CellSpec = ObservableCellSpec | ArtifactArraySpec | LocalCellSpec;

/** Read/write guarantee declared by an Arc channel. */
export type ChannelSpec =
  | ScalarValueSpec
  | ArtifactSpec
  | DialogCursorSpec
  | { type: "index" }
  | { type: "array"; element: ArrayElementSpec }
  | StructSpec;

/** Value guarantee accepted by a supplied host-operation argument. */
export type HostParameterValueSpec =
  | ScalarValueSpec
  | ArtifactSpec
  | DialogCursorSpec
  | { type: "index" }
  | { type: "array"; element: HostParameterValueSpec }
  | { type: "tuple"; elements: HostParameterValueSpec[] }
  | { type: "struct"; fields: Record<string, HostParameterSpec> }
  | { type: "semanticText" };

/** Required or omittable host parameter or named Struct field. */
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

export function isObservableCellSpec(
  spec: CellSpec,
): spec is ObservableCellSpec {
  return (
    spec.type !== "dialogCursor" &&
    spec.type !== "artifact" &&
    (spec.type !== "array" || spec.element.type !== "artifact")
  );
}

/** Whether a channel guarantee may declare a Struct field. */
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

/** Semantic spec-shape violation not excluded by the TypeScript union. */
export type SpecViolation = {
  code: "invalid-spec-shape" | "empty-enum" | "duplicate-enum-value";
  detail: string;
};

/** Projects a cell guarantee into the corresponding channel-shaped guarantee. */
export function cellSpecToChannelSpec(spec: CellSpec): ChannelSpec {
  switch (spec.type) {
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

/**
 * A Struct shape whose fields belong to one field family `F`. A family is
 * closed under nesting when each of its Struct members is itself a
 * `StructShape<F>`, as for guarantees and for authored declarations.
 */
export type StructShape<F> = { type: "struct"; fields: Record<string, F> };

/**
 * Resolves the field a non-empty path names inside a Struct. `asStruct`
 * exposes a field as a nested Struct of the same family, or returns
 * `undefined` for a non-Struct field, so a field at any depth keeps the
 * receiver's family.
 */
export function fieldAtPath<F>(
  struct: StructShape<F>,
  path: readonly string[],
  asStruct: (field: F) => StructShape<F> | undefined,
): F | undefined {
  let fields = struct.fields;
  let field: F | undefined;
  for (const [depth, name] of path.entries()) {
    if (depth > 0) {
      const nested = asStruct(field!);
      if (!nested) return undefined;
      fields = nested.fields;
    }
    if (!Object.hasOwn(fields, name)) return undefined;
    field = fields[name]!;
  }
  return field;
}

/** Resolves the guarantee of a non-empty field path inside a Struct. */
export function fieldSpecAt(
  spec: StructSpec,
  path: readonly string[],
): ObservableFieldSpec | undefined {
  return fieldAtPath(spec, path, (field) =>
    field.type === "struct" ? field : undefined,
  );
}

/** Projects a Struct declaration into its bare recursive value guarantee. */
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

/** Projects one Struct field declaration into its bare value guarantee. */
export function fieldSpecOf(spec: ObservableFieldSpec): ObservableFieldSpec {
  switch (spec.type) {
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
  return spec.type === "struct" ? structSpecOf(spec) : scalarSpecOf(spec);
}

function scalarSpecOf(spec: ScalarValueSpec): ScalarValueSpec {
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
