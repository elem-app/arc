import type {
  ActionBrief,
  ActionMove,
  ActionReport,
  ActionState,
  ActionStatement,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BinaryOperator,
  Dialog,
  Document,
  EffectStatement,
  GuardStatement,
  HostCallArgument,
  HostCallBrief,
  HostCallExpression,
  HostEffect,
  HostEffectStatement,
  InstructionAction,
  InstructionBrief,
  JudgeExpression,
  JudgmentBrief,
  LocalExpression,
  Node,
  NodeRef,
  NodeState,
  NodeTraversal,
  ObservationBrief,
  ObservationReport,
  ObserveAction,
  ObserveOrAskAction,
  PayloadValue,
  PendingEffects,
  PrimitiveValue,
  SemanticString,
  SetAction,
  Statement,
  Traversal,
  TriggerBrief,
  TriggerOutcome,
  TriggerReport,
  TriggerStatement,
  ValueExpression,
  Variable,
} from "../types.js";

export function toArcRef(source: string, identifier: string): ArcRef {
  return `arc:${encodeURIComponent(source)}:${encodeURIComponent(identifier)}`;
}

export function toNodeRef(source: string, path: string[]): NodeRef {
  return `node:${encodeURIComponent(source)}:${path.map(encodeURIComponent).join(".")}`;
}

export function toArcRefParts(ref: ArcRef): {
  source: string;
  identifier: string;
} {
  const [, source, id] = ref.split(":");
  if (source === undefined || id === undefined)
    throw new Error(`Invalid ArcRef: ${ref}`);
  return {
    source: decodeURIComponent(source),
    identifier: decodeURIComponent(id),
  };
}

export function toNodeRefParts(ref: NodeRef): {
  source: string;
  path: string[];
} {
  const [, source, encodedPath] = ref.split(":");
  if (source === undefined || encodedPath === undefined)
    throw new Error(`Invalid NodeRef: ${ref}`);
  return {
    source: decodeURIComponent(source),
    path: encodedPath.split(".").map(decodeURIComponent),
  };
}

type RegistryEntry = {
  arc: ArcRef;
  document: Document;
  root: Node;
  importRefs: Record<string, ArcRef>;
};

type BlockedBy =
  | { kind: "trigger"; arc: ArcRef; node: string }
  | { kind: "guard"; arc: ArcRef; node: string }
  | {
      kind: "statement";
      arc: ArcRef;
      node: string;
      statementIndex: number;
      statementKind: Statement["kind"];
    };

type Accumulator = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversal: Traversal;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  phase: "plan" | "apply";
  judgments: JudgmentBrief[];
  observations: ObservationBrief[];
  hostCalls: HostCallBrief[];
  instructions: InstructionBrief[];
  hostEffects: HostEffect[];
  blockedBy: BlockedBy | undefined;
  active?: NodeRef;
  briefActive?: NodeRef;
  instructionBatchNode?: NodeRef;
  judgmentResults: Map<string, boolean>;
  observationResults: Map<string, ObservationReport>;
  hostCallResults: Map<string, PayloadValue>;
};

type EvalResult =
  | { status: "value"; value: PayloadValue | NodeState }
  | { status: "blocked" };

type RunStatus =
  | { status: "done" }
  | { status: "blocked" }
  | { status: "yielded" }
  | { status: "break"; label: string };

type ActionBriefSnapshot = Omit<ActionBrief, "traversals" | "hostEffects">;
type TriggerBriefSnapshot = TriggerBrief;

type ActionBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  snapshot: ActionBriefSnapshot;
};

type TriggerBriefState = {
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  snapshot: TriggerBriefSnapshot;
};

export class Runtime {
  readonly #documents = new Map<string, Document>();
  readonly #entries = new Map<ArcRef, RegistryEntry>();
  readonly #actionBriefState = new WeakMap<ActionBrief, ActionBriefState>();
  readonly #triggerBriefState = new WeakMap<TriggerBrief, TriggerBriefState>();

  add(source: string, document: Document): this {
    if (this.#documents.has(source)) {
      throw new Error(`Document already registered for source ${source}`);
    }
    this.#documents.set(source, document);

    for (const root of document.roots) {
      const arc = toArcRef(source, root.identifier);
      if (this.#entries.has(arc)) {
        throw new Error(`Duplicate arc registration: ${formatNodeRef(arc)}`);
      }
      this.#entries.set(arc, {
        arc,
        document,
        root,
        importRefs: {},
      });
    }

    this.#refreshImportRefs();
    return this;
  }

  has(arc: ArcRef): boolean {
    return this.#entries.has(arc);
  }

  createTraversal(arc: ArcRef): ArcTraversal {
    const entry = this.#getEntry(arc);
    return createFreshArcTraversal(arc, entry.root, 1);
  }

  startTrigger(dialog: Dialog, traversals: ArcTraversalSet = []): TriggerBrief {
    const entries = [...this.#entries.values()];
    const entryByArc = new Map(entries.map((entry) => [entry.arc, entry]));
    const traversalByArc = indexTraversals(traversals);
    const judgments: JudgmentBrief[] = [];
    const observations: ObservationBrief[] = [];
    const hostCalls: HostCallBrief[] = [];
    const matchableArcs: ArcRef[] = [];

    for (const entry of entries) {
      const existing = traversalByArc.get(entry.arc);
      const base = existing
        ? cloneArcTraversal(existing)
        : createFreshArcTraversal(entry.arc, entry.root, 0);
      const runtime = createAccumulator(
        this.#entries,
        entry,
        base,
        [base],
        dialog,
        "plan",
      );
      const matched = runTrigger(entry.root, base, runtime);
      judgments.push(...runtime.judgments);
      observations.push(...runtime.observations);
      hostCalls.push(...runtime.hostCalls);
      if (matched && !runtime.blockedBy) {
        matchableArcs.push(entry.arc);
      }
    }

    const snapshot = cloneTriggerBriefSnapshot({
      judgments,
      observations,
      hostCalls,
      matchableArcs,
    });
    const brief: TriggerBrief = cloneTriggerBriefSnapshot(snapshot);
    this.#triggerBriefState.set(brief, {
      entryByArc,
      traversals: cloneTraversalSet(traversals),
      dialog: cloneDialog(dialog),
      snapshot: cloneTriggerBriefSnapshot(snapshot),
    });
    return brief;
  }

  progressTrigger(brief: TriggerBrief, report: TriggerReport): TriggerOutcome {
    const state = this.#triggerBriefState.get(brief);
    if (!state) throw new Error("Unknown trigger brief");
    return acceptTriggerReport(
      this.#entries,
      state.entryByArc,
      state.traversals,
      state.dialog,
      state.snapshot,
      report,
    );
  }

  start(traversals: ArcTraversalSet, dialog: Dialog): ActionBrief {
    const rootTraversal = selectActionRootTraversal(traversals);
    if (rootTraversal.phase !== "entered") {
      throw new Error(
        `Root traversal phase must be "entered", got "${rootTraversal.phase}"`,
      );
    }
    const entry = this.#getEntry(rootTraversal.ref);
    return this.#createActionBrief(entry, traversals, dialog);
  }

  progress(brief: ActionBrief, report: ActionReport): ActionBrief {
    const state = this.#actionBriefState.get(brief);
    if (!state) throw new Error("Unknown action brief");

    const rootTraversal = selectActionRootTraversal(
      state.traversals,
      state.entry.arc,
    );
    if (rootTraversal.phase !== "entered") {
      validateActionReport(state.snapshot, report);
      return this.#createActionBrief(
        state.entry,
        state.traversals,
        state.dialog,
      );
    }

    const applied = acceptActionReport(
      state.entries,
      state.entry,
      state.traversals,
      state.dialog,
      state.snapshot,
      report,
    );

    return this.#createActionBrief(
      state.entry,
      applied.traversals,
      state.dialog,
      applied.hostEffects,
      applied.instructions,
      isStopped(selectActionRootTraversal(applied.traversals, state.entry.arc))
        ? state.snapshot.active
        : undefined,
    );
  }

  #getEntry(ref: ArcRef): RegistryEntry {
    const entry = this.#entries.get(ref);
    if (!entry) throw new Error(`Unknown arc: ${formatNodeRef(ref)}`);
    return entry;
  }

  #refreshImportRefs(): void {
    for (const [key, entry] of this.#entries) {
      const importRefs: Record<string, ArcRef> = {};
      for (const binding of entry.document.imports) {
        const imported = toArcRef(binding.source, binding.importedName);
        if (this.#entries.has(imported)) {
          importRefs[binding.localName] = imported;
        }
      }
      this.#entries.set(key, { ...entry, importRefs });
    }
  }

  #createActionBrief(
    entry: RegistryEntry,
    traversals: ArcTraversalSet,
    dialog: Dialog,
    leadingHostEffects: HostEffect[] = [],
    leadingInstructions: InstructionBrief[] = [],
    activeHint?: NodeRef,
  ): ActionBrief {
    const workingTraversals = cloneTraversalSet(traversals);
    const workingRoot = selectActionRootTraversal(workingTraversals, entry.arc);
    const runtime = createAccumulator(
      this.#entries,
      entry,
      workingRoot,
      workingTraversals,
      dialog,
      "plan",
    );
    if (workingRoot.phase === "entered") {
      runTurn(runtime);
    } else if (activeHint) {
      runtime.active = activeHint;
    }
    for (const traversal of workingTraversals) {
      const traversalEntry = this.#getEntry(rootRefOf(traversal.ref));
      pruneFrames(traversalEntry, traversal);
    }
    const yieldedTraversals = cloneTraversalSet(workingTraversals);
    const snapshot = cloneActionBriefSnapshot(
      finalizeActionBrief(
        runtime,
        selectActionRootTraversal(yieldedTraversals, entry.arc),
      ),
    );
    const brief: ActionBrief = {
      traversals: yieldedTraversals,
      hostEffects: [
        ...leadingHostEffects.map(cloneHostEffect),
        ...runtime.hostEffects.map(cloneHostEffect),
      ],
      ...snapshot,
      instructions: [
        ...leadingInstructions.map((item) => ({ ...item })),
        ...snapshot.instructions,
      ],
    };

    this.#actionBriefState.set(brief, {
      entries: this.#entries,
      entry,
      traversals: cloneTraversalSet(yieldedTraversals),
      dialog: cloneDialog(dialog),
      snapshot: cloneActionBriefSnapshot({
        ...snapshot,
        instructions: [
          ...leadingInstructions.map((item) => ({ ...item })),
          ...snapshot.instructions,
        ],
      }),
    });

    return brief;
  }
}

