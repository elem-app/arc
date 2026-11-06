import {
  acceptsHostArgumentCount,
  hostParameterValueSpec,
} from "../spec/host-parameters.js";
import {
  admitHostArgument,
  admitValue,
  arithmeticRule,
  artifactPathRule,
  booleanRule,
  comparisonRule,
  fmtRule,
  interpolationRule,
  numIsFiniteRule,
  producerGuaranteesArtifact,
  resolveHostOperation,
  resolveProducer,
  resolveReferenceSpec,
  stringOperandRule,
  type ProducerContext,
} from "../spec/resolution.js";
import { fieldValueAt } from "../spec/struct.js";
import type {
  HostCallBrief,
  ObservationGroupField,
  ObservationMeta,
  ScalarObservationMeta,
  StructObservationField,
  StructObservationMeta,
  UnionObservationMeta,
} from "../types/host-interaction.js";
import type {
  ActionStatement,
  ArithmeticOperator,
  ArrayCell,
  ArrayElementRead,
  ArrayReference,
  ArtifactConstructExpression,
  Cell,
  CellTarget,
  ComparisonOperator,
  ElementId,
  EnterTarget,
  FieldReceiver,
  FieldReference,
  HostCall,
  HostCallArgument,
  JudgeExpression,
  LocalExpression,
  Node,
  Observable,
  ObservableScalar,
  ObservableStruct,
  ObservableUnion,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  SemanticString,
  SetAction,
  UnsetAction,
  ValueExpression,
} from "../types/ir.js";
import { fieldDeclarationAt, isSettableCell } from "../types/ir.js";
import {
  isArcRef,
  qualifiedBriefSite,
  type ArcRef,
  type NodeRef,
  type NodeState,
  type Traversal,
} from "../types/runtime.js";
import type {
  ArrayElementSpec,
  CellSpec,
  ChannelSpec,
  ObservableFieldSpec,
} from "../types/spec.js";
import { fieldSpecAt, isObservableCellSpec } from "../types/spec.js";
import {
  classifyArtifactValue,
  clonePayloadValue,
  cloneWithCanonicalNumbers,
  createArtifactValue,
  describeArtifactValueIssue,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
  isArtifactValue,
  isPlainRecord,
  type ArrayElementValue,
  type ArrayValue,
  type ArtifactValue,
  type CellValue,
  type DialogCursor,
  type ObservedValue,
  type PayloadValue,
  type SemanticText,
  type SemanticTextPart,
  type StructValue,
} from "../types/value.js";
import {
  assertAssignableChannelValue,
  isDialogCursorValue,
} from "./channel-values.js";
import {
  beginPinForElement,
  beginValuePin,
  completeValuePin,
  settleHostCallPin,
  settleJudgmentPin,
} from "./pins.js";
import {
  arcToNodeRef,
  findTraversalInSet,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  lexicalParentRef,
  resolveLexicalRef,
  traversalToNodeRef,
} from "./refs.js";
import { runtimeError } from "./report-validation.js";
import {
  briefSiteQualifiers,
  cellValuesEqual,
  childState,
  cloneCellValue,
  cloneDialogCursor,
  cloneHostCallBrief,
  makeHostCallId,
  makeJudgeId,
  makeObservationGroupId,
  makeObservationId,
  noteBriefYield,
  payloadValuesEqual,
  type Accumulator,
} from "./state.js";

export type ActionOutcome<T = undefined> =
  | { status: "resolved"; value: T }
  | { status: "blocked" };

type ResolvedCellTarget = {
  ownerTraversal: Traversal;
  root: string;
  rootCell: Cell;
  /** Struct field names and array indices below the root, outermost first. */
  path: (string | number)[];
  leaf: CellTargetLeaf;
  label: string;
  /** Stored value at the target, or `undefined` when it is unset. */
  state: PayloadValue;
};

/**
 * Parser IR of the position a cell target selects: the root cell, a struct
 * field, or an array element.
 */
type CellTargetLeaf = Cell | Observable | ArrayCell["element"];

function formatAuthoredCellTarget(target: CellTarget): string {
  const [root, ...accessors] = target;
  return `${root}${accessors.map(() => "[...]").join("")}`;
}

/**
 * Resolves a lexical cell target against the live traversal state. A struct
 * accessor selects a declared field from the schema and requires a set struct.
 * Array accessors evaluate through the ordinary local-expression path, so
 * non-literal indices are pinned by the containing statement's pin tape, and
 * require a set array. An unset container fails here, before the action
 * evaluates its value or emits a brief.
 */
function resolveCellTarget(
  target: CellTarget,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<ResolvedCellTarget> {
  const [root, ...accessors] = target;
  const owner = findCellOwner(root, traversal, accum);
  if (!owner) {
    throw runtimeError(
      "unknown-cell",
      `Unknown cell target: ${formatAuthoredCellTarget(target)}`,
    );
  }

  let leaf: CellTargetLeaf = owner.cell;
  let state: PayloadValue = owner.traversal.cells[root];
  const path: (string | number)[] = [];
  let label = root;
  for (const accessor of accessors) {
    if (leaf.type === "struct") {
      const name =
        accessor.kind === "literal" && typeof accessor.value === "string"
          ? accessor.value
          : undefined;
      if (name === undefined || !Object.hasOwn(leaf.fields, name)) {
        throw runtimeError(
          "invalid-cell-target",
          `Cell target ${label} names an undeclared Struct field`,
        );
      }
      if (!isPlainRecord(state)) {
        throw runtimeError(
          "unset-value",
          `Cannot access a field of unset Struct ${label}`,
        );
      }
      path.push(name);
      label += `.${name}`;
      state = state[name];
      leaf = leaf.fields[name]!;
      continue;
    }
    if (leaf.type !== "array") {
      throw runtimeError(
        "invalid-cell-target",
        `Cell target ${label} accesses through a non-container value`,
      );
    }
    if (state === undefined) {
      throw runtimeError(
        "unset-value",
        `Cannot access an element of unset array ${label}`,
      );
    }
    if (!Array.isArray(state)) {
      throw runtimeError(
        "invalid-array-operation",
        `Cannot access an element of non-array target ${label}`,
      );
    }
    const resolvedAccessor = evaluateLocalExpression(
      accessor,
      traversal,
      node,
      accum,
    );
    if (resolvedAccessor.status === "blocked") return resolvedAccessor;
    const position = resolvedAccessor.value;
    if (
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 0
    ) {
      throw runtimeError(
        "invalid-array-index",
        `Array index must be a non-negative integer, got ${String(position)}`,
      );
    }
    if (position >= state.length) {
      throw runtimeError(
        "array-index-out-of-range",
        `Array index ${position} is out of range for length ${state.length}`,
      );
    }
    path.push(position);
    label += `[${position}]`;
    state = state[position];
    leaf = leaf.element;
  }

  return {
    status: "resolved",
    value: {
      ownerTraversal: owner.traversal,
      root,
      rootCell: owner.cell,
      path,
      leaf,
      label,
      state,
    },
  };
}

/**
 * Returns new root state with the position at `path` replaced by an admitted
 * `value`. Struct siblings and array siblings are preserved. Every container on
 * the path must be set, because a write never leaves a composite incomplete.
 * The input state is never mutated.
 */
function replaceRootState(
  rootCell: Cell,
  state: CellValue | undefined,
  path: readonly (string | number)[],
  value: CellValue,
  label: string,
): CellValue {
  // Each position keeps the shape of its declaration and the replaced leaf was
  // admitted under its own spec, so the rebuilt root is a value of the root
  // cell's declaration.
  return replaceTargetState(rootCell, state, path, value, label) as CellValue;
}

function replaceTargetState(
  spec: Cell | Observable | ArrayElementSpec,
  state: PayloadValue,
  path: readonly (string | number)[],
  value: CellValue,
  label: string,
): PayloadValue {
  const [segment, ...rest] = path;
  if (segment === undefined) return clonePayloadValue(value);
  if (typeof segment === "string") {
    if (spec.type !== "struct" || !Object.hasOwn(spec.fields, segment)) {
      throw new Error(
        `Internal invariant: ${label} descends through an undeclared Struct field`,
      );
    }
    if (!isPlainRecord(state)) {
      throw runtimeError(
        "unset-value",
        `Cannot write field target ${label} because its Struct is not set`,
      );
    }
    return {
      ...state,
      [segment]: replaceTargetState(
        spec.fields[segment]!,
        state[segment],
        rest,
        value,
        label,
      ),
    };
  }
  if (spec.type !== "array") {
    throw new Error(
      `Internal invariant: ${label} indexes a non-array declaration`,
    );
  }
  if (!Array.isArray(state)) {
    throw runtimeError(
      state === undefined ? "unset-value" : "invalid-array-operation",
      `Cannot write element target ${label} because its array is not set`,
    );
  }
  if (segment >= state.length) {
    throw runtimeError(
      "array-index-out-of-range",
      `Array index ${segment} is out of range for length ${state.length}`,
    );
  }
  const next = state.map(clonePayloadValue);
  next[segment] = replaceTargetState(
    spec.element,
    state[segment],
    rest,
    value,
    label,
  );
  return next;
}

/**
 * Validates and writes one complete concrete value at a resolved target. A
 * struct root or subtree is replaced as a whole, and a field write replaces one
 * field of a set struct.
 */
function writeResolvedCellTarget(
  target: ResolvedCellTarget,
  value: unknown,
): { changed: boolean } {
  assertAssignableValue(target.label, target.leaf, value);
  return writeOwnedCell(
    target.ownerTraversal,
    target.root,
    replaceRootState(
      target.rootCell,
      target.ownerTraversal.cells[target.root],
      target.path,
      value,
      target.label,
    ),
  );
}

/**
 * Validates and writes one complete concrete value at a cell or at a declared
 * struct field path of that cell, preserving the field's siblings. A field
 * path requires a set struct; the replacement path checks it.
 */
export function writeOwnedCellPath(
  ownerTraversal: Traversal,
  rootCell: Cell,
  path: readonly string[],
  value: unknown,
): { changed: boolean } {
  const leaf =
    path.length === 0
      ? rootCell
      : rootCell.type === "struct"
        ? fieldDeclarationAt(rootCell, path)
        : undefined;
  const label = [rootCell.name, ...path].join(".");
  if (!leaf) {
    throw runtimeError(
      "invalid-cell-target",
      `Cell target ${label} names an undeclared Struct field`,
    );
  }
  return writeResolvedCellTarget(
    {
      ownerTraversal,
      root: rootCell.name,
      rootCell,
      path: [...path],
      leaf,
      label,
      state: undefined,
    },
    value,
  );
}

/**
 * The privately owned current value of an observation target, or `undefined`
 * when it is unset.
 */
function storedObservedValue(state: PayloadValue): ObservedValue | undefined {
  // Stored state at an observable position was admitted under its spec, so a
  // set position holds an observed value.
  return clonePayloadValue(state) as ObservedValue | undefined;
}

export function applyObserve(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  const targetResult = resolveCellTarget(
    statement.target,
    traversal,
    node,
    accum,
  );
  if (targetResult.status === "blocked") return targetResult;
  const target = targetResult.value;
  const observable = requireObservableTarget(target);

  const workId = makeObservationId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
  );
  const resolution = accum.observationResults.get(workId);

  if (resolution) {
    if (resolution.status === "resolved") {
      return {
        status: "resolved",
        value: writeResolvedCellTarget(target, resolution.value),
      };
    }
    if (statement.kind === "observe" && resolution.status !== "needs-user") {
      return { status: "resolved", value: { changed: false } };
    }
    return { status: "blocked" };
  }

  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.observations.push({
      kind: "observation",
      id: workId,
      sourceRef: traversalToNodeRef(traversal),
      cell: target.label,
      mode: statement.kind,
      question:
        statement.question !== undefined
          ? renderSemanticText(statement.question, traversal, node, accum)
          : renderCellObservingQuestion(
              observable,
              target.label,
              traversal,
              node,
              accum,
            ),
      guidance: renderNodeGuidance(traversal, node, accum),
      currentValue: storedObservedValue(target.state),
      hostParams: admitFinitePayload(
        effectiveHostParams(node, accum),
        "host-bound emission",
      ),
      meta: observationMetaForTarget(
        observable,
        target.label,
        traversal,
        node,
        accum,
      ),
    });
  }
  return { status: "blocked" };
}

