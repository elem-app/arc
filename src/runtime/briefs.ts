import type {
  ActionBrief,
  ActionMove,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  HostEffect,
  InstructionBrief,
  NodeRef,
  RuntimeIssue,
  TriggerBrief,
  TriggerReport,
} from "../types.js";
import { continueArc, runTrigger } from "./execute.js";
import { arcToNodeRef, formatRef, indexTraversals, rootRefOf } from "./refs.js";
import {
  buildAcceptedActionReport,
  buildAcceptedTriggerReport,
  buildAmbiguousMatchIssue,
  buildInvalidItemIssue,
  buildInvalidReportIssue,
  buildPoisonedTraversalIssue,
  cloneRuntimeIssue,
  filterObservationReports,
  findUnknownReportIdIssue,
  type ReportValidation,
} from "./report-validation.js";
import {
  cloneArcTraversal,
  cloneHostCallBrief,
  cloneHostEffect,
  cloneInstructionBrief,
  cloneTraversalSet,
  createAccumulator,
  createFreshArcTraversal,
  mergeInstructionBriefs,
  pruneFrames,
  resolveTraversalForBrief,
  restartTraversal,
  selectActionRootTraversal,
  upsertTraversal,
  type Accumulator,
  type ActionBriefSnapshot,
  type ActionBriefState,
  type RegistryEntry,
  type TriggerBriefSnapshot,
} from "./state.js";

function cloneTriggerBriefSnapshot(
  plan: TriggerBriefSnapshot,
): TriggerBriefSnapshot {
  return {
    matched: plan.matched,
    traversals: cloneTraversalSet(plan.traversals),
    issues: plan.issues.map(cloneRuntimeIssue),
    judgments: plan.judgments.map((item) => ({ ...item })),
    observations: plan.observations.map((item) => ({ ...item })),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    matchableArcs: [...plan.matchableArcs],
  };
}

export function validateTriggerReport(
  plan: TriggerBriefSnapshot,
  report: TriggerReport,
): ReportValidation<TriggerReport> {
  if (report.preferredMatch) {
    const candidate = new Set([
      ...plan.matchableArcs,
      ...plan.judgments.map((item) => rootRefOf(item.sourceRef)),
      ...plan.observations.map((item) => rootRefOf(item.sourceRef)),
      ...plan.hostCalls.map((item) => rootRefOf(item.sourceRef)),
    ]);
    if (!candidate.has(report.preferredMatch)) {
      return {
        accepted: buildAcceptedTriggerReport(report),
        issues: [
          buildInvalidReportIssue(
            "unknown-trigger-match",
            `Unknown arc selected in trigger report: ${formatRef(report.preferredMatch)}`,
          ),
        ],
        rejected: true,
      };
    }
  }

  const judgmentIdIssue = findUnknownReportIdIssue(
    "judgment",
    plan.judgments.map((item) => item.id),
    report.judgments,
    "trigger report",
  );
  if (judgmentIdIssue) {
    return {
      accepted: buildAcceptedTriggerReport(report),
      issues: [judgmentIdIssue],
      rejected: true,
    };
  }

  const observationIdIssue = findUnknownReportIdIssue(
    "observation",
    plan.observations.map((item) => item.id),
    report.observations,
    "trigger report",
  );
  if (observationIdIssue) {
    return {
      accepted: buildAcceptedTriggerReport(report),
      issues: [observationIdIssue],
      rejected: true,
    };
  }

  const hostCallIdIssue = findUnknownReportIdIssue(
    "host call",
    plan.hostCalls.map((item) => item.id),
    report.hostCalls,
    "trigger report",
  );
  if (hostCallIdIssue) {
    return {
      accepted: buildAcceptedTriggerReport(report),
      issues: [hostCallIdIssue],
      rejected: true,
    };
  }

  const accepted = buildAcceptedTriggerReport(report);
  const issues: RuntimeIssue[] = [];

  if (report.judgments) {
    const judgments: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(report.judgments)) {
      if (typeof value !== "boolean") {
        issues.push(
          buildInvalidItemIssue(
            id,
            "judgment-type",
            `Invalid judgment value in trigger report for ${id}: expected boolean`,
          ),
        );
        continue;
      }
      judgments[id] = value;
    }
    if (Object.keys(judgments).length > 0) {
      accepted.judgments = judgments;
    }
  }

  if (report.observations) {
    const result = filterObservationReports(
      plan.observations,
      report.observations,
      "trigger report",
    );
    if (result.accepted && Object.keys(result.accepted).length > 0) {
      accepted.observations = result.accepted;
    }
    issues.push(...result.issues);
  }

  if (report.hostCalls) {
    accepted.hostCalls = { ...report.hostCalls };
  }

  return { accepted, issues, rejected: false };
}

