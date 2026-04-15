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
  CallerVarRef,
  Dialog,
  Document,
  EffectStatement,
  EnterChannelState,
  GuardStatement,
  HostCallArgument,
  HostCallBrief,
  HostCallExpression,
  HostEffect,
  HostEffectStatement,
  InstructionAction,
  InstructionBrief,
  InstructionPostcheck,
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
  blocked: boolean;
  active?: NodeRef;
  briefActive?: NodeRef;
  instructionBatchNode?: NodeRef;
  instructionBatchSignature?: string;
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
  | { status: "deflected"; active: NodeRef }
  | { status: "break"; label: string };

type ActionBriefSnapshot = Omit<ActionBrief, "traversals" | "hostEffects">;
type TriggerBriefSnapshot = TriggerBrief;

type ActionBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversals: ArcTraversalSet;
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
      const accum = createAccumulator(
        this.#entries,
        entry,
        base,
        [base],
        dialog,
        "plan",
      );
      const matched = runTrigger(entry.root, base, accum);
      judgments.push(...accum.judgments);
      observations.push(...accum.observations);
      hostCalls.push(...accum.hostCalls);
      if (matched && !accum.blocked) {
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

  progress(
    brief: ActionBrief,
    report: ActionReport,
    dialog: Dialog,
  ): ActionBrief {
    const state = this.#actionBriefState.get(brief);
    if (!state) throw new Error("Unknown action brief");

    const rootTraversal = selectActionRootTraversal(
      state.traversals,
      state.entry.arc,
    );
    if (rootTraversal.phase !== "entered") {
      validateActionReport(state.snapshot, report);
      return this.#createActionBrief(state.entry, state.traversals, dialog);
    }

    const applied = acceptActionReport(
      state.entries,
      state.entry,
      state.traversals,
      dialog,
      state.snapshot,
      report,
    );

    return this.#createActionBrief(
      state.entry,
      applied.traversals,
      dialog,
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
    const accum = createAccumulator(
      this.#entries,
      entry,
      workingRoot,
      workingTraversals,
      dialog,
      "plan",
    );
    if (workingRoot.phase === "entered") {
      runTurn(accum);
    } else if (activeHint) {
      accum.active = activeHint;
    }
    for (const traversal of workingTraversals) {
      const traversalEntry = this.#getEntry(rootRefOf(traversal.ref));
      pruneFrames(traversalEntry, traversal);
    }
    const yieldedTraversals = cloneTraversalSet(workingTraversals);
    const snapshot = cloneActionBriefSnapshot(
      finalizeActionBrief(
        accum,
        selectActionRootTraversal(yieldedTraversals, entry.arc),
      ),
    );
    const instructions = mergeInstructionBriefs(
      leadingInstructions,
      snapshot.instructions,
    );
    const brief: ActionBrief = {
      traversals: yieldedTraversals,
      hostEffects: [
        ...leadingHostEffects.map(cloneHostEffect),
        ...accum.hostEffects.map(cloneHostEffect),
      ],
      ...snapshot,
      instructions,
    };

    this.#actionBriefState.set(brief, {
      entries: this.#entries,
      entry,
      traversals: cloneTraversalSet(yieldedTraversals),
      snapshot: cloneActionBriefSnapshot({
        ...snapshot,
        instructions,
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
    blocked: false,
    active: undefined,
    briefActive: undefined,
    instructionBatchNode: undefined,
    instructionBatchSignature: undefined,
    judgmentResults: new Map(),
    observationResults: new Map(),
    hostCallResults: new Map(),
  };
}

function createEmptyEnterChannelState(): EnterChannelState {
  return { args: {}, returns: {}, stagedReturns: {} };
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
    frame: { actionStates: {}, evaluatorActionStates: {} },
    ownedChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
    enterChannels: createEmptyEnterChannelState(),
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
    frame: { actionStates: {}, evaluatorActionStates: {} },
    ownedChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
    enterChannels: createEmptyEnterChannelState(),
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
  next.enterChannels = createEmptyEnterChannelState();
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
    },
    ownedChildren: traversal.ownedChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    refChildren: [...traversal.refChildren],
    appliedHostCallKeys: [...traversal.appliedHostCallKeys],
    enterChannels: {
      args: Object.fromEntries(
        Object.entries(traversal.enterChannels.args).map(
          ([key, channelLink]) => [key, { ...channelLink }],
        ),
      ),
      returns: Object.fromEntries(
        Object.entries(traversal.enterChannels.returns).map(
          ([key, channelLink]) => [key, { ...channelLink }],
        ),
      ),
      stagedReturns: { ...traversal.enterChannels.stagedReturns },
    },
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
    sourceRef: brief.sourceRef,
    module: brief.module,
    target: [...brief.target],
    operation: brief.operation,
    arguments: [...brief.arguments],
  };
}

function cloneInstructionBrief(brief: InstructionBrief): InstructionBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    mode: brief.mode,
    phase: brief.phase,
    text: brief.text,
    postcheck: brief.postcheck
      ? {
          judgmentIds: [...brief.postcheck.judgmentIds],
          observationIds: [...brief.postcheck.observationIds],
          hostCallIds: [...brief.postcheck.hostCallIds],
        }
      : undefined,
  };
}

function mergeInstructionBriefs(
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
        postcheck: brief.postcheck
          ? {
              judgmentIds: [...brief.postcheck.judgmentIds],
              observationIds: [...brief.postcheck.observationIds],
              hostCallIds: [...brief.postcheck.hostCallIds],
            }
          : current.postcheck
            ? {
                judgmentIds: [...current.postcheck.judgmentIds],
                observationIds: [...current.postcheck.observationIds],
                hostCallIds: [...current.postcheck.hostCallIds],
              }
            : undefined,
      });
    }
  }
  return [...merged.values()];
}

function cloneValueExpression(expression: ValueExpression): ValueExpression {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "ref":
      return { kind: "ref", name: expression.name };
    case "variable":
      return { kind: "variable", name: expression.name };
    case "channel":
      return {
        kind: "channel",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "nodeState":
      return { kind: "nodeState", node: expression.node };
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
    case "binary":
      return {
        kind: "binary",
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
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: cloneValueExpression(expression.argument),
      };
  }
}

