import type {
  HostEffectBrief,
  InstructionBrief,
  InstructionPostcheck,
} from "../types/host-interaction.js";
import type {
  ActionStatement,
  CatchDeflectionStatement,
  EffectStatement,
  ElementId,
  EnterChannelBindings,
  GuardStatement,
  InstructionAction,
  InvokeAction,
  MapAction,
  Node,
  ResolutionStatement,
  SegKey,
  SetSpanAction,
  Statement,
  TriggerStatement,
} from "../types/parser.js";
import type {
  ArcRef,
  ArcTraversal,
  BriefId,
  DeflectionContext,
  EnterChannelLink,
  MapActionState,
  NodeRef,
  NodeState,
  PinTape,
  SegId,
  StateSnapshot,
  Traversal,
} from "../types/runtime.js";
import {
  catchSegKey,
  hookSegKey,
  invokeSegKey,
  mapMemberSegKey,
  nodeSegKey,
  qualifiedBriefSite,
} from "../types/runtime.js";
import type { ArrayElementSpec } from "../types/spec.js";
import {
  type ArrayElementValue,
  type ArrayValue,
  type CellValue,
  type PayloadValue,
} from "../types/value.js";
import {
  cloneWithCanonicalNumbers,
  firstNonFiniteNumberPath,
  mergeAndClonePayload,
} from "../value-utils.js";
import { resolveReturnChannelBinding } from "./enter-channels.js";
import {
  type ActionOutcome,
  assertAssignableValue,
  evaluateValueExpression,
  findCellOwner,
  initializeArtifactCells,
  renderHostEffect,
  renderSemanticText,
  requireArrayValue,
  resolveRefInTraversal,
  truthy,
  writeOwnedCell,
  writeOwnedCellValue,
} from "./evaluate.js";
import {
  evaluatorNarrowScope,
  isResolvedNarrowLeaf,
  nodeNarrowScope,
  stepNarrowLeaf,
} from "./narrow-leaf.js";
import {
  beginPinForElement,
  dropAllPinTapes,
  dropPinTape,
  erasePinTape,
  pinTapeFor,
  readValuePin,
  recordValuePin,
} from "./pins.js";
import {
  arcToNodeRef,
  findTraversalInSet,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  isArcRef,
  isArcTraversal,
  resolveLexicalRef,
  rootRefOf,
  toAnonymousCopyRef,
  toNodeRef,
  toNodeRefParts,
  traversalToNodeRef,
} from "./refs.js";
import { runtimeError } from "./report-validation.js";
import { captureReadSet, readSetRewalkStep } from "./rewalk.js";
import {
  type BranchResult,
  type IfLike,
  type LeafStep,
  type ReturnLike,
  type SegFrame,
  type SegHooks,
  type SegOutcome,
  blockSeg,
  blockTraversal,
  deflectSeg,
  runSeg,
} from "./seg.js";
import {
  type Accumulator,
  type EnterTarget,
  actionPreSnapshot,
  briefSiteQualifiers,
  canBatchInstruction,
  cellValuesEqual,
  clearActionState,
  clearEnteredByForAction,
  clearEvaluatorActionStates,
  clearFrame,
  cloneCellValue,
  cloneEnterChannelLink,
  cloneInstructionPostcheck,
  createEmptyArcTraversal,
  createEmptyEnterChannelState,
  createEmptyNodeTraversal,
  dedupeBriefIds,
  ensureEphemeralTraversal,
  ensureOwnedTraversal,
  findEphemeralTraversal,
  getActionState,
  getMapArena,
  hasPendingTransitionLatch,
  instructionBatchSignature,
  isEnteredTraversal,
  isInstructionBatchActive,
  isResolvedActionState,
  isSuspendedArcTraversal,
  latchEnteredTransition,
  latchExitedTransition,
  makeInstructionId,
  markActionResolved,
  markPendingActionState,
  markResolvedActionState,
  noteBriefYield,
  recordPendingTransition,
  replaceEphemeralTraversal,
  selectActionRootTraversal,
  setActiveTraversal,
  stampEnteredBy,
} from "./state.js";

type TerminalTraversalState = Extract<NodeState, "covered" | "skipped">;

type TraversalOutcome =
  | { status: "done"; finalState: TerminalTraversalState }
  | { status: "blocked" }
  | { status: "deflected"; deflection: DeflectionContext };

type HookOutcome<TResult> = SegOutcome<TResult>;

type EnterActionOutcome =
  | {
      status: "resolved";
      traversal: Traversal;
      finalState: TerminalTraversalState;
    }
  | { status: "blocked"; traversal: Traversal }
  | {
      status: "deflected";
      traversal: Traversal;
      deflection: DeflectionContext;
    };

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

/**
 * Whether a recorded SEG is an attached hook body — a pending instruction's
 * `resolveWhen` / `deflectWhen` or an `enterLoop`'s `resolveWhen`. Resume routes
 * a hook SEG through its owner action before re-walking the enclosing body.
 */
function isHookSeg(
  seg: SegId,
): seg is Extract<
  SegId,
  { kind: "resolveWhen" | "deflectWhen" | "enterLoop" }
> {
  return (
    seg.kind === "resolveWhen" ||
    seg.kind === "deflectWhen" ||
    seg.kind === "enterLoop"
  );
}

/** The hook SEG identity for a pending instruction blocked on its hook. */
function instructionHookSeg(
  statement: InstructionAction,
): Extract<SegId, { kind: "resolveWhen" | "deflectWhen" }> {
  return statement.resolveWhen
    ? { kind: "resolveWhen", owner: statement.id }
    : { kind: "deflectWhen", owner: statement.id };
}

/**
 * Reconstructs the `walkSeg` frame stack at the point a target action runs,
 * addressing it at any nesting by lexical descent. The returned frames are
 * root-first and exactly mirror the stack the walk would hold on reaching the
 * target: each frame's `index` is local to its own `statements` array — the
 * offset toward (or at) the target at that level — and `label` is set iff that
 * array IS a `label`'s body (carrying that label's name). This mirrors
 * `walkSeg`, which pushes a labeled body as its own frame while the parent frame
 * stays pointing at the `label` statement.
 *
 * `mode` "at" lands the deepest frame on the target itself (re-running it);
 * "after" lands one past it (skipping it), leaving the index at the branch
 * length when the target is last — `walkSeg`'s pop chain bumps the parent.
 *
 * Returns `undefined` when the target is absent; the caller decides whether that
 * is recoverable. Generalizes the former flat owner lookup to any nesting.
 */
export function resumePath(
  statements: readonly Statement[],
  targetActionId: ElementId,
  mode: "at" | "after",
): SegFrame<Statement>[] | undefined {
  const stack: SegFrame<Statement>[] = [];
  return descendResumePath(statements, targetActionId, mode, undefined, stack)
    ? stack
    : undefined;
}

/**
 * Pushes the frames addressing `targetActionId` within `statements` onto
 * `stack`, where `frameLabel` is the label this array belongs to (a `label`'s
 * body) or `undefined` (the node body or an `if` branch). Statements evaluate
 * against pin entries keyed by their element ids, so a positioned resume needs
 * no separate entry-position bookkeeping. Returns whether the target was
 * found; on a miss it leaves `stack` unchanged.
 */
function descendResumePath(
  statements: readonly Statement[],
  targetActionId: ElementId,
  mode: "at" | "after",
  frameLabel: string | undefined,
  stack: SegFrame<Statement>[],
): boolean {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;

    if (statement.kind === "break") continue;

    if (statement.kind === "if") {
      const depth = stack.length;
      stack.push({ statements, index, label: frameLabel });
      if (
        descendResumePath(
          statement.consequent,
          targetActionId,
          mode,
          undefined,
          stack,
        ) ||
        descendResumePath(
          statement.alternate ?? [],
          targetActionId,
          mode,
          undefined,
          stack,
        )
      ) {
        return true;
      }
      stack.length = depth;
      continue;
    }

    if (statement.kind === "label") {
      const depth = stack.length;
      stack.push({ statements, index, label: frameLabel });
      if (
        descendResumePath(
          statement.body,
          targetActionId,
          mode,
          statement.label,
          stack,
        )
      ) {
        return true;
      }
      stack.length = depth;
      continue;
    }

    if (statement.id === targetActionId) {
      stack.push({
        statements,
        index: mode === "at" ? index : index + 1,
        label: frameLabel,
      });
      return true;
    }
  }
  return false;
}

/**
 * Runs a nested SEG walk with `accum.pin` saved and restored, so the inner
 * SEG's statement scopes never clobber the enclosing statement's pin cursor —
 * an instruction's hook consultation returns to the instruction's own entries
 * with its replay position intact.
 */
function withPinScope<T>(accum: Accumulator, walk: () => T): T {
  const saved = accum.pin;
  try {
    return walk();
  } finally {
    accum.pin = saved;
  }
}

/**
 * Runs one SEG under a pin scope wired to `tape`: every evaluated statement
 * opens its pin entries, and a re-walk restart erases the tape (dial-back).
 * Every SEG executor goes through here, so the pin-open / tape-erase pairing
 * cannot be half-wired.
 */
function runPinnedSeg<
  TStatement extends { kind: string; id: ElementId },
  TResult,
