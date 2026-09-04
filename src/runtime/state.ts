import type {
  ActionBrief,
  HostCallBrief,
  HostCallReport,
  InstructionBrief,
  JudgmentBrief,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupReport,
  ObservationReport,
  ObservationValueMeta,
  ScalarObservationMeta,
  TriggerBrief,
  TriggerReport,
} from "../types/host-interaction.js";
import type {
  ActionStatement,
  CellTarget,
  Document,
  DocumentRewalkPlan,
  ElementId,
  HostCallArgument,
  InstructionAction,
  Node,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  SegKey,
  SemanticString,
  SetAction,
  TriggerStatement,
  UnsetAction,
  ValueExpression,
} from "../types/parser.js";
import type {
  ActionState,
  ActionStateOf,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  BriefSiteQualifier,
  EnterChannelLink,
  EnterChannelState,
  MapActionState,
  NodeFrame,
  NodeRef,
  NodeState,
  NodeTraversal,
  PendingActionExtras,
  PinTape,
  RuntimeIssue,
  SegId,
  StateSnapshot,
  TransitionStretch,
  Traversal,
} from "../types/runtime.js";
import { mapMemberSegKey } from "../types/runtime.js";
import type { ArrayElementSpec, HostModuleSpec } from "../types/spec.js";
import type {
  ArrayElementValue,
  ArrayValue,
  CellValue,
  Dialog,
  DialogCursor,
  PayloadValue,
  SemanticText,
} from "../types/value.js";
import {
  clonePayloadValue,
  cloneWithCanonicalNumbers,
  firstNonFiniteNumberPath,
  mergeAndClonePayload,
} from "../value-utils.js";
import {
  clonePinTapes,
  dropAllPinTapes,
  dropPinTape,
  type PinScope,
} from "./pins.js";
import {
  arcToNodeRef,
  findTraversalInSet,
  formatRef,
  isArcRef,
  isArcTraversal,
  lexicalParentRef,
  traversalToNodeRef,
} from "./refs.js";

export type RegistryEntry = {
  arc: ArcRef;
  document: Document;
  root: Node;
  importRefs: Record<string, ArcRef>;
  hostModules: ReadonlyMap<string, HostModuleSpec>;
  /**
   * Static re-walk plan for this entry's document, computed once at registration.
   * Referenced/imported arcs carry their own entry and therefore their own plan,
   * so the executor reads the plan from the entry owning a node, not from a
   * `Runtime` reference.
   */
  rewalkPlan?: DocumentRewalkPlan;
};

/**
 * The resolved destination of an `$enter(...)` / `$enterLoop(...)`. An `owned`
 * target is a node in the caller's own document; a `referenced` target is the
 * root of an imported arc; an `anonymous-copy` target is a blank copy keyed to
 * the enter statement.
 */
export type EnterTarget =
  | { kind: "owned"; ref: NodeRef; node: Node }
  | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
  | { kind: "anonymous-copy"; ref: NodeRef; node: Node };

export type Accumulator = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversal: Traversal;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  phase: "plan" | "apply";
  judgments: JudgmentBrief[];
  observations: (ObservationBrief | ObservationGroupBrief)[];
  hostCalls: HostCallBrief[];
  /** Brief ids whose expression consumers demand a declared result value. */
  hostCallValueDemands: Set<BriefId>;
  instructions: InstructionBrief[];
  hostParams?: PayloadValue;
  hostParamsActive: boolean;
  blocked: boolean;
  /**
   * Latched, not-yet-yielded position changes for this walk. Appended at
   * genuine traversal entry/exit and flushed by the first transition gate,
   * which stamps `position` and records the stretch onto the action root as
   * `pendingTransition`. Inert when `transitionsEnabled` is false (trigger
   * stage).
   */
  transition?: TransitionStretch & { position?: NodeRef };
  transitionsEnabled: boolean;
  /** Runtime issues raised mid-walk, merged into the brief by the plan walk. */
  issues: RuntimeIssue[];
  active?: NodeRef;
  /** The SEG the walk is currently in, tracked so a block records its `SegId`. */
  activeSeg: SegId;
  briefActive?: NodeRef;
  instructionBatchNode?: NodeRef;
  instructionBatchSignature?: string;
  /** First emitted instruction owner in the current batch. */
  instructionBatchResumeSeg?: Extract<
    SegId,
    { kind: "resolveWhen" | "deflectWhen" }
  >;
  /** Apply-phase instruction ids confirmed by the report being consumed. */
  instructionApplications: Set<BriefId>;
  judgmentResults: Map<string, boolean>;
  observationResults: Map<string, ObservationReport>;
  observationGroupResults: Map<string, ObservationGroupReport>;
  hostCallResults: Map<string, HostCallReport>;
  /**
   * The active pin cursor: the current statement's entries on the walking SEG's
   * pin tape. Opened per statement visit by the SEG executors and saved/
   * restored around nested SEG walks, so sigil-less evaluations always consult
   * the tape of the SEG that owns them.
   */
  pin?: PinScope;
  /**
   * Brief-id qualifier for an inherited hook consultation: the owning
   * instruction's consultation instance, set while its inherited
   * `deflectWhen` evaluates. The inherited hook IR is shared across owners
   * under the `deflectWhen/` scope, so `qualifiedBriefSite` substitutes this
   * instance for that prefix to keep answers from colliding.
   */
  hookInstance?: SegKey;
  /**
   * The `$map` member row the walk is currently inside, if any. Callback
   * element ids are static (`<mapId>/…`) and run once per member, so brief ids,
   * instruction ids, and pin tapes qualify by the member index. `item` is the
   * pinned element value for this member and `index` its position, read by
   * `span.item` / `span.index`. Set by the map driver around each member's
   * callback SEG.
   */
  mapMember?: {
    mapId: ElementId;
    index: number;
    item: ArrayElementValue;
    receiverSpec?: ArrayElementSpec;
    resultSpec?: ArrayElementSpec;
  };
  /**
   * The invoke bodies the walk is currently inside, innermost last. Read-set
   * brackets taken inside a body use that invoke's local plan, and the SEG
   * restored after an in-body wide action is the invoke SEG rather than the
   * node body.
   */
  invokeContext?: { node: Node; id: ElementId }[];
};