function finalizeTriggerBrief(
  snapshot: TriggerBriefSnapshot,
  priorReport: TriggerReport = {},
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  snapshot: TriggerBriefSnapshot;
} {
  const clonedSnapshot = cloneTriggerBriefSnapshot(snapshot);
  return {
    brief: cloneTriggerBriefSnapshot(clonedSnapshot),
    traversals: cloneTraversalSet(clonedSnapshot.traversals),
    priorReport,
    snapshot: clonedSnapshot,
  };
}

export function buildRetryTriggerBrief(
  snapshot: TriggerBriefSnapshot,
  issues: RuntimeIssue[] = [],
  priorReport: TriggerReport = {},
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  snapshot: TriggerBriefSnapshot;
} {
  return finalizeTriggerBrief(
    {
      ...snapshot,
      issues: [...issues],
    },
    priorReport,
  );
}

function mergeTriggerReports(
  prior: TriggerReport,
  next: TriggerReport,
): TriggerReport {
  return {
    preferredMatch: next.preferredMatch,
    judgments:
      prior.judgments || next.judgments
        ? {
            ...(prior.judgments ?? {}),
            ...(next.judgments ?? {}),
          }
        : undefined,
    observations:
      prior.observations || next.observations
        ? {
            ...(prior.observations ?? {}),
            ...(next.observations ?? {}),
          }
        : undefined,
    hostCalls:
      prior.hostCalls || next.hostCalls
        ? {
            ...(prior.hostCalls ?? {}),
            ...(next.hostCalls ?? {}),
          }
        : undefined,
  };
}

