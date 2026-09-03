import type {
  CatchDeflectionStatement,
  Cell,
  CellTarget,
  EffectStatement,
  EnterChannelBindings,
  GuardStatement,
  HostCallArgument,
  LintIssue,
  Node,
  ResolutionStatement,
  SemanticString,
  SourceRange,
  Statement,
  TriggerStatement,
  ValueExpression,
} from "../types/parser.js";
import {
  isArrayCell,
  isScalarObservableCell,
  isValueExpressionCell,
} from "../types/parser.js";

type LintRule = {
  severity: LintIssue["severity"];
  message: string;
};

const LINT_RULES = {
  "canonical-enter-loop-retained-frame": {
    severity: "warning",
    message:
      "$enterLoop() uses a canonical target whose frame is retained on entry; use newcopy(...) for anonymous-copy iterations or forgetful(...) for an intentional forgetful entry.",
  },
  "unguarded-invoke": {
    severity: "warning",
    message:
      "invoke() is reached unconditionally and runs an unconditional action, so that work repeats on every walk or re-walk that reaches it; guard the effects inside it unless the repeated run is intended.",
  },
  "invoke-unconditional-set": {
    severity: "notice",
    message:
      "invoke() writes a cell unconditionally, so the write re-applies on every reach; if another action later writes the same cell, the re-run can overwrite it. Make the re-application deliberate or guard the write.",
  },
  "invoke-self-mutating-set": {
    severity: "error",
    message:
      "invoke() write derives a cell from its own current value without a guard, so it re-applies on every reach and may never reach a fixpoint (e.g. a boolean toggle `flag.$set(flag !== true)`, or a string that keeps growing); guard the write so it settles, or replace it with a value independent of its prior state.",
  },
  "nested-invoke": {
    severity: "warning",
    message: "Nested invoke() creates stacked reactive statement graphs.",
  },
  "boolean-toggle-set": {
    severity: "notice",
    message:
      "Bool cell is set to both true and false in this arc; action-graph $set() actions resolve and are remembered, so toggles and resets should be modeled deliberately.",
  },
  "bare-cell-boolean": {
    severity: "warning",
    message:
      "Bare cell is evaluated as a boolean; an unset value poisons the traversal. Use an explicit comparison for value tests, or cell.isUnset() when testing whether the cell has a value.",
  },
  "read-without-assignment": {
    severity: "error",
    message:
      "Cell is read but never set — by $set(), $observe()/$observeOrAsk(), or an enter returns binding — anywhere it is in scope; the read therefore always reaches an unset cell. Set it before it is read, or remove the read.",
  },
  "read-before-assignment": {
    severity: "notice",
    message:
      "Cell is read before $set(), $observe()/$observeOrAsk(), or an enter returns binding sets it on this path; on the first walk the read reaches an unset cell. Set it before the read, or guard the read until it is set.",
  },
} satisfies Record<string, LintRule>;

type BuiltInLintCode = keyof typeof LINT_RULES;

export type NodeLintContext = {
  lintIssues: LintIssue[];
  nodeLookup: Map<string, Node>;
  cellTypes: Map<string, Cell["type"]>;
  inInvoke: boolean;
};

function cellTargetRoot(target: CellTarget): string {
  return target[0];
}

function isDirectCellTarget(target: CellTarget): boolean {
  return target.length === 1;
}

export function lintNodeStatements(node: Node, context: NodeLintContext): void {
  for (const statement of node.statements) {
    lintStatement(statement, { ...context, branchDepth: 0 });
  }
}

/**
 * Warn when a cell itself reaches a boolean-evaluation boundary. Only a `Bool`
 * cell can legally arrive here — a non-boolean value in a boolean position is a
 * `NON_BOOLEAN_CONDITION` validation error, so a document that reaches linting
 * has already ruled those out. The warning targets the remaining case: a bare
 * `Bool` cell, whose unset value would poison the traversal. The walk is
 * expression-structural; equality and `isUnset()` are not boolean reads of the
 * inner value.
 */
export function lintNodeBareCellBooleans(
  node: Node,
  lintIssues: LintIssue[],
): void {
  for (const statements of [
    node.statements,
    node.trigger,
    node.guard,
    node.deflectWhen,
    node.catchDeflection,
    node.effects,
  ]) {
    lintBareCellBooleansInStatements(statements ?? [], lintIssues);
  }
  if (node.guidance && semanticStringContainsBareCellBoolean(node.guidance)) {
    emitLintIssue(lintIssues, "bare-cell-boolean", node.loc);
  }
  for (const cell of node.cells) {
    const observing = isScalarObservableCell(cell)
      ? cell.observing
      : isArrayCell(cell) && cell.element.type !== "artifact"
        ? cell.element.observing
        : undefined;
    if (observing && semanticStringContainsBareCellBoolean(observing)) {
      emitLintIssue(lintIssues, "bare-cell-boolean", cell.loc);
    }
    if (
      cell.type === "artifact" &&
      cell.initializer !== undefined &&
      expressionContainsBareCellBoolean(cell.initializer.path, false)
    ) {
      emitLintIssue(lintIssues, "bare-cell-boolean", cell.loc);
    }
  }
}