/**
 * The brief-site prefix substitutions active on the walk: the inherited-hook
 * consultation instance and the `$map` member row, composed so a callback
 * element under an inherited hook is qualified by both.
 */
export function briefSiteQualifiers(accum: Accumulator): BriefSiteQualifier[] {
  const qualifiers: BriefSiteQualifier[] = [];
  if (accum.hookInstance !== undefined) {
    qualifiers.push({
      staticPrefix: "deflectWhen/",
      instanceKey: `${accum.hookInstance}/`,
    });
  }
  if (accum.mapMember !== undefined) {
    const { mapId, index } = accum.mapMember;
    qualifiers.push({
      staticPrefix: `${mapId}/`,
      instanceKey: `${mapMemberSegKey(mapId, index)}/`,
    });
  }
  return qualifiers;
}

export type ActionBriefSnapshot = Omit<ActionBrief, "traversals">;
export type TriggerBriefSnapshot = Omit<TriggerBrief, "deps" | "traversals">;

export type ActionBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversals: ArcTraversalSet;
  snapshot: ActionBriefSnapshot;
  hostCallValueDemands: ReadonlySet<BriefId>;
};

/**
 * One candidate arc's trigger consultation state, carried on the in-memory
 * trigger brief chain. `tape` is the consultation's pin tape — a retry
 * round-trip seeks it, so answered judges stay pinned per candidate — and a
 * terminal `status` keeps its outcome across retries without re-running the
 * trigger. A fresh `startTrigger(...)` starts new consultations, so none of
 * this persists in traversal state (a documented exception to the persistence
 * invariant; per-consultation trigger semantics permits a restart to consult
 * afresh).
 */
export type TriggerCandidateState = {
  status: "open" | "matched" | "unmatched";
  tape: PinTape;
};

export type TriggerBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  priorReport: TriggerReport;
  candidates: Map<ArcRef, TriggerCandidateState>;
  snapshot: TriggerBriefSnapshot;
};

export function createAccumulator(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversal: Traversal,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  phase: "plan" | "apply",
  transitionsEnabled: boolean,
): Accumulator {
  return {
    entries,
    entry,
    traversal,
    traversals,
    dialog,
    phase,
    judgments: [],
    observations: [],
    hostCalls: [],
    hostCallValueDemands: new Set(),
    instructions: [],
    hostParamsActive: false,
    blocked: false,
    transition: undefined,
    transitionsEnabled,
    issues: [],
    active: undefined,
    activeSeg: { kind: "body" },
    briefActive: undefined,
    instructionBatchNode: undefined,
    instructionBatchSignature: undefined,
    instructionBatchResumeSeg: undefined,
    instructionApplications: new Set(),
    judgmentResults: new Map(),
    observationResults: new Map(),
    observationGroupResults: new Map(),
    hostCallResults: new Map(),
  };
}

export function createEmptyEnterChannelState(): EnterChannelState {
  return { args: {}, returns: {}, stagedReturns: {} };
}

function createCellSlots(node: Node): Record<string, CellValue | undefined> {
  const cells: Record<string, CellValue | undefined> = {};
  for (const cell of node.cells) {
    cells[cell.name] = undefined;
  }
  return cells;
}

function createTraversalFrame(): NodeFrame {
  return { actionStates: {}, evaluatorActionStates: {}, pinTapes: {} };
}

export function createEmptyArcTraversal(
  arcRef: ArcRef,
  node: Node,
): ArcTraversal {
  return {
    ref: arcRef,
    phase: "dormant",
    enterCount: 0,
    state: undefined,
    cells: createCellSlots(node),
    frame: createTraversalFrame(),
    ownedChildren: [],
    ephemeralChildren: [],
    refChildren: [],
    enterChannels: createEmptyEnterChannelState(),
  };
}

export function createEmptyNodeTraversal(
  nodeRef: NodeRef,
  node: Node,
): NodeTraversal {
  return {
    ref: nodeRef,
    enterCount: 0,
    state: undefined,
    cells: createCellSlots(node),
    frame: createTraversalFrame(),
    ownedChildren: [],
    ephemeralChildren: [],
    refChildren: [],
    enterChannels: createEmptyEnterChannelState(),
  };
}

export function restartTraversal(
  entry: RegistryEntry,
  base?: ArcTraversal,
): ArcTraversal {
  if (!base) {
    const traversal = createEmptyArcTraversal(entry.arc, entry.root);
    traversal.phase = "entered";
    traversal.enterCount = 1;
    return traversal;
  }
  const next = cloneArcTraversal(base);
  next.enterCount += 1;
  next.phase = "entered";
  next.state = undefined;
  next.finalizing = undefined;
  next.enteredBy = undefined;
  next.activeFrame = undefined;
  next.pendingTransition = undefined;
  next.enterChannels = createEmptyEnterChannelState();
  // Re-entry is a rewalk from the SEG top: sigil-less pins release while
  // resolved `$` slots stay (unless the entry itself is forgetful).
  dropAllPinTapes(next);
  if (entry.root.forgetfulEntry) clearFrame(next);
  return next;
}

export function cloneNodeTraversal(traversal: NodeTraversal): NodeTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversalToNodeRef(traversal),
  };
}

export function cloneArcTraversal(traversal: ArcTraversal): ArcTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversal.ref,
    phase: traversal.phase,
    activeFrame: traversal.activeFrame
      ? {
          activeRef: traversal.activeFrame.activeRef,
          activeSeg: { ...traversal.activeFrame.activeSeg },
        }
      : undefined,
    pendingTransition: traversal.pendingTransition
      ? {
          exited: [...traversal.pendingTransition.exited],
          entered: [...traversal.pendingTransition.entered],
        }
      : undefined,
  };
}

