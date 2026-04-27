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
  PrimitiveValue,
  Statement,
  Traversal,
  TriggerStatement,
  ValueExpression,
} from "../types.js";
import {
  type ActionOutcome,
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
  arcToNodeRef,
  findTraversalInSet,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  isArcRef,
  isArcTraversal,
  rootRefOf,
  toPseudoChildRef,
  traversalToNodeRef,
} from "./refs.js";
import {
  type Accumulator,
  type RegistryEntry,
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
  findEphemeralTraversal,
  getActionState,
  getEvaluatorActionState,
  instructionBatchSignature,
  instructionResolutionFrameKey,
  isEnteredTraversal,
  isInstructionBatchActive,
  isResolvedActionState,
  isSuspendedArcTraversal,
  makeInstructionId,
  markActionResolved,
  markEvaluatorActionResolved,
  markPendingActionState,
  noteBriefYield,
  replaceEphemeralTraversal,
  setActiveTraversal,
} from "./state.js";

type TerminalTraversalState = Extract<NodeState, "covered" | "skipped">;

type SegOutcome<TResult> =
  | { status: "done"; value: TResult }
  | { status: "blocked" }
  | { status: "deflected"; active: NodeRef };

type WalkResult<TResult> = { status: "rewalk" } | SegOutcome<TResult>;

type LeafStep<TResult> = { status: "advance" } | WalkResult<TResult>;

type TraversalOutcome =
  | { status: "done"; finalState: TerminalTraversalState }
  | { status: "blocked" }
  | { status: "deflected"; active: NodeRef };

type HookOutcome<TResult> = SegOutcome<TResult>;

type EnterActionOutcome =
  | {
      status: "resolved";
      traversal: Traversal;
      finalState: TerminalTraversalState;
    }
  | { status: "blocked"; traversal: Traversal }
  | { status: "deflected"; traversal: Traversal; active: NodeRef };

function isResultNodeState(
  result: ActionOutcome<unknown>,
): result is ActionOutcome<NodeState> {
  return (
    result.status === "resolved" &&
    (result.value === "covered" ||
      result.value === "deflected" ||
      result.value === "skipped")
  );
}

type SegFrame<TStatement extends { kind: string }> = {
  statements: readonly TStatement[];
  index: number;
  label?: string;
};

type IfLike<TStatement extends { kind: string }> = TStatement & {
  kind: "if";
  test: ValueExpression;
  consequent: TStatement[];
  alternate?: TStatement[];
};

type LabelLike<TStatement extends { kind: string }> = TStatement & {
  kind: "label";
  label: string;
  body: TStatement[];
};

type BreakLike<TStatement extends { kind: string }> = TStatement & {
  kind: "break";
  label: string;
};

type ReturnLike = {
  kind: "return";
  value?: ValueExpression;
};

type BranchResult<TStatement extends { kind: string }, TResult> =
  | { status: "branch"; statements: readonly TStatement[] }
  | SegOutcome<TResult>;

type SegHooks<TStatement extends { kind: string }, TResult> = {
  doneValue: TResult;
  evaluateIf: (
    statement: IfLike<TStatement>,
  ) => BranchResult<TStatement, TResult>;
  evaluateReturn?: (statement: ReturnLike) => SegOutcome<TResult>;
  isResolvedLeaf?: (statement: TStatement) => boolean;
  stepLeaf: (statement: TStatement) => LeafStep<TResult>;
};

/**
 * Runs one smallest enclosing graph (SEG) to a terminal outcome.
 *
 * `runSeg(...)` owns the SEG re-walk loop. `walkSeg(...)` performs one
 * top-down pass; when a briefable action or enter action resolves and requests
 * re-walk, `runSeg(...)` starts a fresh pass from the SEG root.
 */
function runSeg<TStatement extends { kind: string }, TResult>(
  statements: readonly TStatement[],
  hooks: SegHooks<TStatement, TResult>,
): SegOutcome<TResult> {
  while (true) {
    const outcome = walkSeg(statements, hooks);
    if (outcome.status === "rewalk") continue;
    return outcome;
  }
}

/**
 * Performs one top-down DFS pass through a SEG's structural control flow.
 *
 * This walker owns `if` / `label` / `break` sequencing with an explicit stack.
 * Leaf semantics are delegated through `hooks.stepLeaf(...)`; the walker
 * itself does not know what Arc leaf statements mean.
 */