function createAccumulator(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversal: Traversal,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  phase: "plan" | "apply",
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
    instructions: [],
    hostEffects: [],
    blockedBy: undefined,
    active: undefined,
    briefActive: undefined,
    instructionBatchNode: undefined,
    judgmentResults: new Map(),
    observationResults: new Map(),
    hostCallResults: new Map(),
  };
}

function createFreshArcTraversal(
  arcRef: ArcRef,
  node: Node,
  enterCount: number,
  returnTo: ArcRef | null = null,
): ArcTraversal {
  const variables: Record<string, PrimitiveValue | undefined> = {};
  for (const variable of node.variables) variables[variable.name] = undefined;
  return {
    ref: arcRef,
    returnTo,
    phase: "dormant" as const,
    enterCount,
    state: undefined,
    variables,
    frame: { actionStates: {} },
    ownedChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
  };
}

function createFreshNodeTraversal(
  nodeRef: NodeRef,
  node: Node,
  enterCount: number,
): NodeTraversal {
  const variables: Record<string, PrimitiveValue | undefined> = {};
  for (const variable of node.variables) variables[variable.name] = undefined;
  return {
    ref: nodeRef,
    enterCount,
    state: undefined,
    variables,
    frame: { actionStates: {} },
    ownedChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
  };
}

function restartTraversal(
  entry: RegistryEntry,
  base?: ArcTraversal,
): ArcTraversal {
  if (!base) {
    const fresh = createFreshArcTraversal(entry.arc, entry.root, 1);
    fresh.phase = "entered";
    return fresh;
  }
  const next = cloneArcTraversal(base);
  next.enterCount += 1;
  next.phase = "entered";
  next.pendingEffects = undefined;
  next.state = undefined;
  next.returnTo = null;
  if (!entry.root.resumable) clearFrame(next);
  return next;
}

function cloneNodeTraversal(traversal: NodeTraversal): NodeTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversalToNodeRef(traversal),
  };
}

function cloneArcTraversal(traversal: ArcTraversal): ArcTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversal.ref,
    returnTo: traversal.returnTo,
    phase: traversal.phase,
    pendingEffects: traversal.pendingEffects
      ? { ...traversal.pendingEffects }
      : undefined,
  };
}

function cloneTraversalBase<T extends Traversal>(traversal: T) {
  return {
    enterCount: traversal.enterCount,
    state: traversal.state,
    variables: { ...traversal.variables },
    frame: {
      actionStates: Object.fromEntries(
        Object.entries(traversal.frame.actionStates).map(([id, state]) => [
          id,
          state ? { ...state } : undefined,
        ]),
      ),
    },
    ownedChildren: traversal.ownedChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    refChildren: [...traversal.refChildren],
    appliedHostCallKeys: [...traversal.appliedHostCallKeys],
  };
}

function cloneTraversalSet(traversals: ArcTraversalSet): ArcTraversalSet {
  return traversals.map((traversal) => cloneArcTraversal(traversal));
}

function isStopped(traversal: ArcTraversal): boolean {
  return traversal.phase === "completed" || traversal.phase === "suspended";
}

function selectActionRootTraversal(
  traversals: ArcTraversalSet,
  preferredRoot?: ArcRef,
): ArcTraversal {
  if (preferredRoot) {
    const preferred = traversals.find(
      (traversal) => traversal.ref === preferredRoot,
    );
    if (preferred) return preferred;
  }
  const root = traversals.find((traversal) => traversal.returnTo === null);
  if (root) return root;
  const first = traversals[0];
  if (!first) throw new Error("Action traversal set is empty");
  return first;
}

function cloneDialog(dialog: Dialog): Dialog {
  return {
    lastTurns: dialog.lastTurns.map((turn) => ({ ...turn })),
    names: dialog.names ? { ...dialog.names } : undefined,
  };
}

function cloneHostEffect(call: HostEffect): HostEffect {
  return {
    module: call.module,
    target: [...call.target],
    operation: call.operation,
    arguments: [...call.arguments],
  };
}

