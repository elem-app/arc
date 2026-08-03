/**
 * Shared test harness for the area-organized behavior test files.
 *
 * These helpers are a copy of the harness embedded in `runtime.test.ts`,
 * exported for reuse. The original monolith test files keep their own copies
 * untouched while the migration mapping in `MIGRATION.md` is completed.
 */
import {
  Runtime,
  toArcRef,
  toNodeRef,
  toNodeRefParts,
} from "../src/runtime/index.js";
import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  Document,
  HostEffectReport,
  NodeRef,
  NodeTraversal,
  ObservationBrief,
  ObservationGroupBrief,
  PayloadValue,
  SemanticText,
} from "../src/types.js";

export function withExperimentalRewalk(
  document: Document,
  ...nodePaths: string[]
): Document {
  for (const path of nodePaths) {
    const [rootName, ...childNames] = path.split(".");
    let node = document.roots.find(
      (candidate) => candidate.identifier === rootName,
    );
    for (const childName of childNames) {
      node = node?.children.find(
        (candidate) => candidate.identifier === childName,
      );
    }
    if (!node) throw new Error(`Unknown node path: ${path}`);
    node.writeDiffMode = "rewalk";
  }
  return document;
}

export function arc(source: string, id: string): ArcRef {
  return toArcRef(source, id);
}

/** Narrows a shared-channel observation item to a single `ObservationBrief`. */
export function singleObservation(
  item: ObservationBrief | ObservationGroupBrief | undefined,
): ObservationBrief {
  if (!item || item.kind === "observation-group") {
    throw new Error("expected a single observation brief");
  }
  return item;
}

/** Narrows a shared-channel observation item to an `ObservationGroupBrief`. */
export function groupObservation(
  item: ObservationBrief | ObservationGroupBrief | undefined,
): ObservationGroupBrief {
  if (!item || item.kind !== "observation-group") {
    throw new Error("expected a grouped observation brief");
  }
  return item;
}

/** Narrows a brief's observation channel to single `ObservationBrief`s. */
export function singleObservations(brief: {
  observations: readonly (ObservationBrief | ObservationGroupBrief)[];
}): ObservationBrief[] {
  return brief.observations.map(singleObservation);
}

export function node(source: string, identifier: string): NodeRef {
  return toNodeRef(source, identifier.split("."));
}

export function nodeIdentifier(ref: NodeRef): string {
  return toNodeRefParts(ref).path.join(".");
}

export function ownedChild(
  traversal: ArcTraversal | NodeTraversal,
  identifier: string,
): NodeTraversal | undefined {
  return traversal.ownedChildren.find(
    (child) => nodeIdentifier(child.ref) === identifier,
  );
}

export function ephemeralChild(
  traversal: ArcTraversal | NodeTraversal,
  identifier: string,
): NodeTraversal | undefined {
  return traversal.ephemeralChildren.find(
    (child) => nodeIdentifier(child.ref) === identifier,
  );
}

export function rootTraversal(brief: ActionBrief): ArcTraversal {
  const root = brief.traversals.find(
    (traversal) => traversal.enteredBy === undefined,
  );
  if (!root) throw new Error("Missing root traversal");
  return root;
}

export function traversalByRef(
  brief: ActionBrief,
  ref: ArcRef,
): ArcTraversal | undefined {
  return brief.traversals.find((traversal) => traversal.ref === ref);
}

export const EMPTY_DIALOG: Dialog = {
  cursor: { user: 0, self: 0 },
  lastTurns: [],
};

/**
 * Acknowledges transition briefs with the same dialog until work (or rest)
 * surfaces. Most tests exercise work semantics, not position reporting, so the
 * shared drivers are transition-transparent; transition tests drive
 * `runtime.start` / `runtime.progress` directly.
 */
export function settleTransitions(
  runtime: Runtime,
  brief: ActionBrief,
  dialog: Dialog,
): ActionBrief {
  let current = brief;
  while (current.transition && current.allowedMoves.includes("proceed")) {
    current = runtime.progress(current, { move: "proceed" }, dialog);
  }
  return current;
}

export function startRun(
  runtime: Runtime,
  traversals: ArcTraversalSet,
  dialog: Dialog,
): ActionBrief {
  return settleTransitions(runtime, runtime.start(traversals, dialog), dialog);
}

export function progressBrief(
  runtime: Runtime,
  brief: ReturnType<Runtime["start"]>,
  report: ActionReport,
  dialog: Dialog = EMPTY_DIALOG,
): ActionBrief {
  return settleTransitions(
    runtime,
    runtime.progress(brief, report, dialog),
    dialog,
  );
}

export function startTrigger(
  runtime: Runtime,
  dialog: Dialog,
  traversals: ArcTraversalSet = runtime.newTraversalSet(),
  opts: { arcRefs?: readonly ArcRef[] } = {},
) {
  return runtime.startTrigger(traversals, dialog, opts);
}

/** Builds an "applied" report entry for every host effect on the brief. */
export function appliedHostEffects(
  brief: ActionBrief,
): Record<string, HostEffectReport> {
  return Object.fromEntries(
    brief.hostEffects.map((effect) => [effect.id, { status: "applied" }]),
  );
}

export function payloadObject(
  value: PayloadValue,
): Record<string, PayloadValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected payload object");
  }
  return value;
}

export function payloadArray(value: PayloadValue): PayloadValue[] {
  if (!Array.isArray(value)) throw new Error("Expected payload array");
  return value;
}

export function renderSemanticTextForTest(
  value: PayloadValue | SemanticText,
): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value);
  return value
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return String(part);
      }
      if (part.kind === "text") return String(part.value);
      if (part.kind === "entity") return String(part.name);
      if (part.kind === "artifact") return String(part.path);
      return String(part);
    })
    .join("");
}

/** The shared Metal/Surface fixture used by trigger and observation cases. */
export const METAL_SOURCE = `
"arc";

function Metal() {
  this.displayName = "Metal";

  this.trigger = () => {
    if (judge(\`\${user} asks about music\`)) {
      return true;
    }
    return false;
  };

  $enter(Surface);

  function Surface() {
    let subgenre = Enum(["unknown", "thrash", "doom"]);
    subgenre.observing = \`what subgenre does \${user} like\`;
    $observeOrAsk(subgenre);
    $instruct(\`Talk about \${subgenre}.\`);  }
}
`;
