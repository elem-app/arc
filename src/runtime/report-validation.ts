import type {
  ActionReport,
  ArcRef,
  NodeRef,
  ObservationBrief,
  PrimitiveValue,
  RuntimeIssue,
  SourceRange,
  TriggerReport,
} from "../types.js";

export type ReportValidation<TReport> = {
  accepted: TReport;
  issues: RuntimeIssue[];
  rejected: boolean;
};

export function buildInvalidReportIssue(
  reasonCode: string,
  reason: string,
): RuntimeIssue {
  return {
    kind: "invalid-report",
    reasonCode,
    reason,
  };
}

export function buildInvalidItemIssue(
  briefId: string,
  reasonCode: string,
  reason: string,
): RuntimeIssue {
  return {
    kind: "invalid-item",
    briefId,
    reasonCode,
    reason,
  };
}

export function buildPoisonedTraversalIssue(
  arc: ArcRef,
  active: NodeRef,
  source: SourceRange | undefined,
  reason: string,
): RuntimeIssue {
  return {
    kind: "poisoned-traversal",
    arc,
    active,
    source,
    reasonCode: "runtime-error",
    reason,
  };
}

export function buildAmbiguousMatchIssue(
  matchableArcs: ArcRef[],
): RuntimeIssue {
  return {
    kind: "ambiguous-match",
    matchableArcs: [...matchableArcs],
    reasonCode: "multiple-matchable-arcs",
    reason: `Multiple arcs are matchable: ${matchableArcs.join(", ")}`,
  };
}

export function cloneRuntimeIssue(issue: RuntimeIssue): RuntimeIssue {
  if (issue.kind === "poisoned-traversal") {
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
  if (issue.kind === "ambiguous-match") {
    return {
      ...issue,
      matchableArcs: [...issue.matchableArcs],
    };
  }
  return { ...issue };
}

export function buildAcceptedActionReport(report: ActionReport): ActionReport {
  return {
    move: report.move,
  };
}

export function buildAcceptedTriggerReport(
  report: TriggerReport,
): TriggerReport {
  return {
    preferredMatch: report.preferredMatch,
  };
}

export function findUnknownReportIdIssue(
  label: string,
  knownIds: string[],
  provided: Record<string, unknown> | undefined,
  reportKind: string,
): RuntimeIssue | undefined {
  if (!provided) return undefined;
  const ids = new Set(knownIds);
  for (const id of Object.keys(provided)) {
    if (!ids.has(id)) {
      return buildInvalidReportIssue(
        `unknown-${label.replaceAll(" ", "-")}-id`,
        `Unknown ${label} id in ${reportKind}: ${id}`,
      );
    }
  }
  return undefined;
}

export function filterObservationReports(
  observations: readonly ObservationBrief[],
  provided: Record<string, unknown>,
  reportKind: string,
): {
  accepted?: ActionReport["observations"];
  issues: RuntimeIssue[];
} {
  const byId = new Map(observations.map((item) => [item.id, item]));
  const accepted: NonNullable<ActionReport["observations"]> = {};
  const issues: RuntimeIssue[] = [];

  for (const [id, raw] of Object.entries(provided)) {
    const observation = byId.get(id);
    if (!observation) {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(
        buildInvalidItemIssue(
          id,
          "observation-shape",
          `Invalid observation result in ${reportKind}: ${id}`,
        ),
      );
      continue;
    }

    const report = raw as { status?: unknown; value?: unknown };
    if (
      report.status !== "resolved" &&
      report.status !== "unknown" &&
      report.status !== "needs-user"
    ) {
      issues.push(
        buildInvalidItemIssue(
          id,
          "observation-status",
          `Invalid observation status in ${reportKind} for ${observation.variable}: ${String(report.status)}`,
        ),
      );
      continue;
    }
    if (report.status === "needs-user" && observation.mode !== "observeOrAsk") {
      issues.push(
        buildInvalidItemIssue(
          id,
          "observation-needs-user",
          `Observation ${observation.variable} in ${reportKind} cannot use needs-user`,
        ),
      );
      continue;
    }
    if (report.status === "resolved") {
      const valueIssue = validateResolvedObservationValue(
        observation,
        report.value,
        reportKind,
      );
      if (valueIssue) {
        issues.push(valueIssue);
        continue;
      }
      accepted[id] = {
        status: "resolved",
        value: report.value as PrimitiveValue,
      };
      continue;
    }
    accepted[id] = { status: report.status };
  }

  return {
    accepted: Object.keys(accepted).length > 0 ? accepted : undefined,
    issues,
  };
}

function validateResolvedObservationValue(
  observation: ObservationBrief,
  value: unknown,
  reportKind: string,
): RuntimeIssue | undefined {
  if (observation.meta.type === "boolean") {
    if (typeof value !== "boolean") {
      return buildInvalidItemIssue(
        observation.id,
        "observation-type",
        `Invalid observation value in ${reportKind} for ${observation.variable}: expected boolean`,
      );
    }
    return undefined;
  }

  if (observation.meta.type === "rangedInt") {
    if (!Number.isInteger(value)) {
      return buildInvalidItemIssue(
        observation.id,
        "observation-type",
        `Invalid observation value in ${reportKind} for ${observation.variable}: expected integer`,
      );
    }
    const numericValue = value as number;
    if (
      (observation.meta.min !== undefined &&
        numericValue < observation.meta.min) ||
      (observation.meta.max !== undefined &&
        numericValue > observation.meta.max)
    ) {
      return buildInvalidItemIssue(
        observation.id,
        "observation-range",
        `Invalid observation value in ${reportKind} for ${observation.variable}: ${numericValue} is outside ${observation.meta.min}..${observation.meta.max}`,
      );
    }
    return undefined;
  }

  if (typeof value !== "string" || !observation.meta.values?.includes(value)) {
    return buildInvalidItemIssue(
      observation.id,
      "observation-enum",
      `Invalid observation value in ${reportKind} for ${observation.variable}: expected one of ${observation.meta.values?.join(", ")}`,
    );
  }
  return undefined;
}