function cloneHostCallBrief(brief: HostCallBrief): HostCallBrief {
  return {
    id: brief.id,
    arc: brief.arc,
    node: brief.node,
    module: brief.module,
    target: [...brief.target],
    operation: brief.operation,
    arguments: [...brief.arguments],
  };
}

function pruneFrames(entry: RegistryEntry, traversal: Traversal): void {
  const node = resolveNodeForRef(entry, traversal.ref);
  if (!node) return;
  if (!node.resumable) traversal.frame = { actionStates: {} };
  for (const child of traversal.ownedChildren) pruneFrames(entry, child);
}

function isArcRef(ref: ArcRef | NodeRef): ref is ArcRef {
  return ref.startsWith("arc:");
}

function isArcTraversal(traversal: Traversal): traversal is ArcTraversal {
  return isArcRef(traversal.ref);
}

function rootRefOf(ref: ArcRef | NodeRef): ArcRef {
  if (isArcRef(ref)) return ref;
  const { source, path } = toNodeRefParts(ref);
  return toArcRef(source, path[0] ?? "");
}

function arcToNodeRef(ref: ArcRef): NodeRef {
  const { source, identifier } = toArcRefParts(ref);
  return toNodeRef(source, [identifier]);
}

function traversalToNodeRef(traversal: Traversal): NodeRef {
  return isArcTraversal(traversal)
    ? arcToNodeRef(traversal.ref)
    : traversal.ref;
}

function getEntryForRef(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  ref: ArcRef | NodeRef,
): RegistryEntry | undefined {
  return entries.get(rootRefOf(ref));
}

function nodeIdentifier(ref: NodeRef): string {
  return toNodeRefParts(ref).path.join(".");
}

function formatArcRef(ref: ArcRef): string {
  const { source, identifier: id } = toArcRefParts(ref);
  return `${source}#${id}`;
}

function formatNodeRef(ref: ArcRef | NodeRef): string {
  if (isArcRef(ref)) return formatArcRef(ref);
  const { source } = toNodeRefParts(ref);
  return `${source}#${nodeIdentifier(ref)}`;
}

function indexTraversals(
  traversals: ArcTraversalSet,
): Map<ArcRef, ArcTraversal> {
  const indexed = new Map<ArcRef, ArcTraversal>();
  for (const traversal of traversals) indexed.set(traversal.ref, traversal);
  return indexed;
}

function upsertTraversal(
  traversals: ArcTraversalSet,
  next: ArcTraversal,
): void {
  const key = next.ref;
  const index = traversals.findIndex((item) => item.ref === key);
  if (index >= 0) traversals[index] = cloneArcTraversal(next);
  else traversals.push(cloneArcTraversal(next));
}

function resolveNodeForRef(
  entry: RegistryEntry,
  ref: ArcRef | NodeRef,
): Node | undefined {
  const arc = toArcRefParts(entry.arc);
  const target = isArcRef(ref) ? toArcRefParts(ref) : toNodeRefParts(ref);
  if (target.source !== arc.source) return undefined;
  const parts = "identifier" in target ? [target.identifier] : target.path;
  let current: Node | undefined = entry.root;
  if (parts[0] !== entry.root.identifier) return undefined;
  for (const part of parts.slice(1)) {
    current = current?.children.find((child) => child.identifier === part);
    if (!current) return undefined;
  }
  return current;
}

function lexicalParentRef(ref: NodeRef): NodeRef | undefined {
  const { source, path } = toNodeRefParts(ref);
  if (path.length <= 1) return undefined;
  return toNodeRef(source, path.slice(0, -1));
}

function findTraversal(root: Traversal, ref: NodeRef): Traversal | undefined {
  if (!isArcTraversal(root) && root.ref === ref) return root;
  if (isArcTraversal(root) && arcToNodeRef(root.ref) === ref) return root;
  for (const child of root.ownedChildren) {
    const found = findTraversal(child, ref);
    if (found) return found;
  }
  return undefined;
}

function findTraversalInSet(
  traversals: ArcTraversalSet,
  ref: NodeRef,
): Traversal | undefined {
  for (const traversal of traversals) {
    const found = findTraversal(traversal, ref);
    if (found) return found;
  }
  return undefined;
}

function ensureOwnedTraversal(
  runtime: Accumulator,
  childRef: NodeRef,
  childNode: Node,
): Traversal {
  const ownerRef = lexicalParentRef(childRef);
  if (!ownerRef) {
    throw new Error(
      `Owned child ${formatNodeRef(childRef)} has no lexical owner`,
    );
  }
  const ownerTraversal = findTraversalInSet(runtime.traversals, ownerRef);
  if (!ownerTraversal) {
    throw new Error(
      `Missing lexical owner traversal ${formatNodeRef(ownerRef)} for ${formatNodeRef(childRef)}`,
    );
  }
  let child = ownerTraversal.ownedChildren.find(
    (entry) => entry.ref === childRef,
  );
  if (!child) {
    child = createFreshNodeTraversal(childRef, childNode, 0);
    ownerTraversal.ownedChildren.push(child);
  }
  return child;
}

function resolveTraversalForBrief(
  traversals: ArcTraversalSet,
  active: NodeRef,
): Traversal {
  const found = findTraversalInSet(traversals, active);
  if (!found)
    throw new Error(`Active traversal not found: ${formatNodeRef(active)}`);
  return found;
}

function getActionState(
  traversal: Traversal,
  action: ActionStatement | HostEffectStatement,
): ActionState | undefined {
  return traversal.frame.actionStates[action.id];
}

function markResolvedActionState(
  traversal: Traversal,
  actionId: number,
  kind: ActionState["kind"],
): void {
  traversal.frame.actionStates[actionId] = { kind, resolved: true };
}

function markActionResolved(
  traversal: Traversal,
  action: ActionStatement | HostEffectStatement,
): void {
  markResolvedActionState(traversal, action.id, action.kind);
}

function clearFrame(traversal: Traversal): void {
  traversal.frame = { actionStates: {} };
}

function childState(
  traversals: ArcTraversalSet,
  ref: ArcRef | NodeRef,
): NodeState | undefined {
  const child = findTraversalInSet(
    traversals,
    isArcRef(ref) ? arcToNodeRef(ref) : ref,
  );
  return child?.state;
}

function childResolved(traversals: ArcTraversalSet, ref: NodeRef): boolean {
  const state = childState(traversals, ref);
  return state === "covered" || state === "skipped";
}

function isNodeState(value: unknown): value is NodeState {
  return value === "covered" || value === "deflected" || value === "skipped";
}

function runTrigger(
  node: Node,
  traversal: Traversal,
  runtime: Accumulator,
): boolean {
  if (!node.trigger) return true;
  return runTriggerStatements(
    node,
    traversal,
    node.trigger,
    runtime,
    "trigger",
  );
}

function runTriggerStatements(
  node: Node,
  traversal: Traversal,
  statements: TriggerStatement[],
  runtime: Accumulator,
  kind: "trigger",
): boolean {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        runtime,
      );
      if (result.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind,
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return false;
      }
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      if (runTriggerStatements(node, traversal, branch, runtime, kind))
        return true;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return false;
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        runtime,
      );
      if (result.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind,
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return false;
      }
      return truthy(result.value);
    }

    if (getActionState(traversal, statement)?.resolved) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, runtime);
      if (apply.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind,
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return false;
      }
      markActionResolved(traversal, statement);
      continue;
    }
  }

  return false;
}

