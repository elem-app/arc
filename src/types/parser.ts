/**
 * Arc's public structural IR, its structural identities, and the result types
 * produced by document analysis.
 */

import {
  isObservableCellSpec,
  isSettableCellSpec,
  type ArtifactArraySpec,
  type ArtifactSpec,
  type ChannelSpec,
  type DialogCursorSpec,
  type HostModuleSpec,
} from "./spec.js";
import type { PayloadValue, PrimitiveValue } from "./value.js";

/**
 * Structural element id: the element's position within its SEG scope, prefixed
 * by the scope's owner chain. Derived from document shape by `stampElementIds`;
 * there is no allocator. Node-relative (every node has a `body/0`); anything
 * crossing nodes pairs the id with a `NodeRef`.
 *
 * Grammar: a scope prefix (`body`, `guard`, `effects`, `trigger`, `catch`,
 * `deflectWhen`, an owner id + `/resolveWhen`/`/deflectWhen`, or an invoke's
 * own id), then `/`-separated steps — a step is a sibling index with a branch
 * tag (`c` consequent, `a` alternate, `l` label body) on every non-terminal
 * step — and an optional `~n` suffix numbering briefable expressions within
 * the statement. Examples: `body/0c/1`, `guard/0`, `body/2/0` (invoke body),
 * `body/3/resolveWhen/0`, `body/0~0`. The alphabet excludes `.` `:` `[` `]`
 * `#` so ids embed safely in refs and brief ids. Consumers never parse ids;
 * `qualifiedBriefSite` is the only manipulation.
 */
export type ElementId = string & { readonly __elementId: unique symbol };

/** Internal sentinel placed on IR before `stampElementIds` assigns final ids. */
export const UNSTAMPED_ID = "" as ElementId;

/**
 * Flattened string key for one SEG consultation instance on a node frame —
 * keys `evaluatorActionStates` and `pinTapes`. Built by the runtime SEG-key
 * constructors from the live statement the walk is standing at or, for
 * catch-deflection, from a `DeflectionContext` (one-way, struct → string; never
 * parsed back). Equal to the authored scope id for every scope except
 * catch-deflection, which embeds the runtime origin/from refs so a different
 * deflection opens a fresh consultation.
 *
 * A key is never derived from a `SegId`: `SegId` routes resume structurally,
 * and a walk that needs a key already holds the statement it is built from.
 */
export type SegKey = string & { readonly __segKey: unique symbol };

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

/** Document-validation issue, optionally tied to an authored source range. */
export type ValidationIssue = {
  code: string;
  message: string;
  loc?: SourceRange;
};

/**
 * Static lint issue derived from coherent Arc IR. Severity runs
 * `notice` through `warning` to `error`, which marks a construct that cannot
 * behave coherently.
 */
export type LintIssue = {
  code: string;
  severity: "notice" | "warning" | "error";
  message: string;
  loc?: SourceRange;
};

/** The two typed channel namespaces a node body can read and write. */
export type ChannelNamespace = "args" | "returns";

/**
 * A node's typed channel signature: the `args` it reads and the `returns` it
 * writes, each a map from channel key to its schema. Carried on
 * `Node.signature`, so it travels with the parsed `Document`.
 */
export type NodeSignature = {
  args: Record<string, ChannelSpec>;
  returns: Record<string, ChannelSpec>;
};

/**
 * The source an `$enter(...)` channel key binds to. Discriminated so every
 * binding-resolution site handles each source exhaustively:
 *
 * - `cell` — a caller lexical cell, the ordinary binding.
 * - `argsProjection` — the caller forwards one of its own typed `args.*`
 *   channels into the child, resolved through the caller's own link to the
 *   underlying caller cell.
 * - `span` — a member of the owner's `span` namespace. In a `$map` callback the
 *   `map` owner supplies `item`, `index`, and `result`.
 */
export type EnterChannelBindingSource =
  | { kind: "cell"; cell: string }
  | { kind: "argsProjection"; key: string }
  | { kind: "span"; owner: "map"; key: "item" | "index" | "result" };