/** Literal true/false write locations for one boolean cell. */
type BooleanToggleWrites = { trueLoc?: SourceRange; falseLoc?: SourceRange };

export function lintRootArc(root: Node, lintIssues: LintIssue[]): void {
  // Keyed by the declaring node so that same-named cells in sibling scopes stay
  // distinct; a toggle is a single cell written both true and false.
  const writes = new Map<Node, Map<string, BooleanToggleWrites>>();
  collectBooleanLiteralSets(root, new Map(), writes);
  for (const scopeWrites of writes.values()) {
    for (const entry of scopeWrites.values()) {
      if (entry.trueLoc && entry.falseLoc) {
        emitLintIssue(lintIssues, "boolean-toggle-set", entry.falseLoc);
      }
    }
  }
}

function emitLintIssue(
  issues: LintIssue[],
  code: BuiltInLintCode,
  loc: SourceRange | undefined,
): void {
  const rule = LINT_RULES[code];
  issues.push({
    code,
    severity: rule.severity,
    message: rule.message,
    loc,
  });
}

/**
 * Whether an invoke body runs any action unconditionally — an action statement
 * that is not nested inside an `if`. A body whose every effect is internally
 * guarded re-runs cheaply and is left unflagged; only a body that does
 * unconditional work each reach earns the unguarded-reach warning. Labels are
 * transparent (they group rather than guard), so their contents are inspected.
 */
function invokeBodyHasUnconditionalEffect(
  statements: readonly Statement[],
): boolean {
  for (const statement of statements) {
    if (statement.kind === "if" || statement.kind === "break") continue;
    if (statement.kind === "label") {
      if (invokeBodyHasUnconditionalEffect(statement.body)) return true;
      continue;
    }
    return true;
  }
  return false;
}

function lintStatement(
  statement: Statement,
  context: NodeLintContext & { branchDepth: number },
): void {
  if (statement.kind === "if") {
    statement.consequent.forEach((entry) =>
      lintStatement(entry, {
        ...context,
        branchDepth: context.branchDepth + 1,
      }),
    );
    statement.alternate?.forEach((entry) =>
      lintStatement(entry, {
        ...context,
        branchDepth: context.branchDepth + 1,
      }),
    );
    return;
  }

  if (statement.kind === "label") {
    statement.body.forEach((entry) => lintStatement(entry, context));
    return;
  }

  if (statement.kind === "break") return;

  if (statement.kind === "invoke") {
    // A nested invoke is the more specific finding, so it subsumes the
    // unguarded-reach warning on the same statement.
    if (context.inInvoke) {
      emitLintIssue(context.lintIssues, "nested-invoke", statement.loc);
    } else if (
      context.branchDepth === 0 &&
      invokeBodyHasUnconditionalEffect(statement.body)
    ) {
      emitLintIssue(context.lintIssues, "unguarded-invoke", statement.loc);
    }
    for (const entry of statement.body) {
      lintStatement(entry, { ...context, inInvoke: true, branchDepth: 0 });
    }
    return;
  }

  if (statement.kind === "enter-loop") {
    const targetNode =
      statement.target.imported || statement.target.mode !== "canonical"
        ? undefined
        : context.nodeLookup.get(statement.target.identifier);
    if (targetNode?.forgetfulEntry === false) {
      emitLintIssue(
        context.lintIssues,
        "canonical-enter-loop-retained-frame",
        statement.loc,
      );
    }
    return;
  }

  if (
    context.inInvoke &&
    context.branchDepth === 0 &&
    (statement.kind === "set" || statement.kind === "unset")
  ) {
    const root = cellTargetRoot(statement.target);
    emitLintIssue(
      context.lintIssues,
      statement.kind === "set" &&
        isNonConvergentSelfWrite(
          statement.value,
          root,
          context.cellTypes.get(root),
        )
        ? "invoke-self-mutating-set"
        : "invoke-unconditional-set",
      statement.loc,
    );
  }
}

type BooleanLiteralSetStatement =
  | Statement
  | TriggerStatement
  | ResolutionStatement
  | GuardStatement
  | CatchDeflectionStatement
  | EffectStatement;

