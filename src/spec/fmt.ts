import type { FmtConfig } from "../types/ir.js";
import type { CellSpec, ChannelSpec } from "../types/spec.js";
import {
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
  isPlainRecord,
  pathOfArtifactValue,
  type ArtifactValue,
  type PrimitiveValue,
} from "../types/value.js";
import type {
  Admission,
  CoherenceJudgment,
  OperationAdmission,
  ProducerEvidence,
  SourceFact,
} from "./resolution.js";

type FmtIssue = { path: string; detail: string };
const at = (path: string, key: string) => `${path}[${JSON.stringify(key)}]`;

/** Checks the exact static configuration without evaluating any properties. */
export function validateFmtConfig(
  value: unknown,
  path = "$",
): FmtIssue | undefined {
  const record = (
    input: unknown,
    keys: readonly string[],
    here: string,
  ): FmtIssue | undefined => {
    if (!isPlainRecord(input))
      return {
        path: here,
        detail: "Expected a fmt configuration object",
      };
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !keys.includes(key))
        return {
          path: typeof key === "string" ? at(here, key) : here,
          detail: "Unknown fmt setting",
        };
      const property = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in property) || !property.enumerable)
        return {
          path: at(here, key),
          detail: "Fmt settings must be enumerable data properties",
        };
    }
    return undefined;
  };
  const root = record(value, ["array", "struct", "str"], path);
  if (root) return root;
  const config = value as Record<string, unknown>;
  if (
    Object.hasOwn(config, "str") &&
    config.str !== "bare" &&
    config.str !== "json"
  )
    return { path: at(path, "str"), detail: 'Expected "bare" or "json"' };
  if (Object.hasOwn(config, "struct")) {
    const here = at(path, "struct");
    const issue = record(config.struct, ["style"], here);
    if (issue) return issue;
    const struct = config.struct as Record<string, unknown>;
    if (Object.hasOwn(struct, "style") && struct.style !== "json")
      return { path: at(here, "style"), detail: 'Expected "json"' };
  }
  if (Object.hasOwn(config, "array")) {
    const here = at(path, "array");
    const issue = record(
      config.array,
      ["style", "separator", "parentheses"],
      here,
    );
    if (issue) return issue;
    const array = config.array as Record<string, unknown>;
    if (Object.hasOwn(array, "style")) {
      if (array.style !== "json")
        return { path: at(here, "style"), detail: 'Expected "json"' };
      for (const key of ["separator", "parentheses"])
        if (Object.hasOwn(array, key))
          return {
            path: at(here, key),
            detail: "JSON array style cannot include layout settings",
          };
    }
    if (
      Object.hasOwn(array, "separator") &&
      typeof array.separator !== "string"
    )
      return {
        path: at(here, "separator"),
        detail: "Expected a string separator",
      };
    if (
      Object.hasOwn(array, "parentheses") &&
      !["", "[]", "()", "{}"].includes(array.parentheses as string)
    )
      return {
        path: at(here, "parentheses"),
        detail: "Expected empty, square, round, or curly delimiters",
      };
  }
  return undefined;
}

/** Expands defaults in a stable order and returns an independent config. */
export function normalizeFmtConfig(config: FmtConfig): FmtConfig {
  return {
    array:
      config.array?.style === "json"
        ? { style: "json" }
        : {
            separator: config.array?.separator ?? ", ",
            parentheses: config.array?.parentheses ?? "",
          },
    struct: { style: "json" },
    str: config.str ?? "bare",
  };
}

type Shape =
  | { kind: "scalar"; spec: CellSpec | ChannelSpec; literal?: PrimitiveValue }
  | { kind: "artifact" }
  | { kind: "list"; element: Shape }
  | { kind: "array"; elements: Shape[] }
  | { kind: "struct"; fields?: Record<string, Shape> }
  | { kind: "alternatives"; alternatives: Shape[] }
  | { kind: "dynamic" }
  | { kind: "unusable" };