/**
 * Enter-call channel binding map.
 * key: child channel key.
 * value: the source that key binds to.
 *
 * A shorthand authored entry (`{ report }`) binds a child key to the
 * same-named caller cell; a renamed entry (`{ inputReport: report }`) binds
 * the child key to a differently named caller cell. Within one `returns` map,
 * each caller cell may be bound to at most one key.
 */
export type EnterChannelBindings = Record<string, EnterChannelBindingSource>;

/** Control-transfer target referenced by `$enter(...)` / `$enterLoop(...)`. */
export type EnterTarget = {
  identifier: string;
  imported: boolean;
  mode: "canonical" | "forgetful" | "newcopy";
};

/** Boolean-producing comparison operators allowed in Arc source. */
export type ComparisonOperator = "==" | "!=" | ">" | ">=" | "<" | "<=";

/** Numeric binary operators allowed in Arc source. */
export type ArithmeticOperator = "+" | "-" | "*" | "/" | "%";

/** A binary numeric expression at either the local or general value stratum. */
export interface ArithmeticExpression<TExpression> {
  kind: "arithmetic";
  op: ArithmeticOperator;
  left: TExpression;
  right: TExpression;
}

/** A numeric negation expression at either expression stratum. */
export interface NumericUnaryExpression<TExpression> {
  kind: "numericUnary";
  op: "-";
  argument: TExpression;
}

/** The boolean predicate produced by authored `Num.isFinite(...)`. */
export type NumIsFiniteExpression = {
  kind: "numIsFinite";
  argument: ValueExpression;
};

/** A literal value written in an expression position. */
export type LiteralExpression = {
  kind: "literal";
  value: PrimitiveValue | null;
};

/**
 * A literal restricted to strings, for the positions that accept only text.
 * Narrows `LiteralExpression`, so it carries the same `kind`.
 */
export type StringLiteralExpression = { kind: "literal"; value: string };

/**
 * Reference to the array-valued cell or channel an element or length read
 * targets. The receiver of a bracket index / `length` read is always a direct
 * cell or channel reference.
 */
export type ArrayReference =
  | { kind: "cell"; name: string }
  | { kind: "channel"; namespace: ChannelNamespace; key: string };

/** Expressions the runtime resolves locally. */
export type LocalExpression =
  | LiteralExpression
  | { kind: "cell"; name: string }
  | { kind: "isUnset"; cell: string }
  | { kind: "channel"; namespace: ChannelNamespace; key: string }
  | { kind: "channelIsUnset"; namespace: ChannelNamespace; key: string }
  | { kind: "arrayElementRead"; array: ArrayReference; index: LocalExpression }
  | { kind: "arrayLength"; array: ArrayReference }
  | { kind: "span"; owner: "map"; key: "item" | "index" }
  | { kind: "deflectionEscaped"; target: EnterTarget }
  | { kind: "dialogCursor" }
  | {
      kind: "dialogTurnsSince";
      metric: "user" | "self" | "total";
      receiver: LocalExpression;
      baseline: LocalExpression;
    }
  | { kind: "scope"; name: "lastUserMessage" | "lastTurns"; count?: number }
  | { kind: "enterCount" }
  | { kind: "pendingState" }
  | { kind: "nodeState"; identifier: string }
  | ArithmeticExpression<LocalExpression>
  | NumericUnaryExpression<LocalExpression>;

/**
 * A lexical cell root plus zero or more evaluated accesses into its inner value.
 *
 * The root is a statically named cell. Each accessor is evaluated locally when
 * the action reaches the target, so `items[index]` is represented as
 * `["items", { kind: "cell", name: "index" }]`.
 */
export type CellTarget = [root: string, ...accessors: LocalExpression[]];

/** One segment inside a parsed value-position template literal. */
export type ValueStringPart =
  | { kind: "text"; value: string }
  | { kind: "expression"; expression: ValueExpression };

/** Template literal accepted in value positions. */
export type ValueString = {
  kind: "template-string";
  parts: ValueStringPart[];
};