function lintBareCellBooleansInStatements(
  statements: readonly BooleanLiteralSetStatement[],
  lintIssues: LintIssue[],
): void {
  for (const statement of statements) {
    let containsBareBoolean = false;
    switch (statement.kind) {
      case "if":
        containsBareBoolean = expressionContainsBareCellBoolean(
          statement.test,
          true,
        );
        lintBareCellBooleansInStatements(statement.consequent, lintIssues);
        lintBareCellBooleansInStatements(statement.alternate ?? [], lintIssues);
        break;
      case "label":
      case "invoke":
        lintBareCellBooleansInStatements(statement.body, lintIssues);
        break;
      case "set":
      case "set-return":
        containsBareBoolean = expressionContainsBareCellBoolean(
          statement.value,
          false,
        );
        break;
      case "unset":
        break;
      case "return":
        containsBareBoolean =
          statement.value !== undefined &&
          expressionContainsBareCellBoolean(statement.value, true);
        break;
      case "observe":
      case "observeOrAsk":
        containsBareBoolean =
          statement.question !== undefined &&
          semanticStringContainsBareCellBoolean(statement.question);
        break;
      case "instruction":
        containsBareBoolean = semanticStringContainsBareCellBoolean(
          statement.template,
        );
        lintBareCellBooleansInStatements(
          statement.resolveWhen ?? [],
          lintIssues,
        );
        lintBareCellBooleansInStatements(
          statement.deflectWhen ?? [],
          lintIssues,
        );
        break;
      case "enter-loop":
        lintBareCellBooleansInStatements(statement.resolveWhen, lintIssues);
        break;
      case "host-call":
        containsBareBoolean = statement.arguments.some(
          hostCallArgumentContainsBareCellBoolean,
        );
        break;
      default:
        break;
    }
    if (containsBareBoolean) {
      emitLintIssue(lintIssues, "bare-cell-boolean", statement.loc);
    }
  }
}

function semanticStringContainsBareCellBoolean(value: SemanticString): boolean {
  return (
    value.kind === "template-string" &&
    value.parts.some(
      (part) =>
        part.kind === "expression" &&
        expressionContainsBareCellBoolean(part.expression, false),
    )
  );
}

function hostCallArgumentContainsBareCellBoolean(
  arg: HostCallArgument,
): boolean {
  if (arg.kind === "semantic") {
    return semanticStringContainsBareCellBoolean(arg.value);
  }
  if (arg.kind === "value") {
    return expressionContainsBareCellBoolean(arg.value, false);
  }
  if (arg.kind === "array") {
    return arg.elements.some(hostCallArgumentContainsBareCellBoolean);
  }
  return Object.values(arg.value).some(hostCallArgumentContainsBareCellBoolean);
}

function expressionContainsBareCellBoolean(
  expression: ValueExpression,
  booleanPosition: boolean,
): boolean {
  if (expression.kind === "cell") return booleanPosition;
  switch (expression.kind) {
    case "comparison":
    case "arithmetic":
      return (
        expressionContainsBareCellBoolean(expression.left, false) ||
        expressionContainsBareCellBoolean(expression.right, false)
      );
    case "logical":
      return (
        expressionContainsBareCellBoolean(expression.left, true) ||
        expressionContainsBareCellBoolean(expression.right, true)
      );
    case "conditional":
      return (
        expressionContainsBareCellBoolean(expression.test, true) ||
        expressionContainsBareCellBoolean(
          expression.consequent,
          booleanPosition,
        ) ||
        expressionContainsBareCellBoolean(expression.alternate, booleanPosition)
      );
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return expressionContainsBareCellBoolean(expression.argument, true);
    case "regexTest":
      return expressionContainsBareCellBoolean(expression.target, false);
    case "dialogTurnsSince":
      return (
        expressionContainsBareCellBoolean(expression.receiver, false) ||
        expressionContainsBareCellBoolean(expression.baseline, false)
      );
    case "template-string":
      return expression.parts.some(
        (part) =>
          part.kind === "expression" &&
          expressionContainsBareCellBoolean(part.expression, false),
      );
    case "artifact":
      return expressionContainsBareCellBoolean(expression.path, false);
    case "judge":
      return semanticStringContainsBareCellBoolean(expression.question);
    case "host-call":
      return expression.arguments.some(hostCallArgumentContainsBareCellBoolean);
    default:
      return false;
  }
}

function collectBooleanLiteralSets(
  node: Node,
  inheritedDeclarations: Map<string, Node>,
  writes: Map<Node, Map<string, BooleanToggleWrites>>,
): void {
  // Map each in-scope boolean name to the node that declares it. A child's
  // redeclaration shadows the inherited name with its own distinct cell.
  const declarations = new Map(inheritedDeclarations);
  for (const cell of node.cells) {
    if (cell.type === "boolean") {
      declarations.set(cell.name, node);
    }
  }

  collectBooleanLiteralSetsFromStatements(
    node.statements,
    declarations,
    writes,
  );
  collectBooleanLiteralSetsFromStatements(
    node.trigger ?? [],
    declarations,
    writes,
  );
  collectBooleanLiteralSetsFromStatements(
    node.deflectWhen ?? [],
    declarations,
    writes,
  );
  collectBooleanLiteralSetsFromStatements(
    node.guard ?? [],
    declarations,
    writes,
  );
  collectBooleanLiteralSetsFromStatements(
    node.catchDeflection ?? [],
    declarations,
    writes,
  );
  collectBooleanLiteralSetsFromStatements(
    node.effects ?? [],
    declarations,
    writes,
  );

  for (const child of node.children) {
    collectBooleanLiteralSets(child, declarations, writes);
  }
}