/**
 * Applies a grouped observation `$observe({ a, b })` as one atomic action. On
 * the plan phase it emits a single `ObservationGroupBrief` carrying every
 * member's question and type metadata. On resolution it applies one report
 * that addresses every member: plain observation writes every resolved
 * member together and settles; `$observeOrAsk` writes and settles only when
 * every member resolves, and otherwise writes nothing and re-emits the whole
 * group.
 */
export function applyObserveGroup(
  statement: ObserveGroupAction | ObserveOrAskGroupAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  const mode = statement.kind === "observeGroup" ? "observe" : "observeOrAsk";
  const targets: {
    target: ResolvedCellTarget;
    observable: Observable;
  }[] = [];
  for (const authoredTarget of statement.targets) {
    const result = resolveCellTarget(authoredTarget, traversal, node, accum);
    if (result.status === "blocked") return result;
    targets.push({
      target: result.value,
      observable: requireObservableTarget(result.value),
    });
  }
  const workId = makeObservationGroupId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
  );
  const resolution = accum.observationGroupResults.get(workId);

  if (resolution) {
    const members = targets.map(({ target }) => {
      const member = resolution.fields[target.label];
      if (!member) {
        throw new Error(
          `Internal invariant: admitted group report omits ${target.label}`,
        );
      }
      return { target, member };
    });
    if (
      members.some(({ member }) =>
        mode === "observeOrAsk"
          ? member.status !== "resolved"
          : member.status === "needs-user",
      )
    ) {
      return { status: "blocked" };
    }
    const writes: { target: ResolvedCellTarget; value: ObservedValue }[] = [];
    for (const { target, member } of members) {
      if (member.status !== "resolved") continue;
      assertAssignableValue(target.label, target.leaf, member.value);
      writes.push({ target, value: member.value });
    }
    let changed = false;
    for (const write of writes) {
      const wrote = writeResolvedCellTarget(write.target, write.value);
      changed = changed || wrote.changed;
    }
    return { status: "resolved", value: { changed } };
  }

  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    const fields: ObservationGroupField[] = targets.map(
      ({ target, observable }) => {
        return {
          cell: target.label,
          question: renderCellObservingQuestion(
            observable,
            target.label,
            traversal,
            node,
            accum,
          ),
          currentValue: storedObservedValue(target.state),
          meta: observationMetaForTarget(
            observable,
            target.label,
            traversal,
            node,
            accum,
          ),
        };
      },
    );
    accum.observations.push({
      kind: "observation-group",
      id: workId,
      sourceRef: traversalToNodeRef(traversal),
      mode,
      guidance: renderNodeGuidance(traversal, node, accum),
      hostParams: admitFinitePayload(
        effectiveHostParams(node, accum),
        "host-bound emission",
      ),
      fields,
    });
  }
  return { status: "blocked" };
}

/**
 * Requires the resolved leaf to be observable.
 */
function requireObservableTarget(target: ResolvedCellTarget): Observable {
  const leaf = target.leaf;
  if (!isObservableCellSpec(leaf)) {
    throw runtimeError(
      "invalid-observation-target",
      `$observe() cannot target ${target.label}`,
    );
  }
  return leaf;
}

/**
 * The extraction question authored on a target: its own `observing` for a
 * scalar or struct, or the element's `observing` for an array.
 */
function cellObservingText(observable: Observable): SemanticString | undefined {
  return observable.type === "array"
    ? observable.element.observing
    : observable.observing;
}

/** Observation metadata for a scalar target or element, with its `observeAs` bounds. */
function scalarMetaOf(observable: ObservableScalar): ScalarObservationMeta {
  switch (observable.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: observable.values };
    case "number":
      if (observable.observeAs?.kind === "integer") {
        return {
          type: "rangedInt",
          min: observable.observeAs.min ?? Number.MIN_SAFE_INTEGER,
          max: observable.observeAs.max ?? Number.MAX_SAFE_INTEGER,
        };
      }
      return {
        type: "number",
        ...(observable.observeAs?.min !== undefined
          ? { min: observable.observeAs.min }
          : {}),
        ...(observable.observeAs?.max !== undefined
          ? { max: observable.observeAs.max }
          : {}),
      };
  }
}

/** Preserves the ordered constraints for one union observation. */
function unionMetaOf(observable: ObservableUnion): UnionObservationMeta {
  return { type: "union", members: observable.members.map(scalarMetaOf) };
}

/**
 * Observation value metadata for a scalar, union, array, or struct target. A struct
 * describes every declared field recursively with its rendered question.
 */