function specShape(spec: CellSpec | ChannelSpec): Shape {
  switch (spec.type) {
    case "union":
      return {
        kind: "alternatives",
        alternatives: spec.members.map(specShape),
      };
    case "dialogCursor":
      return { kind: "unusable" };
    case "artifact":
      return { kind: "artifact" };
    case "array":
      return { kind: "list", element: specShape(spec.element) };
    case "struct":
      return {
        kind: "struct",
        fields: Object.fromEntries(
          Object.entries(spec.fields).map(([key, field]) => [
            key,
            specShape(field),
          ]),
        ),
      };
    default:
      return { kind: "scalar", spec };
  }
}

function factShape(fact: SourceFact): Shape {
  switch (fact.kind) {
    case "site":
      return specShape(fact.spec);
    case "carrier":
      return { kind: "scalar", spec: { type: fact.carrier } };
    case "literal":
      return {
        kind: "scalar",
        spec: { type: typeof fact.value as "string" | "number" | "boolean" },
        literal: fact.value,
      };
    case "provenance":
      return fact.provenance === "artifact"
        ? { kind: "artifact" }
        : fact.provenance === "index"
          ? { kind: "scalar", spec: { type: "index" } }
          : { kind: "unusable" };
    case "array":
      return { kind: "array", elements: fact.elements.map(factShape) };
    case "empty-array":
      return { kind: "array", elements: [] };
  }
}

function evidenceShape(evidence: ProducerEvidence): Shape {
  switch (evidence.kind) {
    case "fact":
      return factShape(evidence.fact);
    case "alternatives":
      return {
        kind: "alternatives",
        alternatives: evidence.alternatives.map(evidenceShape),
      };
    case "array":
      return { kind: "array", elements: evidence.elements.map(evidenceShape) };
    case "struct":
      return {
        kind: "struct",
        fields:
          evidence.fields &&
          Object.fromEntries(
            Object.entries(evidence.fields).map(([key, field]) => [
              key,
              evidenceShape(field),
            ]),
          ),
      };
    default:
      return evidence;
  }
}

function judgeShape(shape: Shape): CoherenceJudgment {
  if (shape.kind === "unusable") return { kind: "incompatible" };
  if (shape.kind === "dynamic" || (shape.kind === "struct" && !shape.fields))
    return { kind: "unknown" };
  const children =
    shape.kind === "alternatives"
      ? shape.alternatives
      : shape.kind === "array"
        ? shape.elements
        : shape.kind === "list"
          ? [shape.element]
          : shape.kind === "struct"
            ? Object.values(shape.fields!)
            : [];
  const judgments = children.map(judgeShape);
  if (judgments.some((j) => j.kind === "incompatible"))
    return { kind: "incompatible" };
  if (judgments.some((j) => j.kind === "unknown")) return { kind: "unknown" };
  return { kind: "compatible" };
}

/** Judges supported formatting operands. */
export function checkFmtEvidence(
  evidence: ProducerEvidence,
): CoherenceJudgment {
  return judgeShape(evidenceShape(evidence));
}

type Data = PrimitiveValue | Data[] | { [key: string]: Data };