function collectBooleanLiteralSetsFromStatements(
  statements: readonly BooleanLiteralSetStatement[],
  declarations: Map<string, Node>,
  writes: Map<Node, Map<string, BooleanToggleWrites>>,
): void {
  for (const statement of statements) {
    if (statement.kind === "if") {
      collectBooleanLiteralSetsFromStatements(
        statement.consequent,
        declarations,
        writes,
      );
      collectBooleanLiteralSetsFromStatements(
        statement.alternate ?? [],
        declarations,
        writes,
      );
      continue;
    }
    if (statement.kind === "label" || statement.kind === "invoke") {
      collectBooleanLiteralSetsFromStatements(
        statement.body,
        declarations,
        writes,
      );
      continue;
    }
    if (statement.kind !== "set") continue;
    if (!isDirectCellTarget(statement.target)) continue;
    const literal = booleanSetLiteral(statement.value);
    const root = cellTargetRoot(statement.target);
    const declaringNode = declarations.get(root);
    if (literal === undefined || declaringNode === undefined) continue;
    let scopeWrites = writes.get(declaringNode);
    if (scopeWrites === undefined) {
      scopeWrites = new Map();
      writes.set(declaringNode, scopeWrites);
    }
    const entry = scopeWrites.get(root) ?? {};
    if (literal) entry.trueLoc ??= statement.loc;
    else entry.falseLoc ??= statement.loc;
    scopeWrites.set(root, entry);
  }
}

function booleanSetLiteral(expression: ValueExpression): boolean | undefined {
  if (expression.kind !== "literal" || typeof expression.value !== "boolean") {
    return undefined;
  }
  return expression.value;
}

/**
 * Whether an unguarded invoke write can fail to converge. The write `x.$set(v)`
 * re-runs on every reach, so it settles only if iterating `x := v(x)` reaches a
 * fixpoint. A write that does not read its own cell cannot diverge from its
 * prior state and is never flagged here; a plain identity write (`x.$set(x)`) is
 * a trivial fixpoint and is likewise spared.
 *
 * Beyond those, convergence is type-dependent. Over the finite boolean domain it
 * is decidable, so a boolean write is judged precisely: it is flagged only when
 * it can invert its own value (`v(true)` can be false while `v(false)` can be
 * true), which lets a settling write such as `x.$set(x && cond)` through while
 * still catching a guarded toggle such as `x.$set(x != true && cond)`. For any
 * other type the domain is unbounded and convergence is not something we can
 * establish from structure, so every non-identity self-write is flagged — a
 * string that appends to itself or an enum that cycles never settles.
 */
function isNonConvergentSelfWrite(
  value: ValueExpression,
  cell: string,
  cellType: Cell["type"] | undefined,
): boolean {
  if (!expressionReadsCell(value, cell)) return false;
  if (value.kind === "cell" && value.name === cell) return false;
  if (cellType !== "boolean") return true;
  const whenSelfTrue = evalSelfRange(value, cell, true);
  const whenSelfFalse = evalSelfRange(value, cell, false);
  return whenSelfTrue.canBeFalse && whenSelfFalse.canBeTrue;
}

/**
 * The set of boolean results an expression can take as a function of the self
 * cell alone: `selfValue` is substituted for the cell and every other
 * cell ranges freely. `canBeTrue` / `canBeFalse` report whether some
 * assignment of the other cells yields that result, so both being true
 * means the result is unconstrained by the self cell. The two flags are
 * tracked independently across operands, which over-approximates achievability
 * (it ignores shared-cell correlation) in the flag-more direction.
 */
type SelfRange = { canBeTrue: boolean; canBeFalse: boolean };

const SELF_RANGE_UNKNOWN: SelfRange = { canBeTrue: true, canBeFalse: true };

