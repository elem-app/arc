import type {
  ArrayReference,
  Cell,
  ComparisonOperator,
  HostCall,
  HostCallArgument,
  NodeSignature,
  SemanticString,
  ValueExpression,
} from "../types/parser.js";
import {
  cellSpecToChannelSpec,
  type ArrayElementSpec,
  type CellSpec,
  type ChannelSpec,
  type HostModuleSpec,
  type HostNamespaceSpec,
  type HostOperationSpec,
  type HostParameterSpec,
} from "../types/spec.js";
import {
  classifyArtifactPath,
  classifyArtifactValue,
  isArtifactValue,
  isDialogCursorValue,
  isPrimitiveArrayValue,
  isPrimitiveValue,
  type CellValue,
  type PayloadValue,
  type PrimitiveValue,
  type SemanticText,
} from "../types/value.js";
import {
  describeArtifactPathIssue,
  describeArtifactValueIssue,
  firstNonFiniteNumberPath,
} from "../value-utils.js";

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
    | "invalid-dialog-cursor";
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
  }
}

function admitted(value: CellValue): Admission {
  return { admitted: true, value };
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

/** Whether every provider value is admitted by the receiver guarantee. */
export function reusableSpecCompatible(
  provider: CellSpec | ChannelSpec,
  receiver: CellSpec | ChannelSpec,
): boolean {
  if (provider.type === "index" && receiver.type === "number") return true;
  if (provider.type === "enum" && receiver.type === "string") return true;
  if (provider.type !== receiver.type) return false;
  if (provider.type === "enum" && receiver.type === "enum") {
    return provider.values.every((value) => receiver.values.includes(value));
  }
  if (provider.type === "array" && receiver.type === "array") {
    return reusableSpecCompatible(provider.element, receiver.element);
  }
  return true;
}

function judgeSpecLanding(
  source: CellSpec | ChannelSpec,
  destination: CellSpec | ChannelSpec,
): CoherenceJudgment {
  if (reusableSpecCompatible(source, destination)) return COMPATIBLE;
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

/** Facts derived from an expression producer without accompanying its value. */
export type ProducerEvidence =
  | { kind: "fact"; fact: SourceFact }
  | { kind: "alternatives"; alternatives: ProducerEvidence[] }
  | { kind: "array"; elements: ProducerEvidence[] }
  | { kind: "struct" }
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
      const spec = context.signature?.[expression.namespace][expression.key];
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
    case "scope":
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
  destination: HostParameterSpec,
  context: ProducerContext,
): CoherenceJudgment {
  if (argument.kind === "object") return { kind: "incompatible" };
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
    if (destination.type !== "string" && destination.type !== "enum") {
      return { kind: "incompatible" };
    }
    return judgeSemanticArgument(argument.value, destination, context);
  }
  if (destination.type === "semanticText") {
    return stringOperandRule.checkProducer(argument.value, context);
  }
  const channelSpec = hostParameterChannelSpec(destination);
  return channelSpec
    ? judgeProducerLanding(
        resolveProducer(argument.value, context),
        channelSpec,
      )
    : { kind: "incompatible" };
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
  destination: HostParameterSpec,
  path = "$",
): HostArgumentAdmission {
  if (rendered === undefined) {
    return hostArgumentViolation("An unset host argument is not allowed", path);
  }
  if (argument.kind === "object") {
    return hostArgumentViolation(
      "Object host arguments have no supported parameter spec",
      path,
    );
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
    if (destination.type !== "array") {
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

function isRenderedSemanticText(value: unknown): value is SemanticText {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    switch (record.kind) {
      case "text":
        return (
          hasExactKeys(record, ["kind", "value"]) &&
          typeof record.value === "string"
        );
      case "entity":
        return (
          hasExactKeys(record, ["kind", "name"]) &&
          (record.name === "user" || record.name === "self")
        );
      case "artifact":
        return (
          hasExactKeys(record, ["kind", "path"]) &&
          typeof record.path === "string" &&
          classifyArtifactPath(record.path) === undefined
        );
      case "hostVar":
        return (
          hasExactKeys(record, ["kind", "module", "path"]) &&
          typeof record.module === "string" &&
          record.module.length > 0 &&
          Array.isArray(record.path) &&
          record.path.length > 0 &&
          record.path.every(
            (segment: unknown) =>
              typeof segment === "string" && segment.length > 0,
          )
        );
      default:
        return false;
    }
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
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
    case "struct":
      return { kind: "incompatible" };
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
        ? operationAdmitted(value.path)
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

export type ComparisonDecision = {
  judgment: CoherenceJudgment;
  mode:
    | "enum"
    | "number"
    | "string"
    | "boolean"
    | "artifact"
    | "array"
    | "dynamic";
  enumValues?: readonly string[];
  arrayElementFamily?: ArrayComparisonFamily;
};

export const comparisonRule = {
  checkProducers(
    op: ComparisonOperator,
    left: ValueExpression,
    right: ValueExpression,
    context: ProducerContext,
  ): ComparisonDecision {
    return decideComparison(
      op,
      resolveProducer(left, context),
      resolveProducer(right, context),
    );
  },

  admitValues(
    op: ComparisonOperator,
    decision: ComparisonDecision,
    left: unknown,
    right: unknown,
  ): OperationAdmission<{ left: unknown; right: unknown }> {
    switch (decision.mode) {
      case "enum": {
        const spec: ChannelSpec = {
          type: "enum",
          values: [...(decision.enumValues ?? [])],
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
          return operationViolation(
            nonFinite ? "non-finite-number" : "invalid-numeric-comparison",
            nonFinite
              ? "Numeric value must be finite before numeric comparison"
              : "Numeric comparison requires finite numeric operands",
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
      case "boolean":
        return typeof left === "boolean" && typeof right === "boolean"
          ? operationAdmitted({ left, right })
          : operationViolation(
              "invalid-boolean-comparison",
              "Boolean equality requires boolean operands",
            );
      case "artifact":
        return isArtifactValue(left) && isArtifactValue(right)
          ? operationAdmitted({ left, right })
          : operationViolation(
              "invalid-artifact-value",
              "Artifact equality requires valid Artifact values",
            );
      case "array":
        return admitArrayComparisonValues(
          decision.arrayElementFamily,
          left,
          right,
        );
      case "dynamic":
        if (Array.isArray(left) || Array.isArray(right)) {
          return admitArrayComparisonValues(undefined, left, right);
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
          return operationViolation(
            nonFinite ? "non-finite-number" : "invalid-numeric-comparison",
            nonFinite
              ? "Numeric value must be finite before numeric comparison"
              : "Numeric comparison requires finite numeric operands",
          );
        }
        if (op !== "==" && op !== "!=") {
          return typeof left === "string" && typeof right === "string"
            ? operationAdmitted({ left, right })
            : operationViolation(
                "invalid-comparison-operands",
                "Ordering requires two finite numbers or two strings",
              );
        }
        return operationAdmitted({ left, right });
    }
  },

  result: { kind: "carrier", carrier: "boolean" } satisfies SourceFact,
};

function decideComparison(
  op: ComparisonOperator,
  left: ProducerEvidence,
  right: ProducerEvidence,
): ComparisonDecision {
  const ordering = op !== "==" && op !== "!=";
  const leftEnum = provenEnumDomain(left);
  const rightEnum = provenEnumDomain(right);
  if (ordering && (leftEnum || rightEnum)) {
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
  if (known === "artifact") {
    if (leftFamily === "dynamic" || rightFamily === "dynamic") {
      return decision("unknown", "dynamic");
    }
    return leftFamily === "artifact" && rightFamily === "artifact" && !ordering
      ? decision("compatible", "artifact")
      : decision("incompatible", "artifact");
  }
  if (known === "array") {
    if (ordering) return decision("incompatible", "array");
    const elementFamilies = new Set<ArrayComparisonFamily>();
    collectArrayElementFamilies(left, elementFamilies);
    collectArrayElementFamilies(right, elementFamilies);
    if (elementFamilies.size > 1) {
      return decision("incompatible", "array");
    }
    const arrayElementFamily = elementFamilies.values().next().value;
    const judgment = reduceAlternativeJudgments([
      judgeArrayEvidence(left, arrayElementFamily),
      judgeArrayEvidence(right, arrayElementFamily),
    ]);
    return { judgment, mode: "array", arrayElementFamily };
  }
  if (known === "dialog-cursor" || known === "struct" || known === "unusable") {
    return decision("incompatible", "dynamic");
  }
  if (known === "boolean") {
    if (ordering) return decision("incompatible", "boolean");
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "boolean"),
      judgeFamily(right, "boolean"),
    ]);
    return { judgment, mode: "boolean" };
  }
  if (known === "number") {
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "number"),
      judgeFamily(right, "number"),
    ]);
    return { judgment, mode: "number" };
  }
  if (known === "string") {
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "string"),
      judgeFamily(right, "string"),
    ]);
    return { judgment, mode: "string" };
  }
  return decision("unknown", "dynamic");
}

