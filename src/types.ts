/**
 * Scalar values runtime expressions can reduce to without host work.
 */
export type PrimitiveValue = string | number | boolean;

/** Stable parser-assigned statement/expression id, unique within its containing node. */
export type StatementId = number;

/** 1-based source position retained for parser diagnostics. */
export type SourcePosition = {
  line: number;
  column: number;
};

/** Source span retained on parsed nodes for author-facing errors. */
export type SourceRange = {
  start: SourcePosition;
  end: SourcePosition;
};

/** Parser/validator issue tied to authored Arc source. */
export type ValidationIssue = {
  code: string;
  message: string;
  loc?: SourceRange;
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

// Source / IR Types

/**
 * Locally-resolved (no host involvement) expressions.
 */
export type LocalExpression =
  | { kind: "literal"; value: PrimitiveValue | null }
  | { kind: "ref"; name: "user" | "self" }
  | { kind: "variable"; name: string }
  | { kind: "channel"; namespace: "args" | "returns"; key: string }
  | { kind: "deflectionFrom"; target: EnterTarget }
  | { kind: "scope"; name: "lastUserMessage" | "lastTurns"; count?: number }
  | { kind: "enterCount" }
  | { kind: "nodeState"; identifier: string };

/** Semantic boolean check that may suspend on the brief/report boundary. */
export type JudgeExpression = {
  id: StatementId;
  kind: "judge";
  question: SemanticString;
  loc?: SourceRange;
};

/** Structured argument shape accepted by authored host calls and effects. */
export type HostCallArgument =
  | { kind: "semantic"; value: SemanticString }
  | { kind: "value"; value: ValueExpression }
  | { kind: "array"; value: HostCallArgument[] }
  | { kind: "object"; value: Record<string, HostCallArgument> };

/** Host-backed value lookup that may suspend on the brief/report boundary. */
export type HostCallExpression = {
  id: StatementId;
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
  arguments: HostCallArgument[];
  loc?: SourceRange;
};

/** Binary operators allowed. */
export type BinaryOperator =
  | "=="
  | "==="
  | "!="
  | "!=="
  | ">"
  | ">="
  | "<"
  | "<=";

/** Expression forms whose evaluation may yield a brief. */
export type BriefableExpression = JudgeExpression | HostCallExpression;

/**
 * Full recursive expression grammar for Arc value positions.
 *
 * Every Arc expression currently evaluates to a value, though some forms may
 * suspend while waiting for host-reported results.
 */
export type ValueExpression =
  | LocalExpression
  | BriefableExpression
  | {
      kind: "regexTest";
      pattern: string;
      flags: string;
      target: LocalExpression;
    }
  | {
      kind: "binary";
      op: BinaryOperator;
      left: ValueExpression;
      right: ValueExpression;
    }
  | {
      kind: "logical";
      op: "&&" | "||";
      left: ValueExpression;
      right: ValueExpression;
    }
  | { kind: "unary"; op: "!"; argument: ValueExpression };

/** One segment inside a parsed template literal. */
export type SemanticPart =
  | { kind: "text"; value: string }
  | { kind: "expression"; expression: ValueExpression };

/**
 * Parsed template literal content used for semantic guidance and instructions.
 */
export type SemanticString = {
  kind: "semantic-string";
  parts: SemanticPart[];
  loc?: SourceRange;
};

/**
 * Variable declaration visible in the lexical scope of a node.
 * `observing` is the default question text for `observe(...)` and `observeOrAsk(...)`.
 */
export type Variable = {
  name: string;
  type: "enum" | "boolean" | "rangedInt";
  values?: string[];
  min?: number;
  max?: number;
  observing?: SemanticString;
  loc?: SourceRange;
};

/** Passive semantic observation. */
export type ObserveAction = {
  id: StatementId;
  kind: "observe";
  variable: string;
  question?: SemanticString;
  loc?: SourceRange;
};

/** Observation with fallback to asking the user. */
export type ObserveOrAskAction = {
  id: StatementId;
  kind: "observeOrAsk";
  variable: string;
  question?: SemanticString;
  loc?: SourceRange;
};

/** Deterministic variable write without host semantic work. */
export type SetAction = {
  id: StatementId;
  kind: "set";
  variable: string;
  value: ValueExpression;
  loc?: SourceRange;
};

/** Staged write into a caller-bound return channel. */
export type SetReturnAction = {
  id: StatementId;
  kind: "set-return";
  key: string;
  value: ValueExpression;
  loc?: SourceRange;
};

/**
 * Enter-call channel binding map.
 * key: child channel key.
 * value: caller lexical variable name.
 *
 * Current parser/runtime constraint: key and value must be identical
 * (same-name binding only), for example `{ report: "report" }`.
 *
 * This map shape is intentionally retained to allow a future relaxation to
 * renamed bindings without changing the IR type.
 */
export type EnterChannelBindings = Record<string, string>;

/** Control-transfer target referenced by `enter(...)` / `enterLoop(...)`. */
export type EnterTarget = {
  identifier: string;
  imported: boolean;
  fresh: boolean;
  reopen: boolean;
};

/**
 * Enter a child node or imported arc from the current action graph.
 *
 * `node` is a structural reference name resolved from a local declaration or
 * import binding, not a display label.
 */
export type EnterNodeAction = {
  id: StatementId;
  kind: "enter-node";
  target: EnterTarget;
  /**
   * Args channel bindings.
   * key: child-side args channel key (`args.<key>`).
   * value: caller lexical variable name to bind.
   */
  args?: EnterChannelBindings;
  /**
   * Returns channel bindings.
   * key: child-side returns channel key (`returns.<key>.set(...)`).
   * value: caller lexical variable name to bind.
   */
  returns?: EnterChannelBindings;
  loc?: SourceRange;
};

/** Repeated enter action with caller-authored loop resolution. */
export type EnterLoopAction = {
  id: StatementId;
  kind: "enter-loop";
  target: EnterTarget;
  resolveWhen: ResolutionStatement[];
  args?: EnterChannelBindings;
  returns?: EnterChannelBindings;
  loc?: SourceRange;
};

/** Authored instruction emitted from the action graph. */
export type InstructionAction = {
  id: StatementId;
  kind: "instruction";
  mode: "once" | "persistent";
  template: SemanticString;
  resolveWhen?: ResolutionStatement[];
  deflectWhen?: ResolutionStatement[];
  loc?: SourceRange;
};

/** Any executable action statement in a node body. */
export type ActionStatement =
  | ObserveAction
  | ObserveOrAskAction
  | SetAction
  | SetReturnAction
  | EnterNodeAction
  | EnterLoopAction
  | InstructionAction;

/** Control-flow statement in the action graph. */
export type IfStatement = {
  kind: "if";
  test: ValueExpression;
  consequent: Statement[];
  alternate?: Statement[];
  loc?: SourceRange;
};

/** Labeled block in the action graph. */
export type LabelStatement = {
  kind: "label";
  label: string;
  body: Statement[];
  loc?: SourceRange;
};

/** Labeled break in the action graph. */
export type BreakStatement = {
  kind: "break";
  label: string;
  loc?: SourceRange;
};

/** Top-level executable statement inside a node action graph. */
export type Statement =
  | ActionStatement
  | IfStatement
  | LabelStatement
  | BreakStatement;

/** Statement subset allowed inside boolean-style hooks. */
export type HookStatement =
  | ObserveAction
  | SetAction
  | HookIfStatement
  | HookLabelStatement
  | HookBreakStatement
  | HookReturnStatement;

/** Statement subset allowed inside `this.trigger`. */
export type TriggerStatement = HookStatement;

/**
 * Instruction resolution logic uses the same constrained statement subset as
 * `this.trigger`.
 */
export type ResolutionStatement = TriggerStatement;

/** Conditional inside trigger functions. */
export type HookIfStatement = {
  kind: "if";
  test: ValueExpression;
  consequent: HookStatement[];
  alternate?: HookStatement[];
  loc?: SourceRange;
};

/** Statement subset allowed inside `this.guard`. */
export type GuardStatement = HookStatement;

/** Labeled block inside hook functions. */
export type HookLabelStatement = {
  kind: "label";
  label: string;
  body: HookStatement[];
  loc?: SourceRange;
};

/** Labeled break inside hook functions. */
export type HookBreakStatement = {
  kind: "break";
  label: string;
  loc?: SourceRange;
};

/** Return statement inside hook functions. */
export type HookReturnStatement = {
  kind: "return";
  value?: ValueExpression;
  loc?: SourceRange;
};

/** Statement subset allowed inside `this.catchDeflection`. */
export type CatchDeflectionStatement = HookStatement;

/** Host module imported by an Arc document. */
export type HostModuleBinding = {
  module: string;
  localName: string;
  importedName: string;
  source: string;
  loc?: SourceRange;
};

/** Non-blocking host invocation emitted from `this.effects`. */
export type HostEffectStatement = {
  id: StatementId;
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
  arguments: HostCallArgument[];
  loc?: SourceRange;
};

/** Conditional inside `this.effects`. */
export type EffectIfStatement = {
  kind: "if";
  test: ValueExpression;
  consequent: EffectStatement[];
  alternate?: EffectStatement[];
  loc?: SourceRange;
};

/** Statement subset allowed in `this.effects`. */
export type EffectStatement =
  | ObserveAction
  | SetAction
  | SetReturnAction
  | HostEffectStatement
  | EffectIfStatement
  | EffectLabelStatement
  | EffectBreakStatement;

/** Labeled block inside `this.effects`. */
export type EffectLabelStatement = {
  kind: "label";
  label: string;
  body: EffectStatement[];
  loc?: SourceRange;
};

/** Labeled break inside `this.effects`. */
export type EffectBreakStatement = {
  kind: "break";
  label: string;
  loc?: SourceRange;
};

/** Synthetic alias used only for `fresh(...)` pseudo-child definition lookup. */
export type FreshNodeAlias = {
  identifier: string;
  target: string;
  imported: boolean;
};

/**
 * Parsed node definition.
 *
 * `identifier` is the canonical structural identity derived from the JS
 * function declaration name. It is used for references like `enter(X)` and
 * `X.state`.
 *
 * `displayName` is optional human-facing metadata and is not used for lookup.
 */
export type Node = {
  identifier: string;
  displayName?: string;
  description?: string;
  guidance?: SemanticString;
  resumable: boolean;
  variables: Variable[];
  statements: Statement[];
  children: Node[];
  freshAliases: FreshNodeAlias[];
  imports: string[];
  trigger?: TriggerStatement[];
  deflectWhen?: ResolutionStatement[];
  catchDeflection?: CatchDeflectionStatement[];
  guard?: GuardStatement[];
  effects?: EffectStatement[];
  loc?: SourceRange;
};

/**
 * Parsed document with import metadata and one or more arcs.
 *
 * Each top-level function declaration is an arc candidate. Nested function
 * declarations remain child nodes of their containing root or node.
 *
 * Imports track both the root structural identifier (`importedName`) and
 * the local binding used inside the current document (`localName`).
 */
export type Document = {
  version: "v2";
  imports: Array<{
    importedName: string;
    localName: string;
    source: string;
    loc?: SourceRange;
  }>;
  hostModules: HostModuleBinding[];
  roots: Node[];
};

// Runtime API Types

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
 * expressions.
 *
 * These are authored node outcomes, not internal bookkeeping labels:
 * - `covered`: the node completed successfully
 * - `deflected`: the host reported an intentional decline or redirection
 * - `skipped`: the node was bypassed by an explicit guard outcome
 */
export type NodeState = "covered" | "deflected" | "skipped";

/**
 * Per-action resolution state stored inside one resumable node frame.
 *
 * Missing action state means "unresolved". Resolved actions are skipped when
 * traversal re-walks the action graph from the top.
 */
export type ActionState = {
  kind: ActionStatement["kind"] | HostEffectStatement["kind"];
  status: "pending" | "resolved";
  // Temporary enterLoop-specific state tracking. These fields currently let
  // the loop action persist transactional return candidates and its pending
  // step across handbacks. A later refactor may give enterLoop its own frame
  // instead of storing this on generic ActionState.
  stagedReturns?: Record<string, PrimitiveValue>;
  enterLoopPhase?: "target" | "resolveWhen";
};

/**
 * Per-node traversal bookkeeping.
 *
 * Frames are persisted only for resumable nodes. Each frame stores which
 * authored actions inside the node have already resolved, keyed by the stable
 * parser-assigned action id.
 */
export type NodeFrame = {
  actionStates: Record<StatementId, ActionState | undefined>;
  evaluatorActionStates: Record<
    string,
    Record<StatementId, ActionState | undefined> | undefined
  >;
};

/** Reference to a caller variable in an `enter` channel. */
export type CallerVarRef = {
  ownerRef: NodeRef;
  variable: string;
};

/** `enter(..., { args, returns })` channel data for one traversal. */
export type EnterChannelState = {
  /** key: args channel key. */
  args: Record<string, CallerVarRef>;
  /** key: returns channel key. */
  returns: Record<string, CallerVarRef>;
  /** key: returns channel key. */
  stagedReturns: Record<string, PrimitiveValue>;
};

export type TraversalFinalizing = {
  reason: "covered" | "deflected";
  active: NodeRef;
  phase: "catch" | "effects";
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
  /** Variable values declared by this node only. */
  variables: Record<string, PrimitiveValue | undefined>;
  /** Per-action resolution state for this node only. */
  frame: NodeFrame;
  /** Inline persisted traversals for owned nested child nodes. */
  ownedChildren: NodeTraversal[];
  /** Ephemeral fresh traversals owned by specific action sites. */
  ephemeralChildren: NodeTraversal[];
  /** Referenced/imported arcs managed elsewhere in the traversal set. */
  refChildren: ArcRef[];
  /** Idempotency keys for host effects already emitted from this traversal. */
  appliedHostCallKeys: string[];
  /** Enter-time channels set by `enter(..., { args, returns })`. */
  enterChannels: EnterChannelState;
};

/** Persisted runtime state for an owned nested node. */
export type NodeTraversal = TraversalBase<NodeRef>;

/**
 * Persisted runtime state for an arc.
 *
 * `returnTo` is a dynamic control-flow pointer for referenced arc calls. It
 * does not grant lexical variable access. `null` means there is no caller.
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
  returnTo: ArcRef | null;
  phase: "dormant" | "entered" | "completed" | "suspended" | "poisoned";
};

export type Traversal = ArcTraversal | NodeTraversal;

/**
 * The full persisted runtime state for action progression.
 *
 * Trigger probing and action progression both read and return traversal sets so
 * fresh `Runtime` instances can reconstruct execution without hidden in-memory
 * continuation state.
 */
export type ArcTraversalSet = ArcTraversal[];

/** A single conversation turn with role attribution. */
export type DialogTurn = {
  role: "self" | "user";
  message: string;
};

/**
 * Conversation history visible to traversal during trigger probing and action
 * progression. `Dialog.lastUserMessage` is derived from `lastTurns` by the
 * runtime. It is provided by the caller each turn and is not persisted inside
 * `Traversal`.
 */
export type Dialog = {
  lastTurns: DialogTurn[];
  names?: { self?: string; user?: string };
};

/** Fully rendered payload value passed across the runtime boundary. */
export type PayloadValue =
  | PrimitiveValue
  | null
  | undefined
  | PayloadValue[]
  | { [key: string]: PayloadValue };

/** Rendered host effect payload ready for host handling. */
export type HostEffect = {
  module: string;
  target: string[];
  operation: string;
  arguments: PayloadValue[];
};

/**
 * Opaque id for one semantic work item in a brief.
 *
 * A `BriefId` is stable only within the originating brief snapshot. Hosts
 * echo it back in the matching report. It is not a durable persistence
 * key and callers must not parse it for runtime meaning.
 */
export type BriefId = string;

/**
 * A semantic boolean judgment the host may resolve for this turn.
 *
 * `sourceRef` identifies the source node that requested this judgment.
 */
export type JudgmentBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  question: string;
};

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
 */