function evalSelfRange(
  expression: ValueExpression,
  cell: string,
  selfValue: boolean,
): SelfRange {
  switch (expression.kind) {
    case "literal":
      if (typeof expression.value !== "boolean") return SELF_RANGE_UNKNOWN;
      return expression.value
        ? { canBeTrue: true, canBeFalse: false }
        : { canBeTrue: false, canBeFalse: true };
    case "cell":
      if (expression.name !== cell) return SELF_RANGE_UNKNOWN;
      return selfValue
        ? { canBeTrue: true, canBeFalse: false }
        : { canBeTrue: false, canBeFalse: true };
    case "unary": {
      const argument = evalSelfRange(expression.argument, cell, selfValue);
      return { canBeTrue: argument.canBeFalse, canBeFalse: argument.canBeTrue };
    }
    case "comparison": {
      const equality = expression.op === "==" || expression.op === "!=";
      if (!equality) return SELF_RANGE_UNKNOWN;
      const left = evalSelfRange(expression.left, cell, selfValue);
      const right = evalSelfRange(expression.right, cell, selfValue);
      const canEqual =
        (left.canBeTrue && right.canBeTrue) ||
        (left.canBeFalse && right.canBeFalse);
      const canDiffer =
        (left.canBeTrue && right.canBeFalse) ||
        (left.canBeFalse && right.canBeTrue);
      return expression.op === "=="
        ? { canBeTrue: canEqual, canBeFalse: canDiffer }
        : { canBeTrue: canDiffer, canBeFalse: canEqual };
    }
    case "logical": {
      const left = evalSelfRange(expression.left, cell, selfValue);
      const right = evalSelfRange(expression.right, cell, selfValue);
      if (expression.op === "&&") {
        return {
          canBeTrue: left.canBeTrue && right.canBeTrue,
          canBeFalse: left.canBeFalse || (left.canBeTrue && right.canBeFalse),
        };
      }
      return {
        canBeTrue: left.canBeTrue || (left.canBeFalse && right.canBeTrue),
        canBeFalse: left.canBeFalse && right.canBeFalse,
      };
    }
    case "conditional": {
      const test = evalSelfRange(expression.test, cell, selfValue);
      const consequent = evalSelfRange(expression.consequent, cell, selfValue);
      const alternate = evalSelfRange(expression.alternate, cell, selfValue);
      return {
        canBeTrue:
          (test.canBeTrue && consequent.canBeTrue) ||
          (test.canBeFalse && alternate.canBeTrue),
        canBeFalse:
          (test.canBeTrue && consequent.canBeFalse) ||
          (test.canBeFalse && alternate.canBeFalse),
      };
    }
    default:
      return SELF_RANGE_UNKNOWN;
  }
}

function expressionReadsCell(
  expression: ValueExpression,
  cell: string,
): boolean {
  const reads = new Set<string>();
  collectExpressionReads(expression, reads);
  return reads.has(cell);
}

/** Add every cell name read anywhere in an expression to `into`. */
function collectExpressionReads(
  expression: ValueExpression,
  into: Set<string>,
): void {
  switch (expression.kind) {
    case "cell":
      into.add(expression.name);
      return;
    case "isUnset":
      into.add(expression.cell);
      return;
    case "regexTest":
      collectExpressionReads(expression.target, into);
      return;
    case "dialogTurnsSince":
      collectExpressionReads(expression.receiver, into);
      collectExpressionReads(expression.baseline, into);
      return;
    case "comparison":
    case "arithmetic":
    case "logical":
      collectExpressionReads(expression.left, into);
      collectExpressionReads(expression.right, into);
      return;
    case "conditional":
      collectExpressionReads(expression.test, into);
      collectExpressionReads(expression.consequent, into);
      collectExpressionReads(expression.alternate, into);
      return;
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      collectExpressionReads(expression.argument, into);
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          collectExpressionReads(part.expression, into);
        }
      }
      return;
    case "artifact":
      collectExpressionReads(expression.path, into);
      return;
    case "host-call":
      for (const arg of expression.arguments) {
        collectHostCallArgumentReads(arg, into);
      }
      return;
    case "arrayElementRead":
      if (expression.array.kind === "cell") into.add(expression.array.name);
      collectExpressionReads(expression.index, into);
      return;
    case "arrayLength":
      if (expression.array.kind === "cell") into.add(expression.array.name);
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        collectExpressionReads(element, into);
      }
      return;
    default:
      return;
  }
}

function collectHostCallArgumentReads(
  arg: HostCallArgument,
  into: Set<string>,
): void {
  if (arg.kind === "value") {
    collectExpressionReads(arg.value, into);
  } else if (arg.kind === "array") {
    for (const item of arg.elements) collectHostCallArgumentReads(item, into);
  } else if (arg.kind === "object") {
    for (const item of Object.values(arg.value)) {
      collectHostCallArgumentReads(item, into);
    }
  }
}

// ---- Dead-cell read analysis -------------------------------------------
//
// With no default values, reading a cell before any action has set it
// is a dead-cell read (arc-runtime-api). Two static views of that hazard:
// a whole-arc view (a cell read but never set anywhere → warning) and
// a node-local view (a cell set in its node but read before that set on some
// path → notice). Reads come from every position that
// evaluates a cell: value expressions (conditions, set/return values,
// channel bindings, host-call arguments) and authored semantic-text
// interpolations (instruction templates, observe questions, guidance) — a
// `${var}` rendered into semantic text must read the cell to render it.