function cloneTraversalBase<T extends Traversal>(traversal: T) {
  const cells: Record<string, CellValue | undefined> = {};
  for (const key in traversal.cells) {
    cells[key] = cloneCellValue(traversal.cells[key]);
  }
  return {
    enterCount: traversal.enterCount,
    state: traversal.state,
    finalizing: traversal.finalizing
      ? traversal.finalizing.reason === "deflected"
        ? {
            ...traversal.finalizing,
            deflection: {
              ...traversal.finalizing.deflection,
            },
          }
        : { ...traversal.finalizing }
      : undefined,
    cells,
    frame: {
      actionStates: Object.fromEntries(
        Object.entries(traversal.frame.actionStates).map(([id, state]) => [
          id,
          state ? cloneActionState(state) : undefined,
        ]),
      ),
      evaluatorActionStates: Object.fromEntries(
        Object.entries(traversal.frame.evaluatorActionStates ?? {}).map(
          ([scopeKey, scopedStates]) => [
            scopeKey,
            scopedStates
              ? Object.fromEntries(
                  Object.entries(scopedStates).map(([id, state]) => [
                    id,
                    state ? { ...state } : undefined,
                  ]),
                )
              : undefined,
          ],
        ),
      ),
      pinTapes: clonePinTapes(traversal.frame.pinTapes),
    },
    ownedChildren: traversal.ownedChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    ephemeralChildren: traversal.ephemeralChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    refChildren: [...traversal.refChildren],
    enteredBy: traversal.enteredBy ? { ...traversal.enteredBy } : undefined,
    enterChannels: {
      args: Object.fromEntries(
        Object.entries(traversal.enterChannels.args).map(([key, link]) => [
          key,
          cloneEnterChannelLink(link),
        ]),
      ),
      returns: Object.fromEntries(
        Object.entries(traversal.enterChannels.returns).map(([key, link]) => [
          key,
          cloneEnterChannelLink(link),
        ]),
      ),
      stagedReturns: cloneStagedReturns(traversal.enterChannels.stagedReturns),
    },
  };
}

export function cloneTraversalSet(
  traversals: ArcTraversalSet,
): ArcTraversalSet {
  const cloned = traversals.map((traversal) => cloneArcTraversal(traversal));
  const nonFinitePath = firstNonFiniteNumberPath(cloned);
  if (nonFinitePath !== undefined) {
    throw new Error(
      `Internal invariant: traversal state contains a non-finite number at ${nonFinitePath}`,
    );
  }
  return cloneWithCanonicalNumbers(cloned);
}

export function cloneDialogCursor(cursor: DialogCursor): DialogCursor {
  return {
    user: cursor.user,
    self: cursor.self,
    ...(cursor.view !== undefined ? { view: cursor.view } : {}),
  };
}

/** Clones a staged-returns map, deep-cloning each channel value. */
export function cloneEnterChannelLink(
  link: EnterChannelLink,
): EnterChannelLink {
  return link.kind === "value"
    ? { kind: "value", value: cloneCellValue(link.value) ?? link.value }
    : { ...link };
}

function cloneMapActionState(map: MapActionState): MapActionState {
  const pinnedInput = cloneCellValue(map.pinnedInput) as ArrayValue;
  return {
    pinnedInput,
    results: map.results,
    nextIndex: map.nextIndex,
    terminals: map.terminals.map((value) =>
      value === undefined
        ? undefined
        : (cloneCellValue(value) as ArrayElementValue),
    ),
    staged: map.staged
      ? {
          set: map.staged.set,
          ...(map.staged.value === undefined
            ? {}
            : {
                value: cloneCellValue(map.staged.value) as ArrayElementValue,
              }),
        }
      : undefined,
  };
}

function cloneStagedReturns(
  staged: Record<string, CellValue>,
): Record<string, CellValue> {
  const cloned: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(staged)) {
    const next = cloneCellValue(value);
    if (next !== undefined) cloned[key] = next;
  }
  return cloned;
}

export function cloneCellValue(
  value: CellValue | undefined,
): CellValue | undefined {
  if (value === undefined) return undefined;
  return clonePayloadValue(value as PayloadValue) as CellValue;
}

/** Compares authored values by their declared value components. */
export function cellValuesEqual(
  a: CellValue | undefined,
  b: CellValue | undefined,
): boolean {
  return payloadValuesEqual(a, b);
}

function payloadValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((element, index) => payloadValuesEqual(element, b[index]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          payloadValuesEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

export function isStopped(traversal: ArcTraversal): boolean {
  return (
    traversal.phase === "completed" ||
    traversal.phase === "suspended" ||
    traversal.phase === "poisoned"
  );
}

export function isEnteredTraversal(traversal: Traversal): boolean {
  return isArcTraversal(traversal)
    ? traversal.phase === "entered" && traversal.state === undefined
    : traversal.state === undefined;
}

export function isSuspendedArcTraversal(traversal: Traversal): boolean {
  return isArcTraversal(traversal) && traversal.phase === "suspended";
}

export function selectActionRootTraversal(
  traversals: ArcTraversalSet,
  preferredRoot?: ArcRef,
): ArcTraversal {
  if (preferredRoot) {
    const preferred = traversals.find(
      (traversal) => traversal.ref === preferredRoot,
    );
    if (preferred) return preferred;
  }
  // The action root is the arc traversal not owned by an enter action:
  // referenced/imported arcs and entered children always carry `enteredBy`.
  // A trigger-outcome set also carries dormant trigger candidates, which are
  // likewise unowned, so prefer the active (entered) run over them.
  const unowned = traversals.filter(
    (traversal) =>
      isArcTraversal(traversal) && traversal.enteredBy === undefined,
  );
  const entered = unowned.find((traversal) => traversal.phase === "entered");
  if (entered) return entered;
  const root = unowned[0];
  if (root) return root;
  const first = traversals[0];
  if (!first) throw new Error("Action traversal set is empty");
  return first;
}

/**
 * The arc traversal currently driving action progression, or `undefined` when no
 * run is active — an unowned root (`enteredBy === undefined`) that is `entered`.
 * Absence means only dormant trigger candidates remain. Hosts use this to branch
 * between resuming an action run and probing triggers, so they decide what counts
 * as the active root through this contract rather than inspecting traversal
 * `enteredBy` / `phase` internals themselves.
 */
export function findActiveRoot(
  traversals: ArcTraversalSet,
): ArcTraversal | undefined {
  return traversals.find(
    (traversal) =>
      isArcTraversal(traversal) &&
      traversal.enteredBy === undefined &&
      traversal.phase === "entered",
  );
}

export function cloneHostCallBrief(brief: HostCallBrief): HostCallBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    module: brief.module,
    target: [...brief.target],
    operation: brief.operation,
    arguments: brief.arguments.map((arg) => clonePayloadValue(arg)),
    hostParams: clonePayloadValue(brief.hostParams),
  };
}

