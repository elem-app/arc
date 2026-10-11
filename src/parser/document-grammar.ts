import { isHostStructFieldName } from "../spec/host-parameters.js";
import { validateSpec } from "../spec/validation.js";
import type * as IR from "../types/parser.js";
import type { ArrayElementSpec, ChannelSpec } from "../types/spec.js";
import { classifyArtifactPath } from "../types/value.js";
import {
  describeArtifactPathIssue,
  firstInvalidPayloadValue,
} from "../value-utils.js";

type Rule = (
  value: unknown,
  path: string,
  issues: IR.ValidationIssue[],
) => void;
type Fields<T> = { [K in keyof T]-?: Rule };
const fieldPath = (path: string, key: string) =>
  `${path}[${JSON.stringify(key)}]`;
function issue(
  issues: IR.ValidationIssue[],
  path: string,
  detail: string,
  code = "INVALID_DOCUMENT_SHAPE",
) {
  issues.push({ code, message: `Invalid Document at ${path}: ${detail}` });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function predicate(
  test: (value: unknown) => boolean,
  detail: string,
  code?: string,
): Rule {
  return (value, path, issues) => {
    if (!test(value)) issue(issues, path, detail, code);
  };
}
const string = predicate((v) => typeof v === "string", "expected a string");
const name = predicate(
  (v) => typeof v === "string" && v.length > 0,
  "expected a nonempty name",
);
const boolean = predicate((v) => typeof v === "boolean", "expected a boolean");
const number = predicate((v) => typeof v === "number", "expected a number");
const primitive = predicate(
  (v) =>
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean",
  "expected a primitive literal or null",
);
const oneOf = (...values: (string | boolean)[]): Rule =>
  predicate(
    (v) => values.some((x) => x === v),
    `expected ${values.map((v) => JSON.stringify(v)).join(" or ")}`,
  );
const optional =
  (rule: Rule): Rule =>
  (value, path, issues) => {
    if (value !== undefined) rule(value, path, issues);
  };
const lazy =
  (get: () => Rule): Rule =>
  (value, path, issues) =>
    get()(value, path, issues);
function coded(rule: Rule, code: string): Rule {
  return (value, path, issues) => {
    const found: IR.ValidationIssue[] = [];
    rule(value, path, found);
    for (const error of found)
      issues.push({
        ...error,
        code:
          error.code === "INVALID_DOCUMENT_SHAPE" ||
          error.code === "INVALID_EXPRESSION_STRATUM"
            ? code
            : error.code,
      });
  };
}
function refine(rule: Rule, check: Rule): Rule {
  return (value, path, issues) => {
    const before = issues.length;
    rule(value, path, issues);
    if (issues.length === before) check(value, path, issues);
  };
}
function attachLocation(
  value: unknown,
  path: string,
  issues: IR.ValidationIssue[],
  start: number,
): void {
  if (!isRecord(value) || value.loc === undefined) return;
  const found: IR.ValidationIssue[] = [];
  location(value.loc, fieldPath(path, "loc"), found);
  if (found.length === 0)
    for (const error of issues.slice(start))
      error.loc ??= value.loc as IR.SourceRange;
}
function record<T>(fields: Fields<T>): Rule {
  const rules = fields as Record<string, Rule>;
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a record");
      return;
    }
    const before = issues.length;
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rules, key))
        issue(issues, fieldPath(path, key), "unsupported field");
    }
    for (const [key, rule] of Object.entries(rules))
      rule(value[key], fieldPath(path, key), issues);
    if (Object.hasOwn(rules, "loc"))
      attachLocation(value, path, issues, before);
  };
}
function array(rule: Rule, minimum = 0): Rule {
  return (value, path, issues) => {
    if (!Array.isArray(value)) {
      issue(issues, path, "expected an array");
      return;
    }
    if (value.length < minimum)
      issue(issues, path, `expected at least ${minimum} entries`);
    value.forEach((item, index) => rule(item, `${path}[${index}]`, issues));
  };
}
function map(rule: Rule, keyRule: Rule = name): Rule {
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a named map");
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const at = fieldPath(path, key);
      keyRule(key, at, issues);
      rule(item, at, issues);
    }
  };
}
function variants(
  key: string,
  rules: Record<string, Rule>,
  code?: string,
): Rule {
  return (value, path, issues) => {
    if (
      !isRecord(value) ||
      typeof value[key] !== "string" ||
      !Object.hasOwn(rules, value[key])
    ) {
      issue(issues, path, `expected a recognized ${key}`, code);
      return;
    }
    rules[value[key]]!(value, path, issues);
  };
}
const position = record<IR.SourcePosition>({
  line: predicate(
    (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1,
    "line must be a positive safe integer",
  ),
  column: predicate(
    (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    "column must be a non-negative safe integer",
  ),
});
const location: Rule = (value, path, issues) => {
  const before = issues.length;
  record<IR.SourceRange>({ start: position, end: position })(
    value,
    path,
    issues,
  );
  if (issues.length === before) {
    const loc = value as IR.SourceRange;
    if (
      loc.end.line < loc.start.line ||
      (loc.end.line === loc.start.line && loc.end.column < loc.start.column)
    )
      issue(issues, path, "source range ends before it starts");
  }
};
// Missing ids are diagnosed by canonical-id verification; registration stamps a private clone.
const id = optional(string);
const meta = { id, loc: optional(location) };
const target = record<IR.EnterTarget>({
  identifier: name,
  imported: boolean,
  mode: coded(
    oneOf("canonical", "forgetful", "newcopy"),
    "INVALID_TARGET_MODE",
  ),
});
const arrayReference = variants("kind", {
  cell: record<Extract<IR.ArrayReference, { kind: "cell" }>>({
    kind: oneOf("cell"),
    name,
  }),
  channel: record<Extract<IR.ArrayReference, { kind: "channel" }>>({
    kind: oneOf("channel"),
    namespace: oneOf("args", "returns"),
    key: name,
  }),
} satisfies Record<IR.ArrayReference["kind"], Rule>);
const cellTarget: Rule = (value, path, issues) => {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, path, "expected a cell target with a root");
    return;
  }
  name(value[0], `${path}[0]`, issues);
  value
    .slice(1)
    .forEach((item, index) =>
      localExpression(item, `${path}[${index + 1}]`, issues),
    );
};
const payload: Rule = (value, path, issues) => {
  const invalid = firstInvalidPayloadValue(value);
  if (invalid)
    issue(
      issues,
      `${path}${invalid.path === "$" ? "" : invalid.path.slice(1)}`,
      invalid.detail,
      "INVALID_PAYLOAD_VALUE",
    );
};

