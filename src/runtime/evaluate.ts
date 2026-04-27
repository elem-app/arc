import type {
  ActionStatement,
  ArcRef,
  BinaryOperator,
  EnterTarget,
  HostCallArgument,
  HostCallBrief,
  HostCallExpression,
  HostEffect,
  HostEffectStatement,
  JudgeExpression,
  LocalExpression,
  Node,
  NodeRef,
  NodeState,
  ObserveAction,
  ObserveOrAskAction,
  PayloadValue,
  PrimitiveValue,
  SemanticString,
  SetAction,
  Traversal,
  ValueExpression,
  Variable,
} from "../types.js";
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
import {
  type Accumulator,
  childState,
  cloneHostCallBrief,
  makeHostCallId,
  makeJudgeId,
  makeObservationId,
  noteBriefYield,
} from "./state.js";

export type ActionOutcome<T = undefined> =
  | { status: "resolved"; value: T }
  | { status: "blocked" };

export function applyObserve(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome {
  const workId = makeObservationId(accum.entry.arc, traversal, statement.id);
  const resolution = accum.observationResults.get(workId);

  if (resolution) {
    if (resolution.status === "resolved" && resolution.value !== undefined) {
      const variable = getVariableMeta(statement.variable, traversal, accum);
      if (!variable) {
        throw new Error(
          `Unknown variable for observe(): ${statement.variable}`,
        );
      }
      assertAssignableValue(statement.variable, variable, resolution.value);
      setVariableValue(
        statement.variable,
        resolution.value,
        traversal,
        node,
        accum,
      );
      return { status: "resolved", value: undefined };
    }
    if (statement.kind === "observe" && resolution.status !== "needs-user") {
      return { status: "resolved", value: undefined };
    }
    return { status: "blocked" };
  }

  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    const variable = getVariableMeta(statement.variable, traversal, accum);
    if (!variable) {
      throw new Error(`Unknown variable for observe(): ${statement.variable}`);
    }
    accum.observations.push({
      id: workId,
      sourceRef: traversalToNodeRef(traversal),
      variable: statement.variable,
      mode: statement.kind,
      question: renderObservationQuestion(statement, traversal, node, accum),
      currentValue: getVariableValue(statement.variable, traversal, accum),
      meta: {
        type: variable.type,
        values: variable.values,
        min: variable.min,
        max: variable.max,
      },
    });
  }
  return { status: "blocked" };
}

export function applySet(
  statement: SetAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome {
  const owner = findVariableOwner(statement.variable, traversal, accum);
  if (!owner)
    throw new Error(`Unknown variable for set(): ${statement.variable}`);
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
  );
  if (value.status === "blocked") return { status: "blocked" };
  if (
    value.value !== undefined &&
    value.value !== null &&
    typeof value.value !== "string" &&
    typeof value.value !== "number" &&
    typeof value.value !== "boolean"
  ) {
    throw new Error(
      `${statement.variable}.set() requires a primitive host call result`,
    );
  }
  assertAssignableValue(statement.variable, owner.variable, value.value);
  owner.traversal.variables[statement.variable] = value.value ?? undefined;
  return { status: "resolved", value: undefined };
}

