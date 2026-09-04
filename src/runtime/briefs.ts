import type {
  ActionBrief,
  ActionReport,
  InstructionBrief,
  InstructionReport,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "../types/host-interaction.js";
import type {
  ActionMove,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  NodeRef,
  NodeTransition,
  RuntimeIssue,
} from "../types/runtime.js";
import { nodeSegKey } from "../types/runtime.js";
import type { Dialog } from "../types/value.js";
import { clonePayloadValue } from "../value-utils.js";
import {
  clearInvokeStateCrossedByDeflection,
  continueArc,
  resumeActiveFrame,
  runTrigger,
} from "./execute.js";
import { clonePinTape } from "./pins.js";
import {
  arcToNodeRef,
  formatRef,
  getEntryForRef,
  getNodeForRef,
  indexTraversals,
  rootRefOf,
} from "./refs.js";
import {
  buildAcceptedActionReport,
  buildAcceptedTriggerReport,
  buildAmbiguousMatchIssue,
  buildInvalidItemIssue,
  buildInvalidReportIssue,
  buildPoisonedTraversalIssue,
  cloneRuntimeIssue,
  filterHostCallResults,
  filterObservationReports,
  findUnknownReportIdIssue,
  runtimeErrorReasonCode,
  type ReportValidation,
} from "./report-validation.js";
import {
  clearEvaluatorActionStates,
  cloneCellValue,
  cloneHostCallBrief,
  cloneInstructionBrief,
  cloneJudgmentBrief,
  cloneObservationOrGroupBrief,
  cloneTraversalSet,
  createAccumulator,
  createEmptyArcTraversal,
  mergeInstructionBriefs,
  resolveTraversalForBrief,
  restartTraversal,
  selectActionRootTraversal,
  upsertTraversal,
  type Accumulator,
  type ActionBriefSnapshot,
  type ActionBriefState,
  type RegistryEntry,
  type TriggerBriefSnapshot,
  type TriggerCandidateState,
} from "./state.js";

function cloneTriggerBriefSnapshot(
  plan: TriggerBriefSnapshot,
): TriggerBriefSnapshot {
  return {
    matched: plan.matched,
    issues: plan.issues.map(cloneRuntimeIssue),
    judgments: plan.judgments.map(cloneJudgmentBrief),
    observations: plan.observations.map(cloneObservationOrGroupBrief),
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
    const result = filterHostCallResults(report.hostCalls);
    if (result.accepted) accepted.hostCalls = result.accepted;
    issues.push(...result.issues);
  }

  return { accepted, issues, rejected: false };
}

function finalizeTriggerBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  snapshot: TriggerBriefSnapshot,
  priorReport: TriggerReport,
  candidates: Map<ArcRef, TriggerCandidateState>,
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  candidates: Map<ArcRef, TriggerCandidateState>;
  snapshot: TriggerBriefSnapshot;
} {
  const briefSnapshot = cloneTriggerBriefSnapshot(snapshot);
  return {
    brief: {
      traversals: cloneTraversalSet(traversals),
      deps: collectTriggerDeps(entries, traversals, snapshot),
      ...briefSnapshot,
    },
    traversals,
    priorReport,
    candidates,
    snapshot,
  };
}

function collectTriggerDeps(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  snapshot: TriggerBriefSnapshot,
): ArcRef[] {
  const roots = new Set<ArcRef>();
  if (snapshot.matched) roots.add(snapshot.matched);
  for (const arc of snapshot.matchableArcs) roots.add(arc);
  for (const traversal of traversals) roots.add(traversal.ref);
  for (const item of snapshot.judgments) roots.add(rootRefOf(item.sourceRef));
  for (const item of snapshot.observations)
    roots.add(rootRefOf(item.sourceRef));
  for (const item of snapshot.hostCalls) roots.add(rootRefOf(item.sourceRef));
  return collectTransitiveArcDeps(entries, roots);
}

