import type {
  ArrayReference,
  Cell,
  ChannelNamespace,
  ComparisonOperator,
  FieldReceiver,
  FmtConfig,
  HostCall,
  HostCallArgument,
  NodeSignature,
  SemanticString,
  ValueExpression,
} from "../types/ir.js";
import { getChannelSpec } from "../types/ir.js";
import {
  cellSpecToChannelSpec,
  fieldSpecAt,
  fieldSpecOf,
  type ArrayElementSpec,
  type CellSpec,
  type ChannelSpec,
  type HostModuleSpec,
  type HostNamespaceSpec,
  type HostOperationSpec,
  type HostParameterValueSpec,
  type StructSpec,
  type UnionSpec,
} from "../types/spec.js";
import {
  classifyArtifactPath,
  classifyArtifactValue,
  describeArtifactPathIssue,
  describeArtifactValueIssue,
  firstInvalidPayloadValue,
  firstNonFiniteNumberPath,
  isArtifactValue,
  isDialogCursorValue,
  isPlainRecord,
  isPrimitiveArrayValue,
  isPrimitiveValue,
  isRenderedSemanticText,
  pathOfArtifactValue,
  type CellValue,
  type PayloadValue,
  type PrimitiveValue,
} from "../types/value.js";
import { checkFmtEvidence, fmtValue } from "./fmt.js";
import { hostParameterValueSpec } from "./host-parameters.js";

type HostActionPath = {
  module: string;
  target: readonly string[];
  operation: string;
};

export type HostOperationResolution =
  | { kind: "resolved"; operation: HostOperationSpec }
  | {
      kind: "unresolved";
      reason: "module" | "member" | "namespace";
      segment?: string;
    };

/** Resolves one host action through an immutable injected module tree. */
export function resolveHostOperation(
  modules: ReadonlyMap<string, HostModuleSpec>,
  action: HostActionPath,
): HostOperationResolution {
  let current: HostNamespaceSpec | HostOperationSpec | undefined = modules.get(
    action.module,
  );
  if (!current) return { kind: "unresolved", reason: "module" };
  for (const segment of [...action.target, action.operation]) {
    if (current.kind !== "namespace") {
      return { kind: "unresolved", reason: "namespace", segment };
    }
    current = current.members[segment];
    if (!current) {
      return { kind: "unresolved", reason: "member", segment };
    }
  }
  return current.kind === "operation"
    ? { kind: "resolved", operation: current }
    : { kind: "unresolved", reason: "namespace" };
}

/** Concrete value violation under a selected spec guarantee. */
export type AdmissionViolation = {
  code:
    | "unset"
    | "invalid-boolean"
    | "invalid-string"
    | "invalid-enum"
    | "invalid-number"
    | "non-finite-number"
    | "invalid-index"
    | "invalid-array"
    | "invalid-artifact"
    | "invalid-dialog-cursor"
    | "invalid-struct"
    | "invalid-union";
  detail: string;
  path: string;
};

/** Result of concrete value admission under a selected spec guarantee. */
export type Admission<T = CellValue> =
  | { admitted: true; value: T }
  | { admitted: false; violation: AdmissionViolation };

/** Admits one concrete value under a selected cell or channel guarantee. */
export function admitValue(
  spec: CellSpec | ChannelSpec,
  value: unknown,
  path = "$",
): Admission {
  if (value === undefined) {
    return violation("unset", "A set value is required", path);
  }
  switch (spec.type) {
    case "union": {
      for (const member of spec.members) {
        const result = admitValue(member, value, path);
        if (result.admitted) return result;
      }
      const sameCarrier = spec.members.filter(
        (member) =>
          typeof value === (member.type === "enum" ? "string" : member.type),
      );
      return sameCarrier.length === 1
        ? admitValue(sameCarrier[0]!, value, path)
        : violation("invalid-union", "Value must satisfy a Union member", path);
    }
    case "boolean":
      return typeof value === "boolean"
        ? admitted(value)
        : violation("invalid-boolean", "A boolean value is required", path);
    case "string":
      return typeof value === "string"
        ? admitted(value)
        : violation("invalid-string", "A string value is required", path);
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? admitted(value)
        : violation(
            "invalid-enum",
            `Expected one of ${spec.values.map((entry) => JSON.stringify(entry)).join(", ")}`,
            path,
          );
    case "number":
      if (typeof value !== "number") {
        return violation("invalid-number", "A numeric value is required", path);
      }
      return Number.isFinite(value)
        ? admitted(value)
        : violation("non-finite-number", "A finite number is required", path);
    case "index":
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? admitted(value)
        : violation(
            "invalid-index",
            "A non-negative safe integer is required",
            path,
          );
    case "array":
      if (!Array.isArray(value)) {
        return violation("invalid-array", "An array value is required", path);
      }
      for (const [index, element] of value.entries()) {
        const result = admitValue(spec.element, element, `${path}[${index}]`);
        if (!result.admitted) return result;
      }
      return admitted(value as CellValue);
    case "artifact": {
      const issue = classifyArtifactValue(value);
      return issue === undefined
        ? admitted(value as CellValue)
        : violation(
            "invalid-artifact",
            `Invalid Artifact value: ${describeArtifactValueIssue(issue)}`,
            path,
          );
    }
    case "dialogCursor":
      return isDialogCursorValue(value)
        ? admitted(value)
        : violation(
            "invalid-dialog-cursor",
            "A valid Dialog cursor is required",
            path,
          );
    case "struct":
      return admitStructValue(spec, value, path);
  }
}

/**
 * Admits one complete concrete struct value: a plain data record carrying
 * exactly the declared fields, each with an admitted concrete value.
 */
function admitStructValue(
  spec: StructSpec,
  value: unknown,
  path: string,
): Admission {
  const carrierIssue = firstInvalidPayloadValue(value, path);
  if (carrierIssue) {
    return violation("invalid-struct", carrierIssue.detail, carrierIssue.path);
  }
  if (!isPlainRecord(value)) {
    return violation("invalid-struct", "A Struct record is required", path);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(spec.fields, key)) {
      return violation(
        "invalid-struct",
        "Struct value contains an undeclared field",
        `${path}[${JSON.stringify(key)}]`,
      );
    }
  }
  const fields: Record<string, PayloadValue> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    const fieldPath = `${path}[${JSON.stringify(name)}]`;
    if (!Object.hasOwn(value, name)) {
      return violation(
        "invalid-struct",
        "Struct value is missing a declared field",
        fieldPath,
      );
    }
    const result = admitValue(field, value[name], fieldPath);
    if (!result.admitted) return result;
    fields[name] = result.value;
  }
  return admitted(fields);
}

function admitted(value: CellValue): Admission {
  return { admitted: true, value };
}

/** Resolves the first admitting scalar member in authored order. */
export function precedingSpec(
  spec: CellSpec | ChannelSpec,
  value: unknown,
): Exclude<ChannelSpec, { type: "union" }> | undefined {
  if (spec.type !== "union") return spec;
  for (const member of spec.members) {
    if (admitValue(member, value).admitted) return member;
  }
  return undefined;
}

function violation(
  code: AdmissionViolation["code"],
  detail: string,
  path: string,
): Admission {
  return { admitted: false, violation: { code, detail, path } };
}

/** IR-independent evidence established about one value producer. */
export type SourceFact =
  | { kind: "site"; spec: CellSpec | ChannelSpec }
  | { kind: "literal"; value: PrimitiveValue }
  | { kind: "carrier"; carrier: "boolean" | "string" | "number" }
  | { kind: "provenance"; provenance: "artifact" | "dialog-cursor" | "index" }
  | { kind: "array"; elements: readonly SourceFact[] }
  | { kind: "empty-array" };

/** Outcome of one spec rule; `unknown` means that rule cannot prove either side. */
export type CoherenceJudgment =
  | { kind: "compatible" }
  | { kind: "incompatible" }
  | { kind: "unknown" };

const COMPATIBLE = { kind: "compatible" } as const;
const INCOMPATIBLE = { kind: "incompatible" } as const;
const UNKNOWN = { kind: "unknown" } as const;