export function buildTriggerBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  report: TriggerReport = {},
  priorReport: TriggerReport = {},
  leadingIssues: RuntimeIssue[] = [],
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  snapshot: TriggerBriefSnapshot;
} {
  const acceptedReport = mergeTriggerReports(priorReport, report);
  const nextTraversals = cloneTraversalSet(traversals);
  const traversalByArc = indexTraversals(traversals);
  const judgments = [];
  const observations = [];
  const hostCalls = [];
  const matchableArcs: ArcRef[] = [];
  const matchedBases = new Map<
    ArcRef,
    { entry: RegistryEntry; base: ArcTraversal }
  >();
  const issues: RuntimeIssue[] = [...leadingIssues];

  for (const [arcKey, entry] of entryByArc) {
    const existing = traversalByArc.get(arcKey);
    if (existing?.phase === "poisoned") {
      continue;
    }
    const base = existing
      ? cloneArcTraversal(existing)
      : createFreshArcTraversal(entry.arc, entry.root);
    const before = JSON.stringify(base);
    const accum = createAccumulator(
      entries,
      entry,
      base,
      [base],
      dialog,
      "plan",
    );
    applyReportResults(accum, acceptedReport);
    try {
      const matched = runTrigger(entry.root, base, accum);
      judgments.push(...accum.judgments);
      observations.push(...accum.observations);
      hostCalls.push(...accum.hostCalls);
      if (existing || before !== JSON.stringify(base)) {
        upsertTraversal(nextTraversals, base);
      }
      if (matched && !accum.blocked) {
        matchableArcs.push(arcKey);
        matchedBases.set(arcKey, { entry, base });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      base.phase = "poisoned";
      base.finalizing = undefined;
      upsertTraversal(nextTraversals, base);
      issues.push(
        buildPoisonedTraversalIssue(
          entry.arc,
          accum.briefActive ?? accum.active ?? arcToNodeRef(entry.arc),
          entry.root.loc,
          message,
        ),
      );
    }
  }

  let matchKey = acceptedReport.preferredMatch
    ? acceptedReport.preferredMatch
    : undefined;
  if (!matchKey && matchableArcs.length === 1) {
    matchKey = matchableArcs[0];
  }
  if (matchKey && matchedBases.has(matchKey)) {
    const { entry, base } = matchedBases.get(matchKey)!;
    const seeded = restartTraversal(entry, base);
    upsertTraversal(nextTraversals, seeded);
    return finalizeTriggerBrief(
      {
        matched: seeded.ref,
        traversals: nextTraversals,
        issues: [...issues],
        judgments: [],
        observations: [],
        hostCalls: [],
        matchableArcs: [],
      },
      acceptedReport,
    );
  }

  const hasPendingWork =
    judgments.length > 0 || observations.length > 0 || hostCalls.length > 0;
  if (matchKey && !hasPendingWork) {
    issues.push(
      buildInvalidReportIssue(
        "trigger-match-not-matchable",
        `Selected arc ${formatRef(matchKey)} is not matchable in this trigger report`,
      ),
    );
  } else if (!matchKey && !hasPendingWork && matchableArcs.length > 1) {
    issues.push(buildAmbiguousMatchIssue(matchableArcs));
  }

  return finalizeTriggerBrief(
    {
      matched: undefined,
      traversals: nextTraversals,
      issues: [...issues],
      judgments,
      observations,
      hostCalls,
      matchableArcs,
    },
    acceptedReport,
  );
}

function finalizeActionBrief(
  accum: Accumulator,
  traversal: ArcTraversal,
): ActionBriefSnapshot {
  const allowedMoves = new Set<ActionMove>();
  if (traversal.phase === "entered") {
    if (
      accum.instructions.length > 0 ||
      accum.judgments.length > 0 ||
      accum.observations.length > 0 ||
      accum.hostCalls.length > 0
    ) {
      allowedMoves.add("proceed");
      if (accum.instructions.length === 0) {
        allowedMoves.add("deflect");
      }
    }
    if (allowedMoves.size === 0) {
      allowedMoves.add("proceed");
    }
  }
  return {
    active: accum.briefActive ?? accum.active ?? arcToNodeRef(traversal.ref),
    canProgress: traversal.phase === "entered",
    issues: [],
    judgments: accum.judgments.map((item) => ({ ...item })),
    observations: accum.observations.map((item) => ({ ...item })),
    hostCalls: accum.hostCalls.map(cloneHostCallBrief),
    instructions: accum.instructions.map(cloneInstructionBrief),
    allowedMoves: [...allowedMoves],
  };
}

export function buildActionBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  leadingHostEffects: HostEffect[] = [],
  leadingInstructions: InstructionBrief[] = [],
  activeHint?: NodeRef,
  leadingIssues: RuntimeIssue[] = [],
): {
  brief: ActionBrief;
  traversals: ArcTraversalSet;
  snapshot: ActionBriefSnapshot;
} {
  const workingTraversals = cloneTraversalSet(traversals);
  const workingRoot = selectActionRootTraversal(workingTraversals, entry.arc);
  const accum = createAccumulator(
    entries,
    entry,
    workingRoot,
    workingTraversals,
    dialog,
    "plan",
  );
  for (const instruction of leadingInstructions) {
    if (instruction.phase === "apply") {
      accum.yieldedInstructionIds.add(instruction.id);
    }
  }
  if (workingRoot.phase === "entered") {
    continueArc(accum);
  } else if (activeHint) {
    accum.active = activeHint;
  }
  for (const traversal of workingTraversals) {
    const traversalEntry = entries.get(rootRefOf(traversal.ref));
    if (!traversalEntry) {
      throw new Error(`Unknown arc: ${formatRef(rootRefOf(traversal.ref))}`);
    }
    pruneFrames(entries, traversalEntry, traversal);
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
  return {
    brief: {
      traversals: yieldedTraversals,
      hostEffects: [
        ...leadingHostEffects.map(cloneHostEffect),
        ...accum.hostEffects.map(cloneHostEffect),
      ],
      ...snapshot,
      issues:
        leadingIssues.length > 0
          ? leadingIssues.map(cloneRuntimeIssue)
          : snapshot.issues,
      instructions,
    },
    traversals: cloneTraversalSet(yieldedTraversals),
    snapshot: cloneActionBriefSnapshot({
      ...snapshot,
      issues:
        leadingIssues.length > 0
          ? leadingIssues.map(cloneRuntimeIssue)
          : snapshot.issues,
      instructions,
    }),
  };
}

export function buildPoisonedActionBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  active: NodeRef,
  error: unknown,
): {
  brief: ActionBrief;
  traversals: ArcTraversalSet;
  snapshot: ActionBriefSnapshot;
} {
  const working = cloneTraversalSet(traversals);
  const rootTraversal = selectActionRootTraversal(working, entry.arc);
  rootTraversal.phase = "poisoned";
  rootTraversal.finalizing = undefined;
  const message = error instanceof Error ? error.message : String(error);
  return buildActionBrief(entries, entry, working, dialog, [], [], active, [
    buildPoisonedTraversalIssue(entry.arc, active, entry.root.loc, message),
  ]);
}