/** Visit a cell name read or written at a source location. */
type CellUse = (name: string, loc: SourceRange | undefined) => void;

/**
 * Walk every statement list (a node body or a hook body), reporting each
 * value-expression cell read through `onRead` and each cell write
 * (`set`, `observe`, `observeOrAsk`, or an enter `returns` binding) through
 * `onWrite`. An enter `args` binding reads its caller cell.
 */
function collectReadsAndWrites(
  statements: readonly BooleanLiteralSetStatement[],
  onRead: CellUse,
  onWrite: CellUse,
): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "if":
        emitExpressionReads(statement.test, statement.loc, onRead);
        collectReadsAndWrites(statement.consequent, onRead, onWrite);
        collectReadsAndWrites(statement.alternate ?? [], onRead, onWrite);
        break;
      case "label":
      case "invoke":
        collectReadsAndWrites(statement.body, onRead, onWrite);
        break;
      case "set":
        emitCellTargetReads(statement.target, statement.loc, onRead);
        emitExpressionReads(statement.value, statement.loc, onRead);
        if (isDirectCellTarget(statement.target)) {
          onWrite(cellTargetRoot(statement.target), statement.loc);
        }
        break;
      case "unset":
        break;
      case "observe":
      case "observeOrAsk":
        emitCellTargetReads(statement.target, statement.loc, onRead);
        if (statement.question) {
          emitSemanticReads(statement.question, statement.loc, onRead);
        }
        if (isDirectCellTarget(statement.target)) {
          onWrite(cellTargetRoot(statement.target), statement.loc);
        }
        break;
      case "observeGroup":
      case "observeOrAskGroup":
        for (const target of statement.targets) {
          emitCellTargetReads(target, statement.loc, onRead);
          if (isDirectCellTarget(target)) {
            onWrite(cellTargetRoot(target), statement.loc);
          }
        }
        break;
      case "map":
        if (statement.receiver.kind === "cell") {
          onRead(statement.receiver.name, statement.loc);
        }
        collectReadsAndWrites(statement.body, onRead, onWrite);
        if (statement.results) onWrite(statement.results, statement.loc);
        break;
      case "set-span":
      case "set-return":
        emitExpressionReads(statement.value, statement.loc, onRead);
        break;
      case "return":
        if (statement.value) {
          emitExpressionReads(statement.value, statement.loc, onRead);
        }
        break;
      case "enter-node":
        emitChannelUses(statement.args, statement.loc, onRead);
        emitChannelUses(statement.returns, statement.loc, onWrite);
        break;
      case "enter-loop":
        emitChannelUses(statement.args, statement.loc, onRead);
        emitChannelUses(statement.returns, statement.loc, onWrite);
        collectReadsAndWrites(statement.resolveWhen, onRead, onWrite);
        break;
      case "instruction":
        emitSemanticReads(statement.template, statement.loc, onRead);
        collectReadsAndWrites(statement.resolveWhen ?? [], onRead, onWrite);
        collectReadsAndWrites(statement.deflectWhen ?? [], onRead, onWrite);
        break;
      case "host-call": {
        const reads = new Set<string>();
        for (const arg of statement.arguments) {
          collectHostCallArgumentReads(arg, reads);
        }
        for (const name of reads) onRead(name, statement.loc);
        break;
      }
      default:
        break;
    }
  }
}

function emitExpressionReads(
  expression: ValueExpression,
  loc: SourceRange | undefined,
  onRead: CellUse,
): void {
  const reads = new Set<string>();
  collectExpressionReads(expression, reads);
  for (const name of reads) onRead(name, loc);
}

function emitCellTargetReads(
  target: CellTarget,
  loc: SourceRange | undefined,
  onRead: CellUse,
): void {
  const [root, ...accessors] = target;
  if (accessors.length === 0) return;
  onRead(root, loc);
  for (const accessor of accessors) {
    emitExpressionReads(accessor, loc, onRead);
  }
}

/** Add every cell name interpolated into authored semantic text to `into`. */
function collectSemanticStringReads(
  value: SemanticString,
  into: Set<string>,
): void {
  if (value.kind === "literal") return;
  for (const part of value.parts) {
    if (part.kind === "expression")
      collectExpressionReads(part.expression, into);
  }
}

function emitSemanticReads(
  value: SemanticString,
  loc: SourceRange | undefined,
  onRead: CellUse,
): void {
  const reads = new Set<string>();
  collectSemanticStringReads(value, reads);
  for (const name of reads) onRead(name, loc);
}

function emitChannelUses(
  bindings: EnterChannelBindings | undefined,
  loc: SourceRange | undefined,
  use: CellUse,
): void {
  if (!bindings) return;
  for (const source of Object.values(bindings)) {
    // Only a caller-cell source is a lexical cell use; an args projection is a
    // channel forward, not a cell read.
    if (source.kind === "cell") use(source.cell, loc);
  }
}

