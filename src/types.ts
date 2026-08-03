// Shared Foundations
//
// The value domain and structural identities both the IR and the runtime build
// on. A declaration belongs here only when the parser and the runtime each use
// it directly; anything used by one side alone belongs to that side's section.

/**
 * Scalar values runtime expressions can reduce to without host work.
 */
export type PrimitiveValue = string | number | boolean;

export function isPrimitiveValue(value: unknown): value is PrimitiveValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Ordered list of primitive element values held by an array cell. */
export type ArrayValue = PrimitiveValue[];

export function isArrayValue(value: unknown): value is ArrayValue {
  return Array.isArray(value) && value.every(isPrimitiveValue);
}

/**
 * Payload value passed across the runtime boundary.
 */
export type PayloadValue =
  | PrimitiveValue
  | null
  | undefined
  | PayloadValue[]
  | { [key: string]: PayloadValue };

/**
 * Opaque dialog turn coordinate supplied by the host for the scoped visible
 * dialog. A cursor is bound to the view it was read from: `view` is stamped at
 * read time from the supplied dialog's `view`, travels with stored snapshots,
 * and only cursors of the same view are comparable. An absent `view` is the
 * host's default view.
 */
export type DialogCursor = {
  user: number;
  self: number;
  view?: string;
};

/** Values persisted in authored Arc cells. */
export type CellValue = PrimitiveValue | DialogCursor | ArrayValue;

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

/** Parser-internal placeholder for IR built before `stampElementIds` runs. */
export const UNSTAMPED_ID = "" as ElementId;

/**
 * Flattened string key for one SEG consultation instance on a node frame —
 * keys `evaluatorActionStates` and `pinTapes`. Always built by the constructors
 * below, from the live statement the walk is standing at or, for
 * catch-deflection, from a `DeflectionContext` (one-way, struct → string; never
 * parsed back). Equal to the authored scope id for every scope except
 * catch-deflection, which embeds the runtime origin/from refs so a different
 * deflection opens a fresh consultation.
 *
 * A key is never derived from a `SegId`: `SegId` routes resume structurally,
 * and a walk that needs a key already holds the statement it is built from.
 */
export type SegKey = string & { readonly __segKey: unique symbol };

// Source / IR Types
//
// The parsed document: its declarations, expression grammar, statement graph,
// and the diagnostics and static analysis derived from them. Produced by the
// parser; read by the runtime but never written by it.

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

/**
 * Static authoring lint issue tied to valid authored Arc source. Severity runs
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
 * A scalar value shape with the bounds its type requires. Cell declarations,
 * array element shapes, typed channels, and observation metadata all build on
 * it, so a shape carries only the bounds its own type defines.
 */
export type ScalarSpec =
  | { type: "boolean" }
  | { type: "string" }
  | { type: "enum"; values: string[] }
  | { type: "rangedInt"; min: number; max: number };

/**
 * One typed channel schema on a node signature. These are the cell shapes that
 * can cross an enter boundary. `index` is a channel-only non-negative integer
 * used by `span.index`; it is not an authored persistent cell constructor.
 * `array` nests recursively for forward compatibility even though authored
 * array cells are single-level in v1.
 */
export type ChannelSpec =
  | ScalarSpec
  | { type: "dialogCursor" }
  | { type: "index" }
  | { type: "array"; element: ChannelSpec };

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
  | { kind: "nodeState"; identifier: string };

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

/** Structured argument shape accepted by authored host calls and effects. */
export type HostCallArgument =
  | { kind: "semantic"; value: SemanticString }
  | { kind: "value"; value: ValueExpression }
  | { kind: "array"; elements: HostCallArgument[] }
  | { kind: "object"; value: Record<string, HostCallArgument> };

/** Host-backed value lookup that may suspend on the brief/report boundary. */
export type HostCallExpression = {
  id: ElementId;
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
  arguments: HostCallArgument[];
  loc?: SourceRange;
};

/** Expression forms whose evaluation may yield a brief. */
export type BriefableExpression = JudgeExpression | HostCallExpression;

/**
 * Full recursive expression grammar for Arc value positions.
 *
 * Every form evaluates to a value; a briefable form suspends until the host
 * reports its result.
 */
export type ValueExpression =
  | LocalExpression
  | BriefableExpression
  | ValueString
  | { kind: "arrayLiteral"; elements: ValueExpression[] }
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
  | {
      kind: "conditional";
      test: ValueExpression;
      consequent: ValueExpression;
      alternate: ValueExpression;
    }
  | { kind: "unary"; op: "!"; argument: ValueExpression };