function runGuardStatements(
  node: Node,
  traversal: Traversal,
  statements: GuardStatement[],
  runtime: Accumulator,
): NodeState | undefined {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        runtime,
      );
      if (result.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind: "guard",
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return undefined;
      }
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const state = runGuardStatements(node, traversal, branch, runtime);
      if (runtime.blockedBy || state) return state;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return undefined;
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        runtime,
      );
      if (result.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind: "guard",
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return undefined;
      }
      return isNodeState(result.value) ? result.value : undefined;
    }

    if (getActionState(traversal, statement)?.resolved) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, runtime);
      if (apply.status === "blocked") {
        runtime.active = traversalToNodeRef(traversal);
        runtime.blockedBy = {
          kind: "guard",
          arc: runtime.entry.arc,
          node: node.identifier,
        };
        return undefined;
      }
      markActionResolved(traversal, statement);
      continue;
    }
  }

  return undefined;
}

function acceptTriggerReport(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  plan: TriggerBriefSnapshot,
  report: TriggerReport,
): TriggerOutcome {
  validateTriggerReport(plan, report);

  const nextTraversals = cloneTraversalSet(traversals);
  const traversalByArc = indexTraversals(traversals);
  const matchable = new Set(plan.matchableArcs);

  for (const [arcKey, entry] of entryByArc) {
    const existing = traversalByArc.get(arcKey);
    const base = existing
      ? cloneArcTraversal(existing)
      : createFreshArcTraversal(entry.arc, entry.root, 0);
    const runtime = createAccumulator(
      entries,
      entry,
      base,
      [base],
      dialog,
      "apply",
    );
    for (const [id, value] of Object.entries(report.judgments ?? {}))
      runtime.judgmentResults.set(id, value);
    for (const [id, value] of Object.entries(report.observations ?? {}))
      if (value) runtime.observationResults.set(id, value);
    for (const [id, value] of Object.entries(report.hostCalls ?? {}))
      runtime.hostCallResults.set(id, value);
    const matched = runTrigger(entry.root, base, runtime);
    if (matched && !runtime.blockedBy) matchable.add(arcKey);
  }

  let matchKey = report.match ? report.match : undefined;
  if (!matchKey && matchable.size === 1) matchKey = [...matchable][0];
  if (!matchKey) return { matched: undefined, traversals: nextTraversals };
  if (!matchable.has(matchKey)) {
    throw new Error(
      `Selected arc ${formatNodeRef(report.match!)} is not matchable in this trigger brief`,
    );
  }

  const entry = entryByArc.get(matchKey);
  if (!entry) throw new Error(`Unknown arc: ${matchKey}`);
  const existing = traversalByArc.get(matchKey);
  const base = existing
    ? cloneArcTraversal(existing)
    : createFreshArcTraversal(entry.arc, entry.root, 0);
  const runtime = createAccumulator(
    entries,
    entry,
    base,
    [base],
    dialog,
    "apply",
  );
  for (const [id, value] of Object.entries(report.judgments ?? {}))
    runtime.judgmentResults.set(id, value);
  for (const [id, value] of Object.entries(report.observations ?? {}))
    if (value) runtime.observationResults.set(id, value);
  for (const [id, value] of Object.entries(report.hostCalls ?? {}))
    runtime.hostCallResults.set(id, value);
  const matched = runTrigger(entry.root, base, runtime);
  if (!matched || runtime.blockedBy) {
    throw new Error(
      `Arc ${formatNodeRef(entry.arc)} did not satisfy its trigger under the accepted report`,
    );
  }
  const seeded = restartTraversal(entry, base);
  upsertTraversal(nextTraversals, seeded);
  return { matched: seeded.ref, traversals: nextTraversals };
}

function cloneTriggerBriefSnapshot(
  plan: TriggerBriefSnapshot,
): TriggerBriefSnapshot {
  return {
    judgments: plan.judgments.map((item) => ({ ...item })),
    observations: plan.observations.map((item) => ({ ...item })),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    matchableArcs: [...plan.matchableArcs],
  };
}

function validateTriggerReport(
  plan: TriggerBriefSnapshot,
  report: TriggerReport,
): void {
  if (report.match) {
    const candidate = new Set([
      ...plan.matchableArcs,
      ...plan.judgments.map((item) => item.arc),
      ...plan.observations.map((item) => item.arc),
      ...plan.hostCalls.map((item) => item.arc),
    ]);
    if (!candidate.has(report.match)) {
      throw new Error(
        `Unknown arc selected in trigger report: ${formatNodeRef(report.match)}`,
      );
    }
  }
  if (report.judgments) {
    const ids = new Set(plan.judgments.map((item) => item.id));
    for (const id of Object.keys(report.judgments))
      if (!ids.has(id))
        throw new Error(`Unknown judgment id in trigger report: ${id}`);
  }
  if (report.observations) {
    const ids = new Set(plan.observations.map((item) => item.id));
    for (const id of Object.keys(report.observations))
      if (!ids.has(id))
        throw new Error(`Unknown observation id in trigger report: ${id}`);
  }
  if (report.hostCalls) {
    const ids = new Set(plan.hostCalls.map((item) => item.id));
    for (const id of Object.keys(report.hostCalls))
      if (!ids.has(id))
        throw new Error(`Unknown host call id in trigger report: ${id}`);
  }
}

function runTurn(runtime: Accumulator): void {
  const rootNode = resolveNodeForRef(runtime.entry, runtime.traversal.ref);
  if (!rootNode)
    throw new Error(
      `Unknown root traversal node: ${formatNodeRef(runtime.traversal.ref)}`,
    );
  if (isArcTraversal(runtime.traversal) && runtime.traversal.pendingEffects) {
    const pendingEffects = runtime.traversal.pendingEffects;
    const status = runPendingEffects(runtime, pendingEffects);
    if (status.status !== "done") return;
    completePendingEffects(runtime, pendingEffects);
    return;
  }
  const status = runTraversal(runtime.traversal, rootNode, runtime, true);
  if (status.status === "break") {
    throw new Error(`Unhandled break label: ${status.label}`);
  }
  if (status.status !== "done") return;
  runtime.traversal.state = "covered";
  if (isArcTraversal(runtime.traversal)) {
    runtime.traversal.phase = "completed";
  }
}

function runTraversal(
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
  isRoot = false,
): RunStatus {
  runtime.active = traversalToNodeRef(traversal);

  if (!isRoot) {
    if (traversal.state === "covered" || traversal.state === "skipped") {
      return { status: "done" };
    }
    if (node.guard) {
      const guardState = runGuardStatements(
        node,
        traversal,
        node.guard,
        runtime,
      );
      if (runtime.blockedBy) return { status: "blocked" };
      if (guardState) {
        traversal.state = guardState;
        return { status: "done" };
      }
    }
  }

  for (let index = 0; index < node.statements.length; index++) {
    const statement = node.statements[index];
    if (!statement) continue;
    const status = runStatement(
      traversal,
      node,
      statement,
      runtime,
      index,
      index,
    );
    if (status.status !== "done") return status;
  }

  if (isInstructionBatchActive(runtime, traversal)) {
    return { status: "yielded" };
  }

  const effects = runEffects(traversal, node, runtime);
  if (effects.status !== "done") return effects;

  traversal.state = "covered";
  if (isArcTraversal(traversal)) {
    traversal.phase = "completed";
  }
  return { status: "done" };
}