/** Any segment inside a parsed template literal before use-site restriction. */
export type TemplateStringPart =
  | ValueStringPart
  | { kind: "ref"; name: "user" | "self" }
  | { kind: "hostVar"; module: string; path: string[] };

/** Parsed template literal before use-site restriction. */
export type TemplateString = {
  kind: "template-string";
  parts: TemplateStringPart[];
};

/** String accepted in semantic positions. */
export type SemanticString = StringLiteralExpression | TemplateString;

/** Semantic boolean check that may suspend on the brief/report boundary. */
export type JudgeExpression = {
  id: ElementId;
  kind: "judge";
  question: SemanticString;
  loc?: SourceRange;
};

/** Structured argument shape accepted by authored host calls. */
export type HostCallArgument =
  | { kind: "semantic"; value: SemanticString }
  | { kind: "value"; value: ValueExpression }
  | { kind: "array"; elements: HostCallArgument[] }
  | { kind: "object"; value: Record<string, HostCallArgument> };

/** Host-backed operation consumed either as a value or a resolved-once action. */
export type HostCall = {
  id: ElementId;
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
  arguments: HostCallArgument[];
  loc?: SourceRange;
};

/** Constructs one exact Artifact value at the expression's evaluation site. */
export type ArtifactConstructExpression = {
  kind: "artifact";
  path: ValueExpression;
};

/**
 * Full recursive expression grammar for Arc value positions.
 *
 * Every form evaluates to a value or unset. Direct judge and host-call leaves,
 * and any compound expression containing them, may suspend until the host
 * reports.
 */
export type ValueExpression =
  | LocalExpression
  | JudgeExpression
  | HostCall
  | ArtifactConstructExpression
  | ValueString
  | { kind: "arrayLiteral"; elements: ValueExpression[] }
  | {
      kind: "regexTest";
      pattern: string;
      flags: string;
      target: LocalExpression;
    }
  | {
      kind: "comparison";
      op: ComparisonOperator;
      left: ValueExpression;
      right: ValueExpression;
    }
  | ArithmeticExpression<ValueExpression>
  | NumericUnaryExpression<ValueExpression>
  | NumIsFiniteExpression
  | {
      kind: "logical";
      op: "&&" | "||";
      left: ValueExpression;
      right: ValueExpression;
    }
  | {
      kind: "conditional";
      test: ValueExpression;
      consequent: ValueExpression;
      alternate: ValueExpression;
    }
  | { kind: "unary"; op: "!"; argument: ValueExpression };

/** Numeric constraints applied only when accepting an observation result. */
export type NumericObserveAs =
  | { kind: "number"; min?: number; max?: number }
  | { kind: "integer"; min?: number; max?: number };

/** Spec and observation fields shared by scalar cells and array elements. */
export type ObservableScalar =
  | { type: "boolean"; observing?: SemanticString }
  | { type: "string"; observing?: SemanticString }
  | { type: "enum"; values: string[]; observing?: SemanticString }
  | {
      type: "number";
      observing?: SemanticString;
      observeAs?: NumericObserveAs;
    };

type CellBase = {
  name: string;
  loc?: SourceRange;
};

/** Scalar observable cell declaration visible in the lexical scope of a node. */
export type ScalarObservableCell = ObservableScalar & CellBase;

/**
 * Observable array declaration: an ordered collection with one scalar element
 * guarantee.
 */
export type ObservableArrayCell = {
  type: "array";
  element: ObservableScalar;
} & CellBase;

/** Observable cell declaration visible in the lexical scope of a node. */
export type ObservableCell = ScalarObservableCell | ObservableArrayCell;

/** Stored, readable, and settable Artifact-array declaration. */
export type ArtifactArrayCell = ArtifactArraySpec & CellBase;

/** One-level array declaration with either scalar or Artifact elements. */
export type ArrayCell = ObservableArrayCell | ArtifactArrayCell;

/** Dialog-cursor cell declaration: a stored coordinate into the visible dialog. */
export type DialogCursorCell = DialogCursorSpec & CellBase;

