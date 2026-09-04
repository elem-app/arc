import type * as acorn from "acorn";

import {
  UNSTAMPED_ID,
  type ArithmeticOperator,
  type ArrayReference,
  type ArtifactConstructExpression,
  type CellTarget,
  type ComparisonOperator,
  type HostCallArgument,
  type LocalExpression,
  type SemanticString,
  type SourceRange,
  type TemplateString,
  type TemplateStringPart,
  type ValueExpression,
  type ValueStringPart,
} from "../types/parser.js";
import { classifyArtifactPath } from "../types/value.js";
import { describeArtifactPathIssue } from "../value-utils.js";
import { parseTarget, type TargetParseContext } from "./targets.js";

export type ExpressionParseContext = {
  deflectionTargets?: TargetParseContext;
  allowPendingState?: boolean;
};

export function getName(
  node: acorn.Node | null | undefined,
): string | undefined {
  if (node?.type !== "Identifier") return undefined;
  return (node as acorn.Identifier).name;
}

export function getThisProperty(
  node: acorn.Expression | null | undefined,
): string | undefined {
  if (!node || node.type !== "MemberExpression") return undefined;
  if (node.object.type !== "ThisExpression") return undefined;
  return getName(node.property as acorn.Node);
}

export function getMemberTarget(node: acorn.Expression | null | undefined):
  | {
      object: string;
      property: string;
    }
  | undefined {
  if (!node || node.type !== "MemberExpression") return undefined;
  const object = getName(node.object as acorn.Node);
  const property = getName(node.property as acorn.Node);
  if (!object || !property) return undefined;
  return { object, property };
}

export function locOf(
  node: acorn.Node | null | undefined,
): SourceRange | undefined {
  if (!node || !("loc" in node) || !node.loc) return undefined;
  return {
    start: { line: node.loc.start.line, column: node.loc.start.column + 1 },
    end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
  };
}

export function getFunctionBody(
  node: acorn.Expression | null | undefined,
): acorn.Statement[] | undefined {
  if (!node) return undefined;
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    if (node.body.type === "BlockStatement") {
      return node.body.body;
    }
  }
  return undefined;
}

/**
 * Extracts a hook arrow's body as statements, accepting a concise (expression)
 * body in addition to a block. A block body returns its statements directly; a
 * concise body is wrapped as a single statement — a `return <expr>` for
 * value-returning hooks (`conciseAs: "return"`), or an expression statement for
 * effect bodies (`conciseAs: "expression"`) — so `() => judge(x)` reads exactly
 * like `() => { return judge(x); }`. Only an arrow is accepted (every hook is
 * authored as an arrow, never a `function` expression); a non-arrow node returns
 * `undefined`, so callers keep their "must be an arrow function" guard.
 */
export function getHookBodyStatements(
  node: acorn.Expression | null | undefined,
  conciseAs: "return" | "expression",
): acorn.Statement[] | undefined {
  if (!node || node.type !== "ArrowFunctionExpression") return undefined;
  if (node.body.type === "BlockStatement") {
    return node.body.body;
  }
  const expression = node.body;
  const wrapped =
    conciseAs === "return"
      ? {
          type: "ReturnStatement",
          argument: expression,
          start: expression.start,
          end: expression.end,
          loc: expression.loc,
        }
      : {
          type: "ExpressionStatement",
          expression,
          start: expression.start,
          end: expression.end,
          loc: expression.loc,
        };
  return [wrapped as unknown as acorn.Statement];
}

export function getBlockStatements(node: acorn.Statement): acorn.Statement[] {
  return node.type === "BlockStatement" ? node.body : [node];
}

