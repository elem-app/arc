/**
 * Persisted traversal state and the runtime identities, transitions, issues,
 * and moves shared with Arc's host-interaction protocol.
 */

import type {
  ActionStatement,
  ElementId,
  SegKey,
  SourceRange,
} from "./parser.js";
import type {
  ArrayElementValue,
  ArrayValue,
  CellValue,
  PayloadValue,
} from "./value.js";

/**
 * Canonical opaque reference to one arc inside a document.
 */
export type ArcRef = `arc:${string}`;

/**
 * Canonical reference to one root or owned nested node inside a document.
 */
export type NodeRef = `node:${string}`;

/**
 * Terminal runtime state of a node, corresponding directly to `State.*` inside
 * expressions. Each value is an authored node outcome:
 *
 * - `covered`: the node completed successfully
 * - `deflected`: the host reported an intentional decline or redirection
 * - `skipped`: the node was bypassed by an explicit guard outcome
 */
export type NodeState = "covered" | "deflected" | "skipped";

/**
 * Opaque id for one semantic work item in a brief.
 *
 * A `BriefId` is stable only within the originating brief snapshot. Hosts echo
 * it back in the matching report. It is not a durable persistence key and
 * callers must not parse it for runtime meaning.
 *
 * A bare `string` rather than a branded type, because a brief id crosses the
 * host boundary and comes back as JSON text. The runtime rejects an id it never
 * issued with an `invalid-item` issue.
 */
export type BriefId = string;

/** Persisted information about the deflection currently being finalized. */
export type DeflectionContext = {
  /** The traversal where the deflection originated. Preserved while bubbling. */
  origin: NodeRef;
  /**
   * The canonical target of the `$enter`/`$enterLoop` this deflection propagated
   * up through, rewritten at each parent boundary. Unset at the origin node,
   * whose own frontier deflection entered nothing — so `escaped` matches
   * no target there.
   */
  from?: NodeRef;
};

/**
 * Identity of the resumable SEG a walk blocked in, recorded on the action root
 * so a later report resumes that SEG at its suspended position instead of
 * re-deriving the arc from its root.
 *
 * `body` vs `guard` routes node-body resume: a `body` resume skips the guard (the
 * node already passed it on the way in), a `guard` resume re-runs the guard SEG.
 *
 * The hook kinds (`resolveWhen` / `deflectWhen` / `enterLoop`) record an attached
 * hook body as the deepest blocked SEG, carrying the `owner` action whose hook
 * blocked. Resume rebuilds the position at that owner and resolves its hook from
 * the report first — resolving or advancing the owning `instruct` / `enterLoop` —
 * before the enclosing body continues, so a hook side effect that enabled an
 * earlier blocking branch cannot divert control and drop the owner's
 * resolution.
 *
 * `effects` and `catch` are recorded for completeness, but resume routes them
 * through `TraversalFinalizing`, which is their resume authority, so their
 * `SegId` is informational.
 *
 * There is no `trigger` variant. A trigger consultation blocks by reporting no
 * match, and its pin tape is call state supplied per candidate by the trigger
 * brief chain. The trigger SEG therefore has a `SegKey` — it still keys
 * evaluator action states — with nothing to record here.
 */
export type SegId =
  | { kind: "guard" }
  | { kind: "body" }
  | { kind: "effects" }
  | { kind: "catch" }
  | { kind: "resolveWhen"; owner: ElementId }
  | { kind: "deflectWhen"; owner: ElementId }
  | { kind: "enterLoop"; owner: ElementId }
  | { kind: "invoke"; owner: ElementId }
  | { kind: "mapMember"; owner: ElementId; index: number };

/** SegKey of a node-lifecycle SEG. */
export function nodeSegKey(
  kind: "body" | "guard" | "effects" | "trigger",
): SegKey {
  return kind as string as SegKey;
}

/** SegKey of an owned hook SEG's consultation instance. */
export function hookSegKey(
  owner: ElementId,
  hook: "resolveWhen" | "deflectWhen",
): SegKey {
  return `${owner}/${hook}` as SegKey;
}