/** Artifact cell declaration, not the cell's stored runtime value. */
export type ArtifactCell = ArtifactSpec &
  CellBase & {
    initializer?: ArtifactConstructExpression;
  };

/** Local-only cell declaration that cannot be semantically observed. */
export type LocalCell = DialogCursorCell | ArtifactCell;

/** Cell declaration visible in the lexical scope of a node. */
export type Cell = ObservableCell | ArtifactArrayCell | LocalCell;

export function isObservableCell(cell: Cell): cell is ObservableCell {
  return isObservableCellSpec(cell);
}

export function isArrayCell(cell: Cell): cell is ArrayCell {
  return cell.type === "array";
}

/** An observable declaration whose spec and metadata are scalar-shaped. */
export function isScalarObservableCell(
  cell: Cell,
): cell is ScalarObservableCell {
  return isObservableCell(cell) && cell.type !== "array";
}

export function isArtifactCell(cell: Cell): cell is ArtifactCell {
  return cell.type === "artifact";
}

/** A cell that `$set(...)` and `$unset(...)` may target. */
export function isSettableCell(
  cell: Cell,
): cell is
  | ObservableCell
  | ArtifactArrayCell
  | DialogCursorCell
  | ArtifactCell {
  return isSettableCellSpec(cell);
}

/** A cell that may be read as a value expression. */
export function isValueExpressionCell(
  cell: Cell,
): cell is
  | ObservableCell
  | ArtifactArrayCell
  | DialogCursorCell
  | ArtifactCell {
  return (
    isObservableCell(cell) ||
    cell.type === "array" ||
    cell.type === "dialogCursor" ||
    cell.type === "artifact"
  );
}

/** Passive semantic observation. */
export type ObserveAction = {
  id: ElementId;
  kind: "observe";
  target: CellTarget;
  question?: SemanticString;
  loc?: SourceRange;
};

/** Observation with fallback to asking the user. */
export type ObserveOrAskAction = {
  id: ElementId;
  kind: "observeOrAsk";
  target: CellTarget;
  question?: SemanticString;
  loc?: SourceRange;
};

/**
 * Passive semantic observation of several cells as one atomic action.
 *
 * `targets` are bound by same-name binding: the authored object literal
 * `{ a, b }` lists shorthand cell references, so each entry is its own cell
 * target `["a"]` / `["b"]`. Each cell is observed with its own `observing`
 * question; the grouped
 * form takes no override question. The host reports every field in one report
 * and the runtime writes them together (see `specs/arc-scripts.md`, Grouped
 * Observation).
 */
export type ObserveGroupAction = {
  id: ElementId;
  kind: "observeGroup";
  targets: CellTarget[];
  loc?: SourceRange;
};

/**
 * Grouped observation with fallback to asking the user. Binding and reporting
 * follow `ObserveGroupAction`; the host may ask the user instead of resolving
 * silently.
 */
export type ObserveOrAskGroupAction = {
  id: ElementId;
  kind: "observeOrAskGroup";
  targets: CellTarget[];
  loc?: SourceRange;
};

/** Cell write performed after its value expression resolves. */
export type SetAction = {
  id: ElementId;
  kind: "set";
  target: CellTarget;
  value: ValueExpression;
  loc?: SourceRange;
};

/** Cell clear whose target accessors are evaluated locally. */
export type UnsetAction = {
  id: ElementId;
  kind: "unset";
  target: CellTarget;
  loc?: SourceRange;
};

/** Transactionally staged write into a declared returns channel. */
export type SetReturnAction = {
  id: ElementId;
  kind: "set-return";
  key: string;
  value: ValueExpression;
  loc?: SourceRange;
};

/**
 * `span.result.$set(...)`: writes the member's evaluator-local output cell
 * inside a `$map` callback.
 */
export type SetSpanAction = {
  id: ElementId;
  kind: "set-span";
  owner: "map";
  value: ValueExpression;
  loc?: SourceRange;
};

/** Labeled break in the action graph. */
export type BreakStatement = {
  id: ElementId;
  kind: "break";
  label: string;
  loc?: SourceRange;
};

