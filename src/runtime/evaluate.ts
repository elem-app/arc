import type {
  ActionStatement,
  ArcRef,
  ArrayReference,
  BinaryOperator,
  Cell,
  CellSpec,
  CellTarget,
  CellValue,
  ChannelSpec,
  DialogCursor,
  EnterTarget,
  HostCallArgument,
  HostCallBrief,
  HostCallExpression,
  HostEffectBrief,
  HostEffectStatement,
  JudgeExpression,
  LocalExpression,
  Node,
  NodeRef,
  NodeState,
  ObservableCellSpec,
  ObservationGroupField,
  ObservationValueMeta,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  PayloadValue,
  PrimitiveValue,
  ScalarObservationMeta,
  ScalarSpec,
  SemanticString,
  SemanticText,
  SemanticTextPart,
  SetAction,
  Traversal,
  UnsetAction,
  ValueExpression,
  ValueString,
} from "../types.js";
import {
  isArrayValue,
  isObservableCellSpec,
  isPrimitiveValue,
  isSettableCell,
  qualifiedBriefSite,
} from "../types.js";
import { clonePayloadValue } from "./payload.js";
import {
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
  type Accumulator,
  briefSiteQualifiers,
  cellValuesEqual,
  childState,
  cloneCellValue,
  cloneDialogCursor,
  cloneHostCallBrief,
  makeHostCallId,
  makeHostEffectId,
  makeJudgeId,
  makeObservationGroupId,
  makeObservationId,
  noteBriefYield,
} from "./state.js";

export type ActionOutcome<T = undefined> =
  | { status: "resolved"; value: T }
  | { status: "blocked" };

type ResolvedCellTarget = {
  ownerTraversal: Traversal;
  root: string;
  rootCell: Cell;
  path: number[];
  leafSpec: CellSpec;
  label: string;
  value: CellValue | undefined;
};

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

  let leafSpec: CellSpec = owner.cell;
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
      !Number.isInteger(position) ||
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
  value: CellValue,
): { changed: boolean } {
  if (target.path.length === 0) {
    return writeOwnedCell(target.ownerTraversal, target.root, value);
  }
  if (target.path.length !== 1) {
    throw runtimeError(
      "invalid-cell-target",
      `${target.label} exceeds the supported array target depth`,
    );
  }
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
  if (!isPrimitiveValue(value)) {
    throw runtimeError(
      "invalid-cell-assignment",
      `${target.label}.$set() requires a scalar value`,
    );
  }
  const next = [...current];
  next[position] = value;
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
        | PrimitiveValue[]
        | undefined,
      hostParams: clonePayloadValue(effectiveHostParams(node, accum)),
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
      value: PrimitiveValue | PrimitiveValue[];
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
            | PrimitiveValue[]
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
      hostParams: clonePayloadValue(effectiveHostParams(node, accum)),
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
): ObservableCellSpec {
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
  spec: ObservableCellSpec,
): SemanticString | undefined {
  return spec.type === "array" ? spec.element.observing : spec.observing;
}

/** The bare scalar shape of a declaration, without its authoring extras. */
function scalarMetaOf(spec: ScalarSpec): ScalarObservationMeta {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec.values };
    case "rangedInt":
      return { type: "rangedInt", min: spec.min, max: spec.max };
  }
}

/** Observation value metadata for a scalar or array cell. */
function observationMetaForTarget(
  spec: ObservableCellSpec,
): ObservationValueMeta {
  if (spec.type === "array") {
    return { type: "array", element: scalarMetaOf(spec.element) };
  }
  return scalarMetaOf(spec);
}

/** Renders a cell's own `observing` question, or a default when it declares none. */
function renderCellObservingQuestion(
  spec: ObservableCellSpec,
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
  assertAssignableValue(target.label, target.leafSpec, value.value);
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
  assertAssignableChannelValue(statement.key, declared, value.value);
  // `returns.*` is readable in the same SEG via `readChannelValue`, so the
  // staged value is its own change signal. The caller-cell commit stays at
  // enter resolution (bracketed by the enter's wide snapshot), so this does not
  // route through `writeOwnedCell`.
  const nextStaged = value.value as CellValue;
  const changed = !cellValuesEqual(
    traversal.enterChannels.stagedReturns[statement.key],
    nextStaged,
  );
  traversal.enterChannels.stagedReturns[statement.key] = nextStaged;
  return { status: "resolved", value: { changed } };
}

/**
 * Validates a value against a typed channel schema — the arm shared by a return
 * write and (later) span-result and args-projection checks. Mirrors
 * {@link assertAssignableValue} but keys off a {@link ChannelSpec} rather than a
 * lexical cell.
 */