function runStatementBlock(
  traversal: Traversal,
  node: Node,
  statements: Statement[],
  runtime: Accumulator,
  topLevelIndex: number,
): RunStatus {
  for (const statement of statements) {
    const status = runStatement(
      traversal,
      node,
      statement,
      runtime,
      topLevelIndex,
      topLevelIndex,
    );
    if (status.status !== "done") return status;
  }
  return { status: "done" };
}

function runStatement(
  traversal: Traversal,
  node: Node,
  statement: Statement,
  runtime: Accumulator,
  topLevelIndex: number,
  statementIndex: number,
): RunStatus {
  if (statement.kind === "if") {
    const result = evaluateValueExpression(
      statement.test,
      traversal,
      node,
      runtime,
    );
    if (result.status === "blocked") {
      if (isInstructionBatchActive(runtime, traversal)) {
        return { status: "yielded" };
      }
      runtime.active = traversalToNodeRef(traversal);
      runtime.blockedBy = {
        kind: "statement",
        arc: runtime.entry.arc,
        node: node.identifier,
        statementIndex: topLevelIndex,
        statementKind: "if",
      };
      return { status: "blocked" };
    }
    const branch = truthy(result.value)
      ? statement.consequent
      : (statement.alternate ?? []);
    return runStatementBlock(traversal, node, branch, runtime, topLevelIndex);
  }

  if (statement.kind === "label") {
    const status = runStatementBlock(
      traversal,
      node,
      statement.body,
      runtime,
      topLevelIndex,
    );
    if (status.status === "break" && status.label === statement.label) {
      return { status: "done" };
    }
    return status;
  }

  if (statement.kind === "break") {
    return { status: "break", label: statement.label };
  }

  return runAction(
    traversal,
    node,
    statement,
    runtime,
    topLevelIndex,
    statementIndex,
  );
}

function runAction(
  traversal: Traversal,
  node: Node,
  statement: ActionStatement,
  runtime: Accumulator,
  topLevelIndex: number,
  statementIndex: number,
): RunStatus {
  if (getActionState(traversal, statement)?.resolved) return { status: "done" };

  if (
    isInstructionBatchActive(runtime, traversal) &&
    statement.kind !== "instruction"
  ) {
    return { status: "yielded" };
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    const status = applyObserve(statement, traversal, node, runtime);
    if (status.status === "blocked") {
      runtime.active = traversalToNodeRef(traversal);
      runtime.blockedBy = {
        kind: "statement",
        arc: runtime.entry.arc,
        node: node.identifier,
        statementIndex: topLevelIndex,
        statementKind: statement.kind,
      };
      return status;
    }
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "set") {
    const apply = applySet(statement, traversal, node, runtime);
    if (apply.status === "blocked") {
      runtime.active = traversalToNodeRef(traversal);
      runtime.blockedBy = {
        kind: "statement",
        arc: runtime.entry.arc,
        node: node.identifier,
        statementIndex: topLevelIndex,
        statementKind: "set",
      };
      return apply;
    }
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "instruction") {
    emitInstruction(statement, traversal, node, runtime, statementIndex);
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  const target = resolveEnterTarget(runtime, traversal, node, statement);
  if (!target) {
    throw new Error(`Missing child node implementation: ${statement.node}`);
  }

  if (target.kind === "referenced") {
    if (!traversal.refChildren.some((item) => item === target.ref)) {
      traversal.refChildren.push(target.ref);
    }
    const referencedTraversal = ensureReferencedTraversal(
      runtime,
      target.ref,
      target.entry.root,
      rootRefOf(traversal.ref),
    );
    const status = runTraversal(
      referencedTraversal,
      target.entry.root,
      runtime,
      false,
    );
    if (status.status === "blocked") {
      runtime.blockedBy ??= {
        kind: "statement",
        arc: runtime.entry.arc,
        node: node.identifier,
        statementIndex: topLevelIndex,
        statementKind: "enter-node",
      };
      return status;
    }
    if (status.status === "yielded") return status;
    if (
      referencedTraversal.state === "covered" ||
      referencedTraversal.state === "skipped"
    ) {
      markActionResolved(traversal, statement);
    }
    return { status: "done" };
  }

  const childRef = target.ref;
  if (childResolved(runtime.traversals, childRef)) {
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  const childTraversal = ensureOwnedTraversal(runtime, childRef, target.node);
  prepareChildTraversalForEntry(childTraversal, target.node);

  const childStatus = runTraversal(childTraversal, target.node, runtime, false);
  if (childStatus.status === "blocked") {
    runtime.blockedBy ??= {
      kind: "statement",
      arc: runtime.entry.arc,
      node: node.identifier,
      statementIndex: topLevelIndex,
      statementKind: "enter-node",
    };
    return childStatus;
  }
  if (childStatus.status === "yielded") return childStatus;

  if (
    childTraversal.state === "covered" ||
    childTraversal.state === "skipped"
  ) {
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function prepareChildTraversalForEntry(traversal: Traversal, node: Node): void {
  if (traversal.enterCount === 0) {
    traversal.enterCount = 1;
    traversal.state = undefined;
    if (isArcTraversal(traversal)) {
      traversal.phase = "entered";
    }
    return;
  }

  if (
    (isArcTraversal(traversal) && isStopped(traversal)) ||
    traversal.state === "deflected"
  ) {
    traversal.enterCount += 1;
    traversal.state = undefined;
    if (isArcTraversal(traversal)) {
      traversal.phase = "entered";
    }
    if (!node.resumable) clearFrame(traversal);
  }
}

function resolveEnterTarget(
  runtime: Accumulator,
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" }>,
):
  | { kind: "owned"; ref: NodeRef; node: Node }
  | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
  | undefined {
  const ref = resolveReferenceRef(runtime, traversal, node, statement.node);
  if (!ref) return undefined;

  if (!isArcRef(ref)) {
    const ownedNode = resolveNodeForRef(runtime.entry, ref);
    if (ownedNode) return { kind: "owned", ref, node: ownedNode };
  }

  const importedRef = rootRefOf(ref);
  const importedEntry = runtime.entries.get(importedRef);
  if (!importedEntry) return undefined;
  return { kind: "referenced", ref: importedRef, entry: importedEntry };
}

function ensureReferencedTraversal(
  runtime: Accumulator,
  ref: ArcRef,
  root: Node,
  returnTo: ArcRef,
): ArcTraversal {
  let traversal = runtime.traversals.find((item) => item.ref === ref);
  if (!traversal) {
    traversal = createFreshArcTraversal(ref, root, 1, returnTo);
    runtime.traversals.push(traversal);
  }
  traversal.returnTo = returnTo;
  return traversal;
}

function runPendingEffects(
  runtime: Accumulator,
  pendingEffects: PendingEffects,
): RunStatus {
  for (const ref of deflectionEffectRefs(pendingEffects.active)) {
    const traversal = findTraversalInSet(runtime.traversals, ref);
    if (!traversal) {
      throw new Error(
        `Pending effects traversal not found: ${formatNodeRef(ref)}`,
      );
    }

    const entry = getEntryForRef(runtime.entries, ref);
    const node = entry ? resolveNodeForRef(entry, ref) : undefined;
    if (!node) {
      throw new Error(`Pending effects node not found: ${formatNodeRef(ref)}`);
    }

    runtime.active = ref;
    const status = runEffects(traversal, node, runtime);
    if (status.status === "blocked") return status;
  }
  return { status: "done" };
}

function completePendingEffects(
  runtime: Accumulator,
  pendingEffects: PendingEffects,
): void {
  const activeTraversal = findTraversalInSet(
    runtime.traversals,
    pendingEffects.active,
  );
  if (!activeTraversal) {
    throw new Error(
      `Pending effects active traversal not found: ${formatNodeRef(pendingEffects.active)}`,
    );
  }
  if (isArcTraversal(activeTraversal)) {
    activeTraversal.phase = "suspended";
  }
  if (!isArcTraversal(runtime.traversal)) {
    throw new Error("Pending effects can only finalize an arc traversal");
  }
  runtime.traversal.pendingEffects = undefined;
  runtime.traversal.phase = "suspended";
}

function deflectionEffectRefs(active: NodeRef): NodeRef[] {
  const { source, path } = toNodeRefParts(active);
  const refs: NodeRef[] = [];
  for (let length = path.length; length >= 1; length--) {
    refs.push(toNodeRef(source, path.slice(0, length)));
  }
  return refs;
}

function runEffects(
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): RunStatus {
  if (!node.effects) return { status: "done" };
  return runEffectStatements(traversal, node, node.effects, runtime);
}

function runEffectStatements(
  traversal: Traversal,
  node: Node,
  statements: EffectStatement[],
  runtime: Accumulator,
): RunStatus {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        runtime,
      );
      if (result.status === "blocked") return { status: "blocked" };
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const status = runEffectStatements(traversal, node, branch, runtime);
      if (status.status === "blocked") return status;
      continue;
    }

    if (getActionState(traversal, statement)?.resolved) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, runtime);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    if (statement.kind === "set") {
      const apply = applySet(statement, traversal, node, runtime);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    const effect = renderHostEffect(statement, traversal, node, runtime);
    const key = `${traversal.ref}:${statement.id}:${JSON.stringify(effect)}`;
    if (!traversal.appliedHostCallKeys.includes(key)) {
      traversal.appliedHostCallKeys.push(key);
      runtime.hostEffects.push(effect);
    }
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function applyObserve(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): RunStatus {
  const workId = makeObservationId(
    runtime.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    statement.id,
  );
  const resolution = runtime.observationResults.get(workId);

  if (resolution) {
    if (resolution.status === "resolved" && resolution.value !== undefined) {
      setVariableValue(
        statement.variable,
        resolution.value,
        traversal,
        node,
        runtime,
      );
      return { status: "done" };
    }
    if (statement.kind === "observe" && resolution.status !== "needs-user") {
      return { status: "done" };
    }
    return { status: "blocked" };
  }

  if (runtime.phase === "plan") {
    noteBriefYield(runtime, traversal);
    const variable = getVariableMeta(statement.variable, traversal, runtime);
    if (!variable) {
      throw new Error(`Unknown variable for observe(): ${statement.variable}`);
    }
    runtime.observations.push({
      id: workId,
      arc: runtime.entry.arc,
      node: node.identifier,
      variable: statement.variable,
      mode: statement.kind,
      question: renderObservationQuestion(statement, traversal, node, runtime),
      currentValue: getVariableValue(statement.variable, traversal, runtime),
      meta: {
        type: variable.type,
        values: variable.values,
        min: variable.min,
        max: variable.max,
      },
    });
  }
  return { status: "blocked" };
}

function applySet(
  statement: SetAction,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): RunStatus {
  const owner = findVariableOwner(statement.variable, traversal, runtime);
  if (!owner)
    throw new Error(`Unknown variable for set(): ${statement.variable}`);
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    runtime,
  );
  if (value.status === "blocked") return { status: "blocked" };
  if (
    value.value !== undefined &&
    value.value !== null &&
    typeof value.value !== "string" &&
    typeof value.value !== "number" &&
    typeof value.value !== "boolean"
  ) {
    throw new Error(
      `${statement.variable}.set() requires a primitive host call result`,
    );
  }
  assertAssignableValue(statement.variable, owner.variable, value.value);
  owner.traversal.variables[statement.variable] = value.value ?? undefined;
  return { status: "done" };
}

function emitInstruction(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
  statementIndex: number,
): void {
  noteBriefYield(runtime, traversal);
  runtime.instructionBatchNode ??= traversalToNodeRef(traversal);
  runtime.instructions.push({
    id: makeInstructionId(
      runtime.entry.arc,
      nodeIdentifier(traversalToNodeRef(traversal)),
      statement.id,
    ),
    arc: runtime.entry.arc,
    node: node.identifier,
    statementIndex,
    text: renderSemanticString(statement.template, traversal, node, runtime),
  });
}

function renderHostEffect(
  statement: HostEffectStatement,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): HostEffect {
  return {
    module: statement.module,
    target: [...statement.target],
    operation: statement.operation,
    arguments: statement.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, runtime),
    ),
  };
}