export function cloneJudgmentBrief(brief: JudgmentBrief): JudgmentBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    question: cloneSemanticText(brief.question),
    hostParams: clonePayloadValue(brief.hostParams),
  };
}

/**
 * Clones one action's resolution state, deep-copying the mutable continuation a
 * kind carries. A pre-snapshot is carried by reference, intentionally: it is
 * immutable once captured, so sharing it avoids a deep copy of the read-set on
 * every report.
 */
function cloneActionState(state: ActionState): ActionState {
  switch (state.kind) {
    case "enter-node":
    case "enter-loop":
      return {
        ...state,
        stagedReturns: state.stagedReturns
          ? cloneStagedReturns(state.stagedReturns)
          : undefined,
      };
    case "map":
      return {
        ...state,
        map: state.map ? cloneMapActionState(state.map) : undefined,
      };
    case "host-call":
      return state.status === "pending"
        ? {
            ...state,
            call: {
              arguments: state.call.arguments.map((argument) =>
                clonePayloadValue(argument),
              ),
              ...(state.call.hostParams === undefined
                ? {}
                : { hostParams: clonePayloadValue(state.call.hostParams) }),
            },
          }
        : { ...state };
    default:
      return { ...state };
  }
}

/** Clones a scalar shape, copying the member list an `enum` carries. */
function cloneScalarObservationMeta(
  spec: ScalarObservationMeta,
): ScalarObservationMeta {
  switch (spec.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: [...spec.values] };
    case "rangedInt":
      return { type: "rangedInt", min: spec.min, max: spec.max };
    case "number":
      return {
        type: "number",
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
      };
  }
}

/** Clones observation value metadata, dispatching on the scalar vs array variant. */
function cloneObservationValueMeta(
  meta: ObservationValueMeta,
): ObservationValueMeta {
  if (meta.type === "array") {
    return {
      type: "array",
      element: cloneScalarObservationMeta(meta.element),
    };
  }
  return cloneScalarObservationMeta(meta);
}

export function cloneObservationBrief(
  brief: ObservationBrief,
): ObservationBrief {
  return {
    kind: "observation",
    id: brief.id,
    sourceRef: brief.sourceRef,
    cell: brief.cell,
    mode: brief.mode,
    question: cloneSemanticText(brief.question),
    currentValue: Array.isArray(brief.currentValue)
      ? [...brief.currentValue]
      : brief.currentValue,
    hostParams: clonePayloadValue(brief.hostParams),
    meta: cloneObservationValueMeta(brief.meta),
  };
}

/** Clones an observation brief, dispatching on the single vs grouped variant. */
export function cloneObservationOrGroupBrief(
  brief: ObservationBrief | ObservationGroupBrief,
): ObservationBrief | ObservationGroupBrief {
  return brief.kind === "observation-group"
    ? cloneObservationGroupBrief(brief)
    : cloneObservationBrief(brief);
}

export function cloneObservationGroupBrief(
  brief: ObservationGroupBrief,
): ObservationGroupBrief {
  return {
    kind: "observation-group",
    id: brief.id,
    sourceRef: brief.sourceRef,
    mode: brief.mode,
    hostParams: clonePayloadValue(brief.hostParams),
    fields: brief.fields.map((field) => ({
      cell: field.cell,
      question: cloneSemanticText(field.question),
      currentValue: Array.isArray(field.currentValue)
        ? [...field.currentValue]
        : field.currentValue,
      meta: cloneObservationValueMeta(field.meta),
    })),
  };
}

export function cloneRuntimeIssue(issue: RuntimeIssue): RuntimeIssue {
  if (issue.kind === "invalid-item" || issue.kind === "invalid-report") {
    return { ...issue };
  }
  if (issue.kind === "ambiguous-match") {
    return {
      ...issue,
      matchableArcs: [...issue.matchableArcs],
    };
  }
  return {
    ...issue,
    source: issue.source
      ? {
          start: { ...issue.source.start },
          end: { ...issue.source.end },
        }
      : undefined,
  };
}

export function cloneInstructionBrief(
  brief: InstructionBrief,
): InstructionBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    mode: brief.mode,
    phase: brief.phase,
    text: cloneSemanticText(brief.text),
    hostParams: clonePayloadValue(brief.hostParams),
    postcheck: cloneInstructionPostcheck(brief.postcheck),
  };
}

export function cloneSemanticText(text: SemanticText): SemanticText {
  if (typeof text === "string") return text;
  return text.map((part) => ({ ...part }));
}

export function cloneInstructionPostcheck(
  postcheck: InstructionBrief["postcheck"],
): InstructionBrief["postcheck"] {
  return postcheck
    ? {
        judgmentIds: [...postcheck.judgmentIds],
        observationIds: [...postcheck.observationIds],
        hostCallIds: [...postcheck.hostCallIds],
      }
    : undefined;
}

export function mergeInstructionBriefs(
  ...groups: readonly (readonly InstructionBrief[])[]
): InstructionBrief[] {
  const merged = new Map<string, InstructionBrief>();

  for (const group of groups) {
    for (const brief of group) {
      const current = merged.get(brief.id);
      if (!current) {
        merged.set(brief.id, cloneInstructionBrief(brief));
        continue;
      }
      merged.set(brief.id, {
        ...cloneInstructionBrief(brief),
        phase:
          current.phase === "apply" || brief.phase === "apply"
            ? "apply"
            : "postcheck",
        postcheck:
          cloneInstructionPostcheck(brief.postcheck) ??
          cloneInstructionPostcheck(current.postcheck),
      });
    }
  }
  return [...merged.values()];
}