/** SegKey of an invoke body SEG: the invoke's own id is the scope. */
export function invokeSegKey(invoke: ElementId): SegKey {
  return invoke as string as SegKey;
}

/**
 * SegKey of one `$map` member row: the map's id qualified by the member index.
 * The `[n]` bracket delimits the index (as `catchSegKey` brackets its refs); the
 * ElementId alphabet excludes `[` `]`, so the qualifier never collides with a
 * static id.
 */
export function mapMemberSegKey(owner: ElementId, index: number): SegKey {
  return `${owner}[${index}]` as SegKey;
}

/**
 * SegKey of one catch-deflection consultation. Embeds the runtime deflection
 * identity (`origin`/`from` refs) — the only runtime-instanced SegKey. The refs
 * are bracketed (as in brief ids) so they are unambiguously delimited: replay
 * ref-rewriting remaps `[node:…]` occurrences without a partial-match hazard.
 */
export function catchSegKey(deflection: DeflectionContext): SegKey {
  return `catch:[${deflection.origin}]:[${deflection.from}]` as SegKey;
}

/**
 * One brief-site prefix substitution: an element id whose static scope is
 * `staticPrefix` has that prefix replaced by `instanceKey` to make its brief
 * identity per runtime instance. Two cases use it, and they compose:
 *
 * - An inherited `deflectWhen` consultation lives under the declaring node's
 *   `deflectWhen/` scope but its brief identity must be per owning instruction.
 * - A `$map` callback runs the same static callback ids (`<mapId>/…`) once per
 *   member row, so brief identity must be per member index.
 */
export type BriefSiteQualifier = { staticPrefix: string; instanceKey: string };

/**
 * Applies each qualifier's prefix substitution in order, so a callback element
 * under an inherited hook is qualified by both its member index and its hook
 * consultation instance, each substitution preserving the other. This is the
 * only manipulation of an element id.
 */
export function qualifiedBriefSite(
  qualifiers: readonly BriefSiteQualifier[] | undefined,
  id: ElementId,
): ElementId {
  if (!qualifiers || qualifiers.length === 0) return id;
  let result: string = id;
  for (const qualifier of qualifiers) {
    if (result.startsWith(qualifier.staticPrefix)) {
      result = `${qualifier.instanceKey}${result.slice(qualifier.staticPrefix.length)}`;
    }
  }
  return result as ElementId;
}

/** Whether the action holding this state has resolved. */
export type ActionStatus = "pending" | "resolved";

/**
 * The pending `$map` arena: the pinned input read once at first reach, and the
 * index-keyed member table driving sequential member execution.
 *
 * Members `[0, nextIndex)` are terminal, their validated `span.result` held in
 * `terminals`. The member at `nextIndex` is in-progress or not yet started; its
 * `span.result` accumulates in `staged` until it terminalizes, whereupon it
 * moves to `terminals` and `nextIndex` advances. When `nextIndex` reaches the
 * input length every member is terminal and the action resolves. `results` is
 * the output cell name, absent for the forEach shape (members run for effects,
 * no output array, `span.result` unbound).
 */
export type MapActionState = {
  pinnedInput: ArrayValue;
  results?: string;
  nextIndex: number;
  terminals: (ArrayElementValue | undefined)[];
  staged?: { set: boolean; value?: ArrayElementValue };
};

/**
 * Snapshot of the condition-readable state a node's read-set names, resolved
 * against the live traversal set at one moment. The enter pre-snapshot brackets
 * a child subtree with a before/after pair of these.
 *
 * Plain records so it stays JSON-serializable: it is persisted on
 * `ActionState.preSnapshot` and a durable store round-trips the traversal set
 * through JSON. A round-trip drops keys whose value is `undefined`; the diff
 * tolerates that by comparing the union of keys with a missing key meaning
 * `undefined` (see `snapshotChanged`).
 *
 * `unresolvedKeys` records read-set keys that could not be resolved at all (no
 * owner traversal, unresolvable node reference, missing channel binding). They
 * force a re-walk: the read-set says a branch reads them and the runtime cannot
 * prove them unchanged. A `childState` of `undefined` is a resolved value (the
 * node has not been entered), not an unresolved key.
 */