export type ObservationBrief = {
  id: BriefId;
  sourceRef: NodeRef;
  variable: string;
  mode: "observe" | "observeOrAsk";
  question: string;
  currentValue?: PrimitiveValue;
  meta: {
    type: Variable["type"];
    values?: string[];
    min?: number;
    max?: number;
  };
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
  text: string;
  postcheck?: InstructionPostcheck;
};

export type InstructionPostcheck = {
  judgmentIds: BriefId[];
  observationIds: BriefId[];
  hostCallIds: BriefId[];
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
  arguments: PayloadValue[];
};

/**
 * Trigger brief report returned by the host.
 *
 * `preferredMatch` expresses the host's preferred arc when multiple trigger
 * candidates may eventually match. Judgments and observations are keyed by ids
 * from the originating `TriggerBrief`.
 */
export type TriggerReport = {
  preferredMatch?: ArcRef;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
};

/**
 * Multi-arc trigger brief for the current traversal probe.
 *
 * Trigger probing stays separate from normal action-brief probing because trigger
 * evaluation may perform `observe(...)` / `judge(...)` work before any arc is
 * admitted into the main traversal loop.
 *
 * `matchableArcs` contains arcs whose triggers already evaluate true under the
 * currently known state, before any additional host reports are
 * accepted.
 *
 * `matched` identifies the selected arc once trigger stage has resolved to a
 * single activation.
 *
 * Hosts may inspect this object freely, but must treat it as immutable and
 * pass the same object instance back to `Runtime.progressTrigger(...)`.
 */
