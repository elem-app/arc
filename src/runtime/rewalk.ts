import type { ElementId, Node, NodeReadSet, SegKey } from "../types/parser.js";
import type {
  NodeRef,
  NodeState,
  StateSnapshot,
  Traversal,
} from "../types/runtime.js";
import { invokeSegKey, nodeSegKey } from "../types/runtime.js";
import type { CellValue } from "../types/value.js";
import {
  channelIsDeclared,
  findCellOwner,
  readChannelValue,
  resolveRefInTraversal,
} from "./evaluate.js";
import { arcToNodeRef, getEntryForRef, isArcRef } from "./refs.js";
import { type LeafStep, writeDiffStep } from "./seg.js";
import { type Accumulator, cellValuesEqual, childState } from "./state.js";

/**
 * Resolves a node's read-set against the live traversal set and reads current
 * values. Cell names resolve to their lexical owner traversal, node ids to
 * the addressed traversal's outcome, and channels to their caller-backed value
 * (or staged return). Unresolvable keys are recorded, not skipped.
 */
export function captureSnapshot(
  plan: NodeReadSet,
  capturingSeg: SegKey,
  callerTraversal: Traversal,
  callerNode: Node,
  accum: Accumulator,
): StateSnapshot {
  const cells: Record<string, CellValue | undefined> = {};
  const nodeStates: Record<NodeRef, NodeState | undefined> = {};
  const channels: Record<string, CellValue | undefined> = {};
  const unresolvedKeys: string[] = [];

  for (const name of plan.cells) {
    const owner = findCellOwner(name, callerTraversal, accum);
    if (!owner) {
      unresolvedKeys.push(`cell:${name}`);
      continue;
    }
    cells[name] = owner.traversal.cells[name];
  }

  for (const identifier of plan.nodeIdentifiers) {
    const ref = resolveRefInTraversal(
      accum,
      callerTraversal,
      callerNode,
      identifier,
    );
    if (!ref) {
      unresolvedKeys.push(`nodeState:${identifier}`);
      continue;
    }
    const nodeRef: NodeRef = isArcRef(ref) ? arcToNodeRef(ref) : ref;
    nodeStates[nodeRef] = childState(accum.traversals, ref);
  }

  for (const channel of plan.channels) {
    const channelKey = `${channel.namespace}.${channel.key}`;
    const channelState = callerTraversal.enterChannels;
    const hasBinding =
      (channel.namespace === "returns" &&
        channel.key in channelState.stagedReturns) ||
      channel.key in channelState[channel.namespace];
    // A declared-but-unbound channel resolves to `undefined` (unset), not an
    // unresolved read: the read-set names it and the runtime knows it is unset.
    if (
      !hasBinding &&
      !channelIsDeclared(callerTraversal, channel.namespace, channel.key, accum)
    ) {
      unresolvedKeys.push(`channel:${channelKey}`);
      continue;
    }
    channels[channelKey] = readChannelValue(
      callerTraversal,
      channel.namespace,
      channel.key,
      accum,
    );
  }

  return { cells, nodeStates, channels, unresolvedKeys, capturingSeg };
}

/**
 * Reports whether the bracketed state changed between two snapshots. Any
 * unresolved key (either side) forces change, since the runtime cannot prove
 * the read unchanged. Otherwise the first differing key wins — compared over
 * the union of keys, so a key dropped by a JSON round-trip (its value was
 * `undefined`) reads as `undefined` rather than going unchecked.
 */
export function snapshotChanged(
  before: StateSnapshot,
  after: StateSnapshot,
): boolean {
  if (before.unresolvedKeys.length > 0 || after.unresolvedKeys.length > 0) {
    return true;
  }

  return (
    recordChanged(before.cells, after.cells, cellValuesEqual) ||
    recordChanged(before.nodeStates, after.nodeStates, (a, b) => a === b) ||
    recordChanged(before.channels, after.channels, cellValuesEqual)
  );
}

function recordChanged<V>(
  before: Record<string, V | undefined>,
  after: Record<string, V | undefined>,
  equal: (a: V | undefined, b: V | undefined) => boolean,
): boolean {
  // Compare over the union of keys without allocating a Set: every `before` key,
  // then every `after` key the `before` side lacked (a key dropped by a JSON
  // round-trip reads as `undefined` rather than going unchecked).
  for (const key of Object.keys(before)) {
    if (!equal(before[key], after[key])) return true;
  }
  for (const key of Object.keys(after)) {
    if (!(key in before) && !equal(before[key], after[key])) return true;
  }
  return false;
}

/**
 * The static read-set plan for a capturing SEG of `node`: the node body under
 * `nodeSegKey("body")`, or an invoke body under `invokeSegKey(id)`. The body
 * plan already includes its invoke bodies' reads transitively, so the invoke
 * boundary brackets the containing set augmented with the body's reads while
 * in-body brackets diff against the body's local set. `undefined` (no plan for
 * the entry, or an unknown SEG) forces a conservative re-walk.
 */
function resolveRewalkPlan(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  capturingSeg: SegKey,
): NodeReadSet | undefined {
  return getEntryForRef(accum.entries, traversal.ref)
    ?.rewalkPlan?.bySeg.get(node)
    ?.get(capturingSeg);
}

/**
 * The capturing SEG for a bracket taken now: the innermost active invoke body
 * of `node`, or the node's own body when the walk is not inside one.
 */
function capturingSegKey(accum: Accumulator, node: Node): SegKey {
  const invokeId = innermostInvokeIdFor(accum, node);
  return invokeId !== undefined ? invokeSegKey(invokeId) : nodeSegKey("body");
}

/** The innermost active invoke context belonging to `node`, if any. */
function innermostInvokeIdFor(
  accum: Accumulator,
  node: Node,
): ElementId | undefined {
  const context = accum.invokeContext;
  if (!context) return undefined;
  for (let index = context.length - 1; index >= 0; index -= 1) {
    if (context[index]!.node === node) return context[index]!.id;
  }
  return undefined;
}

/**
 * Captures the bracketing SEG's read-set snapshot, or `undefined` when
 * unplanned. Resolves the plan for the current capturing SEG and stamps that
 * SEG onto the snapshot, so the later diff re-resolves the same plan without
 * the caller re-supplying it.
 */
export function captureReadSet(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): StateSnapshot | undefined {
  const capturingSeg = capturingSegKey(accum, node);
  const plan = resolveRewalkPlan(traversal, node, accum, capturingSeg);
  if (!plan) return undefined;
  return captureSnapshot(plan, capturingSeg, traversal, node, accum);
}

/**
 * Decides how a resolved wide action (enter / instruction / invoke) continues
 * its enclosing SEG. An unchanged bracketing read-set advances; a changed set
 * applies the node's configured write-diff step. With no captured `before`
 * snapshot (no plan), the set is conservatively treated as changed. The diff
 * re-resolves the plan for the SEG the snapshot was stamped with
 * (`capturingSeg`), so capture and diff always use the same plan by construction.
 */
export function readSetRewalkStep(
  before: StateSnapshot | undefined,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): LeafStep<void> {
  if (!before) return writeDiffStep(node, true);
  const plan = resolveRewalkPlan(traversal, node, accum, before.capturingSeg);
  if (!plan) return writeDiffStep(node, true);
  const after = captureSnapshot(
    plan,
    before.capturingSeg,
    traversal,
    node,
    accum,
  );
  return writeDiffStep(node, snapshotChanged(before, after));
}