function cloneHostCallArgument(arg: HostCallArgument): HostCallArgument {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: cloneSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: cloneValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      value: arg.value.map((entry) => cloneHostCallArgument(entry)),
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

function cloneSemanticString(semantic: SemanticString): SemanticString {
  return {
    kind: "semantic-string",
    parts: semantic.parts.map((part) =>
      part.kind === "text"
        ? { kind: "text", value: part.value }
        : {
            kind: "expression",
            expression: cloneValueExpression(part.expression),
          },
    ),
    loc: semantic.loc,
  };
}

function pruneFrames(entry: RegistryEntry, traversal: Traversal): void {
  const node = resolveNodeForRef(entry, traversal.ref);
  if (!node) return;
  if (!node.resumable)
    traversal.frame = { actionStates: {}, evaluatorActionStates: {} };
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
  accum: Accumulator,
  childRef: NodeRef,
  childNode: Node,
): Traversal {
  const ownerRef = lexicalParentRef(childRef);
  if (!ownerRef) {
    throw new Error(
      `Owned child ${formatNodeRef(childRef)} has no lexical owner`,
    );
  }
  const ownerTraversal = findTraversalInSet(accum.traversals, ownerRef);
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

function getEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: string,
): Record<number, ActionState | undefined> {
  traversal.frame.evaluatorActionStates ??= {};
  traversal.frame.evaluatorActionStates[scopeKey] ??= {};
  return traversal.frame.evaluatorActionStates[scopeKey]!;
}

function getEvaluatorActionState(
  traversal: Traversal,
  scopeKey: string,
  action: ObserveAction,
): ActionState | undefined {
  return getEvaluatorActionStates(traversal, scopeKey)[action.id];
}

function markEvaluatorActionResolved(
  traversal: Traversal,
  scopeKey: string,
  action: ObserveAction,
): void {
  getEvaluatorActionStates(traversal, scopeKey)[action.id] = {
    kind: action.kind,
    status: "resolved",
  };
}

function clearEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: string,
): void {
  traversal.frame.evaluatorActionStates ??= {};
  delete traversal.frame.evaluatorActionStates[scopeKey];
}

function clearActionState(traversal: Traversal, actionId: number): void {
  delete traversal.frame.actionStates[actionId];
}

function isResolvedActionState(state: ActionState | undefined): boolean {
  return state?.status === "resolved";
}

function markResolvedActionState(
  traversal: Traversal,
  actionId: number,
  kind: ActionState["kind"],
): void {
  traversal.frame.actionStates[actionId] = { kind, status: "resolved" };
}

function markPendingActionState(
  traversal: Traversal,
  actionId: number,
  kind: ActionState["kind"],
): void {
  traversal.frame.actionStates[actionId] = { kind, status: "pending" };
}

function markActionResolved(
  traversal: Traversal,
  action: ActionStatement | HostEffectStatement,
): void {
  markResolvedActionState(traversal, action.id, action.kind);
}

function clearFrame(traversal: Traversal): void {
  traversal.frame = { actionStates: {}, evaluatorActionStates: {} };
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
  accum: Accumulator,
): boolean {
  if (!node.trigger) return true;
  const result = runTriggerStatements(
    node,
    traversal,
    node.trigger,
    accum,
    "trigger",
  );
  if (result.status === "blocked") return false;
  clearEvaluatorActionStates(traversal, "trigger");
  return truthy(result.value);
}

function runTriggerStatements(
  node: Node,
  traversal: Traversal,
  statements: TriggerStatement[],
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
        return { status: "blocked" };
      }
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const branchResult = runTriggerStatements(
        node,
        traversal,
        branch,
        accum,
        frameKey,
      );
      if (branchResult.status === "blocked") return branchResult;
      if (truthy(branchResult.value)) return branchResult;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return { status: "value", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
        return { status: "blocked" };
      }
      return { status: "value", value: truthy(result.value) };
    }

    if (
      isResolvedActionState(
        getEvaluatorActionState(traversal, frameKey, statement),
      )
    ) {
      continue;
    }

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
        return { status: "blocked" };
      }
      markEvaluatorActionResolved(traversal, frameKey, statement);
      continue;
    }
  }

  return { status: "value", value: false };
}