/** Judges one producer fact against one concrete landing guarantee. */
export function judgeOneTimeLanding(
  source: SourceFact | undefined,
  destination: CellSpec | ChannelSpec,
): CoherenceJudgment {
  if (!source) return UNKNOWN;
  if (
    destination.type === "union" &&
    source.kind !== "site" &&
    source.kind !== "literal"
  ) {
    const judgments = destination.members.map((member) =>
      judgeOneTimeLanding(source, member),
    );
    if (judgments.some((judgment) => judgment.kind === "compatible"))
      return COMPATIBLE;
    return judgments.every((judgment) => judgment.kind === "incompatible")
      ? INCOMPATIBLE
      : UNKNOWN;
  }
  switch (source.kind) {
    case "site":
      return judgeSpecLanding(source.spec, destination);
    case "literal":
      return admitValue(destination, source.value).admitted
        ? COMPATIBLE
        : INCOMPATIBLE;
    case "carrier":
      switch (source.carrier) {
        case "boolean":
          return destination.type === "boolean" ? COMPATIBLE : INCOMPATIBLE;
        case "string":
          if (destination.type === "string") return COMPATIBLE;
          return destination.type === "enum" ? UNKNOWN : INCOMPATIBLE;
        case "number":
          return destination.type === "number" || destination.type === "index"
            ? UNKNOWN
            : INCOMPATIBLE;
      }
    case "provenance":
      if (source.provenance === "index") {
        return destination.type === "index" || destination.type === "number"
          ? COMPATIBLE
          : INCOMPATIBLE;
      }
      return source.provenance === "artifact"
        ? destination.type === "artifact"
          ? COMPATIBLE
          : INCOMPATIBLE
        : destination.type === "dialogCursor"
          ? COMPATIBLE
          : INCOMPATIBLE;
    case "array":
      if (destination.type !== "array") return INCOMPATIBLE;
      return reduceAlternativeJudgments(
        source.elements.map((element) =>
          judgeOneTimeLanding(element, destination.element),
        ),
      );
    case "empty-array":
      return destination.type === "array" ? COMPATIBLE : INCOMPATIBLE;
  }
}

/** Reduces one-time judgments for all reachable conditional alternatives. */
export function reduceAlternativeJudgments(
  judgments: readonly CoherenceJudgment[],
): CoherenceJudgment {
  if (judgments.some((judgment) => judgment.kind === "incompatible")) {
    return INCOMPATIBLE;
  }
  if (judgments.some((judgment) => judgment.kind === "unknown")) return UNKNOWN;
  return COMPATIBLE;
}

/** Reduces the judgments of one union's members; disagreement defers to the value. */
function reduceUnionJudgments(
  judgments: readonly CoherenceJudgment[],
): CoherenceJudgment {
  if (judgments.every((judgment) => judgment.kind === "compatible"))
    return COMPATIBLE;
  if (judgments.every((judgment) => judgment.kind === "incompatible"))
    return INCOMPATIBLE;
  return UNKNOWN;
}

function reduceOverUnion(
  union: UnionSpec,
  judge: (member: ProducerEvidence) => CoherenceJudgment,
): CoherenceJudgment {
  return reduceUnionJudgments(
    union.members.map((spec) => judge(resolvedFact({ kind: "site", spec }))),
  );
}

/** Whether every provider value is admitted by the receiver guarantee. */
export function reusableSpecCompatible(
  provider: CellSpec | ChannelSpec,
  receiver: CellSpec | ChannelSpec,
): boolean {
  if (provider.type === "union")
    return provider.members.every((member) =>
      reusableSpecCompatible(member, receiver),
    );
  if (receiver.type === "union") {
    if (provider.type === "enum")
      return provider.values.every(
        (value) => admitValue(receiver, value).admitted,
      );
    return receiver.members.some((member) =>
      reusableSpecCompatible(provider, member),
    );
  }
  if (provider.type === "index" && receiver.type === "number") return true;
  if (provider.type === "enum" && receiver.type === "string") return true;
  if (provider.type !== receiver.type) return false;
  if (provider.type === "enum" && receiver.type === "enum") {
    return provider.values.every((value) => receiver.values.includes(value));
  }
  if (provider.type === "array" && receiver.type === "array") {
    return reusableSpecCompatible(provider.element, receiver.element);
  }
  if (provider.type === "struct" && receiver.type === "struct") {
    return (
      sameFieldNames(provider.fields, receiver.fields) &&
      Object.entries(provider.fields).every(([name, field]) =>
        reusableSpecCompatible(field, receiver.fields[name]!),
      )
    );
  }
  return true;
}

/** Checks a binding with the provider/receiver direction of its namespace. */
export function channelBindingCompatible(
  namespace: ChannelNamespace,
  callerSpec: ChannelSpec,
  targetSpec: ChannelSpec,
): boolean {
  return namespace === "args"
    ? reusableSpecCompatible(callerSpec, targetSpec)
    : reusableSpecCompatible(targetSpec, callerSpec);
}

function sameFieldNames(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftNames = Object.keys(left);
  return (
    leftNames.length === Object.keys(right).length &&
    leftNames.every((name) => Object.hasOwn(right, name))
  );
}

function judgeSpecLanding(
  source: CellSpec | ChannelSpec,
  destination: CellSpec | ChannelSpec,
): CoherenceJudgment {
  if (reusableSpecCompatible(source, destination)) return COMPATIBLE;
  if (source.type === "union")
    return reduceUnionJudgments(
      source.members.map((member) => judgeSpecLanding(member, destination)),
    );
  if (destination.type === "union") {
    return destination.members.every(
      (member) => judgeSpecLanding(source, member).kind === "incompatible",
    )
      ? INCOMPATIBLE
      : UNKNOWN;
  }
  if (source.type === "number" && destination.type === "index") return UNKNOWN;
  if (source.type === "string" && destination.type === "enum") return UNKNOWN;
  if (source.type === "enum" && destination.type === "enum") {
    return source.values.some((value) => destination.values.includes(value))
      ? UNKNOWN
      : INCOMPATIBLE;
  }
  if (source.type === "array" && destination.type === "array") {
    return judgeSpecLanding(source.element, destination.element);
  }
  if (source.type === "struct" && destination.type === "struct") {
    if (!sameFieldNames(source.fields, destination.fields)) return INCOMPATIBLE;
    return reduceAlternativeJudgments(
      Object.entries(source.fields).map(([name, field]) =>
        judgeSpecLanding(field, destination.fields[name]!),
      ),
    );
  }
  return INCOMPATIBLE;
}

export type ProducerContext = {
  cells: readonly Cell[];
  /** Runtime contexts may resolve lexical ownership without materializing it. */
  resolveCell?: (name: string) => Cell | undefined;
  signature?: NodeSignature;
  map?: {
    receiverSpec?: ArrayElementSpec;
    resultSpec?: ArrayElementSpec;
  };
  resolveHostOperation?: (call: HostCall) => HostOperationSpec | undefined;
};

/**
 * Facts derived from an expression producer without accompanying its value.
 * `struct` describes an authored object; `fields` is present when each named
 * field has its own producer evidence.
 */
export type ProducerEvidence =
  | { kind: "fact"; fact: SourceFact }
  | { kind: "alternatives"; alternatives: ProducerEvidence[] }
  | { kind: "array"; elements: ProducerEvidence[] }
  | { kind: "struct"; fields?: Record<string, ProducerEvidence> }
  | { kind: "dynamic" }
  | { kind: "unusable" };