/** Return statement inside hook functions. */
export type HookReturnStatement = {
  id: ElementId;
  kind: "return";
  value?: ValueExpression;
  loc?: SourceRange;
};

/**
 * Shared statement skeleton for hook bodies: the universal leaf actions
 * (`observe`, `set`, `unset`) plus control flow (`if`, labeled block, `break`).
 *
 * `Extra` adds the forms a specific hook allows on top of the skeleton. It
 * defaults to `never` and may be a single action or a union; each member must
 * be a discriminated action carrying its own `kind`.
 */
export type HookStatement<Extra extends { kind: string } = never> =
  | ObserveAction
  | ObserveGroupAction
  | SetAction
  | UnsetAction
  | HookIfStatement<Extra>
  | HookLabelStatement<Extra>
  | BreakStatement
  | Extra;

/** Conditional inside hook functions. */
export type HookIfStatement<Extra extends { kind: string } = never> = {
  id: ElementId;
  kind: "if";
  test: ValueExpression;
  consequent: HookStatement<Extra>[];
  alternate?: HookStatement<Extra>[];
  loc?: SourceRange;
};

/** Labeled block inside hook functions. */
export type HookLabelStatement<Extra extends { kind: string } = never> = {
  id: ElementId;
  kind: "label";
  label: string;
  body: HookStatement<Extra>[];
  loc?: SourceRange;
};

/** Statement allowed inside `this.trigger`. */
export type TriggerStatement = HookStatement<HookReturnStatement>;

/** Statement allowed inside `resolveWhen` and `deflectWhen`. */
export type ResolutionStatement = HookStatement<HookReturnStatement>;

/** Statement allowed inside `this.guard`. */
export type GuardStatement = HookStatement<HookReturnStatement>;

/**
 * Statement allowed inside `this.catchDeflection`: the boolean-style hook
 * statements plus `$observeOrAsk(...)`.
 */
export type CatchDeflectionStatement = HookStatement<
  HookReturnStatement | ObserveOrAskAction | ObserveOrAskGroupAction
>;

/**
 * Statement subset allowed in `this.effects`: the shared hook skeleton plus
 * staged returns and standalone host calls.
 */
export type EffectStatement = HookStatement<SetReturnAction | HostCall>;

/**
 * Enter a child node or imported arc from the current action graph.
 *
 * `target.identifier` is a structural reference name resolved from a local
 * declaration or import binding, and is distinct from a display label.
 */
export type EnterNodeAction = {
  id: ElementId;
  kind: "enter-node";
  target: EnterTarget;
  /**
   * Args channel bindings.
   * key: child-side args channel key (`args.<key>`).
   * value: the `EnterChannelBindingSource` the key binds to.
   */
  args?: EnterChannelBindings;
  /**
   * Returns channel bindings.
   * key: child-side returns channel key (`returns.<key>.$set(...)`).
   * value: the `EnterChannelBindingSource` the key binds to.
   */
  returns?: EnterChannelBindings;
  loc?: SourceRange;
};

/** Repeated enter action with caller-authored loop resolution. */
export type EnterLoopAction = {
  id: ElementId;
  kind: "enter-loop";
  target: EnterTarget;
  resolveWhen: ResolutionStatement[];
  /**
   * Args channel bindings.
   * key: child-side args channel key (`args.<key>`).
   * value: the `EnterChannelBindingSource` the key binds to.
   */
  args?: EnterChannelBindings;
  /**
   * Returns channel bindings.
   * key: child-side returns channel key (`returns.<key>.$set(...)`).
   * value: the `EnterChannelBindingSource` the key binds to.
   */
  returns?: EnterChannelBindings;
  loc?: SourceRange;
};

/** Authored instruction emitted from the action graph. */
export type InstructionAction = {
  id: ElementId;
  kind: "instruction";
  mode: "once" | "persistent";
  template: SemanticString;
  hostParams: PayloadValue;
  resolveWhen?: ResolutionStatement[];
  deflectWhen?: ResolutionStatement[];
  /**
   * Set when `deflectWhen` is the node-level default inherited at parse time.
   * Inherited hook IR is shared across every inheriting instruction — its
   * elements keep their `deflectWhen/` scope ids — so the runtime qualifies
   * the hook's brief identity by the owning instruction's consultation
   * instance (`qualifiedBriefSite`) to keep answers from colliding.
   */
  inheritedDeflectWhen?: boolean;
  loc?: SourceRange;
};