function observationMetaForTarget(
  observable: Observable,
  label: string,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ObservationMeta {
  if (observable.type === "array") {
    return {
      type: "array",
      element:
        observable.element.type === "struct"
          ? structMetaOf(
              observable.element,
              `${label}[]`,
              traversal,
              node,
              accum,
            )
          : observable.element.type === "union"
            ? unionMetaOf(observable.element)
            : scalarMetaOf(observable.element),
    };
  }
  if (observable.type === "struct") {
    return structMetaOf(observable, label, traversal, node, accum);
  }
  return observable.type === "union"
    ? unionMetaOf(observable)
    : scalarMetaOf(observable);
}

/**
 * Observation metadata for a struct target or struct array element: every
 * declared field with its rendered question and type metadata.
 */
function structMetaOf(
  observable: ObservableStruct,
  label: string,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): StructObservationMeta {
  return {
    type: "struct",
    fields: Object.fromEntries(
      Object.entries(observable.fields).map(([name, field]) => {
        const fieldLabel = `${label}.${name}`;
        const entry: StructObservationField = {
          question: renderCellObservingQuestion(
            field,
            fieldLabel,
            traversal,
            node,
            accum,
          ),
          meta: observationMetaForTarget(
            field,
            fieldLabel,
            traversal,
            node,
            accum,
          ),
        };
        return [name, entry];
      }),
    ),
  };
}

/** Renders a target's own `observing` question, or a default when it declares none. */
function renderCellObservingQuestion(
  observable: Observable,
  targetLabel: string,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText {
  const observing = cellObservingText(observable);
  if (observing === undefined) return `observe ${targetLabel}`;
  return renderSemanticText(observing, traversal, node, accum);
}

export function applySet(
  statement: SetAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  const targetResult = resolveCellTarget(
    statement.target,
    traversal,
    node,
    accum,
  );
  if (targetResult.status === "blocked") return targetResult;
  const target = targetResult.value;
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
  );
  if (value.status === "blocked") return { status: "blocked" };
  return {
    status: "resolved",
    value: writeResolvedCellTarget(target, value.value),
  };
}

/** Clears a whole cell. */
export function applyUnset(
  statement: UnsetAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  const targetResult = resolveCellTarget(
    statement.target,
    traversal,
    node,
    accum,
  );
  if (targetResult.status === "blocked") return targetResult;
  const target = targetResult.value;
  if (target.path.length > 0) {
    throw runtimeError(
      "invalid-cell-assignment",
      `${target.label}.$unset() requires a direct cell target`,
    );
  }
  if (!isSettableCell(target.rootCell)) {
    throw runtimeError(
      "invalid-cell-assignment",
      `${target.label}.$unset() cannot unset this cell`,
    );
  }
  return {
    status: "resolved",
    value: writeOwnedCell(target.ownerTraversal, target.root, undefined),
  };
}

export function applySetReturn(
  statement: Extract<ActionStatement, { kind: "set-return" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
  );
  if (value.status === "blocked") return { status: "blocked" };
  // A return write validates against the child's own declared returns schema,
  // never the caller sink: a declared-unbound return stages locally and is
  // discarded at enter resolution, so no sink is resolved here.
  const declared = node.signature?.returns[statement.key];
  if (!declared) {
    throw runtimeError(
      "unknown-channel-key",
      `returns.${statement.key}.$set() targets an undeclared returns channel`,
    );
  }
  assertAssignableChannelValue(
    "returns",
    statement.key,
    declared,
    value.value,
    "return-write",
  );
  // `returns.*` is readable in the same SEG via `readChannelValue`, so the
  // staged value is its own change signal. The caller-cell commit stays at
  // enter resolution (bracketed by the enter's wide snapshot), so this does not
  // route through `writeOwnedCell`.
  const nextStaged = cloneWithCanonicalNumbers(value.value) as CellValue;
  const clonedStaged = cloneCellValue(nextStaged) ?? nextStaged;
  const changed = !cellValuesEqual(
    traversal.enterChannels.stagedReturns[statement.key],
    clonedStaged,
  );
  traversal.enterChannels.stagedReturns[statement.key] = clonedStaged;
  return { status: "resolved", value: { changed } };
}

export function renderHostCallInvocation(
  statement: HostCall,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): Pick<HostCallBrief, "arguments" | "hostParams" | "guidance"> {
  const renderedArguments = renderTypedHostArguments(
    statement,
    traversal,
    node,
    accum,
  );
  const rendered = {
    arguments: renderedArguments,
    guidance: renderNodeGuidance(traversal, node, accum),
    hostParams: admitFinitePayload(
      effectiveHostParams(node, accum),
      "brief/host-call emission",
    ),
  };
  assertPayloadConsumer(rendered.arguments, "brief/host-call emission");
  assertFiniteConsumer(rendered.arguments, "brief/host-call emission");
  return cloneWithCanonicalNumbers(rendered);
}

export function renderHostCallArgument(
  arg: HostCallArgument,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): PayloadValue {
  const rendered = renderHostCallArgumentValue(arg, traversal, node, accum);
  assertPayloadConsumer(rendered, "host-call argument emission");
  assertFiniteConsumer(rendered, "host-call argument emission");
  return cloneWithCanonicalNumbers(rendered);
}

function renderTypedHostArguments(
  action: HostCall,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): PayloadValue[] {
  const resolution = resolveHostOperation(accum.entry.hostModules, action);
  if (resolution.kind === "unresolved") {
    throw new Error(
      "Registered host action no longer resolves to an operation",
    );
  }
  const operation = resolution.operation;
  if (!acceptsHostArgumentCount(operation, action.arguments.length)) {
    throw new Error(
      "Registered host action no longer matches its declared arity",
    );
  }
  return action.arguments.map((argument, index) => {
    const rendered = renderHostCallArgumentValue(
      argument,
      traversal,
      node,
      accum,
    );
    const admission = admitHostArgument(
      argument,
      rendered,
      hostParameterValueSpec(operation.parameters[index]!),
      `$[${index}]`,
    );
    if (!admission.admitted) {
      throw runtimeError(
        admission.violation.code,
        `Invalid host argument at ${admission.violation.path}: ${admission.violation.detail}`,
      );
    }
    assertPayloadConsumer(rendered, "host-call argument emission");
    assertFiniteConsumer(rendered, "host-call argument emission");
    return cloneWithCanonicalNumbers(rendered);
  });
}

function renderHostCallArgumentValue(
  arg: HostCallArgument,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): PayloadValue {
  if (arg.kind === "semantic") {
    return renderSemanticText(arg.value, traversal, node, accum);
  }
  if (arg.kind === "value") {
    const value = evaluateValueExpression(arg.value, traversal, node, accum);
    if (value.status === "blocked") {
      throw new Error("Host call value argument cannot block");
    }
    if (value.value === undefined) {
      throw runtimeError(
        "unset-value",
        "Host call value argument cannot use an unset value",
      );
    }
    assertPayloadConsumer(value.value, "host-call argument emission");
    return value.value;
  }
  if (arg.kind === "array") {
    return arg.elements.map((item) =>
      renderHostCallArgumentValue(item, traversal, node, accum),
    );
  }
  return Object.fromEntries(
    Object.entries(arg.value).map(([key, value]) => [
      key,
      renderHostCallArgumentValue(value, traversal, node, accum),
    ]),
  ) as StructValue;
}

// A host-call result is a sigil-less value: it pins for the rest of the walk
// on the SEG's tape (hydrated in place when the report arrives) and releases on
// dial-back. Arguments render on every visit — before the pin settles — so the
// visit's evaluation order stays prefix-stable for span replay.
export function evaluateHostCall(
  expression: HostCall,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue> {
  const id = makeHostCallId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), expression.id),
  );
  accum.hostCallValueDemands.add(id);
  const renderedArguments = renderTypedHostArguments(
    expression,
    traversal,
    node,
    accum,
  );
  // Render before settling the result so resume visits the same pin prefix.
  const guidance = renderNodeGuidance(traversal, node, accum);
  const report = accum.hostCallResults.get(id);
  const settled = settleHostCallPin(
    accum,
    id,
    report ? { value: report.value } : undefined,
  );
  if (settled.status === "resolved") {
    return { status: "resolved", value: settled.value };
  }
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.hostCalls.push(
      cloneHostCallBrief({
        id,
        sourceRef: traversalToNodeRef(traversal),
        module: expression.module,
        target: [...expression.target],
        operation: expression.operation,
        arguments: renderedArguments,
        guidance,
        hostParams: admitFinitePayload(
          effectiveHostParams(node, accum),
          "brief/host-call emission",
        ),
      } satisfies HostCallBrief),
    );
  }
  return { status: "blocked" };
}