/** Derives provenance and carrier facts from the original expression IR. */
export function resolveProducer(
  expression: ValueExpression,
  context: ProducerContext,
): ProducerEvidence {
  switch (expression.kind) {
    case "literal":
      return expression.value === null
        ? { kind: "unusable" }
        : { kind: "fact", fact: { kind: "literal", value: expression.value } };
    case "cell": {
      const cell = findCell(context, expression.name);
      return cell
        ? {
            kind: "fact",
            fact: { kind: "site", spec: cellSpecToChannelSpec(cell) },
          }
        : { kind: "dynamic" };
    }
    case "channel": {
      const spec = getChannelSpec(
        context.signature,
        expression.namespace,
        expression.key,
      );
      return spec
        ? { kind: "fact", fact: { kind: "site", spec } }
        : { kind: "dynamic" };
    }
    case "field": {
      const spec = resolveReferenceSpec(expression, context);
      return spec
        ? { kind: "fact", fact: { kind: "site", spec } }
        : { kind: "dynamic" };
    }
    case "arrayElementRead": {
      const spec = resolveArrayElementSpec(expression.array, context);
      return spec
        ? { kind: "fact", fact: { kind: "site", spec } }
        : { kind: "dynamic" };
    }
    case "structLiteral":
      return {
        kind: "struct",
        fields: Object.fromEntries(
          Object.entries(expression.fields).map(([name, field]) => [
            name,
            resolveProducer(field, context),
          ]),
        ),
      };
    case "span":
      if (expression.key === "index") {
        return {
          kind: "fact",
          fact: { kind: "provenance", provenance: "index" },
        };
      }
      return context.map?.receiverSpec
        ? {
            kind: "fact",
            fact: { kind: "site", spec: context.map.receiverSpec },
          }
        : { kind: "dynamic" };
    case "dialogCursor":
      return {
        kind: "fact",
        fact: { kind: "provenance", provenance: "dialog-cursor" },
      };
    case "artifact":
      return resolvedFact(artifactPathRule.result);
    case "arrayLength":
      return {
        kind: "fact",
        fact: { kind: "provenance", provenance: "index" },
      };
    case "template-string":
      return resolvedFact(interpolationRule.result);
    case "fmt":
      return resolvedFact(fmtRule.result);
    case "scope":
    case "interruptionId":
    case "interruptionReason":
    case "pendingState":
    case "nodeState":
      return resolvedFact(stringOperandRule.result);
    case "dialogTurnsSince":
    case "enterCount":
    case "arithmetic":
    case "numericUnary":
      return resolvedFact(arithmeticRule.result);
    case "comparison":
      return resolvedFact(comparisonRule.result);
    case "logical":
    case "unary":
    case "regexTest":
    case "isUnset":
    case "channelIsUnset":
    case "deflectionEscaped":
    case "judge":
      return resolvedFact(booleanRule.result);
    case "numIsFinite":
      return resolvedFact(numIsFiniteRule.result);
    case "conditional":
      return {
        kind: "alternatives",
        alternatives: [
          resolveProducer(expression.consequent, context),
          resolveProducer(expression.alternate, context),
        ],
      };
    case "arrayLiteral":
      return expression.elements.length === 0
        ? { kind: "fact", fact: { kind: "empty-array" } }
        : {
            kind: "array",
            elements: expression.elements.map((element) =>
              resolveProducer(element, context),
            ),
          };
    case "host-call": {
      const operation = context.resolveHostOperation?.(expression);
      if (!operation) return { kind: "dynamic" };
      return operation.returns
        ? { kind: "fact", fact: { kind: "site", spec: operation.returns } }
        : { kind: "unusable" };
    }
  }
}

/** Derives carrier provenance for a structured host-call argument. */
export function resolveHostCallArgument(
  argument: HostCallArgument,
  context: ProducerContext,
): ProducerEvidence {
  switch (argument.kind) {
    case "semantic":
      return carrier("string");
    case "value":
      return resolveProducer(argument.value, context);
    case "array":
      return {
        kind: "array",
        elements: argument.elements.map((element) =>
          resolveHostCallArgument(element, context),
        ),
      };
    case "object":
      return { kind: "struct" };
  }
}

/** Applies one-time coherence to one authored host argument. */
export function judgeHostArgument(
  argument: HostCallArgument,
  destination: HostParameterValueSpec,
  context: ProducerContext,
): CoherenceJudgment {
  if (argument.kind === "object") {
    if (destination.type !== "struct") return INCOMPATIBLE;
    if (
      Object.keys(argument.value).some(
        (name) => !Object.hasOwn(destination.fields, name),
      ) ||
      Object.entries(destination.fields).some(
        ([name, field]) =>
          field.type !== "omittable" && !Object.hasOwn(argument.value, name),
      )
    )
      return INCOMPATIBLE;
    return reduceAlternativeJudgments(
      Object.entries(argument.value).map(([name, value]) =>
        judgeHostArgument(
          value,
          hostParameterValueSpec(destination.fields[name]!),
          context,
        ),
      ),
    );
  }
  if (argument.kind === "array") {
    if (destination.type === "tuple") {
      if (argument.elements.length !== destination.elements.length) {
        return { kind: "incompatible" };
      }
      return reduceAlternativeJudgments(
        argument.elements.map((element, index) =>
          judgeHostArgument(element, destination.elements[index]!, context),
        ),
      );
    }
    if (destination.type !== "array") return { kind: "incompatible" };
    return reduceAlternativeJudgments(
      argument.elements.map((element) =>
        judgeHostArgument(element, destination.element, context),
      ),
    );
  }
  if (argument.kind === "semantic") {
    if (destination.type === "semanticText") return { kind: "compatible" };
    if (
      destination.type !== "string" &&
      destination.type !== "enum" &&
      destination.type !== "union"
    ) {
      return { kind: "incompatible" };
    }
    return judgeSemanticArgument(argument.value, destination, context);
  }
  if (destination.type === "semanticText") {
    return stringOperandRule.checkProducer(argument.value, context);
  }
  if (destination.type === "struct") {
    return judgeHostStructValue(
      resolveProducer(argument.value, context),
      destination,
    );
  }
  const channelSpec = hostParameterChannelSpec(destination);
  return channelSpec
    ? judgeProducerLanding(
        resolveProducer(argument.value, context),
        channelSpec,
      )
    : { kind: "incompatible" };
}

/**
 * Judges a value producer landing on a host struct parameter. A complete Arc
 * struct supplies every field it declares, so each of its fields must be
 * declared by the parameter and every required parameter field must be
 * supplied.
 */
function judgeHostStructValue(
  evidence: ProducerEvidence,
  destination: Extract<HostParameterValueSpec, { type: "struct" }>,
): CoherenceJudgment {
  if (evidence.kind === "dynamic") return { kind: "unknown" };
  if (evidence.kind === "alternatives") {
    return reduceAlternativeJudgments(
      evidence.alternatives.map((alternative) =>
        judgeHostStructValue(alternative, destination),
      ),
    );
  }
  const fields: Record<string, ProducerEvidence> | undefined =
    evidence.kind === "struct"
      ? evidence.fields
      : evidence.kind === "fact" &&
          evidence.fact.kind === "site" &&
          evidence.fact.spec.type === "struct"
        ? Object.fromEntries(
            Object.entries(evidence.fact.spec.fields).map(([name, spec]) => [
              name,
              { kind: "fact", fact: { kind: "site", spec } },
            ]),
          )
        : undefined;
  if (!fields) return { kind: "incompatible" };
  if (
    Object.keys(fields).some(
      (name) => !Object.hasOwn(destination.fields, name),
    ) ||
    Object.entries(destination.fields).some(
      ([name, field]) =>
        field.type !== "omittable" && !Object.hasOwn(fields, name),
    )
  ) {
    return { kind: "incompatible" };
  }
  return reduceAlternativeJudgments(
    Object.entries(fields).map(([name, field]) => {
      const fieldSpec = hostParameterValueSpec(destination.fields[name]!);
      if (fieldSpec.type === "struct") {
        return judgeHostStructValue(field, fieldSpec);
      }
      const channelSpec = hostParameterChannelSpec(fieldSpec);
      return channelSpec
        ? judgeProducerLanding(field, channelSpec)
        : { kind: "incompatible" };
    }),
  );
}

/**
 * Admits a rendered complete struct value under a host struct parameter: a
 * plain record whose fields are declared, which supplies every required field,
 * and whose field values satisfy their parameter specs.
 */
function admitHostStructValue(
  rendered: unknown,
  destination: Extract<HostParameterValueSpec, { type: "struct" }>,
  path: string,
): HostArgumentAdmission {
  const shapeIssue = firstInvalidPayloadValue(rendered, path);
  if (shapeIssue)
    return hostArgumentViolation(shapeIssue.detail, shapeIssue.path);
  if (!isPlainRecord(rendered)) {
    return hostArgumentViolation(
      "A Struct host argument must be a plain object",
      path,
    );
  }
  for (const name of Object.keys(rendered)) {
    if (!Object.hasOwn(destination.fields, name)) {
      return hostArgumentViolation(
        "Unexpected Struct field",
        `${path}[${JSON.stringify(name)}]`,
      );
    }
  }
  for (const [name, field] of Object.entries(destination.fields)) {
    const fieldPath = `${path}[${JSON.stringify(name)}]`;
    if (!Object.hasOwn(rendered, name)) {
      if (field.type === "omittable") continue;
      return hostArgumentViolation(
        "Required Struct field is missing",
        fieldPath,
      );
    }
    const fieldSpec = hostParameterValueSpec(field);
    if (fieldSpec.type === "struct") {
      const nested = admitHostStructValue(rendered[name], fieldSpec, fieldPath);
      if (!nested.admitted) return nested;
      continue;
    }
    const channelSpec = hostParameterChannelSpec(fieldSpec);
    if (!channelSpec) {
      return hostArgumentViolation(
        "Host argument type is incompatible",
        fieldPath,
      );
    }
    const admission = admitValue(channelSpec, rendered[name], fieldPath);
    if (!admission.admitted) {
      return hostArgumentViolation(
        admission.violation.detail,
        admission.violation.path,
      );
    }
  }
  return { admitted: true };
}