function renderHostCallArgument(
  arg: HostCallArgument,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): PayloadValue {
  if (arg.kind === "semantic") {
    return renderSemanticString(arg.value, traversal, node, runtime);
  }
  if (arg.kind === "value") {
    const value = evaluateValueExpression(arg.value, traversal, node, runtime);
    if (value.status === "blocked") {
      throw new Error("Host call value argument cannot block");
    }
    return value.value;
  }
  if (arg.kind === "array") {
    return arg.value.map((item) =>
      renderHostCallArgument(item, traversal, node, runtime),
    );
  }
  return Object.fromEntries(
    Object.entries(arg.value).map(([key, value]) => [
      key,
      renderHostCallArgument(value, traversal, node, runtime),
    ]),
  );
}

function evaluateHostCall(
  expression: HostCallExpression,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): EvalResult {
  const id = makeHostCallId(
    runtime.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    expression.id,
  );
  if (runtime.hostCallResults.has(id)) {
    return { status: "value", value: runtime.hostCallResults.get(id) };
  }
  const rendered = {
    id,
    arc: runtime.entry.arc,
    node: node.identifier,
    module: expression.module,
    target: [...expression.target],
    operation: expression.operation,
    arguments: expression.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, runtime),
    ),
  } satisfies HostCallBrief;
  if (runtime.phase === "plan") {
    noteBriefYield(runtime, traversal);
    runtime.hostCalls.push(cloneHostCallBrief(rendered));
  }
  return { status: "blocked" };
}

function evaluateJudge(
  expression: JudgeExpression,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): EvalResult {
  const rendered = renderSemanticString(
    expression.question,
    traversal,
    node,
    runtime,
  );
  const id = makeJudgeId(
    runtime.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    expression.id,
  );
  const result = runtime.judgmentResults.get(id);
  if (result !== undefined) return { status: "value", value: result };
  if (runtime.phase === "plan") {
    noteBriefYield(runtime, traversal);
    runtime.judgments.push({
      id,
      arc: runtime.entry.arc,
      node: node.identifier,
      question: rendered,
    });
  }
  return { status: "blocked" };
}