function collectTransitiveArcDeps(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  roots: Iterable<ArcRef>,
): ArcRef[] {
  const deps = new Set<ArcRef>();
  const visit = (arc: ArcRef): void => {
    if (deps.has(arc)) return;
    deps.add(arc);
    const entry = entries.get(arc);
    if (!entry) return;
    for (const imported of Object.values(entry.importRefs)) visit(imported);
  };
  for (const root of roots) visit(root);
  return [...deps];
}

export function buildRetryTriggerBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  snapshot: TriggerBriefSnapshot,
  issues: RuntimeIssue[] = [],
  priorReport: TriggerReport = {},
  candidates: Map<ArcRef, TriggerCandidateState>,
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  candidates: Map<ArcRef, TriggerCandidateState>;
  snapshot: TriggerBriefSnapshot;
} {
  return finalizeTriggerBrief(
    entries,
    cloneTraversalSet(traversals),
    {
      ...snapshot,
      issues: [...issues],
    },
    priorReport,
    cloneCandidateStates(candidates),
  );
}

/**
 * Carries the chain's retained `preferredMatch` into the next accepted report.
 * Result carryover needs no merging: judge and host-call answers live in the
 * per-candidate consultation tapes, and observation resolutions persist as
 * cell writes and trigger evaluator marks on the chain's traversal set.
 */
function carryTriggerReport(
  prior: TriggerReport,
  next: TriggerReport,
): TriggerReport {
  return {
    ...next,
    preferredMatch: next.preferredMatch ?? prior.preferredMatch,
  };
}

function cloneCandidateStates(
  candidates: ReadonlyMap<ArcRef, TriggerCandidateState>,
): Map<ArcRef, TriggerCandidateState> {
  return new Map(
    [...candidates].map(([arc, state]) => [
      arc,
      { status: state.status, tape: clonePinTape(state.tape) },
    ]),
  );
}

