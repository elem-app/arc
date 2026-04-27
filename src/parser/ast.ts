import type * as acorn from "acorn";

import type {
  BinaryOperator,
  HostCallArgument,
  LocalExpression,
  SemanticPart,
  SemanticString,
  SourceRange,
  ValueExpression,
} from "../types.js";
import { parseTarget, type TargetParseContext } from "./targets.js";

export function isExpressionStatement(
  node: acorn.Statement | acorn.ModuleDeclaration,
): node is acorn.ExpressionStatement {
  return node.type === "ExpressionStatement";
}

export function isFunctionDeclaration(
  node: acorn.Statement | acorn.ModuleDeclaration,
): node is acorn.FunctionDeclaration {
  return node.type === "FunctionDeclaration";
}

export function isVariableDeclaration(
  node: acorn.Statement | acorn.ModuleDeclaration,
): node is acorn.VariableDeclaration {
  return node.type === "VariableDeclaration";
}

export function isAssignmentExpression(
  node: acorn.Expression,
): node is acorn.AssignmentExpression {
  return node.type === "AssignmentExpression";
}

export function isMemberExpression(
  node: acorn.Expression,
): node is acorn.MemberExpression {
  return node.type === "MemberExpression";
}

export function isIdentifier(
  node: acorn.Node | null | undefined,
): node is acorn.Identifier {
  return !!node && node.type === "Identifier";
}

export function isLiteral(
  node: acorn.Node | null | undefined,
): node is acorn.Literal {
  return !!node && node.type === "Literal";
}

export function isTemplateLiteral(
  node: acorn.Node | null | undefined,
): node is acorn.TemplateLiteral {
  return !!node && node.type === "TemplateLiteral";
}

export function isCallExpression(
  node: acorn.Node | null | undefined,
): node is acorn.CallExpression {
  return !!node && node.type === "CallExpression";
}

export function isNewExpression(
  node: acorn.Node | null | undefined,
): node is acorn.NewExpression {
  return !!node && node.type === "NewExpression";
}

export function isIfStatement(
  node: acorn.Statement,
): node is acorn.IfStatement {
  return node.type === "IfStatement";
}

export function isLabeledStatement(
  node: acorn.Statement,
): node is acorn.LabeledStatement {
  return node.type === "LabeledStatement";
}

export function isBreakStatement(
  node: acorn.Statement,
): node is acorn.BreakStatement {
  return node.type === "BreakStatement";
}

export function isReturnStatement(
  node: acorn.Statement,
): node is acorn.ReturnStatement {
  return node.type === "ReturnStatement";
}

export function isImportDeclaration(
  node: acorn.Statement | acorn.ModuleDeclaration,
): node is acorn.ImportDeclaration {
  return node.type === "ImportDeclaration";
}