>(
  accum: Accumulator,
  tape: PinTape,
  statements: readonly TStatement[],
  hooks: Omit<
    SegHooks<TStatement, TResult>,
    "beginStatement" | "onRewalkRestart"
  >,
  initialStack?: SegFrame<TStatement>[],
): SegOutcome<TResult> {
  return withPinScope(accum, () =>
    runSeg<TStatement, TResult>(
      statements,
      {
        ...hooks,
        beginStatement: (statement) =>
          beginPinForElement(accum, tape, statement.id),
        onRewalkRestart: () => erasePinTape(tape),
      },
      initialStack,
    ),
  );
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

/**
 * Evaluates a `return <expr>` in a boolean SEG (trigger / resolution hook): a
 * bare `return` is `false`, a blocked expression suspends the SEG, otherwise the
 * truthiness of the value is the SEG's result.
 */
function evaluateBooleanReturn(
  statement: ReturnLike,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): SegOutcome<boolean> {
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
}

export function runTrigger(
  node: Node,
  traversal: Traversal,
  accum: Accumulator,
  tape: PinTape,
): boolean {
  if (!node.trigger) return true;

  // The trigger consultation's pin tape is call-state supplied by the trigger
  // brief chain (per candidate), not traversal state — a process restart
  // starts fresh consultations.
  const scope = evaluatorNarrowScope(traversal, nodeSegKey("trigger"));
  const outcome = runPinnedSeg<TriggerStatement, boolean>(
    accum,
    tape,
    node.trigger,
    {
      doneValue: false,
      evaluateIf: (statement) =>
        evaluateIfBranch(statement, traversal, node, accum),
      evaluateReturn: (statement) =>
        evaluateBooleanReturn(statement, traversal, node, accum),
      isResolvedLeaf: (statement) => isResolvedNarrowLeaf(statement, scope),
      stepLeaf: (statement) => {
        const step = stepNarrowLeaf<boolean>(
          statement,
          traversal,
          node,
          accum,
          scope,
        );
        if (step) return step;
        throw new Error(
          `Unsupported trigger leaf statement: ${statement.kind}`,
        );
      },
    },
  );
  if (outcome.status === "blocked") return false;
  if (outcome.status === "deflected") {
    throw new Error("Triggers cannot deflect");
  }
  clearEvaluatorActionStates(traversal, nodeSegKey("trigger"));
  return truthy(outcome.value);
}

function runGuardStatements(
  node: Node,
  traversal: Traversal,
  statements: GuardStatement[],
  accum: Accumulator,
): ActionOutcome<NodeState | undefined> {
  const scope = nodeNarrowScope(traversal);
  const tape = pinTapeFor(traversal, nodeSegKey("guard"));
  const outcome = runPinnedSeg<GuardStatement, NodeState | undefined>(
    accum,
    tape,
    statements,
    {
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
      isResolvedLeaf: (statement) => isResolvedNarrowLeaf(statement, scope),
      stepLeaf: (statement) => {
        const step = stepNarrowLeaf<NodeState | undefined>(
          statement,
          traversal,
          node,
          accum,
          scope,
        );
        if (step) return step;
        throw new Error(`Unsupported guard leaf statement: ${statement.kind}`);
      },
    },
  );
  if (outcome.status === "blocked") {
    return { status: "blocked" };
  }
  if (outcome.status === "deflected") {
    throw new Error("Guards cannot deflect");
  }
  // Guard completion ends the consultation: the next guard run is fresh.
  dropPinTape(traversal, nodeSegKey("guard"));
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
  if (shouldInitializeRootArtifactCells(accum.traversal, rootNode)) {
    initializeArtifactCells(accum.traversal, rootNode, accum);
  }
  runTraversal(accum.traversal, rootNode, accum, true);
}

function nodeForTraversal(accum: Accumulator, traversal: Traversal): Node {
  const entry = getEntryForRef(accum.entries, traversal.ref) ?? accum.entry;
  const node = getNodeForRef(accum.entries, entry, traversal.ref);
  if (!node) {
    throw new Error(
      `Unknown traversal node: ${formatRef(traversalToNodeRef(traversal))}`,
    );
  }
  return node;
}

/**
 * Resumes one traversal at a recorded frontier: resolves its node and root-ness
 * from the traversal, then runs the engine. The middle layer between
 * `resumeActiveFrame` (which orchestrates resume and bubble-up across levels) and
 * `runTraversal` (the engine, which takes `node` / `isRoot` explicitly).
 */
function resumeTraversal(
  traversal: Traversal,
  accum: Accumulator,
  resumeSeg: SegId | undefined,
  bodyResumeStack?: SegFrame<Statement>[],
): TraversalOutcome {
  const node = nodeForTraversal(accum, traversal);
  const isRoot = isArcTraversal(traversal) && traversal.enteredBy === undefined;
  return runTraversal(
    traversal,
    node,
    accum,
    isRoot,
    resumeSeg,
    bodyResumeStack,
  );
}

/**
 * Blocks the walk at a transition gate: stamps `position` — the view
 * coordinate — onto the latch, persists the stretch onto the action root as
 * `pendingTransition`, and suspends at `traversal` under the current
 * `activeSeg` so the acknowledging report resumes exactly here. Callers set
 * `accum.activeSeg` before invoking.
 */
function blockForTransition(
  accum: Accumulator,
  traversal: Traversal,
  position: NodeRef,
): { status: "blocked" } {
  setActiveTraversal(accum, traversal);
  recordPendingTransition(accum, position);
  return blockTraversal(accum, traversal);
}

/**
 * The transition gate placed at every authored-evaluation site: when the walk
 * carries latched position changes, yield them before evaluating anything at
 * the current position. The evaluating traversal is the position.
 */
function maybeBlockForTransition(
  accum: Accumulator,
  traversal: Traversal,
): { status: "blocked" } | undefined {
  if (!hasPendingTransitionLatch(accum)) return undefined;
  return blockForTransition(accum, traversal, traversalToNodeRef(traversal));
}

/**
 * Resumes the recorded active SEG from its suspended position and propagates
 * completion up through `enteredBy` markers. The suspended frontier is replayed
 * directly, and an ancestor resumes only as control returns to it, so a
 * suspended child's committed mutation never leaks into a parent branch before
 * the child resolves.
 */
export function resumeActiveFrame(accum: Accumulator): void {
  const root = selectActionRootTraversal(accum.traversals, accum.entry.arc);
  const frame = root.activeFrame;
  if (!frame) {
    throw new Error(
      "Resume requested without a recorded active frame on the action root",
    );
  }
  let active = findTraversalInSet(accum.traversals, frame.activeRef);
  if (!active) {
    throw new Error(
      `Active traversal not found for resume: ${formatRef(frame.activeRef)}`,
    );
  }

  let outcome = resumeTraversal(active, accum, frame.activeSeg);

  while (true) {
    if (outcome.status === "blocked") return;

    // The active SEG reached terminal. Return control to the exact caller enter
    // action via `enteredBy`; absence means the action root, so the arc has
    // completed or deflected.
    const enteredBy = active.enteredBy;
    if (!enteredBy) return;

    const caller = findTraversalInSet(accum.traversals, enteredBy.callerRef);
    if (!caller) {
      throw new Error(
        `Caller traversal not found for bubble-up: ${formatRef(enteredBy.callerRef)}`,
      );
    }

    if (outcome.status === "deflected") {
      // The active SEG deflected: its owning enter deflects too, and the
      // deflection propagates to the caller's catch. An enter inside an invoke
      // body abandons the open invocation as the deflection crosses it, so the
      // caller's catch rewalk re-reaches a fresh invocation.
      clearActionState(caller, enteredBy.actionId);
      clearInvokeStateCrossedByDeflection(
        caller,
        nodeForTraversal(accum, caller),
        enteredBy.actionId,
      );
      caller.finalizing = {
        reason: "deflected",
        deflection: {
          origin: outcome.deflection.origin,
          from: entryTargetRefOf(traversalToNodeRef(active), accum),
        },
        phase: "catch",
      };
      outcome = resumeTraversal(caller, accum, undefined);
    } else {
      // Covered/skipped: a latched exit yields its transition before the caller
      // evaluates anything under the old view. The frame stays at the terminal
      // child (its guard short-circuits on resume and bubble-up redoes this
      // hop), while the position is the caller about to evaluate.
      if (hasPendingTransitionLatch(accum)) {
        accum.activeSeg = { kind: "guard" };
        blockForTransition(accum, active, enteredBy.callerRef);
        return;
      }
      // Resolve/advance the owning enter action atomically, then
      // continue the caller with the SAME read-set diff the synchronous enter
      // uses — no special-casing of the report boundary. Read the persisted
      // pre-snapshot before `resolveEnterAfterChild` (which clears a resolved
      // enter's state) so the after-snapshot is diffed against the bracket the
      // enter opened when its target first ran.
      const callerNode = nodeForTraversal(accum, caller);
      const preSnapshot = actionPreSnapshot(
        caller.frame.actionStates[enteredBy.actionId],
      );
      resolveEnterAfterChild(caller, enteredBy.actionId, active, accum);
      outcome = continueCallerAfterEnter(
        caller,
        callerNode,
        enteredBy.actionId,
        preSnapshot,
        accum,
      );
    }
    active = caller;
  }
}

/**
 * Continues a caller after one of its enter actions resolved out of band during
 * bubble-up, applying the same `readSetRewalkStep` decision the synchronous enter
 * uses — at any nesting, by reconstructing the caller's suspended position.
 *
 * A resolved enter advances the position just past it when its bracketed
 * read-set did not change, and applies the caller node's configured write-diff
 * behavior when it did. A still-pending enter (a covered `enterLoop` iteration
 * advanced to its `resolveWhen`) re-reaches the loop positionally — the body
 * resumes AT the loop so its eventual resolution flows through the same
 * `readSetRewalkStep`.
 *
 * A missing resume path (runtime drift) safely falls back to a root re-walk in
 * both cases — a resolved enter has no un-carried-out owner, and a still-pending
 * `enterLoop` is a plain body action a root re-walk re-derives, unlike a hook
 * owner that must be carried out first.
 */
function continueCallerAfterEnter(
  caller: Traversal,
  callerNode: Node,
  actionId: ElementId,
  preSnapshot: StateSnapshot | undefined,
  accum: Accumulator,
): TraversalOutcome {
  const enterResolved =
    caller.frame.actionStates[actionId]?.status !== "pending";

  // An enter inside an invoke body continues inside the owning invocation:
  // the child-to-invoke rewalk decision applies there, against the innermost
  // invoke's local plan, and the body resumes positioned AT the outermost
  // invoke so `stepInvoke` seeks its suspended body — the invoke-to-parent
  // decision then happens at the invoke boundary when the invocation
  // completes.
  const chain = wideBodyChainTo(callerNode.statements, actionId);
  if (chain && chain.length > 0) {
    const innermost = chain[chain.length - 1]!;
    // An enter that resolves inside a `$map` member routes at the map, whose
    // member tape the driver manages; only an invoke body's tape is dialed
    // back here. Enter-in-member is not yet wired, so innermost is an invoke.
    if (enterResolved && innermost.kind === "invoke") {
      const step = readSetRewalkStep(preSnapshot, caller, callerNode, accum);
      if (step.status === "rewalk") {
        // Dial the invocation's body back: its sigil-less pins release and
        // the seek below re-derives the body under the changed state.
        dropPinTape(caller, invokeSegKey(innermost.id));
      }
    }
    const invokeStack = resumePath(callerNode.statements, chain[0]!.id, "at");
    return resumeTraversal(caller, accum, { kind: "body" }, invokeStack);
  }

  if (!enterResolved) {
    const reReachStack = resumePath(callerNode.statements, actionId, "at");
    return resumeTraversal(caller, accum, { kind: "body" }, reReachStack);
  }

  const step = readSetRewalkStep(preSnapshot, caller, callerNode, accum);
  if (step.status === "advance") {
    const advanceStack = resumePath(callerNode.statements, actionId, "after");
    return resumeTraversal(caller, accum, { kind: "body" }, advanceStack);
  }
  // Changed read-set: re-walk the caller body from the root with no stack.
  // This is a dial-back site: the caller body's sigil-less pins release
  // before the restart re-derives the route under the changed state.
  dropPinTape(caller, nodeSegKey("body"));
  return resumeTraversal(caller, accum, { kind: "body" }, undefined);
}

function runTraversal(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  isRoot = false,
  resumeSeg?: SegId,
  bodyResumeStack?: SegFrame<Statement>[],
): TraversalOutcome {
  // `resumeSeg` and `bodyResumeStack` apply only to the first restart iteration:
  // a resume that begins at the action body skips the guard, so a body block does
  // not rerun the guard under changed state, and an unchanged-read bubble-up
  // resumes the body just past the resolved enter. Finalizing (effects/catch)
  // always wins; a re-walk after a deflection-catch restarts the whole body.
  let entrySeg = resumeSeg;
  let resumeStack = bodyResumeStack;
  while (true) {
    setActiveTraversal(accum, traversal);
    const seg = entrySeg;
    entrySeg = undefined;
    let bodyStack = resumeStack;
    resumeStack = undefined;

    if (traversal.finalizing) {
      const finalized = continueFinalizingTraversal(traversal, node, accum);
      if (finalized.status === "caught") continue;
      return finalized;
    }

    const ownerFirstResume =
      seg !== undefined &&
      (isHookSeg(seg) || seg.kind === "invoke" || seg.kind === "mapMember");
    if (ownerFirstResume) {
      // Resume the recorded hook, invoke, or `$map` member owner-first by
      // reconstructing the resume path AT the owner action. The normal walk
      // re-evaluates its hook (or seeks the suspended invocation / member) and
      // `walkSeg` consumes the same advance-vs-rewalk the synchronous resolve
      // uses — no report-boundary special case. An owner inside a wide body
      // routes at the outermost enclosing invoke or `$map`, whose seeked body
      // re-reaches the owner.
      //
      // A missing path is runtime drift (the recorded owner is absent from the
      // node): throw rather than silently full-rewalking, which would let an
      // earlier branch the hook enabled steal the frontier before the owner is
      // carried out. `Runtime.start` / `Runtime.progress` route the throw to a
      // poisoned-traversal issue.
      const chain = wideBodyChainTo(node.statements, seg.owner);
      const routeId = chain?.[0]?.id ?? seg.owner;
      const ownerStack = resumePath(node.statements, routeId, "at");
      if (!ownerStack) {
        throw new Error(
          `Recorded hook owner ${seg.owner} not found in node ${node.identifier} on resume`,
        );
      }
      bodyStack = ownerStack;
    }

    if (!isRoot && seg?.kind !== "body" && !ownerFirstResume) {
      const guardPhase = runGuardPhase(traversal, node, accum);
      if (guardPhase.status === "finalizing") continue;
      if (guardPhase.status !== "proceed") return guardPhase;
    }

    accum.activeSeg = { kind: "body" };
    const outcome = runNodeBody(traversal, node, accum, bodyStack);

    if (outcome.status === "blocked") {
      return { status: "blocked" };
    }
    if (outcome.status === "deflected") {
      traversal.finalizing = {
        reason: "deflected",
        deflection: outcome.deflection,
        phase: "catch",
      };
      continue;
    }

    if (isInstructionBatchActive(accum, traversal)) {
      return blockTraversal(accum, traversal);
    }

    traversal.finalizing = {
      reason: "covered",
      phase: "effects",
    };
  }
}

function shouldInitializeRootArtifactCells(
  traversal: Traversal,
  node: Node,
): boolean {
  return (
    traversal.enterCount <= 1 &&
    traversal.state === undefined &&
    traversal.finalizing === undefined &&
    (!("activeFrame" in traversal) || traversal.activeFrame === undefined) &&
    node.cells.some(
      (cell) => cell.type === "artifact" && cell.initializer !== undefined,
    )
  );
}

/**
 * Runs the pre-body guard phase: an already-terminal traversal reports `done`;
 * otherwise the guard may cover/skip, block, or `proceed` into the body.
 */
function runGuardPhase(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
):
  | { status: "proceed" }
  | { status: "finalizing" }
  | { status: "done"; finalState: TerminalTraversalState }
  | { status: "blocked" } {
  if (traversal.state === "covered" || traversal.state === "skipped") {
    return { status: "done", finalState: traversal.state };
  }
  if (!node.guard) return { status: "proceed" };

  accum.activeSeg = { kind: "guard" };
  if (maybeBlockForTransition(accum, traversal)) {
    return { status: "blocked" };
  }
  const guardResult = runGuardStatements(node, traversal, node.guard, accum);
  if (guardResult.status === "blocked") {
    return { status: "blocked" };
  }
  if (guardResult.value === "covered" || guardResult.value === "skipped") {
    traversal.state = guardResult.value;
    // A guard-covered/skipped node exits without a body or finalizing pass, so
    // its exit latches here.
    latchExitedTransition(accum, traversalToNodeRef(traversal));
    return { status: "done", finalState: guardResult.value };
  }
  if (guardResult.value === "deflected") {
    traversal.finalizing = {
      reason: "deflected",
      // Guard deflection is this node's own; it entered nothing, so `from` stays
      // unset until it propagates up through a parent's enter boundary.
      deflection: { origin: traversalToNodeRef(traversal) },
      phase: "catch",
    };
    return { status: "finalizing" };
  }
  traversal.state = undefined;
  return { status: "proceed" };
}

/** Runs the node body SEG to a terminal outcome. */
function runNodeBody(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  bodyStack: SegFrame<Statement>[] | undefined,
): SegOutcome<void> {
  const tape = pinTapeFor(traversal, nodeSegKey("body"));
  // The body tape outlives this call: a done pass with an active instruction
  // batch blocks and later seeks the same walk, so its pins must survive.
  // Release happens at the dial-back sites — the in-walk restart here, the
  // caught-deflection restart, the changed-read-set caller continuation — and
  // when the traversal finalizes or is re-entered.
  return runBodySeg(traversal, node, accum, node.statements, tape, bodyStack);
}

/**
 * Runs an action-body SEG — the node body or an invoke body — against its
 * tape: the two share leaf semantics, transition gating, and pin wiring.
 */
function runBodySeg(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  statements: readonly Statement[],
  tape: PinTape,
  bodyStack?: SegFrame<Statement>[],
): SegOutcome<void> {
  return runPinnedSeg<Statement, void>(
    accum,
    tape,
    statements,
    {
      doneValue: undefined,
      evaluateIf: (statement) =>
        maybeBlockForTransition(accum, traversal) ??
        evaluateIfBranch(statement, traversal, node, accum),
      isResolvedLeaf: (statement) => isResolvedActionLeaf(traversal, statement),
      stepLeaf: (statement) =>
        stepActionLeaf(traversal, node, statement, accum),
    },
    bodyStack,
  );
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
    accum.activeSeg = { kind: "catch" };
    // A declared catch hook is an authored evaluation at this node; gate a
    // latched transition before it. A hookless node passes through and its
    // exit coalesces.
    if (node.catchDeflection && node.catchDeflection.length > 0) {
      const gated = maybeBlockForTransition(accum, traversal);
      if (gated) return gated;
    }
    const caught = evaluateCatchDeflection(
      traversal,
      node,
      accum,
      finalizing.deflection,
    );
    if (caught.status === "blocked") return { status: "blocked" };
    if (caught.value) {
      traversal.finalizing = undefined;
      // The caught-deflection restart is a dial-back of this node's body SEG:
      // the abandoned walk's sigil-less pins release, resolved `$` slots stay.
      dropPinTape(traversal, nodeSegKey("body"));
      return { status: "caught" };
    }
    traversal.finalizing = { ...finalizing, phase: "effects" };
  }

  accum.activeSeg = { kind: "effects" };
  // Same rule for declared effects: they run (and their host effects surface)
  // only under the node's own acknowledged view.
  if (node.effects && node.effects.length > 0) {
    const gated = maybeBlockForTransition(accum, traversal);
    if (gated) return gated;
  }
  const effects = runEffects(traversal, node, accum);
  if (effects.status !== "done") return effects;

  traversal.finalizing = undefined;
  // The traversal is terminal: every walk it owned is over, so all of its
  // sigil-less pins release. Resolved `$` slots persist in the frame.
  dropAllPinTapes(traversal);
  traversal.state = finalizing.reason;
  if (isArcTraversal(traversal)) {
    traversal.phase =
      finalizing.reason === "covered" ? "completed" : "suspended";
  }
  latchExitedTransition(accum, traversalToNodeRef(traversal));
  if (finalizing.reason === "deflected") {
    return {
      status: "deflected",
      deflection: finalizing.deflection,
    };
  }
  return { status: "done", finalState: "covered" };
}

