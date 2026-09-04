/**
 * Shared test harness for the area-organized behavior test files.
 *
 * These helpers are a copy of the harness embedded in `runtime.test.ts`,
 * exported for reuse. The original monolith test files keep their own copies
 * untouched while the migration mapping in `MIGRATION.md` is completed.
 */
import { hmd } from "../src/host-utils/index.js";
import {
  Runtime,
  type RuntimeOptions,
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
  BriefId,
  Dialog,
  Document,
  HostCallReport,
  HostModuleSpec,
  NodeRef,
  NodeTraversal,
  ObservationBrief,
  ObservationGroupBrief,
  PayloadValue,
  TerminalBrief,
} from "../src/types/index.js";

/** Explicit declarations shared by pre-existing host-boundary fixtures. */
export const TEST_HOST_MODULES: ReadonlyMap<string, HostModuleSpec> = new Map([
  [
    "api",
    hmd.define({
      value: () => hmd.Num(),
      number: (value = hmd.Num()) => hmd.Num(),
      numbers: (values = hmd.Array(hmd.Num())) => hmd.Num(),
      values: () => hmd.Array(hmd.Num()),
      left: () => hmd.Num(),
      right: () => hmd.Num(),
      apply: (values = hmd.Array(hmd.Num())) => {},
      record: (text = hmd.SemanticText()) => {},
    }),
  ],
  ["audience", hmd.define({})],
  [
    "files",
    hmd.define({
      path: () => hmd.Str(),
      save: (path = hmd.Str()) => {},
    }),
  ],
  ["flags", hmd.define({ enabled: () => hmd.Bool() })],
  ["gate", hmd.define({ isOpen: () => hmd.Bool(), ready: () => hmd.Bool() })],
  ["mail", hmd.define({})],
  [
    "memoir",
    hmd.define({
      facts: {
        apply: (text = hmd.SemanticText()) => {},
        audit: { apply: (text = hmd.SemanticText()) => {} },
      },
    }),
  ],
  ["missing", hmd.define({ call: () => hmd.Str() })],
  ["mod", hmd.define({ doSomething: () => {} })],
  ["reader", hmd.define({ check: (text = hmd.SemanticText()) => hmd.Bool() })],
  [
    "rng",
    hmd.define({
      roll: (sides = hmd.Num()) => hmd.Num(),
      table: { roller: { roll: (sides = hmd.Num()) => hmd.Num() } },
    }),
  ],
  [
    "scorer",
    hmd.define({
      check: () => hmd.Str(),
      score: (roll = hmd.Num(), mode = hmd.Str()) => hmd.Num(),
    }),
  ],
  ["sink", hmd.define({ accept: (artifact = hmd.Artifact()) => hmd.Bool() })],
  ["slugs", hmd.define({ next: () => hmd.Str() })],
  [
    "store",
    hmd.define({
      accept: (artifact = hmd.Artifact()) => hmd.Bool(),
      accepts: (text = hmd.Str()) => hmd.Bool(),
      archive: (artifact = hmd.Artifact()) => {},
      lookup: () => hmd.Artifact(),
      missing: () => hmd.Str(),
      record: (artifact = hmd.Artifact()) => {},
      send: (
        artifact = hmd.Artifact(),
        rendered = hmd.SemanticText(),
        path = hmd.Str(),
      ) => hmd.Bool(),
    }),
  ],
  ["test", hmd.define({})],
  [
    "values",
    hmd.define({
      next: () => hmd.Num(),
      nextEnum: () => hmd.Enum(["cold", "warm"]),
      nextNumbers: () => hmd.Array(hmd.Num()),
    }),
  ],
  ["writer", hmd.define({ save: (text = hmd.SemanticText()) => {} })],
]);

/** Runtime with the explicit fixture registry unless a test supplies another. */
export class TestRuntime extends Runtime {
  constructor(options: RuntimeOptions = {}) {
    super({ hostModules: options.hostModules ?? TEST_HOST_MODULES });
  }
}

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

export function rootTraversal(
  brief: ActionBrief | TerminalBrief,
): ArcTraversal {
  const root = brief.traversals.find(
    (traversal) => traversal.enteredBy === undefined,
  );
  if (!root) throw new Error("Missing root traversal");
  return root;
}

export function traversalByRef(
  brief: ActionBrief | TerminalBrief,
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
  brief: ActionBrief | TerminalBrief,
  dialog: Dialog,
): ActionBrief | TerminalBrief {
  let current = brief;
  while (
    current.canProgress &&
    current.transition &&
    current.allowedMoves.includes("proceed")
  ) {
    current = runtime.progress(current, { move: "proceed" }, dialog);
  }
  return current;
}

export function actionProgress(
  brief: ActionBrief | TerminalBrief,
): ActionBrief {
  if (!brief.canProgress) {
    throw new Error(
      `Expected an action progress brief, got terminal ${brief.outcome}`,
    );
  }
  return brief;
}

export function actionTerminal(
  brief: ActionBrief | TerminalBrief,
): TerminalBrief {
  if (brief.canProgress) {
    throw new Error("Expected a terminal action result brief");
  }
  return brief;
}

export function startRun(
  runtime: Runtime,
  traversals: ArcTraversalSet,
  dialog: Dialog,
): ActionBrief {
  return actionProgress(
    settleTransitions(runtime, runtime.start(traversals, dialog), dialog),
  );
}

export function startTerminal(
  runtime: Runtime,
  traversals: ArcTraversalSet,
  dialog: Dialog,
): TerminalBrief {
  return actionTerminal(
    settleTransitions(runtime, runtime.start(traversals, dialog), dialog),
  );
}

export function progressBrief(
  runtime: Runtime,
  brief: ActionBrief,
  report: ActionReport,
  dialog: Dialog = EMPTY_DIALOG,
): ActionBrief {
  return actionProgress(
    settleTransitions(runtime, runtime.progress(brief, report, dialog), dialog),
  );
}

export function progressTerminal(
  runtime: Runtime,
  brief: ActionBrief,
  report: ActionReport,
  dialog: Dialog = EMPTY_DIALOG,
): TerminalBrief {
  return actionTerminal(
    settleTransitions(runtime, runtime.progress(brief, report, dialog), dialog),
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

/** Builds a void resolution report entry for every host call on the brief. */
export function resolvedHostCalls(
  brief: ActionBrief,
): Record<string, HostCallReport> {
  return Object.fromEntries(
    brief.hostCalls.map((call) => [call.id, { status: "resolved" }]),
  );
}

/** Builds an "applied" report entry for selected apply-phase instructions. */
export function appliedInstructions(
  brief: ActionBrief,
  ids: readonly BriefId[] = brief.instructions
    .filter((instruction) => instruction.phase === "apply")
    .map((instruction) => instruction.id),
): NonNullable<ActionReport["instructions"]> {
  return Object.fromEntries(ids.map((id) => [id, { status: "applied" }]));
}

export function payloadObject(
  value: PayloadValue,
): Record<string, PayloadValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected payload object");
  }
  return value as Record<string, PayloadValue>;
}

export function payloadArray(value: PayloadValue): PayloadValue[] {
  if (!Array.isArray(value)) throw new Error("Expected payload array");
  return value;
}

export function renderSemanticTextForTest(value: PayloadValue): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value);
  return value
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return String(part);
      }
      if (!("kind" in part)) return String(part);
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
