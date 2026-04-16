import type {
  ActionStatement,
  ArcRef,
  ArcTraversal,
  CallerVarRef,
  EffectStatement,
  GuardStatement,
  HostEffect,
  InstructionAction,
  InstructionBrief,
  InstructionPostcheck,
  Node,
  NodeRef,
  NodeState,
  PayloadValue,
  PendingEffects,
  Statement,
  Traversal,
  TriggerStatement,
} from "../types.js";
import {
  applyObserve,
  applySet,
  applySetReturn,
  evaluateValueExpression,
  findVariableOwner,
  renderHostEffect,
  renderSemanticString,
  resolveRefInTraversal,
  truthy,
} from "./evaluate.js";
import {
  findTraversalInSet,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  isArcRef,
  isArcTraversal,
  rootRefOf,
  toNodeRef,
  toNodeRefParts,
  toPseudoChildRef,
  traversalToNodeRef,
} from "./refs.js";
import {
  type Accumulator,
  type EnterIterationStatus,
  type EvalResult,
  type RegistryEntry,
  type RunStatus,
  canBatchInstruction,
  clearActionState,
  clearEvaluatorActionStates,
  clearFrame,
  cloneInstructionPostcheck,
  createEmptyEnterChannelState,
  createFreshArcTraversal,
  createFreshNodeTraversal,
  dedupeBriefIds,
  ensureEphemeralTraversal,
  ensureOwnedTraversal,
  enterLoopFrameKey,
  getActionState,
  getEvaluatorActionState,
  instructionBatchSignature,
  instructionResolutionFrameKey,
  isInstructionBatchActive,
  isNodeState,
  isResolvedActionState,
  isStopped,
  makeInstructionId,
  markActionResolved,
  markEvaluatorActionResolved,
  markPendingActionState,
  noteBriefYield,
  replaceEphemeralTraversal,
  selectActionRootTraversal,
  setActiveTraversal,
} from "./state.js";

export function runTrigger(
  node: Node,
  traversal: Traversal,
  accum: Accumulator,
): boolean {
  if (!node.trigger) return true;
  const result = runTriggerStatements(
    node,
    traversal,
    node.trigger,
    accum,
    "trigger",
  );
  if (result.status === "blocked") return false;
  clearEvaluatorActionStates(traversal, "trigger");
  return truthy(result.value);
}

export function runTriggerStatements(
  node: Node,
  traversal: Traversal,
  statements: TriggerStatement[],
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return blockTraversal(accum, traversal);
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const branchResult = runTriggerStatements(
        node,
        traversal,
        branch,
        accum,
        frameKey,
      );
      if (branchResult.status === "blocked") return branchResult;
      if (truthy(branchResult.value)) return branchResult;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return { status: "value", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return blockTraversal(accum, traversal);
      return { status: "value", value: truthy(result.value) };
    }

    if (
      isResolvedActionState(
        getEvaluatorActionState(traversal, frameKey, statement),
      )
    ) {
      continue;
    }

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") return blockTraversal(accum, traversal);
      markEvaluatorActionResolved(traversal, frameKey, statement);
      continue;
    }
  }

  return { status: "value", value: false };
}

export function runGuardStatements(
  node: Node,
  traversal: Traversal,
  statements: GuardStatement[],
  accum: Accumulator,
): NodeState | undefined {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        blockTraversal(accum, traversal);
        return undefined;
      }
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const state = runGuardStatements(node, traversal, branch, accum);
      if (accum.blocked || state) return state;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return undefined;
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        blockTraversal(accum, traversal);
        return undefined;
      }
      return isNodeState(result.value) ? result.value : undefined;
    }

    if (isResolvedActionState(getActionState(traversal, statement))) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") {
        blockTraversal(accum, traversal);
        return undefined;
      }
      markActionResolved(traversal, statement);
      continue;
    }
  }

  return undefined;
}

