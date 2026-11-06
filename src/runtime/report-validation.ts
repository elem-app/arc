import { admitValue, resolveHostOperation } from "../spec/resolution.js";
import type {
  ActionPoisonReason,
  ActionReport,
  ArrayObservationMeta,
  HostCallBrief,
  HostCallReport,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupReport,
  ObservationMeta,
  ObservationReport,
  RuntimeIssue,
  ScalarObservationMeta,
  StructObservationMeta,
  TriggerReport,
  UnionObservationMeta,
} from "../types/host-interaction.js";
import type { SourceRange } from "../types/ir.js";
import type { ArcRef, NodeRef } from "../types/runtime.js";
import {
  isUnionMemberSpec,
  type HostModuleSpec,
  type ScalarSpec,
} from "../types/spec.js";
import {
  clonePayloadValue,
  cloneWithCanonicalNumbers,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
  isPlainRecord,
  type ObservedValue,
  type PayloadValue,
} from "../types/value.js";

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
  const admission = admitObservationOutcome(
    observation.meta,
    raw,
    observation.mode,
    observation.cell,
  );
  if ("fault" in admission) {
    return {
      issue: buildInvalidItemIssue(
        observation.id,
        admission.fault.code,
        `Invalid observation result in ${reportKind} for ${admission.fault.position}: ${admission.fault.detail}`,
      ),
    };
  }
  return { report: admission.report };
}

/** First fault found while admitting one observation outcome. */
type OutcomeFault = { code: string; detail: string; position: string };

/**
 * Validates one reported outcome against the observed position's metadata and
 * returns its canonical, privately owned form. A resolved value is validated
 * whole, so an invalid element or field rejects the whole outcome.
 */
export function admitObservationOutcome(
  meta: ObservationMeta,
  raw: unknown,
  mode: ObservationBrief["mode"],
  position: string,
): { report: ObservationReport } | { fault: OutcomeFault } {
  if (!isPlainRecord(raw)) {
    return outcomeFault("observation-shape", "expected an outcome", position);
  }
  switch (raw.status) {
    case "resolved": {
      const fault = observationValueFault(meta, raw.value);
      if (fault) return { fault: { ...fault, position } };
      // `observationValueFault` admitted the value under `meta`.
      const value = raw.value as ObservedValue;
      return {
        report: { status: "resolved", value: cloneWithCanonicalNumbers(value) },
      };
    }
    case "unknown":
      return { report: { status: "unknown" } };
    case "needs-user":
      return mode === "observeOrAsk"
        ? { report: { status: "needs-user" } }
        : outcomeFault(
            "observation-needs-user",
            "needs-user is valid only for $observeOrAsk()",
            position,
          );
    default:
      return outcomeFault(
        "observation-status",
        `invalid status ${String(raw.status)}`,
        position,
      );
  }
}

function outcomeFault(
  code: string,
  detail: string,
  position: string,
): { fault: OutcomeFault } {
  return { fault: { code, detail, position } };
}

/**
 * Checks a reported value against a position's observation metadata, shared by
 * the single and grouped observation validators. Returns the fault's reason
 * code and a human-readable detail, or `undefined` when the value is valid.
 */
function observationValueFault(
  meta: ObservationMeta,
  value: unknown,
): { code: string; detail: string } | undefined {
  switch (meta.type) {
    case "union": {
      const metaFault = unionObservationMetaFault(meta);
      if (metaFault) return metaFault;
      for (const member of meta.members) {
        if (!observationValueFault(member, value)) return undefined;
      }
      const sameCarrier = meta.members.filter(
        (member) => typeof value === scalarObservationCarrier(member),
      );
      return sameCarrier.length === 1
        ? observationValueFault(sameCarrier[0]!, value)
        : {
            code: "observation-type",
            detail: "value does not satisfy any Union observation member",
          };
    }
    case "struct":
      return structObservationValueFault(meta, value);
    case "array":
      return arrayObservationValueFault(meta, value);
    default:
      return scalarObservationValueFault(meta, value);
  }
}

/**
 * A resolved list must be an array whose every element is a complete value of
 * the element shape. Every element is checked before the observation can write
 * any part of the list.
 */
