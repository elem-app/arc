import { admitValue, resolveHostOperation } from "../spec/resolution.js";
import type {
  ActionPoisonReason,
  ActionReport,
  HostCallBrief,
  HostCallReport,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupReport,
  ObservationReport,
  ScalarObservationMeta,
  TriggerReport,
} from "../types/host-interaction.js";
import type { SourceRange } from "../types/parser.js";
import type { ArcRef, NodeRef, RuntimeIssue } from "../types/runtime.js";
import type {
  HostModuleSpec,
  ObservableCellSpec,
  ScalarValueSpec,
} from "../types/spec.js";
import type {
  PayloadValue,
  PrimitiveArrayValue,
  PrimitiveValue,
} from "../types/value.js";
import {
  clonePayloadValue,
  cloneWithCanonicalNumbers,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
} from "../value-utils.js";

export type ReportValidation<TReport> = {
  accepted: TReport;
  issues: RuntimeIssue[];
  rejected: boolean;
};

export function runtimeError(reasonCode: string, reason: string): Error {
  return Object.assign(new Error(reason), { reasonCode });
}

export function runtimeErrorReasonCode(error: unknown): string {
  if (
    error instanceof Error &&
    "reasonCode" in error &&
    typeof error.reasonCode === "string"
  ) {
    return error.reasonCode;
  }
  return "other-runtime-error";
}

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
  reasonCode = "other-runtime-error",
): RuntimeIssue {
  return {
    kind: "poisoned-traversal",
    arc,
    active,
    source,
    reasonCode,
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
    poisonReason: clonePoisonReason(report.poisonReason),
  };
}

function clonePoisonReason(
  reason: ActionPoisonReason | undefined,
): ActionPoisonReason | undefined {
  return reason ? { ...reason } : undefined;
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

/**
 * Validates observation reports against a merged plan of single and grouped
 * observation briefs. Each provided entry is dispatched by its brief's variant:
 * a grouped brief validates through {@link validateGroupReportEntry}, a single
 * brief through {@link validateSingleReportEntry}.
 */
export function filterObservationReports(
  observations: readonly (ObservationBrief | ObservationGroupBrief)[],
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
    if (observation.kind === "observation-group") {
      const groupResult = validateGroupReportEntry(
        observation,
        raw,
        reportKind,
      );
      if (groupResult.issue) issues.push(groupResult.issue);
      else if (groupResult.report) accepted[id] = groupResult.report;
      continue;
    }
    const singleResult = validateSingleReportEntry(
      observation,
      raw,
      reportKind,
    );
    if (singleResult.issue) issues.push(singleResult.issue);
    else if (singleResult.report) accepted[id] = singleResult.report;
  }

  return {
    accepted: Object.keys(accepted).length > 0 ? accepted : undefined,
    issues,
  };
}

export function filterHostCallResults(
  provided: Record<string, HostCallReport>,
): {
  accepted?: Record<string, HostCallReport>;
  issues: RuntimeIssue[];
} {
  const accepted: Record<string, HostCallReport> = {};
  const issues: RuntimeIssue[] = [];
  for (const [id, raw] of Object.entries(provided)) {
    const inspected = inspectHostCallReport(raw);
    if (!inspected) {
      issues.push(
        buildInvalidItemIssue(
          id,
          "host-call-report-shape",
          `Invalid host call report for ${id}: expected status "resolved" and an optional value`,
        ),
      );
      continue;
    }
    if (!inspected.hasValue) {
      accepted[id] = { status: "resolved" };
      continue;
    }
    const value = inspected.value;
    const payloadIssue = firstInvalidPayloadValue(value);
    if (payloadIssue) {
      issues.push(
        buildInvalidItemIssue(
          id,
          payloadIssue.code,
          `Invalid host call result for ${id} at ${payloadIssue.path}: ${payloadIssue.detail}`,
        ),
      );
      continue;
    }
    const cloned = clonePayloadValue(value as PayloadValue);
    const path = firstNonFiniteNumberPath(cloned);
    if (path !== undefined) {
      issues.push(
        buildInvalidItemIssue(
          id,
          "host-call-non-finite-number",
          `Invalid host call result for ${id}: non-finite number at ${path}`,
        ),
      );
      continue;
    }
    accepted[id] = {
      status: "resolved",
      value: cloneWithCanonicalNumbers(cloned),
    };
  }
  return {
    accepted: Object.keys(accepted).length > 0 ? accepted : undefined,
    issues,
  };
}