export function expressionToLocalExpression(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  briefable?: boolean,
  context?: ExpressionParseContext,
): LocalExpression {
  if (node.type === "Literal") {
    const value = node.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return { kind: "literal", value };
    }
  }

  if (node.type === "Identifier") {
    return { kind: "cell", name: node.name };
  }

  if (node.type === "BinaryExpression") {
    if (!isArithmeticOperator(node.operator)) {
      throw new Error(`Unsupported local binary operator: ${node.operator}`);
    }
    return {
      kind: "arithmetic",
      op: node.operator,
      left: expressionToLocalExpression(
        node.left as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
      right: expressionToLocalExpression(
        node.right as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "UnaryExpression" && node.operator === "-") {
    return {
      kind: "numericUnary",
      op: "-",
      argument: expressionToLocalExpression(
        node.argument as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "MemberExpression") {
    if (node.computed) {
      // Bracket indexing `items[index]` / `args.items[index]` is an element
      // read on a cell or typed array channel. Any other computed access stays
      // rejected.
      const array = parseArrayReference(
        node.object as acorn.Expression,
        availableHostModules,
      );
      if (!array) {
        throw new Error("Computed member access is not supported in Arc");
      }
      if (node.property.type === "PrivateIdentifier") {
        throw new Error("Array index cannot be a private identifier");
      }
      return {
        kind: "arrayElementRead",
        array,
        index: expressionToLocalExpression(
          node.property,
          availableHostModules,
          briefable,
          context,
        ),
      };
    }
    if (
      node.object.type === "Identifier" &&
      node.object.name === "Dialog" &&
      node.property.type === "Identifier" &&
      node.property.name === "lastUserMessage"
    ) {
      return { kind: "scope", name: "lastUserMessage" };
    }
    if (
      node.object.type === "Identifier" &&
      node.object.name === "Dialog" &&
      node.property.type === "Identifier" &&
      node.property.name === "cursor"
    ) {
      return { kind: "dialogCursor" };
    }
    if (
      node.object.type === "Identifier" &&
      node.object.name === "State" &&
      node.property.type === "Identifier"
    ) {
      return {
        kind: "literal",
        value: node.property.name.toLowerCase() as never,
      };
    }
    if (
      node.object.type === "Identifier" &&
      node.property.type === "Identifier" &&
      node.property.name === "state"
    ) {
      return { kind: "nodeState", identifier: node.object.name };
    }
    if (
      node.property.type === "Identifier" &&
      node.property.name === "length"
    ) {
      const array = parseArrayReference(
        node.object as acorn.Expression,
        availableHostModules,
      );
      if (array) return { kind: "arrayLength", array };
    }
    if (
      node.object.type === "Identifier" &&
      (node.object.name === "args" || node.object.name === "returns") &&
      node.property.type === "Identifier"
    ) {
      return {
        kind: "channel",
        namespace: node.object.name,
        key: node.property.name,
      };
    }
    // `span.item` / `span.index` read the current `$map` member. The owner is
    // `map` — the only span owner in v1; other owners join as they land.
    if (
      node.object.type === "Identifier" &&
      node.object.name === "span" &&
      node.property.type === "Identifier" &&
      (node.property.name === "item" || node.property.name === "index")
    ) {
      return { kind: "span", owner: "map", key: node.property.name };
    }
  }
  if (node.type === "CallExpression") {
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Dialog" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "lastTurns"
    ) {
      const arg = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        !arg ||
        arg.type === "SpreadElement" ||
        arg.type !== "Literal" ||
        typeof arg.value !== "number" ||
        !Number.isSafeInteger(arg.value) ||
        arg.value < 0
      ) {
        throw new Error(
          "Dialog.lastTurns() count must be a non-negative safe-integer literal",
        );
      }
      const count = arg.value;
      return { kind: "scope", name: "lastTurns", count };
    }
  }

  if (node.type === "MemberExpression") {
    const prop = getThisProperty(node);
    if (prop === "enterCount") {
      return { kind: "enterCount" };
    }
    if (prop === "pendingState") {
      if (!context?.allowPendingState) {
        throw new Error(
          "this.pendingState is only available inside this.effects",
        );
      }
      return { kind: "pendingState" };
    }
  }

  throw new Error(`Unsupported value expression: ${node.type}`);
}

/**
 * Parses an action target as one lexical cell root followed by inner-value
 * accessors. Dot access and a computed string access intentionally normalize to
 * the same literal accessor; the current target schema decides whether that
 * accessor is valid for the root value.
 */
export function parseCellTarget(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  context?: ExpressionParseContext,
): CellTarget {
  if (node.type === "Identifier") {
    if (availableHostModules.has(node.name)) {
      throw new Error(`Cell target cannot use host module ${node.name}`);
    }
    return [node.name];
  }
  if (node.type !== "MemberExpression" || node.object.type === "Super") {
    throw new Error("Cell target must start from a cell identifier");
  }

  const target = parseCellTarget(
    node.object as acorn.Expression,
    availableHostModules,
    context,
  );
  if (!node.computed) {
    if (node.property.type !== "Identifier") {
      throw new Error("Cell target property must be an identifier");
    }
    return [...target, { kind: "literal", value: node.property.name }];
  }
  if (node.property.type === "PrivateIdentifier") {
    throw new Error("Cell target accessor cannot be a private identifier");
  }
  return [
    ...target,
    expressionToLocalExpression(
      node.property,
      availableHostModules,
      true,
      context,
    ),
  ];
}

/**
 * Recognizes the receiver of a bracket index or `.length` read: a bare cell
 * identifier or a typed array channel projection (`args.items` / `returns.items`).
 * Returns `undefined` for any other expression, so element and length reads are
 * admitted only on direct cell or channel references.
 */
function parseArrayReference(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): ArrayReference | undefined {
  if (node.type === "Identifier") {
    // A host-module identifier is not a cell; a computed access on it stays a
    // rejected dynamic host-member reference, not an element read.
    if (availableHostModules.has(node.name)) return undefined;
    return { kind: "cell", name: node.name };
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    (node.object.name === "args" || node.object.name === "returns") &&
    node.property.type === "Identifier"
  ) {
    return {
      kind: "channel",
      namespace: node.object.name,
      key: node.property.name,
    };
  }
  return undefined;
}

export function parseExpression(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  briefable?: boolean,
  context?: ExpressionParseContext,
): ValueExpression {
  if (node.type === "TemplateLiteral") {
    const template = parseTemplateString(
      node,
      availableHostModules,
      briefable,
      context,
    );

    // Reject semantic string parts
    const parts: ValueStringPart[] = [];
    for (const part of template.parts) {
      if (part.kind === "ref" || part.kind === "hostVar") {
        throw new Error(
          "Template literal contains semantic-only interpolation in value position",
        );
      }
      parts.push(part);
    }
    return { kind: "template-string", parts };
  }

  if (node.type === "ArrayExpression") {
    return {
      kind: "arrayLiteral",
      elements: node.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Array literals do not support holes or spread");
        }
        return parseExpression(
          element,
          availableHostModules,
          briefable,
          context,
        );
      }),
    };
  }

  if (node.type === "LogicalExpression") {
    if (node.operator !== "&&" && node.operator !== "||") {
      throw new Error(`Unsupported logical operator: ${node.operator}`);
    }
    return {
      kind: "logical",
      op: node.operator,
      left: parseExpression(
        node.left,
        availableHostModules,
        briefable,
        context,
      ),
      right: parseExpression(
        node.right,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "UnaryExpression") {
    if (node.operator === "-") {
      return {
        kind: "numericUnary",
        op: "-",
        argument: parseExpression(
          node.argument as acorn.Expression,
          availableHostModules,
          briefable,
          context,
        ),
      };
    }
    if (node.operator !== "!") {
      throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
    return {
      kind: "unary",
      op: "!",
      argument: parseExpression(
        node.argument as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "BinaryExpression") {
    if (isArithmeticOperator(node.operator)) {
      return {
        kind: "arithmetic",
        op: node.operator,
        left: parseExpression(
          node.left as acorn.Expression,
          availableHostModules,
          briefable,
          context,
        ),
        right: parseExpression(
          node.right as acorn.Expression,
          availableHostModules,
          briefable,
          context,
        ),
      };
    }
    if (!isComparisonOperator(node.operator)) {
      throw new Error(`Unsupported binary operator: ${node.operator}`);
    }
    return {
      kind: "comparison",
      op: node.operator,
      left: parseExpression(
        node.left as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
      right: parseExpression(
        node.right as acorn.Expression,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "ConditionalExpression") {
    return {
      kind: "conditional",
      test: parseExpression(
        node.test,
        availableHostModules,
        briefable,
        context,
      ),
      consequent: parseExpression(
        node.consequent,
        availableHostModules,
        briefable,
        context,
      ),
      alternate: parseExpression(
        node.alternate,
        availableHostModules,
        briefable,
        context,
      ),
    };
  }

  if (node.type === "CallExpression") {
    if (node.callee.type === "Identifier" && node.callee.name === "Artifact") {
      return parseArtifactConstructCall(
        node,
        "Artifact value",
        availableHostModules,
        briefable,
        context,
      );
    }
    if (isNumIsFiniteCall(node, availableHostModules)) {
      const arg = node.arguments[0];
      if (node.arguments.length !== 1 || !arg || arg.type === "SpreadElement") {
        throw new Error("Num.isFinite() accepts exactly one argument");
      }
      return {
        kind: "numIsFinite",
        argument: parseExpression(
          arg,
          availableHostModules,
          briefable,
          context,
        ),
      };
    }
    if (
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      !availableHostModules.has(node.callee.object.name) &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "isUnset"
    ) {
      if (node.arguments.length !== 0) {
        throw new Error("cell.isUnset() does not accept arguments");
      }
      return {
        kind: "isUnset",
        cell: node.callee.object.name,
      };
    }
    // `args.x.isUnset()` / `returns.x.isUnset()` on a typed channel.
    if (
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "MemberExpression" &&
      !node.callee.object.computed &&
      node.callee.object.object.type === "Identifier" &&
      (node.callee.object.object.name === "args" ||
        node.callee.object.object.name === "returns") &&
      node.callee.object.property.type === "Identifier" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "isUnset"
    ) {
      if (node.arguments.length !== 0) {
        throw new Error("channel.isUnset() does not accept arguments");
      }
      return {
        kind: "channelIsUnset",
        namespace: node.callee.object.object.name,
        key: node.callee.object.property.name,
      };
    }
    if (isDeflectionEscapedCall(node)) {
      if (!context?.deflectionTargets) {
        throw new Error(
          "this.deflection.escaped(...) is only available inside this.catchDeflection or this.effects",
        );
      }
      if (node.arguments.length !== 1) {
        throw new Error("this.deflection.escaped() accepts exactly one target");
      }
      return {
        kind: "deflectionEscaped",
        target: parseTarget(
          node.arguments[0],
          "deflectionEscaped",
          context.deflectionTargets,
        ),
      };
    }
    if (isDialogLastTurnsCall(node)) {
      return expressionToLocalExpression(node, availableHostModules, briefable);
    }
    if (isDialogTurnsSinceCall(node, availableHostModules)) {
      return parseDialogTurnsSinceCall(node, availableHostModules, briefable);
    }
    if (node.callee.type !== "Super") {
      const hostCallTarget = parseHostCallTarget(
        node.callee,
        availableHostModules,
      );
      if (hostCallTarget) {
        if (hostCallTarget.operation.startsWith("$")) {
          throw new Error(
            "$-prefixed host operations are only valid as standalone action statements",
          );
        }
        if (!briefable) {
          throw new Error(
            "Host call expressions are not allowed in this position",
          );
        }
        return {
          id: UNSTAMPED_ID,
          kind: "host-call",
          module: hostCallTarget.module,
          target: hostCallTarget.path,
          operation: hostCallTarget.operation,
          arguments: node.arguments.map((arg) => {
            if (arg.type === "SpreadElement") {
              throw new Error("Host calls do not support spread arguments");
            }
            return parseHostCallArgument(
              arg,
              availableHostModules,
              briefable,
              context,
            );
          }),
          loc: locOf(node),
        };
      }
    }
    if (isJudgeCall(node)) {
      const arg = node.arguments[0];
      if (!arg || arg.type === "SpreadElement") {
        throw new Error("judge() expects semantic text");
      }
      if (!briefable) {
        throw new Error("judge() is not allowed in this position");
      }
      return {
        id: UNSTAMPED_ID,
        kind: "judge",
        question: parseSemanticString(arg, availableHostModules, context),
        loc: locOf(node),
      };
    }
    if (isRegexTest(node)) {
      const callee = node.callee as acorn.MemberExpression;
      const object = callee.object as acorn.Literal;
      const target = node.arguments[0];
      if (!target || target.type === "SpreadElement") {
        throw new Error("Regex test requires a target");
      }
      const regex = object.regex;
      if (!regex) {
        throw new Error("Regex literal metadata missing");
      }
      return {
        kind: "regexTest",
        pattern: regex.pattern,
        flags: regex.flags,
        target: expressionToLocalExpression(
          target,
          availableHostModules,
          briefable,
          context,
        ),
      };
    }
  }

  return expressionToLocalExpression(
    node,
    availableHostModules,
    briefable,
    context,
  );
}

/** Parses the shared declaration- and value-site Artifact constructor. */
export function parseArtifactConstructCall(
  call: acorn.CallExpression,
  owner: string,
  availableHostModules: ReadonlyMap<string, string>,
  briefable: boolean | undefined,
  context?: ExpressionParseContext,
): ArtifactConstructExpression {
  if (call.arguments.length !== 1) {
    throw new Error(`${owner} requires one path argument`);
  }
  const argument = call.arguments[0];
  if (!argument || argument.type === "SpreadElement") {
    throw new Error(`${owner} path does not support spread`);
  }
  let path: ValueExpression;
  try {
    path = parseExpression(argument, availableHostModules, briefable, context);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${owner} path must be a value expression${detail}`);
  }
  if (path.kind === "literal" && typeof path.value === "string") {
    const issue = classifyArtifactPath(path.value);
    if (issue !== undefined) {
      throw new Error(`${owner} path ${describeArtifactPathIssue(issue)}`);
    }
  }
  return { kind: "artifact", path };
}

function isArithmeticOperator(
  operator: string,
): operator is ArithmeticOperator {
  return (
    operator === "+" ||
    operator === "-" ||
    operator === "*" ||
    operator === "/" ||
    operator === "%"
  );
}

function isComparisonOperator(
  operator: string,
): operator is ComparisonOperator {
  return (
    operator === "==" ||
    operator === "!=" ||
    operator === ">" ||
    operator === ">=" ||
    operator === "<" ||
    operator === "<="
  );
}

function isNumIsFiniteCall(
  node: acorn.CallExpression,
  availableHostModules: ReadonlyMap<string, string>,
): boolean {
  return (
    !availableHostModules.has("Num") &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Num" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "isFinite"
  );
}

function isDeflectionEscapedCall(node: acorn.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "MemberExpression" &&
    !node.callee.object.computed &&
    node.callee.object.object.type === "ThisExpression" &&
    node.callee.object.property.type === "Identifier" &&
    node.callee.object.property.name === "deflection" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "escaped"
  );
}

export function parseHostCallTarget(
  expression: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[]; operation: string } | undefined {
  if (expression.type !== "MemberExpression") return undefined;
  const operation = getStaticMemberSegment(expression);
  if (!operation) {
    throw new Error("Host calls do not support computed member access");
  }
  if (expression.object.type === "Super") {
    throw new Error("Host calls do not support super member access");
  }
  const parent = parseHostCallTargetRoot(
    expression.object,
    availableHostModules,
  );
  if (!parent) return undefined;
  return {
    module: parent.module,
    path: parent.path,
    operation,
  };
}

function parseHostCallTargetRoot(
  expression: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[] } | undefined {
  if (expression.type === "Identifier") {
    const module = availableHostModules.get(expression.name);
    if (!module) return undefined;
    return { module, path: [] };
  }
  if (expression.type !== "MemberExpression") return undefined;
  const segment = getStaticMemberSegment(expression);
  if (!segment) {
    throw new Error("Host calls do not support computed member access");
  }
  if (expression.object.type === "Super") {
    throw new Error("Host calls do not support super member access");
  }
  const parent = parseHostCallTargetRoot(
    expression.object,
    availableHostModules,
  );
  if (!parent) return undefined;
  return {
    module: parent.module,
    path: [...parent.path, segment],
  };
}

function isDialogLastTurnsCall(node: acorn.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Dialog" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "lastTurns"
  );
}

/**
 * Detects a cursor turn-difference method call — `receiver.userTurnsSince(...)`
 * and its self/total siblings. The receiver must be a cursor value: the live
 * `Dialog.cursor` accessor or a `Dialog.Cursor` cell (a bare identifier).
 * A host-module identifier receiver is excluded so host calls keep their path.
 */
function isDialogTurnsSinceCall(
  node: acorn.CallExpression,
  availableHostModules: ReadonlyMap<string, string>,
): boolean {
  if (
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier"
  ) {
    return false;
  }
  const method = node.callee.property.name;
  if (
    method !== "userTurnsSince" &&
    method !== "selfTurnsSince" &&
    method !== "totalTurnsSince"
  ) {
    return false;
  }
  const receiver = node.callee.object;
  if (isDialogCursorAccess(receiver)) return true;
  return (
    receiver.type === "Identifier" && !availableHostModules.has(receiver.name)
  );
}

function isDialogCursorAccess(node: acorn.Expression | acorn.Super): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "Dialog" &&
    node.property.type === "Identifier" &&
    node.property.name === "cursor"
  );
}

function parseDialogTurnsSinceCall(
  node: acorn.CallExpression,
  availableHostModules: ReadonlyMap<string, string>,
  briefable?: boolean,
): LocalExpression {
  const callee = node.callee;
  const operation =
    callee.type === "MemberExpression" && callee.property.type === "Identifier"
      ? callee.property.name
      : undefined;
  if (
    operation !== "userTurnsSince" &&
    operation !== "selfTurnsSince" &&
    operation !== "totalTurnsSince"
  ) {
    throw new Error("Unsupported cursor turn-difference method");
  }
  const receiverNode = (callee as acorn.MemberExpression).object;
  if (receiverNode.type === "Identifier" && receiverNode.name === "Dialog") {
    throw new Error(
      `Dialog.${operation}() was replaced by cursor methods; call ${operation}() on a cursor value, e.g. Dialog.cursor.${operation}(startedAt)`,
    );
  }
  if (node.arguments.length !== 1) {
    throw new Error(`.${operation}() accepts exactly one cursor`);
  }
  const arg = node.arguments[0];
  if (!arg || arg.type === "SpreadElement") {
    throw new Error(`.${operation}() requires a cursor`);
  }
  if (receiverNode.type === "Super") {
    throw new Error(`.${operation}() has no valid cursor receiver`);
  }
  return {
    kind: "dialogTurnsSince",
    metric:
      operation === "userTurnsSince"
        ? "user"
        : operation === "selfTurnsSince"
          ? "self"
          : "total",
    receiver: expressionToLocalExpression(
      receiverNode,
      availableHostModules,
      briefable,
    ),
    baseline: expressionToLocalExpression(arg, availableHostModules, briefable),
  };
}

export function parseHostCallArgument(
  expression: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  briefable?: boolean,
  context?: ExpressionParseContext,
): HostCallArgument {
  if (
    expression.type === "TemplateLiteral" ||
    (expression.type === "Literal" && typeof expression.value === "string")
  ) {
    return {
      kind: "semantic",
      value: parseSemanticString(expression, availableHostModules, context),
    };
  }
  if (expression.type === "ArrayExpression") {
    return {
      kind: "array",
      elements: expression.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Host call arrays do not support holes or spread");
        }
        return parseHostCallArgument(
          element,
          availableHostModules,
          briefable,
          context,
        );
      }),
    };
  }
  if (expression.type === "ObjectExpression") {
    const value: Record<string, HostCallArgument> = {};
    for (const property of expression.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("Host call objects do not support spread");
      }
      if (property.computed) {
        throw new Error("Host call objects do not support computed keys");
      }
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal" &&
              typeof property.key.value === "string"
            ? property.key.value
            : undefined;
      if (!key) {
        throw new Error("Host call objects require identifier or string keys");
      }
      value[key] = parseHostCallArgument(
        property.value,
        availableHostModules,
        briefable,
        context,
      );
    }
    return { kind: "object", value };
  }
  const value = parseExpression(
    expression,
    availableHostModules,
    briefable,
    context,
  );
  if (containsBriefableExpression(value)) {
    throw new Error("Host call arguments cannot contain briefable expressions");
  }
  return {
    kind: "value",
    value,
  };
}

export function containsBriefableExpression(
  expression: ValueExpression,
): boolean {
  switch (expression.kind) {
    case "judge":
    case "host-call":
      return true;
    case "regexTest":
      return containsBriefableExpression(expression.target);
    case "comparison":
    case "arithmetic":
    case "logical":
      return (
        containsBriefableExpression(expression.left) ||
        containsBriefableExpression(expression.right)
      );
    case "conditional":
      return (
        containsBriefableExpression(expression.test) ||
        containsBriefableExpression(expression.consequent) ||
        containsBriefableExpression(expression.alternate)
      );
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return containsBriefableExpression(expression.argument);
    case "template-string":
      return expression.parts.some(
        (part) =>
          part.kind === "expression" &&
          containsBriefableExpression(part.expression),
      );
    case "artifact":
      return containsBriefableExpression(expression.path);
    case "arrayElementRead":
      return containsBriefableExpression(expression.index);
    case "arrayLiteral":
      return expression.elements.some((element) =>
        containsBriefableExpression(element),
      );
    default:
      return false;
  }
}

export function isJudgeCall(node: acorn.CallExpression): boolean {
  return node.callee.type === "Identifier" && node.callee.name === "judge";
}

export function isRegexTest(node: acorn.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Literal" &&
    !!node.callee.object.regex &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "test"
  );
}

export function parseTemplateString(
  node: acorn.TemplateLiteral,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  briefable?: boolean,
  context?: ExpressionParseContext,
): TemplateString {
  const parts: TemplateStringPart[] = [];

  for (let index = 0; index < node.quasis.length; index++) {
    const quasi = node.quasis[index];
    if (!quasi) continue;
    const rawText = quasi.value.cooked ?? quasi.value.raw;
    if (rawText.length > 0) {
      parts.push({ kind: "text", value: rawText });
    }

    const expression = node.expressions[index];
    if (expression) {
      const participant = matchDialogParticipantReference(expression);
      if (participant) {
        parts.push({ kind: "ref", name: participant });
        continue;
      }
      const hostVar = matchHostVarReference(expression, availableHostModules);
      if (hostVar) {
        parts.push({
          kind: "hostVar",
          module: hostVar.module,
          path: hostVar.path,
        });
        continue;
      }
      parts.push({
        kind: "expression",
        expression: parseExpression(
          expression,
          availableHostModules,
          briefable,
          context,
        ),
      });
    }
  }

  return {
    kind: "template-string",
    parts,
  };
}

function matchDialogParticipantReference(
  node: acorn.Expression,
): "user" | "self" | undefined {
  if (
    node.type === "Identifier" &&
    (node.name === "user" || node.name === "self")
  ) {
    return node.name;
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "Dialog" &&
    node.property.type === "Identifier" &&
    (node.property.name === "user" || node.property.name === "self")
  ) {
    return node.property.name;
  }
  return undefined;
}

export function parseSemanticString(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  context?: ExpressionParseContext,
): SemanticString {
  if (node.type === "Literal" && typeof node.value === "string") {
    return { kind: "literal", value: node.value };
  }
  if (node.type === "TemplateLiteral") {
    return parseTemplateString(node, availableHostModules, undefined, context);
  }
  throw new Error("Semantic text must be a string or template literal");
}

/**
 * Match a host-module member reference of the form `A.x`, `A["x"]`, or nested
 * combinations where `A` is a host-module binding. Returns the module name and
 * member path, or `undefined` when the expression is not a host-module member
 * reference.
 */
export function matchHostVarReference(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[] } | undefined {
  if (node.type !== "MemberExpression") return undefined;
  return walkHostVarMemberChain(node, availableHostModules);
}

function walkHostVarMemberChain(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[] } | undefined {
  if (node.type === "Identifier") {
    const module = availableHostModules.get(node.name);
    if (!module) return undefined;
    return { module, path: [] };
  }
  if (node.type !== "MemberExpression") return undefined;
  const segment = getStaticMemberSegment(node);
  if (!segment) return undefined;
  if (node.object.type === "Super") return undefined;
  const parent = walkHostVarMemberChain(node.object, availableHostModules);
  if (!parent) return undefined;
  return {
    module: parent.module,
    path: [...parent.path, segment],
  };
}

function getStaticMemberSegment(
  node: acorn.MemberExpression,
): string | undefined {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string" &&
    node.property.value.length > 0
  ) {
    return node.property.value;
  }
  return undefined;
}
