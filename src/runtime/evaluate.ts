import {
  admitHostArgument,
  admitValue,
  arithmeticRule,
  artifactPathRule,
  booleanRule,
  comparisonRule,
  interpolationRule,
  numIsFiniteRule,
  producerGuaranteesArtifact,
  resolveHostOperation,
  resolveProducer,
  stringOperandRule,
  type ProducerContext,
} from "../spec/resolution.js";
import type {
  HostCallBrief,
  ObservationGroupField,
  ObservationValueMeta,
  ScalarObservationMeta,
} from "../types/host-interaction.js";
import type {
  ActionStatement,
  ArithmeticOperator,
  ArrayReference,
  ArtifactConstructExpression,
  Cell,
  CellTarget,
  ComparisonOperator,
  ElementId,
  EnterTarget,
  HostCall,
  HostCallArgument,
  JudgeExpression,
  LocalExpression,
  Node,
  ObservableScalar,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  SemanticString,
  SetAction,
  UnsetAction,
  ValueExpression,
} from "../types/parser.js";
import { isSettableCell } from "../types/parser.js";
import type {
  ArcRef,
  NodeRef,
  NodeState,
  Traversal,
} from "../types/runtime.js";
import { qualifiedBriefSite } from "../types/runtime.js";
import type {
  ArrayElementSpec,
  CellSpec,
  ObservableCellSpec,
} from "../types/spec.js";
import { isObservableCellSpec } from "../types/spec.js";
import {
  classifyArtifactValue,
  isArtifactValue,
  type ArrayElementValue,
  type ArrayValue,
  type ArtifactValue,
  type CellValue,
  type DialogCursor,
  type PayloadValue,
  type PrimitiveArrayValue,
  type PrimitiveValue,
  type SemanticText,
  type SemanticTextPart,
  type StructValue,
} from "../types/value.js";
import {
  cloneWithCanonicalNumbers,
  createArtifactValue,
  describeArtifactValueIssue,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
} from "../value-utils.js";
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
  isArcRef,
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
  type Accumulator,
} from "./state.js";

export type ActionOutcome<T = undefined> =
  | { status: "resolved"; value: T }
  | { status: "blocked" };

type ResolvedCellTarget = {
  ownerTraversal: Traversal;
  root: string;
  rootCell: Cell;
  path: number[];
  leafSpec: Cell | ArrayElementSpec;
  label: string;
  value: CellValue | undefined;
};

type ObservableTargetSpec =
  | ObservableScalar
  | { type: "array"; element: ObservableScalar };

function formatAuthoredCellTarget(target: CellTarget): string {
  const [root, ...accessors] = target;
  return `${root}${accessors.map(() => "[...]").join("")}`;
}