export function cloneValueExpression(
  expression: ValueExpression,
): ValueExpression {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "cell":
      return { kind: "cell", name: expression.name };
    case "isUnset":
      return { kind: "isUnset", cell: expression.cell };
    case "channel":
      return {
        kind: "channel",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "channelIsUnset":
      return {
        kind: "channelIsUnset",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "deflectionEscaped":
      return {
        kind: "deflectionEscaped",
        target: { ...expression.target },
      };
    case "dialogCursor":
      return { kind: "dialogCursor" };
    case "dialogTurnsSince":
      return {
        kind: "dialogTurnsSince",
        metric: expression.metric,
        receiver: cloneValueExpression(
          expression.receiver,
        ) as typeof expression.receiver,
        baseline: cloneValueExpression(
          expression.baseline,
        ) as typeof expression.baseline,
      };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "pendingState":
      return { kind: "pendingState" };
    case "nodeState":
      return { kind: "nodeState", identifier: expression.identifier };
    case "arrayElementRead":
      return {
        kind: "arrayElementRead",
        array: { ...expression.array },
        index: cloneValueExpression(
          expression.index,
        ) as typeof expression.index,
      };
    case "arrayLength":
      return { kind: "arrayLength", array: { ...expression.array } };
    case "span":
      return { kind: "span", owner: expression.owner, key: expression.key };
    case "arrayLiteral":
      return {
        kind: "arrayLiteral",
        elements: expression.elements.map((element) =>
          cloneValueExpression(element),
        ),
      };
    case "judge":
      return {
        id: expression.id,
        kind: "judge",
        question: cloneSemanticString(expression.question),
        loc: expression.loc,
      };
    case "host-call":
      return {
        id: expression.id,
        kind: "host-call",
        module: expression.module,
        target: [...expression.target],
        operation: expression.operation,
        arguments: expression.arguments.map((arg) =>
          cloneHostCallArgument(arg),
        ),
        loc: expression.loc,
      };
    case "regexTest":
      return {
        kind: "regexTest",
        pattern: expression.pattern,
        flags: expression.flags,
        target: cloneValueExpression(
          expression.target,
        ) as typeof expression.target,
      };
    case "comparison":
      return {
        kind: "comparison",
        op: expression.op,
        left: cloneValueExpression(expression.left),
        right: cloneValueExpression(expression.right),
      };
    case "arithmetic":
      return {
        kind: "arithmetic",
        op: expression.op,
        left: cloneValueExpression(expression.left),
        right: cloneValueExpression(expression.right),
      };
    case "logical":
      return {
        kind: "logical",
        op: expression.op,
        left: cloneValueExpression(expression.left),
        right: cloneValueExpression(expression.right),
      };
    case "conditional":
      return {
        kind: "conditional",
        test: cloneValueExpression(expression.test),
        consequent: cloneValueExpression(expression.consequent),
        alternate: cloneValueExpression(expression.alternate),
      };
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: cloneValueExpression(expression.argument),
      };
    case "numericUnary":
      return {
        kind: "numericUnary",
        op: expression.op,
        argument: cloneValueExpression(expression.argument),
      };
    case "numIsFinite":
      return {
        kind: "numIsFinite",
        argument: cloneValueExpression(expression.argument),
      };
    case "template-string":
      return {
        kind: "template-string",
        parts: expression.parts.map((part) => {
          if (part.kind === "text") return { kind: "text", value: part.value };
          return {
            kind: "expression",
            expression: cloneValueExpression(part.expression),
          };
        }),
      };
    case "artifact":
      return {
        kind: "artifact",
        path: cloneValueExpression(expression.path),
      };
  }
}

export function cloneHostCallArgument(arg: HostCallArgument): HostCallArgument {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: cloneSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: cloneValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      elements: arg.elements.map((entry) => cloneHostCallArgument(entry)),
    };
  }
  return {
    kind: "object",
    value: Object.fromEntries(
      Object.entries(arg.value).map(([key, value]) => [
        key,
        cloneHostCallArgument(value),
      ]),
    ),
  };
}

export function cloneSemanticString(semantic: SemanticString): SemanticString {
  if (semantic.kind === "literal") {
    return { kind: "literal", value: semantic.value };
  }

  return {
    kind: "template-string",
    parts: semantic.parts.map((part) => {
      if (part.kind === "text") return { kind: "text", value: part.value };
      if (part.kind === "ref") return { kind: "ref", name: part.name };
      if (part.kind === "hostVar") {
        return { kind: "hostVar", module: part.module, path: [...part.path] };
      }
      return {
        kind: "expression",
        expression: cloneValueExpression(part.expression),
      };
    }),
  };
}

export function upsertTraversal(
  traversals: ArcTraversalSet,
  next: ArcTraversal,
): void {
  const key = next.ref;
  const index = traversals.findIndex((item) => item.ref === key);
  if (index >= 0) traversals[index] = cloneArcTraversal(next);
  else traversals.push(cloneArcTraversal(next));
}

export function ensureOwnedTraversal(
  accum: Accumulator,
  childRef: NodeRef,
  childNode: Node,
): Traversal {
  const ownerRef = lexicalParentRef(childRef);
  if (!ownerRef) {
    throw new Error(`Owned child ${formatRef(childRef)} has no lexical owner`);
  }
  const ownerTraversal = findTraversalInSet(accum.traversals, ownerRef);
  if (!ownerTraversal) {
    throw new Error(
      `Missing lexical owner traversal ${formatRef(ownerRef)} for ${formatRef(childRef)}`,
    );
  }
  let child = ownerTraversal.ownedChildren.find(
    (entry) => entry.ref === childRef,
  );
  if (!child) {
    child = createEmptyNodeTraversal(childRef, childNode);
    ownerTraversal.ownedChildren.push(child);
  }
  return child;
}