/**
 * `invoke(() => { ... })`: an attached statement graph run inline in the
 * enclosing node — same cell scope, running under the enclosing node's
 * traversal, with its own SEG and body statement ids stamped under the
 * enclosing node's space.
 *
 * An invoke is never memoized: each reach of the statement on a fresh walk runs
 * a fresh invocation whose `$` slots resolve once per invocation, and its
 * completion is a sigil-less pin — a rewalk of the enclosing SEG releases it
 * and re-derives the body, while a resume replays it and skips the statement.
 * A blocked invocation resumes itself.
 */
export type InvokeAction = {
  id: ElementId;
  kind: "invoke";
  body: Statement[];
  loc?: SourceRange;
};

/**
 * `arr.$map(callback, results?)`: a `$` resolved-once action that reads one
 * pinned input array, runs its callback once per element, and (when `results`
 * is bound) commits one constructed output array in a single write when it
 * resolves. It never writes its receiver.
 *
 * `receiver` is the input array — a lexical array cell or a typed read-only
 * array channel. `results` is the output array cell name when present; omitting
 * it is the forEach shape (members run for their effects, no output, and
 * `span.result` is unbound). `body` is the callback statement graph, run under
 * the invoke dialect, its element ids stamped under this action's id.
 */
export type MapAction = {
  id: ElementId;
  kind: "map";
  receiver: ArrayReference;
  results?: string;
  body: Statement[];
  loc?: SourceRange;
};

/** Any executable action statement in a node body. */
export type ActionStatement =
  | ObserveAction
  | ObserveOrAskAction
  | ObserveGroupAction
  | ObserveOrAskGroupAction
  | SetAction
  | UnsetAction
  | SetReturnAction
  | EnterNodeAction
  | EnterLoopAction
  | InstructionAction
  | InvokeAction
  | MapAction
  | SetSpanAction
  | HostCall;

/** Control-flow statement in the action graph. */
export type IfStatement = {
  id: ElementId;
  kind: "if";
  test: ValueExpression;
  consequent: Statement[];
  alternate?: Statement[];
  loc?: SourceRange;
};

/** Labeled block in the action graph. */
export type LabelStatement = {
  id: ElementId;
  kind: "label";
  label: string;
  body: Statement[];
  loc?: SourceRange;
};

/** Top-level executable statement inside a node action graph. */
export type Statement =
  | ActionStatement
  | IfStatement
  | LabelStatement
  | BreakStatement;

/**
 * Arc document imported by an Arc document: the root structural identifier
 * (`importedName`) and the local binding used inside the importing document
 * (`localName`).
 */
