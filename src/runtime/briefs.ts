import type {
  ActionMove,
  ActionReport,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  HostEffect,
  InstructionBrief,
  TriggerOutcome,
  TriggerReport,
} from "../types.js";
import { runTrigger, runTurn } from "./execute.js";
import { arcToNodeRef, formatRef, indexTraversals, rootRefOf } from "./refs.js";
import {
  type Accumulator,
  type ActionBriefSnapshot,
  type ActionBriefState,
  type TriggerBriefSnapshot,
  type TriggerBriefState,
  cloneArcTraversal,
  cloneHostCallBrief,
  cloneHostEffect,
  cloneInstructionBrief,
  cloneTraversalSet,
  createAccumulator,
  createFreshArcTraversal,
  resolveTraversalForBrief,
  restartTraversal,
  selectActionRootTraversal,
  upsertTraversal,
} from "./state.js";

export function cloneTriggerBriefSnapshot(
  plan: TriggerBriefSnapshot,
): TriggerBriefSnapshot {
  return {
    judgments: plan.judgments.map((item) => ({ ...item })),
    observations: plan.observations.map((item) => ({ ...item })),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    matchableArcs: [...plan.matchableArcs],
  };
}

export function validateTriggerReport(
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
        `Unknown arc selected in trigger report: ${formatRef(report.match)}`,
      );
    }
  }
  validateReportIds(
    "judgment",
    plan.judgments.map((item) => item.id),
    report.judgments,
    "trigger report",
  );
  validateReportIds(
    "observation",
    plan.observations.map((item) => item.id),
    report.observations,
    "trigger report",
  );
  validateReportIds(
    "host call",
    plan.hostCalls.map((item) => item.id),
    report.hostCalls,
    "trigger report",
  );
}

export function acceptTriggerReport(
  state: TriggerBriefState,
  dialog: Dialog,
  report: TriggerReport,
): TriggerOutcome {
  validateTriggerReport(state.snapshot, report);

  const nextTraversals = cloneTraversalSet(state.traversals);
  const traversalByArc = indexTraversals(state.traversals);
  const matchable = new Set(state.snapshot.matchableArcs);

  for (const [arcKey, entry] of state.entryByArc) {
    const existing = traversalByArc.get(arcKey);
    const base = existing
      ? cloneArcTraversal(existing)
      : createFreshArcTraversal(entry.arc, entry.root, 0);
    const accum = createAccumulator(
      state.entries,
      entry,
      base,
      [base],
      dialog,
      "apply",
    );
    applyReportResults(accum, report);
    const matched = runTrigger(entry.root, base, accum);
    if (matched && !accum.blocked) matchable.add(arcKey);
  }

  let matchKey = report.match ? report.match : undefined;
  if (!matchKey && matchable.size === 1) matchKey = [...matchable][0];
  if (!matchKey) return { matched: undefined, traversals: nextTraversals };
  if (!matchable.has(matchKey)) {
    throw new Error(
      `Selected arc ${formatRef(report.match!)} is not matchable in this trigger brief`,
    );
  }

  const entry = state.entryByArc.get(matchKey);
  if (!entry) throw new Error(`Unknown arc: ${matchKey}`);
  const existing = traversalByArc.get(matchKey);
  const base = existing
    ? cloneArcTraversal(existing)
    : createFreshArcTraversal(entry.arc, entry.root, 0);
  const accum = createAccumulator(
    state.entries,
    entry,
    base,
    [base],
    dialog,
    "apply",
  );
  applyReportResults(accum, report);
  const matched = runTrigger(entry.root, base, accum);
  if (!matched || accum.blocked) {
    throw new Error(
      `Arc ${formatRef(entry.arc)} did not satisfy its trigger under the accepted report`,
    );
  }
  const seeded = restartTraversal(entry, base);
  upsertTraversal(nextTraversals, seeded);
  return { matched: seeded.ref, traversals: nextTraversals };
}

export function finalizeActionBrief(
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

export function cloneActionBriefSnapshot(
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

export function validateActionReport(
  plan: ActionBriefSnapshot,
  report: ActionReport,
): void {
  if (!plan.allowedMoves.includes(report.move))
    throw new Error(`Illegal turn move: ${report.move}`);
  validateReportIds(
    "judgment",
    plan.judgments.map((item) => item.id),
    report.judgments,
    "action report",
  );
  validateReportIds(
    "observation",
    plan.observations.map((item) => item.id),
    report.observations,
    "action report",
  );
  validateReportIds(
    "host call",
    plan.hostCalls.map((item) => item.id),
    report.hostCalls,
    "action report",
  );
}

export function acceptActionReport(
  state: ActionBriefState,
  dialog: Dialog,
  report: ActionReport,
): {
  traversals: ArcTraversalSet;
  hostEffects: HostEffect[];
  instructions: InstructionBrief[];
} {
  validateActionReport(state.snapshot, report);
  if (report.move === "defer") {
    return {
      traversals: cloneTraversalSet(state.traversals),
      hostEffects: [],
      instructions: [],
    };
  }

  const working = cloneTraversalSet(state.traversals);
  const rootTraversal = selectActionRootTraversal(working, state.entry.arc);

  if (report.move === "deflect") {
    const activeTraversal = resolveTraversalForBrief(
      working,
      state.snapshot.active,
    );
    activeTraversal.state = "deflected";
    rootTraversal.pendingEffects = {
      reason: "deflected",
      active: state.snapshot.active,
    };

    const accum = createAccumulator(
      state.entries,
      state.entry,
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
    state.entries,
    state.entry,
    selectActionRootTraversal(working, state.entry.arc),
    working,
    dialog,
    "apply",
  );
  applyReportResults(accum, report);
  runTurn(accum);
  return {
    traversals: working,
    hostEffects: accum.hostEffects.map(cloneHostEffect),
    instructions: accum.instructions.map(cloneInstructionBrief),
  };
}

function validateReportIds(
  label: string,
  knownIds: string[],
  provided: Record<string, unknown> | undefined,
  reportKind: string,
): void {
  if (!provided) return;
  const ids = new Set(knownIds);
  for (const id of Object.keys(provided))
    if (!ids.has(id))
      throw new Error(`Unknown ${label} id in ${reportKind}: ${id}`);
}

function applyReportResults(
  accum: Accumulator,
  report: Pick<ActionReport, "judgments" | "observations" | "hostCalls">,
): void {
  for (const [id, value] of Object.entries(report.judgments ?? {}))
    accum.judgmentResults.set(id, value);
  for (const [id, value] of Object.entries(report.observations ?? {}))
    if (value) accum.observationResults.set(id, value);
  for (const [id, value] of Object.entries(report.hostCalls ?? {}))
    accum.hostCallResults.set(id, value);
}