export function findEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
): NodeTraversal | undefined {
  return ownerTraversal.ephemeralChildren.find(
    (entry) => entry.ref === childRef,
  );
}

export function replaceEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
  next: NodeTraversal,
): NodeTraversal {
  const index = ownerTraversal.ephemeralChildren.findIndex(
    (entry) => entry.ref === childRef,
  );
  if (index >= 0) ownerTraversal.ephemeralChildren[index] = next;
  else ownerTraversal.ephemeralChildren.push(next);
  return next;
}

export function ensureEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
  childNode: Node,
): NodeTraversal {
  const existing = findEphemeralTraversal(ownerTraversal, childRef);
  if (existing && !isTerminalNodeTraversal(existing)) {
    return existing;
  }
  return replaceEphemeralTraversal(
    ownerTraversal,
    childRef,
    createEmptyNodeTraversal(childRef, childNode),
  );
}

export function isTerminalNodeTraversal(traversal: NodeTraversal): boolean {
  return (
    traversal.state === "covered" ||
    traversal.state === "skipped" ||
    traversal.state === "deflected"
  );
}

export function resolveTraversalForBrief(
  traversals: ArcTraversalSet,
  active: NodeRef,
): Traversal {
  const found = findTraversalInSet(traversals, active);
  if (!found)
    throw new Error(`Active traversal not found: ${formatRef(active)}`);
  return found;
}

export function getActionState<S extends ActionStatement>(
  traversal: Traversal,
  action: S,
): ActionStateOf<S["kind"]> | undefined {
  return traversal.frame.actionStates[action.id] as
    | ActionStateOf<S["kind"]>
    | undefined;
}

/**
 * The bracket snapshot a subtree-opening action persisted, if it holds one.
 * Reads the field without first narrowing to the kinds that carry it, for the
 * sites that only have an action id.
 */
export function actionPreSnapshot(
  state: ActionState | undefined,
): StateSnapshot | undefined {
  return state && "preSnapshot" in state ? state.preSnapshot : undefined;
}

/**
 * The pending `$map` arena for the given map id. The member callback consults it
 * to stage `span.result`; it exists for the whole span of member execution.
 */
export function getMapArena(
  traversal: Traversal,
  mapId: ElementId,
): MapActionState {
  const state = traversal.frame.actionStates[mapId];
  if (state?.kind !== "map" || state.status !== "pending" || !state.map) {
    throw new Error(`No pending $map arena for ${mapId}`);
  }
  return state.map;
}

export function getEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: SegKey,
): Record<ElementId, ActionState | undefined> {
  traversal.frame.evaluatorActionStates ??= {};
  traversal.frame.evaluatorActionStates[scopeKey] ??= {};
  return traversal.frame.evaluatorActionStates[scopeKey]!;
}

export function getEvaluatorActionState(
  traversal: Traversal,
  scopeKey: SegKey,
  action:
    | ObserveAction
    | ObserveOrAskAction
    | ObserveGroupAction
    | ObserveOrAskGroupAction
    | SetAction
    | UnsetAction,
): ActionState | undefined {
  return getEvaluatorActionStates(traversal, scopeKey)[action.id];
}

export function markEvaluatorActionResolved(
  traversal: Traversal,
  scopeKey: SegKey,
  action:
    | ObserveAction
    | ObserveOrAskAction
    | ObserveGroupAction
    | ObserveOrAskGroupAction
    | SetAction
    | UnsetAction,
): void {
  getEvaluatorActionStates(traversal, scopeKey)[action.id] = {
    kind: action.kind,
    status: "resolved",
  };
}

export function clearEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: SegKey,
): void {
  traversal.frame.evaluatorActionStates ??= {};
  delete traversal.frame.evaluatorActionStates[scopeKey];
  // A hook SEG's pin tape lives and dies with its evaluator scope: the
  // consultation's pins release exactly when its narrow-leaf marks do.
  dropPinTape(traversal, scopeKey);
}

export function clearActionState(
  traversal: Traversal,
  actionId: ElementId,
): void {
  delete traversal.frame.actionStates[actionId];
}

export function isResolvedActionState(state: ActionState | undefined): boolean {
  return state?.status === "resolved";
}

// `ActionState` is discriminated so read sites cannot reach continuation state
// the kind does not carry. These two setters write a `kind` that is still the
// whole union, which no single variant accepts, so each asserts the result.
// Every extra is optional on every variant, so the assertion cannot widen what
// a caller may store.

export function markResolvedActionState(
  traversal: Traversal,
  actionId: ElementId,
  kind: ActionState["kind"],
): void {
  traversal.frame.actionStates[actionId] = {
    kind,
    status: "resolved",
  } as ActionState;
}

export function markPendingActionState(
  traversal: Traversal,
  actionId: ElementId,
  kind: ActionState["kind"],
  extras?: PendingActionExtras,
): void {
  traversal.frame.actionStates[actionId] = {
    kind,
    status: "pending",
    stagedReturns: extras?.stagedReturns
      ? { ...extras.stagedReturns }
      : undefined,
    enterPhase: extras?.enterPhase,
    preSnapshot: extras?.preSnapshot,
    instructionPhase: extras?.instructionPhase,
    deflectWhenOutcome: extras?.deflectWhenOutcome,
    resolveWhenOutcome: extras?.resolveWhenOutcome,
    map: extras?.map,
  } as ActionState;
}

export function markPendingHostCall(
  traversal: Traversal,
  actionId: ElementId,
  call: Extract<ActionState, { kind: "host-call"; status: "pending" }>["call"],
): void {
  traversal.frame.actionStates[actionId] = {
    kind: "host-call",
    status: "pending",
    call: {
      arguments: call.arguments.map((argument) => clonePayloadValue(argument)),
      ...(call.hostParams === undefined
        ? {}
        : { hostParams: clonePayloadValue(call.hostParams) }),
    },
  };
}