export type DocumentImport = {
  importedName: string;
  localName: string;
  source: string;
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

/** Synthetic alias used only for `newcopy(...)` definition lookup. */
export type NewCopyNodeAlias = {
  identifier: string;
  target: string;
  imported: boolean;
};

/** How a SEG continues after a resolved action changes its captured read set. */
export type WriteDiffMode = "rewalk" | "advance";

/**
 * Node definition in Arc's public structural IR.
 *
 * `identifier` is the canonical structural identity derived from the JS
 * function declaration name. It is used for references like `$enter(X)` and
 * `X.state`. `displayName` is optional human-facing metadata, used for display
 * only.
 *
 * Two conventions express absence, by kind:
 *
 * - Collection fields (`cells`, `statements`, `children`, `newcopyAliases`,
 *   `imports`) are always present and empty when the node declares none, so a
 *   walk can iterate them unguarded.
 * - Hook fields (`trigger`, `deflectWhen`, `catchDeflection`, `guard`,
 *   `effects`) are absent when undeclared, because "no hook" and "an empty
 *   hook" differ — an empty hook body would consult and return nothing.
 *   `hostParams` is optional here for the same reason, and required on
 *   `InstructionAction`, where the merged node/instruction params always reach
 *   the brief.
 */
export type Node = {
  identifier: string;
  displayName?: string;
  description?: string;
  // TODO: Surface parsed guidance to the host; the runtime does not read it yet.
  guidance?: SemanticString;
  hostParams?: PayloadValue;
  forgetfulEntry: boolean;
  /**
   * Allows flipping write-diff behavior for this node. Authored `rewalk`
   * support will be added later.
   */
  writeDiffMode: WriteDiffMode;
  /** Typed `args`/`returns` channel schema declared by the node parameters. */
  signature?: NodeSignature;
  cells: Cell[];
  statements: Statement[];
  children: Node[];
  newcopyAliases: NewCopyNodeAlias[];
  imports: string[];
  trigger?: TriggerStatement[];
  deflectWhen?: ResolutionStatement[];
  catchDeflection?: CatchDeflectionStatement[];
  guard?: GuardStatement[];
  effects?: EffectStatement[];
  loc?: SourceRange;
};

/**
 * Public structural IR for one Arc source, with imports and root nodes.
 *
 * Each top-level function declaration is an arc candidate. Nested function
 * declarations remain child nodes of their containing root or node.
 *
 * Imports track both the root structural identifier (`importedName`) and
 * the local binding used inside the current document (`localName`).
 */
export type Document = {
  imports: DocumentImport[];
  hostModules: HostModuleBinding[];
  roots: Node[];
};

/**
 * Static read-set for one lexical node: the traversal-visible state that some
 * branch the node can reach actually reads — cell names, the identifiers
 * whose node outcome (`X.state`) is read, and channel reads.
 *
 * Completeness is a correctness requirement: a missed read drops a key from the
 * enter pre-snapshot, so a change to it goes undetected and the enclosing SEG
 * under-rewalks.
 *
 * `Dialog` reads are excluded. The dialog advances on every turn, so bracketing
 * it would rewalk every cross-turn resolution and release every pinned value.
 * Dialog-gated branches rebind on the next rewalk driven by a state change, and
 * trigger consultations carry per-turn reactivity.
 */
export type NodeReadSet = {
  cells: string[];
  nodeIdentifiers: string[];
  channels: { namespace: ChannelNamespace; key: string }[];
};

/**
 * Document-wide static re-walk plan: each node's read-sets, keyed by the
 * capturing SEG.
 *
 * Keyed by `Node` identity: the analysis runs in the parser over source-less IR
 * (no runtime `NodeRef` available), and the runtime resolves a traversal back to
 * its declaring `Node` — the same object — so `newcopy`/`forgetful` targets
 * resolve to their real node and still find their plan entry.
 *
 * Within a node, one entry per capturing SEG: the node body under
 * `nodeSegKey("body")` and each invoke body under `invokeSegKey(id)`. The body
 * entry includes its invoke bodies' reads transitively — an invoke re-runs
 * whenever the enclosing SEG re-walks, so a change to anything a body reads must
 * re-walk it — while each invoke entry scopes that body's own reads (nested
 * invokes included) for brackets taken inside it.
 *
 * Held in `Map`s: a plan is derived per document at analysis time and never
 * serialized, and keying on `Node` identity requires a `Map`.
 */
export type DocumentRewalkPlan = {
  bySeg: Map<Node, Map<SegKey, NodeReadSet>>;
};

/**
 * Products of one reference-resolving analysis walk over a document:
 * validation issues, lint issues, and the static re-walk plan. None is stored
 * on or mutates the input `Document`.
 */
export type DocumentAnalysis = {
  issues: ValidationIssue[];
  lintIssues: LintIssue[];
  rewalkPlan: DocumentRewalkPlan;
};

/** Optional external authorities supplied to document analysis. */
export type DocumentAnalysisOptions = {
  /** Presence makes host-module analysis definitive, including for an empty map. */
  hostModules?: ReadonlyMap<string, HostModuleSpec>;
};
