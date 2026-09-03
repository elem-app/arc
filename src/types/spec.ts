/** Arc spec type vocabulary, basic guards, and structural conversions. */

/** Scalar constraints shared by cell and channel guarantees. */
export type ScalarValueSpec =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "enum"; values: string[] }
  | { type: "number" };

/** Guarantee declared by an Artifact cell or channel. */
export type ArtifactSpec = { type: "artifact" };

/** Immediate element guarantees supported by one-level Arc arrays. */
export type ArrayElementSpec = ScalarValueSpec | ArtifactSpec;

/** One-level array guarantee whose values may be semantically observed. */
export type ObservableArraySpec = {
  type: "array";
  element: ScalarValueSpec;
};

/** One-level stored Artifact-array guarantee. */
export type ArtifactArraySpec = {
  type: "array";
  element: ArtifactSpec;
};

/** One-level authored array guarantee. */
export type ArraySpec = ObservableArraySpec | ArtifactArraySpec;

/** Guarantee declared by a semantically observable cell. */
export type ObservableCellSpec = ScalarValueSpec | ObservableArraySpec;

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
  | { type: "array"; element: ArrayElementSpec };

/** Value guarantee accepted by one host-operation parameter. */
export type HostParameterSpec =
  | ScalarValueSpec
  | ArtifactSpec
  | DialogCursorSpec
  | { type: "index" }
  | { type: "array"; element: HostParameterSpec }
  | { type: "tuple"; elements: HostParameterSpec[] }
  | { type: "semanticText" };

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
  }
}

function arrayElementSpecToChannelSpec(
  spec: ArrayElementSpec,
): ArrayElementSpec {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "number":
      return { type: "number" };
    case "artifact":
      return { type: "artifact" };
  }
}