function cloneActionBriefSnapshot(
  plan: ActionBriefSnapshot,
): ActionBriefSnapshot {
  return {
    active: plan.active,
    canProgress: plan.canProgress,
    issues: plan.issues.map(cloneRuntimeIssue),
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
): ReportValidation<ActionReport> {
  if (!plan.allowedMoves.includes(report.move)) {
    return {
      accepted: buildAcceptedActionReport(report),
      issues: [
        buildInvalidReportIssue(
          "illegal-move",
          `Illegal turn move: ${report.move}`,
        ),
      ],
      rejected: true,
    };
  }

  const judgmentIdIssue = findUnknownReportIdIssue(
    "judgment",
    plan.judgments.map((item) => item.id),
    report.judgments,
    "action report",
  );
  if (judgmentIdIssue) {
    return {
      accepted: buildAcceptedActionReport(report),
      issues: [judgmentIdIssue],
      rejected: true,
    };
  }

  const observationIdIssue = findUnknownReportIdIssue(
    "observation",
    plan.observations.map((item) => item.id),
    report.observations,
    "action report",
  );
  if (observationIdIssue) {
    return {
      accepted: buildAcceptedActionReport(report),
      issues: [observationIdIssue],
      rejected: true,
    };
  }

  const hostCallIdIssue = findUnknownReportIdIssue(
    "host call",
    plan.hostCalls.map((item) => item.id),
    report.hostCalls,
    "action report",
  );
  if (hostCallIdIssue) {
    return {
      accepted: buildAcceptedActionReport(report),
      issues: [hostCallIdIssue],
      rejected: true,
    };
  }

  const accepted = buildAcceptedActionReport(report);
  const issues: RuntimeIssue[] = [];

  if (report.judgments) {
    const judgments: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(report.judgments)) {
      if (typeof value !== "boolean") {
        issues.push(
          buildInvalidItemIssue(
            id,
            "judgment-type",
            `Invalid judgment value in action report for ${id}: expected boolean`,
          ),
        );
        continue;
      }
      judgments[id] = value;
    }
    if (Object.keys(judgments).length > 0) {
      accepted.judgments = judgments;
    }
  }

  if (report.observations) {
    const result = filterObservationReports(
      plan.observations,
      report.observations,
      "action report",
    );
    if (result.accepted && Object.keys(result.accepted).length > 0) {
      accepted.observations = result.accepted;
    }
    issues.push(...result.issues);
  }

  if (report.hostCalls) {
    accepted.hostCalls = { ...report.hostCalls };
  }

  return { accepted, issues, rejected: false };
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
  const working = cloneTraversalSet(state.traversals);
  const rootTraversal = selectActionRootTraversal(working, state.entry.arc);

  if (report.move === "deflect") {
    const activeTraversal = resolveTraversalForBrief(
      working,
      state.snapshot.active,
    );
    activeTraversal.finalizing = {
      reason: "deflected",
      active: state.snapshot.active,
      phase: "catch",
    };

    const accum = createAccumulator(
      state.entries,
      state.entry,
      rootTraversal,
      working,
      dialog,
      "apply",
    );
    continueArc(accum);
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
  continueArc(accum);
  return {
    traversals: working,
    hostEffects: accum.hostEffects.map(cloneHostEffect),
    instructions: accum.instructions.map(cloneInstructionBrief),
  };
}

function applyReportResults(
  accum: Accumulator,
  report: Pick<ActionReport, "judgments" | "observations" | "hostCalls">,
): void {
  for (const [id, value] of Object.entries(report.judgments ?? {})) {
    accum.judgmentResults.set(id, value);
  }
  for (const [id, value] of Object.entries(report.observations ?? {})) {
    if (value) {
      accum.observationResults.set(id, value);
    }
  }
  for (const [id, value] of Object.entries(report.hostCalls ?? {})) {
    accum.hostCallResults.set(id, value);
  }
}
