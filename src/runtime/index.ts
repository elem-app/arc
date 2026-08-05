import { analyzeDocument, stampElementIds } from "../parser/index.js";
import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  Document,
  DocumentRewalkPlan,
  Node,
  NodeRef,
  TriggerBrief,
  TriggerReport,
} from "../types.js";
import {
  acceptActionReport,
  buildActionBrief,
  buildPoisonedActionBrief,
  buildRetryTriggerBrief,
  buildTriggerBrief,
  validateActionReport,
  validateTriggerReport,
} from "./briefs.js";
import {
  computeImportRefs,
  validateImportedChannelBindings,
} from "./channel-registration.js";
import {
  arcToNodeRef,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  toArcRef,
} from "./refs.js";
import {
  cloneTraversalSet,
  createEmptyArcTraversal,
  isStopped,
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

export class Runtime {
  readonly #documents = new Map<string, Document>();
  readonly #entries = new Map<ArcRef, RegistryEntry>();
  readonly #rewalkPlans = new WeakMap<Document, DocumentRewalkPlan>();
  readonly #actionBriefState = new WeakMap<ActionBrief, ActionBriefState>();
  readonly #triggerBriefState = new WeakMap<TriggerBrief, TriggerBriefState>();

  add(source: string, document: Document): this {
    if (this.#documents.has(source)) {
      throw new Error(`Document already registered for source ${source}`);
    }

    // Deep-clones the document
    const registeredDocument = JSON.parse(JSON.stringify(document)) as Document;
    // Stamps the private clone (never the caller's document), so hand-built
    // IR registers without a manual normalization step. The analysis below
    // then verifies canonical ids as a no-op.
    for (const root of registeredDocument.roots) stampElementIds(root);
    const analysis = analyzeDocument(registeredDocument);
    const firstIssue = analysis.issues[0];
    if (firstIssue) {
      throw new Error(`${firstIssue.code}: ${firstIssue.message}`);
    }
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
        rewalkPlan,
      });
    }

    // Build a prospective registry (existing entries plus the new ones) with
    // freshly resolved import refs, validate imported channel bindings on it,
    // and only then commit — so an incompatible cross-document binding rejects
    // registration and leaves the runtime unchanged (atomic add).
    const prospective = new Map(this.#entries);
    for (const entry of registrations) {
      prospective.set(entry.arc, entry);
    }
    const resolved = computeImportRefs(prospective);
    validateImportedChannelBindings(resolved);

    this.#documents.set(source, registeredDocument);
    this.#rewalkPlans.set(registeredDocument, rewalkPlan);
    for (const [arc, entry] of resolved) {
      this.#entries.set(arc, entry);
    }
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
    const entry = this.#getEntry(arc);
    return createEmptyArcTraversal(arc, entry.root);
  }

  startTrigger(
    traversals: ArcTraversalSet,
    dialog: Dialog,
    opts: { arcRefs?: readonly ArcRef[] } = {},
  ): TriggerBrief {
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

  start(traversals: ArcTraversalSet, dialog: Dialog): ActionBrief {
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
          state.snapshot.active,
          validation.issues,
        ),
      );
    }
    if (rootTraversal.phase !== "entered") {
      return this.#storeActionBrief(
        state.entry,
        buildActionBrief(
          state.entries,
          state.entry,
          state.traversals,
          dialog,
          [],
          state.snapshot.active,
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
            undefined,
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
          isStopped(
            selectActionRootTraversal(applied.traversals, state.entry.arc),
          )
            ? state.snapshot.active
            : undefined,
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
    built: {
      brief: ActionBrief;
      traversals: ArcTraversalSet;
      snapshot: ActionBriefState["snapshot"];
    },
  ): ActionBrief {
    this.#actionBriefState.set(built.brief, {
      entries: new Map(this.#entries),
      entry,
      traversals: built.traversals,
      snapshot: built.snapshot,
    });

    return built.brief;
  }
}

export { isArrayValue, isPrimitiveValue } from "../types.js";
export type {
  ActionBrief,
  ActionMove,
  ActionPoisonReason,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  ArrayValue,
  BriefId,
  CellValue,
  Dialog,
  DialogCursor,
  DialogTurn,
  HostCallBrief,
  HostEffectBrief,
  HostEffectReport,
  InstructionBrief,
  InstructionPostcheck,
  InstructionReport,
  JudgmentBrief,
  NodeRef,
  NodeState,
  NodeTransition,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupField,
  ObservationGroupReport,
  ObservationReport,
  ObservationValueMeta,
  PayloadValue,
  PrimitiveValue,
  RuntimeIssue,
  ScalarObservationMeta,
  ScalarSpec,
  SemanticText,
  SemanticTextPart,
  TransitionStretch,
  TriggerBrief,
  TriggerReport,
  WriteDiffMode,
} from "../types.js";