// A judge answer is a sigil-less value: it pins for the rest of the walk on the
// SEG's tape (hydrated in place when the report arrives) and releases on
// dial-back, so a rewalk re-asks under the freshly rendered question while a
// resume replays the pinned answer.
export function evaluateJudge(
  expression: JudgeExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<boolean> {
  const rendered = renderSemanticText(
    expression.question,
    traversal,
    node,
    accum,
  );
  // Guidance is part of the judgment's inputs and shares their pin lifetime.
  const guidance = renderNodeGuidance(traversal, node, accum);
  const id = makeJudgeId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), expression.id),
  );
  const settled = settleJudgmentPin(accum, id, accum.judgmentResults.get(id));
  if (settled.status === "resolved") {
    return { status: "resolved", value: settled.value };
  }
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.judgments.push({
      id,
      sourceRef: traversalToNodeRef(traversal),
      question: rendered,
      guidance,
      hostParams: admitFinitePayload(
        effectiveHostParams(node, accum),
        "host-bound emission",
      ),
    });
  }
  return { status: "blocked" };
}

type CompoundValueExpression = Exclude<
  ValueExpression,
  LocalExpression | HostCall | JudgeExpression
>;

/** Internal expression domain; parsed `null` literals never enter payload consumers. */
type EvaluatedValue = PayloadValue | NodeState | null;

function isCompoundValueExpression(
  expression: ValueExpression,
): expression is CompoundValueExpression {
  return (
    expression.kind === "regexTest" ||
    expression.kind === "comparison" ||
    expression.kind === "arithmetic" ||
    expression.kind === "logical" ||
    expression.kind === "conditional" ||
    expression.kind === "unary" ||
    expression.kind === "numericUnary" ||
    expression.kind === "numIsFinite" ||
    expression.kind === "artifact" ||
    expression.kind === "fmt" ||
    expression.kind === "template-string" ||
    expression.kind === "arrayLiteral" ||
    expression.kind === "structLiteral"
  );
}