function inspectHostCallReport(
  raw: unknown,
): { hasValue: false } | { hasValue: true; value: unknown } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(raw);
  } catch {
    return undefined;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => key !== "status" && key !== "value") ||
    keys.length < 1 ||
    keys.length > 2
  ) {
    return undefined;
  }
  const status = descriptors.status;
  if (
    !status ||
    !("value" in status) ||
    !status.enumerable ||
    status.value !== "resolved"
  ) {
    return undefined;
  }
  const value = descriptors.value;
  if (!value) return { hasValue: false };
  if (!("value" in value) || !value.enumerable) return undefined;
  return { hasValue: true, value: value.value };
}

/** Applies declared result specs to the transport-valid host-call subset. */
export function admitHostCallResults(
  calls: readonly HostCallBrief[],
  reports: Readonly<Record<string, HostCallReport>>,
  modules: ReadonlyMap<string, HostModuleSpec>,
  valueDemands: ReadonlySet<string>,
): {
  accepted?: Record<string, HostCallReport>;
  issues: RuntimeIssue[];
} {
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const accepted: Record<string, HostCallReport> = {};
  const issues: RuntimeIssue[] = [];

  for (const [id, report] of Object.entries(reports)) {
    const call = callsById.get(id);
    if (!call) continue;
    if (!valueDemands.has(id)) {
      accepted[id] =
        "value" in report
          ? { status: "resolved", value: clonePayloadValue(report.value) }
          : { status: "resolved" };
      continue;
    }
    const path = [call.module, ...call.target, call.operation].join(".");
    const resolution = resolveHostOperation(modules, call);
    if (
      resolution.kind === "unresolved" ||
      resolution.operation.returns === undefined
    ) {
      throw new Error(
        `Value-demanding host call ${path} no longer resolves to an operation with a result`,
      );
    }
    if (!("value" in report) || report.value === undefined) {
      accepted[id] = { status: "resolved" };
      continue;
    }
    const value = report.value;
    const admission = admitValue(resolution.operation.returns, value);
    if (!admission.admitted) {
      issues.push(
        buildInvalidItemIssue(
          id,
          "host-call-result-type",
          `Invalid result for host operation ${path} at ${admission.violation.path}: ${admission.violation.detail}`,
        ),
      );
      continue;
    }
    accepted[id] = { status: "resolved", value: clonePayloadValue(value) };
  }

  return {
    accepted: Object.keys(accepted).length > 0 ? accepted : undefined,
    issues,
  };
}

/** Validates one single-observation report entry. */
function validateSingleReportEntry(
  observation: ObservationBrief,
  raw: unknown,
  reportKind: string,
): { report?: ObservationReport; issue?: RuntimeIssue } {
  const id = observation.id;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      issue: buildInvalidItemIssue(
        id,
        "observation-shape",
        `Invalid observation result in ${reportKind}: ${id}`,
      ),
    };
  }

  const report = raw as { status?: unknown; value?: unknown };
  if (
    report.status !== "resolved" &&
    report.status !== "unknown" &&
    report.status !== "needs-user"
  ) {
    return {
      issue: buildInvalidItemIssue(
        id,
        "observation-status",
        `Invalid observation status in ${reportKind} for ${observation.cell}: ${String(report.status)}`,
      ),
    };
  }
  if (report.status === "needs-user" && observation.mode !== "observeOrAsk") {
    return {
      issue: buildInvalidItemIssue(
        id,
        "observation-needs-user",
        `Observation ${observation.cell} in ${reportKind} cannot use needs-user`,
      ),
    };
  }
  if (report.status === "resolved") {
    const valueIssue = validateResolvedObservationValue(
      observation,
      report.value,
      reportKind,
    );
    if (valueIssue) return { issue: valueIssue };
    return {
      report: {
        status: "resolved",
        value: cloneWithCanonicalNumbers(
          report.value as PrimitiveValue | PrimitiveArrayValue,
        ),
      },
    };
  }
  return { report: { status: report.status } };
}