function expr<K extends IR.ValueExpression["kind"]>(
  fields: Fields<Extract<IR.ValueExpression, { kind: K }>>,
): Rule {
  return record(fields);
}
const valueChild = lazy(() => valueExpression);
const localChild = lazy(() => localExpression);
const semanticChild = lazy(() => semanticString);
const hostChild = lazy(() => hostArgument);
const expressionRules = {
  literal: expr<"literal">({ kind: oneOf("literal"), value: primitive }),
  cell: expr<"cell">({ kind: oneOf("cell"), name }),
  isUnset: expr<"isUnset">({ kind: oneOf("isUnset"), cell: name }),
  channel: expr<"channel">({
    kind: oneOf("channel"),
    namespace: oneOf("args", "returns"),
    key: name,
  }),
  channelIsUnset: expr<"channelIsUnset">({
    kind: oneOf("channelIsUnset"),
    namespace: oneOf("args", "returns"),
    key: name,
  }),
  arrayElementRead: expr<"arrayElementRead">({
    kind: oneOf("arrayElementRead"),
    array: arrayReference,
    index: localChild,
  }),
  arrayLength: expr<"arrayLength">({
    kind: oneOf("arrayLength"),
    array: arrayReference,
  }),
  span: expr<"span">({
    kind: oneOf("span"),
    owner: oneOf("map"),
    key: oneOf("item", "index"),
  }),
  deflectionEscaped: expr<"deflectionEscaped">({
    kind: oneOf("deflectionEscaped"),
    target,
  }),
  dialogCursor: expr<"dialogCursor">({ kind: oneOf("dialogCursor") }),
  dialogTurnsSince: expr<"dialogTurnsSince">({
    kind: oneOf("dialogTurnsSince"),
    metric: oneOf("user", "self", "total"),
    receiver: localChild,
    baseline: localChild,
  }),
  scope: refine(
    expr<"scope">({
      kind: oneOf("scope"),
      name: oneOf("lastUserMessage", "lastTurns"),
      count: optional(
        predicate(
          (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
          "Dialog.lastTurns count must be a non-negative safe integer",
          "INVALID_DIALOG_LAST_TURNS_COUNT",
        ),
      ),
    }),
    (value, path, issues) => {
      const scope = value as Extract<IR.LocalExpression, { kind: "scope" }>;
      if (scope.name !== "lastTurns" && scope.count !== undefined)
        issue(
          issues,
          fieldPath(path, "count"),
          "count belongs to Dialog.lastTurns",
          "INVALID_DIALOG_LAST_TURNS_COUNT",
        );
    },
  ),
  enterCount: expr<"enterCount">({ kind: oneOf("enterCount") }),
  interruptionId: expr<"interruptionId">({ kind: oneOf("interruptionId") }),
  interruptionReason: expr<"interruptionReason">({
    kind: oneOf("interruptionReason"),
  }),
  pendingState: expr<"pendingState">({ kind: oneOf("pendingState") }),
  nodeState: expr<"nodeState">({ kind: oneOf("nodeState"), identifier: name }),
  arithmetic: expr<"arithmetic">({
    kind: oneOf("arithmetic"),
    op: coded(oneOf("+", "-", "*", "/", "%"), "INVALID_ARITHMETIC_OPERATOR"),
    left: valueChild,
    right: valueChild,
  }),
  numericUnary: expr<"numericUnary">({
    kind: oneOf("numericUnary"),
    op: coded(oneOf("-"), "INVALID_NUMERIC_UNARY_OPERATOR"),
    argument: valueChild,
  }),
  judge: expr<"judge">({
    ...meta,
    kind: oneOf("judge"),
    question: semanticChild,
  }),
  "host-call": expr<"host-call">({
    ...meta,
    kind: oneOf("host-call"),
    module: name,
    target: array(name),
    operation: name,
    arguments: coded(array(hostChild), "HOST_CALL_ARGUMENT"),
  }),
  artifact: expr<"artifact">({
    kind: oneOf("artifact"),
    path: (value, path, issues) => {
      coded(valueChild, "INVALID_ARTIFACT_CONSTRUCT_EXPRESSION")(
        value,
        path,
        issues,
      );
      if (
        isRecord(value) &&
        value.kind === "literal" &&
        typeof value.value === "string"
      ) {
        const invalid = classifyArtifactPath(value.value);
        if (invalid)
          issue(
            issues,
            fieldPath(path, "value"),
            describeArtifactPathIssue(invalid),
            "INVALID_ARTIFACT_PATH",
          );
      }
    },
  }),
  "template-string": expr<"template-string">({
    kind: oneOf("template-string"),
    parts: array(lazy(() => valuePart)),
  }),
  arrayLiteral: expr<"arrayLiteral">({
    kind: oneOf("arrayLiteral"),
    elements: array(valueChild),
  }),
  regexTest: expr<"regexTest">({
    kind: oneOf("regexTest"),
    pattern: string,
    flags: string,
    target: localChild,
  }),
  comparison: expr<"comparison">({
    kind: oneOf("comparison"),
    op: coded(
      oneOf("==", "!=", ">", ">=", "<", "<="),
      "INVALID_COMPARISON_OPERATOR",
    ),
    left: valueChild,
    right: valueChild,
  }),
  numIsFinite: expr<"numIsFinite">({
    kind: oneOf("numIsFinite"),
    argument: (v, p, i) =>
      v === undefined
        ? issue(
            i,
            p,
            "expected a value-expression argument",
            "INVALID_NUM_IS_FINITE_EXPRESSION",
          )
        : valueChild(v, p, i),
  }),
  logical: expr<"logical">({
    kind: oneOf("logical"),
    op: coded(oneOf("&&", "||"), "INVALID_LOGICAL_OPERATOR"),
    left: valueChild,
    right: valueChild,
  }),
  conditional: expr<"conditional">({
    kind: oneOf("conditional"),
    test: valueChild,
    consequent: valueChild,
    alternate: valueChild,
  }),
  unary: expr<"unary">({
    kind: oneOf("unary"),
    op: coded(oneOf("!"), "INVALID_LOGICAL_UNARY_OPERATOR"),
    argument: valueChild,
  }),
} satisfies Record<IR.ValueExpression["kind"], Rule>;
const localKinds = {
  literal: true,
  cell: true,
  isUnset: true,
  channel: true,
  channelIsUnset: true,
  arrayElementRead: true,
  arrayLength: true,
  span: true,
  deflectionEscaped: true,
  dialogCursor: true,
  dialogTurnsSince: true,
  scope: true,
  enterCount: true,
  interruptionId: true,
  interruptionReason: true,
  pendingState: true,
  nodeState: true,
  arithmetic: true,
  numericUnary: true,
} satisfies Record<IR.LocalExpression["kind"], true>;
const localExpression: Rule = coded((value, path, issues) => {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !Object.hasOwn(localKinds, value.kind)
  ) {
    issue(issues, path, "expected a local expression");
    return;
  }
  if (value.kind === "arithmetic") {
    record<IR.ArithmeticExpression<IR.LocalExpression>>({
      kind: oneOf("arithmetic"),
      op: coded(oneOf("+", "-", "*", "/", "%"), "INVALID_ARITHMETIC_OPERATOR"),
      left: localChild,
      right: localChild,
    })(value, path, issues);
  } else if (value.kind === "numericUnary") {
    record<IR.NumericUnaryExpression<IR.LocalExpression>>({
      kind: oneOf("numericUnary"),
      op: coded(oneOf("-"), "INVALID_NUMERIC_UNARY_OPERATOR"),
      argument: localChild,
    })(value, path, issues);
  } else
    expressionRules[value.kind as IR.LocalExpression["kind"]](
      value,
      path,
      issues,
    );
}, "INVALID_EXPRESSION_STRATUM");
const valueExpression: Rule = coded((value, path, issues) => {
  variants("kind", expressionRules)(value, path, issues);
  if (
    isRecord(value) &&
    value.kind === "regexTest" &&
    typeof value.pattern === "string" &&
    typeof value.flags === "string"
  ) {
    try {
      new RegExp(value.pattern, value.flags);
    } catch {
      issue(issues, path, "invalid regular expression");
    }
  }
}, "INVALID_EXPRESSION_STRATUM");
const valuePart = variants("kind", {
  text: record<Extract<IR.ValueStringPart, { kind: "text" }>>({
    kind: oneOf("text"),
    value: string,
  }),
  expression: record<Extract<IR.ValueStringPart, { kind: "expression" }>>({
    kind: oneOf("expression"),
    expression: valueChild,
  }),
} satisfies Record<IR.ValueStringPart["kind"], Rule>);
const semanticPart = variants("kind", {
  text: record<Extract<IR.TemplateStringPart, { kind: "text" }>>({
    kind: oneOf("text"),
    value: string,
  }),
  expression: record<Extract<IR.TemplateStringPart, { kind: "expression" }>>({
    kind: oneOf("expression"),
    expression: valueChild,
  }),
  ref: record<Extract<IR.TemplateStringPart, { kind: "ref" }>>({
    kind: oneOf("ref"),
    name: oneOf("user", "self"),
  }),
  hostVar: record<Extract<IR.TemplateStringPart, { kind: "hostVar" }>>({
    kind: oneOf("hostVar"),
    module: name,
    path: array(name, 1),
  }),
} satisfies Record<IR.TemplateStringPart["kind"], Rule>);
const semanticString = variants("kind", {
  literal: record<IR.StringLiteralExpression>({
    kind: oneOf("literal"),
    value: string,
  }),
  "template-string": record<IR.TemplateString>({
    kind: oneOf("template-string"),
    parts: array(semanticPart),
  }),
} satisfies Record<IR.SemanticString["kind"], Rule>);
const hostArgument: Rule = coded(
  variants("kind", {
    value: record<Extract<IR.HostCallArgument, { kind: "value" }>>({
      kind: oneOf("value"),
      value: valueChild,
    }),
    semantic: record<Extract<IR.HostCallArgument, { kind: "semantic" }>>({
      kind: oneOf("semantic"),
      value: semanticChild,
    }),
    array: record<Extract<IR.HostCallArgument, { kind: "array" }>>({
      kind: oneOf("array"),
      elements: array(hostChild),
    }),
    object: record<Extract<IR.HostCallArgument, { kind: "object" }>>({
      kind: oneOf("object"),
      value: map(
        hostChild,
        predicate(
          (v) => typeof v === "string" && isHostStructFieldName(v),
          "invalid Struct field name",
        ),
      ),
    }),
  } satisfies Record<IR.HostCallArgument["kind"], Rule>),
  "HOST_CALL_ARGUMENT",
);