export type TriggerBrief = {
  matched?: ArcRef;
  traversals: ArcTraversalSet;
  issues: RuntimeIssue[];
  judgments: JudgmentBrief[];
  observations: ObservationBrief[];
  hostCalls: HostCallBrief[];
  matchableArcs: ArcRef[];
};

/**
 * Allowed high-level moves for one action brief.
 *
 * - `proceed`: report semantic results and continue traversal
 * - `deflect`: mark the active node as intentionally deflected. This move is
 *   only available when `allowedMoves` includes it for the current frontier.
 */
export type ActionMove = "proceed" | "deflect";

/**
 * Structured brief issued by arc traversal when delegation is needed.
 *
 * The host reads this brief, chooses one of `allowedMoves`, then
 * reports back an `ActionReport` through `Runtime.progress(...)`.
 *
 * Unlike `Traversal`, this brief is ephemeral. It is bound to the exact
 * document/traversal-set snapshot used to build it. Hosts may later call
 * `Runtime.progress(...)` with a newer dialog.
 *
 * `traversals` is the full persisted state the caller should save after this
 * yield. `active` identifies which traversal inside that set currently owns the
 * frontier described by the brief. `active` is derived and does not need to be
 * persisted separately.
 *
 * `canProgress` answers the host control-flow question directly:
 * - `true`: calling `Runtime.progress(...)` may advance this root further
 * - `false`: this root has stopped for now
 *
 * Hosts may inspect this object freely, but must treat it as immutable and
 * pass the same object instance back to `Runtime.progress(...)`.
 */