function isResolvedActionLeaf(
  traversal: Traversal,
  statement: Statement,
): boolean {
  // An invoke is never resolved through its frame slot: its completion is a
  // sigil-less pin consulted by `stepInvoke`, so it re-steps here and skips
  // (or re-runs) against the enclosing SEG's tape.
  if (
    statement.kind !== "observe" &&
    statement.kind !== "observeOrAsk" &&
    statement.kind !== "observeGroup" &&
    statement.kind !== "observeOrAskGroup" &&
    statement.kind !== "set" &&
    statement.kind !== "set-return" &&
    statement.kind !== "set-span" &&
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
  statement: Statement,
  accum: Accumulator,
): LeafStep<void> {
  // Enter leaves are exempt: their target phase performs no view-dependent
  // evaluation, which is what lets guard-less enter chains coalesce into one
  // multi-element transition.
  if (statement.kind !== "enter-node" && statement.kind !== "enter-loop") {
    const gated = maybeBlockForTransition(accum, traversal);
    if (gated) return gated;
  }
  if (
    isInstructionBatchActive(accum, traversal) &&
    statement.kind !== "instruction"
  ) {
    return blockSeg(accum, traversal);
  }

  const narrow = stepNarrowLeaf<void>(
    statement,
    traversal,
    node,
    accum,
    nodeNarrowScope(traversal),
  );
  if (narrow) return narrow;

  // `span.result.$set(...)` settles in place inside the running member and does
  // not disturb the member frontier, so it takes the narrow path rather than
  // the wide-action restore below.
  if (statement.kind === "set-span") {
    return stepSetSpan(traversal, node, statement, accum);
  }

  if (
    statement.kind === "instruction" ||
    statement.kind === "enter-node" ||
    statement.kind === "enter-loop" ||
    statement.kind === "invoke" ||
    statement.kind === "map"
  ) {
    const step =
      statement.kind === "instruction"
        ? runInstructionAction(traversal, node, statement, accum)
        : statement.kind === "invoke"
          ? stepInvoke(traversal, node, statement, accum)
          : statement.kind === "map"
            ? stepMap(traversal, node, statement, accum)
            : runEnterAction(traversal, node, statement, accum);
    restoreBodySegAfterWideAction(accum);
    return step;
  }

  throw new Error("Unsupported action leaf statement");
}

/**
 * Restores the containing SEG after a wide action (`instruct` / `enter` /
 * `enterLoop` / `invoke`). A wide action that blocked inside its attached hook
 * leaves that hook SEG active so the enclosing block records it as the resume
 * frontier; any other outcome is back in the containing SEG — the innermost
 * open invoke body, or the node body. This is the one place that normalizes
 * `activeSeg` after a wide leaf, so a future action path cannot forget the
 * reset and record the wrong SEG.
 */
function restoreBodySegAfterWideAction(accum: Accumulator): void {
  if (isHookSeg(accum.activeSeg)) return;
  const inner = accum.invokeContext?.[accum.invokeContext.length - 1];
  accum.activeSeg = inner
    ? { kind: "invoke", owner: inner.id }
    : { kind: "body" };
}

/**
 * Runs an enter action — `$enter(...)` or `$enterLoop(...)` — to a terminal step.
 *
 * The two are one operation at different settings: an `enter` is a
 * single-iteration, always-resolve `enterLoop`. The shared engine alternates two
 * phases per iteration:
 *
 * - `target`: enter the target child — applying a `forgetful`/`newcopy` decorator
 *   when present. A covered target is never routed here on resume: bubble-up
 *   resolves a covered `enter` and routes a covered loop iteration to
 *   `resolveWhen` directly, so this phase always genuinely (re-)enters.
 * - `resolveWhen` (`enterLoop` only): evaluate the hook — loop again on false,
 *   resolve and commit the staged returns transaction on true. `enter` never
 *   reaches this phase; its action resolves the moment its target covers.
 *
 * Returns are staged across iterations and committed only at resolution, so an
 * `enterLoop`'s returns stay transactional until the whole loop resolves.
 */
function runEnterAction(
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
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
  let phase: "target" | "resolveWhen" =
    existingState?.status === "pending" &&
    existingState.enterPhase === "resolveWhen"
      ? "resolveWhen"
      : "target";
  // Bracket the whole child subtree: capture the caller read-set once, before
  // the target first runs, and reuse the persisted snapshot across blocked
  // child execution. Diffed against the after-snapshot when the enter resolves.
  const preSnapshot =
    existingState?.status === "pending"
      ? existingState.preSnapshot
      : captureReadSet(traversal, node, accum);

  restart: while (true) {
    if (phase === "resolveWhen") {
      if (statement.kind !== "enter-loop") {
        throw new Error("resolveWhen phase is only valid for enterLoop");
      }
      // Evaluate the loop's resolveWhen under the hook SEG so a block records the
      // hook and the next report resumes it owner-first, before the body.
      accum.activeSeg = { kind: "enterLoop", owner: statement.id };
      const resolution = evaluateBooleanHook(
        statement.resolveWhen,
        traversal,
        node,
        accum,
        hookSegKey(statement.id, "resolveWhen"),
      );
      if (resolution.status === "blocked") {
        persistPendingEnterState(
          traversal,
          statement,
          "resolveWhen",
          stagedReturns,
          preSnapshot,
        );
        return blockSeg(accum, traversal);
      }
      accum.activeSeg = { kind: "body" };
      clearEvaluatorActionStates(
        traversal,
        hookSegKey(statement.id, "resolveWhen"),
      );
      if (!truthy(resolution.value)) {
        prepareNextEnterLoopIteration(
          traversal,
          target,
          accum,
          statement.target.mode === "forgetful",
        );
        phase = "target";
        continue restart;
      }
      const resolvedTarget = findExistingEnterTarget(traversal, target, accum);
      if (!resolvedTarget) {
        throw new Error(
          `Enter target traversal not found at resolution: ${formatRef(target.ref)}`,
        );
      }
      commitEnterReturnChannels(resolvedTarget, accum, stagedReturns);
      markActionResolved(traversal, statement);
      clearEnteredByForAction(
        resolvedTarget,
        traversalToNodeRef(traversal),
        statement.id,
      );
      return readSetRewalkStep(preSnapshot, traversal, node, accum);
    }

    // `target` phase: genuinely enter the target (decorator applied).
    const result = runEnterIteration(traversal, node, statement, target, accum);
    if (result.status === "blocked") {
      persistPendingEnterState(
        traversal,
        statement,
        "target",
        stagedReturns,
        preSnapshot,
      );
      return { status: "blocked" };
    }
    if (result.status === "deflected") {
      clearActionState(traversal, statement.id);
      return {
        status: "deflected",
        deflection: {
          origin: result.deflection.origin,
          from: entryTargetRefOf(traversalToNodeRef(result.traversal), accum),
        },
      };
    }

    // A latched transition yields before the caller evaluates anything at the
    // resolved target (returns commit, read-set diff, `resolveWhen`). The enter
    // stays pending exactly like the blocked branch, the frame lands at the
    // terminal child, and the acknowledging report redoes this hop through the
    // proven bubble-up path under the fresh dialog.
    if (hasPendingTransitionLatch(accum)) {
      persistPendingEnterState(
        traversal,
        statement,
        "target",
        stagedReturns,
        preSnapshot,
      );
      accum.activeSeg = { kind: "guard" };
      return blockForTransition(
        accum,
        result.traversal,
        traversalToNodeRef(traversal),
      );
    }

    // Target reached a terminal state. An `enter` resolves now; an `enterLoop`
    // folds the iteration's returns into its transaction and evaluates
    // `resolveWhen`.
    if (statement.kind === "enter-node") {
      if (result.finalState === "covered") {
        commitEnterReturnChannels(result.traversal, accum);
      }
      markActionResolved(traversal, statement);
      clearEnteredByForAction(
        result.traversal,
        traversalToNodeRef(traversal),
        statement.id,
      );
      return readSetRewalkStep(preSnapshot, traversal, node, accum);
    }

    if (result.finalState === "covered") {
      mergeStagedReturns(stagedReturns, result.traversal);
    }
    phase = "resolveWhen";
    continue restart;
  }
}

/**
 * Returns control to a blocked enter action whose target resolved out of band
 * during single-active-SEG resume. An `enter` resolves atomically — commit
 * returns, mark resolved — so the caller re-walk sees it resolved and skipped. A
 * covered `enterLoop` iteration is folded into the loop's returns transaction
 * and the loop advances to `resolveWhen`; the loop itself resolves later.
 */
function resolveEnterAfterChild(
  caller: Traversal,
  actionId: ElementId,
  child: Traversal,
  accum: Accumulator,
): void {
  const state = caller.frame.actionStates[actionId];
  if (state?.kind === "enter-loop") {
    const stagedReturns = { ...(state.stagedReturns ?? {}) };
    if (child.state === "covered") {
      mergeStagedReturns(stagedReturns, child);
    }
    // Preserve the pre-snapshot across the bubble-up so the loop can still diff
    // it when `resolveWhen` finally resolves.
    markPendingActionState(caller, actionId, "enter-loop", {
      enterPhase: "resolveWhen",
      stagedReturns,
      preSnapshot: state.preSnapshot,
    });
    return;
  }

  if (child.state === "covered") {
    commitEnterReturnChannels(child, accum);
  }
  markResolvedActionState(caller, actionId, "enter-node");
  clearEnteredByForAction(child, traversalToNodeRef(caller), actionId);
}

/** Drains a covered target's staged returns into the action's transaction. */
function mergeStagedReturns(
  stagedReturns: Record<string, CellValue>,
  target: Traversal,
): void {
  Object.assign(stagedReturns, target.enterChannels.stagedReturns);
  target.enterChannels.stagedReturns = {};
}

function runEnterIteration(
  callerTraversal: Traversal,
  callerNode: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
  target: EnterTarget,
  accum: Accumulator,
): EnterActionOutcome {
  const callerRef = traversalToNodeRef(callerTraversal);

  if (target.kind === "referenced") {
    if (!callerTraversal.refChildren.some((item) => item === target.ref)) {
      callerTraversal.refChildren.push(target.ref);
    }
    const referencedTraversal = ensureReferencedTraversal(
      accum,
      target.ref,
      target.entry.root,
    );
    const firstEntry = prepareTraversalForEntry(
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
    if (firstEntry) {
      initializeArtifactCells(referencedTraversal, target.entry.root, accum);
    }
    // Mark the referenced arc as owned by this enter so completion bubbles back
    // to the exact caller node and action (replacing `returnTo`).
    stampEnteredBy(referencedTraversal, callerRef, statement.id);
    latchEnterTransition(accum, statement, referencedTraversal);
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
  const firstEntry = prepareTraversalForEntry(
    childTraversal,
    target.node,
    statement.target,
  );
  applyEnterChannels(
    callerTraversal,
    callerNode,
    statement,
    childTraversal,
    accum,
  );
  if (firstEntry) {
    initializeArtifactCells(childTraversal, target.node, accum);
  }
  stampEnteredBy(childTraversal, callerRef, statement.id);
  latchEnterTransition(accum, statement, childTraversal);

  const childOutcome = runTraversal(childTraversal, target.node, accum, false);
  return toEnterActionOutcome(childOutcome, childTraversal);
}

/**
 * Latches a genuine traversal entry. A target still terminal after entry
 * preparation resolves from its preserved state without a body pass — a
 * re-derivation of the enter (e.g. a forgetful-entry caller's frame reset
 * re-reaching a covered child), not a genuine entry — so it announces no
 * position change.
 */
function latchEnterTransition(
  accum: Accumulator,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
  target: Traversal,
): void {
  if (target.state === "covered" || target.state === "skipped") return;
  latchEnteredTransition(accum, traversalToNodeRef(target));
}

function findExistingEnterTarget(
  callerTraversal: Traversal,
  target: EnterTarget,
  accum: Accumulator,
): Traversal | undefined {
  if (target.kind === "anonymous-copy") {
    return findEphemeralTraversal(callerTraversal, target.ref);
  }
  if (target.kind === "referenced") {
    return findTraversalInSet(accum.traversals, arcToNodeRef(target.ref));
  }
  return findTraversalInSet(accum.traversals, target.ref);
}

/**
 * A wide-body owner runs an attached statement graph inline in the enclosing
 * node: an `invoke` per reach, a `$map` callback per member. Resume and
 * deflection-crossing route at the outermost such owner, which then seeks its
 * own suspended body (invoke) or member (map).
 */
type WideBodyAction = InvokeAction | MapAction;

/**
 * The wide-body owner statements (`invoke` / `$map`) enclosing `targetId` within
 * one node's statement tree, outermost first — empty when the target is a
 * top-level statement outside any such owner, `undefined` when the target id
 * does not exist in the node. A target that IS a wide-body owner ends its own
 * chain as the last entry.
 */
function wideBodyChainTo(
  statements: readonly Statement[],
  targetId: ElementId,
): WideBodyAction[] | undefined {
  const chain: WideBodyAction[] = [];
  const descend = (list: readonly Statement[]): boolean => {
    for (const statement of list) {
      if (statement.kind === "if") {
        if (descend(statement.consequent)) return true;
        if (statement.alternate && descend(statement.alternate)) return true;
        continue;
      }
      if (statement.kind === "label") {
        if (descend(statement.body)) return true;
        continue;
      }
      if (statement.kind === "break") continue;
      if (statement.kind === "invoke" || statement.kind === "map") {
        chain.push(statement);
        if (statement.id === targetId) return true;
        if (descend(statement.body)) return true;
        chain.pop();
        continue;
      }
      if (statement.id === targetId) return true;
    }
    return false;
  };
  return descend(statements) ? chain : undefined;
}

/**
 * Clears an invocation's per-invocation state: the invoke's own slot, the
 * body's `$` slots and hook scopes (nested invoke bodies included), and its
 * pin tapes. Called on a fresh reach — a new invocation starts with nothing
 * resolved and nothing pinned — and when a deflection abandons the invocation.
 */
function clearInvokeSubtreeState(
  traversal: Traversal,
  statement: InvokeAction,
): void {
  clearActionState(traversal, statement.id);
  dropPinTape(traversal, invokeSegKey(statement.id));
  clearBodySubtreeState(traversal, statement.body);
}

/**
 * Clears the `$` slots, hook scopes, and nested invoke tapes of one body's
 * statement graph — the per-instance state a fresh reach or an abandoned
 * instance starts without. Shared by the invoke subtree clear and by `$map`
 * member abandonment, which run the same authored body per instance.
 */
function clearBodySubtreeState(
  traversal: Traversal,
  body: readonly Statement[],
): void {
  const visit = (list: readonly Statement[]): void => {
    for (const entry of list) {
      if (entry.kind === "if") {
        visit(entry.consequent);
        if (entry.alternate) visit(entry.alternate);
        continue;
      }
      if (entry.kind === "label") {
        visit(entry.body);
        continue;
      }
      if (entry.kind === "break") continue;
      clearActionState(traversal, entry.id);
      if (entry.kind === "instruction") {
        clearEvaluatorActionStates(
          traversal,
          hookSegKey(entry.id, "resolveWhen"),
        );
        clearEvaluatorActionStates(
          traversal,
          hookSegKey(entry.id, "deflectWhen"),
        );
      }
      if (entry.kind === "enter-loop") {
        clearEvaluatorActionStates(
          traversal,
          hookSegKey(entry.id, "resolveWhen"),
        );
      }
      if (entry.kind === "invoke") {
        dropPinTape(traversal, invokeSegKey(entry.id));
        visit(entry.body);
      }
    }
  };
  visit(body);
}

/**
 * Abandons the open wide-body owner a deflection crosses: when `crossedId` — a
 * deflected enter or the recorded blocked owner — lies inside (or is) an invoke
 * or a `$map`, the outermost enclosing owner's slot and subtree clear, so the
 * catch rewalk re-reaches a fresh invocation or a virgin map. A statement
 * outside any wide-body owner clears nothing.
 */
export function clearInvokeStateCrossedByDeflection(
  traversal: Traversal,
  node: Node,
  crossedId: ElementId,
): void {
  const outermost = wideBodyChainTo(node.statements, crossedId)?.[0];
  if (!outermost) return;
  if (outermost.kind === "map") {
    clearMapSubtreeState(traversal, outermost);
    return;
  }
  clearInvokeSubtreeState(traversal, outermost);
}

/**
 * Steps a first-class `invoke(...)`: runs its attached body SEG inline in the
 * enclosing node.
 *
 * The completion is a sigil-less pin on the enclosing SEG's tape: a resume
 * replays it and skips the statement whole, while a dial-back of the enclosing
 * SEG drops it and the next reach runs a fresh invocation — whose `$` slots,
 * hook scopes, and body pins all start clear. A blocked invocation stays
 * pending in the frame and resumes itself: the body seeks from its top against
 * the invocation's own tape.
 */
function stepInvoke(
  traversal: Traversal,
  node: Node,
  statement: InvokeAction,
  accum: Accumulator,
): LeafStep<void> {
  // A pinned completion: the invocation already ran this walk (or the walk
  // being seeked), and the enclosing SEG has not dialed back since.
  if (readValuePin(accum)) return { status: "advance" };

  const existing = getActionState(traversal, statement);
  const continuing = existing?.status === "pending";
  if (!continuing) {
    clearInvokeSubtreeState(traversal, statement);
  }
  // Bracket the invoke boundary with the containing SEG's plan — the node's
  // set (or the outer invoke's, when nested), which includes this body's
  // reads — captured before the invocation first runs and persisted across
  // blocked execution.
  const preSnapshot = continuing
    ? existing.preSnapshot
    : captureReadSet(traversal, node, accum);
  if (!continuing) {
    markPendingActionState(traversal, statement.id, "invoke", { preSnapshot });
  }

  const tape = pinTapeFor(traversal, invokeSegKey(statement.id));
  accum.invokeContext ??= [];
  accum.invokeContext.push({ node, id: statement.id });
  accum.activeSeg = { kind: "invoke", owner: statement.id };
  let outcome: SegOutcome<void>;
  try {
    outcome = runBodySeg(traversal, node, accum, statement.body, tape);
  } finally {
    accum.invokeContext.pop();
  }

  if (outcome.status === "blocked") return { status: "blocked" };
  if (outcome.status === "deflected") {
    // The deflection abandons the invocation on its way out; the containing
    // node's catch rewalk re-reaches a fresh one.
    clearInvokeSubtreeState(traversal, statement);
    return outcome;
  }
  if (isInstructionBatchActive(accum, traversal)) {
    // In-body pending instructions hold the invocation open at its end; the
    // next report seeks the body and settles them.
    accum.activeSeg = { kind: "invoke", owner: statement.id };
    return blockSeg(accum, traversal);
  }

  // Completed: the invocation is over. Its slot and tape clear (a fresh walk
  // re-runs it from nothing), the completion pins on the enclosing SEG's tape,
  // and a net-changed bracketed set follows the node's write-diff behavior.
  clearActionState(traversal, statement.id);
  dropPinTape(traversal, invokeSegKey(statement.id));
  recordValuePin(accum, true);
  return readSetRewalkStep(preSnapshot, traversal, node, accum);
}

/**
 * Steps a `$map(...)`: drives sequential member execution over the pinned input
 * array, then commits the constructed output array to `results` in one write.
 *
 * The completion is a sigil-less pin on the enclosing SEG's tape, exactly as an
 * invoke's is: a resume replays it and skips the action whole; a dial-back of
 * the enclosing SEG drops it and the next reach re-reads the receiver and
 * evaluates afresh. A blocked member holds the action pending in the arena and
 * resumes into that member.
 */
function stepMap(
  traversal: Traversal,
  node: Node,
  statement: MapAction,
  accum: Accumulator,
): LeafStep<void> {
  if (readValuePin(accum)) return { status: "advance" };

  const existing = getActionState(traversal, statement);
  const continuing =
    existing?.status === "pending" && existing.map !== undefined;
  let arena: MapActionState;
  let preSnapshot: StateSnapshot | undefined;
  if (continuing) {
    arena = existing.map!;
    preSnapshot = existing.preSnapshot;
  } else {
    clearMapSubtreeState(traversal, statement);
    // Bracket the map boundary with the enclosing SEG's read-set, captured
    // before the first member runs and persisted across blocked members, so
    // the members' cell writes and the single `results` commit make one
    // rewalk-vs-advance decision when the action resolves.
    preSnapshot = captureReadSet(traversal, node, accum);
    arena = {
      pinnedInput: cloneCellValue(
        requireArrayValue(
          statement.receiver,
          traversal,
          accum,
          "$map receiver",
        ),
      ) as ArrayValue,
      results: statement.results,
      nextIndex: 0,
      terminals: [],
      staged: undefined,
    };
    markPendingActionState(traversal, statement.id, "map", {
      preSnapshot,
      map: arena,
    });
  }

  while (arena.nextIndex < arena.pinnedInput.length) {
    const outcome = runMapMember(traversal, node, statement, accum, arena);
    if (outcome.status === "blocked") return { status: "blocked" };
    if (outcome.status === "deflected") {
      // The deflection abandons the member on its way out; as it crosses the
      // `$map` the whole arena clears, and the node's catch rewalk re-reaches a
      // virgin map.
      clearMapSubtreeState(traversal, statement);
      return outcome;
    }
  }

  // Every member is terminal: construct the output in index order and commit it
  // to `results` in one write (absent for the forEach shape).
  if (statement.results !== undefined) {
    const output: ArrayValue = arena.terminals.map((value) => {
      if (value === undefined) {
        throw runtimeError(
          "map-missing-result",
          "$map produced a member with no span.result",
        );
      }
      return value;
    });
    const owner = findCellOwner(statement.results, traversal, accum);
    if (!owner) {
      throw runtimeError(
        "unknown-cell",
        `Unknown $map results cell: ${statement.results}`,
      );
    }
    // Validate the whole constructed list against the output cell's element
    // shape before it lands, exactly as an array `$set` does.
    assertAssignableValue(statement.results, owner.cell, output);
    writeOwnedCell(owner.traversal, statement.results, output);
  }
  clearMapSubtreeState(traversal, statement);
  recordValuePin(accum, true);
  return readSetRewalkStep(preSnapshot, traversal, node, accum);
}

/**
 * Runs the callback instance for the arena's next member to a terminal step.
 * On completion it validates and terminalizes `span.result`, advances the
 * cursor, and clears the member's per-instance state so the next member reuses
 * the callback's `$` slots and tape fresh. A blocked or deflected member
 * returns that outcome for the driver to handle.
 */
function runMapMember(
  traversal: Traversal,
  node: Node,
  statement: MapAction,
  accum: Accumulator,
  arena: MapActionState,
): SegOutcome<void> {
  const index = arena.nextIndex;
  // Guarded by the driver's `nextIndex < pinnedInput.length` loop condition.
  const item = arena.pinnedInput[index]!;
  arena.staged ??= { set: false };
  const previousMember = accum.mapMember;
  accum.mapMember = {
    mapId: statement.id,
    index,
    item,
    receiverSpec: runtimeArrayElementSpec(
      statement.receiver,
      traversal,
      node,
      accum,
    ),
    resultSpec:
      statement.results === undefined
        ? undefined
        : runtimeArrayCellElementSpec(statement.results, traversal, accum),
  };
  accum.activeSeg = { kind: "mapMember", owner: statement.id, index };
  const tape = pinTapeFor(traversal, mapMemberSegKey(statement.id, index));
  let outcome: SegOutcome<void>;
  try {
    outcome = runBodySeg(traversal, node, accum, statement.body, tape);
  } finally {
    accum.mapMember = previousMember;
  }
  if (outcome.status !== "done") return outcome;
  if (isInstructionBatchActive(accum, traversal)) {
    // A callback walk may reach its end after emitting a compatible instruction
    // batch, but emission does not resolve those actions. Keep this member's
    // arena row, action state, and tape live until the batch is acknowledged;
    // only then may the driver terminalize it and advance to the next member.
    accum.activeSeg = { kind: "mapMember", owner: statement.id, index };
    return blockSeg(accum, traversal);
  }

  const staged = arena.staged;
  if (statement.results !== undefined) {
    if (!staged?.set) {
      throw runtimeError(
        "map-missing-result",
        "$map member completed without setting span.result",
      );
    }
    arena.terminals[index] = staged.value;
  } else {
    arena.terminals[index] = undefined;
  }
  arena.staged = undefined;
  arena.nextIndex = index + 1;
  clearMapMemberState(traversal, statement, index);
  return outcome;
}

function runtimeArrayElementSpec(
  reference: MapAction["receiver"],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ArrayElementSpec | undefined {
  if (reference.kind === "channel") {
    const spec = node.signature?.[reference.namespace][reference.key];
    return spec?.type === "array" ? spec.element : undefined;
  }
  return runtimeArrayCellElementSpec(reference.name, traversal, accum);
}

function runtimeArrayCellElementSpec(
  name: string,
  traversal: Traversal,
  accum: Accumulator,
): ArrayElementSpec | undefined {
  const cell = findCellOwner(name, traversal, accum)?.cell;
  return cell?.type === "array" ? cell.element : undefined;
}

/**
 * Applies `span.result.$set(...)` inside a `$map` callback: evaluates the value
 * and stages it as the current member's `span.result`. Multiple writes stage in
 * action order, so the last reachable write is the one that terminalizes.
 */
function stepSetSpan(
  traversal: Traversal,
  node: Node,
  statement: SetSpanAction,
  accum: Accumulator,
): LeafStep<void> {
  const member = accum.mapMember;
  if (!member) {
    throw runtimeError(
      "span-outside-map",
      "span.result is only available inside a $map callback",
    );
  }
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
  );
  if (value.status === "blocked") return blockSeg(accum, traversal);
  if (!member.resultSpec) {
    throw runtimeError(
      "invalid-span-result",
      "span.result is unavailable because this $map has no results cell",
    );
  }
  if (firstNonFiniteNumberPath(value.value) !== undefined) {
    throw runtimeError(
      "non-finite-number",
      "Numeric value must be finite before span result write",
    );
  }
  assertAssignableValue("span.result", member.resultSpec, value.value);
  const staged = cloneCellValue(value.value);
  if (staged === undefined || Array.isArray(staged)) {
    throw new Error(
      "Internal invariant: admitted span result is not an element",
    );
  }
  const arena = getMapArena(traversal, member.mapId);
  arena.staged = {
    set: true,
    value: staged as ArrayElementValue,
  };
  markActionResolved(traversal, statement);
  return { status: "advance" };
}

/**
 * Clears one terminalized member's per-instance state: its callback `$` slots,
 * hook scopes, nested invoke tapes, and its own member tape. The next member
 * reuses the callback graph's node-frame slots fresh.
 */
function clearMapMemberState(
  traversal: Traversal,
  statement: MapAction,
  index: number,
): void {
  dropPinTape(traversal, mapMemberSegKey(statement.id, index));
  clearBodySubtreeState(traversal, statement.body);
}

/**
 * Clears the whole `$map` arena: its action slot, the current member's callback
 * state, and that member's tape. Called on a fresh reach — a new map evaluation
 * starts with nothing pinned — and when a deflection abandons the action.
 */
function clearMapSubtreeState(
  traversal: Traversal,
  statement: MapAction,
): void {
  const existing = getActionState(traversal, statement);
  if (existing?.map) {
    dropPinTape(
      traversal,
      mapMemberSegKey(statement.id, existing.map.nextIndex),
    );
  }
  clearActionState(traversal, statement.id);
  clearBodySubtreeState(traversal, statement.body);
}

function runInstructionAction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
): LeafStep<void> {
  if (
    isInstructionBatchActive(accum, traversal) &&
    !canBatchInstruction(accum, node, statement)
  ) {
    return blockSeg(accum, traversal);
  }

  const actionState = getActionState(traversal, statement);
  const instructionId = makeInstructionId(
    accum.entry.arc,
    traversal,
    qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
  );

  if (actionState?.status !== "pending") {
    return emitPendingInstruction(traversal, node, statement, accum);
  }

  if (!actionState.instructionPhase) {
    throw new Error(
      `Pending instruction ${instructionId} is missing its persisted phase`,
    );
  }

  const newlyApplied = consumeInstructionApplication(accum, instructionId);
  if (newlyApplied || accum.phase === "apply") {
    return stepReportedInstruction(
      traversal,
      node,
      statement,
      accum,
      actionState.preSnapshot,
      actionState.instructionPhase,
      newlyApplied || actionState.instructionPhase === "postcheck",
      actionState.deflectWhenOutcome,
      actionState.resolveWhenOutcome,
    );
  }

  return surfacePendingInstruction(
    traversal,
    node,
    statement,
    accum,
    actionState.preSnapshot,
    actionState.instructionPhase,
    actionState.deflectWhenOutcome,
    actionState.resolveWhenOutcome,
  );
}

/** Consumes one durable application report for this exact instruction owner. */
function consumeInstructionApplication(
  accum: Accumulator,
  instructionId: BriefId,
): boolean {
  if (!accum.instructionApplications.has(instructionId)) return false;
  accum.instructionApplications.delete(instructionId);
  return true;
}

/**
 * Emits an instruction on first encounter and records it pending; it resolves on
 * a later report.
 */
function emitPendingInstruction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
): LeafStep<void> {
  // Bracket the whole pending lifetime: capture the enclosing read-set before
  // the postcheck collection runs `resolveWhen` / `deflectWhen` (which may
  // apply `set` side-effects), and persist it so a hook mutation that lands
  // across briefs is still caught when the instruction finally resolves.
  const preSnapshot = captureReadSet(traversal, node, accum);
  let postcheck: InstructionPostcheck | undefined;
  if (accum.phase === "plan") {
    // Collect the postcheck under the hook SEG so a hook block records the hook
    // (the deepest blocked SEG), then return to the body unless the hook left
    // pending work — i.e. it blocked and owns the recorded frontier.
    accum.activeSeg = instructionHookSeg(statement);
    postcheck = collectInstructionPostcheck(statement, traversal, node, accum);
    if (!postcheck) accum.activeSeg = { kind: "body" };
  }
  emitInstruction(statement, traversal, node, accum, "apply", postcheck);
  markPendingActionState(traversal, statement.id, statement.kind, {
    preSnapshot,
    instructionPhase: "apply",
  });
  return { status: "advance" };
}

/**
 * Re-surfaces an instruction with no newly consumable application report.
 * Planning may reconstruct its reachable postcheck, but never advances its
 * outcome. The lap's banked hook evidence carries through unchanged, and its
 * banked hooks pose no checks.
 */
function surfacePendingInstruction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
  preSnapshot: StateSnapshot | undefined,
  phase: InstructionBrief["phase"],
  bankedDeflect: boolean | undefined,
  bankedResolve: boolean | undefined,
): LeafStep<void> {
  let postcheck: InstructionPostcheck | undefined;
  if (accum.phase === "plan") {
    accum.activeSeg = instructionHookSeg(statement);
    postcheck = collectInstructionPostcheck(
      statement,
      traversal,
      node,
      accum,
      bankedDeflect,
      bankedResolve,
    );
    if (!postcheck) accum.activeSeg = { kind: "body" };
  }
  markPendingActionState(traversal, statement.id, statement.kind, {
    preSnapshot,
    instructionPhase: phase,
    deflectWhenOutcome: bankedDeflect,
    resolveWhenOutcome: bankedResolve,
  });
  emitInstruction(statement, traversal, node, accum, phase, postcheck);
  return { status: "advance" };
}

