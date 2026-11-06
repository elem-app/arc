/**
 * Host-facing brief and report types exchanged across Arc's runtime protocol.
 */

import type { InstructionAction, SourceRange } from "./ir.js";
import type {
  ArcRef,
  ArcTraversalSet,
  BriefId,
  DeflectionContext,
  InstructionPhase,
  NodeRef,
  TransitionStretch,
} from "./runtime.js";
import type { StructShape, UnionShape } from "./shape.js";
import type {
  CellValue,
  ObservedValue,
  PayloadValue,
  SemanticText,
} from "./value.js";

/**
 * A semantic boolean judgment the host may resolve for this turn.
 *
 * `sourceRef` identifies the source node that requested this judgment.
 */
export type JudgmentBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  guidance?: SemanticText;
  question: SemanticText;
  hostParams: PayloadValue;
};

/** Type metadata for one scalar value exposed by an observation brief. */
export type ScalarObservationMeta =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "enum"; values: string[] }
  | { type: "rangedInt"; min: number; max: number }
  | { type: "number"; min?: number; max?: number };

/** Ordered scalar alternatives for one whole observation result. */
export type UnionObservationMeta = UnionShape<ScalarObservationMeta>;

/** Element shape of an observed list; every element is a complete value. */
export type ArrayObservationMeta = {
  type: "array";
  element: ScalarObservationMeta | UnionObservationMeta | StructObservationMeta;
};

/**
 * One declared field of an observed struct: its rendered question and its type
 * metadata. A struct's current value is carried whole by the brief.
 */
export type StructObservationField = {
  question: SemanticText;
  meta: ObservationMeta;
};

/** Recursive field schema of an observed struct. */
export type StructObservationMeta = StructShape<StructObservationField>;

/**
 * Type metadata describing an observed value. Scalars carry their type/bounds,
 * unions their ordered alternatives, arrays their element shape, and structs
 * their declared fields.
 */
export type ObservationMeta =
  | ScalarObservationMeta
  | UnionObservationMeta
  | ArrayObservationMeta
  | StructObservationMeta;

/**
 * Authored action an observation brief preserves:
 * - `observe`: silent semantic observation only
 * - `observeOrAsk`: the host may either resolve it silently or choose to ask
 */
export type ObservationMode = "observe" | "observeOrAsk";

/**
 * An observation opportunity the host may resolve for this turn.
 *
 * `currentValue` is included when the traversal already holds a value, so the
 * host can decide whether a refresh is still needed.
 *
 * `sourceRef` identifies the source node that requested this observation.
 *
 * `kind` discriminates this from `ObservationGroupBrief`, which shares the
 * observation channel on every brief.
 */
export type ObservationBrief = {
  kind: "observation";
  id: BriefId;
  sourceRef: NodeRef;
  guidance?: SemanticText;
  cell: string;
  mode: ObservationMode;
  question: SemanticText;
  currentValue?: ObservedValue;
  hostParams: PayloadValue;
  meta: ObservationMeta;
};

/**
 * One cell within an {@link ObservationGroupBrief}. Carries the same per-cell
 * extraction context a single {@link ObservationBrief} does — question, current
 * value, and type metadata — for one member of the group.
 */
export type ObservationGroupField = {
  /** Canonical concrete cell-target label — the write target and report key. */
  cell: string;
  /** Rendered observation question from the cell's `observing`. */
  question: SemanticText;
  /** Current value, present only when the member is set. */
  currentValue?: ObservedValue;
  /** Cell type metadata for host-side validation/UI. */
  meta: ObservationMeta;
};

/**
 * Request to extract several cells together as one atomic action — from an
 * `$observe({ ... })` or `$observeOrAsk({ ... })` call. The host infers the
 * whole set in one inference and reports every field in one
 * {@link ObservationGroupReport}; the runtime applies that report as a unit and
 * keeps no per-field progress.
 *
 * `kind` discriminates this from `ObservationBrief`, which shares the
 * observation channel on every brief.
 */
export type ObservationGroupBrief = {
  kind: "observation-group";
  id: BriefId;
  sourceRef: NodeRef;
  guidance?: SemanticText;
  mode: ObservationMode;
  hostParams: PayloadValue;
  fields: ObservationGroupField[];
};

/**
 * Currently reachable follow-up checks for an instruction pending resolution
 * of its `resolveWhen` / `deflectWhen` logic.
 *
 * A postcheck is the subset of the authored `resolveWhen` / `deflectWhen`
 * logic that the runtime reached while checking whether this instruction should
 * resolve, remain pending, or deflect in the current `ActionBrief` — its
 * semantic and host-call work. The ids listed here refer to brief items already
 * present in the same `ActionBrief`.
 *
 * Hosts can report values for these ids when handing the brief back to the
 * runtime. If some ids remain unresolved, later briefs may repeat the same
 * instruction with a different postcheck frontier.
 */