/** Logical artifact path authored as a literal or value-position template. */
export type ArtifactPathExpression = string | ValueString;

/** Observable scalar value shape, independent of any declaring cell. */
export type ScalarObservableSpec = ScalarSpec & {
  observing?: SemanticString;
};

/** Observable array value shape, independent of any declaring cell. */
export type ArraySpec = {
  type: "array";
  element: ScalarObservableSpec;
};

/** Observable value shape accepted by a cell target. */
export type ObservableCellSpec = ScalarObservableSpec | ArraySpec;

/** Dialog-cursor value shape, independent of any declaring cell. */
export type DialogCursorSpec = {
  type: "dialogCursor";
};

/** Artifact schema, including the authored path used for semantic rendering. */
export type ArtifactSpec = {
  type: "artifact";
  path: ArtifactPathExpression;
};

/** Local-only cell schema that cannot be semantically observed. */
export type LocalCellSpec = DialogCursorSpec | ArtifactSpec;

/** Schema of any declared or synthetic cell target. */
export type CellSpec = ObservableCellSpec | LocalCellSpec;

type CellBase = {
  name: string;
  loc?: SourceRange;
};

/** Scalar observable cell declaration visible in the lexical scope of a node. */
export type ScalarObservableCell = ScalarObservableSpec & CellBase;

/**
 * Array cell declaration: an ordered collection of one scalar element shape,
 * written and observed as a whole value.
 */
export type ArrayCell = ArraySpec & CellBase;

/** Observable cell declaration visible in the lexical scope of a node. */
export type ObservableCell = ScalarObservableCell | ArrayCell;

/** Dialog-cursor cell declaration: a stored coordinate into the visible dialog. */
export type DialogCursorCell = DialogCursorSpec & CellBase;

/** Artifact cell declaration: a logical path rendered into semantic text. */
export type ArtifactCell = ArtifactSpec & CellBase;

/** Local-only cell declaration that cannot be semantically observed. */
export type LocalCell = DialogCursorCell | ArtifactCell;

/** Cell declaration visible in the lexical scope of a node. */
export type Cell = ObservableCell | LocalCell;

export function isObservableCellSpec(
  spec: CellSpec,
): spec is ObservableCellSpec {
  return spec.type !== "dialogCursor" && spec.type !== "artifact";
}

export function isSettableCellSpec(
  spec: CellSpec,
): spec is ObservableCellSpec | DialogCursorSpec {
  return isObservableCellSpec(spec) || spec.type === "dialogCursor";
}

export function isObservableCell(cell: Cell): cell is ObservableCell {
  return isObservableCellSpec(cell);
}

export function isArrayCell(cell: Cell): cell is ArrayCell {
  return cell.type === "array";
}

/** An observable cell whose value carries its type and bounds directly. */
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
): cell is ObservableCell | DialogCursorCell {
  return isSettableCellSpec(cell);
}