/**
 * Applies one accepted report to a pending instruction, driving its current
 * lap. A lap collects two evidences, each banked once settled: the deflect
 * evidence (`deflectWhen`) and the finished evidence (application for a
 * one-shot, `resolveWhen` for a loop). A true deflect evidence short-circuits
 * the lap immediately, honoring the finished evidence collected so far; with
 * both evidences in and no deflection, a finished-true lap resolves the action
 * and a finished-false loop lap starts a fresh lap with no banked evidence.
 */
function stepReportedInstruction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
  preSnapshot: StateSnapshot | undefined,
  instructionPhase: InstructionBrief["phase"],
  applicationConfirmed: boolean,
  bankedDeflect: boolean | undefined,
  bankedResolve: boolean | undefined,
): LeafStep<void> {
  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;
  // Evaluate the open hooks under the hook SEG so a block records the hook
  // and the next report resumes it owner-first, before the enclosing body.
  // Banked evidence substitutes for its hook without re-evaluating it.
  accum.activeSeg = instructionHookSeg(statement);
  const { deflectResult, resolveResult } = withInstructionHostParams(
    statement,
    node,
    accum,
    () => ({
      deflectResult:
        bankedDeflect !== undefined
          ? ({
              status: "resolved",
              value: bankedDeflect,
            } satisfies ActionOutcome<boolean>)
          : statement.deflectWhen
            ? evaluateDeflectWhenHook(statement, traversal, node, accum)
            : ({
                status: "resolved",
                value: false,
              } satisfies ActionOutcome<boolean>),
      resolveResult:
        bankedResolve !== undefined
          ? ({
              status: "resolved",
              value: bankedResolve,
            } satisfies ActionOutcome<boolean>)
          : evaluateInstructionResolution(
              statement,
              traversal,
              node,
              accum,
              applicationConfirmed,
            ),
    }),
  );
  if (deflectResult.status !== "blocked" && truthy(deflectResult.value)) {
    accum.activeSeg = { kind: "body" };
    // The lap short-circuits on deflection, honoring the finished evidence
    // collected up to this handback: a finished lap stays resolved through the
    // deflection, an unfinished one re-presents fresh after a catch or
    // re-entry.
    if (resolveResult.status !== "blocked" && truthy(resolveResult.value)) {
      markActionResolved(traversal, statement);
    } else {
      clearActionState(traversal, statement.id);
    }
    return deflectSeg(traversal);
  }
  if (
    deflectResult.status === "blocked" ||
    resolveResult.status === "blocked"
  ) {
    const nextPhase: InstructionBrief["phase"] = applicationConfirmed
      ? "postcheck"
      : instructionPhase;
    const postcheck =
      accum.phase === "plan"
        ? instructionPostcheckFromAccum(
            accum,
            judgmentStart,
            observationStart,
            hostCallStart,
          )
        : undefined;
    emitInstruction(statement, traversal, node, accum, nextPhase, postcheck);
    markPendingActionState(traversal, statement.id, statement.kind, {
      preSnapshot,
      instructionPhase: nextPhase,
      deflectWhenOutcome:
        bankedDeflect ??
        (deflectResult.status !== "blocked" && statement.deflectWhen
          ? truthy(deflectResult.value)
          : undefined),
      resolveWhenOutcome:
        bankedResolve ??
        (resolveResult.status !== "blocked" && statement.resolveWhen
          ? truthy(resolveResult.value)
          : undefined),
    });
    // Hook still blocked: leave the hook SEG active so the enclosing block
    // records it as the frontier.
    return { status: "advance" };
  }
  accum.activeSeg = { kind: "body" };
  if (truthy(resolveResult.value)) {
    // Resolve before applying the enclosing body's write-diff behavior, so a
    // rewalk skips the now-resolved instruction and advance continues after it.
    // The attached `resolveWhen` hook owned its own continuation while pending;
    // control crosses back into this body SEG only here, at resolution.
    // Diff the persisted pre-snapshot against now; an unchanged read-set
    // advances, while a changed one follows the node's write-diff behavior.
    markActionResolved(traversal, statement);
    return readSetRewalkStep(preSnapshot, traversal, node, accum);
  }

  // Finished-false loop lap: start a fresh lap with no banked evidence.
  markPendingActionState(traversal, statement.id, statement.kind, {
    preSnapshot,
    instructionPhase: "apply",
  });
  emitInstruction(statement, traversal, node, accum, "apply");
  return { status: "advance" };
}