function arrayObservationValueFault(
  meta: ArrayObservationMeta,
  value: unknown,
): { code: string; detail: string } | undefined {
  if (meta.element.type !== "struct") {
    const metaFault =
      meta.element.type === "union"
        ? unionObservationMetaFault(meta.element)
        : scalarObservationMetaFault(meta.element);
    if (metaFault) return metaFault;
  }
  if (!Array.isArray(value)) {
    return { code: "observation-type", detail: "expected an array" };
  }
  for (const [index, entry] of value.entries()) {
    const fault = observationValueFault(meta.element, entry);
    if (fault)
      return { code: fault.code, detail: `[${index}]: ${fault.detail}` };
  }
  return undefined;
}

function scalarObservationCarrier(meta: ScalarObservationMeta): string {
  switch (meta.type) {
    case "enum":
      return "string";
    case "rangedInt":
      return "number";
    default:
      return meta.type;
  }
}

/** Validates every scalar alternative, including when observing an empty list. */
function unionObservationMetaFault(
  meta: UnionObservationMeta,
): { code: string; detail: string } | undefined {
  if (!Array.isArray(meta.members) || meta.members.length < 2) {
    return {
      code: "observation-type",
      detail: "Union metadata requires at least two members",
    };
  }
  for (const member of meta.members) {
    if (
      !member ||
      (!isUnionMemberSpec(member) && member.type !== "rangedInt")
    ) {
      return {
        code: "observation-type",
        detail: "Union observation members must be scalar",
      };
    }
    const fault = scalarObservationMetaFault(member);
    if (fault) return fault;
  }
  return undefined;
}

function scalarObservationValueFault(
  meta: ScalarObservationMeta,
  value: unknown,
): { code: string; detail: string } | undefined {
  const metaFault = scalarObservationMetaFault(meta);
  if (metaFault) return metaFault;
  const admission = admitValue(scalarObservationSpec(meta), value);
  if (!admission.admitted) {
    return scalarAdmissionFault(meta, admission.violation.code);
  }
  return scalarObservationConstraintFault(meta, value);
}

/**
 * A resolved struct value must be a plain data record carrying every declared
 * field with a valid concrete value. An incomplete record, including `{}` for
 * a nonempty struct, never stands in for unknown.
 */
function structObservationValueFault(
  meta: StructObservationMeta,
  value: unknown,
): { code: string; detail: string } | undefined {
  if (!isPlainRecord(value) || firstInvalidPayloadValue(value) !== undefined) {
    return { code: "observation-type", detail: "expected a Struct value" };
  }
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(meta.fields, name)) {
      return {
        code: "observation-type",
        detail: `undeclared Struct field ${JSON.stringify(name)}`,
      };
    }
  }
  for (const [name, field] of Object.entries(meta.fields)) {
    if (!Object.hasOwn(value, name)) {
      return {
        code: "observation-incomplete",
        detail: `Struct value omits field ${JSON.stringify(name)}`,
      };
    }
    const fault = observationValueFault(field.meta, value[name]);
    if (fault) {
      return { code: fault.code, detail: `${name}: ${fault.detail}` };
    }
  }
  return undefined;
}

function scalarObservationSpec(meta: ScalarObservationMeta): ScalarSpec {
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

function scalarAdmissionFault(
  scalar: ScalarObservationMeta,
  code: string,
): { code: string; detail: string } {
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
 * member in its brief and no other; a report that omits a member, names an
 * undeclared one, or is not a well-formed fields object is rejected whole as an
 * `invalid-item` so the group writes nothing and re-emits. Each member outcome
 * is admitted by {@link admitObservationOutcome}.
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
  const members = new Set(group.fields.map((field) => field.cell));
  for (const key of Object.keys(providedFields)) {
    if (!members.has(key)) {
      return {
        issue: buildInvalidItemIssue(
          group.id,
          "observation-group-shape",
          `Grouped observation in ${reportKind} names undeclared member ${key}`,
        ),
      };
    }
  }

  const fields: ObservationGroupReport["fields"] = {};
  for (const field of group.fields) {
    const memberRaw = providedFields[field.cell];
    if (memberRaw === undefined) {
      return {
        issue: buildInvalidItemIssue(
          group.id,
          "observation-group-incomplete",
          `Grouped observation in ${reportKind} omits field ${field.cell}`,
        ),
      };
    }
    const admission = admitObservationOutcome(
      field.meta,
      memberRaw,
      group.mode,
      field.cell,
    );
    if ("fault" in admission) {
      return {
        issue: buildInvalidItemIssue(
          group.id,
          admission.fault.code === "observation-shape"
            ? "observation-group-shape"
            : admission.fault.code,
          `Invalid grouped observation result in ${reportKind} for ${admission.fault.position}: ${admission.fault.detail}`,
        ),
      };
    }
    fields[field.cell] = admission.report;
  }
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