export function getName(
  node: acorn.Node | null | undefined,
): string | undefined {
  return isIdentifier(node) ? node.name : undefined;
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

export function getBlockStatements(node: acorn.Statement): acorn.Statement[] {
  return node.type === "BlockStatement" ? node.body : [node];
}

export function expressionToLocalExpression(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  nextId?: () => number,
): LocalExpression {
  if (isLiteral(node)) {
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

  if (isIdentifier(node)) {
    if (node.name === "user" || node.name === "self") {
      return { kind: "ref", name: node.name };
    }
    return { kind: "variable", name: node.name };
  }

  if (node.type === "MemberExpression") {
    if (node.computed) {
      throw new Error("Computed member access is not supported in Arc");
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
      const count =
        arg &&
        arg.type !== "SpreadElement" &&
        isLiteral(arg) &&
        typeof arg.value === "number"
          ? arg.value
          : undefined;
      return { kind: "scope", name: "lastTurns", count };
    }
  }

  if (node.type === "MemberExpression") {
    const prop = getThisProperty(node);
    if (prop === "enterCount") {
      return { kind: "enterCount" };
    }
  }

  throw new Error(`Unsupported value expression: ${node.type}`);
}

export function parseExpression(
  node: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string> = new Map(),
  nextId?: () => number,
  targetContext?: TargetParseContext,
): ValueExpression {
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
        nextId,
        targetContext,
      ),
      right: parseExpression(
        node.right,
        availableHostModules,
        nextId,
        targetContext,
      ),
    };
  }

  if (node.type === "UnaryExpression") {
    if (node.operator !== "!") {
      throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
    return {
      kind: "unary",
      op: "!",
      argument: parseExpression(
        node.argument as acorn.Expression,
        availableHostModules,
        nextId,
        targetContext,
      ),
    };
  }

  if (node.type === "BinaryExpression") {
    return {
      kind: "binary",
      op: node.operator as BinaryOperator,
      left: parseExpression(
        node.left as acorn.Expression,
        availableHostModules,
        nextId,
        targetContext,
      ),
      right: parseExpression(
        node.right as acorn.Expression,
        availableHostModules,
        nextId,
        targetContext,
      ),
    };
  }

  if (node.type === "CallExpression") {
    if (isDeflectionFromCall(node)) {
      if (!targetContext) {
        throw new Error(
          "deflection.from(...) is only available inside this.catchDeflection",
        );
      }
      if (node.arguments.length !== 1) {
        throw new Error("deflection.from() accepts exactly one target");
      }
      return {
        kind: "deflectionFrom",
        target: parseTarget(node.arguments[0], "deflectionFrom", targetContext),
      };
    }
    if (node.callee.type !== "Super") {
      const hostCallTarget = parseHostCallTarget(
        node.callee,
        availableHostModules,
      );
      if (hostCallTarget) {
        if (!nextId) {
          throw new Error("Host call expressions require an id allocator");
        }
        return {
          id: nextId(),
          kind: "host-call",
          module: hostCallTarget.module,
          target: hostCallTarget.path,
          operation: hostCallTarget.operation,
          arguments: node.arguments.map((arg) => {
            if (arg.type === "SpreadElement") {
              throw new Error("Host calls do not support spread arguments");
            }
            return parseHostCallArgument(arg);
          }),
          loc: locOf(node),
        };
      }
    }
    if (isJudgeCall(node)) {
      const arg = node.arguments[0];
      if (!arg || arg.type === "SpreadElement" || !isTemplateLiteral(arg)) {
        throw new Error("judge() expects a template literal");
      }
      if (!nextId) {
        throw new Error("judge() requires an id allocator");
      }
      return {
        id: nextId(),
        kind: "judge",
        question: parseTemplateLiteral(arg),
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
          nextId,
        ),
      };
    }
  }

  return expressionToLocalExpression(node, availableHostModules, nextId);
}

function isDeflectionFromCall(node: acorn.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "deflection" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "from"
  );
}

export function parseHostCallTarget(
  expression: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[]; operation: string } | undefined {
  if (expression.type !== "MemberExpression") return undefined;
  if (expression.computed || expression.property.type !== "Identifier") {
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
    operation: expression.property.name,
  };
}

function parseHostCallTargetRoot(
  expression: acorn.Expression,
  availableHostModules: ReadonlyMap<string, string>,
): { module: string; path: string[] } | undefined {
  if (isIdentifier(expression)) {
    const module = availableHostModules.get(expression.name);
    if (!module) return undefined;
    return { module, path: [] };
  }
  if (expression.type !== "MemberExpression") return undefined;
  if (expression.computed || expression.property.type !== "Identifier") {
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
    path: [...parent.path, expression.property.name],
  };
}

function parseHostCallArgument(expression: acorn.Expression): HostCallArgument {
  if (isTemplateLiteral(expression)) {
    return { kind: "semantic", value: parseTemplateLiteral(expression) };
  }
  if (isLiteral(expression) && typeof expression.value === "string") {
    return {
      kind: "semantic",
      value: {
        kind: "semantic-string",
        parts: [{ kind: "text", value: expression.value }],
        loc: locOf(expression),
      },
    };
  }
  if (expression.type === "ArrayExpression") {
    return {
      kind: "array",
      value: expression.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Host call arrays do not support holes or spread");
        }
        return parseHostCallArgument(element);
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
      value[key] = parseHostCallArgument(property.value);
    }
    return { kind: "object", value };
  }
  return {
    kind: "value",
    value: expressionToLocalExpression(expression),
  };
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

export function parseTemplateLiteral(
  node: acorn.TemplateLiteral,
): SemanticString {
  const parts: SemanticPart[] = [];

  for (let index = 0; index < node.quasis.length; index++) {
    const quasi = node.quasis[index];
    if (!quasi) continue;
    const rawText = quasi.value.cooked ?? quasi.value.raw;
    if (rawText.length > 0) {
      parts.push({ kind: "text", value: rawText });
    }

    const expression = node.expressions[index];
    if (expression) {
      parts.push({
        kind: "expression",
        expression: parseExpression(expression),
      });
    }
  }

  return {
    kind: "semantic-string",
    parts,
    loc: locOf(node),
  };
}