/**
 * Whole-arc view: flag every readable value cell that is read somewhere but
 * never set anywhere it is in scope. With no defaults such a read can only
 * ever be dead.
 */
export function lintArcCellReads(root: Node, lintIssues: LintIssue[]): void {
  const firstRead = new Map<Cell, SourceRange | undefined>();
  const assigned = new Set<Cell>();
  collectArcCellUsage(root, new Map(), firstRead, assigned);
  for (const [cell, loc] of firstRead) {
    if (!assigned.has(cell)) {
      emitLintIssue(lintIssues, "read-without-assignment", loc ?? cell.loc);
    }
  }
}

function collectArcCellUsage(
  node: Node,
  inheritedDeclarations: Map<string, Cell>,
  firstRead: Map<Cell, SourceRange | undefined>,
  assigned: Set<Cell>,
): void {
  // Static setness follows value readability, independently of semantic
  // observability. A non-readable declaration still shadows an inherited cell.
  const declarations = new Map(inheritedDeclarations);
  for (const cell of node.cells) {
    const name = cell.name;
    if (isValueExpressionCell(cell)) declarations.set(name, cell);
    else declarations.delete(name);
  }
  const onRead: CellUse = (name, loc) => {
    const cell = declarations.get(name);
    if (cell && !firstRead.has(cell)) firstRead.set(cell, loc);
  };
  const onWrite: CellUse = (name) => {
    const cell = declarations.get(name);
    if (cell) assigned.add(cell);
  };
  for (const cell of node.cells) {
    if (cell.type !== "artifact" || cell.initializer === undefined) continue;
    emitExpressionReads(cell.initializer, cell.loc, onRead);
    onWrite(cell.name, cell.loc);
  }
  for (const list of [
    node.statements,
    node.trigger,
    node.guard,
    node.deflectWhen,
    node.catchDeflection,
    node.effects,
  ]) {
    collectReadsAndWrites(list ?? [], onRead, onWrite);
  }
  // Node-level rendered semantic text also reads any cell it interpolates.
  if (node.guidance) emitSemanticReads(node.guidance, node.loc, onRead);
  for (const cell of node.cells) {
    const observing = isScalarObservableCell(cell)
      ? cell.observing
      : isArrayCell(cell) && cell.element.type !== "artifact"
        ? cell.element.observing
        : undefined;
    if (observing) {
      emitSemanticReads(observing, cell.loc, onRead);
    }
  }
  for (const child of node.children) {
    collectArcCellUsage(child, declarations, firstRead, assigned);
  }
}

/**
 * Node-local view: flag a read of a cell declared in this node that, on
 * some path, precedes every operation that sets it. Restricted to cells this
 * node does set somewhere (a never-set read is the whole-arc warning's
 * concern), so this is strictly the "read before set" ordering hazard.
 */
export function lintNodeReadBeforeSet(
  node: Node,
  lintIssues: LintIssue[],
): void {
  const local = new Set(
    node.cells.filter(isValueExpressionCell).map((cell) => cell.name),
  );
  if (local.size === 0) return;

  const qualifying = new Set<string>();
  const noteAssignment: CellUse = (name) => {
    if (local.has(name)) qualifying.add(name);
  };
  const ignore: CellUse = () => {};
  collectReadsAndWrites(node.statements, ignore, noteAssignment);
  collectReadsAndWrites(node.trigger ?? [], ignore, noteAssignment);
  for (const cell of node.cells) {
    if (cell.type === "artifact" && cell.initializer !== undefined) {
      qualifying.add(cell.name);
    }
  }
  if (qualifying.size === 0) return;

  const childrenById = new Map(
    node.children.map((child) => [child.identifier, child]),
  );
  // Trigger runs before the body, so cells it definitely sets are already live.
  const assigned = new Set<string>();
  const reported = new Set<string>();
  walkReadBeforeSet(
    node.trigger ?? [],
    assigned,
    qualifying,
    childrenById,
    reported,
    undefined,
  );
  for (const cell of node.cells) {
    if (cell.type !== "artifact" || cell.initializer === undefined) continue;
    const reads = new Set<string>();
    collectExpressionReads(cell.initializer, reads);
    for (const name of reads) {
      if (qualifying.has(name) && !assigned.has(name) && !reported.has(name)) {
        reported.add(name);
        emitLintIssue(lintIssues, "read-before-assignment", cell.loc);
      }
    }
    assigned.add(cell.name);
  }
  walkReadBeforeSet(
    node.statements,
    assigned,
    qualifying,
    childrenById,
    reported,
    lintIssues,
  );
}