export function markActionResolved(
  traversal: Traversal,
  action: ActionStatement,
): void {
  markResolvedActionState(traversal, action.id, action.kind);
}

export function clearFrame(traversal: Traversal): void {
  traversal.frame = createTraversalFrame();
}

export function setActiveTraversal(
  accum: Accumulator,
  traversal: Traversal,
): void {
  accum.active = traversalToNodeRef(traversal);
}

/**
 * Records the current frontier on the action root traversal so the next report
 * resumes that exact SEG. Stamped at every block, first walk and resume alike.
 */
export function recordActiveFrame(accum: Accumulator): void {
  if (!accum.active) return;
  const root = selectActionRootTraversal(accum.traversals, accum.entry.arc);
  root.activeFrame = {
    activeRef: accum.active,
    activeSeg: { ...accum.activeSeg },
  };
}

/** Appends a genuinely entered traversal to the walk's transition latch. */
export function latchEnteredTransition(accum: Accumulator, ref: NodeRef): void {
  if (!accum.transitionsEnabled) return;
  (accum.transition ??= { exited: [], entered: [] }).entered.push(ref);
}

/** Appends a genuinely exited traversal to the walk's transition latch. */
export function latchExitedTransition(accum: Accumulator, ref: NodeRef): void {
  if (!accum.transitionsEnabled) return;
  (accum.transition ??= { exited: [], entered: [] }).exited.push(ref);
}

/** Whether the walk has latched position changes awaiting a transition gate. */
export function hasPendingTransitionLatch(accum: Accumulator): boolean {
  return (
    accum.transitionsEnabled &&
    accum.transition !== undefined &&
    (accum.transition.exited.length > 0 || accum.transition.entered.length > 0)
  );
}

/**
 * Flushes the transition latch at the transition block sink, beside the active
 * frame: stamps `position` — the view coordinate, which may differ from the
 * frame's resume coordinate — onto the latch for the brief payload, and
 * persists the stretch (`exited`/`entered`) onto the action root as
 * `pendingTransition`.
 */
export function recordPendingTransition(
  accum: Accumulator,
  position: NodeRef,
): void {
  const latch = accum.transition;
  if (!latch) return;
  latch.position = position;
  const root = selectActionRootTraversal(accum.traversals, accum.entry.arc);
  root.pendingTransition = {
    exited: [...latch.exited],
    entered: [...latch.entered],
  };
}

/** Marks a target traversal as owned by the caller's enter action. */
export function stampEnteredBy(
  target: Traversal,
  callerRef: NodeRef,
  actionId: ElementId,
): void {
  target.enteredBy = { callerRef, actionId };
}

/**
 * Clears a target's `enteredBy` marker when it points at the resolved enter
 * action, called as that enter resolves.
 */
export function clearEnteredByForAction(
  target: Traversal,
  callerRef: NodeRef,
  actionId: ElementId,
): void {
  if (
    target.enteredBy?.callerRef === callerRef &&
    target.enteredBy.actionId === actionId
  ) {
    target.enteredBy = undefined;
  }
}

export function noteBriefYield(accum: Accumulator, traversal: Traversal): void {
  accum.briefActive ??= traversalToNodeRef(traversal);
}

export function childState(
  traversals: ArcTraversalSet,
  ref: ArcRef | NodeRef,
): NodeState | undefined {
  const child = findTraversalInSet(
    traversals,
    isArcRef(ref) ? arcToNodeRef(ref) : ref,
  );
  return child?.state;
}

export function makeBriefId(
  kind: "observe" | "observe-group" | "judge" | "host-call" | "instruction",
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return `${kind}:[${arc}]:[${traversalToNodeRef(traversal)}]:${actionId}`;
}

export function makeObservationId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return makeBriefId("observe", arc, traversal, actionId);
}

export function makeObservationGroupId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return makeBriefId("observe-group", arc, traversal, actionId);
}

export function makeJudgeId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return makeBriefId("judge", arc, traversal, actionId);
}

export function makeHostCallId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return makeBriefId("host-call", arc, traversal, actionId);
}

export function makeInstructionId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: ElementId,
): BriefId {
  return makeBriefId("instruction", arc, traversal, actionId);
}

export function dedupeBriefIds(ids: BriefId[]): BriefId[] {
  return [...new Set(ids)];
}

export function isInstructionBatchActive(
  accum: Accumulator,
  traversal: Traversal,
): boolean {
  return accum.instructionBatchNode === traversalToNodeRef(traversal);
}

// TODO: the previous batching condition is too generous and hooks with side
// effects can be batched but the desired semantics of batched hooks is under-
// specified
export function canBatchInstruction(
  accum: Accumulator,
  node: Node,
  statement: InstructionAction,
): boolean {
  // Instruction batching is intentionally dormant. Keep the surrounding
  // runtime batch-shaped so hosts remain free to accept multi-item briefs and
  // this optimization can be restored without changing the protocol.
  //
  // const signature = accum.instructionBatchSignature;
  // return (
  //   signature === undefined ||
  //   signature === instructionBatchSignature(node, statement)
  // );
  void accum;
  void node;
  void statement;
  return false;
}

export function instructionBatchSignature(
  node: Node,
  statement: InstructionAction,
): string {
  return JSON.stringify({
    mode: statement.mode,
    hostParams: normalizePayloadValue(
      mergeAndClonePayload(node.hostParams, statement.hostParams),
    ),
    resolveWhen: normalizeResolutionStatements(statement.resolveWhen),
    deflectWhen: normalizeResolutionStatements(statement.deflectWhen),
  });
}

function normalizePayloadValue(value: PayloadValue): unknown {
  if (Array.isArray(value))
    return value.map((item) => normalizePayloadValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizePayloadValue(item)]),
    );
  }
  return value;
}

export function normalizeResolutionStatements(
  statements: TriggerStatement[] | undefined,
): unknown {
  return (
    statements?.map((statement) => normalizeResolutionStatement(statement)) ??
    null
  );
}