const observeAs: Rule = coded((value, path, issues) => {
  const before = issues.length;
  record<IR.NumericObserveAs>({
    kind: oneOf("number", "integer"),
    min: optional(number),
    max: optional(number),
  })(value, path, issues);
  if (issues.length !== before) return;
  const bounds = value as IR.NumericObserveAs;
  if (
    bounds.min !== undefined &&
    bounds.max !== undefined &&
    bounds.min > bounds.max
  )
    issue(issues, path, "bounds must satisfy min <= max");
  if (bounds.kind === "integer")
    for (const key of ["min", "max"] as const) {
      if (bounds[key] !== undefined && !Number.isSafeInteger(bounds[key]))
        issue(
          issues,
          fieldPath(path, key),
          "integer bound must be a safe integer",
        );
    }
}, "INVALID_NUMERIC_OBSERVE_AS");
type SpecRole = "cell" | "channel" | "cell-element" | "channel-element";
const specTypes = {
  boolean: true,
  string: true,
  enum: true,
  number: true,
  artifact: true,
  dialogCursor: true,
  index: true,
  array: true,
} satisfies Record<
  IR.Cell["type"] | ChannelSpec["type"] | ArrayElementSpec["type"],
  true
>;
function spec(role: SpecRole): Rule {
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a spec record", "INVALID_SPEC");
      return;
    }
    if (value.type === "rangedInt") {
      issue(
        issues,
        path,
        'Source / IR numeric spec must use type "number"; found "rangedInt"',
        "NON_CANONICAL_NUMERIC_SPEC",
      );
      return;
    }
    const type = value.type;
    if (
      typeof type !== "string" ||
      !Object.hasOwn(specTypes, type) ||
      (role === "cell" && type === "index") ||
      (role.endsWith("element") &&
        ["array", "index", "dialogCursor"].includes(type))
    ) {
      issue(
        issues,
        path,
        "unsupported spec type for this role",
        "INVALID_SPEC",
      );
      return;
    }
    const fields: Record<string, Rule> = { type: oneOf(type) };
    if (role === "cell")
      Object.assign(fields, { name, loc: optional(location) });
    if (type === "enum") fields.values = array(string);
    if (type === "array")
      fields.element = spec(
        role === "cell" ? "cell-element" : "channel-element",
      );
    const observable =
      (role === "cell" || role === "cell-element") &&
      ["boolean", "string", "enum", "number"].includes(type);
    if (observable) fields.observing = optional(semanticChild);
    if (observable && type === "number") fields.observeAs = optional(observeAs);
    if (role === "cell" && type === "artifact")
      fields.initializer = optional(
        coded((v, p, i) => {
          if (!isRecord(v) || v.kind !== "artifact")
            issue(i, p, "expected an Artifact constructor");
          else expressionRules.artifact(v, p, i);
        }, "INVALID_ARTIFACT_CELL_SPEC"),
      );
    const before = issues.length;
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key)) {
        issue(
          issues,
          fieldPath(path, key),
          `unsupported field ${JSON.stringify(key)}`,
          key === "observeAs"
            ? "INVALID_NUMERIC_OBSERVE_AS"
            : role === "cell" && type === "artifact" && key === "path"
              ? "INVALID_ARTIFACT_CELL_SPEC"
              : "INVALID_SPEC",
        );
      }
    for (const [key, rule] of Object.entries(fields))
      coded(rule, "INVALID_SPEC")(value[key], fieldPath(path, key), issues);
    if (role === "cell") attachLocation(value, path, issues, before);
    if (issues.length === before) {
      const violation = validateSpec(value);
      if (violation) issue(issues, path, violation.detail, "INVALID_SPEC");
    }
  };
}
function binding(direction: "args" | "returns"): Rule {
  return variants("kind", {
    cell: record<Extract<IR.EnterChannelBindingSource, { kind: "cell" }>>({
      kind: oneOf("cell"),
      cell: name,
    }),
    argsProjection: (value, path, issues) => {
      record<Extract<IR.EnterChannelBindingSource, { kind: "argsProjection" }>>(
        { kind: oneOf("argsProjection"), key: name },
      )(value, path, issues);
      if (direction === "returns")
        issue(issues, path, "an args projection cannot be a returns sink");
    },
    span: record<Extract<IR.EnterChannelBindingSource, { kind: "span" }>>({
      kind: oneOf("span"),
      owner: oneOf("map"),
      key: direction === "args" ? oneOf("item", "index") : oneOf("result"),
    }),
  } satisfies Record<IR.EnterChannelBindingSource["kind"], Rule>);
}
const groupTargets = refine(array(cellTarget, 1), (value, path, issues) => {
  const seen = new Set<string>();
  for (const [index, target] of (value as IR.CellTarget[]).entries()) {
    if (target.length !== 1)
      issue(
        issues,
        `${path}[${index}]`,
        "grouped observation requires direct cell targets",
      );
    if (seen.has(target[0]))
      issue(issues, `${path}[${index}]`, "grouped observation repeats a cell");
    seen.add(target[0]);
  }
});
type Body = "action" | "trigger" | "guard" | "resolution" | "catch" | "effects";
type AnyStatement =
  | IR.Statement
  | IR.TriggerStatement
  | IR.CatchDeflectionStatement
  | IR.EffectStatement;
