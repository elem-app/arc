import { analyzeDocument, stampElementIds } from "../parser/index.js";
import { admitValue } from "../spec/resolution.js";
import type {
  ActionBrief,
  ActionReport,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "../types/host-interaction.js";
import type {
  ActionStatement,
  Document,
  ElementId,
  MapAction,
  Node,
  NodeReadSet,
  Statement,
  ValidationIssue,
} from "../types/parser.js";
import type {
  ActionState,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  NodeRef,
  PinEntry,
  RuntimeDocumentIssue,
  RuntimeRegistrationIssue,
  RuntimeRegistryIssue,
  StateSnapshot,
  Traversal,
} from "../types/runtime.js";
import type { CellSpec, ChannelSpec, HostModuleSpec } from "../types/spec.js";
import {
  isArtifactValue,
  type CellValue,
  type Dialog,
} from "../types/value.js";
import {
  cloneWithCanonicalNumbers,
  createArtifactValue,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
} from "../value-utils.js";
import {
  acceptActionReport,
  buildActionBrief,
  buildPoisonedActionBrief,
  buildRetryTriggerBrief,
  buildTriggerBrief,
  validateActionReport,
  validateTriggerReport,
  type BuiltActionOutput,
} from "./briefs.js";
import {
  resolveImportRefs,
  validateImportedChannelBindings,
} from "./channel-registration.js";
import { assertAssignableChannelValue } from "./channel-values.js";
import { cloneHostModuleRegistry } from "./host-modules.js";
import {
  canonicalizeNegativeZeroInPlace,
  clonePreservingNumbers,
} from "./payload.js";
import {
  arcToNodeRef,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  isArcRef,
  lexicalParentRef,
  resolveLexicalRef,
  toAnonymousCopyRef,
  toArcRef,
  traversalToNodeRef,
} from "./refs.js";
import { admitHostCallResults } from "./report-validation.js";
import {
  cloneCellValue,
  cloneTraversalSet,
  createEmptyArcTraversal,
  restartTraversal,
  selectActionRootTraversal,
  type ActionBriefState,
  type RegistryEntry,
  type TriggerBriefState,
} from "./state.js";

export { validateActionReport, validateTriggerReport } from "./briefs.js";
export {
  isArcRef,
  toArcRef,
  toArcRefParts,
  toNodeRef,
  toNodeRefParts,
} from "./refs.js";
export { findActiveRoot } from "./state.js";

export type RuntimeOptions = {
  hostModules?: ReadonlyMap<string, HostModuleSpec>;
};

/** Comprehensive expected validation failure from `Runtime.add()` or `init()`. */
export class RuntimeRegistrationError extends Error {
  readonly operation: "add" | "init";
  readonly issues: readonly RuntimeRegistrationIssue[];

  constructor(
    operation: "add" | "init",
    issues: readonly RuntimeRegistrationIssue[],
  ) {
    super(
      `Runtime.${operation}() failed with ${issues.length} registration issue${issues.length === 1 ? "" : "s"}:\n${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "RuntimeRegistrationError";
    this.operation = operation;
    this.issues = issues;
  }
}

function documentRegistrationIssues(
  source: string,
  issues: readonly ValidationIssue[],
): RuntimeDocumentIssue[] {
  return issues.map((issue) => ({
    phase: "document",
    source,
    code: issue.code,
    message: issue.message,
    loc: issue.loc,
  }));
}

function compareRegistryIssues(
  left: RuntimeRegistryIssue,
  right: RuntimeRegistryIssue,
): number {
  const leftKey = registryIssueSortKey(left);
  const rightKey = registryIssueSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function registryIssueSortKey(issue: RuntimeRegistryIssue): string {
  const location = issue.loc
    ? `${String(issue.loc.start.line).padStart(10, "0")}:${String(issue.loc.start.column).padStart(10, "0")}`
    : "";
  if (issue.code === "UNRESOLVED_IMPORT") {
    return [
      issue.source,
      location,
      issue.code,
      issue.localName,
      issue.importedSource,
      issue.importedName,
    ].join("\0");
  }
  return [
    issue.arc,
    issue.node,
    location,
    issue.actionId,
    issue.namespace,
    issue.key,
    issue.code,
  ].join("\0");
}

export class Runtime {
  readonly #hostModules: ReadonlyMap<string, HostModuleSpec>;
  readonly #documents = new Map<string, Document>();
  readonly #entries = new Map<ArcRef, RegistryEntry>();
  readonly #actionBriefState = new WeakMap<ActionBrief, ActionBriefState>();
  readonly #triggerBriefState = new WeakMap<TriggerBrief, TriggerBriefState>();
  #initialized = false;

  constructor(options: RuntimeOptions = {}) {
    this.#hostModules = cloneHostModuleRegistry(options.hostModules);
  }

  add(source: string, document: Document): this {
    if (this.#initialized) {
      throw new Error(
        "Runtime is initialized and cannot collect more documents",
      );
    }
    if (this.#documents.has(source)) {
      throw new Error(`Document already registered for source ${source}`);
    }

    // Validate the caller's raw graph before cloning can erase malformed
    // payload descriptors, symbols, array holes, or other non-data shapes. A
    // caller may omit canonical element ids, which stamping below repairs.
    const rawAnalysis = analyzeDocument(document);
    const rawIssues = rawAnalysis.issues.filter(
      (issue) => issue.code !== "ELEMENT_ID",
    );
    if (rawIssues.length > 0) {
      throw new RuntimeRegistrationError(
        "add",
        documentRegistrationIssues(source, rawIssues),
      );
    }
    // Preserve JavaScript numeric values in the private runtime snapshot.
    const registeredDocument = clonePreservingNumbers(document);
    // Stamps the private clone (never the caller's document), so hand-built
    // IR registers without a manual normalization step. The analysis below
    // then verifies canonical ids as a no-op.
    for (const root of registeredDocument.roots) stampElementIds(root);
    const analysis = analyzeDocument(registeredDocument, {
      hostModules: this.#hostModules,
    });
    if (analysis.issues.length > 0) {
      throw new RuntimeRegistrationError(
        "add",
        documentRegistrationIssues(source, analysis.issues),
      );
    }
    canonicalizeNegativeZeroInPlace(registeredDocument);
    const rewalkPlan = analysis.rewalkPlan;

    const registrations: RegistryEntry[] = [];
    const pendingArcs = new Set<ArcRef>();
    for (const root of registeredDocument.roots) {
      const arc = toArcRef(source, root.identifier);
      if (this.#entries.has(arc) || pendingArcs.has(arc)) {
        throw new Error(`Duplicate arc registration: ${formatRef(arc)}`);
      }
      pendingArcs.add(arc);
      registrations.push({
        arc,
        document: registeredDocument,
        root,
        importRefs: {},
        hostModules: this.#hostModules,
        rewalkPlan,
      });
    }

    this.#documents.set(source, registeredDocument);
    for (const entry of registrations) {
      this.#entries.set(entry.arc, entry);
    }
    return this;
  }

  /** Resolves and validates the complete collected registry atomically. */
  init(): this {
    if (this.#initialized) return this;
    const resolution = resolveImportRefs(this.#entries);
    const issues = [
      ...resolution.issues,
      ...validateImportedChannelBindings(resolution.entries),
    ].sort(compareRegistryIssues);
    if (issues.length > 0) {
      throw new RuntimeRegistrationError("init", issues);
    }

    this.#entries.clear();
    for (const [arc, entry] of resolution.entries) {
      this.#entries.set(arc, entry);
    }
    this.#initialized = true;
    return this;
  }

  has(arc: ArcRef): boolean {
    return this.#entries.has(arc);
  }

  nodeForRef(ref: ArcRef | NodeRef): Node | undefined {
    const entry = getEntryForRef(this.#entries, ref);
    return entry && getNodeForRef(this.#entries, entry, ref);
  }

  newTraversalSet(): ArcTraversalSet {
    return [];
  }

  newTraversal(arc: ArcRef): ArcTraversal {
    this.#assertInitialized();
    const entry = this.#getEntry(arc);
    return createEmptyArcTraversal(arc, entry.root);
  }

  startTrigger(
    traversals: ArcTraversalSet,
    dialog: Dialog,
    opts: { arcRefs?: readonly ArcRef[] } = {},
  ): TriggerBrief {
    this.#assertInitialized();
    assertPersistedTraversalValues(this.#entries, traversals);
    const entryByArc = this.#triggerEntries(opts.arcRefs);
    // No prior candidate state: every arc starts a fresh trigger consultation.
    return this.#storeTriggerBrief(
      buildTriggerBrief(this.#entries, entryByArc, traversals, dialog),
      dialog,
      entryByArc,
    );
  }

  progressTrigger(
    brief: TriggerBrief,
    report: TriggerReport,
    dialog: Dialog,
  ): TriggerBrief {
    this.#assertInitialized();
    const state = this.#triggerBriefState.get(brief);
    if (!state) throw new Error("Unknown trigger brief");
    const validation = validateTriggerReport(state.snapshot, report);
    if (validation.rejected) {
      return this.#storeTriggerBrief(
        buildRetryTriggerBrief(
          state.entries,
          state.traversals,
          state.snapshot,
          validation.issues,
          state.priorReport,
          state.candidates,
        ),
        dialog,
        state.entryByArc,
      );
    }
    const typed = admitHostCallResults(
      state.snapshot.hostCalls,
      validation.accepted.hostCalls ?? {},
      this.#hostModules,
    );
    if (typed.accepted) validation.accepted.hostCalls = typed.accepted;
    else delete validation.accepted.hostCalls;
    validation.issues.push(...typed.issues);
    return this.#storeTriggerBrief(
      buildTriggerBrief(
        state.entries,
        state.entryByArc,
        state.traversals,
        dialog,
        validation.accepted,
        state.priorReport,
        state.candidates,
        validation.issues,
      ),
      dialog,
      state.entryByArc,
    );
  }

  start(
    traversals: ArcTraversalSet,
    dialog: Dialog,
  ): ActionBrief | TerminalBrief {
    this.#assertInitialized();
    assertPersistedTraversalValues(this.#entries, traversals);
    const rootTraversal = selectActionRootTraversal(traversals);
    if (rootTraversal.phase !== "entered") {
      throw new Error(
        `Root traversal phase must be "entered", got "${rootTraversal.phase}"`,
      );
    }
    const entry = this.#getEntry(rootTraversal.ref);
    try {
      return this.#storeActionBrief(
        entry,
        buildActionBrief(this.#entries, entry, traversals, dialog),
      );
    } catch (error) {
      return this.#storeActionBrief(
        entry,
        buildPoisonedActionBrief(
          this.#entries,
          entry,
          traversals,
          dialog,
          arcToNodeRef(entry.arc),
          error,
        ),
      );
    }
  }

  enterArc(
    arc: ArcRef,
    dialog: Dialog,
    options: { args?: Readonly<Record<string, CellValue>> } = {},
  ): ActionBrief | TerminalBrief {
    this.#assertInitialized();
    const entry = this.#getEntry(arc);
    const traversal = restartTraversal(entry);
    const declaredArgs = entry.root.signature?.args ?? {};
    for (const [key, value] of Object.entries(options.args ?? {})) {
      const spec = declaredArgs[key];
      if (!spec) {
        throw new Error(
          `Unknown args channel key "${key}" for direct Arc entry: ${formatRef(arc)}`,
        );
      }
      assertAssignableChannelValue("args", key, spec, value, "arc-entry");
      traversal.enterChannels.args[key] = {
        kind: "value",
        value: cloneCellValue(cloneWithCanonicalNumbers(value)) ?? value,
      };
    }
    return this.start([traversal], dialog);
  }

  progress(
    brief: ActionBrief,
    report: ActionReport,
    dialog: Dialog,
  ): ActionBrief | TerminalBrief {
    this.#assertInitialized();
    const state = this.#actionBriefState.get(brief);
    if (!state) throw new Error("Unknown action brief");

    const rootTraversal = selectActionRootTraversal(
      state.traversals,
      state.entry.arc,
    );
    const validation = validateActionReport(state.snapshot, report);
    if (validation.rejected) {
      return this.#storeActionBrief(
        state.entry,
        buildActionBrief(
          state.entries,
          state.entry,
          state.traversals,
          dialog,
          [],
          validation.issues,
        ),
      );
    }
    const typed = admitHostCallResults(
      state.snapshot.hostCalls,
      validation.accepted.hostCalls ?? {},
      this.#hostModules,
    );
    if (typed.accepted) validation.accepted.hostCalls = typed.accepted;
    else delete validation.accepted.hostCalls;
    validation.issues.push(...typed.issues);
    if (rootTraversal.phase !== "entered") {
      return this.#storeActionBrief(
        state.entry,
        buildActionBrief(
          state.entries,
          state.entry,
          state.traversals,
          dialog,
          [],
          validation.issues,
        ),
      );
    }

    if (validation.accepted.move === "poison") {
      const poisonReason = validation.accepted.poisonReason;
      return this.#storeActionBrief(
        state.entry,
        buildPoisonedActionBrief(
          state.entries,
          state.entry,
          state.traversals,
          dialog,
          state.snapshot.active,
          poisonReason?.reason ?? "Host poisoned the active Arc frontier.",
          poisonReason?.reasonCode ?? "host-poisoned",
        ),
      );
    }

    if (state.snapshot.transition) {
      // A transition proceed carries no results, so there is nothing to apply:
      // acknowledging it is re-planning under the freshly projected dialog.
      // Clearing the pending transition empties the plan walk's latch, the gate
      // passes, and the walk continues to the next frontier — where new work is
      // emitted in plan phase, with its resolution hooks posed.
      const working = cloneTraversalSet(state.traversals);
      const workingRoot = selectActionRootTraversal(working, state.entry.arc);
      workingRoot.pendingTransition = undefined;
      try {
        return this.#storeActionBrief(
          state.entry,
          buildActionBrief(
            state.entries,
            state.entry,
            working,
            dialog,
            [],
            validation.issues,
          ),
        );
      } catch (error) {
        return this.#storeActionBrief(
          state.entry,
          buildPoisonedActionBrief(
            state.entries,
            state.entry,
            state.traversals,
            dialog,
            state.snapshot.active,
            error,
          ),
        );
      }
    }

    try {
      const applied = acceptActionReport(state, dialog, validation.accepted);

      return this.#storeActionBrief(
        state.entry,
        buildActionBrief(
          state.entries,
          state.entry,
          applied.traversals,
          dialog,
          applied.hostEffects,
          validation.issues,
        ),
      );
    } catch (error) {
      return this.#storeActionBrief(
        state.entry,
        buildPoisonedActionBrief(
          state.entries,
          state.entry,
          state.traversals,
          dialog,
          state.snapshot.active,
          error,
        ),
      );
    }
  }

  #getEntry(ref: ArcRef): RegistryEntry {
    const entry = this.#entries.get(ref);
    if (!entry) throw new Error(`Unknown arc: ${formatRef(ref)}`);
    return entry;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("Runtime.init() must succeed before execution");
    }
  }

  #storeTriggerBrief(
    built: {
      brief: TriggerBrief;
      traversals: ArcTraversalSet;
      priorReport: TriggerReport;
      candidates: TriggerBriefState["candidates"];
      snapshot: TriggerBriefState["snapshot"];
    },
    dialog: Dialog,
    entryByArc: ReadonlyMap<ArcRef, RegistryEntry>,
  ): TriggerBrief {
    this.#triggerBriefState.set(built.brief, {
      entries: new Map(this.#entries),
      entryByArc: new Map(entryByArc),
      traversals: built.traversals,
      dialog,
      priorReport: built.priorReport,
      candidates: built.candidates,
      snapshot: built.snapshot,
    });
    return built.brief;
  }

  #triggerEntries(arcRefs: readonly ArcRef[] | undefined) {
    if (arcRefs === undefined) {
      return new Map(
        [...this.#entries.values()].map((entry) => [entry.arc, entry]),
      );
    }
    const entries = new Map<ArcRef, RegistryEntry>();
    for (const arcRef of arcRefs) entries.set(arcRef, this.#getEntry(arcRef));
    return entries;
  }

  #storeActionBrief(
    entry: RegistryEntry,
    built: BuiltActionOutput,
  ): ActionBrief | TerminalBrief {
    if ("snapshot" in built) {
      this.#actionBriefState.set(built.brief, {
        entries: new Map(this.#entries),
        entry,
        traversals: built.traversals,
        snapshot: built.snapshot,
      });
    }

    return built.brief;
  }
}

/**
 * Re-admits every externally restored cell/channel value through the schema in
 * the registered document. `CellValue` describes only the persistence carrier;
 * the declaring spec remains the authority for a concrete slot.
 */
function assertPersistedTraversalValues(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
): void {
  const visit = (traversal: Traversal): void => {
    const entry = getEntryForRef(entries, traversal.ref);
    const node = entry && getNodeForRef(entries, entry, traversal.ref);
    if (!entry || !node) {
      throw new Error(
        `Persisted traversal has no registered node: ${formatRef(traversal.ref)}`,
      );
    }

    const cells = new Map(node.cells.map((cell) => [cell.name, cell]));
    for (const [name, value] of Object.entries(traversal.cells)) {
      const spec = cells.get(name);
      if (!spec) {
        throw new Error(
          `Persisted traversal contains undeclared cell ${formatRef(traversal.ref)}.${name}`,
        );
      }
      if (value !== undefined) {
        assertPersistedAdmitted(
          `cell ${formatRef(traversal.ref)}.${name}`,
          spec,
          value,
        );
      }
    }

    const signature = node.signature;
    for (const namespace of ["args", "returns"] as const) {
      for (const [key, link] of Object.entries(
        traversal.enterChannels[namespace],
      )) {
        const spec = signature?.[namespace][key];
        if (!spec) {
          throw new Error(
            `Persisted traversal contains undeclared ${namespace}.${key} binding for ${formatRef(traversal.ref)}`,
          );
        }
        if (link.kind === "value") {
          assertPersistedAdmitted(
            `${namespace}.${key} binding for ${formatRef(traversal.ref)}`,
            spec,
            link.value,
          );
        }
      }
    }
    for (const [key, value] of Object.entries(
      traversal.enterChannels.stagedReturns,
    )) {
      const spec = signature?.returns[key];
      if (!spec) {
        throw new Error(
          `Persisted traversal contains undeclared staged returns.${key} for ${formatRef(traversal.ref)}`,
        );
      }
      assertPersistedAdmitted(
        `staged returns.${key} for ${formatRef(traversal.ref)}`,
        spec,
        value,
      );
    }

    assertPersistedFrameValues(entries, traversal, node, entry);

    traversal.ownedChildren.forEach(visit);
    traversal.ephemeralChildren.forEach(visit);
  };

  traversals.forEach(visit);
}

/** Re-admits value-bearing continuation state before a restored frame runs. */
function assertPersistedFrameValues(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  entry: RegistryEntry,
): void {
  for (const [id, state] of Object.entries(traversal.frame.actionStates)) {
    if (!state) continue;
    assertPersistedActionState(entries, traversal, node, id, state);
    if ("preSnapshot" in state && state.preSnapshot) {
      assertPersistedSnapshot(
        entries,
        traversal,
        node,
        entry,
        state.preSnapshot,
      );
    }
  }

  for (const scoped of Object.values(
    traversal.frame.evaluatorActionStates ?? {},
  )) {
    for (const state of Object.values(scoped ?? {})) {
      if (state && "preSnapshot" in state && state.preSnapshot) {
        assertPersistedSnapshot(
          entries,
          traversal,
          node,
          entry,
          state.preSnapshot,
        );
      }
    }
  }

  for (const tape of Object.values(traversal.frame.pinTapes ?? {})) {
    for (const pinEntries of Object.values(tape ?? {})) {
      if (!Array.isArray(pinEntries)) {
        throw invalidPersistedState("pin tape entry list is not an array");
      }
      pinEntries.forEach(assertPersistedPinEntry);
    }
  }
}

function assertPersistedActionState(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  id: string,
  state: ActionState,
): void {
  const action = findStatefulAction(node.statements, id as ElementId);

  if (state.kind === "map" && state.map) {
    if (action?.kind !== "map") {
      throw invalidPersistedState(
        `$map state ${JSON.stringify(id)} has no action`,
      );
    }
    assertPersistedMapState(entries, traversal, node, action, state.map);
  }

  if (
    (state.kind === "enter-node" || state.kind === "enter-loop") &&
    state.stagedReturns
  ) {
    if (action?.kind !== state.kind) {
      throw invalidPersistedState(
        `${state.kind} state ${JSON.stringify(id)} has no matching action`,
      );
    }
    const target = resolvePersistedEnterTargetNode(
      entries,
      traversal,
      node,
      action,
    );
    if (!target) {
      throw invalidPersistedState(
        `${state.kind} state ${JSON.stringify(id)} has no registered target`,
      );
    }
    for (const [key, value] of Object.entries(state.stagedReturns)) {
      const spec = target.signature?.returns[key];
      if (!spec) {
        throw invalidPersistedState(
          `${state.kind} state contains undeclared staged returns.${key}`,
        );
      }
      assertPersistedAdmitted(`staged returns.${key}`, spec, value);
    }
  }
}

function assertPersistedMapState(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  action: MapAction,
  map: NonNullable<Extract<ActionState, { kind: "map" }>["map"]>,
): void {
  if (map.results !== action.results) {
    throw invalidPersistedState(
      "$map arena result target does not match its action",
    );
  }

  const receiver =
    action.receiver.kind === "channel"
      ? node.signature?.[action.receiver.namespace][action.receiver.key]
      : findLexicalCellSpec(entries, traversal, action.receiver.name);
  if (!receiver || receiver.type !== "array") {
    throw invalidPersistedState(
      "$map receiver has no registered array authority",
    );
  }
  assertPersistedAdmitted("$map pinned input", receiver, map.pinnedInput);

  if (action.results === undefined) {
    if (
      map.terminals.some((value) => value !== undefined) ||
      map.staged?.set === true ||
      map.staged?.value !== undefined
    ) {
      throw invalidPersistedState(
        "$map forEach arena contains a value without a span.result landing",
      );
    }
    return;
  }

  const result = findLexicalCellSpec(entries, traversal, action.results);
  if (!result || result.type !== "array") {
    throw invalidPersistedState(
      "$map result has no registered array authority",
    );
  }
  for (const [index, value] of map.terminals.entries()) {
    if (value !== undefined) {
      assertPersistedAdmitted(`$map terminal[${index}]`, result.element, value);
    }
  }
  if (map.staged?.set) {
    if (map.staged.value === undefined) {
      throw invalidPersistedState("$map staged span.result has no value");
    }
    assertPersistedAdmitted(
      "$map staged span.result",
      result.element,
      map.staged.value,
    );
  } else if (map.staged?.value !== undefined) {
    throw invalidPersistedState("$map unset staged result carries a value");
  }
}

function assertPersistedSnapshot(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  entry: RegistryEntry,
  snapshot: StateSnapshot,
): void {
  const plan = entry.rewalkPlan?.bySeg.get(node)?.get(snapshot.capturingSeg);
  if (!plan) {
    throw invalidPersistedState("pre-snapshot has no registered rewalk plan");
  }

  const expectedCells = new Set(plan.cells);
  for (const [name, value] of Object.entries(snapshot.cells)) {
    if (!expectedCells.has(name)) {
      throw invalidPersistedState(
        `pre-snapshot contains an unplanned cell ${JSON.stringify(name)}`,
      );
    }
    if (value === undefined) continue;
    const spec = findLexicalCellSpec(entries, traversal, name);
    if (!spec) {
      throw invalidPersistedState(
        `pre-snapshot cell ${JSON.stringify(name)} has no registered authority`,
      );
    }
    assertPersistedAdmitted(`pre-snapshot cell ${name}`, spec, value);
  }

  const expectedChannels = new Map<string, ChannelSpec>();
  for (const channel of plan.channels) {
    const key = `${channel.namespace}.${channel.key}`;
    const spec = node.signature?.[channel.namespace][channel.key];
    if (!spec) {
      throw invalidPersistedState(
        `pre-snapshot channel ${key} has no registered authority`,
      );
    }
    expectedChannels.set(key, spec);
  }
  for (const [key, value] of Object.entries(snapshot.channels)) {
    const spec = expectedChannels.get(key);
    if (!spec) {
      throw invalidPersistedState(
        `pre-snapshot contains an unplanned channel ${JSON.stringify(key)}`,
      );
    }
    if (value !== undefined) {
      assertPersistedAdmitted(`pre-snapshot channel ${key}`, spec, value);
    }
  }

  const expectedNodeRefs = expectedSnapshotNodeRefs(
    entries,
    traversal,
    node,
    entry,
    plan,
  );
  for (const [ref, state] of Object.entries(snapshot.nodeStates)) {
    if (!expectedNodeRefs.has(ref as NodeRef)) {
      throw invalidPersistedState(
        `pre-snapshot contains an unplanned node state ${JSON.stringify(ref)}`,
      );
    }
    if (
      state !== undefined &&
      state !== "covered" &&
      state !== "deflected" &&
      state !== "skipped"
    ) {
      throw invalidPersistedState(
        `pre-snapshot contains invalid node state ${JSON.stringify(state)}`,
      );
    }
  }

  const allowedUnresolved = new Set<string>([
    ...plan.cells.map((name) => `cell:${name}`),
    ...plan.nodeIdentifiers.map((identifier) => `nodeState:${identifier}`),
    ...plan.channels.map(({ namespace, key }) => `channel:${namespace}.${key}`),
  ]);
  if (
    !Array.isArray(snapshot.unresolvedKeys) ||
    snapshot.unresolvedKeys.some(
      (key) => typeof key !== "string" || !allowedUnresolved.has(key),
    )
  ) {
    throw invalidPersistedState(
      "pre-snapshot contains an invalid unresolved key",
    );
  }
}

function expectedSnapshotNodeRefs(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  entry: RegistryEntry,
  plan: NodeReadSet,
): Set<NodeRef> {
  const refs = new Set<NodeRef>();
  const ownerRef = traversalToNodeRef(traversal);
  for (const identifier of plan.nodeIdentifiers) {
    const resolved = resolveLexicalRef(
      entries,
      entry,
      ownerRef,
      node,
      identifier,
    );
    if (resolved)
      refs.add(isArcRef(resolved) ? arcToNodeRef(resolved) : resolved);
  }
  return refs;
}

function findLexicalCellSpec(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  name: string,
): CellSpec | undefined {
  let ref: NodeRef | undefined = traversalToNodeRef(traversal);
  while (ref) {
    const entry = getEntryForRef(entries, ref);
    const node = entry && getNodeForRef(entries, entry, ref);
    const cell = node?.cells.find((candidate) => candidate.name === name);
    if (cell) return cell;
    ref = lexicalParentRef(ref);
  }
  return undefined;
}

function resolvePersistedEnterTargetNode(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversal: Traversal,
  node: Node,
  action: Extract<ActionStatement, { kind: "enter-node" | "enter-loop" }>,
): Node | undefined {
  const ownerEntry = getEntryForRef(entries, traversal.ref);
  if (!ownerEntry) return undefined;
  const ownerRef = traversalToNodeRef(traversal);
  const ref =
    action.target.mode === "newcopy"
      ? toAnonymousCopyRef(traversal, action.target.identifier, action.id)
      : resolveLexicalRef(
          entries,
          ownerEntry,
          ownerRef,
          node,
          action.target.identifier,
          action.target.imported,
        );
  if (!ref) return undefined;
  const targetEntry = getEntryForRef(entries, ref);
  return targetEntry && getNodeForRef(entries, targetEntry, ref);
}

function findStatefulAction(
  statements: readonly Statement[],
  id: ElementId,
):
  | Extract<ActionStatement, { kind: "enter-node" | "enter-loop" | "map" }>
  | undefined {
  for (const statement of statements) {
    if (
      statement.id === id &&
      (statement.kind === "enter-node" ||
        statement.kind === "enter-loop" ||
        statement.kind === "map")
    ) {
      return statement;
    }
    const nested =
      statement.kind === "if"
        ? [statement.consequent, statement.alternate ?? []]
        : statement.kind === "label" ||
            statement.kind === "invoke" ||
            statement.kind === "map"
          ? [statement.body]
          : [];
    for (const body of nested) {
      const found = findStatefulAction(body, id);
      if (found) return found;
    }
  }
  return undefined;
}

function assertPersistedPinEntry(entry: PinEntry): void {
  if (entry.kind === "judgment") {
    if (entry.resolved && typeof entry.value !== "boolean") {
      throw invalidPersistedState("resolved judgment pin is not boolean");
    }
    if (!entry.resolved && entry.value !== undefined) {
      throw invalidPersistedState("pending judgment pin carries a value");
    }
    return;
  }

  if (entry.kind === "value") {
    if (!Number.isSafeInteger(entry.subtreeSize) || entry.subtreeSize < 1) {
      throw invalidPersistedState("value pin has an invalid subtree size");
    }
  }
  if (entry.resolved && typeof entry.hasValue !== "boolean") {
    throw invalidPersistedState("resolved value pin has no setness encoding");
  }
  if (entry.hasValue === true) {
    if (entry.value === undefined) {
      throw invalidPersistedState("set value pin has no carrier");
    }
    assertPersistedDurableCarrier("pin", entry.value);
  } else if (entry.value !== undefined) {
    throw invalidPersistedState("unset or pending value pin carries a carrier");
  }
}

function assertPersistedAdmitted(
  label: string,
  spec: CellSpec | ChannelSpec,
  value: unknown,
): void {
  assertPersistedDurableCarrier(label, value);
  const admission = admitValue(spec, value);
  if (!admission.admitted) {
    const { detail, path } = admission.violation;
    throw invalidPersistedState(
      `${label} violates its ${spec.type} guarantee${path === "$" ? "" : ` at ${path}`}: ${detail}`,
    );
  }
}

function assertPersistedDurableCarrier(label: string, value: unknown): void {
  const issue = firstInvalidPayloadValue(value);
  if (issue) {
    throw invalidPersistedState(
      `${label} is not a durable carrier at ${issue.path}: ${issue.detail}`,
    );
  }
  const nonFinite = firstNonFiniteNumberPath(value);
  if (nonFinite !== undefined) {
    throw invalidPersistedState(
      `${label} contains a non-finite number at ${nonFinite}`,
    );
  }
}

function invalidPersistedState(detail: string): Error {
  return new Error(`Invalid persisted traversal state: ${detail}`);
}

export type {
  ActionBrief,
  ActionPoisonReason,
  ActionReport,
  HostCallBrief,
  HostEffectBrief,
  HostEffectReport,
  InstructionBrief,
  InstructionPostcheck,
  InstructionReport,
  JudgmentBrief,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupField,
  ObservationGroupReport,
  ObservationReport,
  ObservationValueMeta,
  ScalarObservationMeta,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "../types/host-interaction.js";
export type { WriteDiffMode } from "../types/parser.js";
export type {
  ActionMove,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  NodeRef,
  NodeState,
  NodeTransition,
  RuntimeDocumentIssue,
  RuntimeIssue,
  RuntimeRegistrationIssue,
  RuntimeRegistryIssue,
  TransitionStretch,
} from "../types/runtime.js";
export { isPrimitiveArrayValue, isPrimitiveValue } from "../types/value.js";
export type {
  ArrayElementValue,
  ArrayValue,
  ArtifactValue,
  CellValue,
  Dialog,
  DialogCursor,
  DialogTurn,
  PayloadValue,
  PrimitiveArrayValue,
  PrimitiveValue,
  SemanticText,
  SemanticTextPart,
} from "../types/value.js";
export { createArtifactValue, isArtifactValue };