function evaluateValueExpression(
  expression: ValueExpression,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): EvalResult {
  if (expression.kind === "host-call")
    return evaluateHostCall(expression, traversal, node, runtime);
  if (expression.kind === "judge")
    return evaluateJudge(expression, traversal, node, runtime);
  if (expression.kind === "regexTest") {
    const target = evaluateSimpleExpression(
      expression.target,
      traversal,
      node,
      runtime,
    );
    if (target.status === "blocked") return target;
    const value = target.value;
    if (typeof value !== "string") return { status: "value", value: false };
    return {
      status: "value",
      value: new RegExp(expression.pattern, expression.flags).test(value),
    };
  }
  if (expression.kind === "binary") {
    const left = evaluateValueExpression(
      expression.left,
      traversal,
      node,
      runtime,
    );
    if (left.status === "blocked") return left;
    const right = evaluateValueExpression(
      expression.right,
      traversal,
      node,
      runtime,
    );
    if (right.status === "blocked") return right;
    const isOrdering =
      expression.op === ">" ||
      expression.op === ">=" ||
      expression.op === "<" ||
      expression.op === "<=";
    if (isOrdering) {
      const enumValues =
        findEnumValues(expression.left, traversal, runtime) ??
        findEnumValues(expression.right, traversal, runtime);
      if (enumValues) {
        const li =
          typeof left.value === "string" ? enumValues.indexOf(left.value) : -1;
        const ri =
          typeof right.value === "string"
            ? enumValues.indexOf(right.value)
            : -1;
        return {
          status: "value",
          value: evaluateBinary(expression.op, li, ri),
        };
      }
    }
    return {
      status: "value",
      value: evaluateBinary(expression.op, left.value, right.value),
    };
  }
  if (expression.kind === "logical") {
    const left = evaluateValueExpression(
      expression.left,
      traversal,
      node,
      runtime,
    );
    if (left.status === "blocked") return left;
    if (expression.op === "&&") {
      if (!truthy(left.value)) return { status: "value", value: left.value };
      return evaluateValueExpression(
        expression.right,
        traversal,
        node,
        runtime,
      );
    }
    if (truthy(left.value)) return { status: "value", value: left.value };
    return evaluateValueExpression(expression.right, traversal, node, runtime);
  }
  if (expression.kind === "unary") {
    const argument = evaluateValueExpression(
      expression.argument,
      traversal,
      node,
      runtime,
    );
    if (argument.status === "blocked") return argument;
    return { status: "value", value: !truthy(argument.value) };
  }
  return evaluateSimpleExpression(expression, traversal, node, runtime);
}

function evaluateSimpleExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): EvalResult {
  switch (expression.kind) {
    case "literal":
      return { status: "value", value: expression.value };
    case "ref":
      return {
        status: "value",
        value: runtime.dialog.names?.[expression.name] ?? expression.name,
      };
    case "variable":
      return {
        status: "value",
        value: getVariableValue(expression.name, traversal, runtime),
      };
    case "scope":
      if (expression.name === "lastUserMessage") {
        const lastUser = [...runtime.dialog.lastTurns]
          .reverse()
          .find((turn) => turn.role === "user");
        return { status: "value", value: lastUser?.message };
      }
      return {
        status: "value",
        value: runtime.dialog.lastTurns
          .slice(-(expression.count ?? runtime.dialog.lastTurns.length))
          .map((turn) => `${turn.role}: ${turn.message}`)
          .join("\n"),
      };
    case "enterCount":
      return { status: "value", value: traversal.enterCount };
    case "nodeState": {
      const ref = resolveReferenceRef(
        runtime,
        traversal,
        node,
        expression.node,
      );
      return {
        status: "value",
        value: ref ? childState(runtime.traversals, ref) : undefined,
      };
    }
  }
}

function resolveReferenceRef(
  runtime: Accumulator,
  traversal: Traversal,
  node: Node,
  name: string,
): ArcRef | NodeRef | undefined {
  const entry = getEntryForRef(runtime.entries, traversal.ref);
  if (!entry) return undefined;
  const traversalRef = traversalToNodeRef(traversal);
  const traversalParts = toNodeRefParts(traversalRef);
  const localChild = node.children.find((child) => child.identifier === name);
  if (localChild) {
    return toNodeRef(traversalParts.source, [
      ...traversalParts.path,
      localChild.identifier,
    ]);
  }
  if (node.imports.includes(name) && entry.importRefs[name]) {
    return entry.importRefs[name];
  }

  const ownerRef = lexicalParentRef(traversalRef);
  if (!ownerRef) return undefined;
  const resolvedOwnerEntry = getEntryForRef(runtime.entries, ownerRef) ?? entry;
  const ownerNode = resolveNodeForRef(resolvedOwnerEntry, ownerRef);
  if (!ownerNode) return undefined;
  const sibling = ownerNode.children.find((child) => child.identifier === name);
  if (sibling) {
    const ownerParts = toNodeRefParts(ownerRef);
    return toNodeRef(ownerParts.source, [
      ...ownerParts.path,
      sibling.identifier,
    ]);
  }
  if (ownerNode.imports.includes(name) && resolvedOwnerEntry.importRefs[name]) {
    return resolvedOwnerEntry.importRefs[name];
  }
  return undefined;
}

function findVariableOwner(
  variable: string,
  traversal: Traversal,
  runtime: Accumulator,
): { traversal: Traversal; variable: Variable } | undefined {
  let ref: NodeRef | undefined = traversalToNodeRef(traversal);
  while (ref) {
    const entry = getEntryForRef(runtime.entries, ref);
    if (!entry) return undefined;
    const node = resolveNodeForRef(entry, ref);
    const found = node?.variables.find((item) => item.name === variable);
    if (found) {
      const ownerTraversal = findTraversalInSet(runtime.traversals, ref);
      if (!ownerTraversal) break;
      return { traversal: ownerTraversal, variable: found };
    }
    ref = lexicalParentRef(ref);
  }
  return undefined;
}

function getVariableMeta(
  variable: string,
  traversal: Traversal,
  runtime: Accumulator,
): Variable | undefined {
  return findVariableOwner(variable, traversal, runtime)?.variable;
}

function getVariableValue(
  variable: string,
  traversal: Traversal,
  runtime: Accumulator,
): PrimitiveValue | undefined {
  return findVariableOwner(variable, traversal, runtime)?.traversal.variables[
    variable
  ];
}

function setVariableValue(
  variable: string,
  value: PrimitiveValue | undefined,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): void {
  const owner = findVariableOwner(variable, traversal, runtime);
  if (!owner)
    throw new Error(`Unknown variable: ${variable} in ${node.identifier}`);
  owner.traversal.variables[variable] = value;
}

function findEnumValues(
  expression: ValueExpression,
  traversal: Traversal,
  runtime: Accumulator,
): string[] | undefined {
  if (expression.kind === "variable") {
    const meta = getVariableMeta(expression.name, traversal, runtime);
    if (meta?.type === "enum" && meta.values) return meta.values;
  }
  return undefined;
}

function renderObservationQuestion(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): string {
  if (statement.question)
    return renderSemanticString(statement.question, traversal, node, runtime);
  const variable = getVariableMeta(statement.variable, traversal, runtime);
  if (!variable?.observing) return `observe ${statement.variable}`;
  return renderSemanticString(variable.observing, traversal, node, runtime);
}