function decision(
  kind: CoherenceJudgment["kind"],
  mode: ComparisonDecision["mode"],
): ComparisonDecision {
  return { judgment: { kind }, mode };
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

type ScalarComparisonFamily = "boolean" | "string" | "number";
type ArrayComparisonFamily = ScalarComparisonFamily | "artifact";

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
      }
    }
  }
}

function collectArrayElementFamilies(
  evidence: ProducerEvidence,
  families: Set<ArrayComparisonFamily>,
): void {
  switch (evidence.kind) {
    case "alternatives":
      for (const alternative of evidence.alternatives) {
        collectArrayElementFamilies(alternative, families);
      }
      return;
    case "array":
      for (const element of evidence.elements) {
        collectScalarComparisonFamilies(element, families);
      }
      return;
    case "fact":
      if (
        evidence.fact.kind === "site" &&
        evidence.fact.spec.type === "array"
      ) {
        families.add(arrayComparisonFamily(evidence.fact.spec.element));
      } else if (evidence.fact.kind === "array") {
        for (const element of evidence.fact.elements) {
          collectScalarComparisonFamilies(
            { kind: "fact", fact: element },
            families,
          );
        }
      }
      return;
    case "dynamic":
    case "struct":
    case "unusable":
      return;
  }
}

function collectScalarComparisonFamilies(
  evidence: ProducerEvidence,
  families: Set<ArrayComparisonFamily>,
): void {
  if (evidence.kind === "alternatives") {
    for (const alternative of evidence.alternatives) {
      collectScalarComparisonFamilies(alternative, families);
    }
    return;
  }
  const family = stableFamily(evidence);
  if (
    family === "boolean" ||
    family === "string" ||
    family === "number" ||
    family === "artifact"
  ) {
    families.add(family);
  }
}