export type HostArgumentAdmission =
  | { admitted: true }
  | {
      admitted: false;
      violation: {
        code: "invalid-host-argument";
        detail: string;
        path: string;
      };
    };

/** Admits one rendered host argument under its declared parameter spec. */
export function admitHostArgument(
  argument: HostCallArgument,
  rendered: PayloadValue,
  destination: HostParameterValueSpec,
  path = "$",
): HostArgumentAdmission {
  if (rendered === undefined) {
    return hostArgumentViolation("An unset host argument is not allowed", path);
  }
  if (argument.kind === "object") {
    if (destination.type !== "struct") {
      return hostArgumentViolation(
        "An authored object requires a Struct parameter",
        path,
      );
    }
    const shapeIssue = firstInvalidPayloadValue(rendered, path);
    if (shapeIssue)
      return hostArgumentViolation(shapeIssue.detail, shapeIssue.path);
    if (!rendered || typeof rendered !== "object" || Array.isArray(rendered)) {
      return hostArgumentViolation(
        "A Struct host argument must be a plain object",
        path,
      );
    }
    for (const [name, field] of Object.entries(destination.fields)) {
      if (field.type !== "omittable" && !Object.hasOwn(argument.value, name)) {
        return hostArgumentViolation(
          "Required Struct field is missing",
          `${path}[${JSON.stringify(name)}]`,
        );
      }
    }
    for (const name of Object.keys(rendered)) {
      if (
        !Object.hasOwn(argument.value, name) ||
        !Object.hasOwn(destination.fields, name)
      ) {
        return hostArgumentViolation(
          "Unexpected Struct field",
          `${path}[${JSON.stringify(name)}]`,
        );
      }
    }
    for (const [name, child] of Object.entries(argument.value)) {
      const fieldPath = `${path}[${JSON.stringify(name)}]`;
      if (!Object.hasOwn(destination.fields, name)) {
        return hostArgumentViolation("Undeclared Struct field", fieldPath);
      }
      if (!Object.hasOwn(rendered, name)) {
        return hostArgumentViolation(
          "Supplied Struct field is missing",
          fieldPath,
        );
      }
      const admission = admitHostArgument(
        child,
        rendered[name],
        hostParameterValueSpec(destination.fields[name]!),
        fieldPath,
      );
      if (!admission.admitted) return admission;
    }
    return { admitted: true };
  }
  if (argument.kind === "array") {
    if (!Array.isArray(rendered)) {
      return hostArgumentViolation("An array host argument is required", path);
    }
    if (destination.type === "tuple") {
      if (
        argument.elements.length !== destination.elements.length ||
        rendered.length !== destination.elements.length
      ) {
        return hostArgumentViolation(
          `Expected a tuple with ${destination.elements.length} elements`,
          path,
        );
      }
      for (let index = 0; index < destination.elements.length; index += 1) {
        const admission = admitHostArgument(
          argument.elements[index]!,
          rendered[index] as PayloadValue,
          destination.elements[index]!,
          `${path}[${index}]`,
        );
        if (!admission.admitted) return admission;
      }
      return { admitted: true };
    }
    if (
      destination.type !== "array" ||
      rendered.length !== argument.elements.length
    ) {
      return hostArgumentViolation("Host argument type is incompatible", path);
    }
    for (let index = 0; index < argument.elements.length; index += 1) {
      const admission = admitHostArgument(
        argument.elements[index]!,
        rendered[index] as PayloadValue,
        destination.element,
        `${path}[${index}]`,
      );
      if (!admission.admitted) return admission;
    }
    return { admitted: true };
  }
  if (destination.type === "semanticText") {
    return (argument.kind === "semantic" && isRenderedSemanticText(rendered)) ||
      typeof rendered === "string"
      ? { admitted: true }
      : hostArgumentViolation(
          "SemanticText requires an authored semantic argument or string value",
          path,
        );
  }
  if (destination.type === "struct") {
    return admitHostStructValue(rendered, destination, path);
  }
  const channelSpec = hostParameterChannelSpec(destination);
  if (!channelSpec) {
    return hostArgumentViolation("Host argument type is incompatible", path);
  }
  const admission = admitValue(channelSpec, rendered, path);
  return admission.admitted
    ? { admitted: true }
    : hostArgumentViolation(
        admission.violation.detail,
        admission.violation.path,
      );
}

/** Applies the generic one-time landing relation to producer evidence. */
export function judgeProducerLanding(
  evidence: ProducerEvidence,
  destination: ChannelSpec,
): CoherenceJudgment {
  switch (evidence.kind) {
    case "fact":
      return judgeOneTimeLanding(evidence.fact, destination);
    case "dynamic":
      return judgeOneTimeLanding(undefined, destination);
    case "unusable":
      return { kind: "incompatible" };
    case "struct":
      return judgeStructEvidenceLanding(evidence, destination);
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map((alternative) =>
          judgeProducerLanding(alternative, destination),
        ),
      );
    case "array":
      if (destination.type !== "array") return { kind: "incompatible" };
      return reduceAlternativeJudgments(
        evidence.elements.map((element) =>
          judgeProducerLanding(element, destination.element),
        ),
      );
  }
}

/**
 * Judges an authored object landing on a struct guarantee: the object must name
 * exactly the declared fields, and each field producer must land on its field.
 */
function judgeStructEvidenceLanding(
  evidence: Extract<ProducerEvidence, { kind: "struct" }>,
  destination: ChannelSpec,
): CoherenceJudgment {
  if (destination.type !== "struct" || !evidence.fields) {
    return { kind: "incompatible" };
  }
  const fields = evidence.fields;
  const names = Object.keys(fields);
  if (
    names.some((name) => !Object.hasOwn(destination.fields, name)) ||
    Object.keys(destination.fields).some((name) => !Object.hasOwn(fields, name))
  ) {
    return { kind: "incompatible" };
  }
  return reduceAlternativeJudgments(
    names.map((name) =>
      judgeProducerLanding(fields[name]!, destination.fields[name]!),
    ),
  );
}

export function producerGuaranteesArtifact(
  evidence: ProducerEvidence,
): boolean {
  switch (evidence.kind) {
    case "fact":
      return (
        (evidence.fact.kind === "provenance" &&
          evidence.fact.provenance === "artifact") ||
        (evidence.fact.kind === "site" &&
          evidence.fact.spec.type === "artifact")
      );
    case "alternatives":
      return (
        evidence.alternatives.length > 0 &&
        evidence.alternatives.every(producerGuaranteesArtifact)
      );
    default:
      return false;
  }
}

export const numIsFiniteRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return judgeNumericEvidence(resolveProducer(operand, context));
  },

  admitValue(value: unknown): Admission<number> {
    return typeof value === "number"
      ? { admitted: true, value }
      : {
          admitted: false,
          violation: {
            code: "invalid-number",
            detail: "A numeric value is required",
            path: "$",
          },
        };
  },

  result: { kind: "carrier", carrier: "boolean" } satisfies SourceFact,
};

export const arithmeticRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return judgeNumericEvidence(resolveProducer(operand, context));
  },

  admitValue: numIsFiniteRule.admitValue,

  result: { kind: "carrier", carrier: "number" } satisfies SourceFact,
};

export type OperationViolation = {
  code: string;
  detail: string;
};

export type OperationAdmission<T> =
  | { admitted: true; value: T }
  | { admitted: false; violation: OperationViolation };

export const booleanRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return judgeBooleanEvidence(resolveProducer(operand, context));
  },

  admitValue(value: unknown): OperationAdmission<boolean> {
    return typeof value === "boolean"
      ? operationAdmitted(value)
      : operationViolation("non-boolean-value", "A boolean value is required");
  },

  result: { kind: "carrier", carrier: "boolean" } satisfies SourceFact,
};

export const stringOperandRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return judgeStringEvidence(resolveProducer(operand, context));
  },

  admitValue(value: unknown): OperationAdmission<string> {
    return typeof value === "string"
      ? operationAdmitted(value)
      : operationViolation("invalid-string", "A string value is required");
  },

  result: { kind: "carrier", carrier: "string" } satisfies SourceFact,
};

export const artifactPathRule = {
  checkProducer: stringOperandRule.checkProducer,

  admitValue(value: unknown): OperationAdmission<string> {
    if (typeof value !== "string") {
      return operationViolation(
        "invalid-artifact-path",
        "Artifact path must be a string",
      );
    }
    const issue = classifyArtifactPath(value);
    return issue === undefined
      ? operationAdmitted(value)
      : operationViolation(
          "invalid-artifact-path",
          `Artifact ${describeArtifactPathIssue(issue)}`,
        );
  },

  result: {
    kind: "provenance",
    provenance: "artifact",
  } satisfies SourceFact,
};

