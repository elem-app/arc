/**
 * Host-facing brief and report types exchanged across Arc's runtime protocol.
 */

import type { InstructionAction } from "./parser.js";
import type {
  ActionMove,
  ArcRef,
  ArcTraversalSet,
  BriefId,
  NodeRef,
  NodeTransition,
  RuntimeIssue,
} from "./runtime.js";
import type {
  CellValue,
  PayloadValue,
  PrimitiveArrayValue,
  PrimitiveValue,
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

/**
 * Type metadata describing an observed value. A scalar carries its own
 * type/bounds; an array carries its element shape so the host extracts a
 * complete element-typed list.
 */
export type ObservationValueMeta =
  | ScalarObservationMeta
  | { type: "array"; element: ScalarObservationMeta };

/**
 * An observation opportunity the host may resolve for this turn.
 *
 * `mode` preserves the authored action:
 * - `observe`: silent semantic observation only
 * - `observeOrAsk`: the host may either resolve it silently or choose to ask
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
  cell: string;
  mode: "observe" | "observeOrAsk";
  question: SemanticText;
  currentValue?: PrimitiveValue | PrimitiveArrayValue;
  hostParams: PayloadValue;
  meta: ObservationValueMeta;
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
  /** Current value, if any. */
  currentValue?: PrimitiveValue | PrimitiveArrayValue;
  /** Cell type metadata for host-side validation/UI. */
  meta: ObservationValueMeta;
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
  mode: "observe" | "observeOrAsk";
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
  mode: InstructionAction["mode"];
  phase: "apply" | "postcheck";
  text: SemanticText;
  hostParams: PayloadValue;
  postcheck?: InstructionPostcheck;
};

/**
 * A host-backed value request emitted from an expression frontier.
 *
 * The runtime is blocked until the host reports a value for this call id.
 */
export type HostCallBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  module: string;
  target: string[];
  operation: string;
  arguments: (PayloadValue | SemanticText)[];
  hostParams: PayloadValue;
};

/**
 * Rendered host effect payload ready for host handling.
 */
export type HostEffectBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  module: string;
  target: string[];
  operation: string;
  arguments: (PayloadValue | SemanticText)[];
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
  /** Pending host-backed value requests produced before this yield. */
  hostCalls: HostCallBrief[];
  /** Host effects awaiting a report; unreported effects hold the frontier. */
  hostEffects: HostEffectBrief[];
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
  allowedMoves: ActionMove[];
};

/** Terminal action-stage output. It cannot be submitted to `Runtime.progress`. */
export type TerminalBrief = {
  /** Full persisted traversal state after terminal settlement. */
  traversals: ArcTraversalSet;
  /** Discriminator for terminal action output. */
  canProgress: false;
  /** Registered root whose action stage produced this result. */
  root: ArcRef;
  /** Terminal outcome of the action root. */
  outcome: "covered" | "deflected" | "poisoned";
  /** Committed root returns, present only for a covered root that declares them. */
  returns?: Record<string, CellValue>;
  /** Structured issues carried by terminal settlement. */
  issues: RuntimeIssue[];
};

/**
 * Outcome for one observation reported back by the host.
 *
 * - `resolved`: a value was inferred and may be committed into traversal state
 * - `unknown`: no value could be inferred this turn; for `$observe()` this
 *   consumes the action without writing a new value, while `$observeOrAsk()`
 *   remains pending
 * - `needs-user`: the host determined the user must be asked; this is intended
 *   for `$observeOrAsk()` and leaves the action pending
 */
export type ObservationReport = {
  status: "resolved" | "unknown" | "needs-user";
  value?: PrimitiveValue | PrimitiveArrayValue;
};

/**
 * Outcome for one grouped observation reported back by the host. It must carry
 * an entry for every field in the brief; a report that omits a field is invalid
 * and re-emits the group.
 *
 * Per field: `resolved` writes the value; `unknown` skips the field, leaving its
 * cell unchanged; `needs-user` (observeOrAsk only) leaves the whole group
 * pending. The group commits — writing all `resolved` fields together and
 * advancing past the action — only when no field is `needs-user`.
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

/**
 * Outcome for one host effect reported back by the host.
 *
 * `applied` acknowledges that the emitted effect was handled. There is no
 * per-effect failure status: a host that cannot accept an emitted effect
 * rejects the frontier with `move: "poison"` instead.
 */
export type HostEffectReport = {
  status: "applied";
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
  hostCalls?: Record<BriefId, PayloadValue>;
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
  poisonReason?: ActionPoisonReason;
  instructions?: Record<BriefId, InstructionReport>;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
  hostEffects?: Record<BriefId, HostEffectReport>;
};