export function buildTriggerBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  report: TriggerReport = {},
  priorReport: TriggerReport = {},
  priorCandidates?: ReadonlyMap<ArcRef, TriggerCandidateState>,
  leadingIssues: RuntimeIssue[] = [],
): {
  brief: TriggerBrief;
  traversals: ArcTraversalSet;
  priorReport: TriggerReport;
  candidates: Map<ArcRef, TriggerCandidateState>;
  snapshot: TriggerBriefSnapshot;
} {
  const acceptedReport = carryTriggerReport(priorReport, report);
  // Absent prior candidate state means fresh consultations for every arc (a
  // new `startTrigger`); present state means a retry round-trip on the same
  // chain, which seeks each candidate's consultation instead of restarting it.
  const freshConsultations = priorCandidates === undefined;
  const candidates = priorCandidates
    ? cloneCandidateStates(priorCandidates)
    : new Map<ArcRef, TriggerCandidateState>();
  const nextTraversals = cloneTraversalSet(traversals);
  const traversalByArc = indexTraversals(nextTraversals);
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
    const base = existing ?? createEmptyArcTraversal(entry.arc, entry.root);
    const prior = candidates.get(arcKey);
    if (prior && prior.status !== "open") {
      // Terminal candidates keep their consultation outcome across retries.
      if (prior.status === "matched") {
        matchableArcs.push(arcKey);
        matchedBases.set(arcKey, { entry, base });
      }
      continue;
    }
    if (freshConsultations && existing) {
      // A new consultation releases the previous one's narrow-leaf marks; the
      // pin state is per-candidate call-state and starts empty below.
      clearEvaluatorActionStates(base, nodeSegKey("trigger"));
    }
    const candidate = prior ?? {
      status: "open" as const,
      tape: {},
    };
    candidates.set(arcKey, candidate);
    const before = JSON.stringify(base);
    const accum = createAccumulator(
      entries,
      entry,
      base,
      [base],
      dialog,
      "plan",
      // Trigger probing never announces transitions.
      false,
    );
    applyReportResults(accum, acceptedReport);
    try {
      const matched = runTrigger(entry.root, base, accum, candidate.tape);
      judgments.push(...accum.judgments);
      observations.push(...accum.observations);
      hostCalls.push(...accum.hostCalls);
      issues.push(...accum.issues);
      if (!existing && before !== JSON.stringify(base)) {
        upsertTraversal(nextTraversals, base);
      }
      if (!accum.blocked) {
        candidate.status = matched ? "matched" : "unmatched";
      }
      if (matched && !accum.blocked) {
        matchableArcs.push(arcKey);
        matchedBases.set(arcKey, { entry, base });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      base.phase = "poisoned";
      base.finalizing = undefined;
      if (!existing) upsertTraversal(nextTraversals, base);
      issues.push(
        buildPoisonedTraversalIssue(
          entry.arc,
          accum.briefActive ?? accum.active ?? arcToNodeRef(entry.arc),
          entry.root.loc,
          message,
          runtimeErrorReasonCode(error),
        ),
      );
    }
  }

  const hasPendingWork =
    judgments.length > 0 || observations.length > 0 || hostCalls.length > 0;
  let matchKey = acceptedReport.preferredMatch;
  if (!matchKey && !hasPendingWork && matchableArcs.length === 1) {
    matchKey = matchableArcs[0];
  }
  if (matchKey && matchedBases.has(matchKey)) {
    const { entry, base } = matchedBases.get(matchKey)!;
    const seeded = restartTraversal(entry, base);
    // TODO: Specify whether traversal mutations from non-selected trigger
    // candidates should remain in the matched outcome. Current behavior
    // preserves mutations already accumulated in `nextTraversals`.
    upsertTraversal(nextTraversals, seeded);
    return finalizeTriggerBrief(
      entries,
      nextTraversals,
      {
        matched: seeded.ref,
        issues: [...issues],
        judgments: [],
        observations: [],
        hostCalls: [],
        matchableArcs: [],
      },
      acceptedReport,
      candidates,
    );
  }

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
    entries,
    nextTraversals,
    {
      matched: undefined,
      issues: [...issues],
      judgments,
      observations,
      hostCalls,
      matchableArcs,
    },
    acceptedReport,
    candidates,
  );
}

function allowedMovesForActionBrief(
  accum: Pick<
    Accumulator,
    "judgments" | "observations" | "hostCalls" | "hostCallValueDemands"
  >,
  traversal: ArcTraversal,
  instructions: readonly InstructionBrief[],
  transition: NodeTransition | undefined,
): ActionMove[] {
  const allowedMoves = new Set<ActionMove>();
  if (traversal.phase !== "entered") return [];

  allowedMoves.add("poison");
  if (transition) {
    // A transition brief carries no other work; proceed acknowledges it with a
    // freshly projected dialog. Deflect is never enabled by a transition.
    allowedMoves.add("proceed");
    return [...allowedMoves];
  }
  if (
    instructions.length > 0 ||
    accum.judgments.length > 0 ||
    accum.observations.length > 0 ||
    accum.hostCalls.length > 0
  ) {
    allowedMoves.add("proceed");
    const hasStandaloneHostCall = accum.hostCalls.some(
      (call) => !accum.hostCallValueDemands.has(call.id),
    );
    if (instructions.length === 0 && !hasStandaloneHostCall) {
      allowedMoves.add("deflect");
    }
  }
  return [...allowedMoves];
}