/**
 * Resolves a lexical cell target against the live traversal state. Accessors
 * evaluate through the ordinary local-expression path, so non-literal indices
 * are pinned by the containing statement's pin tape.
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

  let leafSpec: Cell | ArrayElementSpec = owner.cell;
  let value = owner.traversal.cells[root];
  const path: number[] = [];
  let label = root;
  for (const accessor of accessors) {
    if (leafSpec.type !== "array") {
      throw runtimeError(
        "invalid-cell-target",
        `Cell target ${label} accesses through a non-container value`,
      );
    }
    if (value === undefined) {
      throw runtimeError(
        "unset-value",
        `Cannot access an element of unset array ${label}`,
      );
    }
    if (!Array.isArray(value)) {
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
    if (position >= value.length) {
      throw runtimeError(
        "array-index-out-of-range",
        `Array index ${position} is out of range for length ${value.length}`,
      );
    }
    path.push(position);
    label += `[${position}]`;
    value = value[position];
    leafSpec = leafSpec.element;
  }

  return {
    status: "resolved",
    value: {
      ownerTraversal: owner.traversal,
      root,
      rootCell: owner.cell,
      path,
      leafSpec,
      label,
      value,
    },
  };
}

function writeResolvedCellTarget(
  target: ResolvedCellTarget,
  value: unknown,
): { changed: boolean } {
  if (target.path.length === 0) {
    return writeOwnedCellValue(
      target.ownerTraversal,
      target.root,
      target.leafSpec,
      value,
      target.label,
    );
  }
  if (target.path.length !== 1) {
    throw runtimeError(
      "invalid-cell-target",
      `${target.label} exceeds the supported array target depth`,
    );
  }
  assertAssignableValue(target.label, target.leafSpec, value);
  const current = target.ownerTraversal.cells[target.root];
  if (!Array.isArray(current)) {
    throw runtimeError(
      current === undefined ? "unset-value" : "invalid-array-operation",
      `Cannot write element target ${target.label} because its root is not a set array`,
    );
  }
  const [position] = target.path;
  if (position === undefined || position >= current.length) {
    throw runtimeError(
      "array-index-out-of-range",
      `Array index ${String(position)} is out of range for length ${current.length}`,
    );
  }
  const next = cloneCellValue(current);
  if (!Array.isArray(next)) {
    throw new Error("Internal invariant: cloned array target is not an array");
  }
  const replacement = cloneCellValue(value);
  if (replacement === undefined) {
    throw new Error("Internal invariant: admitted array element is unset");
  }
  next[position] = replacement as ArrayElementValue;
  return writeOwnedCell(target.ownerTraversal, target.root, next);
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
  const observableSpec = requireObservableTarget(target);

  const workId = makeObservationId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
  );
  const resolution = accum.observationResults.get(workId);

  if (resolution) {
    if (resolution.status === "resolved" && resolution.value !== undefined) {
      assertAssignableValue(target.label, target.leafSpec, resolution.value);
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
      question: renderObservationQuestion(
        statement,
        target,
        observableSpec,
        traversal,
        node,
        accum,
      ),
      currentValue: cloneCellValue(target.value) as
        | PrimitiveValue
        | PrimitiveArrayValue
        | undefined,
      hostParams: admitFinitePayload(
        effectiveHostParams(node, accum),
        "host-bound emission",
      ),
      meta: observationMetaForTarget(observableSpec),
    });
  }
  return { status: "blocked" };
}

/**
 * Applies a grouped observation `$observe({ a, b })` as one atomic action. On
 * the plan phase it emits a single `ObservationGroupBrief` carrying every cell's
 * question and type metadata. On resolution it applies one report that addresses
 * all fields: any `needs-user` field keeps the whole group blocked (the group
 * re-emits and writes nothing), otherwise every `resolved` field is written
 * together and the group settles before execution advances.
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
    observableSpec: ObservableCellSpec;
  }[] = [];
  for (const authoredTarget of statement.targets) {
    const result = resolveCellTarget(authoredTarget, traversal, node, accum);
    if (result.status === "blocked") return result;
    targets.push({
      target: result.value,
      observableSpec: requireObservableTarget(result.value),
    });
  }
  const workId = makeObservationGroupId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
  );
  const resolution = accum.observationGroupResults.get(workId);

  if (resolution) {
    for (const { target } of targets) {
      if (resolution.fields[target.label]?.status === "needs-user") {
        return { status: "blocked" };
      }
    }
    const writes: {
      target: ResolvedCellTarget;
      value: PrimitiveValue | PrimitiveArrayValue;
    }[] = [];
    for (const { target } of targets) {
      const field = resolution.fields[target.label];
      if (!field || field.status !== "resolved" || field.value === undefined) {
        continue;
      }
      assertAssignableValue(target.label, target.leafSpec, field.value);
      writes.push({ target, value: field.value });
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
      ({ target, observableSpec }) => {
        return {
          cell: target.label,
          question: renderCellObservingQuestion(
            observableSpec,
            target.label,
            traversal,
            node,
            accum,
          ),
          currentValue: cloneCellValue(target.value) as
            | PrimitiveValue
            | PrimitiveArrayValue
            | undefined,
          meta: observationMetaForTarget(observableSpec),
        };
      },
    );
    accum.observations.push({
      kind: "observation-group",
      id: workId,
      sourceRef: traversalToNodeRef(traversal),
      mode,
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
function requireObservableTarget(
  target: ResolvedCellTarget,
): ObservableTargetSpec {
  if (!isObservableCellSpec(target.leafSpec)) {
    throw runtimeError(
      "invalid-observation-target",
      `$observe() cannot target ${target.label}`,
    );
  }
  return target.leafSpec;
}

/**
 * The extraction question authored on a cell: its own `observing` for a scalar
 * cell, or the element's `observing` for an array cell.
 */