/** Encodes admitted data without invoking inherited JSON conversion hooks. */
function encodeJson(data: Data): string {
  if (Array.isArray(data)) return `[${data.map(encodeJson).join(",")}]`;
  if (typeof data === "object")
    return `{${Object.keys(data)
      .map((key) => `${JSON.stringify(key)}:${encodeJson(data[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(data);
}
type Admit = (
  spec: CellSpec | ChannelSpec,
  value: unknown,
  path?: string,
) => Admission;
type Projection =
  | { admitted: true; value: Data }
  | { admitted: false; violation: { code: string; detail: string } };
const fail = (
  detail: string,
  path: string,
): Extract<Projection, { admitted: false }> => ({
  admitted: false,
  violation: {
    code: "invalid-fmt-value",
    detail: `${detail} at ${path}`,
  },
});

function project(
  shape: Shape,
  value: Data,
  path: string,
  admit: Admit,
): Projection {
  if (shape.kind === "unusable")
    return fail("Unsupported formatting authority", path);
  if (shape.kind === "alternatives") {
    const projections = shape.alternatives.map((child) =>
      project(child, value, path, admit),
    );
    const valid = projections.filter((p) => p.admitted);
    if (valid.length === 0)
      return fail("Value does not satisfy a formatting alternative", path);
    const first = valid[0]!.value;
    if (valid.some((p) => encodeJson(p.value) !== encodeJson(first)))
      return fail("Ambiguous formatting authority", path);
    return { admitted: true, value: first };
  }
  if (shape.kind === "scalar") {
    const admission = admit(shape.spec, value, path);
    return admission.admitted &&
      (shape.literal === undefined || shape.literal === value)
      ? { admitted: true, value }
      : fail(
          admission.admitted
            ? "Value differs from its literal evidence"
            : admission.violation.detail,
          path,
        );
  }
  if (shape.kind === "artifact") {
    const admission = admit({ type: "artifact" }, value, path);
    return admission.admitted
      ? {
          admitted: true,
          value: pathOfArtifactValue(value as ArtifactValue),
        }
      : fail(admission.violation.detail, path);
  }
  if (shape.kind === "array" || shape.kind === "list") {
    if (
      !Array.isArray(value) ||
      (shape.kind === "array" && value.length !== shape.elements.length)
    )
      return fail("Array does not satisfy its formatting evidence", path);
    const values: Data[] = [];
    for (let i = 0; i < value.length; i++) {
      const child = project(
        shape.kind === "list" ? shape.element : shape.elements[i]!,
        value[i]!,
        `${path}[${i}]`,
        admit,
      );
      if (!child.admitted) return child;
      values.push(child.value);
    }
    return { admitted: true, value: values };
  }
  if (shape.kind === "struct") {
    if (!isPlainRecord(value)) return fail("Expected a Struct record", path);
    if (!shape.fields) return { admitted: true, value };
    const keys = Object.keys(value);
    for (const key of keys) {
      if (!Object.hasOwn(shape.fields, key))
        return fail("Undeclared Struct field", at(path, key));
    }
    for (const key of Object.keys(shape.fields)) {
      if (!Object.hasOwn(value, key))
        return fail("Missing Struct field", at(path, key));
    }
    const entries: [string, Data][] = [];
    for (const key of keys) {
      const child = project(
        shape.fields[key]!,
        value[key] as Data,
        at(path, key),
        admit,
      );
      if (!child.admitted) return child;
      entries.push([key, child.value]);
    }
    return { admitted: true, value: Object.fromEntries(entries) };
  }
  return { admitted: true, value };
}

// TODO: Revisit record-order observability if rewalk is stabilized.
// Formatting preserves Object.keys order, while write-diff ignores record
// key order, including in nested records. An order-only write can change
// newly formatted text without triggering a rewalk of earlier decisions
// that depended on formatted text. This may be undesirable for rewalk;
// leave write-diff unchanged while rewalk is default-off and unstable.
export function fmtValue(
  evidence: ProducerEvidence,
  value: unknown,
  config: FmtConfig,
  admit: Admit,
): OperationAdmission<string> {
  if (value === undefined)
    return {
      admitted: false,
      violation: {
        code: "unset-value",
        detail: "Formatting requires a set value",
      },
    };
  const issue = firstInvalidPayloadValue(value);
  if (issue) return fail(issue.detail, issue.path);
  const nonFinite = firstNonFiniteNumberPath(value);
  if (nonFinite !== undefined)
    return {
      admitted: false,
      violation: {
        code: "non-finite-number",
        detail: `Numeric value must be finite before formatting${nonFinite === "$" ? "" : ` at ${nonFinite}`}`,
      },
    };
  const projected = project(evidenceShape(evidence), value as Data, "$", admit);
  if (!projected.admitted) return projected;
  const options = normalizeFmtConfig(config);
  const render = (data: Data): string => {
    if (typeof data === "string")
      return options.str === "json" ? JSON.stringify(data) : data;
    if (Array.isArray(data)) {
      if (options.array?.style === "json") return encodeJson(data);
      const delimiters = options.array?.parentheses ?? "";
      return (
        (delimiters[0] ?? "") +
        data.map(render).join(options.array?.separator) +
        (delimiters[1] ?? "")
      );
    }
    if (typeof data === "object") return encodeJson(data);
    return String(data);
  };
  return { admitted: true, value: render(projected.value) };
}