export type InstructionPostcheck = {
  judgmentIds: BriefId[];
  observationIds: BriefId[];
  hostCallIds: BriefId[];
};

/**
 * Host-directed instruction text emitted by the arc.
 *
 * Hosts typically apply this as guidance for LLM generation and decide how
 * (or whether) to surface it in user-visible output.
 *
 * `sourceRef` identifies the source node that emitted this instruction.
 */
export type InstructionBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  guidance?: SemanticText;
  mode: InstructionAction["mode"];
  phase: InstructionPhase;
  text: SemanticText;
  hostParams: PayloadValue;
  postcheck?: InstructionPostcheck;
};

/** A host operation invocation awaiting resolution by the host. */
export type HostCallBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  guidance?: SemanticText;
  module: string;
  target: string[];
  operation: string;
  arguments: PayloadValue[];
  hostParams: PayloadValue;
};

/**
 * High-level moves offered by the current action brief through `allowedMoves`.
 *
 * - `proceed`: report semantic results and continue traversal
 * - `deflect`: initiate or acknowledge deflection at the active node.
 * - `interrupt`: interrupt pending work without acknowledging it.
 * - `poison`: mark the active arc as unusable because the host cannot execute
 *   the current frontier contract.
 */
export type ActionMove = "proceed" | "deflect" | "interrupt" | "poison";

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

/**
 * Multi-arc trigger brief for the current traversal probe.
 *
 * Trigger probing stays separate from normal action-brief probing because trigger
 * evaluation may perform `$observe(...)` / `judge(...)` work before any arc is
 * admitted into the main traversal loop.
 *
 * `matchableArcs` contains arcs whose trigger consultations have already
 * evaluated true under the currently known state. It may coexist with pending
 * `judgments`, `observations`, or `hostCalls` while other candidates remain
 * open. Without an effective `preferredMatch`, the runtime waits for that work
 * to settle before implicitly selecting a sole matchable arc.
 *
 * `matched` identifies the selected arc once trigger stage has resolved to a
 * single activation. The host may select an arc already listed in
 * `matchableArcs` by reporting it as `preferredMatch` without answering the
 * remaining pending work; explicit selection settles immediately and the
 * resulting matched brief clears the unneeded work.
 *
 * `deps` is the compatibility set for the returned `traversals`. Callers that
 * persist and later feed those traversals back into a runtime must provide Arc
 * definitions compatible with every ArcRef in this list. The set can include
 * arcs that do not currently have traversal entries because they are reachable
 * through imports and may be entered later.
 *
 * Hosts may inspect this object freely, but must treat it as immutable and
 * pass the same object instance back to
 * `Runtime.progressTrigger(...)`.
 */
export type TriggerBrief = {
  matched?: ArcRef;
  deps: ArcRef[];
  traversals: ArcTraversalSet;
  issues: RuntimeIssue[];
  judgments: JudgmentBrief[];
  /**
   * Pending observations. A single `$observe(a)` yields an `ObservationBrief`;
   * a grouped `$observe({ a, b })` yields an `ObservationGroupBrief`. The two
   * share one channel so a host that reads observations handles the group
   * variant as well. Discriminate on `kind`.
   */
  observations: (ObservationBrief | ObservationGroupBrief)[];
  hostCalls: HostCallBrief[];
  matchableArcs: ArcRef[];
};

/**
 * Structured brief issued by arc traversal when delegation is needed.
 *
 * The host reads this brief, chooses one of `allowedMoves`, then
 * reports back an `ActionReport` through `Runtime.progress(...)`.
 *
 * This brief is ephemeral: it is bound to the exact document/traversal-set
 * snapshot used to build it. Hosts may later call `Runtime.progress(...)` with
 * a newer dialog.
 *
 * `traversals` is the full persisted state the caller should save after this
 * yield. `active` identifies which traversal inside that set currently owns the
 * frontier described by the brief. `active` is derived and does not need to be
 * persisted separately.
 *
 * Hosts may inspect this object freely, but must treat it as immutable and
 * pass the same object instance back to `Runtime.progress(...)`.
 */