export const fmtRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return checkFmtEvidence(resolveProducer(operand, context));
  },
  projectValue(
    evidence: ProducerEvidence,
    value: unknown,
    config: FmtConfig,
  ): OperationAdmission<string> {
    return fmtValue(evidence, value, config, admitValue);
  },
  result: { kind: "carrier", carrier: "string" } satisfies SourceFact,
};

export const interpolationRule = {
  checkProducer(
    operand: ValueExpression,
    context: ProducerContext,
  ): CoherenceJudgment {
    return judgeInterpolationEvidence(resolveProducer(operand, context));
  },

  projectValue(
    evidence: ProducerEvidence,
    value: unknown,
  ): OperationAdmission<string> {
    if (value === undefined) {
      return operationViolation(
        "invalid-template-interpolation",
        "Value template interpolation cannot use an unset value",
      );
    }
    if (producerGuaranteesArtifact(evidence)) {
      return isArtifactValue(value)
        ? operationAdmitted(pathOfArtifactValue(value))
        : operationViolation(
            "invalid-artifact-value",
            "Artifact interpolation requires a valid Artifact value",
          );
    }
    if (isPrimitiveValue(value)) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        return operationViolation(
          "non-finite-number",
          "Numeric value must be finite before value-template interpolation",
        );
      }
      return operationAdmitted(String(value));
    }
    if (isPrimitiveArrayValue(value)) {
      const nonFinitePath = firstNonFiniteNumberPath(value);
      if (nonFinitePath !== undefined) {
        return operationViolation(
          "non-finite-number",
          `Numeric value must be finite before value-template interpolation${
            nonFinitePath === "$" ? "" : ` at ${nonFinitePath}`
          }`,
        );
      }
      return operationAdmitted(String(value));
    }
    return operationViolation(
      "invalid-template-interpolation",
      "Value template interpolation cannot render this value",
    );
  },

  result: { kind: "carrier", carrier: "string" } satisfies SourceFact,
};

/** The ordering evaluation applies to admitted operands. */
export type SelectedOrdering = {
  judgment: CoherenceJudgment;
  mode: "enum" | "number" | "string" | "dynamic";
  enumValues?: readonly string[];
};

/** A selected ordering, or operands whose values decide the comparison. */
export type ComparisonDecision =
  | SelectedOrdering
  | {
      judgment: CoherenceJudgment;
      mode: "by-value";
      operands: { left: ProducerEvidence; right: ProducerEvidence };
    };

export const comparisonRule = {
  checkProducers(
    op: ComparisonOperator,
    left: ValueExpression,
    right: ValueExpression,
    context: ProducerContext,
  ): ComparisonDecision {
    const leftEvidence = resolveProducer(left, context);
    const rightEvidence = resolveProducer(right, context);
    return isEquality(op)
      ? decideEquality(leftEvidence, rightEvidence)
      : decideOrdering(leftEvidence, rightEvidence);
  },

  admitValues(
    op: ComparisonOperator,
    decision: ComparisonDecision,
    left: unknown,
    right: unknown,
  ): OperationAdmission<AdmittedComparison> {
    if (decision.mode !== "by-value")
      return admitSelectedOrdering(decision, left, right);
    const { left: leftEvidence, right: rightEvidence } = decision.operands;
    return isEquality(op)
      ? admitEqualityValues(leftEvidence, rightEvidence, left, right)
      : admitUnionOrderingValues(leftEvidence, rightEvidence, left, right);
  },

  /** Whether the operands of an equality decision could hold equal values. */
  mayBeEqual(decision: ComparisonDecision): boolean {
    return (
      decision.mode !== "by-value" ||
      mayEqual(decision.operands.left, decision.operands.right)
    );
  },

  result: { kind: "carrier", carrier: "boolean" } satisfies SourceFact,
};

function isEquality(op: ComparisonOperator): boolean {
  return op === "==" || op === "!=";
}

function incoherentComparison(): OperationAdmission<never> {
  return operationViolation(
    "invalid-comparison-operands",
    "Comparison operands do not have a coherent shared domain",
  );
}

function nonFiniteComparison(path: string): OperationAdmission<never> {
  return operationViolation(
    "non-finite-number",
    `Numeric value must be finite before numeric comparison${
      path === "$" ? "" : ` at ${path}`
    }`,
  );
}

function admitSelectedOrdering(
  selected: SelectedOrdering,
  left: unknown,
  right: unknown,
): OperationAdmission<AdmittedOrdering> {
  if (selected.judgment.kind === "incompatible") return incoherentComparison();
  const admitted = admitOrderingOperands(selected, left, right);
  return admitted.admitted
    ? operationAdmitted({ left, right, decision: selected })
    : admitted;
}

function admitOrderingOperands(
  selected: SelectedOrdering,
  left: unknown,
  right: unknown,
): OperationAdmission<{ left: unknown; right: unknown }> {
  switch (selected.mode) {
    case "enum": {
      const spec: ChannelSpec = {
        type: "enum",
        values: [...(selected.enumValues ?? [])],
      };
      const admittedLeft = admitValue(spec, left);
      const admittedRight = admitValue(spec, right);
      if (!admittedLeft.admitted || !admittedRight.admitted) {
        return operationViolation(
          "invalid-enum-value",
          "Enum comparison requires values in the selected Enum domain",
        );
      }
      return operationAdmitted({ left, right });
    }
    case "number": {
      const admittedLeft = admitValue({ type: "number" }, left);
      const admittedRight = admitValue({ type: "number" }, right);
      if (!admittedLeft.admitted || !admittedRight.admitted) {
        const nonFinite =
          (typeof left === "number" && !Number.isFinite(left)) ||
          (typeof right === "number" && !Number.isFinite(right));
        return nonFinite
          ? nonFiniteComparison("$")
          : operationViolation(
              "invalid-numeric-comparison",
              "Numeric comparison requires finite numeric operands",
            );
      }
      return operationAdmitted({ left, right });
    }
    case "string":
      return typeof left === "string" && typeof right === "string"
        ? operationAdmitted({ left, right })
        : operationViolation(
            "invalid-string-comparison",
            "String comparison requires string operands",
          );
    case "dynamic":
      if (Array.isArray(left) || Array.isArray(right)) {
        const nonFinite =
          firstNonFiniteNumberPath(left) ?? firstNonFiniteNumberPath(right);
        return nonFinite !== undefined
          ? nonFiniteComparison(nonFinite)
          : operationViolation(
              "invalid-array-operation",
              "Arrays cannot be ordered",
            );
      }
      if (typeof left === "number" || typeof right === "number") {
        const admittedLeft = admitValue({ type: "number" }, left);
        const admittedRight = admitValue({ type: "number" }, right);
        if (admittedLeft.admitted && admittedRight.admitted) {
          return operationAdmitted({ left, right });
        }
        const nonFinite =
          (typeof left === "number" && !Number.isFinite(left)) ||
          (typeof right === "number" && !Number.isFinite(right));
        return nonFinite
          ? nonFiniteComparison("$")
          : operationViolation(
              "invalid-numeric-comparison",
              "Numeric comparison requires finite numeric operands",
            );
      }
      return typeof left === "string" && typeof right === "string"
        ? operationAdmitted({ left, right })
        : operationViolation(
            "invalid-comparison-operands",
            "Ordering requires two finite numbers or two strings",
          );
  }
}

/** Whether a producer carries a union declaration at an ordered position. */
function hasUnionEvidence(evidence: ProducerEvidence): boolean {
  return evidence.kind === "alternatives"
    ? evidence.alternatives.some(hasUnionEvidence)
    : declaredUnion(evidence) !== undefined;
}

function declaredUnion(evidence: ProducerEvidence): UnionSpec | undefined {
  return evidence.kind === "fact" &&
    evidence.fact.kind === "site" &&
    evidence.fact.spec.type === "union"
    ? evidence.fact.spec
    : undefined;
}

/** Shadowed members remain declared, but cannot govern an operation. */
function precedingAlternatives(spec: UnionSpec): ProducerEvidence[] {
  return spec.members.flatMap((member, index) => {
    const earlier = spec.members.slice(0, index);
    const shadowed =
      member.type === "enum"
        ? member.values.every((value) =>
            earlier.some((prior) => admitValue(prior, value).admitted),
          )
        : earlier.some((prior) => reusableSpecCompatible(member, prior));
    return shadowed ? [] : [resolvedFact({ kind: "site", spec: member })];
  });
}