const body = (role: Body): Rule => array(lazy(() => statement(role)));
function stmt<K extends AnyStatement["kind"]>(
  fields: Fields<Extract<AnyStatement, { kind: K }>>,
): Rule {
  return record(fields);
}
const commonStatement = {
  observe: true,
  observeGroup: true,
  set: true,
  unset: true,
  if: true,
  label: true,
  break: true,
} satisfies Record<IR.HookStatement["kind"], true>;
const actionKinds = {
  ...commonStatement,
  observeOrAsk: true,
  observeOrAskGroup: true,
  "set-return": true,
  "enter-node": true,
  "enter-loop": true,
  instruction: true,
  invoke: true,
  map: true,
  "set-span": true,
  "host-call": true,
} satisfies Record<IR.Statement["kind"], true>;
const triggerKinds = { ...commonStatement, return: true } satisfies Record<
  | IR.TriggerStatement["kind"]
  | IR.GuardStatement["kind"]
  | IR.ResolutionStatement["kind"],
  true
>;
const catchKinds = {
  ...triggerKinds,
  observeOrAsk: true,
  observeOrAskGroup: true,
} satisfies Record<
  IR.CatchDeflectionStatement["kind"] | IR.CatchInterruptionStatement["kind"],
  true
>;
const effectKinds = {
  ...commonStatement,
  "set-return": true,
  "host-call": true,
} satisfies Record<IR.EffectStatement["kind"], true>;
function statement(role: Body): Rule {
  const bindings = {
    args: optional(map(binding("args"))),
    returns: optional(map(binding("returns"))),
  };
  const rules = {
    observe: stmt<"observe">({
      ...meta,
      kind: oneOf("observe"),
      target: cellTarget,
      question: optional(semanticChild),
    }),
    observeOrAsk: stmt<"observeOrAsk">({
      ...meta,
      kind: oneOf("observeOrAsk"),
      target: cellTarget,
      question: optional(semanticChild),
    }),
    observeGroup: stmt<"observeGroup">({
      ...meta,
      kind: oneOf("observeGroup"),
      targets: groupTargets,
    }),
    observeOrAskGroup: stmt<"observeOrAskGroup">({
      ...meta,
      kind: oneOf("observeOrAskGroup"),
      targets: groupTargets,
    }),
    set: stmt<"set">({
      ...meta,
      kind: oneOf("set"),
      target: cellTarget,
      value: valueChild,
    }),
    unset: stmt<"unset">({ ...meta, kind: oneOf("unset"), target: cellTarget }),
    "set-return": stmt<"set-return">({
      ...meta,
      kind: oneOf("set-return"),
      key: name,
      value: valueChild,
    }),
    "set-span": stmt<"set-span">({
      ...meta,
      kind: oneOf("set-span"),
      owner: oneOf("map"),
      value: valueChild,
    }),
    break: stmt<"break">({ ...meta, kind: oneOf("break"), label: name }),
    return: stmt<"return">({
      ...meta,
      kind: oneOf("return"),
      value: optional(valueChild),
    }),
    if: stmt<"if">({
      ...meta,
      kind: oneOf("if"),
      test: valueChild,
      consequent: body(role),
      alternate: optional(body(role)),
    }),
    label: stmt<"label">({
      ...meta,
      kind: oneOf("label"),
      label: name,
      body: body(role),
    }),
    "enter-node": stmt<"enter-node">({
      ...meta,
      ...bindings,
      kind: oneOf("enter-node"),
      target,
    }),
    "enter-loop": stmt<"enter-loop">({
      ...meta,
      ...bindings,
      kind: oneOf("enter-loop"),
      target,
      resolveWhen: body("resolution"),
    }),
    instruction: refine(
      stmt<"instruction">({
        ...meta,
        kind: oneOf("instruction"),
        mode: oneOf("once", "persistent"),
        template: semanticChild,
        hostParams: optional(payload),
        resolveWhen: optional(body("resolution")),
        deflectWhen: optional(body("resolution")),
        inheritedDeflectWhen: optional(boolean),
      }),
      (value, path, issues) => {
        const instruction = value as IR.InstructionAction;
        const resolutionIssue = instructionResolutionIssue(instruction);
        if (resolutionIssue)
          issue(issues, fieldPath(path, "resolveWhen"), resolutionIssue);
        if (
          instruction.inheritedDeflectWhen &&
          instruction.deflectWhen === undefined
        )
          issue(
            issues,
            fieldPath(path, "deflectWhen"),
            "an inherited deflectWhen requires its hook body",
          );
      },
    ),
    invoke: stmt<"invoke">({
      ...meta,
      kind: oneOf("invoke"),
      body: body("action"),
    }),
    map: stmt<"map">({
      ...meta,
      kind: oneOf("map"),
      receiver: arrayReference,
      results: optional(name),
      body: body("action"),
    }),
    "host-call": expressionRules["host-call"],
  } satisfies Record<AnyStatement["kind"], Rule>;
  const allowed =
    role === "action"
      ? actionKinds
      : role === "catch"
        ? catchKinds
        : role === "effects"
          ? effectKinds
          : triggerKinds;
  return (value, path, issues) => {
    if (
      !isRecord(value) ||
      typeof value.kind !== "string" ||
      !Object.hasOwn(allowed, value.kind)
    ) {
      issue(issues, path, `expected a statement allowed in ${role}`);
      return;
    }
    rules[value.kind as AnyStatement["kind"]](value, path, issues);
  };
}
/** Resolution requirements shared by source lowering and public IR. */
export function instructionResolutionIssue(
  instruction: Pick<IR.InstructionAction, "mode" | "resolveWhen">,
): string | undefined {
  if (
    instruction.mode === "persistent" &&
    instruction.resolveWhen === undefined
  )
    return "$instructLoop() requires resolveWhen";
  if (instruction.mode === "once" && instruction.resolveWhen !== undefined)
    return "$instruct() does not support resolveWhen";
  return undefined;
}