function judgeArrayEvidence(
  evidence: ProducerEvidence,
  elementFamily: ArrayComparisonFamily | undefined,
): CoherenceJudgment {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(
        evidence.alternatives.map((alternative) =>
          judgeArrayEvidence(alternative, elementFamily),
        ),
      );
    case "array":
      return reduceAlternativeJudgments(
        evidence.elements.map((element) =>
          judgeScalarComparisonEvidence(element, elementFamily),
        ),
      );
    case "fact":
      if (evidence.fact.kind === "empty-array") {
        return { kind: "compatible" };
      }
      if (evidence.fact.kind === "array") {
        return reduceAlternativeJudgments(
          evidence.fact.elements.map((element) =>
            judgeScalarComparisonEvidence(
              { kind: "fact", fact: element },
              elementFamily,
            ),
          ),
        );
      }
      if (
        evidence.fact.kind === "site" &&
        evidence.fact.spec.type === "array"
      ) {
        const family = arrayComparisonFamily(evidence.fact.spec.element);
        return elementFamily === undefined || family === elementFamily
          ? { kind: "compatible" }
          : { kind: "incompatible" };
      }
      return { kind: "incompatible" };
    case "struct":
    case "unusable":
      return { kind: "incompatible" };
  }
}

function judgeScalarComparisonEvidence(
  evidence: ProducerEvidence,
  family: ArrayComparisonFamily | undefined,
): CoherenceJudgment {
  if (family !== undefined) return judgeFamily(evidence, family);
  if (evidence.kind === "dynamic") return { kind: "unknown" };
  if (evidence.kind === "alternatives") {
    return reduceAlternativeJudgments(
      evidence.alternatives.map((alternative) =>
        judgeScalarComparisonEvidence(alternative, family),
      ),
    );
  }
  const stable = stableFamily(evidence);
  return stable === "boolean" ||
    stable === "string" ||
    stable === "number" ||
    stable === "artifact"
    ? { kind: "compatible" }
    : { kind: "incompatible" };
}

