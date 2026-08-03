import type {
  DeflectionContext,
  ElementId,
  Node,
  Traversal,
  ValueExpression,
} from "../types.js";
import { traversalToNodeRef } from "./refs.js";
import { runtimeError } from "./report-validation.js";
import {
  type Accumulator,
  recordActiveFrame,
  setActiveTraversal,
} from "./state.js";

/**
 * The terminal outcome of one SEG walk: completed with a value, suspended on a
 * brief, or deflected.
 */
export type SegOutcome<TResult> =
  | { status: "done"; value: TResult }
  | { status: "blocked" }
  | { status: "deflected"; deflection: DeflectionContext };

/** A SEG walk result before the re-walk loop folds `rewalk` away. */
export type WalkResult<TResult> = { status: "rewalk" } | SegOutcome<TResult>;

/** Applies the current node's configured continuation rule to a write-set diff. */
export function writeDiffStep<TResult>(
  node: Pick<Node, "writeDiffMode">,
  changed: boolean,
): LeafStep<TResult> {
  return changed && node.writeDiffMode === "rewalk"
    ? { status: "rewalk" }
    : { status: "advance" };
}

/** One leaf step's effect on the SEG walk: advance, re-walk, or terminate. */
export type LeafStep<TResult> = { status: "advance" } | WalkResult<TResult>;

/** One frame of the explicit SEG walk stack. */
export type SegFrame<TStatement extends { kind: string }> = {
  statements: readonly TStatement[];
  index: number;
  label?: string;
};

/** The `if`-branch type a SEG `evaluateIf` hook receives. */
export type IfLike<TStatement extends { kind: string }> = TStatement & {
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

/** A `return <expr>` statement a SEG `evaluateReturn` hook receives. */
export type ReturnLike = {
  id: ElementId;
  kind: "return";
  value?: ValueExpression;
};

/** What evaluating an `if` yields: a branch to descend into, or a SEG outcome. */
export type BranchResult<TStatement extends { kind: string }, TResult> =
  | { status: "branch"; statements: readonly TStatement[] }
  | SegOutcome<TResult>;

/**
 * The leaf- and control-flow semantics a SEG walk delegates to. The walker owns
 * `if` / `label` / `break` sequencing; everything statement-specific is a hook.
 */
export type SegHooks<
  TStatement extends { kind: string; id: ElementId },
  TResult,
> = {
  doneValue: TResult;
  evaluateIf: (
    statement: IfLike<TStatement>,
  ) => BranchResult<TStatement, TResult>;
  evaluateReturn?: (statement: ReturnLike) => SegOutcome<TResult>;
  isResolvedLeaf?: (statement: TStatement) => boolean;
  stepLeaf: (statement: TStatement) => LeafStep<TResult>;
  // Invoked with the statement before each evaluating visit (`if` test,
  // `return`, leaf step). SEG executors open the statement's pin entries (keyed
  // by its element id) here so sigil-less evaluations inside the statement
  // replay or record against them. Skipped resolved leaves and structural
  // `label`/`break` steps evaluate nothing and get no call.
  beginStatement?: (statement: TStatement) => void;
  // Invoked once each time `runSeg` restarts the SEG from its root after a
  // resolved leaf requested a re-walk (dial-back). SEG executors release the
  // SEG's pin tape here.
  onRewalkRestart?: () => void;
};

/**
 * Upper bound on `runSeg` re-walk restarts before a SEG is declared
 * non-convergent. A body that writes a value its own read-set depends on
 * without reaching a fixpoint (e.g. `invoke(() => count.$set(count + 1))`) would
 * otherwise spin forever; past this bound `runSeg` throws, which
 * `Runtime.start` / `Runtime.progress` route to a poisoned-traversal issue.
 */
const SEG_REWALK_LIMIT = 10_000;

/**
 * Runs one smallest enclosing graph (SEG) to a terminal outcome.
 *
 * `runSeg(...)` owns the SEG re-walk loop. `walkSeg(...)` performs one
 * top-down pass; when a briefable action or enter action resolves and requests
 * re-walk, `runSeg(...)` starts a fresh pass from the SEG root.
 */
export function runSeg<
  TStatement extends { kind: string; id: ElementId },
  TResult,
>(
  statements: readonly TStatement[],
  hooks: SegHooks<TStatement, TResult>,
  initialStack?: SegFrame<TStatement>[],
): SegOutcome<TResult> {
  // `initialStack` positions only the first pass — a clean bubble-up or
  // owner-first hook resume reconstructs the suspended frame stack so the walk
  // resumes at any nesting. A re-walk request (a later resolved leaf net-changed
  // state) restarts from the SEG root, where earlier branch reachability must be
  // recomputed.
  let stack = initialStack ?? [{ statements, index: 0 }];
  let rewalks = 0;
  while (true) {
    const outcome = walkSeg(statements, hooks, stack);
    if (outcome.status === "rewalk") {
      rewalks += 1;
      if (rewalks > SEG_REWALK_LIMIT) {
        throw runtimeError(
          "seg-rewalk-limit-exceeded",
          "Arc SEG re-walk did not converge: a write inside a rewalk-driven " +
            "context must be idempotent at the fixpoint",
        );
      }
      hooks.onRewalkRestart?.();
      stack = [{ statements, index: 0 }];
      continue;
    }
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
function walkSeg<TStatement extends { kind: string; id: ElementId }, TResult>(
  statements: readonly TStatement[],
  hooks: SegHooks<TStatement, TResult>,
  initialStack?: SegFrame<TStatement>[],
): WalkResult<TResult> {
  const stack: SegFrame<TStatement>[] = initialStack ?? [
    { statements, index: 0 },
  ];

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
      hooks.beginStatement?.(statement);
      const ifLike = statement as IfLike<TStatement>;
      const branch = hooks.evaluateIf(ifLike);
      if (branch.status !== "branch") return branch;
      if (branch.statements.length === 0) {
        frame.index += 1;
        continue;
      }
      stack.push({
        statements: branch.statements,
        index: 0,
      });
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
      hooks.beginStatement?.(statement);
      return hooks.evaluateReturn(statement as ReturnLike);
    }

    if (hooks.isResolvedLeaf?.(statement)) {
      frame.index += 1;
      continue;
    }

    hooks.beginStatement?.(statement);
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

/** Suspends the current SEG and records the resume point on the action root. */
export function blockSeg<TResult>(
  accum: Accumulator,
  traversal: Traversal,
): SegOutcome<TResult> {
  blockTraversal(accum, traversal);
  return { status: "blocked" };
}

/** A SEG outcome that deflects at the current traversal. */
export function deflectSeg<TResult>(traversal: Traversal): SegOutcome<TResult> {
  // The deflection originates here and has entered nothing yet, so `from` is
  // unset until it propagates up through a parent's `$enter` boundary.
  return {
    status: "deflected",
    deflection: { origin: traversalToNodeRef(traversal) },
  };
}

/**
 * Records the resume point on the action root at the single block sink: the
 * blocking traversal and the SEG the walk is currently in. First walk and
 * resume alike, so the next report replays this SEG from its suspended position
 * rather than re-deriving the arc from the root.
 */
export function blockTraversal(
  accum: Accumulator,
  traversal: Traversal,
): { status: "blocked" } {
  setActiveTraversal(accum, traversal);
  recordActiveFrame(accum);
  accum.blocked = true;
  return { status: "blocked" };
}