function assertAssignableValue(
  variable: string,
  meta: Variable,
  value: PrimitiveValue | NodeState | undefined | null,
): void {
  if (value == null)
    throw new Error(`${variable}.set() cannot assign null or undefined`);
  if (meta.type === "boolean") {
    if (typeof value !== "boolean")
      throw new Error(`${variable}.set() requires a boolean value`);
    return;
  }
  if (meta.type === "rangedInt") {
    if (typeof value !== "number")
      throw new Error(`${variable}.set() requires a numeric value`);
    if (
      (meta.min !== undefined && value < meta.min) ||
      (meta.max !== undefined && value > meta.max)
    ) {
      throw new Error(
        `${variable}.set() value ${value} is outside ${meta.min}..${meta.max}`,
      );
    }
    return;
  }
  if (typeof value !== "string" || !meta.values?.includes(value)) {
    throw new Error(
      `${variable}.set() must use one of ${meta.values?.join(", ")}`,
    );
  }
}

function renderSemanticString(
  semantic: SemanticString,
  traversal: Traversal,
  node: Node,
  runtime: Accumulator,
): string {
  return semantic.parts
    .map((part) => {
      if (part.kind === "text") return part.value;
      const value = evaluateValueExpression(
        part.expression,
        traversal,
        node,
        runtime,
      );
      if (value.status === "blocked") return "";
      return value.value == null ? "" : String(value.value);
    })
    .join("");
}

function evaluateBinary(
  op: BinaryOperator,
  left: unknown,
  right: unknown,
): boolean {
  switch (op) {
    case "==":
    case "===":
      return left === right;
    case "!=":
    case "!==":
      return left !== right;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  const lhs = left == null ? "" : String(left);
  const rhs = right == null ? "" : String(right);
  if (lhs === rhs) return 0;
  return lhs > rhs ? 1 : -1;
}

function makeJudgeId(arc: ArcRef, node: string, actionId: number): string {
  return `judge:${arc}:${node}:${actionId}`;
}

function makeObservationId(
  arc: ArcRef,
  node: string,
  actionId: number,
): string {
  return `observe:${arc}:${node}:${actionId}`;
}

function makeHostCallId(arc: ArcRef, node: string, actionId: number): string {
  return `host-call:${arc}:${node}:${actionId}`;
}

function makeInstructionId(
  arc: ArcRef,
  node: string,
  actionId: number,
): string {
  return `instruction:${arc}:${node}:${actionId}`;
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function noteBriefYield(runtime: Accumulator, traversal: Traversal): void {
  runtime.briefActive ??= traversalToNodeRef(traversal);
}

function isInstructionBatchActive(
  runtime: Accumulator,
  traversal: Traversal,
): boolean {
  return runtime.instructionBatchNode === traversalToNodeRef(traversal);
}

function finalizeActionBrief(
  runtime: Accumulator,
  traversal: ArcTraversal,
): ActionBriefSnapshot {
  const allowedMoves = new Set<ActionMove>();
  if (
    runtime.instructions.length > 0 ||
    runtime.judgments.length > 0 ||
    runtime.observations.length > 0 ||
    runtime.hostCalls.length > 0
  ) {
    allowedMoves.add("proceed");
    allowedMoves.add("defer");
    allowedMoves.add("deflect");
  }
  if (allowedMoves.size === 0) allowedMoves.add("proceed");
  return {
    active:
      runtime.briefActive ?? runtime.active ?? arcToNodeRef(traversal.ref),
    canProgress: traversal.phase === "entered",
    blockedBy:
      runtime.blockedBy && runtime.blockedBy.kind !== "trigger"
        ? { ...runtime.blockedBy }
        : undefined,
    judgments: runtime.judgments.map((item) => ({ ...item })),
    observations: runtime.observations.map((item) => ({ ...item })),
    hostCalls: runtime.hostCalls.map(cloneHostCallBrief),
    instructions: runtime.instructions.map((item) => ({ ...item })),
    allowedMoves: [...allowedMoves],
  };
}

function cloneActionBriefSnapshot(
  plan: ActionBriefSnapshot,
): ActionBriefSnapshot {
  return {
    active: plan.active,
    canProgress: plan.canProgress,
    blockedBy: plan.blockedBy ? { ...plan.blockedBy } : undefined,
    judgments: plan.judgments.map((item) => ({ ...item })),
    observations: plan.observations.map((item) => ({ ...item })),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    instructions: plan.instructions.map((item) => ({ ...item })),
    allowedMoves: [...plan.allowedMoves],
  };
}

function validateActionReport(
  plan: ActionBriefSnapshot,
  report: ActionReport,
): void {
  if (!plan.allowedMoves.includes(report.move))
    throw new Error(`Illegal turn move: ${report.move}`);
  if (report.judgments) {
    const ids = new Set(plan.judgments.map((item) => item.id));
    for (const id of Object.keys(report.judgments))
      if (!ids.has(id))
        throw new Error(`Unknown judgment id in action report: ${id}`);
  }
  if (report.observations) {
    const ids = new Set(plan.observations.map((item) => item.id));
    for (const id of Object.keys(report.observations))
      if (!ids.has(id))
        throw new Error(`Unknown observation id in action report: ${id}`);
  }
  if (report.hostCalls) {
    const ids = new Set(plan.hostCalls.map((item) => item.id));
    for (const id of Object.keys(report.hostCalls))
      if (!ids.has(id))
        throw new Error(`Unknown host call id in action report: ${id}`);
  }
}

function acceptActionReport(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  plan: ActionBriefSnapshot,
  report: ActionReport,
): {
  traversals: ArcTraversalSet;
  hostEffects: HostEffect[];
  instructions: InstructionBrief[];
} {
  validateActionReport(plan, report);
  if (report.move === "defer") {
    return {
      traversals: cloneTraversalSet(traversals),
      hostEffects: [],
      instructions: [],
    };
  }

  const working = cloneTraversalSet(traversals);
  const rootTraversal = selectActionRootTraversal(working, entry.arc);

  if (report.move === "deflect") {
    const activeTraversal = resolveTraversalForBrief(working, plan.active);
    activeTraversal.state = "deflected";
    rootTraversal.pendingEffects = {
      reason: "deflected",
      active: plan.active,
    };

    const runtime = createAccumulator(
      entries,
      entry,
      rootTraversal,
      working,
      dialog,
      "apply",
    );
    runTurn(runtime);
    return {
      traversals: working,
      hostEffects: runtime.hostEffects.map(cloneHostEffect),
      instructions: runtime.instructions.map((item) => ({ ...item })),
    };
  }

  const runtime = createAccumulator(
    entries,
    entry,
    selectActionRootTraversal(working, entry.arc),
    working,
    dialog,
    "apply",
  );
  for (const [id, value] of Object.entries(report.judgments ?? {}))
    runtime.judgmentResults.set(id, value);
  for (const [id, value] of Object.entries(report.observations ?? {}))
    if (value) runtime.observationResults.set(id, value);
  for (const [id, value] of Object.entries(report.hostCalls ?? {}))
    runtime.hostCallResults.set(id, value);
  runTurn(runtime);
  return {
    traversals: working,
    hostEffects: runtime.hostEffects.map(cloneHostEffect),
    instructions: runtime.instructions.map((item) => ({ ...item })),
  };
}

export type {
  ActionBrief,
  ActionMove,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  Dialog,
  HostCallBrief,
  HostEffect,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  NodeState,
  ObservationBrief,
  ObservationReport,
  PayloadValue,
  TriggerBrief,
  TriggerOutcome,
  TriggerReport,
} from "../types.js";