export type StateSnapshot = {
  cells: Record<string, CellValue | undefined>;
  nodeStates: Record<NodeRef, NodeState | undefined>;
  channels: Record<string, CellValue | undefined>;
  unresolvedKeys: string[];
  // The capturing SEG whose read-set plan this snapshot was taken under — the
  // node body or an invoke body — so the diff re-resolves the same plan.
  capturingSeg: SegKey;
};

/**
 * Continuation an enter action persists while its target is unresolved, so a
 * resume continues the existing target rather than re-entering it.
 */
type EnterContinuation = {
  /** Staged returns held transactionally until the enter resolves. */
  stagedReturns?: Record<string, CellValue>;
  /** The phase the enter suspended in. */
  enterPhase?: "target" | "resolveWhen";
};

/**
 * The caller read-set captured before a bracketing action's subtree first ran,
 * persisted across blocked execution so the action can diff before/after and
 * decide rewalk-vs-advance when it resolves. Carried by the kinds that open
 * something to bracket: both enters, `invoke`, `map`, and `instruction` (whose
 * `resolveWhen` / `deflectWhen` consultation is the bracketed work).
 */
type SubtreeBracket = {
  preSnapshot?: StateSnapshot;
};

/**
 * Persisted continuation for a pending instruction: the host-facing phase plus
 * the current lap's banked hook evidence. A lap — one `$instruct` pendency or
 * one `$instructLoop` iteration — collects each hook's settled outcome once;
 * a hook that settles while its sibling evidence is still open banks its value
 * here so later briefs re-pose only the open checks. A new lap starts with no
 * banked evidence.
 */
type InstructionContinuation = {
  instructionPhase: "apply" | "postcheck";
  deflectWhenOutcome?: boolean;
  resolveWhenOutcome?: boolean;
};

/** Continuation fields a caller may hand to a newly pending action state. */
export type PendingActionExtras = EnterContinuation &
  SubtreeBracket &
  Partial<InstructionContinuation> & { map?: MapActionState };

/** Every action kind that can hold resolution state on a node frame. */
export type ActionStateKind = ActionStatement["kind"];

/** The kinds that transfer control to a child traversal. */
export type EnterActionKind = Extract<
  ActionStateKind,
  "enter-node" | "enter-loop"
>;

/**
 * Per-action resolution state stored inside one node frame.
 *
 * Missing action state means "unresolved". Resolved actions are skipped when
 * traversal re-walks the action graph from the top.
 *
 * Discriminated on `kind` so continuation state reaches only the kinds that can
 * carry it: the enters record where they suspended, the subtree-opening kinds
 * hold a bracket snapshot, `$map` carries its arena, and every other action
 * holds nothing beyond its status.
 */
export type ActionState =
  | ({ kind: "enter-node"; status: ActionStatus } & EnterContinuation &
      SubtreeBracket)
  | ({ kind: "enter-loop"; status: ActionStatus } & EnterContinuation &
      SubtreeBracket)
  | ({ kind: "invoke"; status: ActionStatus } & SubtreeBracket)
  | ({ kind: "instruction"; status: "pending" } & SubtreeBracket &
      InstructionContinuation)
  | { kind: "instruction"; status: "resolved" }
  | ({
      kind: "map";
      status: ActionStatus;
      /** The `$map` arena, held while the action is pending. */
      map?: MapActionState;
    } & SubtreeBracket)
  | {
      kind: "host-call";
      status: "pending";
      /** Rendered invocation captured when this call is first reached. */
      call: {
        arguments: PayloadValue[];
        hostParams?: PayloadValue;
      };
    }
  | { kind: "host-call"; status: "resolved" }
  | {
      kind: Exclude<
        ActionStateKind,
        EnterActionKind | "invoke" | "instruction" | "map" | "host-call"
      >;
      status: ActionStatus;
    };

/**
 * The `ActionState` variant that holds state for one action kind. Selects by
 * membership rather than equality, so a kind inside a variant's grouped
 * discriminant — either enter, or any of the kinds sharing the plain variant —
 * still resolves to its variant.
 */