function evaluateInstructionResolution(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  applicationConfirmed: boolean,
): ActionOutcome<boolean> {
  if (!statement.resolveWhen) {
    // A one-shot's finished evidence is its application: open until the host
    // reports it applied, never settled false — an unapplied one-shot waits
    // rather than deciding a lap.
    return applicationConfirmed
      ? { status: "resolved", value: statement.mode === "once" }
      : { status: "blocked" };
  }
  return evaluateBooleanHook(
    statement.resolveWhen,
    traversal,
    node,
    accum,
    hookSegKey(statement.id, "resolveWhen"),
  );
}

function evaluateCatchDeflection(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  deflection: DeflectionContext,
): ActionOutcome<boolean> {
  if (!node.catchDeflection) {
    return { status: "resolved", value: false };
  }

  return evaluateBooleanHook(
    node.catchDeflection,
    traversal,
    node,
    accum,
    catchSegKey(deflection),
  );
}

/**
 * The canonical `$enter`/`$enterLoop` target a deflected child was entered as —
 * the value `escaped(Target)` matches against as the deflection crosses
 * this parent boundary. A canonical or forgetful entry's traversal ref already
 * is the target; a `newcopy` entry's ref is an anonymous copy, so resolve it
 * back through the owner's copy alias to the canonical node/arc the author
 * named.
 */