function walkSeg<TStatement extends { kind: string }, TResult>(
  statements: readonly TStatement[],
  hooks: SegHooks<TStatement, TResult>,
): WalkResult<TResult> {
  const stack: SegFrame<TStatement>[] = [{ statements, index: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const statement = frame.statements[frame.index];

    if (!statement) {
      stack.pop();
      if (stack.length === 0) {
        return { status: "done", value: hooks.doneValue };
      }
      stack[stack.length - 1]!.index += 1;
      continue;
    }

    if (statement.kind === "if") {
      const branch = hooks.evaluateIf(statement as IfLike<TStatement>);
      if (branch.status !== "branch") return branch;
      if (branch.statements.length === 0) {
        frame.index += 1;
        continue;
      }
      stack.push({ statements: branch.statements, index: 0 });
      continue;
    }

    if (statement.kind === "label") {
      const labeled = statement as LabelLike<TStatement>;
      if (labeled.body.length === 0) {
        frame.index += 1;
        continue;
      }
      stack.push({
        statements: labeled.body,
        index: 0,
        label: labeled.label,
      });
      continue;
    }

    if (statement.kind === "break") {
      unwindSegBreak(stack, (statement as BreakLike<TStatement>).label);
      continue;
    }

    if (statement.kind === "return") {
      if (!hooks.evaluateReturn) {
        throw new Error("Return statements are unsupported in this SEG");
      }
      return hooks.evaluateReturn(statement as ReturnLike);
    }

    if (hooks.isResolvedLeaf?.(statement)) {
      frame.index += 1;
      continue;
    }

    const outcome = hooks.stepLeaf(statement);
    if (outcome.status === "advance") {
      frame.index += 1;
      continue;
    }
    return outcome;
  }

  return { status: "done", value: hooks.doneValue };
}

function unwindSegBreak<TStatement extends { kind: string }>(
  stack: SegFrame<TStatement>[],
  label: string,
): void {
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.label === label) {
      const parent = stack[stack.length - 1];
      if (!parent) {
        throw new Error(`Unhandled break label: ${label}`);
      }
      parent.index += 1;
      return;
    }
  }

  throw new Error(`Unhandled break label: ${label}`);
}

function blockSeg<TResult>(
  accum: Accumulator,
  traversal: Traversal,
): SegOutcome<TResult> {
  blockTraversal(accum, traversal);
  return { status: "blocked" };
}

function deflectSeg<TResult>(traversal: Traversal): SegOutcome<TResult> {
  const outcome = deflectTraversal(traversal);
  if (outcome.status !== "deflected") {
    throw new Error("Expected deflected traversal outcome");
  }
  return { status: "deflected", active: outcome.active };
}

function evaluateIfBranch<TStatement extends { kind: string }, TResult>(
  statement: IfLike<TStatement>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): BranchResult<TStatement, TResult> {
  const result = evaluateValueExpression(
    statement.test,
    traversal,
    node,
    accum,
  );
  if (result.status === "blocked") {
    return blockSeg(accum, traversal);
  }
  return {
    status: "branch",
    statements: truthy(result.value)
      ? statement.consequent
      : (statement.alternate ?? []),
  };
}