export type ActionStateOf<K extends ActionStateKind> =
  ActionState extends infer S
    ? S extends { kind: infer SK }
      ? K extends SK
        ? S
        : never
      : never
    : never;

/**
 * One pinned sigil-less evaluation result on a pin tape.
 *
 * A walk pins every non-constant sigil-less evaluation as the frontier advances
 * past it — cell/channel/outcome reads, dialog reads, judgments, and host-call
 * results — so a resume (seek) replays the walked prefix from its pins instead
 * of re-deriving or re-asking. Entries are discriminated so routing never
 * parses opaque brief ids, and an `undefined` result is encoded explicitly
 * (`hasValue: false`) to survive a JSON round-trip.
 *
 * `judgment` and `hostCall` entries are created pending when the evaluation
 * briefs, carry their brief id, and are hydrated in place when the report's
 * result arrives — the tape, not the per-call report map, is what later
 * evaluations consult.
 */
export type PinEntry =
  | {
      kind: "value";
      resolved: boolean;
      /** Number of flattened tape entries this expression subtree owns. */
      subtreeSize: number;
      hasValue?: boolean;
      value?: PayloadValue;
    }
  | { kind: "judgment"; briefId: BriefId; resolved: boolean; value?: boolean }
  | {
      kind: "hostCall";
      briefId: BriefId;
      resolved: boolean;
      hasValue?: boolean;
      value?: PayloadValue;
    };

/**
 * One SEG's pin tape: the pinned evaluations of each statement visit, in
 * evaluation order, keyed by the owning statement's `ElementId`. A statement's
 * entries are keyed by its structural position, so a statement skipped as
 * resolved skips its entries whole and alignment holds across mid-walk
 * resolution. Keys carry the full id, including the scope prefix the tape's own
 * SEG instance already implies, so persisted state stays self-describing. A
 * tape is released whole by dial-back (rewalk) and discarded when its SEG
 * completes.
 */
export type PinTape = Record<ElementId, PinEntry[]>;

/**
 * Per-node traversal bookkeeping.
 *
 * A frame persists throughout one entry. `forgetfulEntry` controls whether it is
 * cleared when a later entry begins. Each frame stores which authored actions
 * inside the node have already resolved, keyed by element id.
 *
 * `pinTapes` holds the node's per-SEG pin tapes, keyed by the same `SegKey`s
 * as `evaluatorActionStates` plus the node-lifecycle SEGs (`body`, `guard`,
 * `effects`). A hook SEG's tape lives and dies with its evaluator scope; the
 * lifecycle tapes are dropped by dial-back, SEG completion, and entry reset.
 */
export type NodeFrame = {
  actionStates: Record<ElementId, ActionState | undefined>;
  evaluatorActionStates: Record<
    SegKey,
    Record<ElementId, ActionState | undefined> | undefined
  >;
  pinTapes: Record<SegKey, PinTape | undefined>;
};

/** Reference to a caller cell in an `enter` channel. */
export type CallerCellRef = {
  ownerRef: NodeRef;
  cell: string;
};

/**
 * One resolved enter-channel binding on a child traversal. Most bindings link a
 * child channel key to a caller cell (`callerCell`). `value` carries an input
 * captured by value, either from direct Arc entry or from a `$map`
 * member's `span.item` / `span.index`. `spanResult` is the write sink into the
 * owning map arena's staged result for `span.result`.
 */
export type EnterChannelLink =
  | ({ kind: "callerCell" } & CallerCellRef)
  | { kind: "value"; value: CellValue }
  | { kind: "spanResult"; ownerRef: NodeRef; mapId: ElementId };

/** Enter-time and direct-root channel data for one traversal. */
export type EnterChannelState = {
  /** key: args channel key. */
  args: Record<string, EnterChannelLink>;
  /** key: returns channel key. */
  returns: Record<string, EnterChannelLink>;
  /** key: returns channel key. */
  stagedReturns: Record<string, CellValue>;
};

/**
 * Terminal work a traversal must finish before its `state` becomes visible, and
 * the authority resume routes through while it is set — `SegId` records the
 * finalizing SEGs only informationally.
 *
 * `phase` differs by reason because only a deflection can reach the catch hook:
 * a covered traversal goes straight to `effects`, while a deflected one runs
 * `catch` first and then `effects`.
 */
