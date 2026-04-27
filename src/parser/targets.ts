import type * as acorn from "acorn";

import type { EnterTarget } from "../types.js";
import { isCallExpression, isIdentifier } from "./ast.js";

export type TargetParseMode = "enter" | "enterLoop" | "deflectionFrom";

export type TargetParseContext = {
  availableImports: ReadonlySet<string>;
  visibleNodeNames: ReadonlySet<string>;
};

export function parseTarget(
  expression: acorn.Expression | acorn.SpreadElement | undefined,
  mode: TargetParseMode,
  context: TargetParseContext,
): EnterTarget {
  const label = targetLabel(mode);
  if (!expression || expression.type === "SpreadElement") {
    throw new Error(`${label} requires a target`);
  }
  if (isIdentifier(expression)) {
    return parseBareTarget(expression.name, context);
  }
  if (mode === "deflectionFrom") {
    throw new Error("deflection.from() v1 only accepts a bare target");
  }
  if (
    isCallExpression(expression) &&
    expression.callee.type === "Identifier" &&
    (expression.callee.name === "fresh" || expression.callee.name === "reopen")
  ) {
    const targetMode = expression.callee.name;
    if (expression.arguments.length !== 1) {
      throw new Error(
        `${targetMode}() accepts exactly one node or imported arc identifier`,
      );
    }
    const targetArg = expression.arguments[0];
    if (
      !targetArg ||
      targetArg.type === "SpreadElement" ||
      !isIdentifier(targetArg)
    ) {
      throw new Error(
        `${targetMode}() requires a node or imported arc identifier`,
      );
    }
    return {
      ...parseBareTarget(targetArg.name, context),
      fresh: targetMode === "fresh",
      reopen: targetMode === "reopen",
    };
  }
  throw new Error(
    `${label} requires a node/import identifier or fresh(node/import) or reopen(node/import)`,
  );
}

function parseBareTarget(
  identifier: string,
  context: TargetParseContext,
): EnterTarget {
  const { availableImports, visibleNodeNames } = context;
  if (!visibleNodeNames.has(identifier) && !availableImports.has(identifier)) {
    throw new Error(`Unknown node: ${identifier}`);
  }
  return {
    identifier,
    imported:
      availableImports.has(identifier) && !visibleNodeNames.has(identifier),
    fresh: false,
    reopen: false,
  };
}

function targetLabel(mode: TargetParseMode): string {
  if (mode === "enter") return "enter()";
  if (mode === "enterLoop") return "enterLoop()";
  return "deflection.from()";
}