export function buildActionBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  leadingIssues: RuntimeIssue[] = [],
): BuiltActionOutput {
  const workingTraversals = cloneTraversalSet(traversals);
  const workingRoot = selectActionRootTraversal(workingTraversals, entry.arc);
  const accum = createAccumulator(
    entries,
    entry,
    workingRoot,
    workingTraversals,
    dialog,
    "plan",
    true,
  );
  if (workingRoot.pendingTransition) {
    // An unacknowledged transition seeds the plan walk's latch, so the walk
    // re-blocks at the same gate — before any work-producing evaluation — and
    // the brief re-carries the transition. This is what makes transition
    // briefs exclusive: nothing can be collected ahead of the first gate.
    accum.transition = {
      exited: [...workingRoot.pendingTransition.exited],
      entered: [...workingRoot.pendingTransition.entered],
    };
  }
  if (workingRoot.phase === "entered") {
    if (workingRoot.activeFrame) {
      // Resume the recorded frontier in plan mode (symmetric with apply), so the
      // brief is rebuilt by replaying the suspended SEG from its recorded
      // position, not by re-deriving the arc from its root.
      resumeActiveFrame(accum);
    } else {
      continueArc(accum);
    }
  }
  for (const traversal of workingTraversals) {
    if (!entries.has(rootRefOf(traversal.ref))) {
      throw new Error(`Unknown arc: ${formatRef(rootRefOf(traversal.ref))}`);
    }
  }
  const actionRoot = selectActionRootTraversal(workingTraversals, entry.arc);
  const instructions = mergeInstructionBriefs(accum.instructions);
  const transition = buildTransitionPayload(entries, entry, accum);
  if (
    transition &&
    (instructions.length > 0 ||
      accum.judgments.length > 0 ||
      accum.observations.length > 0 ||
      accum.hostCalls.length > 0)
  ) {
    // Tripwire for a gate-placement regression: the seeded plan walk blocks at
    // the first gate, so a transition brief can never have collected work. A
    // violation would let stale-view work escape; fail loudly instead.
    throw new Error(
      "Transition brief exclusivity violated: a transition-bearing brief collected frontier work",
    );
  }
  const issues = [
    ...leadingIssues.map(cloneRuntimeIssue),
    ...accum.issues.map(cloneRuntimeIssue),
  ];
  if (actionRoot.phase !== "entered") {
    if (
      instructions.length > 0 ||
      accum.judgments.length > 0 ||
      accum.observations.length > 0 ||
      accum.hostCalls.length > 0 ||
      transition
    ) {
      throw new Error(
        "Terminal action-result invariant violated: a stopped root has pending frontier work",
      );
    }

    let outcome: TerminalBrief["outcome"];
    switch (actionRoot.phase) {
      case "completed":
        if (actionRoot.state !== "covered") {
          throw new Error(
            `Invalid completed action root state: expected "covered", got ${JSON.stringify(actionRoot.state)}`,
          );
        }
        outcome = "covered";
        break;
      case "suspended":
        if (actionRoot.state !== "deflected") {
          throw new Error(
            `Invalid suspended action root state: expected "deflected", got ${JSON.stringify(actionRoot.state)}`,
          );
        }
        outcome = "deflected";
        break;
      case "poisoned":
        outcome = "poisoned";
        break;
      default:
        throw new Error(
          `Invalid terminal action root phase: ${actionRoot.phase}`,
        );
    }

    const actionEntry = getEntryForRef(entries, actionRoot.ref) ?? entry;
    const declaredReturns = actionEntry.root.signature?.returns ?? {};
    const returns =
      outcome === "covered" && Object.keys(declaredReturns).length > 0
        ? Object.fromEntries(
            Object.entries(actionRoot.enterChannels.stagedReturns).map(
              ([key, value]) => [key, cloneCellValue(value) ?? value],
            ),
          )
        : undefined;
    return {
      brief: {
        traversals: cloneTraversalSet(workingTraversals),
        canProgress: false,
        root: actionRoot.ref,
        outcome,
        ...(returns === undefined ? {} : { returns }),
        issues,
      },
      traversals: workingTraversals,
    };
  }

  const snapshot: ActionBriefSnapshot = {
    active: accum.briefActive ?? accum.active ?? arcToNodeRef(actionRoot.ref),
    canProgress: true,
    issues,
    judgments: accum.judgments,
    observations: accum.observations,
    hostCalls: accum.hostCalls,
    instructions,
    transition,
    allowedMoves: allowedMovesForActionBrief(
      accum,
      actionRoot,
      instructions,
      transition,
    ),
  };
  return {
    brief: {
      traversals: cloneTraversalSet(workingTraversals),
      ...cloneActionBriefSnapshot(snapshot),
    },
    traversals: workingTraversals,
    snapshot,
    hostCallValueDemands: new Set(accum.hostCallValueDemands),
  };
}