export type TraversalFinalizing =
  | {
      reason: "covered";
      phase: "effects";
    }
  | {
      reason: "deflected";
      deflection: DeflectionContext;
      phase: "catch" | "effects";
    };

/**
 * Recorded resume point on the action root traversal: the traversal that owns
 * the suspended frontier and the SEG it blocked in. Resumed at its suspended
 * position on the next report instead of re-deriving the frontier from the root.
 *
 * Resume rebuilds the suspended position from the SEG identity, and the blocked
 * leaf resolves against the report by brief id, so no blocked-leaf pointer is
 * recorded. A pending action blocked inside a hook records that hook directly
 * (carrying its `owner`), so resume re-reaches the owner at its position rather
 * than re-walking the body from the top.
 */
export type ActiveFrame = {
  activeRef: NodeRef;
  activeSeg: SegId;
};

/**
 * The stretch of position changes one transition covers: the nodes the walk
 * left, innermost first, and the nodes it newly opened, outermost first. Both
 * are lists because one transition spans a whole run of moves with no authored
 * evaluation in between.
 *
 * Three carriers hold this stretch at successive stages:
 *
 * - the in-walk latch accumulates it,
 * - `ArcTraversal.pendingTransition` persists it unacknowledged,
 * - `NodeTransition` renders it into a brief with the position and its host
 *   params.
 */
export type TransitionStretch = {
  exited: NodeRef[];
  entered: NodeRef[];
};

/**
 * Shared serializable runtime state for both arcs and owned child nodes.
 */
export type TraversalBase<TRef extends ArcRef | NodeRef> = {
  /** Canonical identity of the arc or node this traversal belongs to. */
  ref: TRef;
  enterCount: number;
  /** Coarse authored node outcome visible as `State.*` in expressions. */
  state?: NodeState;
  /** Internal terminal work that must finish before `state` is exposed. */
  finalizing?: TraversalFinalizing;
  /** Cell values declared by this node only. */
  cells: Record<string, CellValue | undefined>;
  /** Per-action resolution state for this node only. */
  frame: NodeFrame;
  /** Inline persisted traversals for owned nested child nodes. */
  ownedChildren: NodeTraversal[];
  /** Anonymous-copy traversals owned by specific action sites. */
  ephemeralChildren: NodeTraversal[];
  /** Referenced/imported arcs managed elsewhere in the traversal set. */
  refChildren: ArcRef[];
  /** Enter-time channels set by `$enter(..., { args, returns })`. */
  enterChannels: EnterChannelState;
  /**
   * Marks the enter action that currently owns this traversal's completion.
   * Absence means the traversal is not owned by an enter action — the action
   * root, or a traversal between enters. Bubble-up reads this to return control
   * to the exact caller node and enter action when a child resolves.
   */
  enteredBy?: { callerRef: NodeRef; actionId: ElementId };
};

/** Persisted runtime state for an owned nested node. */
export type NodeTraversal = TraversalBase<NodeRef>;

/**
 * Persisted runtime state for an arc.
 *
 * Cross-traversal continuation is recorded structurally: referenced arcs carry
 * an `enteredBy` marker (on `TraversalBase`) back to the caller enter action,
 * and the action root is the arc traversal whose `enteredBy` is undefined.
 *
 * `activeFrame` is the recorded resume point for action progression. It is set
 * only on the action root traversal and recomputed at each block.
 *
 * `phase` encodes the traversal lifecycle:
 * - `dormant`: fresh traversal, never triggered.
 * - `entered`: actively being worked.
 * - `completed`: all nodes covered.
 * - `suspended`: entered but left before completing.
 * - `poisoned`: progression failed due to an authored runtime error.
 */
