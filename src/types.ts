/**
 * Scalar values runtime expressions can reduce to without host work.
 */
export type PrimitiveValue = string | number | boolean;

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

// Source / IR Types

/**
 * Locally-resolved (no host involvement) expressions.
 */
export type LocalExpression =
  | { kind: "literal"; value: PrimitiveValue | null }
  | { kind: "ref"; name: "user" | "self" }
  | { kind: "variable"; name: string }
  | { kind: "scope"; name: "lastUserMessage" | "lastTurns"; count?: number }
  | { kind: "enterCount" }
  | { kind: "nodeState"; node: string };

/** Semantic boolean check that may suspend on the brief/report boundary. */
export type JudgeExpression = {
  id: number;
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
  id: number;
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
  id: number;
  kind: "observe";
  variable: string;
  question?: SemanticString;
  loc?: SourceRange;
};

/** Observation with fallback to asking the user. */
export type ObserveOrAskAction = {
  id: number;
  kind: "observeOrAsk";
  variable: string;
  question?: SemanticString;
  loc?: SourceRange;
};

/** Deterministic variable write without host semantic work. */
export type SetAction = {
  id: number;
  kind: "set";
  variable: string;
  value: ValueExpression;
  loc?: SourceRange;
};

/**
 * Enter a child node or imported arc from the current action graph.
 *
 * `node` is a structural reference name resolved from a local declaration or
 * import binding, not a display label.
 */
export type EnterNodeAction = {
  id: number;
  kind: "enter-node";
  node: string;
  imported: boolean;
  loc?: SourceRange;
};

/**
 * Bare template literal in the action graph.
 */
export type InstructionAction = {
  id: number;
  kind: "instruction";
  template: SemanticString;
  loc?: SourceRange;
};

/** Any executable action statement in a node body. */
export type ActionStatement =
  | ObserveAction
  | ObserveOrAskAction
  | SetAction
  | EnterNodeAction
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

/** Statement subset allowed inside `this.trigger`. */
export type TriggerStatement =
  | ObserveAction
  | TriggerIfStatement
  | { kind: "return"; value?: ValueExpression; loc?: SourceRange };

/** Conditional inside trigger functions. */
export type TriggerIfStatement = {
  kind: "if";
  test: ValueExpression;
  consequent: TriggerStatement[];
  alternate?: TriggerStatement[];
  loc?: SourceRange;
};

/** Statement subset allowed inside `this.guard`. */
export type GuardStatement =
  | ObserveAction
  | GuardIfStatement
  | { kind: "return"; value?: ValueExpression; loc?: SourceRange };

/** Conditional inside guard functions. */
export type GuardIfStatement = {
  kind: "if";
  test: ValueExpression;
  consequent: GuardStatement[];
  alternate?: GuardStatement[];
  loc?: SourceRange;
};

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
  id: number;
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
  | HostEffectStatement
  | EffectIfStatement;

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
  imports: string[];
  trigger?: TriggerStatement[];
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
  resolved: true;
};

/**
 * Per-node traversal bookkeeping.
 *
 * Frames are persisted only for resumable nodes. Each frame stores which
 * authored actions inside the node have already resolved, keyed by the stable
 * parser-assigned action id.
 */
export type NodeFrame = {
  actionStates: Record<number, ActionState | undefined>;
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
  /** Variable values declared by this node only. */
  variables: Record<string, PrimitiveValue | undefined>;
  /** Per-action resolution state for this node only. */
  frame: NodeFrame;
  /** Inline persisted traversals for owned nested child nodes. */
  ownedChildren: NodeTraversal[];
  /** Referenced/imported arcs managed elsewhere in the traversal set. */
  refChildren: ArcRef[];
  /** Idempotency keys for host effects already emitted from this traversal. */
  appliedHostCallKeys: string[];
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
 */
export type ArcTraversal = TraversalBase<ArcRef> & {
  returnTo: ArcRef | null;
  phase: "dormant" | "entered" | "completed" | "suspended";
  pendingEffects?: PendingEffects;
};

/** Deferred effect finalization that must complete before an arc stops. */
export type PendingEffects = {
  reason: "deflected";
  active: NodeRef;
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
 * `arc` identifies which registered arc requested this judgment. Trigger briefs
 * may contain judgments from multiple arcs at once.
 */
export type JudgmentBrief = {
  id: BriefId;
  arc: ArcRef;
  node: string;
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
 * `arc` identifies which registered arc requested this observation.
 */
export type ObservationBrief = {
  id: BriefId;
  arc: ArcRef;
  node: string;
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
 * Instruction text that the host may weave into the companion response.
 *
 * This is not a provider prompt. It is authored guidance surfaced in a
 * structured form so another system can decide whether and how to present it.
 *
 * `arc` identifies which registered arc emitted this instruction.
 */
export type InstructionBrief = {
  id: BriefId;
  arc: ArcRef;
  node: string;
  statementIndex: number;
  text: string;
};

/**
 * A host-backed value request emitted from an expression frontier.
 *
 * The runtime is blocked until the host reports a value for this call id.
 */
export type HostCallBrief = {
  id: BriefId;
  arc: ArcRef;
  node: string;
  module: string;
  target: string[];
  operation: string;
  arguments: PayloadValue[];
};

/**
 * Trigger brief report returned by the host.
 *
 * `match` names the selected arc, if any. Judgments and observations are keyed
 * by ids from the originating `TriggerBrief`.
 */
export type TriggerReport = {
  match?: ArcRef;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
};

/**
 * Trigger runtime outcome after accepting a trigger report.
 *
 * `traversals` is the next persisted traversal set. When a trigger matched,
 * `matched` identifies the arc ready for normal action-brief probing. Look up
 * the traversal from `traversals` by ref if needed.
 */
export type TriggerOutcome = {
  matched?: ArcRef;
  traversals: ArcTraversalSet;
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
 */
export type TriggerBrief = {
  judgments: JudgmentBrief[];
  observations: ObservationBrief[];
  hostCalls: HostCallBrief[];
  matchableArcs: ArcRef[];
};

/**
 * Allowed high-level moves for one action brief.
 *
 * - `proceed`: report semantic results and continue traversal
 * - `defer`: leave traversal unchanged for this turn
 * - `deflect`: mark the active node as intentionally deflected
 */
export type ActionMove = "proceed" | "defer" | "deflect";

/**
 * Structured brief issued by arc traversal when delegation is needed.
 *
 * The host reads this brief, chooses one of `allowedMoves`, then
 * reports back an `ActionReport` through `Runtime.progress(...)`.
 *
 * Unlike `Traversal`, this brief is ephemeral. It is bound to the exact
 * document/traversal-set/context snapshot used to build it.
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
 * `blockedBy` points at the guard or statement frontier that prevented local
 * deterministic execution from advancing further before delegation.
 */
export type ActionBrief = {
  /** Full persisted traversal state to save after this yield. */
  traversals: ArcTraversalSet;
  /** The traversal inside `traversals` that this brief/report is about. */
  active: NodeRef;
  /** Whether the root traversal for this brief can still advance. */
  canProgress: boolean;
  /** Pending host-backed value requests produced before this yield. */
  hostCalls: HostCallBrief[];
  /** Append-only host effects produced before this yield. */
  hostEffects: HostEffect[];
  blockedBy?:
    | { kind: "guard"; arc: ArcRef; node: string }
    | {
        kind: "statement";
        arc: ArcRef;
        node: string;
        statementIndex: number;
        statementKind: Statement["kind"];
      };
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
 * report against the originating brief snapshot.
 */
export type ActionReport = {
  move: ActionMove;
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
};