export type BuiltActionBrief = {
  brief: ActionBrief;
  traversals: ArcTraversalSet;
  snapshot: ActionBriefSnapshot;
  hostCallValueDemands: ReadonlySet<BriefId>;
};

export type BuiltTerminalBrief = {
  brief: TerminalBrief;
  traversals: ArcTraversalSet;
};

export type BuiltActionOutput = BuiltActionBrief | BuiltTerminalBrief;

/**
 * Builds the brief's transition payload from the walk's flushed latch:
 * absent unless a gate stamped `position` this walk. `hostParams` is the position
 * node's authored `hostParams`, resolved at build time; unset when the
 * node declares none.
 */
function buildTransitionPayload(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  accum: Accumulator,
): NodeTransition | undefined {
  const latch = accum.transition;
  if (!latch?.position) return undefined;
  const positionEntry = getEntryForRef(entries, latch.position) ?? entry;
  const positionNode = getNodeForRef(entries, positionEntry, latch.position);
  return {
    exited: [...latch.exited],
    entered: [...latch.entered],
    position: latch.position,
    hostParams:
      positionNode?.hostParams !== undefined
        ? clonePayloadValue(positionNode.hostParams)
        : undefined,
  };
}

export function buildPoisonedActionBrief(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  active: NodeRef,
  error: unknown,
  reasonCode?: string,
): BuiltTerminalBrief {
  const working = cloneTraversalSet(traversals);
  const rootTraversal = selectActionRootTraversal(working, entry.arc);
  rootTraversal.phase = "poisoned";
  rootTraversal.finalizing = undefined;
  rootTraversal.pendingTransition = undefined;
  const message = error instanceof Error ? error.message : String(error);
  const built = buildActionBrief(entries, entry, working, dialog, [
    buildPoisonedTraversalIssue(
      entry.arc,
      active,
      entry.root.loc,
      message,
      reasonCode ?? runtimeErrorReasonCode(error),
    ),
  ]);
  if ("snapshot" in built) {
    throw new Error("Poisoned action root produced a progress brief");
  }
  return built;
}