function arrayComparisonFamily(spec: ArrayElementSpec): ArrayComparisonFamily {
  return spec.type === "enum" ? "string" : spec.type;
}

function judgeFamily(
  evidence: ProducerEvidence,
  family: "boolean" | "string" | "number" | "artifact" | "array",
): CoherenceJudgment {
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

function admitArrayComparisonValues(
  elementFamily: ArrayComparisonFamily | undefined,
  left: unknown,
  right: unknown,
): OperationAdmission<{ left: unknown; right: unknown }> {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return operationViolation(
      "invalid-array-operation",
      "Array equality requires array operands",
    );
  }
  if (elementFamily === "artifact") {
    const spec: ChannelSpec = {
      type: "array",
      element: { type: "artifact" },
    };
    const admittedLeft = admitValue(spec, left);
    const admittedRight = admitValue(spec, right);
    return admittedLeft.admitted && admittedRight.admitted
      ? operationAdmitted({ left, right })
      : operationViolation(
          "invalid-array-operation",
          "Artifact array equality requires valid Artifact elements",
        );
  }
  const nonFinitePath =
    firstNonFiniteNumberPath(left) ?? firstNonFiniteNumberPath(right);
  if (nonFinitePath !== undefined) {
    return operationViolation(
      "non-finite-number",
      `Numeric value must be finite before numeric comparison${
        nonFinitePath === "$" ? "" : ` at ${nonFinitePath}`
      }`,
    );
  }

  const concreteFamily = concreteArrayElementFamily(left, right);
  if (concreteFamily === "incompatible") {
    return operationViolation(
      "invalid-array-operation",
      "Array equality requires one shared boolean, string, or number element family",
    );
  }
  const selectedFamily = elementFamily ?? concreteFamily;
  if (selectedFamily === undefined) {
    return operationAdmitted({ left, right });
  }
  if (
    elementFamily !== undefined &&
    concreteFamily !== undefined &&
    concreteFamily !== elementFamily
  ) {
    return operationViolation(
      "invalid-array-operation",
      `Array equality requires ${elementFamily} elements`,
    );
  }

  const spec: ChannelSpec = {
    type: "array",
    element: { type: selectedFamily },
  };
  const admittedLeft = admitValue(spec, left);
  const admittedRight = admitValue(spec, right);
  return admittedLeft.admitted && admittedRight.admitted
    ? operationAdmitted({ left, right })
    : operationViolation(
        "invalid-array-operation",
        `Array equality requires ${selectedFamily} elements`,
      );
}

function concreteArrayElementFamily(
  left: readonly unknown[],
  right: readonly unknown[],
): ScalarComparisonFamily | "incompatible" | undefined {
  let family: ScalarComparisonFamily | undefined;
  for (const element of [...left, ...right]) {
    const current =
      typeof element === "boolean" ||
      typeof element === "string" ||
      typeof element === "number"
        ? elementTypeFamily(element)
        : undefined;
    if (current === undefined) return "incompatible";
    if (family !== undefined && current !== family) return "incompatible";
    family = current;
  }
  return family;
}

function elementTypeFamily(
  value: boolean | string | number,
): ScalarComparisonFamily {
  return typeof value === "boolean"
    ? "boolean"
    : typeof value === "string"
      ? "string"
      : "number";
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
  spec: HostParameterSpec,
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
    case "array": {
      const element = spec.element;
      if (
        element.type !== "boolean" &&
        element.type !== "string" &&
        element.type !== "enum" &&
        element.type !== "number" &&
        element.type !== "artifact"
      ) {
        return undefined;
      }
      return {
        type: "array",
        element:
          element.type === "enum"
            ? { type: "enum", values: element.values }
            : { type: element.type },
      };
    }
    case "tuple":
    case "semanticText":
      return undefined;
  }
}

function judgeSemanticArgument(
  semantic: SemanticString,
  destination: Extract<ChannelSpec, { type: "string" | "enum" }>,
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
  if (destination.type === "enum") return { kind: "unknown" };
  return dynamic ? { kind: "unknown" } : { kind: "compatible" };
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
  if (reference.kind === "channel") {
    const spec = context.signature?.[reference.namespace][reference.key];
    return spec?.type === "array" ? spec.element : undefined;
  }
  const cell = findCell(context, reference.name);
  return cell?.type === "array" ? cell.element : undefined;
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