export type ActionBrief = {
  /** Full persisted traversal state to save after this yield. */
  traversals: ArcTraversalSet;
  /** The traversal inside `traversals` that this brief/report is about. */
  active: NodeRef;
  /** This brief is an actionable frontier accepted by `Runtime.progress`. */
  canProgress: true;
  /** Protocol or authored-execution issues surfaced after the previous yield. */
  issues: RuntimeIssue[];
  /** Pending host operation invocations produced before this yield. */
  hostCalls: HostCallBrief[];
  judgments: JudgmentBrief[];
  /**
   * Pending observations, single and grouped on one channel. A single
   * `$observe(a)` yields an `ObservationBrief`; a grouped `$observe({ a, b })`
   * yields an `ObservationGroupBrief`. Sharing the channel makes a host that
   * reads observations handle the group variant as well. Discriminate on
   * `kind`.
   */
  observations: (ObservationBrief | ObservationGroupBrief)[];
  instructions: InstructionBrief[];
  /**
   * The walk's position moved; the brief carries no other work. Answer
   * `proceed` with a dialog freshly projected for `position`.
   */
  transition?: NodeTransition;
  /**
   * Required deflection awaiting a bare `{ move: "deflect" }` acknowledgement.
   * Carries its origin with `from` unset. Exclusive of transition and work.
   */
  deflection?: DeflectionContext;
  allowedMoves: ActionMove[];
};

/**
 * Ends the current action progression and cannot be submitted to Runtime.progress.
 */
export type TerminalBrief = {
  /** Full persisted traversal state at handback. */
  traversals: ArcTraversalSet;
  /** Discriminator for terminal action output. */
  canProgress: false;
  /** Registered root whose action stage produced this result. */
  root: ArcRef;
  /** Structured issues carried by the output. */
  issues: RuntimeIssue[];
} & (
  | {
      outcome: "covered";
      /** Committed root returns, present only when the root declares them. */
      returns?: Record<string, CellValue>;
    }
  | {
      outcome: "deflected" | "poisoned" | "interrupted";
      returns?: never;
    }
);

/**
 * Outcome for one observation reported back by the host.
 *
 * - `resolved`: a complete concrete value of the observed type, committed into
 *   traversal state
 * - `unknown`: no value could be inferred this turn; for `$observe()` this
 *   consumes the action without writing a new value, while `$observeOrAsk()`
 *   remains pending
 * - `needs-user`: the host determined a participant must be asked; valid only for
 *   `$observeOrAsk()`, and leaves the action pending
 */
export type ObservationReport =
  | { status: "resolved"; value: ObservedValue }
  | { status: "unknown" | "needs-user"; value?: never };

/**
 * Outcome for one grouped observation reported back by the host. It must carry
 * an entry for every member in the brief; a report that omits a member is
 * invalid and re-emits the group. Each member outcome follows
 * {@link ObservationReport}.
 *
 * Plain `$observe({ ... })` writes every resolved member together and settles.
 * `$observeOrAsk({ ... })` writes and settles only when every member resolves;
 * otherwise it writes nothing and re-emits the whole group.
 *
 * Neither report type carries a discriminating tag. Read them apart by the
 * presence of `fields`, or by the kind of the brief the id came from.
 */
export type ObservationGroupReport = {
  fields: Record<string, ObservationReport>;
};

/** Outcome for one instruction application reported back by the host. */
export type InstructionReport = {
  /** The host applied this instruction during the current application window. */
  status: "applied";
};

/** Resolution of one host operation invocation. */
export type HostCallReport = {
  status: "resolved";
  /** Present when the operation produced a value. */
  value?: PayloadValue;
};

/** Host-defined interruption identity and optional explanation. */
export type ActionInterruption = {
  id: string;
  reason?: string;
};

/** Host-supplied diagnostic for `ActionReport.move = "poison"`. */
export type ActionPoisonReason = {
  reasonCode?: string;
  reason?: string;
};

/**
 * Trigger brief report returned by the host.
 *
 * `preferredMatch` requests one trigger candidate as the match. When it names
 * an arc already listed in the originating brief's `matchableArcs`, the host
 * may omit that brief's pending judgments, observations, and host calls, so the
 * selection settles immediately. A request naming an open candidate remains
 * pending while its consultation continues. Judgments and observations are
 * keyed by ids from the originating `TriggerBrief`.
 */
export type TriggerReport = {
  preferredMatch?: ArcRef;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  hostCalls?: Record<BriefId, HostCallReport>;
};

/**
 * Structured report returned by the host or presenter.
 *
 * It is accepted only through `Runtime.progress(...)`, which validates the
 * report against the originating brief snapshot and replans using the dialog
 * supplied for that progress call.
 */
export type ActionReport = {
  move: ActionMove;
  /** Required for interrupt; unavailable on other moves. */
  interruption?: ActionInterruption;
  poisonReason?: ActionPoisonReason;
  instructions?: Record<BriefId, InstructionReport>;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  hostCalls?: Record<BriefId, HostCallReport>;
};
