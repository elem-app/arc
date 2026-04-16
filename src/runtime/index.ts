import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  Document,
  HostCallBrief,
  HostEffect,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  ObservationBrief,
  TriggerBrief,
  TriggerOutcome,
  TriggerReport,
} from "../types.js";
import {
  acceptActionReport,
  acceptTriggerReport,
  cloneActionBriefSnapshot,
  cloneTriggerBriefSnapshot,
  finalizeActionBrief,
  validateActionReport,
} from "./briefs.js";
import { runTrigger, runTurn } from "./execute.js";
import { formatRef, indexTraversals, rootRefOf, toArcRef } from "./refs.js";
import {
  cloneArcTraversal,
  cloneDialog,
  cloneHostEffect,
  cloneTraversalSet,
  createAccumulator,
  createFreshArcTraversal,
  isStopped,
  mergeInstructionBriefs,
  pruneFrames,
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
    return createFreshArcTraversal(arc, entry.root, 1);
  }

  startTrigger(traversals: ArcTraversalSet, dialog: Dialog): TriggerBrief {
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

    const snapshot = {
      judgments,
      observations,
      hostCalls,
      matchableArcs,
    } satisfies TriggerBrief;
    const brief: TriggerBrief = cloneTriggerBriefSnapshot(snapshot);
    this.#triggerBriefState.set(brief, {
      entries: new Map(this.#entries),
      entryByArc,
      traversals: cloneTraversalSet(traversals),
      dialog: cloneDialog(dialog),
      snapshot: cloneTriggerBriefSnapshot(snapshot),
    });
    return brief;
  }

  progressTrigger(
    brief: TriggerBrief,
    report: TriggerReport,
    dialog: Dialog,
  ): TriggerOutcome {
    const state = this.#triggerBriefState.get(brief);
    if (!state) throw new Error("Unknown trigger brief");
    return acceptTriggerReport(state, dialog, report);
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

    const applied = acceptActionReport(state, dialog, report);

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
    if (!entry) throw new Error(`Unknown arc: ${formatRef(ref)}`);
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
      pruneFrames(this.#entries, traversalEntry, traversal);
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
      entries: new Map(this.#entries),
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