/**
 * Static-setness walk of a statement list. `assigned` is mutated in place
 * with the cells certainly written once the list completes; branch arms are
 * intersected so a cell set in only one arm stays potentially unset after. An
 * invoke body shares the enclosing scope, so it is walked inline; a `$map`
 * callback is walked over a copy, since an empty input runs it zero times, and
 * only the map's `results` array counts as set after it. When `lintIssues` is
 * undefined the walk only accumulates set cells (used to seed from the trigger
 * stage); otherwise each first read-before-set of a
 * qualifying cell is reported once.
 */
function walkReadBeforeSet(
  statements: readonly BooleanLiteralSetStatement[],
  assigned: Set<string>,
  qualifying: Set<string>,
  childrenById: Map<string, Node>,
  reported: Set<string>,
  lintIssues: LintIssue[] | undefined,
): void {
  const report = (name: string, loc: SourceRange | undefined) => {
    if (!lintIssues) return;
    if (qualifying.has(name) && !assigned.has(name) && !reported.has(name)) {
      reported.add(name);
      emitLintIssue(lintIssues, "read-before-assignment", loc);
    }
  };
  const reportExpression = (
    expression: ValueExpression,
    loc: SourceRange | undefined,
  ) => {
    const reads = new Set<string>();
    collectExpressionReads(expression, reads);
    for (const name of reads) report(name, loc);
  };
  const reportSemantic = (
    value: SemanticString,
    loc: SourceRange | undefined,
  ) => {
    const reads = new Set<string>();
    collectSemanticStringReads(value, reads);
    for (const name of reads) report(name, loc);
  };

  for (const statement of statements) {
    switch (statement.kind) {
      case "if": {
        reportExpression(statement.test, statement.loc);
        const consequent = new Set(assigned);
        walkReadBeforeSet(
          statement.consequent,
          consequent,
          qualifying,
          childrenById,
          reported,
          lintIssues,
        );
        const alternate = new Set(assigned);
        walkReadBeforeSet(
          statement.alternate ?? [],
          alternate,
          qualifying,
          childrenById,
          reported,
          lintIssues,
        );
        for (const name of consequent) {
          if (alternate.has(name)) assigned.add(name);
        }
        break;
      }
      case "label":
        walkReadBeforeSet(
          statement.body,
          assigned,
          qualifying,
          childrenById,
          reported,
          lintIssues,
        );
        break;
      case "set":
        emitCellTargetReads(statement.target, statement.loc, report);
        reportExpression(statement.value, statement.loc);
        if (isDirectCellTarget(statement.target)) {
          assigned.add(cellTargetRoot(statement.target));
        }
        break;
      case "unset":
        assigned.delete(cellTargetRoot(statement.target));
        break;
      case "observe":
      case "observeOrAsk":
        emitCellTargetReads(statement.target, statement.loc, report);
        if (statement.question)
          reportSemantic(statement.question, statement.loc);
        if (isDirectCellTarget(statement.target)) {
          assigned.add(cellTargetRoot(statement.target));
        }
        break;
      case "observeGroup":
      case "observeOrAskGroup":
        for (const target of statement.targets) {
          emitCellTargetReads(target, statement.loc, report);
          if (isDirectCellTarget(target)) {
            assigned.add(cellTargetRoot(target));
          }
        }
        break;
      case "map": {
        if (statement.receiver.kind === "cell") {
          report(statement.receiver.name, statement.loc);
        }
        // The callback may not run at all, so its writes are not definite.
        walkReadBeforeSet(
          statement.body,
          new Set(assigned),
          qualifying,
          childrenById,
          reported,
          lintIssues,
        );
        if (statement.results) assigned.add(statement.results);
        break;
      }
      case "set-span":
      case "set-return":
        reportExpression(statement.value, statement.loc);
        break;
      case "return":
        if (statement.value) reportExpression(statement.value, statement.loc);
        break;
      case "enter-node":
        if (statement.args) {
          for (const source of Object.values(statement.args)) {
            if (source.kind === "cell") report(source.cell, statement.loc);
          }
        }
        if (statement.returns) {
          for (const source of Object.values(statement.returns)) {
            if (source.kind === "cell") assigned.add(source.cell);
          }
        }
        break;
      case "invoke":
        // An invoke body shares the enclosing scope, so it is walked inline.
        walkReadBeforeSet(
          statement.body,
          assigned,
          qualifying,
          childrenById,
          reported,
          lintIssues,
        );
        break;
      case "enter-loop":
        if (statement.args) {
          for (const source of Object.values(statement.args)) {
            if (source.kind === "cell") report(source.cell, statement.loc);
          }
        }
        if (statement.returns) {
          for (const source of Object.values(statement.returns)) {
            if (source.kind === "cell") assigned.add(source.cell);
          }
        }
        break;
      case "instruction":
        reportSemantic(statement.template, statement.loc);
        break;
      default:
        break;
    }
  }
}