export function runTurn(accum: Accumulator): void {
  const rootNode = getNodeForRef(
    accum.entries,
    accum.entry,
    accum.traversal.ref,
  );
  if (!rootNode)
    throw new Error(
      `Unknown root traversal node: ${formatRef(accum.traversal.ref)}`,
    );
  if (isArcTraversal(accum.traversal) && accum.traversal.pendingEffects) {
    const pendingEffects = accum.traversal.pendingEffects;
    const status = runPendingEffects(accum, pendingEffects);
    if (status.status !== "done") return;
    completePendingEffects(accum, pendingEffects);
    return;
  }
  const status = runTraversal(accum.traversal, rootNode, accum, true);
  if (status.status === "break") {
    throw new Error(`Unhandled break label: ${status.label}`);
  }
  if (status.status === "deflected") {
    const rootTraversal = accum.traversal;
    if (!isArcTraversal(rootTraversal) || !rootTraversal.pendingEffects) {
      throw new Error("Deflected root traversal is missing pending effects");
    }
    const pendingEffects = rootTraversal.pendingEffects;
    const pendingStatus = runPendingEffects(accum, pendingEffects);
    if (pendingStatus.status !== "done") return;
    completePendingEffects(accum, pendingEffects);
    return;
  }
  if (status.status !== "done") return;
  accum.traversal.state = "covered";
  if (isArcTraversal(accum.traversal)) {
    accum.traversal.phase = "completed";
  }
}

export function runTraversal(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  isRoot = false,
): RunStatus {
  setActiveTraversal(accum, traversal);

  if (!isRoot) {
    if (traversal.state === "covered" || traversal.state === "skipped") {
      return { status: "done" };
    }
    if (node.guard) {
      const guardState = runGuardStatements(node, traversal, node.guard, accum);
      if (accum.blocked) return { status: "blocked" };
      if (guardState) {
        traversal.state = guardState;
        return { status: "done" };
      }
    }
  }

  for (let index = 0; index < node.statements.length; index++) {
    const statement = node.statements[index];
    if (!statement) continue;
    const status = runStatement(traversal, node, statement, accum);
    if (status.status !== "done") return status;
  }

  if (isInstructionBatchActive(accum, traversal)) {
    return { status: "yielded" };
  }

  const effects = runEffects(traversal, node, accum);
  if (effects.status !== "done") return effects;

  traversal.state = "covered";
  if (isArcTraversal(traversal)) {
    traversal.phase = "completed";
  }
  return { status: "done" };
}

export function runStatementBlock(
  traversal: Traversal,
  node: Node,
  statements: Statement[],
  accum: Accumulator,
): RunStatus {
  for (const statement of statements) {
    const status = runStatement(traversal, node, statement, accum);
    if (status.status !== "done") return status;
  }
  return { status: "done" };
}

export function runStatement(
  traversal: Traversal,
  node: Node,
  statement: Statement,
  accum: Accumulator,
): RunStatus {
  if (statement.kind === "if") {
    const result = evaluateValueExpression(
      statement.test,
      traversal,
      node,
      accum,
    );
    if (result.status === "blocked") {
      if (isInstructionBatchActive(accum, traversal)) {
        return { status: "yielded" };
      }
      return blockTraversal(accum, traversal);
    }
    const branch = truthy(result.value)
      ? statement.consequent
      : (statement.alternate ?? []);
    return runStatementBlock(traversal, node, branch, accum);
  }

  if (statement.kind === "label") {
    const status = runStatementBlock(traversal, node, statement.body, accum);
    if (status.status === "break" && status.label === statement.label) {
      return { status: "done" };
    }
    return status;
  }

  if (statement.kind === "break") {
    return { status: "break", label: statement.label };
  }

  return runAction(traversal, node, statement, accum);
}