/** Accepts any two values, rejecting only cursors and producers without a value. */
function decideEquality(
  left: ProducerEvidence,
  right: ProducerEvidence,
): ComparisonDecision {
  return {
    judgment:
      isEqualityOperand(left) && isEqualityOperand(right)
        ? COMPATIBLE
        : INCOMPATIBLE,
    mode: "by-value",
    operands: { left, right },
  };
}

/** Whether a producer holds no `Dialog.Cursor` and always supplies a value. */
function isEqualityOperand(evidence: ProducerEvidence): boolean {
  switch (evidence.kind) {
    case "unusable":
      return false;
    case "alternatives":
      return evidence.alternatives.every(isEqualityOperand);
    case "array":
      return evidence.elements.every(isEqualityOperand);
    case "struct":
      return Object.values(evidence.fields ?? {}).every(isEqualityOperand);
    case "fact":
      return evidence.fact.kind === "array"
        ? evidence.fact.elements.every((fact) =>
            isEqualityOperand(resolvedFact(fact)),
          )
        : stableFamily(evidence) !== "dialog-cursor";
    case "dynamic":
      return true;
  }
}

/** Rejects non-finite and malformed values; any other pair may then compare. */
function admitEqualityValues(
  leftEvidence: ProducerEvidence,
  rightEvidence: ProducerEvidence,
  left: unknown,
  right: unknown,
): OperationAdmission<AdmittedEquality> {
  const nonFinite =
    firstNonFiniteNumberPath(left) ?? firstNonFiniteNumberPath(right);
  if (nonFinite !== undefined) return nonFiniteComparison(nonFinite);
  if (
    firstInvalidPayloadValue(left) ||
    firstInvalidPayloadValue(right) ||
    !evidenceAdmitsValue(leftEvidence, left) ||
    !evidenceAdmitsValue(rightEvidence, right)
  )
    return incoherentComparison();
  return operationAdmitted({ left, right, decision: { mode: "equality" } });
}

/**
 * Whether two producers could hold equal values, for lint rather than
 * evaluation; unproven evidence could. Arrays with disjoint element types count
 * as unequal even though two empty arrays are equal, because the mismatch is
 * what an author needs to see.
 */
function mayEqual(left: ProducerEvidence, right: ProducerEvidence): boolean {
  if (left.kind === "alternatives")
    return left.alternatives.some((alternative) =>
      mayEqual(alternative, right),
    );
  if (right.kind === "alternatives")
    return right.alternatives.some((alternative) =>
      mayEqual(left, alternative),
    );
  const leftUnion = declaredUnion(left);
  if (leftUnion)
    return leftUnion.members.some((spec) =>
      mayEqual(resolvedFact({ kind: "site", spec }), right),
    );
  const rightUnion = declaredUnion(right);
  if (rightUnion)
    return rightUnion.members.some((spec) =>
      mayEqual(left, resolvedFact({ kind: "site", spec })),
    );
  const leftFamily = stableFamily(left);
  const rightFamily = stableFamily(right);
  if (leftFamily === "dynamic" || rightFamily === "dynamic") return true;
  if (leftFamily !== rightFamily) return false;
  if (leftFamily === "string") {
    const leftStrings = knownStrings(left);
    const rightStrings = knownStrings(right);
    return (
      !leftStrings ||
      !rightStrings ||
      leftStrings.some((value) => rightStrings.includes(value))
    );
  }
  if (leftFamily === "array") {
    return alignedElementEvidence(left, right).every(([lhs, rhs]) =>
      mayEqual(lhs, rhs),
    );
  }
  if (leftFamily === "struct") {
    const leftFields = structOperandFields(left);
    const rightFields = structOperandFields(right);
    if (!leftFields || !rightFields) return false;
    if (leftFields === "dynamic" || rightFields === "dynamic") return true;
    return (
      sameFieldNames(leftFields, rightFields) &&
      Object.keys(leftFields).every((name) =>
        mayEqual(leftFields[name]!, rightFields[name]!),
      )
    );
  }
  return true;
}

/** The strings a producer can hold, when they are known. */
function knownStrings(
  evidence: ProducerEvidence,
): readonly string[] | undefined {
  if (evidence.kind !== "fact") return undefined;
  const fact = evidence.fact;
  if (fact.kind === "literal")
    return typeof fact.value === "string" ? [fact.value] : undefined;
  return fact.kind === "site" && fact.spec.type === "enum"
    ? fact.spec.values
    : undefined;
}

function decideOrdering(
  left: ProducerEvidence,
  right: ProducerEvidence,
): ComparisonDecision {
  if (!hasUnionEvidence(left) && !hasUnionEvidence(right))
    return decideScalarOrdering(left, right);
  return {
    judgment: judgeUnionOrdering(left, right),
    mode: "by-value",
    operands: { left, right },
  };
}

/** Judges an ordering that reaches a union declaration. */
function judgeUnionOrdering(
  left: ProducerEvidence,
  right: ProducerEvidence,
): CoherenceJudgment {
  if (left.kind === "alternatives") {
    return reduceAlternativeJudgments(
      left.alternatives.map(
        (alternative) => decideOrdering(alternative, right).judgment,
      ),
    );
  }
  if (right.kind === "alternatives") {
    return reduceAlternativeJudgments(
      right.alternatives.map(
        (alternative) => decideOrdering(left, alternative).judgment,
      ),
    );
  }
  const leftUnion = declaredUnion(left);
  const rightUnion = declaredUnion(right);
  return reduceUnionJudgments(
    (leftUnion ? precedingAlternatives(leftUnion) : [left]).flatMap((lhs) =>
      (rightUnion ? precedingAlternatives(rightUnion) : [right]).map(
        (rhs) => decideScalarOrdering(lhs, rhs).judgment,
      ),
    ),
  );
}

type AdmittedOrdering = {
  left: unknown;
  right: unknown;
  decision: SelectedOrdering;
};

type AdmittedEquality = {
  left: unknown;
  right: unknown;
  decision: { mode: "equality" };
};

type AdmittedComparison = AdmittedOrdering | AdmittedEquality;

/** Checks a replayed value against its original producer, without adding type tags. */
function evidenceAdmitsValue(
  evidence: ProducerEvidence,
  value: unknown,
): boolean {
  switch (evidence.kind) {
    case "dynamic":
      return true;
    case "unusable":
      return false;
    case "alternatives":
      return evidence.alternatives.some((alternative) =>
        evidenceAdmitsValue(alternative, value),
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length === evidence.elements.length &&
        evidence.elements.every((element, index) =>
          evidenceAdmitsValue(element, value[index]),
        )
      );
    case "struct":
      return (
        isPlainRecord(value) &&
        (evidence.fields === undefined ||
          (sameFieldNames(evidence.fields, value) &&
            Object.entries(evidence.fields).every(([name, field]) =>
              evidenceAdmitsValue(field, value[name]),
            )))
      );
    case "fact": {
      const fact = evidence.fact;
      switch (fact.kind) {
        case "site":
          return admitValue(fact.spec, value).admitted;
        case "literal":
          return value === fact.value;
        case "carrier":
          return typeof value === fact.carrier;
        case "empty-array":
          return Array.isArray(value) && value.length === 0;
        case "array":
          return evidenceAdmitsValue(
            { kind: "array", elements: fact.elements.map(resolvedFact) },
            value,
          );
        case "provenance":
          return admitValue(
            {
              type:
                fact.provenance === "dialog-cursor"
                  ? "dialogCursor"
                  : fact.provenance,
            },
            value,
          ).admitted;
      }
    }
  }
}

function elementEvidenceAt(
  evidence: ProducerEvidence,
  index: number,
): ProducerEvidence {
  if (evidence.kind === "array")
    return evidence.elements[index] ?? { kind: "unusable" };
  if (evidence.kind === "fact") {
    if (evidence.fact.kind === "site" && evidence.fact.spec.type === "array")
      return resolvedFact({ kind: "site", spec: evidence.fact.spec.element });
    if (evidence.fact.kind === "array")
      return evidence.fact.elements[index]
        ? resolvedFact(evidence.fact.elements[index]!)
        : { kind: "unusable" };
  }
  return { kind: "dynamic" };
}