export function applySetReturn(
  statement: Extract<ActionStatement, { kind: "set-return" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome {
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
  );
  if (value.status === "blocked") return { status: "blocked" };
  if (
    value.value !== undefined &&
    value.value !== null &&
    typeof value.value !== "string" &&
    typeof value.value !== "number" &&
    typeof value.value !== "boolean"
  ) {
    throw new Error(
      `returns.${statement.key}.set() requires a primitive host call result`,
    );
  }
  const callerVarRef = traversal.enterChannels.returns[statement.key];
  if (!callerVarRef) {
    throw new Error(
      `Unknown return channel key "${statement.key}" for ${formatRef(traversalToNodeRef(traversal))}`,
    );
  }
  const callerTraversal = findTraversalInSet(
    accum.traversals,
    callerVarRef.ownerRef,
  );
  if (!callerTraversal) {
    throw new Error(
      `Return channel caller-owner traversal not found for binding: ${formatRef(callerVarRef.ownerRef)}`,
    );
  }
  const ownerEntry = getEntryForRef(accum.entries, callerVarRef.ownerRef);
  const ownerNode = ownerEntry
    ? getNodeForRef(accum.entries, ownerEntry, callerVarRef.ownerRef)
    : undefined;
  const ownerVariable = ownerNode?.variables.find(
    (item) => item.name === callerVarRef.variable,
  );
  if (!ownerVariable) {
    throw new Error(
      `Return channel binding references unknown caller variable "${callerVarRef.variable}" on ${formatRef(callerVarRef.ownerRef)}`,
    );
  }
  assertAssignableValue(
    callerVarRef.variable,
    ownerVariable,
    value.value as PrimitiveValue | undefined,
  );
  traversal.enterChannels.stagedReturns[statement.key] =
    value.value as PrimitiveValue;
  return { status: "resolved", value: undefined };
}

export function renderHostEffect(
  statement: HostEffectStatement,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): HostEffect {
  return {
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
    return renderSemanticString(arg.value, traversal, node, accum);
  }
  if (arg.kind === "value") {
    const value = evaluateValueExpression(arg.value, traversal, node, accum);
    if (value.status === "blocked") {
      throw new Error("Host call value argument cannot block");
    }
    return value.value;
  }
  if (arg.kind === "array") {
    return arg.value.map((item) =>
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

// Host-call expressions do not persist their resolved value in node frame
// state. A later re-walk or resumed execution walk re-evaluates them
// against the current accepted report via `accum.hostCallResults`.
export function evaluateHostCall(
  expression: HostCallExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue> {
  const id = makeHostCallId(accum.entry.arc, traversal, expression.id);
  if (accum.hostCallResults.has(id)) {
    return { status: "resolved", value: accum.hostCallResults.get(id) };
  }
  const rendered = {
    id,
    sourceRef: traversalToNodeRef(traversal),
    module: expression.module,
    target: [...expression.target],
    operation: expression.operation,
    arguments: expression.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, accum),
    ),
  } satisfies HostCallBrief;
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.hostCalls.push(cloneHostCallBrief(rendered));
  }
  return { status: "blocked" };
}

// Judge expressions do not persist their resolved value in node
// frame state. A later re-walk or resumed execution walk re-evaluates them
// against the current accepted report via `accum.judgmentResults`.
export function evaluateJudge(
  expression: JudgeExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<boolean> {
  const rendered = renderSemanticString(
    expression.question,
    traversal,
    node,
    accum,
  );
  const id = makeJudgeId(accum.entry.arc, traversal, expression.id);
  const result = accum.judgmentResults.get(id);
  if (result !== undefined) return { status: "resolved", value: result };
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.judgments.push({
      id,
      sourceRef: traversalToNodeRef(traversal),
      question: rendered,
    });
  }
  return { status: "blocked" };
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
      return evaluateValueExpression(expression.right, traversal, node, accum);
    }
    if (truthy(left.value)) return { status: "resolved", value: left.value };
    return evaluateValueExpression(expression.right, traversal, node, accum);
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
  return evaluateLocalExpression(expression, traversal, node, accum);
}

export function evaluateLocalExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<PayloadValue | NodeState> {
  switch (expression.kind) {
    case "literal":
      return { status: "resolved", value: expression.value };
    case "ref":
      return {
        status: "resolved",
        value: accum.dialog.names?.[expression.name] ?? expression.name,
      };
    case "variable":
      return {
        status: "resolved",
        value: getVariableValue(expression.name, traversal, accum),
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
    case "deflectionFrom":
      return {
        status: "resolved",
        value: matchesDeflectionTarget(
          expression.target,
          traversal,
          node,
          accum,
        ),
      };
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
  }
}

function matchesDeflectionTarget(
  target: EnterTarget,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): boolean {
  const active = accum.deflectionActive;
  if (!active) return false;
  const activeTraversal = findTraversalInSet(accum.traversals, active);
  if (!activeTraversal) return false;

  const ref = resolveRefInTraversal(
    accum,
    traversal,
    node,
    target.identifier,
    target.imported,
  );
  if (!ref) return false;
  return (isArcRef(ref) ? arcToNodeRef(ref) : ref) === active;
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

export function findVariableOwner(
  variable: string,
  traversal: Traversal,
  accum: Accumulator,
): { traversal: Traversal; variable: Variable } | undefined {
  let ref: NodeRef | undefined = traversalToNodeRef(traversal);
  while (ref) {
    const entry = getEntryForRef(accum.entries, ref);
    if (!entry) return undefined;
    const node = getNodeForRef(accum.entries, entry, ref);
    const found = node?.variables.find((item) => item.name === variable);
    if (found) {
      const ownerTraversal = findTraversalInSet(accum.traversals, ref);
      if (!ownerTraversal) break;
      return { traversal: ownerTraversal, variable: found };
    }
    ref = lexicalParentRef(ref);
  }
  return undefined;
}

export function getVariableMeta(
  variable: string,
  traversal: Traversal,
  accum: Accumulator,
): Variable | undefined {
  return findVariableOwner(variable, traversal, accum)?.variable;
}

export function getVariableValue(
  variable: string,
  traversal: Traversal,
  accum: Accumulator,
): PrimitiveValue | undefined {
  return findVariableOwner(variable, traversal, accum)?.traversal.variables[
    variable
  ];
}

export function readChannelValue(
  traversal: Traversal,
  namespace: "args" | "returns",
  key: string,
  accum: Accumulator,
): PrimitiveValue | undefined {
  const channelState = traversal.enterChannels;
  if (namespace === "returns" && key in channelState.stagedReturns) {
    return channelState.stagedReturns[key];
  }
  const callerVarRef = channelState[namespace][key];
  if (!callerVarRef) {
    throw new Error(
      `Unknown ${namespace} channel key "${key}" for ${formatRef(traversalToNodeRef(traversal))}`,
    );
  }
  const callerTraversal = findTraversalInSet(
    accum.traversals,
    callerVarRef.ownerRef,
  );
  if (!callerTraversal) {
    throw new Error(
      `${namespace}.${key} caller-owner traversal not found for binding: ${formatRef(callerVarRef.ownerRef)}`,
    );
  }
  return callerTraversal.variables[callerVarRef.variable];
}

export function setVariableValue(
  variable: string,
  value: PrimitiveValue | undefined,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): void {
  const owner = findVariableOwner(variable, traversal, accum);
  if (!owner)
    throw new Error(`Unknown variable: ${variable} in ${node.identifier}`);
  owner.traversal.variables[variable] = value;
}

export function findEnumValues(
  expression: ValueExpression,
  traversal: Traversal,
  accum: Accumulator,
): string[] | undefined {
  if (expression.kind === "variable") {
    const meta = getVariableMeta(expression.name, traversal, accum);
    if (meta?.type === "enum" && meta.values) return meta.values;
  }
  return undefined;
}

export function renderObservationQuestion(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): string {
  if (statement.question)
    return renderSemanticString(statement.question, traversal, node, accum);
  const variable = getVariableMeta(statement.variable, traversal, accum);
  if (!variable?.observing) return `observe ${statement.variable}`;
  return renderSemanticString(variable.observing, traversal, node, accum);
}

export function assertAssignableValue(
  variable: string,
  meta: Variable,
  value: PrimitiveValue | NodeState | undefined | null,
): void {
  if (value == null)
    throw new Error(`${variable}.set() cannot assign null or undefined`);
  if (meta.type === "boolean") {
    if (typeof value !== "boolean")
      throw new Error(`${variable}.set() requires a boolean value`);
    return;
  }
  if (meta.type === "rangedInt") {
    if (typeof value !== "number")
      throw new Error(`${variable}.set() requires a numeric value`);
    if (
      (meta.min !== undefined && value < meta.min) ||
      (meta.max !== undefined && value > meta.max)
    ) {
      throw new Error(
        `${variable}.set() value ${value} is outside ${meta.min}..${meta.max}`,
      );
    }
    return;
  }
  if (typeof value !== "string" || !meta.values?.includes(value)) {
    throw new Error(
      `${variable}.set() must use one of ${meta.values?.join(", ")}`,
    );
  }
}

export function renderSemanticString(
  semantic: SemanticString,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): string {
  return semantic.parts
    .map((part) => {
      if (part.kind === "text") return part.value;
      const value = evaluateValueExpression(
        part.expression,
        traversal,
        node,
        accum,
      );
      if (value.status === "blocked") return "";
      return value.value == null ? "" : String(value.value);
    })
    .join("");
}

export function truthy(value: unknown): boolean {
  return Boolean(value);
}

function evaluateBinary(
  op: BinaryOperator,
  left: unknown,
  right: unknown,
): boolean {
  switch (op) {
    case "==":
    case "===":
      return left === right;
    case "!=":
    case "!==":
      return left !== right;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
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
