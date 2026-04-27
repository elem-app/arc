import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  Document,
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
import { arcToNodeRef, formatRef, toArcRef } from "./refs.js";
import {
  createFreshArcTraversal,
  isStopped,
  selectActionRootTraversal,
  type ActionBriefState,
  type RegistryEntry,
  type TriggerBriefState,
} from "./state.js";

export { toArcRef, toArcRefParts, toNodeRef, toNodeRefParts } from "./refs.js";

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
        throw new Error(`Duplicate arc registration: ${formatRef(arc)}`);
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

  newTraversalSet(): ArcTraversalSet {
    return [];
  }

  newTraversal(arc: ArcRef): ArcTraversal {
    const entry = this.#getEntry(arc);
    return createFreshArcTraversal(arc, entry.root);
  }

  startTrigger(traversals: ArcTraversalSet, dialog: Dialog): TriggerBrief {
    return this.#storeTriggerBrief(
      buildTriggerBrief(
        this.#entries,
        new Map([...this.#entries.values()].map((entry) => [entry.arc, entry])),
        traversals,
        dialog,
      ),
      dialog,
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
          state.snapshot,
          validation.issues,
          state.priorReport,
        ),
        dialog,
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
      ),
      dialog,
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
          [],
          state.snapshot.active,
          validation.issues,
        ),
      );
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
          applied.instructions,
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
      snapshot: TriggerBriefState["snapshot"];
    },
    dialog: Dialog,
  ): TriggerBrief {
    this.#triggerBriefState.set(built.brief, {
      entries: new Map(this.#entries),
      entryByArc: new Map(
        [...this.#entries.values()].map((entry) => [entry.arc, entry]),
      ),
      traversals: built.traversals,
      dialog,
      priorReport: built.priorReport,
      snapshot: built.snapshot,
    });
    return built.brief;
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

export type {
  ActionBrief,
  ActionMove,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  Dialog,
  DialogTurn,
  HostCallBrief,
  HostEffect,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  NodeState,
  ObservationBrief,
  ObservationReport,
  PayloadValue,
  RuntimeIssue,
  TriggerBrief,
  TriggerReport,
} from "../types.js";
