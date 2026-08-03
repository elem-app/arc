import type { CallerCellRef, Traversal } from "../types.js";
import { findTraversalInSet, formatRef, traversalToNodeRef } from "./refs.js";
import { runtimeError } from "./report-validation.js";
import type { Accumulator } from "./state.js";

type ReturnChannelBindingContext = "set" | "commit";

export function resolveReturnChannelBinding(
  traversal: Traversal,
  accum: Accumulator,
  key: string,
  context: ReturnChannelBindingContext,
): { callerCellRef: CallerCellRef; callerTraversal: Traversal } {
  const link = traversal.enterChannels.returns[key];
  if (!link || link.kind !== "callerCell") {
    const prefix =
      context === "commit"
        ? "Unknown staged returns channel key"
        : "Unknown returns channel key";
    throw runtimeError(
      "unknown-channel-key",
      `${prefix} "${key}" for ${formatRef(traversalToNodeRef(traversal))}`,
    );
  }
  const callerCellRef: CallerCellRef = {
    ownerRef: link.ownerRef,
    cell: link.cell,
  };

  const callerTraversal = findTraversalInSet(
    accum.traversals,
    callerCellRef.ownerRef,
  );
  if (!callerTraversal) {
    const subject =
      context === "commit"
        ? "Returns channel caller"
        : "Returns channel caller-owner traversal";
    throw runtimeError(
      "invalid-channel-binding",
      `${subject} not found for binding: ${formatRef(callerCellRef.ownerRef)}`,
    );
  }

  return { callerCellRef, callerTraversal };
}