/** The element pairs equality compares: by position for literal arrays. */
function alignedElementEvidence(
  left: ProducerEvidence,
  right: ProducerEvidence,
): [ProducerEvidence, ProducerEvidence][] {
  const lengths = [left, right].flatMap((evidence) => {
    const length = literalArrayLength(evidence);
    return length === undefined ? [] : [length];
  });
  const count = lengths.length > 0 ? Math.min(...lengths) : 1;
  return Array.from({ length: count }, (_, index) => [
    elementEvidenceAt(left, index),
    elementEvidenceAt(right, index),
  ]);
}

function literalArrayLength(evidence: ProducerEvidence): number | undefined {
  if (evidence.kind === "array") return evidence.elements.length;
  if (evidence.kind !== "fact") return undefined;
  if (evidence.fact.kind === "array") return evidence.fact.elements.length;
  return evidence.fact.kind === "empty-array" ? 0 : undefined;
}

/** Validates both values once, then selects the ordering they establish. */
function admitUnionOrderingValues(
  leftEvidence: ProducerEvidence,
  rightEvidence: ProducerEvidence,
  left: unknown,
  right: unknown,
): OperationAdmission<AdmittedOrdering> {
  const nonFinite =
    firstNonFiniteNumberPath(left) ?? firstNonFiniteNumberPath(right);
  if (nonFinite !== undefined) return nonFiniteComparison(nonFinite);
  if (
    firstInvalidPayloadValue(left) ||
    firstInvalidPayloadValue(right) ||
    !evidenceAdmitsValue(leftEvidence, left) ||
    !evidenceAdmitsValue(rightEvidence, right)
  )
    return incoherentComparison();
  return selectUnionOrdering(leftEvidence, rightEvidence, left, right);
}

/** Resolves each union from its validated value, then selects the ordering. */
function selectUnionOrdering(
  leftEvidence: ProducerEvidence,
  rightEvidence: ProducerEvidence,
  left: unknown,
  right: unknown,
): OperationAdmission<AdmittedOrdering> {
  if (
    leftEvidence.kind === "alternatives" ||
    rightEvidence.kind === "alternatives"
  ) {
    const leftAlternatives =
      leftEvidence.kind === "alternatives"
        ? leftEvidence.alternatives.filter((evidence) =>
            evidenceAdmitsValue(evidence, left),
          )
        : [leftEvidence];
    const rightAlternatives =
      rightEvidence.kind === "alternatives"
        ? rightEvidence.alternatives.filter((evidence) =>
            evidenceAdmitsValue(evidence, right),
          )
        : [rightEvidence];
    let selected: AdmittedOrdering | undefined;
    for (const lhs of leftAlternatives)
      for (const rhs of rightAlternatives) {
        const result = selectUnionOrdering(lhs, rhs, left, right);
        if (!result.admitted) return result;
        if (
          selected &&
          (selected.decision.mode !== result.value.decision.mode ||
            !sameEnumDomain(
              selected.decision.enumValues ?? [],
              result.value.decision.enumValues ?? [],
            ))
        ) {
          return operationViolation(
            "invalid-comparison-operands",
            "Conditional alternatives do not establish one unambiguous comparison domain",
          );
        }
        selected = result.value;
      }
    return selected ? operationAdmitted(selected) : incoherentComparison();
  }

  const leftUnion = declaredUnion(leftEvidence);
  const rightUnion = declaredUnion(rightEvidence);
  return admitSelectedOrdering(
    decideScalarOrdering(
      leftUnion
        ? resolvedFact({
            kind: "site",
            spec: precedingSpec(leftUnion, left)!,
          })
        : leftEvidence,
      rightUnion
        ? resolvedFact({
            kind: "site",
            spec: precedingSpec(rightUnion, right)!,
          })
        : rightEvidence,
    ),
    left,
    right,
  );
}

function decideScalarOrdering(
  left: ProducerEvidence,
  right: ProducerEvidence,
): SelectedOrdering {
  const leftEnum = provenEnumDomain(left);
  const rightEnum = provenEnumDomain(right);
  if (leftEnum || rightEnum) {
    if (leftEnum && rightEnum && !sameEnumDomain(leftEnum, rightEnum)) {
      return decision("incompatible", "enum");
    }
    const enumValues = leftEnum ?? rightEnum!;
    const judgment = reduceAlternativeJudgments([
      judgeEnumOperand(left, enumValues),
      judgeEnumOperand(right, enumValues),
    ]);
    return { judgment, mode: "enum", enumValues };
  }

  const leftFamily = stableFamily(left);
  const rightFamily = stableFamily(right);
  const known = leftFamily === "dynamic" ? rightFamily : leftFamily;
  if (known === "number" || known === "string") {
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, known),
      judgeFamily(right, known),
    ]);
    return { judgment, mode: known };
  }
  const undecided =
    known === "dynamic" ||
    (known === "artifact" &&
      (leftFamily === "dynamic" || rightFamily === "dynamic"));
  return decision(undecided ? "unknown" : "incompatible", "dynamic");
}

function decision(
  kind: CoherenceJudgment["kind"],
  mode: SelectedOrdering["mode"],
): SelectedOrdering {
  return { judgment: { kind }, mode };
}

/**
 * The field producers of a struct operand, `"dynamic"` when its fields are
 * known only at runtime, or `undefined` when the operand is not a struct.
 */
function structOperandFields(
  evidence: Exclude<ProducerEvidence, { kind: "alternatives" }>,
): Record<string, ProducerEvidence> | "dynamic" | undefined {
  switch (evidence.kind) {
    case "struct":
      return evidence.fields ?? "dynamic";
    case "dynamic":
      return "dynamic";
    case "fact":
      return evidence.fact.kind === "site" &&
        evidence.fact.spec.type === "struct"
        ? Object.fromEntries(
            Object.entries(evidence.fact.spec.fields).map(([name, spec]) => [
              name,
              { kind: "fact", fact: { kind: "site", spec } },
            ]),
          )
        : undefined;
    case "array":
    case "unusable":
      return undefined;
  }
}

type StableFamily =
  | "boolean"
  | "string"
  | "number"
  | "artifact"
  | "dialog-cursor"
  | "array"
  | "struct"
  | "unusable"
  | "dynamic";

function stableFamily(evidence: ProducerEvidence): StableFamily {
  switch (evidence.kind) {
    case "dynamic":
      return "dynamic";
    case "struct":
      return "struct";
    case "unusable":
      return "unusable";
    case "array":
      return "array";
    case "alternatives": {
      const families = evidence.alternatives.map(stableFamily);
      const first = families[0] ?? "dynamic";
      return families.every((family) => family === first) ? first : "dynamic";
    }
    case "fact": {
      const fact = evidence.fact;
      if (fact.kind === "literal") {
        if (typeof fact.value === "boolean") return "boolean";
        if (typeof fact.value === "string") return "string";
        return "number";
      }
      if (fact.kind === "carrier") return fact.carrier;
      if (fact.kind === "array" || fact.kind === "empty-array") return "array";
      if (fact.kind === "provenance") {
        return fact.provenance === "artifact"
          ? "artifact"
          : fact.provenance === "dialog-cursor"
            ? "dialog-cursor"
            : "number";
      }
      switch (fact.spec.type) {
        case "boolean":
          return "boolean";
        case "string":
        case "enum":
          return "string";
        case "number":
        case "index":
          return "number";
        case "artifact":
          return "artifact";
        case "dialogCursor":
          return "dialog-cursor";
        case "array":
          return "array";
        case "struct":
          return "struct";
        case "union": {
          const families = fact.spec.members.map((spec) =>
            stableFamily(resolvedFact({ kind: "site", spec })),
          );
          return families.every((family) => family === families[0])
            ? families[0]!
            : "dynamic";
        }
      }
    }
  }
}

function judgeFamily(
  evidence: ProducerEvidence,
  family: "boolean" | "string" | "number",
): CoherenceJudgment {
  const union = declaredUnion(evidence);
  if (union)
    return reduceOverUnion(union, (member) => judgeFamily(member, family));
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map((alternative) =>
          judgeFamily(alternative, family),
        ),
      );
    default:
      return stableFamily(evidence) === family
        ? { kind: "compatible" }
        : { kind: "incompatible" };
  }
}

function provenEnumDomain(
  evidence: ProducerEvidence,
): readonly string[] | undefined {
  if (
    evidence.kind === "fact" &&
    evidence.fact.kind === "site" &&
    evidence.fact.spec.type === "enum"
  ) {
    return evidence.fact.spec.values;
  }
  if (evidence.kind !== "alternatives" || evidence.alternatives.length === 0) {
    return undefined;
  }
  const domains = evidence.alternatives.map(provenEnumDomain);
  const first = domains[0];
  return first &&
    domains.every((domain) => domain && sameEnumDomain(first, domain))
    ? first
    : undefined;
}

