import type {
  Node,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  SegKey,
  SetAction,
  SetReturnAction,
  UnsetAction,
} from "../types/parser.js";
import type { Traversal } from "../types/runtime.js";
import {
  type ActionOutcome,
  applyObserve,
  applyObserveGroup,
  applySet,
  applySetReturn,
  applyUnset,
} from "./evaluate.js";
import { type LeafStep, blockSeg, writeDiffStep } from "./seg.js";
import {
  type Accumulator,
  getActionState,
  getEvaluatorActionState,
  isResolvedActionState,
  markActionResolved,
  markEvaluatorActionResolved,
} from "./state.js";

/**
 * The narrow leaf actions shared across every SEG: direct state reads/writes
 * that settle without a brief. Only the resolution-state scope differs by SEG.
 */
export type NarrowLeaf =
  | ObserveAction
  | ObserveOrAskAction
  | ObserveGroupAction
  | ObserveOrAskGroupAction
  | SetAction
  | UnsetAction
  | SetReturnAction;

/**
 * Records and reads a narrow leaf's resolution state — keyed on the node frame
 * (`node` scope) or a named evaluator frame (`evaluator` scope).
 */
export type NarrowScope = {
  isResolved: (action: NarrowLeaf) => boolean;
  markResolved: (action: NarrowLeaf) => void;
};

export function nodeNarrowScope(traversal: Traversal): NarrowScope {
  return {
    isResolved: (action) =>
      isResolvedActionState(getActionState(traversal, action)),
    markResolved: (action) => markActionResolved(traversal, action),
  };
}

export function evaluatorNarrowScope(
  traversal: Traversal,
  segKey: SegKey,
): NarrowScope {
  // Evaluator-scoped SEGs (triggers and boolean hooks) never contain
  // a `set-return`, so narrowing it out of the marker's accepted union is sound.
  type EvaluatorLeaf = Exclude<NarrowLeaf, SetReturnAction>;
  return {
    isResolved: (action) =>
      isResolvedActionState(
        getEvaluatorActionState(traversal, segKey, action as EvaluatorLeaf),
      ),
    markResolved: (action) =>
      markEvaluatorActionResolved(traversal, segKey, action as EvaluatorLeaf),
  };
}

/** Narrows a SEG leaf to a {@link NarrowLeaf}, or `undefined` when it is not one. */
function asNarrowLeaf(statement: { kind: string }): NarrowLeaf | undefined {
  switch (statement.kind) {
    case "observe":
    case "observeOrAsk":
    case "observeGroup":
    case "observeOrAskGroup":
    case "set":
    case "unset":
    case "set-return":
      return statement as NarrowLeaf;
    default:
      return undefined;
  }
}

function applyNarrowLeaf(
  leaf: NarrowLeaf,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): ActionOutcome<{ changed: boolean }> {
  switch (leaf.kind) {
    case "observe":
    case "observeOrAsk":
      return applyObserve(leaf, traversal, node, accum);
    case "observeGroup":
    case "observeOrAskGroup":
      return applyObserveGroup(leaf, traversal, node, accum);
    case "set":
      return applySet(leaf, traversal, node, accum);
    case "unset":
      return applyUnset(leaf, traversal, node, accum);
    case "set-return":
      return applySetReturn(leaf, traversal, node, accum);
  }
}

/**
 * The narrow-action write-diff gate, shared by every SEG. A resolved `observe` /
 * `set` / `unset` / `set-return` applies the node's configured write-diff
 * step when the write moved a value, and otherwise advances. A blocked apply
 * suspends the SEG; `markResolved` records the leaf as settled.
 */
function settleNarrowLeaf<TResult>(
  apply: ActionOutcome<{ changed: boolean }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  markResolved: () => void,
): LeafStep<TResult> {
  if (apply.status === "blocked") return blockSeg(accum, traversal);
  markResolved();
  return writeDiffStep(node, apply.value.changed);
}

/**
 * Steps a SEG leaf if it is a narrow action, recording resolution in `scope`;
 * returns `undefined` otherwise so a caller can handle its own wide / host leaves.
 */
export function stepNarrowLeaf<TResult>(
  statement: { kind: string },
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  scope: NarrowScope,
): LeafStep<TResult> | undefined {
  const leaf = asNarrowLeaf(statement);
  if (!leaf) return undefined;
  return settleNarrowLeaf<TResult>(
    applyNarrowLeaf(leaf, traversal, node, accum),
    traversal,
    node,
    accum,
    () => scope.markResolved(leaf),
  );
}

/** Whether a SEG leaf is a narrow action already resolved in `scope`. */
export function isResolvedNarrowLeaf(
  statement: { kind: string },
  scope: NarrowScope,
): boolean {
  const leaf = asNarrowLeaf(statement);
  return leaf !== undefined && scope.isResolved(leaf);
}