function validateResolvedObservationValue(
  observation: ObservationBrief,
  value: unknown,
  reportKind: string,
): RuntimeIssue | undefined {
  const fault = observationValueFault(observation.meta, value);
  if (!fault) return undefined;
  return buildInvalidItemIssue(
    observation.id,
    fault.code,
    `Invalid observation value in ${reportKind} for ${observation.cell}: ${fault.detail}`,
  );
}

/**
 * Checks a reported value against a cell's observation metadata, shared by the
 * single and grouped observation validators. Returns the fault's reason code and
 * a human-readable detail, or `undefined` when the value is valid.
 */
function observationValueFault(
  meta: ObservationBrief["meta"],
  value: unknown,
): { code: string; detail: string } | undefined {
  const metaFault = observationMetaFault(meta);
  if (metaFault) return metaFault;

  const admission = admitValue(observationSpec(meta), value);
  if (!admission.admitted) {
    return observationAdmissionFault(meta, admission.violation.code);
  }

  if (meta.type !== "array") {
    return scalarObservationConstraintFault(meta, value);
  }
  // All-or-nothing: validate every observation-only element constraint before
  // the group or scalar observation can write any part of the list.
  for (const element of value as PrimitiveArrayValue) {
    const fault = scalarObservationConstraintFault(meta.element, element);
    if (fault) return fault;
  }
  return undefined;
}

function observationSpec(meta: ObservationBrief["meta"]): ObservableCellSpec {
  return meta.type === "array"
    ? { type: "array", element: scalarObservationSpec(meta.element) }
    : scalarObservationSpec(meta);
}

function scalarObservationSpec(meta: ScalarObservationMeta): ScalarValueSpec {
  switch (meta.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: meta.values };
    case "rangedInt":
    case "number":
      return { type: "number" };
  }
}

function observationMetaFault(
  meta: ObservationBrief["meta"],
): { code: string; detail: string } | undefined {
  return meta.type === "array"
    ? scalarObservationMetaFault(meta.element)
    : scalarObservationMetaFault(meta);
}

function scalarObservationMetaFault(
  meta: ScalarObservationMeta,
): { code: string; detail: string } | undefined {
  if (meta.type === "rangedInt") {
    if (
      !Number.isSafeInteger(meta.min) ||
      !Number.isSafeInteger(meta.max) ||
      meta.min > meta.max
    ) {
      return {
        code: "observation-type",
        detail: "invalid integer observation metadata",
      };
    }
    return undefined;
  }
  if (meta.type === "number") {
    if (
      (meta.min !== undefined && !Number.isFinite(meta.min)) ||
      (meta.max !== undefined && !Number.isFinite(meta.max)) ||
      (meta.min !== undefined && meta.max !== undefined && meta.min > meta.max)
    ) {
      return {
        code: "observation-type",
        detail: "invalid numeric observation metadata",
      };
    }
  }
  return undefined;
}

function observationAdmissionFault(
  meta: ObservationBrief["meta"],
  code: string,
): { code: string; detail: string } {
  const scalar = meta.type === "array" ? meta.element : meta;
  if (code === "invalid-array") {
    return { code: "observation-type", detail: "expected an array" };
  }
  if (code === "invalid-enum") {
    return {
      code: "observation-enum",
      detail: `expected one of ${scalar.type === "enum" ? scalar.values.join(", ") : "the declared variants"}`,
    };
  }
  switch (scalar.type) {
    case "boolean":
      return { code: "observation-type", detail: "expected boolean" };
    case "string":
      return { code: "observation-type", detail: "expected string" };
    case "enum":
      return {
        code: "observation-enum",
        detail: `expected one of ${scalar.values.join(", ")}`,
      };
    case "rangedInt":
      return { code: "observation-type", detail: "expected integer" };
    case "number":
      return {
        code: "observation-type",
        detail: "expected a finite number",
      };
  }
}