function cellObservingText(
  spec: ObservableTargetSpec,
): SemanticString | undefined {
  return spec.type === "array" ? spec.element.observing : spec.observing;
}

/** The bare scalar shape of a declaration, without its authoring extras. */
function scalarMetaOf(spec: ObservableScalar): ScalarObservationMeta {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "number":
      if (spec.observeAs?.kind === "integer") {
        return {
          type: "rangedInt",
          min: spec.observeAs.min ?? Number.MIN_SAFE_INTEGER,
          max: spec.observeAs.max ?? Number.MAX_SAFE_INTEGER,
        };
      }
      return {
        type: "number",
        ...(spec.observeAs?.min !== undefined
          ? { min: spec.observeAs.min }
          : {}),
        ...(spec.observeAs?.max !== undefined
          ? { max: spec.observeAs.max }
          : {}),
      };
  }
}

/** Observation value metadata for a scalar or array cell. */
function observationMetaForTarget(
  spec: ObservableTargetSpec,
): ObservationValueMeta {
  if (spec.type === "array") {
    return { type: "array", element: scalarMetaOf(spec.element) };
  }
  return scalarMetaOf(spec);
}

/** Renders a cell's own `observing` question, or a default when it declares none. */
function renderCellObservingQuestion(
  spec: ObservableTargetSpec,
  targetLabel: string,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText {
  const observing = cellObservingText(spec);
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
): Pick<HostCallBrief, "arguments" | "hostParams"> {
  const renderedArguments = renderTypedHostArguments(
    statement,
    traversal,
    node,
    accum,
  );
  const rendered = {
    arguments: renderedArguments,
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
  if (action.arguments.length !== operation.parameters.length) {
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
      operation.parameters[index]!,
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
    expression.kind === "template-string" ||
    expression.kind === "arrayLiteral"
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
    if (isOrdering && decision.mode === "enum") {
      const enumValues = decision.enumValues ?? [];
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
        decision.mode === "artifact",
        decision.mode === "artifact",
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
    case "pendingState": {
      const finalizing = traversal.finalizing;
      if (!finalizing || finalizing.phase !== "effects") {
        throw new Error(
          "this.pendingState is only available while this.effects is running",
        );
      }
      return { status: "resolved", value: finalizing.reason };
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
    case "arrayElementRead": {
      const array = requireArrayValue(
        expression.array,
        traversal,
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
      return { status: "resolved", value: array[position] };
    }
    case "arrayLength": {
      const array = requireArrayValue(
        expression.array,
        traversal,
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

/**
 * Reads an array reference's current value, requiring it to be a set array.
 * Reading an element or `length` of an unset array is a runtime error, as is a
 * value that is somehow not an array (guarded defensively; validation rejects
 * non-array receivers statically).
 */
export function requireArrayValue(
  array: ArrayReference,
  traversal: Traversal,
  accum: Accumulator,
  operation: string,
): ArrayValue {
  const value =
    array.kind === "cell"
      ? getCellValue(array.name, traversal, accum)
      : readChannelValue(traversal, array.namespace, array.key, accum);
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
  const finalizing = traversal.finalizing;
  if (finalizing?.reason !== "deflected") {
    throw new Error(
      "this.deflection.escaped(...) is only available while a deflection is pending",
    );
  }

  // `from` is the canonical target of the entry the deflection propagated up
  // through. A node's own frontier deflection entered nothing, so `from` is
  // unset and `escaped` matches no target — self included.
  const from = finalizing.deflection.from;
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

export function renderObservationQuestion(
  statement: ObserveAction | ObserveOrAskAction,
  target: ResolvedCellTarget,
  spec: ObservableTargetSpec,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SemanticText {
  if (statement.question !== undefined)
    return renderSemanticText(statement.question, traversal, node, accum);
  const observing = cellObservingText(spec);
  if (observing === undefined) return `observe ${target.label}`;
  return renderSemanticText(observing, traversal, node, accum);
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