function assertAssignableChannelValue(
  key: string,
  spec: ChannelSpec,
  value: unknown,
): asserts value is CellValue {
  if (value == null) {
    throw runtimeError(
      "invalid-return-value",
      `returns.${key}.$set() cannot assign null or undefined`,
    );
  }
  switch (spec.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw runtimeError(
          "invalid-return-value",
          `returns.${key}.$set() requires a boolean value`,
        );
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw runtimeError(
          "invalid-return-value",
          `returns.${key}.$set() requires a string value`,
        );
      }
      return;
    case "index":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw runtimeError(
          "invalid-return-value",
          `returns.${key}.$set() requires a non-negative integer`,
        );
      }
      return;
    case "rangedInt":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw runtimeError(
          "invalid-return-value",
          `returns.${key}.$set() requires an integer value`,
        );
      }
      if (value < spec.min || value > spec.max) {
        throw runtimeError(
          "cell-out-of-range",
          `returns.${key}.$set() value ${value} is outside ${spec.min}..${spec.max}`,
        );
      }
      return;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw runtimeError(
          "invalid-enum-value",
          `returns.${key}.$set() must use one of ${spec.values.join(", ")}`,
        );
      }
      return;
    case "dialogCursor":
      assertDialogCursor(value, `returns.${key}.$set()`);
      return;
    case "array":
      if (!Array.isArray(value)) {
        throw runtimeError(
          "invalid-return-value",
          `returns.${key}.$set() requires an array value`,
        );
      }
      for (const element of value) {
        assertAssignableChannelValue(key, spec.element, element);
      }
      return;
  }
}

export function renderHostEffect(
  statement: HostEffectStatement,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): HostEffectBrief {
  return {
    id: makeHostEffectId(accum.entry.arc, traversal, statement.id),
    sourceRef: traversalToNodeRef(traversal),
    module: statement.module,
    target: [...statement.target],
    operation: statement.operation,
    arguments: statement.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, accum),
    ),
  };
}

export function renderHostCallArgument(
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
    return value.value;
  }
  if (arg.kind === "array") {
    return arg.elements.map((item) =>
      renderHostCallArgument(item, traversal, node, accum),
    );
  }
  return Object.fromEntries(
    Object.entries(arg.value).map(([key, value]) => [
      key,
      renderHostCallArgument(value, traversal, node, accum),
    ]),
  );
}

// A host-call result is a sigil-less value: it pins for the rest of the walk
// on the SEG's tape (hydrated in place when the report arrives) and releases on
// dial-back. Arguments render on every visit — before the pin settles — so the
// visit's evaluation order stays prefix-stable for span replay.
export function evaluateHostCall(
  expression: HostCallExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue> {
  const id = makeHostCallId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), expression.id),
  );
  const renderedArguments = expression.arguments.map((arg) =>
    renderHostCallArgument(arg, traversal, node, accum),
  );
  const settled = settleHostCallPin(
    accum,
    id,
    accum.hostCallResults.has(id)
      ? { value: accum.hostCallResults.get(id) }
      : undefined,
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
        hostParams: clonePayloadValue(effectiveHostParams(node, accum)),
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
      hostParams: clonePayloadValue(effectiveHostParams(node, accum)),
    });
  }
  return { status: "blocked" };
}

type CompoundValueExpression = Exclude<
  ValueExpression,
  LocalExpression | HostCallExpression | JudgeExpression
>;

function isCompoundValueExpression(
  expression: ValueExpression,
): expression is CompoundValueExpression {
  return (
    expression.kind === "regexTest" ||
    expression.kind === "binary" ||
    expression.kind === "logical" ||
    expression.kind === "conditional" ||
    expression.kind === "unary" ||
    expression.kind === "template-string" ||
    expression.kind === "arrayLiteral"
  );
}