/** Channel members whose syntax belongs to other Arc operations. */
export function isReservedChannelKey(key: string): boolean {
  return key === "state" || key === "length" || key === "isUnset";
}
const channelKey = predicate(
  (v) => typeof v === "string" && v.length > 0 && !isReservedChannelKey(v),
  "expected an unreserved channel name",
  "INVALID_CHANNEL_KEY",
);
const signature = record<IR.NodeSignature>({
  args: map(spec("channel"), channelKey),
  returns: map(spec("channel"), channelKey),
});
const node: Rule = lazy(() =>
  record<IR.Node>({
    identifier: name,
    displayName: optional(string),
    description: optional(string),
    guidance: optional(semanticChild),
    hostParams: optional(payload),
    forgetfulEntry: boolean,
    writeDiffMode: coded(oneOf("rewalk", "advance"), "INVALID_WRITE_DIFF_MODE"),
    signature: optional(signature),
    cells: array(spec("cell")),
    statements: body("action"),
    children: array(node),
    newcopyAliases: array(
      record<IR.NewCopyNodeAlias>({
        identifier: name,
        target: name,
        imported: boolean,
      }),
    ),
    imports: array(name),
    trigger: optional(body("trigger")),
    deflectWhen: optional(body("resolution")),
    catchDeflection: optional(body("catch")),
    catchInterruption: optional(body("catch")),
    guard: optional(body("guard")),
    effects: optional(body("effects")),
    loc: optional(location),
  }),
);
const documentGrammar = record<IR.Document>({
  imports: array(
    record<IR.DocumentImport>({
      importedName: name,
      localName: name,
      source: name,
      loc: optional(location),
    }),
  ),
  hostModules: array(
    record<IR.HostModuleBinding>({
      module: name,
      localName: name,
      importedName: oneOf("default"),
      source: name,
      loc: optional(location),
    }),
  ),
  roots: array(node, 1),
});