// TODO: add compatDate/version metadata for runtime/API upgrades, then enforce
// on-demand migration policy (migrate only traversals that are re-entered).
// Placement (ArcTraversal vs ArcTraversalSet) is still an open design choice.
export type ArcTraversal = TraversalBase<ArcRef> & {
  activeFrame?: ActiveFrame;
  /**
   * Recorded, unacknowledged stretch of position changes. Set only on the
   * action root, written at the transition block sink beside `activeFrame`,
   * and cleared when the next report is accepted.
   */
  pendingTransition?: TransitionStretch;
  phase: "dormant" | "entered" | "completed" | "suspended" | "poisoned";
};

/**
 * Either persisted traversal shape. Most runtime functions accept this: an arc
 * traversal and an owned node traversal differ only in their ref type and the
 * action-root bookkeeping `ArcTraversal` adds.
 */
export type Traversal = ArcTraversal | NodeTraversal;

/**
 * The full persisted runtime state for action progression.
 *
 * Trigger probing and action progression both read and return traversal sets so
 * fresh `Runtime` instances can reconstruct execution without hidden in-memory
 * continuation state.
 */
export type ArcTraversalSet = ArcTraversal[];

/**
 * The walk's position moved from one node to another.
 *
 * `position` is the node the walk now stands at: evaluation continues there,
 * and the next dialog must be projected for it. `exited`
 * and `entered` tell how the walk got there — the nodes it left (innermost
 * first) and the nodes it newly opened (outermost first). Both are arrays
 * because one transition covers a whole stretch of moves with no authored
 * evaluation in between: a guard-less enter chain opens several nodes at once,
 * and a deflection can unwind several. On a pure entry, `position` is the
 * innermost entered node; on an exit, it is the caller returned to, which
 * appears in neither array because it was already open.
 *
 * `hostParams` is the position node's authored `hostParams` (`undefined` when
 * it declares none), carried so the host can decide how to project without a
 * document lookup. A transition-bearing brief carries no other work: the host
 * answers `proceed`, and the point of that report is the dialog supplied with
 * it, freshly projected for `position`.
 */
export type NodeTransition = TransitionStretch & {
  position: NodeRef;
  hostParams: PayloadValue;
};

/** Host-visible runtime issue surfaced while advancing from the previous yield. */
export type RuntimeIssue =
  | {
      kind: "poisoned-traversal";
      arc: ArcRef;
      active: NodeRef;
      source?: SourceRange;
      reasonCode?: string;
      reason?: string;
    }
  | {
      kind: "invalid-report";
      reasonCode?: string;
      reason?: string;
    }
  | {
      kind: "invalid-item";
      briefId: BriefId;
      reasonCode?: string;
      reason?: string;
    }
  | {
      kind: "ambiguous-match";
      matchableArcs: ArcRef[];
      reasonCode?: string;
      reason?: string;
    };

/** One document-local issue found while `Runtime.add()` validates an input. */
export type RuntimeDocumentIssue = {
  phase: "document";
  source: string;
  code: string;
  message: string;
  loc?: SourceRange;
};

/** One cross-document issue found while `Runtime.init()` validates the registry. */
export type RuntimeRegistryIssue =
  | {
      phase: "registry";
      code: "UNRESOLVED_IMPORT";
      message: string;
      source: string;
      localName: string;
      importedSource: string;
      importedName: string;
      loc?: SourceRange;
    }
  | {
      phase: "registry";
      code:
        | "ENTER_CHANNEL_UNDECLARED"
        | "ENTER_CHANNEL_UNRESOLVED"
        | "ENTER_CHANNEL_INCOMPATIBLE";
      message: string;
      arc: ArcRef;
      node: string;
      actionId: ElementId;
      target: string;
      namespace: "args" | "returns";
      key: string;
      loc?: SourceRange;
    };

/** Every expected validation issue surfaced by runtime registration. */
export type RuntimeRegistrationIssue =
  | RuntimeDocumentIssue
  | RuntimeRegistryIssue;

/**
 * Allowed high-level moves for one action brief.
 *
 * - `proceed`: report semantic results and continue traversal
 * - `deflect`: mark the active node as intentionally deflected. This move is
 *   only available when `allowedMoves` includes it for the current frontier.
 * - `poison`: mark the active arc as unusable because the host cannot execute
 *   the current frontier contract.
 */
export type ActionMove = "proceed" | "deflect" | "poison";