function entryTargetRefOf(
  childRef: NodeRef,
  accum: Accumulator,
): NodeRef | undefined {
  const parts = toNodeRefParts(childRef);
  const last = parts.path[parts.path.length - 1];
  if (last === undefined || !last.includes("#")) return childRef;
  const ownerRef = toNodeRef(parts.source, parts.path.slice(0, -1));
  const ownerEntry = getEntryForRef(accum.entries, ownerRef);
  if (!ownerEntry) return undefined;
  const ownerNode = getNodeForRef(accum.entries, ownerEntry, ownerRef);
  if (!ownerNode) return undefined;
  const alias = ownerNode.newcopyAliases.find(
    (entry) => entry.identifier === last,
  );
  if (!alias) return undefined;
  const resolved = resolveLexicalRef(
    accum.entries,
    ownerEntry,
    ownerRef,
    ownerNode,
    alias.target,
    alias.imported,
  );
  if (!resolved) return undefined;
  return isArcRef(resolved) ? arcToNodeRef(resolved) : resolved;
}

function collectInstructionPostcheck(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  bankedDeflect?: boolean,
  bankedResolve?: boolean,
): InstructionPostcheck | undefined {
  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;

  // A hook whose lap evidence is already banked poses no checks.
  withInstructionHostParams(statement, node, accum, () => {
    if (statement.deflectWhen && bankedDeflect === undefined) {
      evaluateDeflectWhenHook(statement, traversal, node, accum);
    }
    if (statement.resolveWhen && bankedResolve === undefined) {
      evaluateBooleanHook(
        statement.resolveWhen,
        traversal,
        node,
        accum,
        hookSegKey(statement.id, "resolveWhen"),
      );
    }
  });

  return instructionPostcheckFromAccum(
    accum,
    judgmentStart,
    observationStart,
    hostCallStart,
  );
}

