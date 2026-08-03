import type * as acorn from "acorn";

import type { EnterTarget } from "../types.js";

export type TargetParseMode = "enter" | "enterLoop" | "deflectionEscaped";

/** The node whose action graph or hook a target appears in. */
export type EnclosingNode = {
  identifier: string;
  childNames: ReadonlySet<string>;
};

export type TargetParseContext = {
  availableImports: ReadonlySet<string>;
  visibleNodeNames: ReadonlySet<string>;
  /** Present for detecting a bare target that resolves to the enclosing node. */
  enclosing?: EnclosingNode;
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
  if (expression.type === "Identifier") {
    return parseBareTarget(expression.name, mode, context);
  }
  if (mode === "deflectionEscaped") {
    throw new Error("this.deflection.escaped() only accepts a bare target");
  }
  if (
    expression.type === "CallExpression" &&
    expression.callee.type === "Identifier" &&
    (expression.callee.name === "forgetful" ||
      expression.callee.name === "newcopy")
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
      targetArg.type !== "Identifier"
    ) {
      throw new Error(
        `${targetMode}() requires a node or imported arc identifier`,
      );
    }
    return {
      ...parseBareTarget(targetArg.name, mode, context),
      mode: targetMode,
    };
  }
  throw new Error(
    `${label} requires a node/import identifier or forgetful(node/import) or newcopy(node/import)`,
  );
}

/**
 * Whether a bare identifier resolves to the enclosing node. A self-reference
 * climbs to the lexical parent, where the node appears as a child, so a bare
 * name equal to the node's own name resolves to self unless a local child or
 * import shadows it.
 */
function resolvesToEnclosing(
  identifier: string,
  context: TargetParseContext,
): boolean {
  const { enclosing, availableImports } = context;
  return (
    enclosing !== undefined &&
    identifier === enclosing.identifier &&
    !enclosing.childNames.has(identifier) &&
    !availableImports.has(identifier)
  );
}

function parseBareTarget(
  identifier: string,
  mode: TargetParseMode,
  context: TargetParseContext,
): EnterTarget {
  const { availableImports, visibleNodeNames } = context;
  if (resolvesToEnclosing(identifier, context)) {
    // A node cannot enter itself in any form, so forbid self-entry uniformly
    // for root and non-root. `escaped(Self)` is legal but can never
    // match (nothing self-enters), so accept it and let it be false at runtime
    // even at a root arc, whose own name is otherwise not a reference name.
    if (mode !== "deflectionEscaped") {
      throw new Error(
        `${targetLabel(mode)} cannot re-enter the enclosing node ${identifier}`,
      );
    }
    return { identifier, imported: false, mode: "canonical" };
  }
  if (!visibleNodeNames.has(identifier) && !availableImports.has(identifier)) {
    throw new Error(`Unknown node: ${identifier}`);
  }
  return {
    identifier,
    imported:
      availableImports.has(identifier) && !visibleNodeNames.has(identifier),
    mode: "canonical",
  };
}

function targetLabel(mode: TargetParseMode): string {
  if (mode === "enter") return "$enter()";
  if (mode === "enterLoop") return "$enterLoop()";
  return "this.deflection.escaped()";
}