export function runTrigger(
  node: Node,
  traversal: Traversal,
  accum: Accumulator,
): boolean {
  if (!node.trigger) return true;

  const outcome = runSeg<TriggerStatement, boolean>(node.trigger, {
    doneValue: false,
    evaluateIf: (statement) =>
      evaluateIfBranch(statement, traversal, node, accum),
    evaluateReturn: (statement) => {
      if (!statement.value) return { status: "done", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        return blockSeg(accum, traversal);
      }
      return { status: "done", value: truthy(result.value) };
    },
    isResolvedLeaf: (statement) =>
      (statement.kind === "observe" || statement.kind === "set") &&
      isResolvedActionState(
        getEvaluatorActionState(traversal, "trigger", statement),
      ),
    stepLeaf: (statement) => {
      if (statement.kind === "observe") {
        const apply = applyObserve(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markEvaluatorActionResolved(traversal, "trigger", statement);
        return { status: "rewalk" };
      }

      if (statement.kind === "set") {
        const apply = applySet(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markEvaluatorActionResolved(traversal, "trigger", statement);
        return { status: "rewalk" };
      }

      {
        throw new Error(
          `Unsupported trigger leaf statement: ${statement.kind}`,
        );
      }
    },
  });
  if (outcome.status === "blocked") return false;
  if (outcome.status === "deflected") {
    throw new Error("Triggers cannot deflect");
  }
  clearEvaluatorActionStates(traversal, "trigger");
  return truthy(outcome.value);
}

function runGuardStatements(
  node: Node,
  traversal: Traversal,
  statements: GuardStatement[],
  accum: Accumulator,
): ActionOutcome<NodeState | undefined> {
  const outcome = runSeg<GuardStatement, NodeState | undefined>(statements, {
    doneValue: undefined,
    evaluateIf: (statement) =>
      evaluateIfBranch(statement, traversal, node, accum),
    evaluateReturn: (statement) => {
      if (!statement.value) return { status: "done", value: undefined };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        return blockSeg(accum, traversal);
      }
      return isResultNodeState(result)
        ? { status: "done", value: result.value }
        : { status: "done", value: undefined };
    },
    isResolvedLeaf: (statement) =>
      (statement.kind === "observe" || statement.kind === "set") &&
      isResolvedActionState(getActionState(traversal, statement)),
    stepLeaf: (statement) => {
      if (statement.kind === "observe") {
        const apply = applyObserve(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }

      if (statement.kind === "set") {
        const apply = applySet(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }

      throw new Error(`Unsupported guard leaf statement: ${statement.kind}`);
    },
  });
  if (outcome.status === "blocked") {
    return { status: "blocked" };
  }
  if (outcome.status === "deflected") {
    throw new Error("Guards cannot deflect");
  }
  return { status: "resolved", value: outcome.value };
}

export function continueArc(accum: Accumulator): void {
  const rootNode = getNodeForRef(
    accum.entries,
    accum.entry,
    accum.traversal.ref,
  );
  if (!rootNode)
    throw new Error(
      `Unknown root traversal node: ${formatRef(accum.traversal.ref)}`,
    );
  runTraversal(accum.traversal, rootNode, accum, true);
}

function runTraversal(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  isRoot = false,
): TraversalOutcome {
  restart: while (true) {
    setActiveTraversal(accum, traversal);

    if (traversal.finalizing) {
      const finalized = continueFinalizingTraversal(traversal, node, accum);
      if (finalized.status === "caught") continue restart;
      return finalized;
    }

    if (!isRoot) {
      if (traversal.state === "covered" || traversal.state === "skipped") {
        return { status: "done", finalState: traversal.state };
      }
      if (node.guard) {
        const guardResult = runGuardStatements(
          node,
          traversal,
          node.guard,
          accum,
        );
        if (guardResult.status === "blocked") {
          return { status: "blocked" };
        }
        if (
          guardResult.value === "covered" ||
          guardResult.value === "skipped"
        ) {
          traversal.state = guardResult.value;
          return { status: "done", finalState: guardResult.value };
        }
        if (guardResult.value === "deflected") {
          throw new Error(
            "Returning State.DEFLECTED from a guard is unsupported yet",
          );
        }
        traversal.state = undefined;
      }
    }

    const outcome = runSeg<Statement, void>(node.statements, {
      doneValue: undefined,
      evaluateIf: (statement) =>
        evaluateIfBranch(statement, traversal, node, accum),
      isResolvedLeaf: (statement) => isResolvedActionLeaf(traversal, statement),
      stepLeaf: (statement) =>
        stepActionLeaf(traversal, node, statement as ActionStatement, accum),
    });

    if (outcome.status === "blocked") {
      return { status: "blocked" };
    }
    if (outcome.status === "deflected") {
      traversal.finalizing = {
        reason: "deflected",
        active: outcome.active,
        phase: "catch",
      };
      continue restart;
    }

    if (isInstructionBatchActive(accum, traversal)) {
      return blockTraversal(accum, traversal);
    }

    traversal.finalizing = {
      reason: "covered",
      active: traversalToNodeRef(traversal),
      phase: "effects",
    };
  }
}

function continueFinalizingTraversal(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): TraversalOutcome | { status: "caught" } {
  const finalizing = traversal.finalizing;
  if (!finalizing) {
    throw new Error("Traversal is not finalizing");
  }

  if (finalizing.reason === "deflected" && finalizing.phase === "catch") {
    const caught = evaluateCatchDeflection(traversal, node, accum);
    if (caught.status === "blocked") return { status: "blocked" };
    if (caught.value) {
      traversal.finalizing = undefined;
      return { status: "caught" };
    }
    traversal.state = "deflected";
    traversal.finalizing = { ...finalizing, phase: "effects" };
  }

  const effects = runEffects(traversal, node, accum);
  if (effects.status !== "done") return effects;

  traversal.finalizing = undefined;
  traversal.state = finalizing.reason;
  if (isArcTraversal(traversal)) {
    traversal.phase =
      finalizing.reason === "covered" ? "completed" : "suspended";
  }
  if (finalizing.reason === "deflected") {
    return { status: "deflected", active: finalizing.active };
  }
  return { status: "done", finalState: "covered" };
}

function isResolvedActionLeaf(
  traversal: Traversal,
  statement: Statement,
): boolean {
  if (
    statement.kind !== "observe" &&
    statement.kind !== "observeOrAsk" &&
    statement.kind !== "set" &&
    statement.kind !== "set-return" &&
    statement.kind !== "instruction" &&
    statement.kind !== "enter-node" &&
    statement.kind !== "enter-loop"
  ) {
    return false;
  }
  return isResolvedActionState(getActionState(traversal, statement));
}

function stepActionLeaf(
  traversal: Traversal,
  node: Node,
  statement: ActionStatement,
  accum: Accumulator,
): LeafStep<void> {
  if (
    isInstructionBatchActive(accum, traversal) &&
    statement.kind !== "instruction"
  ) {
    return blockSeg(accum, traversal);
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    const outcome = applyObserve(statement, traversal, node, accum);
    if (outcome.status === "blocked") return blockSeg(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "rewalk" };
  }

  if (statement.kind === "set") {
    const apply = applySet(statement, traversal, node, accum);
    if (apply.status === "blocked") return blockSeg(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "rewalk" };
  }

  if (statement.kind === "set-return") {
    const apply = applySetReturn(statement, traversal, node, accum);
    if (apply.status === "blocked") return blockSeg(accum, traversal);
    markActionResolved(traversal, statement);
    return { status: "rewalk" };
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

  throw new Error("Unsupported action leaf statement");
}

function runEnterNodeAction(
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" }>,
  accum: Accumulator,
): LeafStep<void> {
  const target = resolveEnterTarget(accum, traversal, node, statement);
  if (!target) {
    throw new Error(
      `Missing child node implementation: ${statement.target.identifier}`,
    );
  }

  const result = runEnterIteration(traversal, node, statement, target, accum);
  if (result.status === "blocked") {
    return { status: "blocked" };
  }
  if (result.status === "deflected") {
    return { status: "deflected", active: result.active };
  }
  if (result.finalState === "covered") {
    commitEnterReturnChannels(result.traversal, accum);
  }
  if (result.finalState === "covered" || result.finalState === "skipped") {
    markActionResolved(traversal, statement);
    return { status: "rewalk" };
  }
  throw new Error(
    `Enter action resolved without terminal child state: ${statement.target.identifier}`,
  );
}

function runEnterLoopAction(
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-loop" }>,
  accum: Accumulator,
): LeafStep<void> {
  const target = resolveEnterTarget(accum, traversal, node, statement);
  if (!target) {
    throw new Error(
      `Missing child node implementation: ${statement.target.identifier}`,
    );
  }

  const existingState = getActionState(traversal, statement);
  const stagedReturns =
    existingState?.status === "pending" && existingState.stagedReturns
      ? { ...existingState.stagedReturns }
      : {};
  const phase =
    existingState?.status === "pending" &&
    existingState.enterLoopPhase === "resolveWhen"
      ? "resolveWhen"
      : "target";
  const loopState = {
    phase,
    stagedReturns,
  };

  restart: while (true) {
    if (loopState.phase === "resolveWhen") {
      const resolution = evaluateResolutionFunction(
        statement.resolveWhen,
        traversal,
        node,
        accum,
        enterLoopFrameKey(statement),
      );
      if (resolution.status === "blocked") {
        persistPendingEnterLoopState(
          traversal,
          statement,
          "resolveWhen",
          loopState.stagedReturns,
        );
        return blockSeg(accum, traversal);
      }
      clearEvaluatorActionStates(traversal, enterLoopFrameKey(statement));
      if (truthy(resolution.value)) {
        commitEnterReturnChannels(
          currentEnterLoopTargetTraversal(traversal, target, accum),
          accum,
          loopState.stagedReturns,
        );
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }
      prepareNextEnterLoopIteration(traversal, target, accum);
      loopState.phase = "target";
      continue restart;
    }

    const result = runEnterIteration(traversal, node, statement, target, accum);
    if (result.status === "blocked") {
      persistPendingEnterLoopState(
        traversal,
        statement,
        "target",
        loopState.stagedReturns,
      );
      return { status: "blocked" };
    }
    if (result.status === "deflected") {
      clearActionState(traversal, statement.id);
      return { status: "deflected", active: result.active };
    }
    if (result.finalState === "covered") {
      Object.assign(
        loopState.stagedReturns,
        result.traversal.enterChannels.stagedReturns,
      );
      result.traversal.enterChannels.stagedReturns = {};
    }
    loopState.phase = "resolveWhen";
    continue restart;
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
): EnterActionOutcome {
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
    prepareTraversalForEntry(
      referencedTraversal,
      target.entry.root,
      statement.target,
    );
    applyEnterChannels(
      callerTraversal,
      callerNode,
      statement,
      referencedTraversal,
      accum,
    );
    const outcome = runTraversal(
      referencedTraversal,
      target.entry.root,
      accum,
      false,
    );
    return toEnterActionOutcome(outcome, referencedTraversal);
  }

  const childTraversal =
    target.kind === "owned"
      ? ensureOwnedTraversal(accum, target.ref, target.node)
      : ensureEphemeralTraversal(callerTraversal, target.ref, target.node);
  prepareTraversalForEntry(childTraversal, target.node, statement.target);
  applyEnterChannels(
    callerTraversal,
    callerNode,
    statement,
    childTraversal,
    accum,
  );

  const childOutcome = runTraversal(childTraversal, target.node, accum, false);
  return toEnterActionOutcome(childOutcome, childTraversal);
}

function runInstructionAction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
): LeafStep<void> {
  if (
    isInstructionBatchActive(accum, traversal) &&
    !canBatchInstruction(accum, statement)
  ) {
    return blockSeg(accum, traversal);
  }

  const actionState = getActionState(traversal, statement);
  const instructionId = makeInstructionId(
    accum.entry.arc,
    traversal,
    statement.id,
  );
  if (
    accum.phase === "plan" &&
    actionState?.status === "pending" &&
    accum.yieldedInstructionIds.has(instructionId)
  ) {
    noteBriefYield(accum, traversal);
    accum.instructionBatchNode ??= traversalToNodeRef(traversal);
    accum.instructionBatchSignature ??= instructionBatchSignature(statement);
    return blockSeg(accum, traversal);
  }

  if (actionState?.status !== "pending") {
    const postcheck =
      accum.phase === "plan"
        ? collectInstructionPostcheck(statement, traversal, node, accum)
        : undefined;
    emitInstruction(statement, traversal, node, accum, "apply", postcheck);
    markPendingActionState(traversal, statement.id, statement.kind);
    return { status: "advance" };
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
    : ({ status: "resolved", value: false } satisfies ActionOutcome<boolean>);
  const resolveResult = evaluateInstructionResolution(
    statement,
    traversal,
    node,
    accum,
  );
  if (deflectResult.status !== "blocked" && truthy(deflectResult.value)) {
    clearActionState(traversal, statement.id);
    return deflectSeg(traversal);
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
    return { status: "advance" };
  }
  if (truthy(resolveResult.value)) {
    markActionResolved(traversal, statement);
    return { status: "rewalk" };
  }

  emitInstruction(statement, traversal, node, accum, "apply");
  return { status: "advance" };
}

function evaluateInstructionResolution(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<boolean> {
  if (!statement.resolveWhen) {
    return { status: "resolved", value: statement.mode === "once" };
  }
  return evaluateResolutionFunction(
    statement.resolveWhen,
    traversal,
    node,
    accum,
    instructionResolutionFrameKey(statement, "resolveWhen"),
  );
}

function evaluateCatchDeflection(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<boolean> {
  if (!node.catchDeflection || !traversal.finalizing) {
    return { status: "resolved", value: false };
  }

  const previous = accum.deflectionActive;
  accum.deflectionActive = traversal.finalizing.active;
  try {
    return evaluateResolutionFunction(
      node.catchDeflection,
      traversal,
      node,
      accum,
      catchDeflectionFrameKey(traversal.finalizing.active),
    );
  } finally {
    accum.deflectionActive = previous;
  }
}

function catchDeflectionFrameKey(active: NodeRef): string {
  return `catch-deflection:${active}`;
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
): ActionOutcome<boolean> {
  const outcome = runSeg<TriggerStatement, boolean>(statements, {
    doneValue: false,
    evaluateIf: (statement) =>
      evaluateIfBranch(statement, traversal, node, accum),
    evaluateReturn: (statement) => {
      if (!statement.value) return { status: "done", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        return blockSeg(accum, traversal);
      }
      return { status: "done", value: truthy(result.value) };
    },
    isResolvedLeaf: (statement) =>
      (statement.kind === "observe" || statement.kind === "set") &&
      isResolvedActionState(
        getEvaluatorActionState(traversal, frameKey, statement),
      ),
    stepLeaf: (statement) => {
      if (statement.kind === "observe") {
        const apply = applyObserve(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markEvaluatorActionResolved(traversal, frameKey, statement);
        return { status: "rewalk" };
      }

      if (statement.kind === "set") {
        const apply = applySet(statement, traversal, node, accum);
        if (apply.status === "blocked") {
          return blockSeg(accum, traversal);
        }
        markEvaluatorActionResolved(traversal, frameKey, statement);
        return { status: "rewalk" };
      }

      throw new Error(
        `Unsupported resolution leaf statement: ${statement.kind}`,
      );
    },
  });
  if (outcome.status === "blocked") {
    return { status: "blocked" };
  }
  if (outcome.status === "deflected") {
    throw new Error("Resolution functions cannot deflect");
  }
  clearEvaluatorActionStates(traversal, frameKey);
  return { status: "resolved", value: outcome.value };
}

function deflectTraversal(traversal: Traversal): TraversalOutcome {
  const activeRef = traversalToNodeRef(traversal);
  return { status: "deflected", active: activeRef };
}

function prepareTraversalForEntry(
  traversal: Traversal,
  node: Node,
  target: { fresh: boolean; reopen: boolean },
): void {
  if (traversal.finalizing) {
    return;
  }

  if (target.reopen) {
    reopenTraversalForEntry(traversal, node);
    return;
  }

  if (traversal.enterCount === 0) {
    resetTraversalForEntry(traversal, node, 1);
    return;
  }

  if (traversal.state === "deflected" || isSuspendedArcTraversal(traversal)) {
    resetTraversalForEntry(traversal, node, traversal.enterCount + 1);
  }
}

function restartTraversalForEntry(traversal: Traversal, node: Node): void {
  resetTraversalForEntry(traversal, node, traversal.enterCount + 1);
}

function reopenTraversalForEntry(traversal: Traversal, node: Node): void {
  if (traversal.enterCount > 0 && isEnteredTraversal(traversal)) {
    return;
  }

  const nextEnterCount =
    traversal.enterCount === 0 ? 1 : traversal.enterCount + 1;
  resetTraversalForEntry(traversal, node, nextEnterCount, true);
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
  stagedReturns = traversal.enterChannels.stagedReturns,
): void {
  const channelState = traversal.enterChannels;
  for (const [key, value] of Object.entries(stagedReturns)) {
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

function persistPendingEnterLoopState(
  traversal: Traversal,
  statement: Extract<ActionStatement, { kind: "enter-loop" }>,
  phase: "target" | "resolveWhen",
  stagedReturns: Record<string, PrimitiveValue>,
): void {
  if (phase === "target" && Object.keys(stagedReturns).length === 0) {
    clearActionState(traversal, statement.id);
    return;
  }
  markPendingActionState(traversal, statement.id, statement.kind, {
    enterLoopPhase: phase,
    stagedReturns,
  });
}

function prepareNextEnterLoopIteration(
  traversal: Traversal,
  target:
    | { kind: "owned"; ref: NodeRef; node: Node }
    | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
    | { kind: "pseudo-owned"; ref: NodeRef; node: Node },
  accum: Accumulator,
): void {
  if (target.kind === "pseudo-owned") {
    replaceEphemeralTraversal(
      traversal,
      target.ref,
      createFreshNodeTraversal(target.ref, target.node),
    );
    return;
  }

  if (target.kind === "referenced") {
    const nextTraversal = ensureReferencedTraversal(
      accum,
      target.ref,
      target.entry.root,
      rootRefOf(traversal.ref),
    );
    restartTraversalForEntry(nextTraversal, target.entry.root);
    return;
  }

  const nextTraversal = ensureOwnedTraversal(accum, target.ref, target.node);
  restartTraversalForEntry(nextTraversal, target.node);
}

function currentEnterLoopTargetTraversal(
  traversal: Traversal,
  target:
    | { kind: "owned"; ref: NodeRef; node: Node }
    | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
    | { kind: "pseudo-owned"; ref: NodeRef; node: Node },
  accum: Accumulator,
): Traversal {
  if (target.kind === "pseudo-owned") {
    const existing = findEphemeralTraversal(traversal, target.ref);
    if (!existing) {
      throw new Error(
        `Current enterLoop target traversal not found: ${formatRef(target.ref)}`,
      );
    }
    return existing;
  }

  const existing = findTraversalInSet(
    accum.traversals,
    target.kind === "referenced" ? arcToNodeRef(target.ref) : target.ref,
  );
  if (!existing) {
    throw new Error(
      `Current enterLoop target traversal not found: ${formatRef(target.ref)}`,
    );
  }
  return existing;
}

function ensureReferencedTraversal(
  accum: Accumulator,
  ref: ArcRef,
  root: Node,
  returnTo: ArcRef,
): ArcTraversal {
  let traversal = accum.traversals.find((item) => item.ref === ref);
  if (!traversal) {
    traversal = createFreshArcTraversal(ref, root, returnTo);
    accum.traversals.push(traversal);
  }
  traversal.returnTo = returnTo;
  return traversal;
}

function runEffects(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): HookOutcome<void> {
  if (!node.effects) return { status: "done", value: undefined };

  const outcome = runSeg<EffectStatement, void>(node.effects, {
    doneValue: undefined,
    evaluateIf: (statement) =>
      evaluateIfBranch(statement, traversal, node, accum),
    isResolvedLeaf: (statement) =>
      statement.kind !== "if" &&
      statement.kind !== "label" &&
      statement.kind !== "break" &&
      isResolvedActionState(getActionState(traversal, statement)),
    stepLeaf: (statement) => {
      if (statement.kind === "observe") {
        const apply = applyObserve(statement, traversal, node, accum);
        if (apply.status === "blocked") return blockSeg(accum, traversal);
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }

      if (statement.kind === "set") {
        const apply = applySet(statement, traversal, node, accum);
        if (apply.status === "blocked") return blockSeg(accum, traversal);
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }

      if (statement.kind === "set-return") {
        const apply = applySetReturn(statement, traversal, node, accum);
        if (apply.status === "blocked") return blockSeg(accum, traversal);
        markActionResolved(traversal, statement);
        return { status: "rewalk" };
      }

      if (statement.kind !== "host-call") {
        throw new Error("Unsupported effects leaf statement");
      }

      const effect = renderHostEffect(statement, traversal, node, accum);
      const key = hostEffectDedupKey(traversal, statement.id, effect);
      if (!traversal.appliedHostCallKeys.includes(key)) {
        traversal.appliedHostCallKeys.push(key);
        accum.hostEffects.push(effect);
      }
      markActionResolved(traversal, statement);
      return { status: "rewalk" };
    },
  });
  return outcome;
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

function toEnterActionOutcome(
  outcome: TraversalOutcome,
  traversal: Traversal,
): EnterActionOutcome {
  if (outcome.status === "done") {
    return {
      status: "resolved",
      traversal,
      finalState: outcome.finalState,
    };
  }
  if (outcome.status === "blocked") {
    return { status: "blocked", traversal };
  }
  if (outcome.status === "deflected") {
    return { status: "deflected", traversal, active: outcome.active };
  }
  throw new Error(`Unexpected enter iteration outcome: ${outcome}`);
}

function resetTraversalForEntry(
  traversal: Traversal,
  node: Node,
  nextEnterCount: number,
  forceClearFrame = false,
): void {
  traversal.enterCount = nextEnterCount;
  traversal.state = undefined;
  traversal.finalizing = undefined;
  traversal.enterChannels = createEmptyEnterChannelState();
  if (isArcTraversal(traversal)) {
    traversal.phase = "entered";
  }
  if (forceClearFrame || !node.resumable) clearFrame(traversal);
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