/** A cell that may be read as a value expression. */
export function isValueExpressionCell(
  cell: Cell,
): cell is ObservableCell | DialogCursorCell {
  return isObservableCell(cell) || cell.type === "dialogCursor";
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

/** Deterministic cell write without host semantic work. */
export type SetAction = {
  id: ElementId;
  kind: "set";
  target: CellTarget;
  value: ValueExpression;
  loc?: SourceRange;
};

/** Deterministic cell clear without host semantic work. */
export type UnsetAction = {
  id: ElementId;
  kind: "unset";
  target: CellTarget;
  loc?: SourceRange;
};

/** Staged write into a caller-bound returns channel. */
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

/** Non-blocking host invocation emitted from `this.effects`. */
export type HostEffectStatement = {
  id: ElementId;
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
  arguments: HostCallArgument[];
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
 * staged returns and host effects.
 */
export type EffectStatement = HookStatement<
  SetReturnAction | HostEffectStatement
>;

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
  | SetSpanAction;

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
 * Parsed node definition.
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
 * Parsed document with import metadata and one or more arcs.
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
 * on the `Document`; the IR stays pure parser output.
 */
export type DocumentAnalysis = {
  issues: ValidationIssue[];
  lintIssues: LintIssue[];
  rewalkPlan: DocumentRewalkPlan;
};

// Runtime API Types
//
// Persisted traversal state and the brief/report contract the host answers.
// Nothing here is derivable from source alone.

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

/** One segment inside host-facing rendered semantic text. */
export type SemanticTextPart =
  | { kind: "text"; value: string }
  | { kind: "entity"; name: "user" | "self" }
  | { kind: "artifact"; path: string }
  | { kind: "hostVar"; module: string; path: string[] };

/** Host-facing rendered semantic text with deferred host-rendered references. */
export type SemanticText = string | SemanticTextPart[];

/** A single conversation turn with role attribution. */
export type DialogTurn = {
  role: "self" | "user";
  message: string;
};

/**
 * Conversation history visible to traversal during trigger probing and action
 * progression. `Dialog.lastUserMessage` is derived from `lastTurns` by the
 * runtime. `cursor` is the host-maintained coordinate for that same scoped
 * visible dialog. The dialog is provided by the caller each turn and is not
 * persisted inside `Traversal`.
 */
export type Dialog = {
  lastTurns: DialogTurn[];
  cursor: DialogCursor;
  /**
   * The view this dialog was projected for, stamped by the host. Cursor reads
   * copy it, binding the cursor to this view. Absent means the host's default
   * view.
   */
  view?: string;
};

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
  terminals: (PrimitiveValue | undefined)[];
  staged?: { set: boolean; value?: PrimitiveValue };
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

/** Continuation fields a caller may hand to a newly pending action state. */
export type PendingActionExtras = EnterContinuation &
  SubtreeBracket & { map?: MapActionState };

/** Every action kind that can hold resolution state on a node frame. */
export type ActionStateKind =
  | ActionStatement["kind"]
  | HostEffectStatement["kind"];

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
  | ({ kind: "instruction"; status: ActionStatus } & SubtreeBracket)
  | ({
      kind: "map";
      status: ActionStatus;
      /** The `$map` arena, held while the action is pending. */
      map?: MapActionState;
    } & SubtreeBracket)
  | {
      kind: Exclude<
        ActionStateKind,
        EnterActionKind | "invoke" | "instruction" | "map"
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
 * child channel key to a caller cell (`callerCell`). A `$map` callback's enter
 * also binds `span.*`: `spanValue` carries the member's `span.item` / `span.index`
 * captured by value at bind time, and `spanResult` is the write sink into the
 * owning map arena's staged result for `span.result`.
 */
export type EnterChannelLink =
  | ({ kind: "callerCell" } & CallerCellRef)
  | { kind: "spanValue"; value: CellValue }
  | { kind: "spanResult"; ownerRef: NodeRef; mapId: ElementId };

/** `$enter(..., { args, returns })` channel data for one traversal. */
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
  /** Idempotency keys for host effects already emitted from this traversal. */
  appliedHostCallKeys: string[];
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

/** Type metadata for a scalar observed value: the bare scalar shape. */
export type ScalarObservationMeta = ScalarSpec;

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
  currentValue?: PrimitiveValue | ArrayValue;
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
  currentValue?: PrimitiveValue | ArrayValue;
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
 * `hostParams` is the position node's authored `hostParams` (`null` when it
 * declares none), carried so the host can decide how to project without a
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
 * Allowed high-level moves for one action brief.
 *
 * - `proceed`: report semantic results and continue traversal
 * - `deflect`: mark the active node as intentionally deflected. This move is
 *   only available when `allowedMoves` includes it for the current frontier.
 * - `poison`: mark the active arc as unusable because the host cannot execute
 *   the current frontier contract.
 */
export type ActionMove = "proceed" | "deflect" | "poison";

/**
 * Multi-arc trigger brief for the current traversal probe.
 *
 * Trigger probing stays separate from normal action-brief probing because trigger
 * evaluation may perform `$observe(...)` / `judge(...)` work before any arc is
 * admitted into the main traversal loop.
 *
 * `matchableArcs` contains arcs whose triggers already evaluate true under the
 * currently known state, before any additional host reports are
 * accepted.
 *
 * `matched` identifies the selected arc once trigger stage has resolved to a
 * single activation.
 *
 * `deps` is the compatibility set for the returned `traversals`. Callers that
 * persist and later feed those traversals back into a runtime must provide Arc
 * definitions compatible with every ArcRef in this list. The set can include
 * arcs that do not currently have traversal entries because they are reachable
 * through imports and may be entered later.
 *
 * Hosts may inspect this object freely, but must treat it as immutable and
 * pass the same object instance back to `Runtime.progressTrigger(...)`.
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
  value?: PrimitiveValue | ArrayValue;
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
 * `preferredMatch` expresses the host's preferred arc when multiple trigger
 * candidates may eventually match. Judgments and observations are keyed by ids
 * from the originating `TriggerBrief`.
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
  judgments?: Record<BriefId, boolean>;
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  hostCalls?: Record<BriefId, PayloadValue>;
  hostEffects?: Record<BriefId, HostEffectReport>;
};