export function runAction(
  traversal: Traversal,
  node: Node,
  statement: ActionStatement,
  accum: Accumulator,
): RunStatus {
  if (isResolvedActionState(getActionState(traversal, statement))) {
    return { status: "done" };
  }

  if (
    statement.kind === "instruction" &&
    isInstructionBatchActive(accum, traversal) &&
    !canBatchInstruction(accum, statement)
  ) {
    return { status: "yielded" };
  }

  if (
    isInstructionBatchActive(accum, traversal) &&
    statement.kind !== "instruction"
  ) {
    return { status: "yielded" };
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    const status = applyObserve(statement, traversal, node, accum);
    if (status.status === "blocked") return blockTraversal(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "set") {
    const apply = applySet(statement, traversal, node, accum);
    if (apply.status === "blocked") return blockTraversal(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "set-return") {
    const apply = applySetReturn(statement, traversal, node, accum);
    if (apply.status === "blocked") return blockTraversal(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "instruction") {
    return runInstructionAction(traversal, node, statement, accum);
  }

  if (statement.kind === "enter-node") {
    return runEnterNodeAction(traversal, node, statement, accum);
  }

  if (statement.kind === "enter-loop") {
    return runEnterLoopAction(traversal, node, statement, accum);
  }

  return { status: "done" };
}

function runEnterNodeAction(
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" }>,
  accum: Accumulator,
): RunStatus {
  const target = resolveEnterTarget(accum, traversal, node, statement);
  if (!target) {
    throw new Error(
      `Missing child node implementation: ${statement.target.identifier}`,
    );
  }

  const result = runEnterIteration(traversal, node, statement, target, accum);
  if (result.status === "blocked") {
    return result;
  }
  if (result.status === "deflected" || result.status === "yielded") {
    return result;
  }
  if (result.finalState === "covered") {
    commitEnterReturnChannels(result.traversal, accum);
  }
  if (result.finalState === "covered" || result.finalState === "skipped") {
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function runEnterLoopAction(
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-loop" }>,
  accum: Accumulator,
): RunStatus {
  const target = resolveEnterTarget(accum, traversal, node, statement);
  if (!target) {
    throw new Error(
      `Missing child node implementation: ${statement.target.identifier}`,
    );
  }

  while (true) {
    const result = runEnterIteration(traversal, node, statement, target, accum);
    if (result.status === "blocked") {
      return result;
    }
    if (result.status === "deflected" || result.status === "yielded") {
      return result;
    }
    if (result.finalState === "covered") {
      commitEnterReturnChannels(result.traversal, accum);
    }

    const resolution = evaluateResolutionFunction(
      statement.resolveWhen,
      traversal,
      node,
      accum,
      enterLoopFrameKey(statement),
    );
    if (resolution.status === "blocked") {
      return blockTraversal(accum, traversal);
    }
    clearEvaluatorActionStates(traversal, enterLoopFrameKey(statement));
    if (truthy(resolution.value)) {
      markActionResolved(traversal, statement);
      return { status: "done" };
    }

    if (target.kind === "pseudo-owned") {
      replaceEphemeralTraversal(
        traversal,
        target.ref,
        createFreshNodeTraversal(target.ref, target.node, 0),
      );
      continue;
    }

    restartTraversalForEntry(
      result.traversal,
      target.kind === "referenced" ? target.entry.root : target.node,
    );
  }
}

function runEnterIteration(
  callerTraversal: Traversal,
  callerNode: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
  target:
    | { kind: "owned"; ref: NodeRef; node: Node }
    | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
    | { kind: "pseudo-owned"; ref: NodeRef; node: Node },
  accum: Accumulator,
): EnterIterationStatus {
  if (target.kind === "referenced") {
    if (!callerTraversal.refChildren.some((item) => item === target.ref)) {
      callerTraversal.refChildren.push(target.ref);
    }
    const referencedTraversal = ensureReferencedTraversal(
      accum,
      target.ref,
      target.entry.root,
      rootRefOf(callerTraversal.ref),
    );
    applyEnterChannels(
      callerTraversal,
      callerNode,
      statement,
      referencedTraversal,
      accum,
    );
    const status = runTraversal(
      referencedTraversal,
      target.entry.root,
      accum,
      false,
    );
    return toEnterIterationStatus(status, referencedTraversal);
  }

  const childTraversal =
    target.kind === "owned"
      ? ensureOwnedTraversal(accum, target.ref, target.node)
      : ensureEphemeralTraversal(callerTraversal, target.ref, target.node);
  prepareChildTraversalForEntry(childTraversal, target.node);
  applyEnterChannels(
    callerTraversal,
    callerNode,
    statement,
    childTraversal,
    accum,
  );

  const childStatus = runTraversal(childTraversal, target.node, accum, false);
  return toEnterIterationStatus(childStatus, childTraversal);
}

function runInstructionAction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
): RunStatus {
  const actionState = getActionState(traversal, statement);
  if (actionState?.status !== "pending") {
    const postcheck =
      accum.phase === "plan"
        ? collectInstructionPostcheck(statement, traversal, node, accum)
        : undefined;
    emitInstruction(statement, traversal, node, accum, "apply", postcheck);
    markPendingActionState(traversal, statement.id, statement.kind);
    return { status: "done" };
  }

  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;
  const deflectResult = statement.deflectWhen
    ? evaluateResolutionFunction(
        statement.deflectWhen,
        traversal,
        node,
        accum,
        instructionResolutionFrameKey(statement, "deflectWhen"),
      )
    : ({ status: "value", value: false } satisfies EvalResult);
  const resolveResult = evaluateInstructionResolution(
    statement,
    traversal,
    node,
    accum,
  );
  if (deflectResult.status !== "blocked" && truthy(deflectResult.value)) {
    clearActionState(traversal, statement.id);
    return deflectTraversal(accum, traversal);
  }
  if (
    deflectResult.status === "blocked" ||
    resolveResult.status === "blocked"
  ) {
    const postcheck =
      accum.phase === "plan"
        ? instructionPostcheckFromAccum(
            accum,
            judgmentStart,
            observationStart,
            hostCallStart,
          )
        : undefined;
    emitInstruction(statement, traversal, node, accum, "postcheck", postcheck);
    return blockTraversal(accum, traversal);
  }
  if (truthy(resolveResult.value)) {
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  emitInstruction(statement, traversal, node, accum, "apply");
  return { status: "done" };
}

function evaluateInstructionResolution(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  if (!statement.resolveWhen) {
    return { status: "value", value: statement.mode === "once" };
  }
  return evaluateResolutionFunction(
    statement.resolveWhen,
    traversal,
    node,
    accum,
    instructionResolutionFrameKey(statement, "resolveWhen"),
  );
}

function collectInstructionPostcheck(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): InstructionPostcheck | undefined {
  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;

  if (statement.deflectWhen) {
    evaluateResolutionFunction(
      statement.deflectWhen,
      traversal,
      node,
      accum,
      instructionResolutionFrameKey(statement, "deflectWhen"),
    );
  }
  if (statement.resolveWhen) {
    evaluateResolutionFunction(
      statement.resolveWhen,
      traversal,
      node,
      accum,
      instructionResolutionFrameKey(statement, "resolveWhen"),
    );
  }

  return instructionPostcheckFromAccum(
    accum,
    judgmentStart,
    observationStart,
    hostCallStart,
  );
}

function instructionPostcheckFromAccum(
  accum: Accumulator,
  judgmentStart: number,
  observationStart: number,
  hostCallStart: number,
): InstructionPostcheck | undefined {
  const judgmentIds = dedupeBriefIds(
    accum.judgments.slice(judgmentStart).map((item) => item.id),
  );
  const observationIds = dedupeBriefIds(
    accum.observations.slice(observationStart).map((item) => item.id),
  );
  const hostCallIds = dedupeBriefIds(
    accum.hostCalls.slice(hostCallStart).map((item) => item.id),
  );

  if (
    judgmentIds.length === 0 &&
    observationIds.length === 0 &&
    hostCallIds.length === 0
  ) {
    return undefined;
  }

  return {
    judgmentIds,
    observationIds,
    hostCallIds,
  };
}

export function evaluateResolutionFunction(
  statements: TriggerStatement[],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  const result = evaluateResolutionStatements(
    statements,
    traversal,
    node,
    accum,
    frameKey,
  );
  if (result.status !== "blocked") {
    clearEvaluatorActionStates(traversal, frameKey);
  }
  return result;
}

function evaluateResolutionStatements(
  statements: TriggerStatement[],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const test = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (test.status === "blocked") return test;
      const branch = truthy(test.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const branchResult = evaluateResolutionStatements(
        branch,
        traversal,
        node,
        accum,
        frameKey,
      );
      if (branchResult.status === "blocked") return branchResult;
      if (truthy(branchResult.value)) return branchResult;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return { status: "value", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return result;
      return { status: "value", value: truthy(result.value) };
    }

    if (
      isResolvedActionState(
        getEvaluatorActionState(traversal, frameKey, statement),
      )
    ) {
      continue;
    }
    const observeStatus = applyObserve(statement, traversal, node, accum);
    if (observeStatus.status === "blocked") return observeStatus;
    markEvaluatorActionResolved(traversal, frameKey, statement);
  }

  return { status: "value", value: false };
}

function deflectTraversal(accum: Accumulator, traversal: Traversal): RunStatus {
  const activeRef = traversalToNodeRef(traversal);
  traversal.state = "deflected";

  const rootTraversal = selectActionRootTraversal(
    accum.traversals,
    accum.entry.arc,
  );
  rootTraversal.pendingEffects = {
    reason: "deflected",
    active: activeRef,
  };

  return { status: "deflected", active: activeRef };
}

function prepareChildTraversalForEntry(traversal: Traversal, node: Node): void {
  if (traversal.enterCount === 0) {
    resetTraversalForEntry(traversal, node, 1);
    return;
  }

  if (
    (isArcTraversal(traversal) && isStopped(traversal)) ||
    traversal.state === "deflected"
  ) {
    resetTraversalForEntry(traversal, node, traversal.enterCount + 1);
  }
}

function restartTraversalForEntry(traversal: Traversal, node: Node): void {
  resetTraversalForEntry(traversal, node, traversal.enterCount + 1, true);
}

function resolveEnterTarget(
  accum: Accumulator,
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
):
  | { kind: "owned"; ref: NodeRef; node: Node }
  | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
  | { kind: "pseudo-owned"; ref: NodeRef; node: Node }
  | undefined {
  const ownerEntry =
    getEntryForRef(accum.entries, traversal.ref) ?? accum.entry;

  if (statement.target.fresh) {
    const ref = toPseudoChildRef(
      traversal,
      statement.target.identifier,
      statement.id,
    );
    const pseudoNode = getNodeForRef(accum.entries, ownerEntry, ref);
    if (!pseudoNode) return undefined;
    return { kind: "pseudo-owned", ref, node: pseudoNode };
  }

  const ref = resolveRefInTraversal(
    accum,
    traversal,
    node,
    statement.target.identifier,
    statement.target.imported,
  );
  if (!ref) return undefined;

  if (!isArcRef(ref)) {
    const ownedNode = getNodeForRef(accum.entries, ownerEntry, ref);
    if (ownedNode) return { kind: "owned", ref, node: ownedNode };
  }

  const importedRef = rootRefOf(ref);
  const importedEntry = accum.entries.get(importedRef);
  if (!importedEntry) return undefined;
  return { kind: "referenced", ref: importedRef, entry: importedEntry };
}

function applyEnterChannels(
  callerTraversal: Traversal,
  callerNode: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
  calleeTraversal: Traversal,
  accum: Accumulator,
): void {
  const hasArgs = !!statement.args && Object.keys(statement.args).length > 0;
  const hasReturns =
    !!statement.returns && Object.keys(statement.returns).length > 0;
  if (!hasArgs && !hasReturns) {
    calleeTraversal.enterChannels = createEmptyEnterChannelState();
    return;
  }

  const nextArgs = resolveEnterChannelLinks(
    statement.args ?? {},
    callerTraversal,
    callerNode,
    accum,
    "args",
  );
  const nextReturns = resolveEnterChannelLinks(
    statement.returns ?? {},
    callerTraversal,
    callerNode,
    accum,
    "returns",
  );

  if (
    sameEnterChannelLinks(calleeTraversal.enterChannels.args, nextArgs) &&
    sameEnterChannelLinks(calleeTraversal.enterChannels.returns, nextReturns)
  ) {
    return;
  }

  calleeTraversal.enterChannels = {
    args: nextArgs,
    returns: nextReturns,
    stagedReturns: {},
  };
}

function resolveEnterChannelLinks(
  mapping: Record<string, string>,
  callerTraversal: Traversal,
  callerNode: Node,
  accum: Accumulator,
  label: "args" | "returns",
): Record<string, CallerVarRef> {
  const resolved: Record<string, CallerVarRef> = {};
  for (const [key, variable] of Object.entries(mapping)) {
    const owner = findVariableOwner(variable, callerTraversal, accum);
    if (!owner) {
      throw new Error(
        `Unknown ${label} variable mapping "${variable}" in ${callerNode.identifier}`,
      );
    }
    resolved[key] = {
      ownerRef: traversalToNodeRef(owner.traversal),
      variable,
    };
  }
  return resolved;
}

function sameEnterChannelLinks(
  left: Record<string, CallerVarRef>,
  right: Record<string, CallerVarRef>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const l = left[key];
    const r = right[key];
    if (!l || !r) return false;
    if (l.ownerRef !== r.ownerRef || l.variable !== r.variable) return false;
  }
  return true;
}

function commitEnterReturnChannels(
  traversal: Traversal,
  accum: Accumulator,
): void {
  const channelState = traversal.enterChannels;
  for (const [key, value] of Object.entries(channelState.stagedReturns)) {
    const callerVarRef = channelState.returns[key];
    if (!callerVarRef) {
      throw new Error(
        `Unknown staged return channel key "${key}" for ${formatRef(traversalToNodeRef(traversal))}`,
      );
    }
    const callerTraversal = findTraversalInSet(
      accum.traversals,
      callerVarRef.ownerRef,
    );
    if (!callerTraversal) {
      throw new Error(
        `Return channel caller not found for binding: ${formatRef(callerVarRef.ownerRef)}`,
      );
    }
    callerTraversal.variables[callerVarRef.variable] = value;
  }
  channelState.stagedReturns = {};
}

function ensureReferencedTraversal(
  accum: Accumulator,
  ref: ArcRef,
  root: Node,
  returnTo: ArcRef,
): ArcTraversal {
  let traversal = accum.traversals.find((item) => item.ref === ref);
  if (!traversal) {
    traversal = createFreshArcTraversal(ref, root, 1, returnTo);
    accum.traversals.push(traversal);
  }
  traversal.returnTo = returnTo;
  return traversal;
}

function runPendingEffects(
  accum: Accumulator,
  pendingEffects: PendingEffects,
): RunStatus {
  for (const ref of deflectionEffectRefs(pendingEffects.active)) {
    const traversal = findTraversalInSet(accum.traversals, ref);
    if (!traversal) {
      throw new Error(`Pending effects traversal not found: ${formatRef(ref)}`);
    }

    const entry = getEntryForRef(accum.entries, ref);
    const node = entry ? getNodeForRef(accum.entries, entry, ref) : undefined;
    if (!node) {
      throw new Error(`Pending effects node not found: ${formatRef(ref)}`);
    }

    accum.active = ref;
    const status = runEffects(traversal, node, accum);
    if (status.status === "blocked") return status;
  }
  return { status: "done" };
}

function completePendingEffects(
  accum: Accumulator,
  pendingEffects: PendingEffects,
): void {
  const activeTraversal = findTraversalInSet(
    accum.traversals,
    pendingEffects.active,
  );
  if (!activeTraversal) {
    throw new Error(
      `Pending effects active traversal not found: ${formatRef(pendingEffects.active)}`,
    );
  }
  if (isArcTraversal(activeTraversal)) {
    activeTraversal.phase = "suspended";
  }
  if (!isArcTraversal(accum.traversal)) {
    throw new Error("Pending effects can only finalize an arc traversal");
  }
  accum.traversal.pendingEffects = undefined;
  accum.traversal.phase = "suspended";
}

function deflectionEffectRefs(active: NodeRef): NodeRef[] {
  const { source, path } = toNodeRefParts(active);
  const refs: NodeRef[] = [];
  for (let length = path.length; length >= 1; length--) {
    refs.push(toNodeRef(source, path.slice(0, length)));
  }
  return refs;
}

function runEffects(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): RunStatus {
  if (!node.effects) return { status: "done" };
  return runEffectStatements(traversal, node, node.effects, accum);
}

function runEffectStatements(
  traversal: Traversal,
  node: Node,
  statements: EffectStatement[],
  accum: Accumulator,
): RunStatus {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return { status: "blocked" };
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const status = runEffectStatements(traversal, node, branch, accum);
      if (status.status === "blocked") return status;
      continue;
    }

    if (isResolvedActionState(getActionState(traversal, statement))) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    if (statement.kind === "set") {
      const apply = applySet(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    if (statement.kind === "set-return") {
      const apply = applySetReturn(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    const effect = renderHostEffect(statement, traversal, node, accum);
    const key = hostEffectDedupKey(traversal, statement.id, effect);
    if (!traversal.appliedHostCallKeys.includes(key)) {
      traversal.appliedHostCallKeys.push(key);
      accum.hostEffects.push(effect);
    }
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function emitInstruction(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  phase: InstructionBrief["phase"],
  postcheck?: InstructionPostcheck,
): void {
  noteBriefYield(accum, traversal);
  accum.instructionBatchNode ??= traversalToNodeRef(traversal);
  accum.instructionBatchSignature ??= instructionBatchSignature(statement);
  accum.instructions.push({
    id: makeInstructionId(accum.entry.arc, traversal, statement.id),
    sourceRef: traversalToNodeRef(traversal),
    mode: statement.mode,
    phase,
    text: renderSemanticString(statement.template, traversal, node, accum),
    postcheck: cloneInstructionPostcheck(postcheck),
  });
}

function blockTraversal(
  accum: Accumulator,
  traversal: Traversal,
): { status: "blocked" } {
  setActiveTraversal(accum, traversal);
  accum.blocked = true;
  return { status: "blocked" };
}

function toEnterIterationStatus(
  status: RunStatus,
  traversal: Traversal,
): EnterIterationStatus {
  if (status.status === "blocked") {
    return { status: "blocked", traversal };
  }
  if (status.status === "yielded") {
    return { status: "yielded", traversal };
  }
  if (status.status === "deflected") {
    return { status: "deflected", traversal, active: status.active };
  }
  return {
    status: "done",
    traversal,
    finalState: traversal.state,
  };
}

function resetTraversalForEntry(
  traversal: Traversal,
  node: Node,
  nextEnterCount: number,
  clearPendingEffects = false,
): void {
  traversal.enterCount = nextEnterCount;
  traversal.state = undefined;
  traversal.enterChannels = createEmptyEnterChannelState();
  if (isArcTraversal(traversal)) {
    traversal.phase = "entered";
    if (clearPendingEffects) traversal.pendingEffects = undefined;
  }
  if (!node.resumable) clearFrame(traversal);
}

function hostEffectDedupKey(
  traversal: Traversal,
  statementId: number,
  effect: HostEffect,
): string {
  return `[${traversal.ref}]:${statementId}:${stableStringifyPayload(effect)}`;
}

function stableStringifyPayload(value: PayloadValue | HostEffect): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyPayload(item)).join(",")}]`;
  }

  const objectValue = value as Record<string, PayloadValue>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringifyPayload(objectValue[key])}`,
    )
    .join(",")}}`;
}
