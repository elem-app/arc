/**
 * Public Arc type barrel spanning parser IR, runtime protocol, spec vocabulary,
 * and value carriers.
 */

export { validateHostModuleSpec } from "../spec/validation.js";
export * from "./host-interaction.js";
export * from "./ir.js";
export type * from "./runtime.js";
export {
  catchSegKey,
  hookSegKey,
  invokeSegKey,
  mapMemberSegKey,
  nodeSegKey,
  qualifiedBriefSite,
} from "./runtime.js";
export type {
  ArrayElementSpec,
  ArraySpec,
  ArtifactArraySpec,
  ArtifactSpec,
  CellSpec,
  ChannelSpec,
  DialogCursorSpec,
  HostModuleSpec,
  HostModuleSpecIssue,
  HostNamespaceSpec,
  HostOperationSpec,
  HostParameterSpec,
  HostParameterValueSpec,
  IndexSpec,
  LocalCellSpec,
  NumberObserveAsConstraint,
  ObservableArraySpec,
  ObservableCellSpec,
  ObservableElementSpec,
  ObservableFieldSpec,
  ScalarSpec,
  StructSpec,
  UnionSpec,
} from "./spec.js";
export type * from "./value.js";
export {
  classifyArtifactPath,
  classifyArtifactValue,
  isArtifactValue,
  isDialogCursorValue,
  isPrimitiveArrayValue,
  isPrimitiveValue,
} from "./value.js";