export function evaluateValueExpression(
  expression: ValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue | NodeState> {
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
  compute: () => ActionOutcome<PayloadValue | NodeState>,
): ActionOutcome<PayloadValue | NodeState> {
  const pin = beginValuePin(accum);
  if (pin.status === "replayed") {
    return { status: "resolved", value: pin.value as PayloadValue | NodeState };
  }
  const result = compute();
  if (result.status === "resolved") {
    completeValuePin(pin.reservation, result.value as PayloadValue);
  }
  return result;
}

function computeCompoundValueExpression(
  expression: CompoundValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue | NodeState> {
  if (expression.kind === "regexTest") {
    const target = evaluateLocalExpression(
      expression.target,
      traversal,
      node,
      accum,
    );
    if (target.status === "blocked") return target;
    const value = target.value;
    if (typeof value !== "string") return { status: "resolved", value: false };
    return {
      status: "resolved",
      value: new RegExp(expression.pattern, expression.flags).test(value),
    };
  }
  if (expression.kind === "binary") {
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
    if (isOrdering) {
      if (left.value === undefined || right.value === undefined) {
        return { status: "resolved", value: false };
      }
      const enumValues =
        findEnumValues(expression.left, traversal, accum) ??
        findEnumValues(expression.right, traversal, accum);
      if (enumValues) {
        const li =
          typeof left.value === "string" ? enumValues.indexOf(left.value) : -1;
        const ri =
          typeof right.value === "string"
            ? enumValues.indexOf(right.value)
            : -1;
        return {
          status: "resolved",
          value: evaluateBinary(expression.op, li, ri),
        };
      }
    }
    return {
      status: "resolved",
      value: evaluateBinary(expression.op, left.value, right.value),
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
  if (expression.kind === "template-string") {
    return computeValueText(expression, traversal, node, accum);
  }
  if (expression.kind === "arrayLiteral") {
    const elements: PrimitiveValue[] = [];
    for (const element of expression.elements) {
      const value = evaluateValueExpression(element, traversal, node, accum);
      if (value.status === "blocked") return value;
      if (!isPrimitiveValue(value.value)) {
        throw runtimeError(
          "invalid-array-literal",
          "Array literal elements must be primitive values",
        );
      }
      elements.push(value.value);
    }
    return { status: "resolved", value: elements };
  }
  throw new Error("Unknown compound value expression");
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
    // Arrays interpolate via JS array stringification (comma-joined; empty →
    // ""); a dialog cursor and other non-primitive objects are rejected.
    if (!isPrimitiveValue(value.value) && !isArrayValue(value.value)) {
      throw runtimeError(
        "invalid-template-interpolation",
        `Template interpolation must resolve to a primitive value or array; got ${value.value === null ? "null" : typeof value.value}.`,
      );
    }
    rendered += String(value.value);
  }
  return { status: "resolved", value: rendered };
}

export function evaluateLocalExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue | NodeState> {
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
): ActionOutcome<PayloadValue | NodeState> {
  switch (expression.kind) {
    case "literal":
      return { status: "resolved", value: expression.value };
    case "cell":
      return {
        status: "resolved",
        value: getCellValue(expression.name, traversal, accum),
      };
    case "isUnset":
      return {
        status: "resolved",
        value: getCellValue(expression.cell, traversal, accum) === undefined,
      };
    case "channel":
      return {
        status: "resolved",
        value: readChannelValue(
          traversal,
          expression.namespace,
          expression.key,
          accum,
        ),
      };
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
        !Number.isInteger(position) ||
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
): PrimitiveValue[] {
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

export function getCellValue(
  cell: string,
  traversal: Traversal,
  accum: Accumulator,
): CellValue | undefined {
  return cloneCellValue(
    findCellOwner(cell, traversal, accum)?.traversal.cells[cell],
  );
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
    return channelState.stagedReturns[key];
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
  if (link.kind === "spanValue") {
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
  const next = cloneCellValue(value);
  const changed = !cellValuesEqual(ownerTraversal.cells[name], next);
  ownerTraversal.cells[name] = next;
  return { changed };
}

export function findEnumValues(
  expression: ValueExpression,
  traversal: Traversal,
  accum: Accumulator,
): string[] | undefined {
  if (expression.kind === "cell") {
    const meta = getCellMeta(expression.name, traversal, accum);
    if (meta?.type === "enum" && meta.values) return meta.values;
  }
  return undefined;
}

export function renderObservationQuestion(
  statement: ObserveAction | ObserveOrAskAction,
  target: ResolvedCellTarget,
  spec: ObservableCellSpec,
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
  if (value == null)
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() cannot assign null or undefined`,
    );
  if (spec.type === "artifact") {
    throw runtimeError(
      "invalid-cell-assignment",
      `${cell}.$set() cannot assign this cell`,
    );
  }
  if (spec.type === "dialogCursor") {
    assertDialogCursor(value, `${cell}.$set()`);
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) {
      throw runtimeError(
        "invalid-cell-assignment",
        `${cell}.$set() requires an array value`,
      );
    }
    for (const element of value) {
      assertAssignableScalar(cell, spec.element, element);
    }
    return;
  }
  assertAssignableScalar(cell, spec, value);
}

/**
 * Validates one scalar value against a scalar cell spec — the shared arm for a
 * scalar cell assignment and for every element of an array cell assignment.
 */
function assertAssignableScalar(
  cell: string,
  spec: ScalarObservationMeta,
  value: unknown,
): asserts value is PrimitiveValue {
  if (spec.type === "boolean") {
    if (typeof value !== "boolean")
      throw runtimeError(
        "invalid-cell-assignment",
        `${cell}.$set() requires a boolean value`,
      );
    return;
  }
  if (spec.type === "string") {
    if (typeof value !== "string")
      throw runtimeError(
        "invalid-cell-assignment",
        `${cell}.$set() requires a string value`,
      );
    return;
  }
  if (spec.type === "rangedInt") {
    if (typeof value !== "number" || !Number.isInteger(value))
      throw runtimeError(
        "invalid-cell-assignment",
        `${cell}.$set() requires an integer value`,
      );
    if (
      (spec.min !== undefined && value < spec.min) ||
      (spec.max !== undefined && value > spec.max)
    ) {
      throw runtimeError(
        "cell-out-of-range",
        `${cell}.$set() value ${value} is outside ${spec.min}..${spec.max}`,
      );
    }
    return;
  }
  if (typeof value !== "string" || !spec.values?.includes(value)) {
    throw runtimeError(
      "invalid-enum-value",
      `${cell}.$set() must use one of ${spec.values?.join(", ")}`,
    );
  }
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
  if (!isDialogCursor(value)) {
    throw runtimeError(
      "invalid-dialog-cursor",
      `${label} must be a valid Dialog cursor`,
    );
  }
}

function isDialogCursor(value: unknown): value is DialogCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(cursor.user) &&
    Number.isSafeInteger(cursor.self) &&
    (cursor.user as number) >= 0 &&
    (cursor.self as number) >= 0 &&
    (cursor.view === undefined || typeof cursor.view === "string")
  );
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

    const expression = part.expression;
    if (expression.kind === "cell") {
      const cell = getCellMeta(expression.name, traversal, accum);
      if (cell?.type === "artifact") {
        parts.push({
          kind: "artifact",
          path: renderArtifactPath(cell, traversal, node, accum),
        });
        deferred = true;
        continue;
      }
    }

    const value = evaluateValueExpression(expression, traversal, node, accum);
    if (value.status === "blocked") continue;
    if (value.value === undefined) {
      throw runtimeError(
        "invalid-template-interpolation",
        "Semantic template interpolation cannot use an unset value",
      );
    }
    pushText(value.value == null ? "" : String(value.value));
  }

  if (!deferred) {
    return parts
      .map((part) => (part.kind === "text" ? part.value : ""))
      .join("");
  }
  return parts;
}

function renderArtifactPath(
  cell: Extract<Cell, { type: "artifact" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): string {
  const path =
    typeof cell.path === "string"
      ? cell.path
      : renderArtifactTemplatePath(cell.path, traversal, node, accum);
  validateRenderedArtifactPath(cell.name, path);
  return path;
}

function renderArtifactTemplatePath(
  path: ValueString,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): string {
  const rendered = evaluateValueExpression(path, traversal, node, accum);
  if (rendered.status === "blocked") {
    throw runtimeError(
      "invalid-artifact-path",
      "Artifact path template cannot contain blocked work",
    );
  }
  if (typeof rendered.value !== "string") {
    throw new Error("Artifact path template resolved to a non-string value");
  }
  return rendered.value;
}

function validateRenderedArtifactPath(name: string, path: string): void {
  if (path.length === 0) {
    throw runtimeError(
      "invalid-artifact-path",
      `Artifact ${name} path cannot be empty`,
    );
  }
  if (path.startsWith("/")) {
    throw runtimeError(
      "invalid-artifact-path",
      `Artifact ${name} path must be relative`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw runtimeError(
        "invalid-artifact-path",
        `Artifact ${name} path cannot contain "." or ".." segments`,
      );
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
  if (typeof value !== "boolean") {
    throw runtimeError(
      "non-boolean-value",
      "Only a boolean value can be evaluated as a boolean; compare a non-boolean value explicitly",
    );
  }
  return value;
}

/** Structural equality of two ordered arrays by element value. */
function arraysStructurallyEqual(left: unknown[], right: unknown[]): boolean {
  return (
    left.length === right.length &&
    left.every((element, index) => element === right[index])
  );
}

function evaluateBinary(
  op: BinaryOperator,
  left: unknown,
  right: unknown,
): boolean {
  const arrayOperand = Array.isArray(left) || Array.isArray(right);
  switch (op) {
    case "==":
    case "===":
      if (left === undefined || right === undefined) return false;
      if (arrayOperand) {
        return (
          Array.isArray(left) &&
          Array.isArray(right) &&
          arraysStructurallyEqual(left, right)
        );
      }
      return left === right;
    case "!=":
    case "!==":
      if (left === undefined || right === undefined) return true;
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