export type ActionBrief = {
  /** Full persisted traversal state to save after this yield. */
  traversals: ArcTraversalSet;
  /** The traversal inside `traversals` that this brief/report is about. */
  active: NodeRef;
  /** Whether the root traversal for this brief can still advance. */
  canProgress: boolean;
  /** Protocol or authored-execution issues surfaced after the previous yield. */
  issues: RuntimeIssue[];
  /** Pending host-backed value requests produced before this yield. */
  hostCalls: HostCallBrief[];
  /** Append-only host effects produced before this yield. */
  hostEffects: HostEffect[];
  judgments: JudgmentBrief[];
  observations: ObservationBrief[];
  instructions: InstructionBrief[];
  allowedMoves: ActionMove[];
};

/**
 * Outcome for one observation reported back by the host.
 *
 * - `resolved`: a value was inferred and may be committed into traversal state
 * - `unknown`: no value could be inferred this turn; for `observe()` this
 *   consumes the action without writing a new value, while `observeOrAsk()`
 *   remains pending
 * - `needs-user`: the host determined the user must be asked; this is intended
 *   for `observeOrAsk()` and leaves the action pending
 */
export type ObservationReport = {
  status: "resolved" | "unknown" | "needs-user";
  value?: PrimitiveValue;
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
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
};