function runGuardStatements(
  node: Node,
  traversal: Traversal,
  statements: GuardStatement[],
  accum: Accumulator,
): NodeState | undefined {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
        return undefined;
      }
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const state = runGuardStatements(node, traversal, branch, accum);
      if (accum.blocked || state) return state;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return undefined;
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
        return undefined;
      }
      return isNodeState(result.value) ? result.value : undefined;
    }

    if (isResolvedActionState(getActionState(traversal, statement))) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") {
        accum.active = traversalToNodeRef(traversal);
        accum.blocked = true;
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
    const accum = createAccumulator(
      entries,
      entry,
      base,
      [base],
      dialog,
      "apply",
    );
    for (const [id, value] of Object.entries(report.judgments ?? {}))
      accum.judgmentResults.set(id, value);
    for (const [id, value] of Object.entries(report.observations ?? {}))
      if (value) accum.observationResults.set(id, value);
    for (const [id, value] of Object.entries(report.hostCalls ?? {}))
      accum.hostCallResults.set(id, value);
    const matched = runTrigger(entry.root, base, accum);
    if (matched && !accum.blocked) matchable.add(arcKey);
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
  const accum = createAccumulator(
    entries,
    entry,
    base,
    [base],
    dialog,
    "apply",
  );
  for (const [id, value] of Object.entries(report.judgments ?? {}))
    accum.judgmentResults.set(id, value);
  for (const [id, value] of Object.entries(report.observations ?? {}))
    if (value) accum.observationResults.set(id, value);
  for (const [id, value] of Object.entries(report.hostCalls ?? {}))
    accum.hostCallResults.set(id, value);
  const matched = runTrigger(entry.root, base, accum);
  if (!matched || accum.blocked) {
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
      ...plan.judgments.map((item) => rootRefOf(item.sourceRef)),
      ...plan.observations.map((item) => rootRefOf(item.sourceRef)),
      ...plan.hostCalls.map((item) => rootRefOf(item.sourceRef)),
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

function runTurn(accum: Accumulator): void {
  const rootNode = resolveNodeForRef(accum.entry, accum.traversal.ref);
  if (!rootNode)
    throw new Error(
      `Unknown root traversal node: ${formatNodeRef(accum.traversal.ref)}`,
    );
  if (isArcTraversal(accum.traversal) && accum.traversal.pendingEffects) {
    const pendingEffects = accum.traversal.pendingEffects;
    const status = runPendingEffects(accum, pendingEffects);
    if (status.status !== "done") return;
    completePendingEffects(accum, pendingEffects);
    return;
  }
  const status = runTraversal(accum.traversal, rootNode, accum, true);
  if (status.status === "break") {
    throw new Error(`Unhandled break label: ${status.label}`);
  }
  if (status.status === "deflected") {
    const rootTraversal = accum.traversal;
    if (!isArcTraversal(rootTraversal) || !rootTraversal.pendingEffects) {
      throw new Error("Deflected root traversal is missing pending effects");
    }
    const pendingEffects = rootTraversal.pendingEffects;
    const pendingStatus = runPendingEffects(accum, pendingEffects);
    if (pendingStatus.status !== "done") return;
    completePendingEffects(accum, pendingEffects);
    return;
  }
  if (status.status !== "done") return;
  accum.traversal.state = "covered";
  if (isArcTraversal(accum.traversal)) {
    accum.traversal.phase = "completed";
  }
}

function runTraversal(
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  isRoot = false,
): RunStatus {
  accum.active = traversalToNodeRef(traversal);

  if (!isRoot) {
    if (traversal.state === "covered" || traversal.state === "skipped") {
      return { status: "done" };
    }
    if (node.guard) {
      const guardState = runGuardStatements(node, traversal, node.guard, accum);
      if (accum.blocked) return { status: "blocked" };
      if (guardState) {
        traversal.state = guardState;
        return { status: "done" };
      }
    }
  }

  for (let index = 0; index < node.statements.length; index++) {
    const statement = node.statements[index];
    if (!statement) continue;
    const status = runStatement(traversal, node, statement, accum);
    if (status.status !== "done") return status;
  }

  if (isInstructionBatchActive(accum, traversal)) {
    return { status: "yielded" };
  }

  const effects = runEffects(traversal, node, accum);
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
  accum: Accumulator,
): RunStatus {
  for (const statement of statements) {
    const status = runStatement(traversal, node, statement, accum);
    if (status.status !== "done") return status;
  }
  return { status: "done" };
}

function runStatement(
  traversal: Traversal,
  node: Node,
  statement: Statement,
  accum: Accumulator,
): RunStatus {
  if (statement.kind === "if") {
    const result = evaluateValueExpression(
      statement.test,
      traversal,
      node,
      accum,
    );
    if (result.status === "blocked") {
      if (isInstructionBatchActive(accum, traversal)) {
        return { status: "yielded" };
      }
      accum.active = traversalToNodeRef(traversal);
      accum.blocked = true;
      return { status: "blocked" };
    }
    const branch = truthy(result.value)
      ? statement.consequent
      : (statement.alternate ?? []);
    return runStatementBlock(traversal, node, branch, accum);
  }

  if (statement.kind === "label") {
    const status = runStatementBlock(traversal, node, statement.body, accum);
    if (status.status === "break" && status.label === statement.label) {
      return { status: "done" };
    }
    return status;
  }

  if (statement.kind === "break") {
    return { status: "break", label: statement.label };
  }

  return runAction(traversal, node, statement, accum);
}

function runAction(
  traversal: Traversal,
  node: Node,
  statement: ActionStatement,
  accum: Accumulator,
): RunStatus {
  if (isResolvedActionState(getActionState(traversal, statement))) {
    return { status: "done" };
  }

  if (
    statement.kind === "instruction" &&
    isInstructionBatchActive(accum, traversal) &&
    !canBatchInstruction(accum, statement)
  ) {
    return { status: "yielded" };
  }

  if (
    isInstructionBatchActive(accum, traversal) &&
    statement.kind !== "instruction"
  ) {
    return { status: "yielded" };
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    const status = applyObserve(statement, traversal, node, accum);
    if (status.status === "blocked") {
      accum.active = traversalToNodeRef(traversal);
      accum.blocked = true;
      return status;
    }
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "set") {
    const apply = applySet(statement, traversal, node, accum);
    if (apply.status === "blocked") {
      accum.active = traversalToNodeRef(traversal);
      accum.blocked = true;
      return apply;
    }
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "set-return") {
    const apply = applySetReturn(statement, traversal, node, accum);
    if (apply.status === "blocked") {
      accum.active = traversalToNodeRef(traversal);
      accum.blocked = true;
      return apply;
    }
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  if (statement.kind === "instruction") {
    return runInstructionAction(traversal, node, statement, accum);
  }

  const target = resolveEnterTarget(accum, traversal, node, statement);
  if (!target) {
    throw new Error(`Missing child node implementation: ${statement.node}`);
  }

  if (target.kind === "referenced") {
    if (!traversal.refChildren.some((item) => item === target.ref)) {
      traversal.refChildren.push(target.ref);
    }
    const referencedTraversal = ensureReferencedTraversal(
      accum,
      target.ref,
      target.entry.root,
      rootRefOf(traversal.ref),
    );
    applyEnterChannels(traversal, node, statement, referencedTraversal, accum);
    const status = runTraversal(
      referencedTraversal,
      target.entry.root,
      accum,
      false,
    );
    if (status.status === "blocked") {
      accum.blocked = true;
      return status;
    }
    if (status.status === "deflected") return status;
    if (status.status === "yielded") return status;
    if (
      referencedTraversal.state === "covered" ||
      referencedTraversal.state === "skipped"
    ) {
      if (referencedTraversal.state === "covered") {
        commitEnterReturnChannels(referencedTraversal, accum);
      }
      markActionResolved(traversal, statement);
    }
    return { status: "done" };
  }

  const childRef = target.ref;
  if (childResolved(accum.traversals, childRef)) {
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  const childTraversal = ensureOwnedTraversal(accum, childRef, target.node);
  prepareChildTraversalForEntry(childTraversal, target.node);
  applyEnterChannels(traversal, node, statement, childTraversal, accum);

  const childStatus = runTraversal(childTraversal, target.node, accum, false);
  if (childStatus.status === "blocked") {
    accum.blocked = true;
    return childStatus;
  }
  if (childStatus.status === "deflected") return childStatus;
  if (childStatus.status === "yielded") return childStatus;

  if (
    childTraversal.state === "covered" ||
    childTraversal.state === "skipped"
  ) {
    if (childTraversal.state === "covered") {
      commitEnterReturnChannels(childTraversal, accum);
    }
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function runInstructionAction(
  traversal: Traversal,
  node: Node,
  statement: InstructionAction,
  accum: Accumulator,
): RunStatus {
  const actionState = getActionState(traversal, statement);
  if (actionState?.status !== "pending") {
    const postcheck =
      accum.phase === "plan"
        ? collectInstructionPostcheck(statement, traversal, node, accum)
        : undefined;
    emitInstruction(statement, traversal, node, accum, "apply", postcheck);
    markPendingActionState(traversal, statement.id, statement.kind);
    return { status: "done" };
  }

  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;
  const deflectResult = statement.deflectWhen
    ? evaluateResolutionFunction(
        statement.deflectWhen,
        traversal,
        node,
        accum,
        instructionResolutionFrameKey(statement, "deflectWhen"),
      )
    : ({ status: "value", value: false } satisfies EvalResult);
  const resolveResult = evaluateInstructionResolution(
    statement,
    traversal,
    node,
    accum,
  );
  if (deflectResult.status !== "blocked" && truthy(deflectResult.value)) {
    clearActionState(traversal, statement.id);
    return deflectTraversal(accum, traversal);
  }
  if (
    deflectResult.status === "blocked" ||
    resolveResult.status === "blocked"
  ) {
    const postcheck =
      accum.phase === "plan"
        ? instructionPostcheckFromAccum(
            accum,
            judgmentStart,
            observationStart,
            hostCallStart,
          )
        : undefined;
    emitInstruction(statement, traversal, node, accum, "postcheck", postcheck);
    accum.active = traversalToNodeRef(traversal);
    accum.blocked = true;
    return { status: "blocked" };
  }
  if (truthy(resolveResult.value)) {
    markActionResolved(traversal, statement);
    return { status: "done" };
  }

  emitInstruction(statement, traversal, node, accum, "apply");
  return { status: "done" };
}

function evaluateInstructionResolution(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  if (!statement.resolveWhen) {
    return { status: "value", value: statement.mode === "once" };
  }
  return evaluateResolutionFunction(
    statement.resolveWhen,
    traversal,
    node,
    accum,
    instructionResolutionFrameKey(statement, "resolveWhen"),
  );
}

function collectInstructionPostcheck(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): InstructionPostcheck | undefined {
  const judgmentStart = accum.judgments.length;
  const observationStart = accum.observations.length;
  const hostCallStart = accum.hostCalls.length;

  if (statement.deflectWhen) {
    evaluateResolutionFunction(
      statement.deflectWhen,
      traversal,
      node,
      accum,
      instructionResolutionFrameKey(statement, "deflectWhen"),
    );
  }
  if (statement.resolveWhen) {
    evaluateResolutionFunction(
      statement.resolveWhen,
      traversal,
      node,
      accum,
      instructionResolutionFrameKey(statement, "resolveWhen"),
    );
  }

  return instructionPostcheckFromAccum(
    accum,
    judgmentStart,
    observationStart,
    hostCallStart,
  );
}

function instructionPostcheckFromAccum(
  accum: Accumulator,
  judgmentStart: number,
  observationStart: number,
  hostCallStart: number,
): InstructionPostcheck | undefined {
  const judgmentIds = dedupeBriefIds(
    accum.judgments.slice(judgmentStart).map((item) => item.id),
  );
  const observationIds = dedupeBriefIds(
    accum.observations.slice(observationStart).map((item) => item.id),
  );
  const hostCallIds = dedupeBriefIds(
    accum.hostCalls.slice(hostCallStart).map((item) => item.id),
  );

  if (
    judgmentIds.length === 0 &&
    observationIds.length === 0 &&
    hostCallIds.length === 0
  ) {
    return undefined;
  }

  return {
    judgmentIds,
    observationIds,
    hostCallIds,
  };
}

function dedupeBriefIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function instructionResolutionFrameKey(
  statement: InstructionAction,
  kind: "resolveWhen" | "deflectWhen",
): string {
  return `instruction:${String(statement.id)}:${kind}`;
}

function evaluateResolutionFunction(
  statements: TriggerStatement[],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  const result = evaluateResolutionStatements(
    statements,
    traversal,
    node,
    accum,
    frameKey,
  );
  if (result.status !== "blocked") {
    clearEvaluatorActionStates(traversal, frameKey);
  }
  return result;
}

function evaluateResolutionStatements(
  statements: TriggerStatement[],
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  frameKey: string,
): EvalResult {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const test = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (test.status === "blocked") return test;
      const branch = truthy(test.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const branchResult = evaluateResolutionStatements(
        branch,
        traversal,
        node,
        accum,
        frameKey,
      );
      if (branchResult.status === "blocked") return branchResult;
      if (truthy(branchResult.value)) return branchResult;
      continue;
    }

    if (statement.kind === "return") {
      if (!statement.value) return { status: "value", value: false };
      const result = evaluateValueExpression(
        statement.value,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return result;
      return { status: "value", value: truthy(result.value) };
    }

    if (
      isResolvedActionState(
        getEvaluatorActionState(traversal, frameKey, statement),
      )
    ) {
      continue;
    }
    const observeStatus = applyObserve(statement, traversal, node, accum);
    if (observeStatus.status === "blocked") return observeStatus;
    markEvaluatorActionResolved(traversal, frameKey, statement);
  }

  return { status: "value", value: false };
}

function deflectTraversal(accum: Accumulator, traversal: Traversal): RunStatus {
  const activeRef = traversalToNodeRef(traversal);
  traversal.state = "deflected";

  const rootTraversal = selectActionRootTraversal(
    accum.traversals,
    accum.entry.arc,
  );
  rootTraversal.pendingEffects = {
    reason: "deflected",
    active: activeRef,
  };

  return { status: "deflected", active: activeRef };
}

function prepareChildTraversalForEntry(traversal: Traversal, node: Node): void {
  if (traversal.enterCount === 0) {
    traversal.enterCount = 1;
    traversal.state = undefined;
    traversal.enterChannels = createEmptyEnterChannelState();
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
    traversal.enterChannels = createEmptyEnterChannelState();
    if (isArcTraversal(traversal)) {
      traversal.phase = "entered";
    }
    if (!node.resumable) clearFrame(traversal);
  }
}

function resolveEnterTarget(
  accum: Accumulator,
  traversal: Traversal,
  node: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" }>,
):
  | { kind: "owned"; ref: NodeRef; node: Node }
  | { kind: "referenced"; ref: ArcRef; entry: RegistryEntry }
  | undefined {
  const ref = resolveReferenceRef(accum, traversal, node, statement.node);
  if (!ref) return undefined;

  if (!isArcRef(ref)) {
    const ownedNode = resolveNodeForRef(accum.entry, ref);
    if (ownedNode) return { kind: "owned", ref, node: ownedNode };
  }

  const importedRef = rootRefOf(ref);
  const importedEntry = accum.entries.get(importedRef);
  if (!importedEntry) return undefined;
  return { kind: "referenced", ref: importedRef, entry: importedEntry };
}

function applyEnterChannels(
  callerTraversal: Traversal,
  callerNode: Node,
  statement: Extract<ActionStatement, { kind: "enter-node" }>,
  calleeTraversal: Traversal,
  accum: Accumulator,
): void {
  const hasArgs = !!statement.args && Object.keys(statement.args).length > 0;
  const hasReturns =
    !!statement.returns && Object.keys(statement.returns).length > 0;
  if (!hasArgs && !hasReturns) {
    calleeTraversal.enterChannels = createEmptyEnterChannelState();
    return;
  }

  const nextArgs = resolveEnterChannelLinks(
    statement.args ?? {},
    callerTraversal,
    callerNode,
    accum,
    "args",
  );
  const nextReturns = resolveEnterChannelLinks(
    statement.returns ?? {},
    callerTraversal,
    callerNode,
    accum,
    "returns",
  );

  if (
    sameEnterChannelLinks(calleeTraversal.enterChannels.args, nextArgs) &&
    sameEnterChannelLinks(calleeTraversal.enterChannels.returns, nextReturns)
  ) {
    return;
  }

  calleeTraversal.enterChannels = {
    args: nextArgs,
    returns: nextReturns,
    stagedReturns: {},
  };
}

function resolveEnterChannelLinks(
  mapping: Record<string, string>,
  callerTraversal: Traversal,
  callerNode: Node,
  accum: Accumulator,
  label: "args" | "returns",
): Record<string, CallerVarRef> {
  const resolved: Record<string, CallerVarRef> = {};
  for (const [key, variable] of Object.entries(mapping)) {
    const owner = findVariableOwner(variable, callerTraversal, accum);
    if (!owner) {
      throw new Error(
        `Unknown ${label} variable mapping "${variable}" in ${callerNode.identifier}`,
      );
    }
    resolved[key] = {
      ownerRef: traversalToNodeRef(owner.traversal),
      variable,
    };
  }
  return resolved;
}

function sameEnterChannelLinks(
  left: Record<string, CallerVarRef>,
  right: Record<string, CallerVarRef>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const l = left[key];
    const r = right[key];
    if (!l || !r) return false;
    if (l.ownerRef !== r.ownerRef || l.variable !== r.variable) return false;
  }
  return true;
}

function commitEnterReturnChannels(
  traversal: Traversal,
  accum: Accumulator,
): void {
  const channelState = traversal.enterChannels;
  for (const [key, value] of Object.entries(channelState.stagedReturns)) {
    const callerVarRef = channelState.returns[key];
    if (!callerVarRef) {
      throw new Error(
        `Unknown staged return channel key "${key}" for ${formatNodeRef(traversalToNodeRef(traversal))}`,
      );
    }
    const callerTraversal = findTraversalInSet(
      accum.traversals,
      callerVarRef.ownerRef,
    );
    if (!callerTraversal) {
      throw new Error(
        `Return channel caller not found for binding: ${formatNodeRef(callerVarRef.ownerRef)}`,
      );
    }
    callerTraversal.variables[callerVarRef.variable] = value;
  }
  channelState.stagedReturns = {};
}

function ensureReferencedTraversal(
  accum: Accumulator,
  ref: ArcRef,
  root: Node,
  returnTo: ArcRef,
): ArcTraversal {
  let traversal = accum.traversals.find((item) => item.ref === ref);
  if (!traversal) {
    traversal = createFreshArcTraversal(ref, root, 1, returnTo);
    accum.traversals.push(traversal);
  }
  traversal.returnTo = returnTo;
  return traversal;
}

function runPendingEffects(
  accum: Accumulator,
  pendingEffects: PendingEffects,
): RunStatus {
  for (const ref of deflectionEffectRefs(pendingEffects.active)) {
    const traversal = findTraversalInSet(accum.traversals, ref);
    if (!traversal) {
      throw new Error(
        `Pending effects traversal not found: ${formatNodeRef(ref)}`,
      );
    }

    const entry = getEntryForRef(accum.entries, ref);
    const node = entry ? resolveNodeForRef(entry, ref) : undefined;
    if (!node) {
      throw new Error(`Pending effects node not found: ${formatNodeRef(ref)}`);
    }

    accum.active = ref;
    const status = runEffects(traversal, node, accum);
    if (status.status === "blocked") return status;
  }
  return { status: "done" };
}

function completePendingEffects(
  accum: Accumulator,
  pendingEffects: PendingEffects,
): void {
  const activeTraversal = findTraversalInSet(
    accum.traversals,
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
  if (!isArcTraversal(accum.traversal)) {
    throw new Error("Pending effects can only finalize an arc traversal");
  }
  accum.traversal.pendingEffects = undefined;
  accum.traversal.phase = "suspended";
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
  accum: Accumulator,
): RunStatus {
  if (!node.effects) return { status: "done" };
  return runEffectStatements(traversal, node, node.effects, accum);
}

function runEffectStatements(
  traversal: Traversal,
  node: Node,
  statements: EffectStatement[],
  accum: Accumulator,
): RunStatus {
  for (const statement of statements) {
    if (statement.kind === "if") {
      const result = evaluateValueExpression(
        statement.test,
        traversal,
        node,
        accum,
      );
      if (result.status === "blocked") return { status: "blocked" };
      const branch = truthy(result.value)
        ? statement.consequent
        : (statement.alternate ?? []);
      const status = runEffectStatements(traversal, node, branch, accum);
      if (status.status === "blocked") return status;
      continue;
    }

    if (isResolvedActionState(getActionState(traversal, statement))) continue;

    if (statement.kind === "observe") {
      const apply = applyObserve(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    if (statement.kind === "set") {
      const apply = applySet(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    if (statement.kind === "set-return") {
      const apply = applySetReturn(statement, traversal, node, accum);
      if (apply.status === "blocked") return apply;
      markActionResolved(traversal, statement);
      continue;
    }

    const effect = renderHostEffect(statement, traversal, node, accum);
    const key = `${traversal.ref}:${statement.id}:${JSON.stringify(effect)}`;
    if (!traversal.appliedHostCallKeys.includes(key)) {
      traversal.appliedHostCallKeys.push(key);
      accum.hostEffects.push(effect);
    }
    markActionResolved(traversal, statement);
  }
  return { status: "done" };
}

function applyObserve(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): RunStatus {
  const workId = makeObservationId(
    accum.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    statement.id,
  );
  const resolution = accum.observationResults.get(workId);

  if (resolution) {
    if (resolution.status === "resolved" && resolution.value !== undefined) {
      setVariableValue(
        statement.variable,
        resolution.value,
        traversal,
        node,
        accum,
      );
      return { status: "done" };
    }
    if (statement.kind === "observe" && resolution.status !== "needs-user") {
      return { status: "done" };
    }
    return { status: "blocked" };
  }

  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    const variable = getVariableMeta(statement.variable, traversal, accum);
    if (!variable) {
      throw new Error(`Unknown variable for observe(): ${statement.variable}`);
    }
    accum.observations.push({
      id: workId,
      sourceRef: traversalToNodeRef(traversal),
      variable: statement.variable,
      mode: statement.kind,
      question: renderObservationQuestion(statement, traversal, node, accum),
      currentValue: getVariableValue(statement.variable, traversal, accum),
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
  accum: Accumulator,
): RunStatus {
  const owner = findVariableOwner(statement.variable, traversal, accum);
  if (!owner)
    throw new Error(`Unknown variable for set(): ${statement.variable}`);
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
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

function applySetReturn(
  statement: Extract<ActionStatement, { kind: "set-return" }>,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): RunStatus {
  const value = evaluateValueExpression(
    statement.value,
    traversal,
    node,
    accum,
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
      `returns.${statement.key}.set() requires a primitive host call result`,
    );
  }
  const callerVarRef = traversal.enterChannels.returns[statement.key];
  if (!callerVarRef) {
    throw new Error(
      `Unknown return channel key "${statement.key}" for ${formatNodeRef(traversalToNodeRef(traversal))}`,
    );
  }
  const callerTraversal = findTraversalInSet(
    accum.traversals,
    callerVarRef.ownerRef,
  );
  if (!callerTraversal) {
    throw new Error(
      `Return channel caller-owner traversal not found for binding: ${formatNodeRef(callerVarRef.ownerRef)}`,
    );
  }
  const ownerEntry = getEntryForRef(accum.entries, callerVarRef.ownerRef);
  const ownerNode = ownerEntry
    ? resolveNodeForRef(ownerEntry, callerVarRef.ownerRef)
    : undefined;
  const ownerVariable = ownerNode?.variables.find(
    (item) => item.name === callerVarRef.variable,
  );
  if (!ownerVariable) {
    throw new Error(
      `Return channel binding references unknown caller variable "${callerVarRef.variable}" on ${formatNodeRef(callerVarRef.ownerRef)}`,
    );
  }
  assertAssignableValue(
    callerVarRef.variable,
    ownerVariable,
    value.value as PrimitiveValue | undefined,
  );
  traversal.enterChannels.stagedReturns[statement.key] =
    value.value as PrimitiveValue;
  return { status: "done" };
}

function emitInstruction(
  statement: InstructionAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
  phase: InstructionBrief["phase"],
  postcheck?: InstructionPostcheck,
): void {
  noteBriefYield(accum, traversal);
  accum.instructionBatchNode ??= traversalToNodeRef(traversal);
  accum.instructionBatchSignature ??= instructionBatchSignature(statement);
  accum.instructions.push({
    id: makeInstructionId(
      accum.entry.arc,
      nodeIdentifier(traversalToNodeRef(traversal)),
      statement.id,
    ),
    sourceRef: traversalToNodeRef(traversal),
    mode: statement.mode,
    phase,
    text: renderSemanticString(statement.template, traversal, node, accum),
    postcheck: postcheck
      ? {
          judgmentIds: [...postcheck.judgmentIds],
          observationIds: [...postcheck.observationIds],
          hostCallIds: [...postcheck.hostCallIds],
        }
      : undefined,
  });
}

function renderHostEffect(
  statement: HostEffectStatement,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): HostEffect {
  return {
    module: statement.module,
    target: [...statement.target],
    operation: statement.operation,
    arguments: statement.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, accum),
    ),
  };
}

function renderHostCallArgument(
  arg: HostCallArgument,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): PayloadValue {
  if (arg.kind === "semantic") {
    return renderSemanticString(arg.value, traversal, node, accum);
  }
  if (arg.kind === "value") {
    const value = evaluateValueExpression(arg.value, traversal, node, accum);
    if (value.status === "blocked") {
      throw new Error("Host call value argument cannot block");
    }
    return value.value;
  }
  if (arg.kind === "array") {
    return arg.value.map((item) =>
      renderHostCallArgument(item, traversal, node, accum),
    );
  }
  return Object.fromEntries(
    Object.entries(arg.value).map(([key, value]) => [
      key,
      renderHostCallArgument(value, traversal, node, accum),
    ]),
  );
}

function evaluateHostCall(
  expression: HostCallExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  const id = makeHostCallId(
    accum.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    expression.id,
  );
  if (accum.hostCallResults.has(id)) {
    return { status: "value", value: accum.hostCallResults.get(id) };
  }
  const rendered = {
    id,
    sourceRef: traversalToNodeRef(traversal),
    module: expression.module,
    target: [...expression.target],
    operation: expression.operation,
    arguments: expression.arguments.map((arg) =>
      renderHostCallArgument(arg, traversal, node, accum),
    ),
  } satisfies HostCallBrief;
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.hostCalls.push(cloneHostCallBrief(rendered));
  }
  return { status: "blocked" };
}

function evaluateJudge(
  expression: JudgeExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  const rendered = renderSemanticString(
    expression.question,
    traversal,
    node,
    accum,
  );
  const id = makeJudgeId(
    accum.entry.arc,
    nodeIdentifier(traversalToNodeRef(traversal)),
    expression.id,
  );
  const result = accum.judgmentResults.get(id);
  if (result !== undefined) return { status: "value", value: result };
  if (accum.phase === "plan") {
    noteBriefYield(accum, traversal);
    accum.judgments.push({
      id,
      sourceRef: traversalToNodeRef(traversal),
      question: rendered,
    });
  }
  return { status: "blocked" };
}

function evaluateValueExpression(
  expression: ValueExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  if (expression.kind === "host-call")
    return evaluateHostCall(expression, traversal, node, accum);
  if (expression.kind === "judge")
    return evaluateJudge(expression, traversal, node, accum);
  if (expression.kind === "regexTest") {
    const target = evaluateLocalExpression(
      expression.target,
      traversal,
      node,
      accum,
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
      accum,
    );
    if (left.status === "blocked") return left;
    const right = evaluateValueExpression(
      expression.right,
      traversal,
      node,
      accum,
    );
    if (right.status === "blocked") return right;
    const isOrdering =
      expression.op === ">" ||
      expression.op === ">=" ||
      expression.op === "<" ||
      expression.op === "<=";
    if (isOrdering) {
      const enumValues =
        findEnumValues(expression.left, traversal, accum) ??
        findEnumValues(expression.right, traversal, accum);
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
      accum,
    );
    if (left.status === "blocked") return left;
    if (expression.op === "&&") {
      if (!truthy(left.value)) return { status: "value", value: left.value };
      return evaluateValueExpression(expression.right, traversal, node, accum);
    }
    if (truthy(left.value)) return { status: "value", value: left.value };
    return evaluateValueExpression(expression.right, traversal, node, accum);
  }
  if (expression.kind === "unary") {
    const argument = evaluateValueExpression(
      expression.argument,
      traversal,
      node,
      accum,
    );
    if (argument.status === "blocked") return argument;
    return { status: "value", value: !truthy(argument.value) };
  }
  return evaluateLocalExpression(expression, traversal, node, accum);
}

function evaluateLocalExpression(
  expression: LocalExpression,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): EvalResult {
  switch (expression.kind) {
    case "literal":
      return { status: "value", value: expression.value };
    case "ref":
      return {
        status: "value",
        value: accum.dialog.names?.[expression.name] ?? expression.name,
      };
    case "variable":
      return {
        status: "value",
        value: getVariableValue(expression.name, traversal, accum),
      };
    case "channel":
      return {
        status: "value",
        value: readChannelValue(
          traversal,
          expression.namespace,
          expression.key,
          accum,
        ),
      };
    case "scope":
      if (expression.name === "lastUserMessage") {
        const lastUser = [...accum.dialog.lastTurns]
          .reverse()
          .find((turn) => turn.role === "user");
        return { status: "value", value: lastUser?.message };
      }
      return {
        status: "value",
        value: accum.dialog.lastTurns
          .slice(-(expression.count ?? accum.dialog.lastTurns.length))
          .map((turn) => `${turn.role}: ${turn.message}`)
          .join("\n"),
      };
    case "enterCount":
      return { status: "value", value: traversal.enterCount };
    case "nodeState": {
      const ref = resolveReferenceRef(accum, traversal, node, expression.node);
      return {
        status: "value",
        value: ref ? childState(accum.traversals, ref) : undefined,
      };
    }
  }
}

function resolveReferenceRef(
  accum: Accumulator,
  traversal: Traversal,
  node: Node,
  name: string,
): ArcRef | NodeRef | undefined {
  const entry = getEntryForRef(accum.entries, traversal.ref);
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
  const resolvedOwnerEntry = getEntryForRef(accum.entries, ownerRef) ?? entry;
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
  accum: Accumulator,
): { traversal: Traversal; variable: Variable } | undefined {
  let ref: NodeRef | undefined = traversalToNodeRef(traversal);
  while (ref) {
    const entry = getEntryForRef(accum.entries, ref);
    if (!entry) return undefined;
    const node = resolveNodeForRef(entry, ref);
    const found = node?.variables.find((item) => item.name === variable);
    if (found) {
      const ownerTraversal = findTraversalInSet(accum.traversals, ref);
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
  accum: Accumulator,
): Variable | undefined {
  return findVariableOwner(variable, traversal, accum)?.variable;
}

function getVariableValue(
  variable: string,
  traversal: Traversal,
  accum: Accumulator,
): PrimitiveValue | undefined {
  return findVariableOwner(variable, traversal, accum)?.traversal.variables[
    variable
  ];
}

function readChannelValue(
  traversal: Traversal,
  namespace: "args" | "returns",
  key: string,
  accum: Accumulator,
): PrimitiveValue | undefined {
  const channelState = traversal.enterChannels;
  if (namespace === "returns" && key in channelState.stagedReturns) {
    return channelState.stagedReturns[key];
  }
  const callerVarRef = channelState[namespace][key];
  if (!callerVarRef) {
    throw new Error(
      `Unknown ${namespace} channel key "${key}" for ${formatNodeRef(traversalToNodeRef(traversal))}`,
    );
  }
  const callerTraversal = findTraversalInSet(
    accum.traversals,
    callerVarRef.ownerRef,
  );
  if (!callerTraversal) {
    throw new Error(
      `${namespace}.${key} caller-owner traversal not found for binding: ${formatNodeRef(callerVarRef.ownerRef)}`,
    );
  }
  return callerTraversal.variables[callerVarRef.variable];
}

function setVariableValue(
  variable: string,
  value: PrimitiveValue | undefined,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): void {
  const owner = findVariableOwner(variable, traversal, accum);
  if (!owner)
    throw new Error(`Unknown variable: ${variable} in ${node.identifier}`);
  owner.traversal.variables[variable] = value;
}

function findEnumValues(
  expression: ValueExpression,
  traversal: Traversal,
  accum: Accumulator,
): string[] | undefined {
  if (expression.kind === "variable") {
    const meta = getVariableMeta(expression.name, traversal, accum);
    if (meta?.type === "enum" && meta.values) return meta.values;
  }
  return undefined;
}

function renderObservationQuestion(
  statement: ObserveAction | ObserveOrAskAction,
  traversal: Traversal,
  node: Node,
  accum: Accumulator,
): string {
  if (statement.question)
    return renderSemanticString(statement.question, traversal, node, accum);
  const variable = getVariableMeta(statement.variable, traversal, accum);
  if (!variable?.observing) return `observe ${statement.variable}`;
  return renderSemanticString(variable.observing, traversal, node, accum);
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
  accum: Accumulator,
): string {
  return semantic.parts
    .map((part) => {
      if (part.kind === "text") return part.value;
      const value = evaluateValueExpression(
        part.expression,
        traversal,
        node,
        accum,
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

function noteBriefYield(accum: Accumulator, traversal: Traversal): void {
  accum.briefActive ??= traversalToNodeRef(traversal);
}

function isInstructionBatchActive(
  accum: Accumulator,
  traversal: Traversal,
): boolean {
  return accum.instructionBatchNode === traversalToNodeRef(traversal);
}

function canBatchInstruction(
  accum: Accumulator,
  statement: InstructionAction,
): boolean {
  // TODO: Loosen this beyond strict signature equality so non-conflicting
  // instruction briefs can batch together without forcing identical policy.
  const signature = accum.instructionBatchSignature;
  return (
    signature === undefined ||
    signature === instructionBatchSignature(statement)
  );
}

function instructionBatchSignature(statement: InstructionAction): string {
  return JSON.stringify({
    mode: statement.mode,
    resolveWhen: normalizeResolutionStatements(statement.resolveWhen),
    deflectWhen: normalizeResolutionStatements(statement.deflectWhen),
  });
}

function normalizeResolutionStatements(
  statements: TriggerStatement[] | undefined,
): unknown {
  return (
    statements?.map((statement) => normalizeResolutionStatement(statement)) ??
    null
  );
}

function normalizeResolutionStatement(statement: TriggerStatement): unknown {
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
  return {
    kind: "observe",
    variable: statement.variable,
    question: statement.question
      ? normalizeSemanticString(statement.question)
      : null,
  };
}

function normalizeValueExpression(expression: ValueExpression): unknown {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "ref":
      return { kind: "ref", name: expression.name };
    case "variable":
      return { kind: "variable", name: expression.name };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count ?? null,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "nodeState":
      return { kind: "nodeState", node: expression.node };
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
    case "binary":
      return {
        kind: "binary",
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
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: normalizeValueExpression(expression.argument),
      };
  }
}

function normalizeHostCallArgument(arg: HostCallArgument): unknown {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: normalizeSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: normalizeValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      value: arg.value.map((entry) => normalizeHostCallArgument(entry)),
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

function normalizeSemanticString(semantic: SemanticString): unknown {
  return semantic.parts.map((part) =>
    part.kind === "text"
      ? { kind: "text", value: part.value }
      : {
          kind: "expression",
          expression: normalizeValueExpression(part.expression),
        },
  );
}

function finalizeActionBrief(
  accum: Accumulator,
  traversal: ArcTraversal,
): ActionBriefSnapshot {
  const allowedMoves = new Set<ActionMove>();
  if (
    accum.instructions.length > 0 ||
    accum.judgments.length > 0 ||
    accum.observations.length > 0 ||
    accum.hostCalls.length > 0
  ) {
    allowedMoves.add("proceed");
    allowedMoves.add("defer");
    if (accum.instructions.length === 0) {
      allowedMoves.add("deflect");
    }
  }
  if (allowedMoves.size === 0) allowedMoves.add("proceed");
  return {
    active: accum.briefActive ?? accum.active ?? arcToNodeRef(traversal.ref),
    canProgress: traversal.phase === "entered",
    judgments: accum.judgments.map((item) => ({ ...item })),
    observations: accum.observations.map((item) => ({ ...item })),
    hostCalls: accum.hostCalls.map(cloneHostCallBrief),
    instructions: accum.instructions.map(cloneInstructionBrief),
    allowedMoves: [...allowedMoves],
  };
}

function cloneActionBriefSnapshot(
  plan: ActionBriefSnapshot,
): ActionBriefSnapshot {
  return {
    active: plan.active,
    canProgress: plan.canProgress,
    judgments: plan.judgments.map((item) => ({ ...item })),
    observations: plan.observations.map((item) => ({ ...item })),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    instructions: plan.instructions.map(cloneInstructionBrief),
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

    const accum = createAccumulator(
      entries,
      entry,
      rootTraversal,
      working,
      dialog,
      "apply",
    );
    runTurn(accum);
    return {
      traversals: working,
      hostEffects: accum.hostEffects.map(cloneHostEffect),
      instructions: accum.instructions.map(cloneInstructionBrief),
    };
  }

  const accum = createAccumulator(
    entries,
    entry,
    selectActionRootTraversal(working, entry.arc),
    working,
    dialog,
    "apply",
  );
  for (const [id, value] of Object.entries(report.judgments ?? {}))
    accum.judgmentResults.set(id, value);
  for (const [id, value] of Object.entries(report.observations ?? {}))
    if (value) accum.observationResults.set(id, value);
  for (const [id, value] of Object.entries(report.hostCalls ?? {}))
    accum.hostCallResults.set(id, value);
  runTurn(accum);
  return {
    traversals: working,
    hostEffects: accum.hostEffects.map(cloneHostEffect),
    instructions: accum.instructions.map(cloneInstructionBrief),
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