function cloneActionBriefSnapshot(
  plan: ActionBriefSnapshot,
): ActionBriefSnapshot {
  return {
    active: plan.active,
    canProgress: plan.canProgress,
    issues: plan.issues.map(cloneRuntimeIssue),
    judgments: plan.judgments.map(cloneJudgmentBrief),
    observations: plan.observations.map(cloneObservationOrGroupBrief),
    hostCalls: plan.hostCalls.map(cloneHostCallBrief),
    instructions: plan.instructions.map(cloneInstructionBrief),
    transition: plan.transition
      ? {
          exited: [...plan.transition.exited],
          entered: [...plan.transition.entered],
          position: plan.transition.position,
          hostParams: clonePayloadValue(plan.transition.hostParams),
        }
      : undefined,
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

  const accepted = buildAcceptedActionReport(report);
  const issues: RuntimeIssue[] = [];
  if (report.move === "poison") {
    return { accepted, issues, rejected: false };
  }

  const instructionIdIssue = findUnknownReportIdIssue(
    "instruction",
    plan.instructions.map((item) => item.id),
    report.instructions,
    "action report",
  );
  if (instructionIdIssue) {
    return {
      accepted: buildAcceptedActionReport(report),
      issues: [instructionIdIssue],
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

  if (report.instructions) {
    const instructions: Record<string, InstructionReport> = {};
    const instructionsById = new Map(
      plan.instructions.map((item) => [item.id, item]),
    );
    for (const [id, value] of Object.entries(report.instructions)) {
      const instruction = instructionsById.get(id);
      if (instruction?.phase !== "apply") {
        issues.push(
          buildInvalidItemIssue(
            id,
            "instruction-phase",
            `Invalid instruction report for ${id}: only an apply-phase instruction can be reported applied`,
          ),
        );
        continue;
      }
      if (value?.status !== "applied") {
        issues.push(
          buildInvalidItemIssue(
            id,
            "instruction-status",
            `Invalid instruction report for ${id}: expected status "applied"`,
          ),
        );
        continue;
      }
      instructions[id] = { status: "applied" };
    }
    if (Object.keys(instructions).length > 0) {
      accepted.instructions = instructions;
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
    const result = filterHostCallResults(report.hostCalls);
    if (result.accepted) accepted.hostCalls = result.accepted;
    issues.push(...result.issues);
  }

  return { accepted, issues, rejected: false };
}

export function acceptActionReport(
  state: ActionBriefState,
  dialog: Dialog,
  report: ActionReport,
): {
  traversals: ArcTraversalSet;
} {
  const working = cloneTraversalSet(state.traversals);
  const rootTraversal = selectActionRootTraversal(working, state.entry.arc);
  // An accepted report acknowledges any pending transition: the dialog supplied
  // with it is the fresh view, and the apply walk starts with an empty latch so
  // the gate passes.
  rootTraversal.pendingTransition = undefined;
  const accum = createAccumulator(
    state.entries,
    state.entry,
    rootTraversal,
    working,
    dialog,
    "apply",
    true,
  );

  if (report.move === "deflect") {
    // Deflect the recorded frontier, then resume it: its finalizing routes to
    // `this.catchDeflection`, and an uncaught deflection bubbles up through the
    // same enter continuations as a normal completion. A frontier blocked in an
    // invoke body (or in a hook owned inside one) abandons the open invocation
    // as the deflection crosses it.
    const activeRef =
      rootTraversal.activeFrame?.activeRef ?? state.snapshot.active;
    const activeTraversal = resolveTraversalForBrief(working, activeRef);
    const recordedSeg = rootTraversal.activeFrame?.activeSeg;
    if (recordedSeg && "owner" in recordedSeg) {
      const entry = state.entries.get(rootRefOf(activeTraversal.ref));
      const activeNode = entry
        ? getNodeForRef(state.entries, entry, activeTraversal.ref)
        : undefined;
      if (activeNode) {
        clearInvokeStateCrossedByDeflection(
          activeTraversal,
          activeNode,
          recordedSeg.owner,
        );
      }
    }
    activeTraversal.finalizing = {
      reason: "deflected",
      // Deflection originates at this node's own frontier; it entered nothing,
      // so `from` stays unset until it propagates up through a parent's enter.
      deflection: { origin: activeRef },
      phase: "catch",
    };
    rootTraversal.activeFrame = { activeRef, activeSeg: { kind: "catch" } };
    resumeActiveFrame(accum);
    return { traversals: working };
  }

  for (const id of Object.keys(report.instructions ?? {})) {
    accum.instructionApplications.add(id);
  }
  applyReportResults(accum, report);
  resumeActiveFrame(accum);
  return { traversals: working };
}

function applyReportResults(
  accum: Accumulator,
  report: Pick<ActionReport, "judgments" | "observations" | "hostCalls">,
): void {
  for (const [id, value] of Object.entries(report.judgments ?? {})) {
    accum.judgmentResults.set(id, value);
  }
  for (const [id, value] of Object.entries(report.observations ?? {})) {
    if (!value) continue;
    // The observation channel is shared: a grouped result carries `fields`, a
    // single result carries `status`. Route each to its own result map so the
    // matching apply reads it back.
    if ("fields" in value) {
      accum.observationGroupResults.set(id, value);
    } else {
      accum.observationResults.set(id, value);
    }
  }
  for (const [id, value] of Object.entries(report.hostCalls ?? {})) {
    accum.hostCallResults.set(id, value);
  }
}