/** Establishes inert data and the complete Document grammar before typed analysis. */
export function validateDocumentStructure(
  document: unknown,
  issues: IR.ValidationIssue[],
): void {
  // Inspect the caller-owned graph before reads or cloning can invoke accessors
  // or erase unsupported properties. Optional fields may contain undefined.
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();

  const reject = (path: string, detail: string): void => {
    issues.push({
      code: "INVALID_PUBLIC_IR",
      message: `Invalid public IR at ${path}: ${detail}`,
    });
  };

  const visit = (value: unknown, path: string): void => {
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return;
    }
    if (typeof value !== "object") {
      reject(path, `unsupported ${typeof value} value`);
      return;
    }
    if (active.has(value)) {
      reject(path, "cyclic references are not allowed");
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    active.add(value);

    let prototype: object | null;
    let keys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      active.delete(value);
      reject(path, "object shape could not be inspected");
      return;
    }

    const descriptorAt = (key: string): PropertyDescriptor | undefined => {
      try {
        return Object.getOwnPropertyDescriptor(value, key);
      } catch {
        reject(
          `${path}[${JSON.stringify(key)}]`,
          "property descriptor could not be inspected",
        );
        return undefined;
      }
    };

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        reject(path, "arrays must use the ordinary Array prototype");
      } else {
        const length = descriptorAt("length")?.value as number;
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptorAt(String(index));
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            reject(
              `${path}[${index}]`,
              "arrays must contain dense enumerable data elements",
            );
            continue;
          }
          visit(descriptor.value, `${path}[${index}]`);
        }
        for (const key of keys) {
          if (key === "length") continue;
          if (
            typeof key !== "string" ||
            !Number.isSafeInteger(Number(key)) ||
            Number(key) < 0 ||
            String(Number(key)) !== key ||
            Number(key) >= length
          ) {
            reject(
              typeof key === "string"
                ? `${path}[${JSON.stringify(key)}]`
                : path,
              "arrays cannot contain non-element properties",
            );
          }
        }
      }
      active.delete(value);
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      reject(path, "objects must use a plain or null prototype");
      active.delete(value);
      return;
    }
    for (const key of keys) {
      if (typeof key !== "string") {
        reject(path, "objects cannot contain symbol keys");
        continue;
      }
      const descriptor = descriptorAt(key);
      const fieldPath = `${path}[${JSON.stringify(key)}]`;
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        reject(fieldPath, "fields must be enumerable data properties");
        continue;
      }
      visit(descriptor.value, fieldPath);
    }
    active.delete(value);
  };

  visit(document, "$");
  if (issues.length > 0) return;

  // Finiteness has document-wide diagnostic precedence, including opaque payloads.
  const numericSeen = new WeakSet<object>();
  const numbers = (value: unknown, path: string): void => {
    if (typeof value === "number" && !Number.isFinite(value))
      issues.push({
        code: "NON_FINITE_NUMBER",
        message: `Document contains a non-finite number at ${path}`,
      });
    if (value === null || typeof value !== "object" || numericSeen.has(value))
      return;
    numericSeen.add(value);
    if (Array.isArray(value))
      value.forEach((item, index) => numbers(item, `${path}[${index}]`));
    else
      for (const [key, item] of Object.entries(value))
        numbers(item, fieldPath(path, key));
  };
  numbers(document, "$");
  if (issues.length === 0) documentGrammar(document, "$", issues);
}