/** Evaluates an instruction's `deflectWhen` under its hook SEG key. */
function evaluateDeflectWhenHook(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<boolean> {
  return withInheritedHookOwner(accum, statement, () =>
    evaluateBooleanHook(
      statement.deflectWhen!,
      traversal,
      node,
      accum,
      hookSegKey(statement.id, "deflectWhen"),
    ),
  );
}

/**
 * Evaluates an instruction's inherited `deflectWhen` with the owning
 * instruction as the brief-id qualifier. Inherited hook IR is shared across
 * every inheriting instruction with the same expression ids, so without the
 * owner in the id, one owner's reported answer would settle every owner's
 * question. An instruction-authored `deflectWhen` needs no qualifier — its
 * expression ids are already unique to the owner.
 */
function withInheritedHookOwner<T>(
  accum: Accumulator,
  statement: InstructionAction,
  callback: () => T,
): T {
  if (!statement.inheritedDeflectWhen) return callback();
  const previous = accum.hookInstance;
  accum.hookInstance = hookSegKey(statement.id, "deflectWhen");
  try {
    return callback();
  } finally {
    accum.hookInstance = previous;
  }
}

function withInstructionHostParams<T>(
  statement: InstructionAction,
  node: Node,
  accum: Accumulator,
  callback: () => T,
): T {
  const previous = accum.hostParams;
  const previousActive = accum.hostParamsActive;
  accum.hostParams = mergeAndClonePayload(
    node.hostParams,
    statement.hostParams,
  );
  accum.hostParamsActive = true;
  try {
    return callback();
  } finally {
    accum.hostParams = previous;
    accum.hostParamsActive = previousActive;
  }
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

export function evaluateBooleanHook(
  statements: readonly (ResolutionStatement | CatchDeflectionStatement)[],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  segKey: SegKey,
): ActionOutcome<boolean> {
  const scope = evaluatorNarrowScope(traversal, segKey);
  // One consultation is one walk: the hook's tape persists across blocked
  // round-trips (a report that resolves a later leaf replays earlier judge
  // pins) and is released with the evaluator scope when the hook completes
  // (`clearEvaluatorActionStates` pairs the two).
  const tape = pinTapeFor(traversal, segKey);
  const outcome = runPinnedSeg(accum, tape, statements, {
    doneValue: false,
    evaluateIf: (statement) =>
      evaluateIfBranch(statement, traversal, node, accum),
    evaluateReturn: (statement) =>
      evaluateBooleanReturn(statement, traversal, node, accum),
    isResolvedLeaf: (statement) => isResolvedNarrowLeaf(statement, scope),
    stepLeaf: (statement) => {
      const step = stepNarrowLeaf<boolean>(
        statement,
        traversal,
        node,
        accum,
        scope,
      );
      if (step) return step;
      throw new Error(
        `Unsupported boolean-hook leaf statement: ${statement.kind}`,
      );
    },
  });
  if (outcome.status === "blocked") {
    return { status: "blocked" };
  }
  if (outcome.status === "deflected") {
    throw new Error("Hooks cannot deflect");
  }
  clearEvaluatorActionStates(traversal, segKey);
  return { status: "resolved", value: outcome.value };
}

function prepareTraversalForEntry(
  traversal: Traversal,
  node: Node,
  target: { mode: "canonical" | "forgetful" | "newcopy" },
): boolean {
  if (traversal.finalizing) {
    return false;
  }

  if (target.mode === "forgetful") {
    return prepareForgetfulTraversalEntry(traversal, node);
  }

  if (traversal.enterCount === 0) {
    resetTraversalForEntry(traversal, node, 1);
    return true;
  }

  if (traversal.state === "deflected" || isSuspendedArcTraversal(traversal)) {
    resetTraversalForEntry(traversal, node, traversal.enterCount + 1);
  }
  return false;
}

function restartTraversalForEntry(
  traversal: Traversal,
  node: Node,
  forceForgetfulEntry = false,
): void {
  resetTraversalForEntry(
    traversal,
    node,
    traversal.enterCount + 1,
    forceForgetfulEntry,
  );
}

function prepareForgetfulTraversalEntry(
  traversal: Traversal,
  node: Node,
): boolean {
  if (traversal.enterCount > 0 && isEnteredTraversal(traversal)) {
    return false;
  }

  const nextEnterCount =
    traversal.enterCount === 0 ? 1 : traversal.enterCount + 1;
  resetTraversalForEntry(traversal, node, nextEnterCount, true);
  return nextEnterCount === 1;
}

function resolveEnterTarget(
  accum: Accumulator,
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
): EnterTarget | undefined {
  const ownerEntry =
    getEntryForRef(accum.entries, traversal.ref) ?? accum.entry;

  if (statement.target.mode === "newcopy") {
    const ref = toAnonymousCopyRef(
      traversal,
      statement.target.identifier,
      statement.id,
    );
    const copyNode = getNodeForRef(accum.entries, ownerEntry, ref);
    if (!copyNode) return undefined;
    return { kind: "anonymous-copy", ref, node: copyNode };
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
  mapping: EnterChannelBindings,
  callerTraversal: Traversal,
  callerNode: Node,
  accum: Accumulator,
  label: "args" | "returns",
): Record<string, EnterChannelLink> {
  const resolved: Record<string, EnterChannelLink> = {};
  for (const [key, source] of Object.entries(mapping)) {
    if (source.kind === "cell") {
      const owner = findCellOwner(source.cell, callerTraversal, accum);
      if (!owner) {
        throw new Error(
          `Unknown ${label} cell mapping "${source.cell}" in ${callerNode.identifier}`,
        );
      }
      resolved[key] = {
        kind: "callerCell",
        ownerRef: traversalToNodeRef(owner.traversal),
        cell: source.cell,
      };
      continue;
    }
    if (source.kind === "argsProjection") {
      // Forwards the caller's own typed args channel: resolve it through the
      // caller's link. A caller channel that is itself declared-unbound has no
      // link and passes unset through — the child channel stays absent.
      const callerLink = callerTraversal.enterChannels.args[source.key];
      if (callerLink) {
        resolved[key] = cloneEnterChannelLink(callerLink);
      }
      continue;
    }
    // A `$map` callback's enter binds `span.*`. The member context supplies the
    // values: `item` / `index` are captured by value at bind time; `result` is
    // the write sink into the member's arena, committed when the child covers.
    const member = accum.mapMember;
    if (!member) {
      throw new Error(
        `span.${source.key} binding on ${label}.${key} outside a $map member`,
      );
    }
    if (source.key === "item") {
      resolved[key] = { kind: "value", value: member.item };
    } else if (source.key === "index") {
      resolved[key] = { kind: "value", value: member.index };
    } else {
      resolved[key] = {
        kind: "spanResult",
        ownerRef: traversalToNodeRef(callerTraversal),
        mapId: member.mapId,
      };
    }
  }
  return resolved;
}

function sameEnterChannelLinks(
  left: Record<string, EnterChannelLink>,
  right: Record<string, EnterChannelLink>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const l = left[key];
    const r = right[key];
    if (!l || !r || l.kind !== r.kind) return false;
    if (l.kind === "callerCell" && r.kind === "callerCell") {
      if (l.ownerRef !== r.ownerRef || l.cell !== r.cell) return false;
    } else if (l.kind === "value" && r.kind === "value") {
      if (!cellValuesEqual(l.value, r.value)) return false;
    } else if (l.kind === "spanResult" && r.kind === "spanResult") {
      if (l.ownerRef !== r.ownerRef || l.mapId !== r.mapId) return false;
    }
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
    const link = channelState.returns[key];
    // A declared-unbound return has no caller sink: its staged value is
    // discarded at resolution rather than committed anywhere.
    if (!link) continue;
    if (link.kind === "spanResult") {
      // The return sink is a `$map` member's `span.result`: stage it into the
      // owning arena for the current member to terminalize.
      commitSpanResult(link, value, accum);
      continue;
    }
    const { callerCellRef, callerTraversal } = resolveReturnChannelBinding(
      traversal,
      accum,
      key,
      "commit",
    );
    // Route through the single write path so the enter's wide snapshot reads a
    // consistently-cloned before/after across the return commit.
    const owner = findCellOwner(callerCellRef.cell, callerTraversal, accum);
    if (!owner) {
      throw runtimeError(
        "invalid-channel-binding",
        `Return sink cell not found: ${callerCellRef.cell}`,
      );
    }
    writeOwnedCellValue(owner.traversal, callerCellRef.cell, owner.cell, value);
  }
  channelState.stagedReturns = {};
}

/** Stages a covered child's return into the owning `$map` member's arena. */
function commitSpanResult(
  link: Extract<EnterChannelLink, { kind: "spanResult" }>,
  value: CellValue,
  accum: Accumulator,
): void {
  const owner = findTraversalInSet(accum.traversals, link.ownerRef);
  if (!owner) {
    throw runtimeError(
      "invalid-channel-binding",
      `span.result sink owner traversal not found: ${formatRef(link.ownerRef)}`,
    );
  }
  const node = nodeForTraversal(accum, owner);
  const map = findMapAction(node.statements, link.mapId);
  if (!map || map.results === undefined) {
    throw runtimeError(
      "invalid-span-result",
      `span.result sink map not found: ${link.mapId}`,
    );
  }
  const resultSpec = runtimeArrayCellElementSpec(map.results, owner, accum);
  if (!resultSpec) {
    throw runtimeError(
      "invalid-span-result",
      `span.result sink ${map.results} has no array element spec`,
    );
  }
  assertAssignableValue("span.result", resultSpec, value);
  const staged = cloneCellValue(value);
  if (staged === undefined || Array.isArray(staged)) {
    throw new Error(
      "Internal invariant: admitted child return is not an element",
    );
  }
  getMapArena(owner, link.mapId).staged = {
    set: true,
    value: staged as ArrayElementValue,
  };
}

function findMapAction(
  statements: readonly Statement[],
  id: ElementId,
): MapAction | undefined {
  for (const statement of statements) {
    if (statement.kind === "map" && statement.id === id) return statement;
    if (statement.kind === "if") {
      const found =
        findMapAction(statement.consequent, id) ??
        findMapAction(statement.alternate ?? [], id);
      if (found) return found;
      continue;
    }
    if (
      statement.kind === "label" ||
      statement.kind === "invoke" ||
      statement.kind === "map"
    ) {
      const found = findMapAction(statement.body, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Persists a blocked enter's continuation: its phase and staged-return
 * transaction. Always marks the action pending — including a `target`-phase
 * block with no staged returns — so resume continues the existing target rather
 * than re-entering it (which would re-create a `forgetful`/`newcopy` target).
 */
function persistPendingEnterState(
  traversal: Traversal,
  statement: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
  phase: "target" | "resolveWhen",
  stagedReturns: Record<string, CellValue>,
  preSnapshot: StateSnapshot | undefined,
): void {
  markPendingActionState(traversal, statement.id, statement.kind, {
    enterPhase: phase,
    stagedReturns,
    preSnapshot,
  });
}

function prepareNextEnterLoopIteration(
  traversal: Traversal,
  target: EnterTarget,
  accum: Accumulator,
  forgetful: boolean,
): void {
  if (target.kind === "anonymous-copy") {
    replaceEphemeralTraversal(
      traversal,
      target.ref,
      createEmptyNodeTraversal(target.ref, target.node),
    );
    return;
  }

  // A forgetful iteration clears the node frame per forgetful-target semantics;
  // a bare canonical target follows the node's forgetfulEntry policy.
  if (target.kind === "referenced") {
    const nextTraversal = ensureReferencedTraversal(
      accum,
      target.ref,
      target.entry.root,
    );
    restartTraversalForEntry(nextTraversal, target.entry.root, forgetful);
    return;
  }

  const nextTraversal = ensureOwnedTraversal(accum, target.ref, target.node);
  restartTraversalForEntry(nextTraversal, target.node, forgetful);
}

function ensureReferencedTraversal(
  accum: Accumulator,
  ref: ArcRef,
  root: Node,
): ArcTraversal {
  let traversal = accum.traversals.find((item) => item.ref === ref);
  if (!traversal) {
    traversal = createEmptyArcTraversal(ref, root);
    accum.traversals.push(traversal);
  }
  return traversal;
}

function runEffects(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): HookOutcome<void> {
  if (!node.effects) return { status: "done", value: undefined };

  const scope = nodeNarrowScope(traversal);
  const tape = pinTapeFor(traversal, nodeSegKey("effects"));
  // Effect statements briefed on this walk, so a set-driven re-walk re-steps
  // them without re-briefing them a second time.
  const briefedEffects = new Set<ElementId>();
  let unreported = false;
  const outcome = runPinnedSeg<EffectStatement, void>(
    accum,
    tape,
    node.effects,
    {
      doneValue: undefined,
      evaluateIf: (statement) =>
        evaluateIfBranch(statement, traversal, node, accum),
      isResolvedLeaf: (statement) =>
        statement.kind !== "if" &&
        statement.kind !== "label" &&
        statement.kind !== "break" &&
        isResolvedActionState(getActionState(traversal, statement)),
      stepLeaf: (statement) => {
        const step = stepNarrowLeaf<void>(
          statement,
          traversal,
          node,
          accum,
          scope,
        );
        if (step) return step;

        if (statement.kind !== "host-call") {
          throw new Error("Unsupported effects leaf statement");
        }

        const actionState = getActionState(traversal, statement);
        if (actionState?.status === "pending") {
          const effect = renderHostEffect(statement, traversal, node, accum);
          if (accum.hostEffectResults.has(effect.id)) {
            markActionResolved(traversal, statement);
            return { status: "advance" };
          }
          // Still unreported: re-surface it and keep walking — it gates this
          // SEG's completion below, not the statements after it.
          if (accum.phase === "plan" && !briefedEffects.has(statement.id)) {
            briefedEffects.add(statement.id);
            accum.hostEffects.push(effect);
            noteBriefYield(accum, traversal);
          }
          unreported = true;
          return { status: "advance" };
        }

        const effect = renderHostEffect(statement, traversal, node, accum);
        const key = hostEffectDedupKey(statement.id, effect);
        if (!traversal.appliedHostCallKeys.includes(key)) {
          // A host effect is a host commitment: emit it once, then keep it on
          // every brief until the host reports it back.
          traversal.appliedHostCallKeys.push(key);
          accum.hostEffects.push(effect);
          briefedEffects.add(statement.id);
          markPendingActionState(traversal, statement.id, statement.kind);
          noteBriefYield(accum, traversal);
          unreported = true;
          return { status: "advance" };
        }
        markActionResolved(traversal, statement);
        return { status: "advance" };
      },
    },
  );
  if (outcome.status === "done" && unreported) {
    // Unreported effects hold the SEG at its frontier; the report that carries
    // their feedback resumes here and resolves them.
    return blockSeg(accum, traversal);
  }
  if (outcome.status === "done") dropPinTape(traversal, nodeSegKey("effects"));
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
  accum.instructionBatchSignature ??= instructionBatchSignature(
    node,
    statement,
  );
  accum.instructionBatchResumeSeg ??= instructionHookSeg(statement);
  accum.instructions.push({
    id: makeInstructionId(
      accum.entry.arc,
      traversal,
      qualifiedBriefSite(briefSiteQualifiers(accum), statement.id),
    ),
    sourceRef: traversalToNodeRef(traversal),
    mode: statement.mode,
    phase,
    text: renderSemanticText(statement.template, traversal, node, accum),
    hostParams: admitBriefPayload(
      mergeAndClonePayload(node.hostParams, statement.hostParams),
    ),
    postcheck: cloneInstructionPostcheck(postcheck),
  });
}

function admitBriefPayload(value: PayloadValue): PayloadValue {
  const path = firstNonFiniteNumberPath(value);
  if (path !== undefined) {
    throw runtimeError(
      "non-finite-number",
      `Numeric value must be finite before brief/effect emission${path === "$" ? "" : ` at ${path}`}`,
    );
  }
  return cloneWithCanonicalNumbers(value);
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
    return {
      status: "deflected",
      traversal,
      deflection: outcome.deflection,
    };
  }
  throw new Error(`Unexpected enter iteration outcome: ${outcome}`);
}

function resetTraversalForEntry(
  traversal: Traversal,
  node: Node,
  nextEnterCount: number,
  forceForgetfulEntry = false,
): void {
  traversal.enterCount = nextEnterCount;
  traversal.state = undefined;
  traversal.finalizing = undefined;
  traversal.enterChannels = createEmptyEnterChannelState();
  if (isArcTraversal(traversal)) {
    traversal.phase = "entered";
  }
  // Re-entry starts fresh walks: every sigil-less pin releases while resolved
  // `$` slots stay (unless the entry is forgetful, which clears them too).
  dropAllPinTapes(traversal);
  if (forceForgetfulEntry || node.forgetfulEntry) clearFrame(traversal);
}

function hostEffectDedupKey(
  statementId: ElementId,
  effect: HostEffectBrief,
): string {
  // Ref-free by construction: the key persists in traversal state, which
  // replay compares modulo ref renames, so it must not embed arc/node refs.
  // The key list is already scoped to one traversal, and `id`/`sourceRef`
  // derive from that traversal, so beyond `statementId` only the ref-free
  // payload fields discriminate.
  return `${statementId}:${stableStringifyPayload({
    module: effect.module,
    target: effect.target,
    operation: effect.operation,
    arguments: effect.arguments,
  })}`;
}

function stableStringifyPayload(value: PayloadValue | HostEffectBrief): string {
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