export function evaluateValueExpression(
  expression: ValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<EvaluatedValue> {
  if (expression.kind === "host-call")
    return evaluateHostCall(expression, traversal, node, accum);
  if (expression.kind === "judge")
    return evaluateJudge(expression, traversal, node, accum);
  if (!isCompoundValueExpression(expression)) {
    return evaluateLocalExpression(expression, traversal, node, accum);
  }

  return withValuePin(accum, () =>
    computeCompoundValueExpression(expression, traversal, node, accum),
  );
}

/**
 * Wraps one expression visit in the value-pin protocol: a replayed resolved
 * entry short-circuits the whole subtree; otherwise the computed result
 * completes the reservation when it resolves.
 */
function withValuePin(
  accum: Accumulator,
  compute: () => ActionOutcome<EvaluatedValue>,
): ActionOutcome<EvaluatedValue> {
  const pin = beginValuePin(accum);
  if (pin.status === "replayed") {
    return { status: "resolved", value: pin.value as PayloadValue | NodeState };
  }
  const result = compute();
  if (result.status === "resolved" && result.value !== null) {
    if (firstNonFiniteNumberPath(result.value) === undefined) {
      completeValuePin(
        pin.reservation,
        cloneWithCanonicalNumbers(result.value) as PayloadValue,
      );
    }
  }
  return result;
}

function computeCompoundValueExpression(
  expression: CompoundValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<EvaluatedValue> {
  if (expression.kind === "regexTest") {
    const target = evaluateLocalExpression(
      expression.target,
      traversal,
      node,
      accum,
    );
    if (target.status === "blocked") return target;
    if (target.value === undefined) return { status: "resolved", value: false };
    const admitted = stringOperandRule.admitValue(target.value);
    if (!admitted.admitted) {
      throw runtimeError(
        expressionHasArtifactType(expression.target, traversal, node, accum)
          ? "invalid-artifact-operation"
          : "invalid-regex-target",
        expressionHasArtifactType(expression.target, traversal, node, accum)
          ? "Artifacts cannot be used in regular-expression tests"
          : admitted.violation.detail,
      );
    }
    return {
      status: "resolved",
      value: new RegExp(expression.pattern, expression.flags).test(
        admitted.value,
      ),
    };
  }
  if (expression.kind === "comparison") {
    const decision = comparisonRule.checkProducers(
      expression.op,
      expression.left,
      expression.right,
      runtimeProducerContext(traversal, node, accum),
    );
    if (decision.judgment.kind === "incompatible") {
      throw runtimeError(
        "invalid-comparison-operands",
        "Comparison operands do not have a coherent shared domain",
      );
    }
    const left = evaluateValueExpression(
      expression.left,
      traversal,
      node,
      accum,
    );
    if (left.status === "blocked") return left;
    const right = evaluateValueExpression(
      expression.right,
      traversal,
      node,
      accum,
    );
    if (right.status === "blocked") return right;
    const isOrdering =
      expression.op === ">" ||
      expression.op === ">=" ||
      expression.op === "<" ||
      expression.op === "<=";
    if (left.value === undefined || right.value === undefined) {
      return {
        status: "resolved",
        value:
          expression.op === "!=" &&
          (left.value === undefined || right.value === undefined),
      };
    }
    const admitted = comparisonRule.admitValues(
      expression.op,
      decision,
      left.value,
      right.value,
    );
    if (!admitted.admitted) {
      throw runtimeError(admitted.violation.code, admitted.violation.detail);
    }
    const selected = admitted.value.decision;
    if (selected.mode === "struct") {
      const equal = payloadValuesEqual(
        admitted.value.left,
        admitted.value.right,
      );
      return {
        status: "resolved",
        value: expression.op === "==" ? equal : !equal,
      };
    }
    if (isOrdering && selected.mode === "enum") {
      const enumValues = selected.enumValues ?? [];
      const li = enumValues.indexOf(admitted.value.left as string);
      const ri = enumValues.indexOf(admitted.value.right as string);
      return {
        status: "resolved",
        value: evaluateBinary(expression.op, li, ri, false, false),
      };
    }
    return {
      status: "resolved",
      value: evaluateBinary(
        expression.op,
        admitted.value.left,
        admitted.value.right,
        selected.mode === "artifact",
        selected.mode === "artifact",
      ),
    };
  }
  if (expression.kind === "arithmetic") {
    const left = evaluateValueExpression(
      expression.left,
      traversal,
      node,
      accum,
    );
    if (left.status === "blocked") return left;
    const right = evaluateValueExpression(
      expression.right,
      traversal,
      node,
      accum,
    );
    if (right.status === "blocked") return right;
    const lhs = requireArithmeticNumber(left.value, expression.op, "left");
    const rhs = requireArithmeticNumber(right.value, expression.op, "right");
    return {
      status: "resolved",
      value: evaluateArithmetic(expression.op, lhs, rhs),
    };
  }
  if (expression.kind === "logical") {
    const left = evaluateValueExpression(
      expression.left,
      traversal,
      node,
      accum,
    );
    if (left.status === "blocked") return left;
    if (expression.op === "&&") {
      if (!truthy(left.value)) return { status: "resolved", value: left.value };
      const right = evaluateValueExpression(
        expression.right,
        traversal,
        node,
        accum,
      );
      if (right.status === "resolved") truthy(right.value);
      return right;
    }
    if (truthy(left.value)) return { status: "resolved", value: left.value };
    const right = evaluateValueExpression(
      expression.right,
      traversal,
      node,
      accum,
    );
    if (right.status === "resolved") truthy(right.value);
    return right;
  }
  if (expression.kind === "conditional") {
    const test = evaluateValueExpression(
      expression.test,
      traversal,
      node,
      accum,
    );
    if (test.status === "blocked") return test;
    return evaluateValueExpression(
      truthy(test.value) ? expression.consequent : expression.alternate,
      traversal,
      node,
      accum,
    );
  }
  if (expression.kind === "unary") {
    const argument = evaluateValueExpression(
      expression.argument,
      traversal,
      node,
      accum,
    );
    if (argument.status === "blocked") return argument;
    return { status: "resolved", value: !truthy(argument.value) };
  }
  if (expression.kind === "numericUnary") {
    const argument = evaluateValueExpression(
      expression.argument,
      traversal,
      node,
      accum,
    );
    if (argument.status === "blocked") return argument;
    return {
      status: "resolved",
      value: -requireArithmeticNumber(
        argument.value,
        expression.op,
        "argument",
      ),
    };
  }
  if (expression.kind === "numIsFinite") {
    const argument = evaluateValueExpression(
      expression.argument,
      traversal,
      node,
      accum,
    );
    if (argument.status === "blocked") return argument;
    if (argument.value === undefined) {
      throw runtimeError(
        "unset-value",
        "Unset value cannot be evaluated by Num.isFinite",
      );
    }
    const admission = numIsFiniteRule.admitValue(argument.value);
    if (!admission.admitted) {
      throw runtimeError(
        "non-numeric-is-finite-argument",
        `Num.isFinite requires a numeric argument; got ${runtimeKind(argument.value)}`,
      );
    }
    return { status: "resolved", value: Number.isFinite(admission.value) };
  }
  if (expression.kind === "fmt") {
    const value = evaluateValueExpression(
      expression.value,
      traversal,
      node,
      accum,
    );
    if (value.status === "blocked") return value;
    const projection = fmtRule.projectValue(
      resolveProducer(
        expression.value,
        runtimeProducerContext(traversal, node, accum),
      ),
      value.value,
      expression.config,
    );
    if (!projection.admitted)
      throw runtimeError(
        projection.violation.code,
        projection.violation.detail,
      );
    return { status: "resolved", value: projection.value };
  }
  if (expression.kind === "artifact") {
    return computeArtifactConstructExpression(
      expression,
      traversal,
      node,
      accum,
    );
  }
  if (expression.kind === "template-string") {
    return computeValueText(expression, traversal, node, accum);
  }
  if (expression.kind === "arrayLiteral") {
    const elements: PayloadValue[] = [];
    for (const element of expression.elements) {
      const value = evaluateValueExpression(element, traversal, node, accum);
      if (value.status === "blocked") return value;
      if (value.value === undefined) {
        throw runtimeError(
          "unset-value",
          "Array literal elements cannot use an unset value",
        );
      }
      const issue = firstInvalidPayloadValue(value.value);
      if (issue) {
        throw runtimeError(
          "invalid-array-literal",
          `Invalid array literal element at ${issue.path}: ${issue.detail}`,
        );
      }
      elements.push(cloneWithCanonicalNumbers(value.value as PayloadValue));
    }
    return { status: "resolved", value: elements };
  }
  if (expression.kind === "structLiteral") {
    // A struct value is concrete only when every field is concrete: an unset
    // field makes the whole literal unset, and its consumer applies its own
    // absence rule.
    const fields: Record<string, PayloadValue> = {};
    let incomplete = false;
    for (const [name, field] of Object.entries(expression.fields)) {
      const value = evaluateValueExpression(field, traversal, node, accum);
      if (value.status === "blocked") return value;
      if (value.value === undefined) {
        incomplete = true;
        continue;
      }
      const issue = firstInvalidPayloadValue(value.value);
      if (issue || value.value === null) {
        throw runtimeError(
          "invalid-struct-literal",
          `Invalid Struct field ${JSON.stringify(name)}${issue ? ` at ${issue.path}: ${issue.detail}` : ""}`,
        );
      }
      fields[name] = cloneWithCanonicalNumbers(value.value);
    }
    return { status: "resolved", value: incomplete ? undefined : fields };
  }
  throw new Error("Unknown compound value expression");
}

function computeArtifactConstructExpression(
  expression: ArtifactConstructExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<ArtifactValue> {
  const evaluated = evaluateValueExpression(
    expression.path,
    traversal,
    node,
    accum,
  );
  if (evaluated.status === "blocked") return evaluated;
  if (evaluated.value === undefined) {
    throw runtimeError(
      "unset-value",
      "Artifact path cannot use an unset value",
    );
  }
  const admission = artifactPathRule.admitValue(evaluated.value);
  if (!admission.admitted) {
    throw runtimeError(admission.violation.code, admission.violation.detail);
  }
  return {
    status: "resolved",
    value: createArtifactValue(admission.value),
  };
}

function computeValueText(
  valueString: Extract<ValueExpression, { kind: "template-string" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<string> {
  let rendered = "";
  for (const part of valueString.parts) {
    if (part.kind === "text") {
      rendered += part.value;
      continue;
    }
    const value = evaluateValueExpression(
      part.expression,
      traversal,
      node,
      accum,
    );
    if (value.status === "blocked") return value;
    if (value.value === undefined) {
      throw runtimeError(
        "invalid-template-interpolation",
        "Value template interpolation cannot use an unset value",
      );
    }
    const projection = interpolationRule.projectValue(
      resolveProducer(
        part.expression,
        runtimeProducerContext(traversal, node, accum),
      ),
      value.value,
    );
    if (!projection.admitted) {
      throw runtimeError(
        projection.violation.code,
        projection.violation.detail,
      );
    }
    rendered += projection.value;
  }
  return { status: "resolved", value: rendered };
}

export function evaluateLocalExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<EvaluatedValue> {
  if (expression.kind === "literal") {
    return computeLocalExpression(expression, traversal, node, accum);
  }
  return withValuePin(accum, () =>
    computeLocalExpression(expression, traversal, node, accum),
  );
}

function computeLocalExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<EvaluatedValue> {
  switch (expression.kind) {
    case "literal":
      return { status: "resolved", value: expression.value };
    case "cell":
      return resolvedCellRead(expression.name, traversal, accum);
    case "isUnset":
      return {
        status: "resolved",
        value: getCellValue(expression.cell, traversal, accum) === undefined,
      };
    case "channel":
      return resolvedChannelRead(
        traversal,
        expression.namespace,
        expression.key,
        accum,
      );
    case "channelIsUnset":
      return {
        status: "resolved",
        value:
          readChannelValue(
            traversal,
            expression.namespace,
            expression.key,
            accum,
          ) === undefined,
      };
    case "field":
      return {
        status: "resolved",
        value: readFieldValue(expression, traversal, node, accum),
      };
    case "deflectionEscaped":
      return {
        status: "resolved",
        value: deflectionEscaped(expression.target, traversal, node, accum),
      };
    case "span": {
      if (!accum.mapMember) {
        throw runtimeError(
          "span-outside-map",
          "span is only available inside a $map callback",
        );
      }
      return {
        status: "resolved",
        value:
          expression.key === "item"
            ? accum.mapMember.item
            : accum.mapMember.index,
      };
    }
    case "dialogCursor": {
      assertDialogCursor(accum.dialog.cursor, "Dialog.cursor");
      // Stamp the cursor with the supplied dialog's view, binding it to the
      // projection it was read from.
      const cursor = cloneDialogCursor(accum.dialog.cursor);
      if (accum.dialog.view !== undefined) cursor.view = accum.dialog.view;
      return { status: "resolved", value: cursor };
    }
    case "dialogTurnsSince":
      return evaluateDialogTurnsSince(expression, traversal, node, accum);
    case "scope":
      if (expression.name === "lastUserMessage") {
        for (
          let index = accum.dialog.lastTurns.length - 1;
          index >= 0;
          index--
        ) {
          const turn = accum.dialog.lastTurns[index];
          if (turn?.role === "user") {
            return { status: "resolved", value: turn.message };
          }
        }
        return { status: "resolved", value: undefined };
      }
      return {
        status: "resolved",
        value: accum.dialog.lastTurns
          .slice(-(expression.count ?? accum.dialog.lastTurns.length))
          .map((turn) => `${turn.role}: ${turn.message}`)
          .join("\n"),
      };
    case "enterCount":
      return { status: "resolved", value: traversal.enterCount };
    case "interruptionId":
    case "interruptionReason": {
      const control = traversal.control;
      if (control?.reason !== "interrupted" || control.phase !== "catch") {
        throw new Error(
          "this.interruption is only available while this.catchInterruption is running",
        );
      }
      return {
        status: "resolved",
        value:
          expression.kind === "interruptionId"
            ? control.interruption.id
            : control.interruption.reason,
      };
    }
    case "pendingState": {
      const control = traversal.control;
      if (!control || control.phase !== "effects") {
        throw new Error(
          "this.pendingState is only available while this.effects is running",
        );
      }
      return { status: "resolved", value: control.reason };
    }
    case "nodeState": {
      const ref = resolveRefInTraversal(
        accum,
        traversal,
        node,
        expression.identifier,
      );
      return {
        status: "resolved",
        value: ref ? childState(accum.traversals, ref) : undefined,
      };
    }
    case "arrayElementRead":
      return readArrayElement(expression, traversal, node, accum);
    case "arrayLength": {
      const array = requireArrayValue(
        expression.array,
        traversal,
        node,
        accum,
        "length",
      );
      return { status: "resolved", value: array.length };
    }
    case "arithmetic": {
      const left = evaluateLocalExpression(
        expression.left,
        traversal,
        node,
        accum,
      );
      if (left.status === "blocked") return left;
      const right = evaluateLocalExpression(
        expression.right,
        traversal,
        node,
        accum,
      );
      if (right.status === "blocked") return right;
      return {
        status: "resolved",
        value: evaluateArithmetic(
          expression.op,
          requireArithmeticNumber(left.value, expression.op, "left"),
          requireArithmeticNumber(right.value, expression.op, "right"),
        ),
      };
    }
    case "numericUnary": {
      const argument = evaluateLocalExpression(
        expression.argument,
        traversal,
        node,
        accum,
      );
      if (argument.status === "blocked") return argument;
      return {
        status: "resolved",
        value: -requireArithmeticNumber(
          argument.value,
          expression.op,
          "argument",
        ),
      };
    }
  }
}

/** Reads one existing element of an array reference by a local index. */
function readArrayElement(
  expression: ArrayElementRead,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<ArrayElementValue> {
  const array = requireArrayValue(
    expression.array,
    traversal,
    node,
    accum,
    "index",
  );
  const index = evaluateLocalExpression(
    expression.index,
    traversal,
    node,
    accum,
  );
  if (index.status === "blocked") return index;
  const position = index.value;
  if (
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 0
  ) {
    throw runtimeError(
      "invalid-array-index",
      `Array index must be a non-negative integer, got ${String(position)}`,
    );
  }
  if (position >= array.length) {
    throw runtimeError(
      "array-index-out-of-range",
      `Array index ${position} is out of range for length ${array.length}`,
    );
  }
  return { status: "resolved", value: array[position]! };
}

/**
 * Reads an array reference's current value, requiring it to be a set array.
 * Reading an element or `length` of an unset array is a runtime error, as is a
 * value that is somehow not an array (guarded defensively; validation rejects
 * non-array receivers statically).
 */
export function requireArrayValue(
  array: ArrayReference,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  operation: string,
): ArrayValue {
  const value =
    array.kind === "cell"
      ? getCellValue(array.name, traversal, accum)
      : array.kind === "channel"
        ? readChannelValue(traversal, array.namespace, array.key, accum)
        : readFieldValue(array, traversal, node, accum);
  if (value === undefined) {
    throw runtimeError(
      "unset-value",
      `Cannot read ${operation} of an unset array`,
    );
  }
  if (!Array.isArray(value)) {
    throw runtimeError(
      "invalid-array-operation",
      `Cannot read ${operation} of a non-array value`,
    );
  }
  return value;
}

function deflectionEscaped(
  target: EnterTarget,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): boolean {
  const control = traversal.control;
  if (control?.reason !== "deflected") {
    throw new Error(
      "this.deflection.escaped(...) is only available while a deflection is pending",
    );
  }

  // `from` is the canonical target of the entry the deflection propagated up
  // through. A node's own frontier deflection entered nothing, so `from` is
  // unset and `escaped` matches no target — self included.
  const from = control.deflection.from;
  if (!from) return false;

  const ref = resolveRefInTraversal(
    accum,
    traversal,
    node,
    target.identifier,
    target.imported,
  );
  if (!ref) {
    if (targetsEnclosingNode(target, node)) return false;
    throw new Error(
      `Internal invariant violation: deflection target ${target.identifier} could not be resolved`,
    );
  }
  return (isArcRef(ref) ? arcToNodeRef(ref) : ref) === from;
}

function targetsEnclosingNode(target: EnterTarget, node: Node): boolean {
  return (
    !target.imported &&
    target.identifier === node.identifier &&
    !node.children.some((child) => child.identifier === target.identifier) &&
    !node.imports.includes(target.identifier)
  );
}

export function resolveRefInTraversal(
  accum: Accumulator,
  traversal: Traversal,
  node: Node,
  identifier: string,
  importedHint?: boolean,
): ArcRef | NodeRef | undefined {
  const entry = getEntryForRef(accum.entries, traversal.ref);
  if (!entry) return undefined;
  return resolveLexicalRef(
    accum.entries,
    entry,
    traversalToNodeRef(traversal),
    node,
    identifier,
    importedHint,
  );
}

export function findCellOwner(
  cell: string,
  traversal: Traversal,
  accum: Accumulator,
): { traversal: Traversal; cell: Cell } | undefined {
  let ref: NodeRef | undefined = traversalToNodeRef(traversal);
  while (ref) {
    const entry = getEntryForRef(accum.entries, ref);
    if (!entry) return undefined;
    const node = getNodeForRef(accum.entries, entry, ref);
    const found = node?.cells.find((item) => item.name === cell);
    if (found) {
      const ownerTraversal = findTraversalInSet(accum.traversals, ref);
      if (!ownerTraversal) break;
      return { traversal: ownerTraversal, cell: found };
    }
    ref = lexicalParentRef(ref);
  }
  return undefined;
}

export function getCellMeta(
  cell: string,
  traversal: Traversal,
  accum: Accumulator,
): Cell | undefined {
  return findCellOwner(cell, traversal, accum)?.cell;
}

function runtimeProducerContext(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ProducerContext {
  return {
    cells: [],
    resolveCell: (name) => getCellMeta(name, traversal, accum),
    signature: node.signature,
    map: accum.mapMember
      ? {
          receiverSpec: accum.mapMember.receiverSpec,
          resultSpec: accum.mapMember.resultSpec,
        }
      : undefined,
    resolveHostOperation: (call) => {
      const resolution = resolveHostOperation(accum.entry.hostModules, call);
      return resolution.kind === "resolved" ? resolution.operation : undefined;
    },
  };
}

/**
 * Whether an expression's authored type context identifies its result as an
 * Artifact. Runtime values stay representation-only; Artifact meaning comes
 * from constructor IR or the declaring cell/channel spec.
 */
function expressionHasArtifactType(
  expression: ValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): boolean {
  return producerGuaranteesArtifact(
    resolveProducer(expression, runtimeProducerContext(traversal, node, accum)),
  );
}

export function getCellValue(
  cell: string,
  traversal: Traversal,
  accum: Accumulator,
): CellValue | undefined {
  return cloneCellValue(
    findCellOwner(cell, traversal, accum)?.traversal.cells[cell],
  );
}

/**
 * Resolves the spec and stored value of a struct field reference. The field
 * path is resolved from the receiver's spec, and a field of an unset struct
 * reads as unset.
 */
function readFieldState(
  field: FieldReference,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): { spec: ObservableFieldSpec; state: PayloadValue } {
  const receiver = readReceiverState(field.receiver, traversal, node, accum);
  const spec =
    receiver.spec?.type === "struct"
      ? fieldSpecAt(receiver.spec, field.path)
      : undefined;
  if (!spec) {
    throw runtimeError(
      "invalid-field-read",
      `Cannot read undeclared Struct field ${field.path.join(".")}`,
    );
  }
  return { spec, state: fieldValueAt(receiver.state, field.path) };
}

/** Resolves the spec and stored value of a field reference's receiver. */
function readReceiverState(
  receiver: FieldReceiver,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): {
  spec: CellSpec | ChannelSpec | ArrayElementSpec | undefined;
  state: PayloadValue;
} {
  switch (receiver.kind) {
    case "cell": {
      const owner = findCellOwner(receiver.name, traversal, accum);
      if (!owner) {
        throw runtimeError("unknown-cell", `Unknown cell: ${receiver.name}`);
      }
      return {
        spec: owner.cell,
        state: owner.traversal.cells[receiver.name],
      };
    }
    case "channel":
      return {
        spec: nodeForTraversal(traversal, accum)?.signature?.[
          receiver.namespace
        ][receiver.key],
        state: readChannelValue(
          traversal,
          receiver.namespace,
          receiver.key,
          accum,
        ),
      };
    case "arrayElementRead": {
      const element = readArrayElement(receiver, traversal, node, accum);
      if (element.status === "blocked") {
        throw new Error("Internal invariant: a local element read blocked");
      }
      return {
        spec: runtimeArrayElementSpec(receiver.array, traversal, node, accum),
        state: element.value,
      };
    }
    case "span": {
      const member = accum.mapMember;
      if (!member) {
        throw runtimeError(
          "span-outside-map",
          "span is only available inside a $map callback",
        );
      }
      return { spec: member.receiverSpec, state: member.item };
    }
  }
}

/**
 * The element spec of an array reference resolved against the live
 * traversal: a cell, a channel, or an array field of any field receiver.
 */
export function runtimeArrayElementSpec(
  reference: ArrayReference,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ArrayElementSpec | undefined {
  const spec = resolveReferenceSpec(reference, {
    cells: [],
    signature: node.signature,
    resolveCell: (name) => findCellOwner(name, traversal, accum)?.cell,
    map: { receiverSpec: accum.mapMember?.receiverSpec },
  });
  return spec?.type === "array" ? spec.element : undefined;
}

/** Reads a struct field's value, or `undefined` when its struct is unset. */
function readFieldValue(
  field: FieldReference,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): CellValue | undefined {
  const { state } = readFieldState(field, traversal, node, accum);
  // A set field holds a value admitted under its observable field spec.
  return cloneCellValue(state as CellValue | undefined);
}

function resolvedCellRead(
  name: string,
  traversal: Traversal,
  accum: Accumulator,
): ActionOutcome<CellValue | undefined> {
  return { status: "resolved", value: getCellValue(name, traversal, accum) };
}

/** Resolves the node a traversal belongs to, for signature lookups. */
export function nodeForTraversal(
  traversal: Traversal,
  accum: Accumulator,
): Node | undefined {
  const ref = traversalToNodeRef(traversal);
  const entry = getEntryForRef(accum.entries, traversal.ref);
  return entry ? getNodeForRef(accum.entries, entry, ref) : undefined;
}

/** Whether the traversal's node declares the given channel key in its signature. */
export function channelIsDeclared(
  traversal: Traversal,
  namespace: "args" | "returns",
  key: string,
  accum: Accumulator,
): boolean {
  const signature = nodeForTraversal(traversal, accum)?.signature;
  return signature ? key in signature[namespace] : false;
}

export function readChannelValue(
  traversal: Traversal,
  namespace: "args" | "returns",
  key: string,
  accum: Accumulator,
): CellValue | undefined {
  const channelState = traversal.enterChannels;
  if (namespace === "returns" && key in channelState.stagedReturns) {
    return cloneCellValue(channelState.stagedReturns[key]);
  }
  const link = channelState[namespace][key];
  if (!link) {
    // A declared-but-unbound channel reads as an unset cell; only an undeclared
    // key is an error.
    if (channelIsDeclared(traversal, namespace, key, accum)) {
      return undefined;
    }
    throw runtimeError(
      "unknown-channel-key",
      `Unknown ${namespace} channel key "${key}" for ${formatRef(traversalToNodeRef(traversal))}`,
    );
  }
  if (link.kind === "value") {
    return cloneCellValue(link.value);
  }
  if (link.kind === "spanResult") {
    // A `span.result` return sink holds no readable value until it commits: an
    // unread member output reads as an unset cell.
    return undefined;
  }
  const callerTraversal = findTraversalInSet(accum.traversals, link.ownerRef);
  if (!callerTraversal) {
    throw runtimeError(
      "invalid-channel-binding",
      `${namespace}.${key} caller-owner traversal not found for binding: ${formatRef(link.ownerRef)}`,
    );
  }
  return cloneCellValue(callerTraversal.cells[link.cell]);
}

function resolvedChannelRead(
  traversal: Traversal,
  namespace: "args" | "returns",
  key: string,
  accum: Accumulator,
): ActionOutcome<CellValue | undefined> {
  return {
    status: "resolved",
    value: readChannelValue(traversal, namespace, key, accum),
  };
}

/**
 * Single write path for an owned cell. Clones the value, compares it by
 * value against the current value, writes it, and reports whether it changed.
 * Every cell write goes through here so before/after snapshots read a
 * consistent value and re-walk decisions see net change, not write occurrence.
 */
export function writeOwnedCell(
  ownerTraversal: Traversal,
  name: string,
  value: CellValue | undefined,
): { changed: boolean } {
  const nonFinitePath = firstNonFiniteNumberPath(value);
  if (nonFinitePath !== undefined) {
    throw new Error(
      `Internal invariant: a cell write reached storage with a non-finite number at ${nonFinitePath}`,
    );
  }
  const next = cloneWithCanonicalNumbers(cloneCellValue(value));
  const changed = !cellValuesEqual(ownerTraversal.cells[name], next);
  ownerTraversal.cells[name] = next;
  return { changed };
}

/** Validates and stores one direct owned-cell write by its declared spec. */
export function writeOwnedCellValue(
  ownerTraversal: Traversal,
  name: string,
  spec: CellSpec,
  value: unknown,
  label = name,
): { changed: boolean } {
  assertAssignableValue(label, spec, value);
  return writeOwnedCell(ownerTraversal, name, value);
}

export function assertAssignableValue(
  cell: string,
  spec: CellSpec,
  value: unknown,
): asserts value is CellValue {
  const admission = admitValue(spec, value);
  if (admission.admitted) return;

  const { code, detail, path } = admission.violation;
  if (code === "non-finite-number") {
    const consumer =
      spec.type === "array"
        ? "array write"
        : cell.includes("[")
          ? "array element write"
          : "cell write";
    throw runtimeError(
      "non-finite-number",
      `Numeric value must be finite before ${consumer}${path === "$" ? "" : ` at ${path}`}`,
    );
  }
  if (code === "invalid-enum") {
    throw runtimeError(
      "invalid-enum-value",
      `${cell}.$set() must satisfy its Enum constraint: ${detail}`,
    );
  }
  if (code === "invalid-artifact") {
    throw runtimeError(
      "invalid-artifact-value",
      `${cell}.$set() requires a valid Artifact value${path === "$" ? "" : ` at ${path}`}: ${detail}`,
    );
  }
  if (code === "invalid-dialog-cursor") {
    throw runtimeError(
      "invalid-dialog-cursor",
      `${cell}.$set() requires a valid Dialog cursor`,
    );
  }
  if (code === "unset") {
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() requires a set value`,
    );
  }
  if (code === "invalid-string") {
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() requires a string value`,
    );
  }
  if (code === "invalid-boolean") {
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() requires a boolean value`,
    );
  }
  if (code === "invalid-number") {
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() requires a numeric value`,
    );
  }
  throw runtimeError(
    "invalid-cell-assignment",
    `${cell}.$set() is incompatible with its ${spec.type} constraint${path === "$" ? "" : ` at ${path}`}`,
  );
}

function evaluateDialogTurnsSince(
  expression: Extract<LocalExpression, { kind: "dialogTurnsSince" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<number> {
  const receiver = evaluateLocalExpression(
    expression.receiver,
    traversal,
    node,
    accum,
  );
  if (receiver.status === "blocked") return receiver;
  assertDialogCursor(receiver.value, "cursor .*TurnsSince() receiver");
  const baseline = evaluateLocalExpression(
    expression.baseline,
    traversal,
    node,
    accum,
  );
  if (baseline.status === "blocked") return baseline;
  assertDialogCursor(baseline.value, "cursor .*TurnsSince() baseline");
  // Cursors are coordinates in one projection; two views count different
  // subsets of history, so a cross-view difference measures nothing. This is
  // an authored runtime error, handled as traversal poison by the advancement
  // boundary.
  const receiverView = receiver.value.view;
  const baselineView = baseline.value.view;
  if (receiverView !== baselineView) {
    throw runtimeError(
      "cross-view-comparison",
      `Cursors from different views cannot be compared: the receiver was read under ${
        receiverView === undefined
          ? "the default view"
          : `view "${receiverView}"`
      } and the baseline under ${
        baselineView === undefined
          ? "the default view"
          : `view "${baselineView}"`
      }.`,
    );
  }
  // Signed difference: receiver minus baseline. A comparison between two stored
  // cursors keeps that signed value. The live `Dialog.cursor` is a
  // different matter: the host mutates it each turn and it must only ever
  // advance, so it must be at least as large as any stored snapshot it is
  // compared against.
  const userDelta = receiver.value.user - baseline.value.user;
  const selfDelta = receiver.value.self - baseline.value.self;
  const liveReceiverWentBackwards =
    expression.receiver.kind === "dialogCursor" &&
    (userDelta < 0 || selfDelta < 0);
  const liveBaselineWentBackwards =
    expression.baseline.kind === "dialogCursor" &&
    (userDelta > 0 || selfDelta > 0);
  if (liveReceiverWentBackwards || liveBaselineWentBackwards) {
    throw runtimeError(
      "cursor-moved-backwards",
      "Dialog.cursor moved backwards relative to a stored cursor",
    );
  }
  return {
    status: "resolved",
    value:
      expression.metric === "user"
        ? userDelta
        : expression.metric === "self"
          ? selfDelta
          : userDelta + selfDelta,
  };
}

function assertDialogCursor(
  value: unknown,
  label: string,
): asserts value is DialogCursor {
  if (!isDialogCursorValue(value)) {
    throw runtimeError(
      "invalid-dialog-cursor",
      `${label} must be a valid Dialog cursor`,
    );
  }
}

/** Renders the emitting node's standing guidance for action-stage work. */
export function renderNodeGuidance(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText | undefined {
  return accum.stage === "trigger" || node.guidance === undefined
    ? undefined
    : renderSemanticText(node.guidance, traversal, node, accum);
}

export function renderSemanticText(
  semantic: SemanticString,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText {
  if (semantic.kind === "literal") return semantic.value;

  const pin = beginValuePin(accum);
  if (pin.status === "replayed") return pin.value as SemanticText;
  const rendered = computeSemanticText(semantic, traversal, node, accum);
  completeValuePin(pin.reservation, rendered);
  return rendered;
}

function computeSemanticText(
  semantic: Extract<SemanticString, { kind: "template-string" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText {
  const parts: SemanticTextPart[] = [];
  let deferred = false;

  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") {
      last.value += value;
      return;
    }
    parts.push({ kind: "text", value });
  };

  for (const part of semantic.parts) {
    if (part.kind === "text") {
      pushText(part.value);
      continue;
    }
    if (part.kind === "hostVar") {
      parts.push({
        kind: "hostVar",
        module: part.module,
        path: part.path,
      });
      deferred = true;
      continue;
    }
    if (part.kind === "ref") {
      parts.push({ kind: "entity", name: part.name });
      deferred = true;
      continue;
    }

    const value = evaluateValueExpression(
      part.expression,
      traversal,
      node,
      accum,
    );
    if (value.status === "blocked") continue;
    if (value.value === undefined) {
      throw runtimeError(
        "invalid-template-interpolation",
        "Semantic template interpolation cannot use an unset value",
      );
    }
    const evidence = resolveProducer(
      part.expression,
      runtimeProducerContext(traversal, node, accum),
    );
    if (producerGuaranteesArtifact(evidence)) {
      if (!isArtifactValue(value.value)) {
        const issue = classifyArtifactValue(value.value);
        throw runtimeError(
          "invalid-artifact-value",
          `Invalid Artifact value: ${describeArtifactValueIssue(issue ?? "not-plain-object")}`,
        );
      }
      parts.push({ kind: "artifact", path: value.value.path });
      deferred = true;
      continue;
    }
    const projection = interpolationRule.projectValue(evidence, value.value);
    if (!projection.admitted) {
      const detail = projection.violation.detail
        .replace("value-template", "semantic-template")
        .replace("Value template", "Semantic template");
      throw runtimeError(projection.violation.code, detail);
    }
    pushText(projection.value);
  }

  if (!deferred) {
    return parts
      .map((part) => (part.kind === "text" ? part.value : ""))
      .join("");
  }
  return parts;
}

export function initializeArtifactCells(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): void {
  for (const cell of node.cells) {
    if (cell.type !== "artifact" || cell.initializer === undefined) continue;
    const savedPin = accum.pin;
    beginPinForElement(
      accum,
      {},
      `artifact-initializer/${cell.name}` as ElementId,
    );
    try {
      const initialized = evaluateValueExpression(
        cell.initializer,
        traversal,
        node,
        accum,
      );
      if (initialized.status === "blocked") {
        throw runtimeError(
          "invalid-artifact-path",
          "Artifact path initializer cannot contain blocked work",
        );
      }
      writeOwnedCellValue(traversal, cell.name, cell, initialized.value);
    } finally {
      accum.pin = savedPin;
    }
  }
}

function effectiveHostParams(node: Node, accum: Accumulator): PayloadValue {
  return accum.hostParamsActive ? accum.hostParams : node.hostParams;
}

export function truthy(value: unknown): boolean {
  if (value === undefined) {
    throw runtimeError(
      "unset-value",
      "Unset value cannot be evaluated as a boolean",
    );
  }
  const admission = booleanRule.admitValue(value);
  if (!admission.admitted) {
    throw runtimeError(
      admission.violation.code,
      "Only a boolean value can be evaluated as a boolean; compare a non-boolean value explicitly",
    );
  }
  return admission.value;
}

/** Structural equality of two ordered arrays by element value. */
function arraysStructurallyEqual(left: unknown[], right: unknown[]): boolean {
  return (
    left.length === right.length &&
    left.every((element, index) =>
      cellValuesEqual(element as CellValue, right[index] as CellValue),
    )
  );
}

function runtimeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    if (
      "status" in value &&
      (value.status === "idle" ||
        value.status === "running" ||
        value.status === "resolved" ||
        value.status === "deflected")
    ) {
      return "node-state";
    }
    return "object";
  }
  return typeof value;
}

function requireArithmeticNumber(
  value: unknown,
  op: string,
  side: "left" | "right" | "argument",
): number {
  if (value === undefined) {
    throw runtimeError(
      "unset-value",
      `Unset value cannot be used as the ${side} operand of ${op}`,
    );
  }
  const admission = arithmeticRule.admitValue(value);
  if (!admission.admitted) {
    throw runtimeError(
      "non-numeric-arithmetic-operand",
      `Arithmetic operator ${op} requires a numeric ${side} operand; got ${runtimeKind(value)}`,
    );
  }
  return admission.value;
}

function evaluateArithmetic(
  op: ArithmeticOperator,
  left: number,
  right: number,
): number {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
  }
}

function assertFiniteConsumer(value: unknown, consumer: string): void {
  const path = firstNonFiniteNumberPath(value);
  if (path === undefined) return;
  throw runtimeError(
    "non-finite-number",
    `Numeric value must be finite before ${consumer}${path === "$" ? "" : ` at ${path}`}`,
  );
}

function admitFinitePayload(
  value: PayloadValue,
  consumer: string,
): PayloadValue {
  assertPayloadConsumer(value, consumer);
  assertFiniteConsumer(value, consumer);
  return cloneWithCanonicalNumbers(value);
}

function assertPayloadConsumer(
  value: unknown,
  consumer: string,
): asserts value is PayloadValue {
  const issue = firstInvalidPayloadValue(value);
  if (!issue) return;
  throw runtimeError(
    issue.code,
    `Invalid payload before ${consumer} at ${issue.path}: ${issue.detail}`,
  );
}

function evaluateBinary(
  op: ComparisonOperator,
  left: unknown,
  right: unknown,
  leftHasArtifactType: boolean,
  rightHasArtifactType: boolean,
): boolean {
  const artifactOperand = leftHasArtifactType || rightHasArtifactType;
  const artifactsEqual =
    leftHasArtifactType &&
    rightHasArtifactType &&
    isArtifactValue(left) &&
    isArtifactValue(right) &&
    left.path === right.path;
  const arrayOperand = Array.isArray(left) || Array.isArray(right);
  switch (op) {
    case "==":
      if (left === undefined || right === undefined) return false;
      if (artifactOperand) return artifactsEqual;
      if (arrayOperand) {
        return (
          Array.isArray(left) &&
          Array.isArray(right) &&
          arraysStructurallyEqual(left, right)
        );
      }
      return left === right;
    case "!=":
      if (left === undefined || right === undefined) return true;
      if (artifactOperand) return !artifactsEqual;
      if (arrayOperand) {
        return !(
          Array.isArray(left) &&
          Array.isArray(right) &&
          arraysStructurallyEqual(left, right)
        );
      }
      return left !== right;
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (artifactOperand) {
        throw runtimeError(
          "invalid-artifact-operation",
          `Artifacts cannot be used with ordering operator ${op}`,
        );
      }
      if (arrayOperand) {
        throw runtimeError(
          "invalid-array-operation",
          "Arrays cannot be ordered",
        );
      }
      return op === ">"
        ? compareValues(left, right) > 0
        : op === ">="
          ? compareValues(left, right) >= 0
          : op === "<"
            ? compareValues(left, right) < 0
            : compareValues(left, right) <= 0;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  const lhs = left == null ? "" : String(left);
  const rhs = right == null ? "" : String(right);
  if (lhs === rhs) return 0;
  return lhs > rhs ? 1 : -1;
}