export function normalizeResolutionStatement(
  statement: TriggerStatement,
): unknown {
  if (statement.kind === "if") {
    return {
      kind: "if",
      test: normalizeValueExpression(statement.test),
      consequent: statement.consequent.map((entry) =>
        normalizeResolutionStatement(entry),
      ),
      alternate: statement.alternate?.map((entry) =>
        normalizeResolutionStatement(entry),
      ),
    };
  }
  if (statement.kind === "return") {
    return {
      kind: "return",
      value: statement.value ? normalizeValueExpression(statement.value) : null,
    };
  }
  if (statement.kind === "label") {
    return {
      kind: "label",
      label: statement.label,
      body: statement.body.map((entry) => normalizeResolutionStatement(entry)),
    };
  }
  if (statement.kind === "break") {
    return {
      kind: "break",
      label: statement.label,
    };
  }
  if (statement.kind === "set") {
    return {
      kind: "set",
      target: normalizeCellTarget(statement.target),
      value: normalizeValueExpression(statement.value),
    };
  }
  if (statement.kind === "unset") {
    return {
      kind: "unset",
      target: normalizeCellTarget(statement.target),
    };
  }
  if (statement.kind === "observeGroup") {
    return {
      kind: "observeGroup",
      targets: statement.targets.map((target) => normalizeCellTarget(target)),
    };
  }
  return {
    kind: "observe",
    target: normalizeCellTarget(statement.target),
    question:
      statement.question !== undefined
        ? normalizeSemanticString(statement.question)
        : null,
  };
}

function normalizeCellTarget(target: CellTarget): unknown {
  const [root, ...accessors] = target;
  return [
    root,
    ...accessors.map((accessor) => normalizeValueExpression(accessor)),
  ];
}

export function normalizeValueExpression(expression: ValueExpression): unknown {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "cell":
      return { kind: "cell", name: expression.name };
    case "isUnset":
      return { kind: "isUnset", cell: expression.cell };
    case "channel":
      return {
        kind: "channel",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "channelIsUnset":
      return {
        kind: "channelIsUnset",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "deflectionEscaped":
      return {
        kind: "deflectionEscaped",
        target: { ...expression.target },
      };
    case "dialogCursor":
      return { kind: "dialogCursor" };
    case "dialogTurnsSince":
      return {
        kind: "dialogTurnsSince",
        metric: expression.metric,
        receiver: normalizeValueExpression(expression.receiver),
        baseline: normalizeValueExpression(expression.baseline),
      };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count ?? null,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "pendingState":
      return { kind: "pendingState" };
    case "nodeState":
      return { kind: "nodeState", node: expression.identifier };
    case "arrayElementRead":
      return {
        kind: "arrayElementRead",
        array: { ...expression.array },
        index: normalizeValueExpression(expression.index),
      };
    case "arrayLength":
      return { kind: "arrayLength", array: { ...expression.array } };
    case "span":
      return { kind: "span", owner: expression.owner, key: expression.key };
    case "arrayLiteral":
      return {
        kind: "arrayLiteral",
        elements: expression.elements.map((element) =>
          normalizeValueExpression(element),
        ),
      };
    case "judge":
      return {
        kind: "judge",
        question: normalizeSemanticString(expression.question),
      };
    case "host-call":
      return {
        kind: "host-call",
        module: expression.module,
        target: [...expression.target],
        operation: expression.operation,
        arguments: expression.arguments.map((arg) =>
          normalizeHostCallArgument(arg),
        ),
      };
    case "regexTest":
      return {
        kind: "regexTest",
        pattern: expression.pattern,
        flags: expression.flags,
        target: normalizeValueExpression(expression.target),
      };
    case "comparison":
      return {
        kind: "comparison",
        op: expression.op,
        left: normalizeValueExpression(expression.left),
        right: normalizeValueExpression(expression.right),
      };
    case "arithmetic":
      return {
        kind: "arithmetic",
        op: expression.op,
        left: normalizeValueExpression(expression.left),
        right: normalizeValueExpression(expression.right),
      };
    case "logical":
      return {
        kind: "logical",
        op: expression.op,
        left: normalizeValueExpression(expression.left),
        right: normalizeValueExpression(expression.right),
      };
    case "conditional":
      return {
        kind: "conditional",
        test: normalizeValueExpression(expression.test),
        consequent: normalizeValueExpression(expression.consequent),
        alternate: normalizeValueExpression(expression.alternate),
      };
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: normalizeValueExpression(expression.argument),
      };
    case "numericUnary":
      return {
        kind: "numericUnary",
        op: expression.op,
        argument: normalizeValueExpression(expression.argument),
      };
    case "numIsFinite":
      return {
        kind: "numIsFinite",
        argument: normalizeValueExpression(expression.argument),
      };
    case "template-string":
      return {
        kind: "template-string",
        parts: expression.parts.map((part) => {
          if (part.kind === "text") return { kind: "text", value: part.value };
          return {
            kind: "expression",
            expression: normalizeValueExpression(part.expression),
          };
        }),
      };
    case "artifact":
      return {
        kind: "artifact",
        path: normalizeValueExpression(expression.path),
      };
  }
}

export function normalizeHostCallArgument(arg: HostCallArgument): unknown {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: normalizeSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: normalizeValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      elements: arg.elements.map((entry) => normalizeHostCallArgument(entry)),
    };
  }
  return {
    kind: "object",
    value: Object.fromEntries(
      Object.entries(arg.value).map(([key, value]) => [
        key,
        normalizeHostCallArgument(value),
      ]),
    ),
  };
}

export function normalizeSemanticString(semantic: SemanticString): unknown {
  if (semantic.kind === "literal") {
    return { kind: "literal", value: semantic.value };
  }

  return semantic.parts.map((part) => {
    if (part.kind === "text") return { kind: "text", value: part.value };
    if (part.kind === "ref") return { kind: "ref", name: part.name };
    if (part.kind === "hostVar") {
      return { kind: "hostVar", module: part.module, path: [...part.path] };
    }
    return {
      kind: "expression",
      expression: normalizeValueExpression(part.expression),
    };
  });
}