function judgeEnumOperand(
  evidence: ProducerEvidence,
  domain: readonly string[],
): CoherenceJudgment {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map((alternative) =>
          judgeEnumOperand(alternative, domain),
        ),
      );
    case "fact":
      if (evidence.fact.kind === "literal") {
        return typeof evidence.fact.value === "string" &&
          domain.includes(evidence.fact.value)
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      if (
        evidence.fact.kind === "site" &&
        evidence.fact.spec.type === "enum" &&
        sameEnumDomain(evidence.fact.spec.values, domain)
      ) {
        return { kind: "compatible" };
      }
      return { kind: "incompatible" };
    default:
      return { kind: "incompatible" };
  }
}

function sameEnumDomain(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function judgeBooleanEvidence(evidence: ProducerEvidence): CoherenceJudgment {
  return judgeFamily(evidence, "boolean");
}

function judgeStringEvidence(evidence: ProducerEvidence): CoherenceJudgment {
  return judgeFamily(evidence, "string");
}

function judgeInterpolationEvidence(
  evidence: ProducerEvidence,
): CoherenceJudgment {
  const union = declaredUnion(evidence);
  if (union) return reduceOverUnion(union, judgeInterpolationEvidence);
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "unusable":
    case "struct":
      return { kind: "incompatible" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map(judgeInterpolationEvidence),
      );
    case "array":
      return reduceAlternativeJudgments(
        evidence.elements.map(judgePrimitiveArrayElementInterpolation),
      );
    case "fact": {
      if (
        evidence.fact.kind === "site" &&
        evidence.fact.spec.type === "array"
      ) {
        return evidence.fact.spec.element.type === "artifact"
          ? { kind: "incompatible" }
          : { kind: "compatible" };
      }
      if (evidence.fact.kind === "array") {
        return reduceAlternativeJudgments(
          evidence.fact.elements.map((element) =>
            judgePrimitiveArrayElementInterpolation({
              kind: "fact",
              fact: element,
            }),
          ),
        );
      }
      const family = stableFamily(evidence);
      return family === "boolean" ||
        family === "string" ||
        family === "number" ||
        family === "artifact" ||
        family === "array"
        ? { kind: "compatible" }
        : { kind: "incompatible" };
    }
  }
}

function judgePrimitiveArrayElementInterpolation(
  evidence: ProducerEvidence,
): CoherenceJudgment {
  const union = declaredUnion(evidence);
  if (union)
    return reduceOverUnion(union, judgePrimitiveArrayElementInterpolation);
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map(judgePrimitiveArrayElementInterpolation),
      );
    default: {
      const family = stableFamily(evidence);
      return family === "boolean" || family === "string" || family === "number"
        ? { kind: "compatible" }
        : { kind: "incompatible" };
    }
  }
}

function operationAdmitted<T>(value: T): OperationAdmission<T> {
  return { admitted: true, value };
}

function operationViolation<T = never>(
  code: string,
  detail: string,
): OperationAdmission<T> {
  return { admitted: false, violation: { code, detail } };
}

function judgeNumericEvidence(evidence: ProducerEvidence): CoherenceJudgment {
  const union = declaredUnion(evidence);
  if (union) return reduceOverUnion(union, judgeNumericEvidence);
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "unusable":
    case "struct":
    case "array":
      return { kind: "incompatible" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map(judgeNumericEvidence),
      );
    case "fact": {
      const fact = evidence.fact;
      if (fact.kind === "literal") {
        return typeof fact.value === "number"
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      if (fact.kind === "carrier") {
        return fact.carrier === "number"
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      if (fact.kind === "provenance") {
        return fact.provenance === "index"
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      if (fact.kind === "site") {
        return fact.spec.type === "number" || fact.spec.type === "index"
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      return { kind: "incompatible" };
    }
  }
}

function carrier(value: "boolean" | "string" | "number"): ProducerEvidence {
  return resolvedFact({ kind: "carrier", carrier: value });
}

function resolvedFact(fact: SourceFact): ProducerEvidence {
  return { kind: "fact", fact };
}

function hostParameterChannelSpec(
  spec: HostParameterValueSpec,
): ChannelSpec | undefined {
  switch (spec.type) {
    case "boolean":
    case "string":
    case "number":
    case "index":
    case "artifact":
    case "dialogCursor":
      return { type: spec.type };
    case "enum":
      return { type: "enum", values: spec.values };
    case "union":
      return spec;
    case "array": {
      const element = spec.element;
      if (
        element.type !== "boolean" &&
        element.type !== "string" &&
        element.type !== "enum" &&
        element.type !== "number" &&
        element.type !== "union" &&
        element.type !== "artifact"
      ) {
        return undefined;
      }
      return {
        type: "array",
        element,
      };
    }
    case "tuple":
    case "struct":
    case "semanticText":
      return undefined;
  }
}

function judgeSemanticArgument(
  semantic: SemanticString,
  destination: Extract<ChannelSpec, { type: "string" | "enum" | "union" }>,
  context: ProducerContext,
): CoherenceJudgment {
  if (semantic.kind === "literal") {
    return judgeOneTimeLanding(
      { kind: "literal", value: semantic.value },
      destination,
    );
  }
  let dynamic = false;
  for (const part of semantic.parts) {
    if (part.kind === "ref" || part.kind === "hostVar") {
      return { kind: "incompatible" };
    }
    if (part.kind !== "expression") continue;
    const evidence = resolveProducer(part.expression, context);
    if (producerGuaranteesArtifact(evidence)) {
      return { kind: "incompatible" };
    }
    if (producerMayProduceArtifact(evidence)) dynamic = true;
  }
  const landing = judgeOneTimeLanding(
    { kind: "carrier", carrier: "string" },
    destination,
  );
  return landing.kind === "incompatible"
    ? landing
    : dynamic
      ? UNKNOWN
      : landing;
}

function producerMayProduceArtifact(evidence: ProducerEvidence): boolean {
  switch (evidence.kind) {
    case "dynamic":
      return true;
    case "alternatives":
      return evidence.alternatives.some(producerMayProduceArtifact);
    case "fact":
      return (
        (evidence.fact.kind === "provenance" &&
          evidence.fact.provenance === "artifact") ||
        (evidence.fact.kind === "site" &&
          evidence.fact.spec.type === "artifact")
      );
    default:
      return false;
  }
}

function hostArgumentViolation(
  detail: string,
  path: string,
): HostArgumentAdmission {
  return {
    admitted: false,
    violation: { code: "invalid-host-argument", detail, path },
  };
}

function resolveArrayElementSpec(
  reference: ArrayReference,
  context: ProducerContext,
): ArrayElementSpec | undefined {
  const spec = resolveReferenceSpec(reference, context);
  return spec?.type === "array" ? spec.element : undefined;
}

/**
 * Resolves the declared value guarantee of a cell, channel, or struct field
 * reference, projected to its bare channel-shaped spec.
 */
export function resolveReferenceSpec(
  reference: ArrayReference,
  context: ProducerContext,
): ChannelSpec | undefined {
  if (reference.kind === "channel") {
    return getChannelSpec(
      context.signature,
      reference.namespace,
      reference.key,
    );
  }
  if (reference.kind === "cell") {
    const cell = findCell(context, reference.name);
    return cell ? cellSpecToChannelSpec(cell) : undefined;
  }
  const receiver = resolveReceiverSpec(reference.receiver, context);
  if (receiver?.type !== "struct") return undefined;
  const field = fieldSpecAt(receiver, reference.path);
  return field ? fieldSpecOf(field) : undefined;
}

/**
 * Resolves the declared guarantee of a field receiver: a cell or channel, one
 * element of an array reference, or the current `$map` element.
 */
function resolveReceiverSpec(
  receiver: FieldReceiver,
  context: ProducerContext,
): ChannelSpec | ArrayElementSpec | undefined {
  switch (receiver.kind) {
    case "cell":
    case "channel":
      return resolveReferenceSpec(receiver, context);
    case "arrayElementRead": {
      const array = resolveReferenceSpec(receiver.array, context);
      return array?.type === "array" ? array.element : undefined;
    }
    case "span":
      return context.map?.receiverSpec;
  }
}

function findCell(context: ProducerContext, name: string): Cell | undefined {
  const resolved = context.resolveCell?.(name);
  if (resolved) return resolved;
  for (let index = context.cells.length - 1; index >= 0; index -= 1) {
    const candidate = context.cells[index]!;
    if (candidate.name === name) return candidate;
  }
  return undefined;
}