/** Applies only the observation-specific constraint after base spec admission. */
function scalarObservationConstraintFault(
  meta: ScalarObservationMeta,
  value: unknown,
): { code: string; detail: string } | undefined {
  if (meta.type === "rangedInt") {
    if (!Number.isSafeInteger(value)) {
      return { code: "observation-type", detail: "expected integer" };
    }
    const numericValue = value as number;
    if (numericValue < meta.min || numericValue > meta.max) {
      return {
        code: "observation-range",
        detail: `${numericValue} is outside ${meta.min}..${meta.max}`,
      };
    }
  } else if (
    meta.type === "number" &&
    ((meta.min !== undefined && (value as number) < meta.min) ||
      (meta.max !== undefined && (value as number) > meta.max))
  ) {
    return {
      code: "observation-range",
      detail: `${value as number} is outside the observation bounds`,
    };
  }
  return undefined;
}

/**
 * Validates one grouped observation report entry. The report must address every
 * field in its brief; a report that omits a field, or is not a well-formed
 * fields object, is rejected whole as an `invalid-item` so the group writes
 * nothing and re-emits. Per-field, `needs-user` is allowed only for
 * `observeOrAsk` groups, and a `resolved` value must satisfy the field's cell
 * type.
 */
function validateGroupReportEntry(
  group: ObservationGroupBrief,
  raw: unknown,
  reportKind: string,
): { report?: ObservationGroupReport; issue?: RuntimeIssue } {
  const providedFields = groupReportFields(raw);
  if (!providedFields) {
    return {
      issue: buildInvalidItemIssue(
        group.id,
        "observation-group-shape",
        `Invalid grouped observation result in ${reportKind}: ${group.id}`,
      ),
    };
  }

  const fields: ObservationGroupReport["fields"] = {};
  const fieldIssue = collectGroupFields(
    group,
    providedFields,
    reportKind,
    fields,
  );
  if (fieldIssue) return { issue: fieldIssue };
  return { report: { fields } };
}

function groupReportFields(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fields = (raw as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return undefined;
  }
  return fields as Record<string, unknown>;
}

/**
 * Validates every field of a group into `fields`, returning the first fault as
 * an `invalid-item` issue (which rejects the whole group) or `undefined` on
 * success.
 */
function collectGroupFields(
  group: ObservationGroupBrief,
  providedFields: Record<string, unknown>,
  reportKind: string,
  fields: ObservationGroupReport["fields"],
): RuntimeIssue | undefined {
  for (const field of group.fields) {
    const raw = providedFields[field.cell];
    if (raw === undefined) {
      return buildInvalidItemIssue(
        group.id,
        "observation-group-incomplete",
        `Grouped observation in ${reportKind} omits field ${field.cell}`,
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return buildInvalidItemIssue(
        group.id,
        "observation-group-shape",
        `Invalid field ${field.cell} in grouped observation in ${reportKind}`,
      );
    }
    const report = raw as { status?: unknown; value?: unknown };
    if (
      report.status !== "resolved" &&
      report.status !== "unknown" &&
      report.status !== "needs-user"
    ) {
      return buildInvalidItemIssue(
        group.id,
        "observation-status",
        `Invalid status for field ${field.cell} in ${reportKind}: ${String(report.status)}`,
      );
    }
    if (report.status === "needs-user" && group.mode !== "observeOrAsk") {
      return buildInvalidItemIssue(
        group.id,
        "observation-needs-user",
        `Field ${field.cell} in ${reportKind} cannot use needs-user`,
      );
    }
    if (report.status === "resolved") {
      const fault = observationValueFault(field.meta, report.value);
      if (fault) {
        return buildInvalidItemIssue(
          group.id,
          fault.code,
          `Invalid value for field ${field.cell} in ${reportKind}: ${fault.detail}`,
        );
      }
      fields[field.cell] = {
        status: "resolved",
        value: cloneWithCanonicalNumbers(
          report.value as PrimitiveValue | PrimitiveArrayValue,
        ),
      };
      continue;
    }
    fields[field.cell] = { status: report.status };
  }
  return undefined;
}
