import type * as acorn from "acorn";
import { parse as acornParse } from "acorn";

import {
  arithmeticRule,
  artifactPathRule,
  booleanRule,
  comparisonRule,
  interpolationRule,
  judgeHostArgument,
  judgeProducerLanding,
  numIsFiniteRule,
  type ProducerContext,
  producerGuaranteesArtifact,
  resolveHostOperation,
  resolveProducer,
  reusableSpecCompatible,
  stringOperandRule,
} from "../spec/resolution.js";
import { validateSpec } from "../spec/validation.js";
import type {
  ArrayReference,
  BreakStatement,
  CatchDeflectionStatement,
  Cell,
  CellTarget,
  Document,
  DocumentAnalysis,
  DocumentAnalysisOptions,
  EffectStatement,
  ElementId,
  EnterChannelBindings,
  EnterTarget,
  GuardStatement,
  HostCall,
  HostCallArgument,
  HostModuleBinding,
  IfStatement,
  InstructionAction,
  InvokeAction,
  LabelStatement,
  LintIssue,
  MapAction,
  Node,
  NodeReadSet,
  NodeSignature,
  NumericObserveAs,
  ObservableScalar,
  ObserveAction,
  ObserveGroupAction,
  ObserveOrAskAction,
  ObserveOrAskGroupAction,
  ResolutionStatement,
  SegKey,
  SemanticString,
  SetAction,
  SetReturnAction,
  SetSpanAction,
  SourceRange,
  Statement,
  TemplateStringPart,
  TriggerStatement,
  UnsetAction,
  ValidationIssue,
  ValueExpression,
  ValueString,
  WriteDiffMode,
} from "../types/parser.js";
import {
  isArrayCell,
  isScalarObservableCell,
  isValueExpressionCell,
  UNSTAMPED_ID,
} from "../types/parser.js";
import { invokeSegKey, nodeSegKey } from "../types/runtime.js";
import type {
  ArrayElementSpec,
  ArtifactSpec,
  CellSpec,
  ChannelSpec,
  HostModuleSpec,
} from "../types/spec.js";
import {
  cellSpecToChannelSpec,
  isObservableCellSpec,
  isSettableCellSpec,
} from "../types/spec.js";
import {
  classifyArtifactPath,
  type PayloadValue,
  type StructValue,
} from "../types/value.js";
import {
  describeArtifactPathIssue,
  firstInvalidPayloadValue,
} from "../value-utils.js";
import {
  containsBriefableExpression,
  type ExpressionParseContext,
  getBlockStatements,
  getFunctionBody,
  getHookBodyStatements,
  getMemberTarget,
  getThisProperty,
  locOf,
  parseArtifactConstructCall,
  parseCellTarget,
  parseExpression,
  parseHostCallArgument,
  parseHostCallTarget,
  parseSemanticString,
} from "./ast.js";
import {
  lintArcCellReads,
  lintNodeBareCellBooleans,
  lintNodeReadBeforeSet,
  lintNodeStatements,
  lintRootArc,
} from "./lint.js";
import { type EnclosingNode, parseTarget } from "./targets.js";

const HOST_MODULE_SOURCE_PREFIX = "host:";

/** Identifiers whose Arc meaning takes precedence over host-module lookup. */
const ARC_RESERVED_HOST_ALIAS_NAMES: ReadonlySet<string> = new Set([
  "$enter",
  "$enterLoop",
  "$instruct",
  "$instructLoop",
  "$observe",
  "$observeOrAsk",
  "Array",
  "Artifact",
  "Bool",
  "Dialog",
  "Enum",
  "Index",
  "Num",
  "RangedInt",
  "State",
  "Str",
  "args",
  "forgetful",
  "invoke",
  "judge",
  "newcopy",
  "returns",
  "self",
  "span",
  "user",
]);

/**
 * Parses Arc source text into a validated `Document`.
 *
 * This is the high-level entrypoint for authored Arc source. It accepts the
 * Arc-specific JavaScript subset, builds the normalized document IR, then runs
 * semantic validation before returning.
 */
export function parse(source: string): Document {
  const program = acornParse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  }) as acorn.Program;
  assertFiniteNumericLiterals(program);

  if (!hasArcDirective(program.body)) {
    throw new Error('Expected "arc" directive');
  }

  const imports: Document["imports"] = [];
  const hostModules: HostModuleBinding[] = [];

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = String(statement.source.value);
    const isHostModuleImport = source.startsWith(HOST_MODULE_SOURCE_PREFIX);
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        if (isHostModuleImport) {
          assertHostModuleAliasAvailable(specifier.local.name);
          hostModules.push({
            module: parseHostModuleName(source),
            importedName: "default",
            localName: specifier.local.name,
            source,
            loc: locOf(specifier),
          });
          continue;
        }
        throw new Error(
          "Arc does not support default imports; import roots by named binding",
        );
      }
      if (isHostModuleImport) {
        throw new Error(
          "Arc host module imports must use a default import binding",
        );
      }
      if (specifier.type === "ImportSpecifier") {
        const importedName =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : String(specifier.imported.value);
        imports.push({
          importedName,
          localName: specifier.local.name,
          source,
          loc: locOf(specifier),
        });
      }
    }
  }

  const rootFunctions: acorn.FunctionDeclaration[] = [];
  const rootNames = new Set<string>();
  for (const statement of program.body) {
    if (
      statement === program.body[0] ||
      statement.type === "ImportDeclaration"
    ) {
      continue;
    }

    if (statement.type === "FunctionDeclaration") {
      if (!statement.id?.name) {
        throw new Error("Root node declarations must be named");
      }
      if (rootNames.has(statement.id.name)) {
        throw new Error(`Duplicate arc: ${statement.id.name}`);
      }
      rootNames.add(statement.id.name);
      rootFunctions.push(statement);
      continue;
    }

    if (
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      throw new Error(
        "Export syntax is not supported; declare the root node directly",
      );
    }

    if (statement.type === "VariableDeclaration") {
      throw new Error(
        "Document-level cell declarations are not allowed; declare cells directly in a root node body",
      );
    }

    throw new Error(
      "Only imports and root node declarations are allowed at document level",
    );
  }

  if (rootFunctions.length === 0) {
    throw new Error("No root node declarations found");
  }

  const roots = rootFunctions.map((fn) =>
    parseNode(
      fn,
      new Set(imports.map((entry) => entry.localName)),
      new Map(hostModules.map((entry) => [entry.localName, entry.module])),
      new Set(),
      new Set(),
      undefined,
    ),
  );

  for (const root of roots) stampElementIds(root);

  const document: Document = {
    imports,
    hostModules,
    roots,
  };

  const issues = validate(document);
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      first ? `${first.code}: ${first.message}` : "Arc validation failed",
    );
  }

  return document;
}

function assertFiniteNumericLiterals(program: acorn.Program): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { type?: unknown; value?: unknown };
    if (
      node.type === "Literal" &&
      typeof node.value === "number" &&
      !Number.isFinite(node.value)
    ) {
      const error = new Error("Numeric literal must be finite") as Error & {
        code: string;
        loc: SourceRange | undefined;
      };
      error.code = "NON_FINITE_NUMBER";
      error.loc = locOf(value as acorn.Node);
      throw error;
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      visit(item);
    }
  };
  visit(program);
}

/**
 * Validates a parsed `Document` without reparsing source text.
 *
 * This is useful when a caller already has a document and wants structured
 * diagnostics instead of an exception from `parse(...)`. It is a thin wrapper
 * over `analyzeDocument(...)`, which performs the single reference-resolving
 * walk that produces both validation issues and the re-walk plan.
 */
export function validate(document: Document): ValidationIssue[] {
  return analyzeDocument(document).issues;
}

/**
 * Performs the static analysis pass over a parsed `Document`. One
 * reference-resolving walk produces both validation issues and the static
 * re-walk plan (per-node read-sets), so the read-set extraction stays in lockstep
 * with `validateNode`'s scope-tracking recursion rather than drifting in a
 * sibling pass.
 *
 * Neither product is stored on the `Document`; the IR stays pure parser output.
 */
export function analyzeDocument(
  document: Document,
  options: DocumentAnalysisOptions = {},
): DocumentAnalysis {
  const issues: ValidationIssue[] = [];
  const lintIssues: LintIssue[] = [];
  const bySeg = new Map<Node, Map<SegKey, NodeReadSet>>();
  activeReadSet = undefined;
  activeInvokeBuilders = [];
  mapContextStack = [];
  activeSegReadSets = undefined;
  validatePublicDocumentGraph(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  validatePublicHostModuleBindings(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  if (options.hostModules !== undefined) {
    validateDeclaredHostModules(document, options.hostModules, issues);
    if (issues.length > 0) {
      return { issues, lintIssues, rewalkPlan: { bySeg } };
    }
  }
  validatePublicNumericIr(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  validateDocumentSpecs(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  validateDocumentShape(document, issues);
  const documentImportNames = new Set(
    document.imports.map((entry) => entry.localName),
  );
  for (const root of document.roots) {
    verifyElementIds(root, issues);
    lintRootArc(root, lintIssues);
    lintArcCellReads(root, lintIssues);
    validateNode(root, {
      issues,
      lintIssues,
      cells: [],
      visibleLocalNodes: new Set(),
      visibleImportNames: new Set(),
      documentImportNames,
      nodeLookup: new Map(
        root.children.map((child) => [child.identifier, child]),
      ),
      bySeg,
      hostModules: options.hostModules,
    });
  }
  return { issues, lintIssues, rewalkPlan: { bySeg } };
}

/**
 * Validates the caller-owned IR graph before any clone can erase accessors,
 * symbols, non-enumerable fields, sparse arrays, custom prototypes, or cycles.
 * Optional properties may be present with an `undefined` data value.
 */
function validatePublicDocumentGraph(
  document: Document,
  issues: ValidationIssue[],
): void {
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

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        reject(path, "arrays must use the ordinary Array prototype");
      } else {
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
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
            Number(key) >= value.length
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
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const fieldPath = `${path}[${JSON.stringify(key)}]`;
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        reject(fieldPath, "fields must be enumerable data properties");
        continue;
      }
      if (key === "hostParams") {
        const payloadIssue = firstInvalidPayloadValue(descriptor.value);
        if (payloadIssue) {
          issues.push({
            code: "INVALID_PAYLOAD_VALUE",
            message: `Invalid hostParams payload at ${fieldPath}${
              payloadIssue.path === "$" ? "" : payloadIssue.path.slice(1)
            }: ${payloadIssue.detail}`,
          });
        }
        continue;
      }
      visit(descriptor.value, fieldPath);
    }
    active.delete(value);
  };

  visit(document, "$");
}

function validateDocumentSpecs(
  document: Document,
  issues: ValidationIssue[],
): void {
  const visit = (node: Node): void => {
    for (const cell of node.cells) {
      const violation = validateSpec(cell);
      if (violation) {
        issues.push({
          code: "INVALID_SPEC",
          message: `Invalid spec for cell ${cell.name}: ${violation.detail}`,
          loc: cell.loc,
        });
      }
      validateArtifactArrayElementShape(
        cell,
        `cell ${cell.name}`,
        cell.loc,
        issues,
      );
    }
    for (const namespace of ["args", "returns"] as const) {
      for (const [key, spec] of Object.entries(
        node.signature?.[namespace] ?? {},
      )) {
        const violation = validateSpec(spec);
        if (violation) {
          issues.push({
            code: "INVALID_SPEC",
            message: `Invalid spec for ${namespace}.${key}: ${violation.detail}`,
          });
        }
        validateArtifactArrayElementShape(
          spec,
          `${namespace}.${key}`,
          undefined,
          issues,
        );
      }
    }
    node.children.forEach(visit);
  };
  document.roots.forEach(visit);
}

function validateArtifactArrayElementShape(
  spec: unknown,
  owner: string,
  loc: SourceRange | undefined,
  issues: ValidationIssue[],
): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
  const object = spec as Record<string, unknown>;
  if (object.type !== "array") return;
  const element = object.element;
  if (!element || typeof element !== "object" || Array.isArray(element)) return;
  const elementObject = element as Record<string, unknown>;
  if (elementObject.type !== "artifact") return;
  const unsupported = Object.keys(elementObject).find((key) => key !== "type");
  if (unsupported === undefined) return;
  issues.push({
    code: "INVALID_SPEC",
    message: `Invalid spec for ${owner}: Artifact array element does not support ${JSON.stringify(unsupported)}`,
    loc,
  });
}

function validatePublicNumericIr(
  document: Document,
  issues: ValidationIssue[],
): void {
  const numericSeen = new WeakSet<object>();
  const scanNumbers = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        issues.push({
          code: "NON_FINITE_NUMBER",
          message: `Document contains a non-finite number at ${path}`,
        });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (numericSeen.has(value)) return;
    numericSeen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => scanNumbers(item, `${path}[${index}]`));
      return;
    }
    for (const key of Object.keys(value)) {
      scanNumbers(
        (value as Record<string, unknown>)[key],
        `${path}[${JSON.stringify(key)}]`,
      );
    }
  };
  scanNumbers(document, "$");
  if (issues.length > 0) return;

  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.type === "rangedInt") {
      issues.push({
        code: "NON_CANONICAL_NUMERIC_SPEC",
        message: `Source / IR numeric spec at ${path} must use type "number"; found "rangedInt"`,
      });
    }
    if (object.type === "number" && "observeAs" in object) {
      validatePublicObserveAs(object.observeAs, `${path}["observeAs"]`, issues);
    } else if ("observeAs" in object) {
      issues.push({
        code: "INVALID_NUMERIC_OBSERVE_AS",
        message: `Invalid numeric observeAs at ${path}: unsupported field "observeAs"`,
      });
    }
    validatePublicArtifactCellSpec(object, path, issues);
    validatePublicExpressionObject(object, path, issues);
    validateLocalConsumerShapes(object, path, issues);
    for (const key of Object.keys(object)) {
      // `hostParams` is an opaque PayloadValue boundary. The number-admission
      // walk above still descends through it, but Source / IR schema and
      // expression rules must not interpret payload keys such as `type`,
      // `observeAs`, `kind`, or `op`.
      if (key === "hostParams") {
        const payloadIssue = firstInvalidPayloadValue(object[key]);
        if (payloadIssue) {
          issues.push({
            code: "INVALID_PAYLOAD_VALUE",
            message: `Invalid hostParams payload at ${path}[${JSON.stringify(key)}]${payloadIssue.path === "$" ? "" : payloadIssue.path.slice(1)}: ${payloadIssue.detail}`,
          });
        }
        continue;
      }
      visit(object[key], `${path}[${JSON.stringify(key)}]`);
    }
  };
  visit(document, "$");
  document.roots.forEach((root, index) =>
    validateNodeChannelObserveAs(root, `$["roots"][${index}]`, issues),
  );
}

function validateNodeChannelObserveAs(
  node: Node,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const namespace of ["args", "returns"] as const) {
    for (const [key, spec] of Object.entries(
      node.signature?.[namespace] ?? {},
    )) {
      validateChannelObserveAs(
        spec,
        `${path}["signature"][${JSON.stringify(namespace)}][${JSON.stringify(key)}]`,
        issues,
      );
    }
  }
  node.children.forEach((child, index) =>
    validateNodeChannelObserveAs(
      child,
      `${path}["children"][${index}]`,
      issues,
    ),
  );
}

function validateChannelObserveAs(
  spec: ChannelSpec,
  path: string,
  issues: ValidationIssue[],
): void {
  if ("observeAs" in (spec as unknown as Record<string, unknown>)) {
    issues.push({
      code: "INVALID_NUMERIC_OBSERVE_AS",
      message: `Invalid numeric observeAs at ${path}: unsupported field "observeAs"`,
    });
  }
  if (spec.type === "array") {
    validateChannelObserveAs(spec.element, `${path}["element"]`, issues);
  }
}

function validatePublicObserveAs(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  const fail = (detail: string): void => {
    issues.push({
      code: "INVALID_NUMERIC_OBSERVE_AS",
      message: `Invalid numeric observeAs at ${path}: ${detail}`,
    });
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("expected an object");
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== "kind" && key !== "min" && key !== "max") {
      fail(`unsupported field ${JSON.stringify(key)}`);
    }
  }
  if (object.kind !== "number" && object.kind !== "integer") {
    fail('kind must be "number" or "integer"');
    return;
  }
  for (const bound of ["min", "max"] as const) {
    if (object[bound] !== undefined && typeof object[bound] !== "number") {
      fail(`${bound} must be a number`);
    }
  }
  const min = typeof object.min === "number" ? object.min : undefined;
  const max = typeof object.max === "number" ? object.max : undefined;
  if (min !== undefined && max !== undefined && min > max) {
    fail("bounds must satisfy min <= max");
  }
  if (object.kind === "integer") {
    if (min !== undefined && !Number.isSafeInteger(min)) {
      fail("integer min must be a safe integer");
    }
    if (max !== undefined && !Number.isSafeInteger(max)) {
      fail("integer max must be a safe integer");
    }
  }
}

function validatePublicArtifactCellSpec(
  object: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (object.type !== "artifact" || typeof object.name !== "string") return;
  if ("path" in object) {
    issues.push({
      code: "INVALID_ARTIFACT_CELL_SPEC",
      message: `Invalid Artifact cell at ${path}: declaration path expressions belong under "initializer"`,
    });
  }
  if (
    object.initializer !== undefined &&
    (!isPublicValueExpression(object.initializer) ||
      (object.initializer as Record<string, unknown>).kind !== "artifact")
  ) {
    issues.push({
      code: "INVALID_ARTIFACT_CELL_SPEC",
      message: `Invalid Artifact cell at ${path}: initializer must be omitted or an Artifact constructor expression`,
    });
  }
}

function validatePublicExpressionObject(
  object: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  const requireValue = (field: string): void => {
    if (!isPublicValueExpression(object[field])) {
      issues.push({
        code: "INVALID_EXPRESSION_STRATUM",
        message: `Expression at ${path}[${JSON.stringify(field)}] is not valid in the value expression stratum`,
      });
    }
  };
  const requireLocal = (field: string): void => {
    if (!isPublicLocalExpression(object[field])) {
      issues.push({
        code: "INVALID_EXPRESSION_STRATUM",
        message: `Expression at ${path}[${JSON.stringify(field)}] is not valid in the local expression stratum`,
      });
    }
  };
  const invalidOperator = (code: string, label: string): void => {
    issues.push({
      code,
      message: `Invalid ${label} operator ${JSON.stringify(object.op)} at ${path}`,
    });
  };
  if (object.kind === "artifact") {
    if (!isPublicValueExpression(object.path)) {
      issues.push({
        code: "INVALID_ARTIFACT_CONSTRUCT_EXPRESSION",
        message: `Invalid Artifact constructor at ${path}: path must be a value expression`,
      });
    } else if (
      object.path !== null &&
      typeof object.path === "object" &&
      !Array.isArray(object.path) &&
      (object.path as Record<string, unknown>).kind === "literal" &&
      typeof (object.path as Record<string, unknown>).value === "string"
    ) {
      const issue = classifyArtifactPath(
        (object.path as Record<string, unknown>).value as string,
      );
      if (issue !== undefined) {
        issues.push({
          code: "INVALID_ARTIFACT_PATH",
          message: `Invalid Artifact constructor at ${path}["path"]: ${describeArtifactPathIssue(issue)}`,
        });
      }
    }
  }
  if (
    object.kind === "comparison" &&
    object.op !== "==" &&
    object.op !== "!=" &&
    object.op !== ">" &&
    object.op !== ">=" &&
    object.op !== "<" &&
    object.op !== "<="
  ) {
    invalidOperator("INVALID_COMPARISON_OPERATOR", "comparison");
  }
  if (
    object.kind === "arithmetic" &&
    object.op !== "+" &&
    object.op !== "-" &&
    object.op !== "*" &&
    object.op !== "/" &&
    object.op !== "%"
  ) {
    invalidOperator("INVALID_ARITHMETIC_OPERATOR", "arithmetic");
  }
  if (object.kind === "arithmetic") {
    for (const side of ["left", "right"] as const) {
      requireValue(side);
    }
  }
  if (
    object.kind === "numericUnary" &&
    !isPublicValueExpression(object.argument)
  ) {
    issues.push({
      code: "INVALID_EXPRESSION_STRATUM",
      message: `Expression at ${path}["argument"] is not valid in the value expression stratum`,
    });
  }
  if (object.kind === "logical" && object.op !== "&&" && object.op !== "||") {
    invalidOperator("INVALID_LOGICAL_OPERATOR", "logical");
  }
  if (object.kind === "numericUnary" && object.op !== "-") {
    invalidOperator("INVALID_NUMERIC_UNARY_OPERATOR", "numeric unary");
  }
  if (object.kind === "unary" && object.op !== "!") {
    invalidOperator("INVALID_LOGICAL_UNARY_OPERATOR", "logical unary");
  }
  if (object.kind === "comparison" || object.kind === "logical") {
    requireValue("left");
    requireValue("right");
  }
  if (object.kind === "conditional") {
    requireValue("test");
    requireValue("consequent");
    requireValue("alternate");
  }
  if (object.kind === "if") requireValue("test");
  if (object.kind === "set" || object.kind === "set-return") {
    requireValue("value");
  }
  if (
    object.kind === "return" &&
    object.value !== undefined &&
    object.value !== null
  ) {
    requireValue("value");
  }
  if (object.kind === "value") requireValue("value");
  if (object.kind === "unary") requireValue("argument");
  if (object.kind === "regexTest") requireLocal("target");
  if (object.kind === "dialogTurnsSince") {
    requireLocal("receiver");
    requireLocal("baseline");
  }
  if (object.kind === "arrayLiteral") {
    if (!Array.isArray(object.elements)) {
      issues.push({
        code: "INVALID_EXPRESSION_STRATUM",
        message: `Expression at ${path}["elements"] is not valid in the value expression stratum`,
      });
    } else {
      object.elements.forEach((element, index) => {
        if (!isPublicValueExpression(element)) {
          issues.push({
            code: "INVALID_EXPRESSION_STRATUM",
            message: `Expression at ${path}["elements"][${index}] is not valid in the value expression stratum`,
          });
        }
      });
    }
  }
  if (object.kind === "numIsFinite") {
    if (!("argument" in object)) {
      issues.push({
        code: "INVALID_NUM_IS_FINITE_EXPRESSION",
        message: `Invalid Num.isFinite expression at ${path}: expected one value-expression argument`,
      });
    } else if (!isPublicValueExpression(object.argument)) {
      issues.push({
        code: "INVALID_EXPRESSION_STRATUM",
        message: `Expression at ${path}["argument"] is not valid in the value expression stratum`,
      });
    }
  }
  if (
    object.kind === "scope" &&
    object.name === "lastTurns" &&
    object.count !== undefined &&
    (typeof object.count !== "number" ||
      !Number.isSafeInteger(object.count) ||
      object.count < 0)
  ) {
    issues.push({
      code: "INVALID_DIALOG_LAST_TURNS_COUNT",
      message: `Dialog.lastTurns count at ${path}["count"] must be a non-negative safe integer`,
    });
  }
}

function validateLocalConsumerShapes(
  object: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  const check = (value: unknown, valuePath: string): void => {
    if (!isPublicLocalExpression(value)) {
      issues.push({
        code: "INVALID_EXPRESSION_STRATUM",
        message: `Expression at ${valuePath} is not valid in the local expression stratum`,
      });
    }
  };
  if (object.kind === "arrayElementRead") {
    check(object.index, `${path}["index"]`);
  }
  if (
    (object.kind === "set" ||
      object.kind === "unset" ||
      object.kind === "observe" ||
      object.kind === "observeOrAsk") &&
    Array.isArray(object.target)
  ) {
    object.target
      .slice(1)
      .forEach((item, index) => check(item, `${path}["target"][${index + 1}]`));
  }
  if (
    (object.kind === "observeGroup" || object.kind === "observeOrAskGroup") &&
    Array.isArray(object.targets)
  ) {
    object.targets.forEach((target, targetIndex) => {
      if (!Array.isArray(target)) return;
      target
        .slice(1)
        .forEach((item, index) =>
          check(item, `${path}["targets"][${targetIndex}][${index + 1}]`),
        );
    });
  }
}

function isPublicLocalExpression(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expression = value as Record<string, unknown>;
  if (expression.kind === "arithmetic") {
    return (
      isPublicLocalExpression(expression.left) &&
      isPublicLocalExpression(expression.right)
    );
  }
  if (expression.kind === "numericUnary") {
    return isPublicLocalExpression(expression.argument);
  }
  return (
    expression.kind === "literal" ||
    expression.kind === "cell" ||
    expression.kind === "isUnset" ||
    expression.kind === "channel" ||
    expression.kind === "channelIsUnset" ||
    expression.kind === "arrayElementRead" ||
    expression.kind === "arrayLength" ||
    expression.kind === "span" ||
    expression.kind === "deflectionEscaped" ||
    expression.kind === "dialogCursor" ||
    expression.kind === "dialogTurnsSince" ||
    expression.kind === "scope" ||
    expression.kind === "enterCount" ||
    expression.kind === "pendingState" ||
    expression.kind === "nodeState"
  );
}

function isPublicValueExpression(value: unknown): boolean {
  if (isPublicLocalExpression(value)) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expression = value as Record<string, unknown>;
  if (expression.kind === "arithmetic") {
    return (
      isPublicValueExpression(expression.left) &&
      isPublicValueExpression(expression.right)
    );
  }
  if (expression.kind === "numericUnary") {
    return isPublicValueExpression(expression.argument);
  }
  if (expression.kind === "template-string") {
    return isPublicValueString(expression);
  }
  if (expression.kind === "artifact") {
    return isPublicValueExpression(expression.path);
  }
  return (
    expression.kind === "judge" ||
    expression.kind === "host-call" ||
    expression.kind === "arrayLiteral" ||
    expression.kind === "regexTest" ||
    expression.kind === "comparison" ||
    expression.kind === "logical" ||
    expression.kind === "conditional" ||
    expression.kind === "unary" ||
    expression.kind === "numIsFinite"
  );
}

/** Validates an untrusted public value-template shape before typed walkers use it. */
function isPublicValueString(value: unknown): value is ValueString {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expression = value as Record<string, unknown>;
  if (
    expression.kind !== "template-string" ||
    !Array.isArray(expression.parts)
  ) {
    return false;
  }
  return expression.parts.every((valuePart) => {
    if (
      valuePart === null ||
      typeof valuePart !== "object" ||
      Array.isArray(valuePart)
    ) {
      return false;
    }
    const part = valuePart as Record<string, unknown>;
    if (part.kind === "text") return typeof part.value === "string";
    return (
      part.kind === "expression" && isPublicValueExpression(part.expression)
    );
  });
}

/**
 * Mutable read-set accumulator for the node whose SEGs are currently being
 * validated. `validateExpression` records each condition-readable reference into
 * it. `validate(...)`-only callers never set it, so collection is a no-op there.
 */
type ReadSetBuilder = {
  cells: Set<string>;
  nodeIdentifiers: Set<string>;
  channels: Map<string, { namespace: "args" | "returns"; key: string }>;
};

let activeReadSet: ReadSetBuilder | undefined;

/**
 * Builders for the invoke bodies currently being descended, innermost last.
 * A read inside a body belongs to that body's local set and to every
 * enclosing set — the enclosing SEG re-runs the invoke whenever it re-walks,
 * so anything a body reads is live for every level above it.
 */
let activeInvokeBuilders: ReadSetBuilder[] = [];

/**
 * The `$map` callback bodies currently being validated, innermost last. `span.*`
 * is a scoped reserved namespace, so a `span` read or write is admitted only
 * while this is non-empty; outside a callback it is a placement error. Each
 * entry carries the element schemas of the map's receiver and `results`, which
 * type `span.item` and `span.result`.
 */
type MapValidationContext = {
  receiverSpec?: ArrayElementSpec;
  resultsSpec?: ArrayElementSpec;
};
let mapContextStack: MapValidationContext[] = [];

/** The per-SEG read-sets collected for the node currently being validated. */
let activeSegReadSets: Map<SegKey, NodeReadSet> | undefined;

function recordCellRead(name: string): void {
  activeReadSet?.cells.add(name);
  for (const builder of activeInvokeBuilders) builder.cells.add(name);
}

function recordNodeStateRead(identifier: string): void {
  activeReadSet?.nodeIdentifiers.add(identifier);
  for (const builder of activeInvokeBuilders) {
    builder.nodeIdentifiers.add(identifier);
  }
}

function recordChannelRead(namespace: "args" | "returns", key: string): void {
  activeReadSet?.channels.set(`${namespace}.${key}`, { namespace, key });
  for (const builder of activeInvokeBuilders) {
    builder.channels.set(`${namespace}.${key}`, { namespace, key });
  }
}

function finalizeReadSet(builder: ReadSetBuilder): NodeReadSet {
  return {
    cells: [...builder.cells],
    nodeIdentifiers: [...builder.nodeIdentifiers],
    channels: [...builder.channels.values()],
  };
}

function hasArcDirective(
  body: Array<acorn.Statement | acorn.ModuleDeclaration>,
): boolean {
  const first = body[0];
  if (!first || first.type !== "ExpressionStatement") return false;
  const expression = first.expression;
  if (expression.type !== "Literal" || typeof expression.value !== "string") {
    return false;
  }
  return expression.value === "arc";
}

function parseHostModuleName(source: string): string {
  const module = source.slice(HOST_MODULE_SOURCE_PREFIX.length);
  if (!module) {
    throw new Error("Host module import source must include a module name");
  }
  return module;
}

function assertHostModuleAliasAvailable(localName: string): void {
  if (ARC_RESERVED_HOST_ALIAS_NAMES.has(localName)) {
    throw new Error(
      `Host module alias ${JSON.stringify(localName)} is reserved by Arc`,
    );
  }
}

function validatePublicHostModuleBindings(
  document: Document,
  issues: ValidationIssue[],
): void {
  for (const binding of document.hostModules) {
    if (!ARC_RESERVED_HOST_ALIAS_NAMES.has(binding.localName)) continue;
    issues.push({
      code: "RESERVED_HOST_MODULE_ALIAS",
      message: `Host module alias ${JSON.stringify(binding.localName)} is reserved by Arc`,
      loc: binding.loc,
    });
  }
}

function validateDeclaredHostModules(
  document: Document,
  hostModules: ReadonlyMap<string, HostModuleSpec>,
  issues: ValidationIssue[],
): void {
  for (const binding of document.hostModules) {
    if (hostModules.has(binding.module)) continue;
    issues.push({
      code: "HOST_MODULE_UNDECLARED",
      message: `Host module ${JSON.stringify(binding.module)} has no injected declaration`,
      loc: binding.loc,
    });
  }
}

function parseNode(
  fn: acorn.FunctionDeclaration | acorn.AnonymousFunctionDeclaration,
  availableImports: Set<string>,
  availableHostModules: Map<string, string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  inheritedDeflectWhen?: ResolutionStatement[],
): Node {
  if (!fn.id?.name) {
    throw new Error("Node declarations must be named");
  }
  if (fn.id.name === "invoke") {
    throw new Error("invoke is a reserved name and cannot name a node");
  }

  const signature = parseNodeSignature(fn.params);

  const cells: Cell[] = [];
  const childFunctions = new Map<string, acorn.FunctionDeclaration>();
  let forgetfulEntry = false;
  const writeDiffMode: WriteDiffMode = "advance";
  let displayName: string | undefined;
  let description: string | undefined;
  let guidance: SemanticString | undefined;
  let hostParams: PayloadValue | undefined;
  let trigger: TriggerStatement[] | undefined;
  let deflectWhen: ResolutionStatement[] | undefined;
  let catchDeflection: CatchDeflectionStatement[] | undefined;
  let catchDeflectionBody: acorn.Statement[] | undefined;
  let guard: GuardStatement[] | undefined;
  let effects: EffectStatement[] | undefined;
  let effectsBody: acorn.Statement[] | undefined;
  const seenNodeConfigAssignments = new Set<string>();
  const handledStatements = new Set<acorn.Statement>();

  for (const statement of fn.body.body) {
    if (statement.type === "VariableDeclaration") {
      const parsedCells = parseCellDeclarations(
        statement,
        availableHostModules,
      );
      if (parsedCells.length !== statement.declarations.length) {
        throw new Error(
          "Node-body declarations must use supported Arc cell constructors",
        );
      }
      cells.push(...parsedCells);
      handledStatements.add(statement);
      continue;
    }

    if (statement.type === "FunctionDeclaration" && statement.id) {
      childFunctions.set(statement.id.name, statement);
      handledStatements.add(statement);
      continue;
    }

    if (statement.type !== "ExpressionStatement") continue;
    const expression = statement.expression;
    if (
      expression.type !== "AssignmentExpression" ||
      expression.operator !== "="
    ) {
      continue;
    }

    const thisProperty = getThisProperty(expression.left as acorn.Expression);
    if (thisProperty === "observing") {
      throw new Error(
        "this.observing is not supported in Arc; use cell.observing for extraction guidance or this.guidance for node guidance",
      );
    }
    if (
      thisProperty === "displayName" ||
      thisProperty === "description" ||
      thisProperty === "guidance" ||
      thisProperty === "hostParams" ||
      thisProperty === "forgetfulEntry" ||
      thisProperty === "trigger" ||
      thisProperty === "deflectWhen" ||
      thisProperty === "catchDeflection" ||
      thisProperty === "guard" ||
      thisProperty === "effects"
    ) {
      if (seenNodeConfigAssignments.has(thisProperty)) {
        throw new Error(
          `Duplicate node config assignment: this.${thisProperty}`,
        );
      }
      seenNodeConfigAssignments.add(thisProperty);
    }
    if (thisProperty === "displayName") {
      if (
        expression.right.type !== "Literal" ||
        typeof expression.right.value !== "string"
      ) {
        throw new Error("this.displayName must be a string literal");
      }
      displayName = expression.right.value;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "description") {
      if (
        expression.right.type !== "Literal" ||
        typeof expression.right.value !== "string"
      ) {
        throw new Error("this.description must be a string literal");
      }
      description = expression.right.value;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "guidance") {
      guidance = parseSemanticString(expression.right, availableHostModules);
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "hostParams") {
      hostParams = parseHostParamsValue(expression.right, "this.hostParams");
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "forgetfulEntry") {
      if (
        expression.right.type !== "Literal" ||
        typeof expression.right.value !== "boolean"
      ) {
        throw new Error("this.forgetfulEntry must be a boolean literal");
      }
      forgetfulEntry = expression.right.value;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "trigger") {
      trigger = parseTriggerArrowFunction(
        expression.right,
        "this.trigger",
        availableHostModules,
      );
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "deflectWhen") {
      deflectWhen = parseResolutionDefinition(
        expression.right,
        "this.deflectWhen",
        availableHostModules,
      );
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "catchDeflection") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.catchDeflection must be an arrow function");
      }
      const body = getHookBodyStatements(expression.right, "return");
      if (!body) throw new Error("this.catchDeflection must be a function");
      catchDeflectionBody = body;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "guard") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.guard must be an arrow function");
      }
      const body = getHookBodyStatements(expression.right, "return");
      if (!body) throw new Error("this.guard must be a function");
      guard = parseGuardStatements(body, availableHostModules);
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "effects") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.effects must be an arrow function");
      }
      const body = getHookBodyStatements(expression.right, "expression");
      if (!body) throw new Error("this.effects must be a function");
      effectsBody = body;
      handledStatements.add(statement);
      continue;
    }

    const member = getMemberTarget(expression.left as acorn.Expression);
    if (member?.property === "observing") {
      const cell = cells.find((entry) => entry.name === member.object);
      if (!cell) {
        throw new Error(
          `Unknown cell for observing assignment: ${member.object}`,
        );
      }
      if (!isScalarObservableCell(cell)) {
        throw new Error(
          `${member.object}.observing is only supported for scalar observable cells`,
        );
      }
      if (cell.observing !== undefined) {
        throw new Error(
          `Duplicate cell config assignment: ${member.object}.observing`,
        );
      }
      cell.observing = parseSemanticString(
        expression.right,
        availableHostModules,
      );
      handledStatements.add(statement);
    }
  }

  const effectiveDeflectWhen = deflectWhen ?? inheritedDeflectWhen;
  const nextVisibleNodeNames = new Set([
    ...visibleNodeNames,
    ...childFunctions.keys(),
  ]);
  const nextVisibleCellNames = new Set([
    ...visibleCellNames,
    ...cells.map((entry) => entry.name),
  ]);
  const enclosing: EnclosingNode = {
    identifier: fn.id.name,
    childNames: new Set(childFunctions.keys()),
  };
  if (catchDeflectionBody) {
    catchDeflection = parseCatchDeflectionStatements(
      catchDeflectionBody,
      availableHostModules,
      availableImports,
      nextVisibleNodeNames,
      enclosing,
    );
  }
  if (effectsBody) {
    effects = parseEffectStatements(effectsBody, availableHostModules, {
      allowPendingState: true,
      deflectionTargets: {
        availableImports,
        visibleNodeNames: nextVisibleNodeNames,
        enclosing,
      },
    });
  }
  const childFunctionNodes = [...childFunctions.values()].map((child) =>
    parseNode(
      child,
      availableImports,
      availableHostModules,
      nextVisibleNodeNames,
      nextVisibleCellNames,
      effectiveDeflectWhen,
    ),
  );
  const statements = fn.body.body.flatMap((statement) =>
    parseNodeStatement(
      statement,
      childFunctions,
      handledStatements,
      availableImports,
      nextVisibleNodeNames,
      nextVisibleCellNames,
      availableHostModules,
      effectiveDeflectWhen,
      enclosing,
    ),
  );
  const children = [...childFunctionNodes];

  return {
    identifier: fn.id.name,
    displayName,
    description,
    guidance,
    hostParams,
    forgetfulEntry,
    writeDiffMode,
    signature,
    cells,
    statements,
    children,
    // Rebuilt by stampElementIds once ids are stamped; aliases embed ids.
    newcopyAliases: [],
    imports: [...availableImports],
    trigger,
    deflectWhen,
    catchDeflection,
    guard,
    effects,
    loc: locOf(fn),
  };
}

/**
 * Parses a node's `args = {…}` / `returns = {…}` defaulted parameters into a
 * typed {@link NodeSignature}. A node may declare `args`, `returns`, both, or
 * neither; when both are present `args` must precede `returns`, and no other
 * parameter names are admitted. Each declared parameter requires an
 * object-literal default whose values are constructed channel specs. Returns
 * `undefined` for a bare (parameterless) node.
 */
function parseNodeSignature(
  params: readonly acorn.Pattern[],
): NodeSignature | undefined {
  if (params.length === 0) return undefined;
  let args: Record<string, ChannelSpec> | undefined;
  let returns: Record<string, ChannelSpec> | undefined;
  for (const param of params) {
    if (
      param.type !== "AssignmentPattern" ||
      param.left.type !== "Identifier"
    ) {
      throw new Error(
        "Node parameters must be `args = { … }` and/or `returns = { … }` with object-literal channel schemas",
      );
    }
    const name = param.left.name;
    if (name !== "args" && name !== "returns") {
      throw new Error(`Unsupported node parameter: ${name}`);
    }
    if (param.right.type !== "ObjectExpression") {
      throw new Error(`Node ${name} must default to an object-literal schema`);
    }
    if (name === "args") {
      if (args) throw new Error("Duplicate node parameter: args");
      if (returns) throw new Error("Node args must precede returns");
      args = parseChannelSchema(param.right, "args");
    } else {
      if (returns) throw new Error("Duplicate node parameter: returns");
      returns = parseChannelSchema(param.right, "returns");
    }
  }
  return { args: args ?? {}, returns: returns ?? {} };
}

/** Parses one `args`/`returns` object literal into a channel-key → spec map. */
function parseChannelSchema(
  object: acorn.ObjectExpression,
  namespace: "args" | "returns",
): Record<string, ChannelSpec> {
  const schema: Record<string, ChannelSpec> = {};
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${namespace} schema does not support spread`);
    }
    if (property.computed || property.key.type !== "Identifier") {
      throw new Error(`${namespace} schema keys must be plain identifiers`);
    }
    const key = property.key.name;
    if (schema[key]) {
      throw new Error(`${namespace} schema has duplicate key: ${key}`);
    }
    // These names collide with member-access syntax the channel read grammar
    // reserves (`args.state` is a node-state read, `args.length` an array-length
    // read, `args.isUnset()` the channel-unset check), so a channel key cannot
    // use them.
    if (key === "state" || key === "length" || key === "isUnset") {
      throw new Error(
        `${namespace} schema key "${key}" is reserved and cannot name a channel`,
      );
    }
    schema[key] = parseChannelSpec(property.value, `${namespace}.${key}`);
  }
  return schema;
}

/**
 * Parses one channel spec constructor: `Bool()`, `Str()`, `Enum([...])`,
 * `Num()`, `Artifact()`, `Dialog.Cursor()`, `Index()`, or
 * `Array(elementSpec)`.
 * Observation configuration is not part of channel compatibility, so a config
 * argument is rejected. Nested arrays are rejected as they are for cells.
 */
function parseChannelSpec(
  expression: acorn.Expression | acorn.Pattern,
  owner: string,
): ChannelSpec {
  if (expression.type !== "CallExpression") {
    throw new Error(`${owner} must be a channel spec constructor`);
  }
  const callee = expression.callee;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Dialog" &&
    callee.property.type === "Identifier"
  ) {
    if (callee.property.name !== "Cursor") {
      throw new Error(
        `${owner} unsupported Dialog channel: ${callee.property.name}`,
      );
    }
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Dialog.Cursor() takes no arguments`);
    }
    return { type: "dialogCursor" };
  }
  if (callee.type !== "Identifier") {
    throw new Error(`${owner} must be a channel spec constructor`);
  }
  const name = callee.name;
  if (name === "Artifact") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Artifact() channel spec takes no arguments`);
    }
    return { type: "artifact" };
  }
  if (name === "Index") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Index() takes no arguments`);
    }
    return { type: "index" };
  }
  if (name === "Bool") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Bool() channel spec takes no configuration`);
    }
    return { type: "boolean" };
  }
  if (name === "Str") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Str() channel spec takes no configuration`);
    }
    return { type: "string" };
  }
  if (name === "Num") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Num() channel spec takes no configuration`);
    }
    return { type: "number" };
  }
  if (name === "Enum") {
    const arg = expression.arguments[0];
    if (
      expression.arguments.length !== 1 ||
      !arg ||
      arg.type !== "ArrayExpression"
    ) {
      throw new Error(
        `${owner} Enum() channel spec requires a single array literal`,
      );
    }
    const values = arg.elements.map((element) => {
      if (
        !element ||
        element.type !== "Literal" ||
        typeof element.value !== "string"
      ) {
        throw new Error(`${owner} Enum() channel spec requires string values`);
      }
      return element.value;
    });
    return { type: "enum", values };
  }
  if (name === "RangedInt") {
    throw new Error(
      `${owner} RangedInt() is observation shorthand and cannot declare a channel; use Num()`,
    );
  }
  if (name === "Array") {
    const arg = expression.arguments[0];
    if (
      expression.arguments.length !== 1 ||
      !arg ||
      arg.type === "SpreadElement"
    ) {
      throw new Error(
        `${owner} Array() channel spec takes one element constructor`,
      );
    }
    const element = parseChannelSpec(arg, `${owner} element`);
    if (element.type === "array") {
      throw new Error(`${owner} Array() channel spec cannot nest arrays`);
    }
    if (element.type === "index" || element.type === "dialogCursor") {
      throw new Error(
        `${owner} Array() element must be a scalar or Artifact channel type`,
      );
    }
    return { type: "array", element };
  }
  throw new Error(`${owner} unsupported channel spec: ${name}`);
}

function collectNewCopyNodeAliases(
  statements: Statement[],
): Node["newcopyAliases"] {
  const aliases: Node["newcopyAliases"] = [];

  const visit = (statement: Statement): void => {
    if (statement.kind === "if") {
      statement.consequent.forEach(visit);
      statement.alternate?.forEach(visit);
      return;
    }
    if (statement.kind === "label") {
      statement.body.forEach(visit);
      return;
    }
    if (statement.kind === "invoke" || statement.kind === "map") {
      statement.body.forEach(visit);
      return;
    }
    if (
      (statement.kind === "enter-node" || statement.kind === "enter-loop") &&
      statement.target.mode === "newcopy"
    ) {
      aliases.push({
        identifier: `${statement.target.identifier}#${statement.id}`,
        target: statement.target.identifier,
        imported: statement.target.imported,
      });
    }
  };

  statements.forEach(visit);
  return aliases;
}

/**
 * Statement union covered by the element-id walk: the node-body dialect plus
 * every hook dialect (their leaf actions are the shared types, so a single
 * kind-switch covers all of them).
 */
type StampStatement =
  | Statement
  | TriggerStatement
  | GuardStatement
  | CatchDeflectionStatement
  | EffectStatement
  | ResolutionStatement;

/**
 * Canonical element-id stamper. Derives every statement's and briefable
 * expression's `ElementId` from the document shape — each SEG scope's
 * statements from zero, branch tags on descent, `~n` for briefable
 * expressions in evaluation order — writes them in place, and rebuilds
 * `newcopyAliases` so aliases embed final ids. Idempotent.
 *
 * `parse(...)` stamps its own output and `Runtime.add` stamps its private
 * clone, so hand-built IR needs no manual step there; `analyzeDocument` /
 * `validate` only VERIFY canonical ids (never mutating their input) and
 * report mismatches as validation issues.
 *
 * An inherited `deflectWhen` is stamped under the static `deflectWhen/`
 * scope, never the owning instruction's: when the hook array is genuinely
 * shared this rewrites the same ids, and when a JSON clone severed the
 * sharing it is what makes the private copy canonical. Per-owner brief
 * identity is `qualifiedBriefSite`'s job, not the stamper's.
 */
export function stampElementIds(node: Node): void {
  applyElementIds(node, undefined);
}

/** Verifies canonical ids without mutating; mismatches become issues. */
function verifyElementIds(node: Node, issues: ValidationIssue[]): void {
  applyElementIds(node, issues);
  scanUnstampedIds(node, issues);
}

/**
 * Independent unstamped-id sweep by structural reflection: any `kind`-bearing
 * object whose `id` is the unstamped placeholder is reported. Deliberately
 * NOT the stamper walk — the walk dispatches on statement kind, so a kind it
 * forgot to descend into is invisible to it, and this sweep is what turns
 * that gap into a validation issue instead of runtime garbage ids.
 */
function scanUnstampedIds(value: unknown, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) scanUnstampedIds(entry, issues);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind === "string" &&
    "id" in record &&
    record.id === UNSTAMPED_ID
  ) {
    issues.push({
      code: "ELEMENT_ID",
      message: `Unstamped element id on a "${record.kind}" element; normalize the document with stampElementIds`,
      loc: record.loc as SourceRange | undefined,
    });
  }
  for (const entry of Object.values(record)) scanUnstampedIds(entry, issues);
}

function applyElementIds(
  node: Node,
  verify: ValidationIssue[] | undefined,
): void {
  const scopes: [readonly StampStatement[] | undefined, string][] = [
    [node.trigger, "trigger/"],
    [node.deflectWhen, "deflectWhen/"],
    [node.guard, "guard/"],
    [node.catchDeflection, "catch/"],
    [node.effects, "effects/"],
    [node.statements, "body/"],
  ];
  for (const [list, prefix] of scopes) {
    if (list) applyStatementIds(list, prefix, verify);
  }
  if (verify) {
    verifyNewcopyAliases(node, verify);
  } else {
    node.newcopyAliases = collectNewCopyNodeAliases(node.statements);
  }
  for (const child of node.children) applyElementIds(child, verify);
}

/**
 * Verifies that a node's `newcopyAliases` match what the document shape derives
 * — the verify-mode counterpart to the stamp-mode rebuild. Aliases embed
 * element ids, so a stale or corrupted alias is a canonical-id mismatch like
 * any other, and the public `validate` contract reports it rather than relying
 * on `Runtime.add` restamping its private clone.
 */
function verifyNewcopyAliases(node: Node, issues: ValidationIssue[]): void {
  const expected = collectNewCopyNodeAliases(node.statements);
  const actual = node.newcopyAliases;
  const matches =
    actual.length === expected.length &&
    expected.every((alias, index) => {
      const found = actual[index];
      return (
        found !== undefined &&
        found.identifier === alias.identifier &&
        found.target === alias.target &&
        found.imported === alias.imported
      );
    });
  if (!matches) {
    issues.push({
      code: "ELEMENT_ID",
      message: `Derived newcopyAliases on node "${node.identifier}" do not match the document shape; normalize with stampElementIds`,
      loc: node.loc,
    });
  }
}

function applyStatementIds(
  list: readonly StampStatement[],
  prefix: string,
  verify: ValidationIssue[] | undefined,
): void {
  list.forEach((statement, index) => {
    const id = `${prefix}${index}` as ElementId;
    applyElementId(statement, id, verify);
    let expressionCount = 0;
    const nextExpressionId = (): ElementId =>
      `${id}~${expressionCount++}` as ElementId;
    switch (statement.kind) {
      case "if":
        applyExpressionIds(statement.test, nextExpressionId, verify);
        applyStatementIds(statement.consequent, `${id}c/`, verify);
        if (statement.alternate) {
          applyStatementIds(statement.alternate, `${id}a/`, verify);
        }
        return;
      case "label":
        applyStatementIds(statement.body, `${id}l/`, verify);
        return;
      case "return":
        if (statement.value) {
          applyExpressionIds(statement.value, nextExpressionId, verify);
        }
        return;
      case "set":
      case "set-return":
      case "set-span":
        applyExpressionIds(statement.value, nextExpressionId, verify);
        return;
      case "invoke":
        applyStatementIds(statement.body, `${id}/`, verify);
        return;
      case "map":
        // The callback body stamps under the `$map` id on the invoke scheme;
        // runtime member instances qualify these static ids by member index.
        applyStatementIds(statement.body, `${id}/`, verify);
        return;
      case "enter-loop":
        applyStatementIds(statement.resolveWhen, `${id}/resolveWhen/`, verify);
        return;
      case "instruction":
        if (statement.resolveWhen) {
          applyStatementIds(
            statement.resolveWhen,
            `${id}/resolveWhen/`,
            verify,
          );
        }
        if (statement.deflectWhen) {
          applyStatementIds(
            statement.deflectWhen,
            statement.inheritedDeflectWhen
              ? "deflectWhen/"
              : `${id}/deflectWhen/`,
            verify,
          );
        }
        return;
      case "host-call":
        for (const argument of statement.arguments) {
          applyArgumentIds(argument, nextExpressionId, verify);
        }
        return;
      default:
        // observe / observeOrAsk / observeGroup / observeOrAskGroup / unset /
        // enter-node / break: no nested id-bearing elements (semantic strings
        // reject briefables).
        return;
    }
  });
}

function applyExpressionIds(
  expression: ValueExpression,
  nextExpressionId: () => ElementId,
  verify: ValidationIssue[] | undefined,
): void {
  switch (expression.kind) {
    case "judge":
      applyElementId(expression, nextExpressionId(), verify);
      return;
    case "host-call":
      applyElementId(expression, nextExpressionId(), verify);
      for (const argument of expression.arguments) {
        applyArgumentIds(argument, nextExpressionId, verify);
      }
      return;
    case "regexTest":
      applyExpressionIds(expression.target, nextExpressionId, verify);
      return;
    case "comparison":
    case "arithmetic":
    case "logical":
      applyExpressionIds(expression.left, nextExpressionId, verify);
      applyExpressionIds(expression.right, nextExpressionId, verify);
      return;
    case "conditional":
      applyExpressionIds(expression.test, nextExpressionId, verify);
      applyExpressionIds(expression.consequent, nextExpressionId, verify);
      applyExpressionIds(expression.alternate, nextExpressionId, verify);
      return;
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      applyExpressionIds(expression.argument, nextExpressionId, verify);
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          applyExpressionIds(part.expression, nextExpressionId, verify);
        }
      }
      return;
    case "artifact":
      applyExpressionIds(expression.path, nextExpressionId, verify);
      return;
    case "arrayElementRead":
      applyExpressionIds(expression.index, nextExpressionId, verify);
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        applyExpressionIds(element, nextExpressionId, verify);
      }
      return;
    default:
      return;
  }
}

function applyArgumentIds(
  argument: HostCallArgument,
  nextExpressionId: () => ElementId,
  verify: ValidationIssue[] | undefined,
): void {
  switch (argument.kind) {
    case "semantic":
      return;
    case "value":
      applyExpressionIds(argument.value, nextExpressionId, verify);
      return;
    case "array":
      for (const entry of argument.elements) {
        applyArgumentIds(entry, nextExpressionId, verify);
      }
      return;
    case "object":
      for (const key of Object.keys(argument.value)) {
        const entry = argument.value[key];
        if (entry) applyArgumentIds(entry, nextExpressionId, verify);
      }
      return;
  }
}

function applyElementId(
  element: { id: ElementId; loc?: SourceRange },
  expected: ElementId,
  verify: ValidationIssue[] | undefined,
): void {
  if (!verify) {
    element.id = expected;
    return;
  }
  if (element.id !== expected) {
    verify.push({
      code: "ELEMENT_ID",
      message: `Element id ${
        element.id === UNSTAMPED_ID ? "(unstamped)" : `"${element.id}"`
      } does not match its structural id "${expected}"; normalize the document with stampElementIds`,
      loc: element.loc,
    });
  }
}

function parseCellDeclarations(
  statement: acorn.VariableDeclaration,
  availableHostModules: ReadonlyMap<string, string>,
): Cell[] {
  const cells: Cell[] = [];

  for (const declaration of statement.declarations) {
    const id = declaration.id;
    if (declaration.init?.type === "NewExpression") {
      throw new Error(
        "Arc cell declarations do not support new; use Type(...) instead",
      );
    }
    if (
      !declaration.init ||
      declaration.init.type !== "CallExpression" ||
      id.type !== "Identifier"
    ) {
      continue;
    }
    if (id.name === "invoke") {
      throw new Error("invoke is a reserved name and cannot name a cell");
    }

    const callee = declaration.init.callee;
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Dialog" &&
      callee.property.type === "Identifier"
    ) {
      if (callee.property.name !== "Cursor") {
        throw new Error(
          `Unsupported Dialog cell type: ${callee.property.name}`,
        );
      }
      if (declaration.init.arguments.length !== 0) {
        throw new Error(`Dialog.Cursor cell ${id.name} accepts no arguments`);
      }
      cells.push({
        name: id.name,
        type: "dialogCursor",
        loc: locOf(id),
      });
      continue;
    }
    if (callee.type !== "Identifier") continue;

    if (callee.name === "Artifact") {
      if (declaration.init.arguments.length === 0) {
        cells.push({
          name: id.name,
          type: "artifact",
          loc: locOf(id),
        });
        continue;
      }
      const initializer = parseArtifactConstructCall(
        declaration.init,
        `Artifact ${id.name}`,
        availableHostModules,
        true,
      );
      if (containsBriefableExpression(initializer)) {
        throw new Error(
          `Artifact ${id.name} path cannot contain judge() or host call expressions`,
        );
      }
      cells.push({
        name: id.name,
        type: "artifact",
        initializer,
        loc: locOf(id),
      });
      continue;
    }

    if (callee.name === "Index") {
      throw new Error(
        `Index() is a channel-only type and cannot declare the cell ${id.name}`,
      );
    }

    if (callee.name === "Array") {
      const element = parseArrayElementSpec(
        id.name,
        declaration.init.arguments,
        availableHostModules,
      );
      if (element.type === "artifact") {
        cells.push({
          name: id.name,
          type: "array",
          element: { type: "artifact" },
          loc: locOf(id),
        });
      } else {
        cells.push({
          name: id.name,
          type: "array",
          element,
          loc: locOf(id),
        });
      }
      continue;
    }

    const scalar = parseScalarConstructorSpec(
      declaration.init,
      id.name,
      availableHostModules,
    );
    if (scalar) {
      cells.push({ name: id.name, ...scalar, loc: locOf(id) });
    }
  }

  return cells;
}

/**
 * Recognizes an inline scalar cell constructor — `Enum([...], config?)`,
 * `Bool(config?)`, `Str(config?)`, `Num(config?)`, or
 * `RangedInt(min, max, config?)` — and
 * returns its element spec. Returns `undefined` when the callee is not a scalar
 * constructor. Shared by top-level scalar cell declarations, array element
 * declarations, and (in Phase 2) typed channel specs; `owner` names the owning
 * construct in error messages.
 */
function parseScalarConstructorSpec(
  call: acorn.CallExpression,
  owner: string,
  availableHostModules: ReadonlyMap<string, string>,
): ObservableScalar | undefined {
  if (call.callee.type !== "Identifier") return undefined;
  const name = call.callee.name;

  if (name === "Enum") {
    const arg = call.arguments[0];
    const config = parseCellConfig(
      owner,
      name,
      call.arguments[1],
      availableHostModules,
    );
    if (
      !arg ||
      arg.type === "SpreadElement" ||
      arg.type !== "ArrayExpression"
    ) {
      throw new Error(`Enum cell ${owner} requires an array literal`);
    }
    const values = arg.elements.map((element) => {
      if (
        !element ||
        element.type !== "Literal" ||
        typeof element.value !== "string"
      ) {
        throw new Error(`Enum cell ${owner} requires string values`);
      }
      return element.value;
    });
    return { type: "enum", values, ...config };
  }

  if (name === "Bool") {
    const config = parseCellConfig(
      owner,
      name,
      call.arguments[0],
      availableHostModules,
    );
    return { type: "boolean", ...config };
  }

  if (name === "Str") {
    const config = parseCellConfig(
      owner,
      name,
      call.arguments[0],
      availableHostModules,
    );
    return { type: "string", ...config };
  }

  if (name === "Num") {
    const config = parseNumericCellConfig(
      owner,
      name,
      call.arguments[0],
      availableHostModules,
    );
    if (call.arguments.length > 1) {
      throw new Error(`Num cell ${owner} accepts at most one config argument`);
    }
    return { type: "number", ...config };
  }

  if (name === "RangedInt") {
    if (call.arguments.length > 3) {
      throw new Error(
        `RangedInt cell ${owner} accepts min, max, and an optional config argument`,
      );
    }
    const minArg = call.arguments[0];
    const maxArg = call.arguments[1];
    const config = parseCellConfig(
      owner,
      name,
      call.arguments[2],
      availableHostModules,
    );
    const min = parseSignedNumericLiteral(minArg);
    const max = parseSignedNumericLiteral(maxArg);
    if (min === undefined || max === undefined) {
      throw new Error(
        `RangedInt cell ${owner} requires numeric min/max literals`,
      );
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new Error(
        `RangedInt cell ${owner} requires ordered safe-integer min/max literals`,
      );
    }
    return {
      type: "number",
      observeAs: { kind: "integer", min, max },
      ...config,
    };
  }

  return undefined;
}

/**
 * Parses the single element constructor of an `Array(elementCell)` declaration
 * into an {@link ObservableScalar}. The element must be a constructed scalar
 * cell: a bare constructor (`Array(Str)`), a nested array, extra arguments, or a
 * non-scalar constructor are all rejected.
 */
function parseArrayElementSpec(
  cellName: string,
  args: readonly (acorn.Expression | acorn.SpreadElement)[],
  availableHostModules: ReadonlyMap<string, string>,
): ObservableScalar | ArtifactSpec {
  const arg = args[0];
  if (args.length !== 1 || !arg || arg.type === "SpreadElement") {
    throw new Error(
      `Array cell ${cellName} takes exactly one element constructor`,
    );
  }
  if (arg.type !== "CallExpression") {
    throw new Error(
      `Array cell ${cellName} element must be a constructed scalar cell, e.g. Array(Str())`,
    );
  }
  if (arg.callee.type === "Identifier" && arg.callee.name === "Array") {
    throw new Error(`Array cell ${cellName} cannot nest arrays`);
  }
  if (arg.callee.type === "Identifier" && arg.callee.name === "Artifact") {
    if (arg.arguments.length !== 0) {
      throw new Error(
        `Array cell ${cellName} Artifact() element takes no arguments`,
      );
    }
    return { type: "artifact" };
  }
  const element = parseScalarConstructorSpec(
    arg,
    cellName,
    availableHostModules,
  );
  if (!element) {
    throw new Error(
      `Array cell ${cellName} element must be a scalar or Artifact cell constructor`,
    );
  }
  return element;
}

function parseCellConfig(
  cellName: string,
  typeName: string,
  arg: acorn.Expression | acorn.SpreadElement | undefined,
  availableHostModules: ReadonlyMap<string, string>,
): Pick<ObservableScalar, "observing"> {
  if (!arg) return {};
  if (arg.type === "SpreadElement" || arg.type !== "ObjectExpression") {
    throw new Error(
      `${typeName} cell ${cellName} config must be an object literal`,
    );
  }

  const config: Pick<ObservableScalar, "observing"> = {};
  for (const property of arg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(
        `${typeName} cell ${cellName} config does not support spread`,
      );
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key !== "observing") {
      throw new Error(
        `${typeName} cell ${cellName} has unsupported config key: ${key ?? "<computed>"}`,
      );
    }
    if (config.observing !== undefined) {
      throw new Error(
        `Duplicate cell config assignment: ${cellName}.observing`,
      );
    }
    config.observing = parseSemanticString(
      property.value,
      availableHostModules,
    );
  }
  return config;
}

function parseNumericCellConfig(
  cellName: string,
  typeName: string,
  arg: acorn.Expression | acorn.SpreadElement | undefined,
  availableHostModules: ReadonlyMap<string, string>,
): { observing?: SemanticString; observeAs?: NumericObserveAs } {
  if (!arg) return {};
  if (arg.type === "SpreadElement" || arg.type !== "ObjectExpression") {
    throw new Error(
      `${typeName} cell ${cellName} config must be an object literal`,
    );
  }
  const config: { observing?: SemanticString; observeAs?: NumericObserveAs } =
    {};
  for (const property of arg.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      throw new Error(
        `${typeName} cell ${cellName} config does not support spread or computed keys`,
      );
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === "observing") {
      if (config.observing !== undefined) {
        throw new Error(
          `Duplicate cell config assignment: ${cellName}.observing`,
        );
      }
      config.observing = parseSemanticString(
        property.value,
        availableHostModules,
      );
      continue;
    }
    if (key === "observeAs") {
      if (config.observeAs !== undefined) {
        throw new Error(
          `Duplicate cell config assignment: ${cellName}.observeAs`,
        );
      }
      config.observeAs = parseNumericObserveAs(property.value, cellName);
      continue;
    }
    throw new Error(
      `${typeName} cell ${cellName} has unsupported config key: ${key ?? "<computed>"}`,
    );
  }
  return config;
}

function parseNumericObserveAs(
  expression: acorn.Expression | acorn.Pattern,
  cellName: string,
): NumericObserveAs {
  if (expression.type !== "ObjectExpression") {
    throw new Error(`Num cell ${cellName} observeAs must be an object literal`);
  }
  let kind: NumericObserveAs["kind"] | undefined;
  let min: number | undefined;
  let max: number | undefined;
  const seen = new Set<string>();
  for (const property of expression.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      throw new Error(
        `Num cell ${cellName} observeAs does not support spread or computed keys`,
      );
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key && seen.has(key)) {
      throw new Error(`Num cell ${cellName} observeAs repeats field: ${key}`);
    }
    if (key) seen.add(key);
    if (key === "kind") {
      if (
        property.value.type !== "Literal" ||
        (property.value.value !== "number" &&
          property.value.value !== "integer")
      ) {
        throw new Error(
          `Num cell ${cellName} observeAs kind must be "number" or "integer"`,
        );
      }
      kind = property.value.value;
      continue;
    }
    if (key === "min" || key === "max") {
      const value = parseSignedNumericLiteral(property.value);
      if (value === undefined) {
        throw new Error(
          `Num cell ${cellName} observeAs ${key} must be a numeric literal`,
        );
      }
      if (key === "min") min = value;
      else max = value;
      continue;
    }
    throw new Error(
      `Num cell ${cellName} observeAs has unsupported field: ${key ?? "<computed>"}`,
    );
  }
  if (!kind) {
    throw new Error(`Num cell ${cellName} observeAs requires kind`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(
      `Num cell ${cellName} observeAs bounds must satisfy min <= max`,
    );
  }
  if (
    kind === "integer" &&
    ((min !== undefined && !Number.isSafeInteger(min)) ||
      (max !== undefined && !Number.isSafeInteger(max)))
  ) {
    throw new Error(
      `Num cell ${cellName} integer observeAs bounds must be safe integers`,
    );
  }
  return {
    kind,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function parseSignedNumericLiteral(
  expression:
    | acorn.Expression
    | acorn.SpreadElement
    | acorn.Pattern
    | undefined,
): number | undefined {
  if (!expression || expression.type === "SpreadElement") return undefined;
  if (expression.type === "Literal" && typeof expression.value === "number") {
    return Object.is(expression.value, -0) ? 0 : expression.value;
  }
  if (
    expression.type === "UnaryExpression" &&
    expression.operator === "-" &&
    expression.argument.type === "Literal" &&
    typeof expression.argument.value === "number"
  ) {
    const value = -expression.argument.value;
    return Object.is(value, -0) ? 0 : value;
  }
  return undefined;
}

function parseNodeStatement(
  statement: acorn.Statement,
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  handledStatements: ReadonlySet<acorn.Statement>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,

  defaultDeflectWhen: ResolutionStatement[] | undefined,
  enclosing: EnclosingNode,
): Statement[] {
  if (handledStatements.has(statement)) {
    return [];
  }

  if (statement.type === "LabeledStatement") {
    if (statement.label.type !== "Identifier") {
      throw new Error("Arc labels must use identifier names");
    }
    if (statement.body.type !== "BlockStatement") {
      throw new Error("Arc labels must target a block statement");
    }
    const parsed: LabelStatement = {
      id: UNSTAMPED_ID,
      kind: "label",
      label: statement.label.name,
      body: parseStatementList(
        statement.body.body,
        childFunctions,
        handledStatements,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        availableHostModules,
        defaultDeflectWhen,
        enclosing,
      ),
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (statement.type === "BreakStatement") {
    if (!statement.label || statement.label.type !== "Identifier") {
      throw new Error("Arc break statements must specify a label");
    }
    const parsed: BreakStatement = {
      id: UNSTAMPED_ID,
      kind: "break",
      label: statement.label.name,
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (statement.type === "IfStatement") {
    const parsed: IfStatement = {
      id: UNSTAMPED_ID,
      kind: "if",
      test: parseExpression(statement.test, availableHostModules, true),
      consequent: parseStatementList(
        getBlockStatements(statement.consequent),
        childFunctions,
        handledStatements,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        availableHostModules,
        undefined,
        enclosing,
      ),
      alternate: statement.alternate
        ? parseStatementList(
            getBlockStatements(statement.alternate),
            childFunctions,
            handledStatements,
            availableImports,
            visibleNodeNames,
            visibleCellNames,
            availableHostModules,
            undefined,
            enclosing,
          )
        : undefined,
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (statement.type !== "ExpressionStatement") {
    throw unsupportedArcStatement("an Arc action graph", statement);
  }
  const expression = statement.expression;
  if (expression.type === "AssignmentExpression") {
    throw new Error(
      "Unsupported Arc assignment; only this.* config and cell.observing assignments are allowed",
    );
  }

  const action = parseActionExpression(
    expression,
    childFunctions,
    availableImports,
    visibleNodeNames,
    visibleCellNames,
    availableHostModules,
    defaultDeflectWhen,
    enclosing,
  );
  if (!action) {
    throw new Error("Unsupported Arc expression statement");
  }
  return [action];
}

function unsupportedArcStatement(
  scope:
    | "an Arc action graph"
    | "this.trigger"
    | "this.guard"
    | "this.catchDeflection"
    | "this.effects",
  statement: acorn.Statement,
): Error {
  switch (statement.type) {
    case "VariableDeclaration":
      return new Error(
        "Cell declarations are only allowed directly in a node body",
      );
    case "FunctionDeclaration":
      return new Error(
        "Child node declarations are only allowed directly in a node body",
      );
    case "ReturnStatement":
      return new Error(`\`return\` is not allowed in ${scope}`);
    case "WhileStatement":
      return new Error(`\`while\` is not supported in ${scope}`);
    case "DoWhileStatement":
      return new Error(`\`do...while\` is not supported in ${scope}`);
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      return new Error(`\`for\` loops are not supported in ${scope}`);
    default:
      return new Error(`Unsupported statement in ${scope}`);
  }
}

function parseStatementList(
  statements: acorn.Statement[],
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  handledStatements: ReadonlySet<acorn.Statement>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,

  defaultDeflectWhen: ResolutionStatement[] | undefined,
  enclosing: EnclosingNode,
): Statement[] {
  return statements.flatMap((statement) =>
    parseNodeStatement(
      statement,
      childFunctions,
      handledStatements,
      availableImports,
      visibleNodeNames,
      visibleCellNames,
      availableHostModules,
      defaultDeflectWhen,
      enclosing,
    ),
  );
}

function parseActionExpression(
  expression: acorn.Expression,
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,

  defaultDeflectWhen: ResolutionStatement[] | undefined,
  enclosing: EnclosingNode,
): Statement | undefined {
  if (expression.type === "CallExpression") {
    if (
      expression.callee.type === "ArrowFunctionExpression" ||
      expression.callee.type === "FunctionExpression"
    ) {
      throw new Error(
        "Statement-position IIFEs are not supported; use invoke(() => { ... })",
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "invoke"
    ) {
      return parseInvokeCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        availableHostModules,
        defaultDeflectWhen,
        enclosing,
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observe"
    ) {
      return parseObserveCall(expression, "observe", availableHostModules);
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observeOrAsk"
    ) {
      return parseObserveCall(expression, "observeOrAsk", availableHostModules);
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }
    if (
      expression.callee.type === "Identifier" &&
      (expression.callee.name === "$instructLoop" ||
        expression.callee.name === "$instruct")
    ) {
      return parseInstructionCall(
        expression,
        availableHostModules,
        defaultDeflectWhen,
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$enter"
    ) {
      return parseEnterCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        enclosing,
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$enterLoop"
    ) {
      return parseEnterLoopCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        availableHostModules,
        enclosing,
      );
    }

    if (
      expression.callee.type === "MemberExpression" &&
      !expression.callee.computed &&
      expression.callee.property.type === "Identifier" &&
      expression.callee.property.name === "$map"
    ) {
      return parseMapCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleCellNames,
        availableHostModules,
        defaultDeflectWhen,
        enclosing,
      );
    }

    if (isSpanResultSetCallee(expression.callee)) {
      return parseSetSpanCall(expression, availableHostModules);
    }

    const mutation = parseCellMutationCall(
      expression,
      availableHostModules,
      "action",
    );
    if (mutation) return mutation;

    const hostCall = parseStandaloneHostCall(expression, availableHostModules);
    if (hostCall) return hostCall;
  }

  return undefined;
}

/** Whether a callee is `span.result.$set` (the only writable span member). */
function isSpanResultSetCallee(
  callee: acorn.Expression | acorn.Super,
): boolean {
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "$set" &&
    callee.object.type === "MemberExpression" &&
    !callee.object.computed &&
    callee.object.object.type === "Identifier" &&
    callee.object.object.name === "span" &&
    callee.object.property.type === "Identifier" &&
    callee.object.property.name === "result"
  );
}

/** Parses `span.result.$set(value)` into a `SetSpanAction`. */
function parseSetSpanCall(
  expression: acorn.CallExpression,
  availableHostModules: Map<string, string>,
): SetSpanAction {
  if (expression.arguments.length !== 1) {
    throw new Error("span.result.$set() takes exactly one value");
  }
  const argument = expression.arguments[0];
  if (!argument || argument.type === "SpreadElement") {
    throw new Error("span.result.$set() takes exactly one value");
  }
  return {
    id: UNSTAMPED_ID,
    kind: "set-span",
    owner: "map",
    value: parseExpression(argument, availableHostModules, true),
    loc: locOf(expression),
  };
}

/**
 * Parses `receiver.$map(callback, results?)` into a `MapAction`. The receiver is
 * an array cell or a typed array channel; the callback is a zero-arg arrow
 * parsed under the invoke dialect in the enclosing node's scope; `results`, when
 * present, is a bare output array cell.
 */
function parseMapCall(
  expression: acorn.CallExpression,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,
  defaultDeflectWhen: ResolutionStatement[] | undefined,
  enclosing: EnclosingNode,
): MapAction {
  const callee = expression.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type === "Super"
  ) {
    throw new Error("$map must be called as receiver.$map(...)");
  }
  const receiver = mapReceiverFrom(callee.object, availableHostModules);
  if (!receiver) {
    throw new Error(
      "$map receiver must be an array cell or a typed array channel",
    );
  }

  const [arrow, resultsArg, ...rest] = expression.arguments;
  if (!arrow || rest.length > 0) {
    throw new Error("$map takes a callback and an optional results cell");
  }
  if (arrow.type === "FunctionExpression") {
    throw new Error(
      "$map callback must be a zero-arg arrow function, not a function expression",
    );
  }
  if (arrow.type !== "ArrowFunctionExpression") {
    throw new Error("$map callback must be a zero-arg arrow function");
  }
  if (arrow.params.length > 0) {
    throw new Error("A $map callback cannot declare parameters");
  }

  let results: string | undefined;
  if (resultsArg) {
    if (resultsArg.type !== "Identifier") {
      throw new Error("$map results must be a bare array cell");
    }
    results = resultsArg.name;
  }

  const bodyChildFunctions = new Map<string, acorn.FunctionDeclaration>();
  const bodyHandledStatements = new Set<acorn.Statement>();
  const block = getFunctionBody(arrow);
  let body: Statement[];
  if (block) {
    body = parseStatementList(
      block,
      bodyChildFunctions,
      bodyHandledStatements,
      availableImports,
      visibleNodeNames,
      visibleCellNames,
      availableHostModules,
      defaultDeflectWhen,
      enclosing,
    );
  } else {
    const action = parseActionExpression(
      arrow.body as acorn.Expression,
      bodyChildFunctions,
      availableImports,
      visibleNodeNames,
      visibleCellNames,
      availableHostModules,
      defaultDeflectWhen,
      enclosing,
    );
    if (!action) {
      throw new Error("Unsupported $map callback expression");
    }
    body = [action];
  }

  return {
    id: UNSTAMPED_ID,
    kind: "map",
    receiver,
    results,
    body,
    loc: locOf(expression),
  };
}

/** Builds a `$map` receiver `ArrayReference` from its callee object expression. */
function mapReceiverFrom(
  node: acorn.Expression,
  availableHostModules: Map<string, string>,
): ArrayReference | undefined {
  if (node.type === "Identifier") {
    if (availableHostModules.has(node.name)) return undefined;
    return { kind: "cell", name: node.name };
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    (node.object.name === "args" || node.object.name === "returns") &&
    node.property.type === "Identifier"
  ) {
    return {
      kind: "channel",
      namespace: node.object.name,
      key: node.property.name,
    };
  }
  return undefined;
}

/**
 * Parses `invoke(() => { ... })` into a first-class `InvokeAction`: an
 * attached statement graph run inline in the enclosing node. The argument must
 * be a single zero-parameter arrow; the `function`-expression form is rejected
 * with a clear error.
 *
 * The arrow body is parsed with the standard node-body parser under the
 * enclosing node's scope (so in-body `$enter(Child)` and cell references
 * resolve against the surrounding node) and the enclosing node's statement-id
 * allocator, so statement addressing stays node-wide unique. The body admits
 * the full node-body action-graph dialect — `$enter` / `$enterLoop` /
 * `$instruct` / `$instructLoop` / nested `invoke` / `cell.$set` / `$observe` /
 * `$observeOrAsk` / `judge` / `if` / `label` / `break`, with an independent
 * label scope. `return`, params, call-args, the `function`-expression form,
 * and `let` / `this.*` / `function` declarations inside the body are
 * rejected — by the wrapper checks here or naturally by `parseNodeStatement`.
 * In-body instructions inherit the enclosing node's default deflection via
 * `defaultDeflectWhen`.
 */
function parseInvokeCall(
  expression: acorn.CallExpression,

  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,
  defaultDeflectWhen: ResolutionStatement[] | undefined,
  enclosing: EnclosingNode,
): InvokeAction {
  const argument = expression.arguments[0];
  if (expression.arguments.length !== 1 || !argument) {
    throw new Error("invoke() takes exactly one zero-arg arrow function");
  }
  if (argument.type === "FunctionExpression") {
    throw new Error(
      "invoke() must use a zero-arg arrow function, not a function expression",
    );
  }
  if (argument.type !== "ArrowFunctionExpression") {
    throw new Error("invoke() must use a zero-arg arrow function");
  }
  if (argument.params.length > 0) {
    throw new Error("An invoke body cannot declare parameters");
  }

  const id = UNSTAMPED_ID;

  // The body shares the enclosing node's id space and scope; only its label
  // scope is independent. Child node declarations inside the body stay
  // unresolvable and are rejected downstream.
  const bodyChildFunctions = new Map<string, acorn.FunctionDeclaration>();
  const bodyHandledStatements = new Set<acorn.Statement>();

  const block = getFunctionBody(argument);
  let body: Statement[];
  if (block) {
    body = parseStatementList(
      block,
      bodyChildFunctions,
      bodyHandledStatements,
      availableImports,
      visibleNodeNames,
      visibleCellNames,
      availableHostModules,
      defaultDeflectWhen,
      enclosing,
    );
  } else {
    const action = parseActionExpression(
      argument.body as acorn.Expression,
      bodyChildFunctions,
      availableImports,
      visibleNodeNames,
      visibleCellNames,
      availableHostModules,
      defaultDeflectWhen,
      enclosing,
    );
    if (!action) {
      throw new Error("Unsupported invoke body expression");
    }
    body = [action];
  }

  return {
    id,
    kind: "invoke",
    body,
    loc: locOf(expression),
  };
}

function parseTriggerArrowFunction(
  expression: acorn.Expression,
  label: string,

  availableHostModules: Map<string, string>,
): TriggerStatement[] {
  if (expression.type !== "ArrowFunctionExpression") {
    throw new Error(`${label} must be an arrow function`);
  }
  const body = getHookBodyStatements(expression, "return");
  if (!body) throw new Error(`${label} must be a function`);
  return parseTriggerStatements(body, availableHostModules);
}

function parseResolutionDefinition(
  expression: acorn.Expression,
  label: string,

  availableHostModules: Map<string, string>,
): ResolutionStatement[] {
  if (expression.type === "ArrowFunctionExpression") {
    return parseTriggerArrowFunction(expression, label, availableHostModules);
  }

  const question = parseSemanticString(expression, availableHostModules);
  return [
    {
      id: UNSTAMPED_ID,
      kind: "return",
      value: {
        id: UNSTAMPED_ID,
        kind: "judge",
        question,
        loc: locOf(expression),
      },
      loc: locOf(expression),
    },
  ];
}

function createInstructionAction(
  template: SemanticString,
  mode: InstructionAction["mode"],

  loc: SourceRange | undefined,
  hostParams: PayloadValue,
  resolveWhen?: ResolutionStatement[],
  deflectWhen?: ResolutionStatement[],
): InstructionAction {
  return {
    id: UNSTAMPED_ID,
    kind: "instruction",
    mode,
    template,
    hostParams,
    resolveWhen,
    deflectWhen,
    loc,
  };
}

function parseInstructionCall(
  expression: acorn.CallExpression,
  availableHostModules: Map<string, string>,

  defaultDeflectWhen?: ResolutionStatement[],
): InstructionAction {
  const callee =
    expression.callee.type === "Identifier"
      ? expression.callee.name
      : undefined;
  if (callee !== "$instructLoop" && callee !== "$instruct") {
    throw new Error("Unsupported instruction call");
  }

  const textArg = expression.arguments[0];
  if (!textArg || textArg.type === "SpreadElement") {
    throw new Error(`${callee}() requires instruction text`);
  }
  const template = parseSemanticString(textArg, availableHostModules);
  rejectUnsupportedInstructionIml(template);

  if (expression.arguments.length > 2) {
    throw new Error(
      `${callee}() accepts at most an instruction and one options object`,
    );
  }

  let resolveWhen: ResolutionStatement[] | undefined;
  let deflectWhen: ResolutionStatement[] | undefined;
  let hostParams: PayloadValue | undefined;
  const optionsArg = expression.arguments[1];
  if (optionsArg) {
    if (
      optionsArg.type === "SpreadElement" ||
      optionsArg.type !== "ObjectExpression"
    ) {
      throw new Error(`${callee}() options must be an object literal`);
    }
    for (const property of optionsArg.properties) {
      if (property.type === "SpreadElement") {
        throw new Error(`${callee}() options do not support spread`);
      }
      if (property.computed) {
        throw new Error(`${callee}() options do not support computed keys`);
      }
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal" &&
              typeof property.key.value === "string"
            ? property.key.value
            : undefined;
      if (
        key !== "resolveWhen" &&
        key !== "deflectWhen" &&
        key !== "hostParams"
      ) {
        throw new Error(
          `${callee}() has unsupported option key: ${key ?? "<computed>"}`,
        );
      }
      if (key === "hostParams") {
        hostParams = parseHostParamsValue(
          property.value,
          `${callee}().hostParams`,
        );
        continue;
      }
      const parsed = parseResolutionDefinition(
        property.value,
        `${callee}().${key}`,
        availableHostModules,
      );
      if (key === "resolveWhen") resolveWhen = parsed;
      if (key === "deflectWhen") deflectWhen = parsed;
    }
  }

  const mode: InstructionAction["mode"] =
    callee === "$instruct" ? "once" : "persistent";
  if (mode === "persistent" && !resolveWhen) {
    throw new Error("$instructLoop() requires resolveWhen");
  }
  if (mode === "once" && resolveWhen) {
    throw new Error("$instruct() does not support resolveWhen");
  }

  const action = createInstructionAction(
    template,
    mode,
    locOf(expression),
    hostParams,
    resolveWhen,
    deflectWhen ?? defaultDeflectWhen,
  );
  if (deflectWhen === undefined && defaultDeflectWhen !== undefined) {
    action.inheritedDeflectWhen = true;
  }
  return action;
}

function parseHostParamsValue(
  expression: acorn.Expression,
  context: string,
): PayloadValue {
  if (expression.type === "Literal") {
    const value = expression.value;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    throw new Error(`${context} only supports literal metadata values`);
  }
  if (expression.type === "ArrayExpression") {
    return expression.elements.map((element) => {
      if (!element || element.type === "SpreadElement") {
        throw new Error(`${context} arrays do not support holes or spread`);
      }
      return parseHostParamsValue(element, context);
    });
  }
  if (expression.type === "ObjectExpression") {
    return parseParamsObject(expression, context);
  }
  throw new Error(`${context} only supports literal metadata values`);
}

function parseParamsObject(
  expression: acorn.ObjectExpression,
  context: string,
): StructValue {
  const value: Record<string, PayloadValue> = {};
  for (const property of expression.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${context} objects do not support spread`);
    }
    if (property.computed) {
      throw new Error(`${context} objects do not support computed keys`);
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (!key) {
      throw new Error(`${context} objects require string keys`);
    }
    value[key] = parseHostParamsValue(property.value, context);
  }
  return value as StructValue;
}

function parseEnterCall(
  expression: acorn.CallExpression,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,

  enclosing: EnclosingNode,
): Statement {
  const target = parseTarget(expression.arguments[0], "enter", {
    availableImports,
    visibleNodeNames,
    enclosing,
  });
  if (expression.arguments.length > 2) {
    throw new Error("$enter() accepts a target and an optional options object");
  }

  const optionsArg = expression.arguments[1];
  let args: EnterChannelBindings | undefined;
  let returns: EnterChannelBindings | undefined;

  if (optionsArg) {
    if (
      optionsArg.type === "SpreadElement" ||
      optionsArg.type !== "ObjectExpression"
    ) {
      throw new Error("$enter() options must be an object literal");
    }
    const seenKeys = new Set<string>();
    for (const property of optionsArg.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("$enter() options do not support spread");
      }
      if (property.computed) {
        throw new Error("$enter() options do not support computed keys");
      }
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal" &&
              typeof property.key.value === "string"
            ? property.key.value
            : undefined;
      if (key !== "args" && key !== "returns") {
        throw new Error(
          `$enter() has unsupported option key: ${key ?? "<computed>"}`,
        );
      }
      if (seenKeys.has(key)) {
        throw new Error(`$enter() options has duplicate key: ${key}`);
      }
      seenKeys.add(key);
      const parsed = parseEnterChannelMap(
        property.value,
        `$enter().${key}`,
        visibleCellNames,
      );
      if (key === "args") args = parsed;
      if (key === "returns") returns = parsed;
    }
  }

  return {
    id: UNSTAMPED_ID,
    kind: "enter-node",
    target,
    args,
    returns,
    loc: locOf(expression),
  };
}

function parseEnterLoopCall(
  expression: acorn.CallExpression,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleCellNames: Set<string>,
  availableHostModules: Map<string, string>,

  enclosing: EnclosingNode,
): Statement {
  const target = parseTarget(expression.arguments[0], "enterLoop", {
    availableImports,
    visibleNodeNames,
    enclosing,
  });
  if (expression.arguments.length !== 2) {
    throw new Error("$enterLoop() accepts a target and one options object");
  }

  const optionsArg = expression.arguments[1];
  if (
    !optionsArg ||
    optionsArg.type === "SpreadElement" ||
    optionsArg.type !== "ObjectExpression"
  ) {
    throw new Error("$enterLoop() options must be an object literal");
  }

  let resolveWhen: ResolutionStatement[] | undefined;
  let args: EnterChannelBindings | undefined;
  let returns: EnterChannelBindings | undefined;
  const seenKeys = new Set<string>();
  for (const property of optionsArg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error("$enterLoop() options do not support spread");
    }
    if (property.computed) {
      throw new Error("$enterLoop() options do not support computed keys");
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key !== "resolveWhen" && key !== "args" && key !== "returns") {
      throw new Error(
        `$enterLoop() has unsupported option key: ${key ?? "<computed>"}`,
      );
    }
    if (seenKeys.has(key)) {
      throw new Error(`$enterLoop() options has duplicate key: ${key}`);
    }
    seenKeys.add(key);
    if (key === "resolveWhen") {
      resolveWhen = parseResolutionDefinition(
        property.value,
        "$enterLoop().resolveWhen",
        availableHostModules,
      );
      continue;
    }
    const parsed = parseEnterChannelMap(
      property.value,
      `$enterLoop().${key}`,
      visibleCellNames,
    );
    if (key === "args") args = parsed;
    if (key === "returns") returns = parsed;
  }

  if (!resolveWhen) {
    throw new Error("$enterLoop() requires resolveWhen");
  }

  return {
    id: UNSTAMPED_ID,
    kind: "enter-loop",
    target,
    resolveWhen,
    args,
    returns,
    loc: locOf(expression),
  };
}

function parseEnterChannelMap(
  expression: acorn.Expression,
  label:
    | "$enter().args"
    | "$enter().returns"
    | "$enterLoop().args"
    | "$enterLoop().returns",
  visibleCellNames: Set<string>,
): EnterChannelBindings {
  if (expression.type !== "ObjectExpression") {
    throw new Error(`${label} must be an object literal`);
  }
  const isReturns = label.endsWith(".returns");
  const boundCells = new Set<string>();
  const mapping: EnterChannelBindings = {};
  for (const property of expression.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${label} does not support spread`);
    }
    if (property.computed) {
      throw new Error(`${label} does not support computed keys`);
    }
    if (property.key.type !== "Identifier") {
      throw new Error(`${label} keys must be identifiers`);
    }
    const key = property.key.name;
    if (mapping[key]) {
      throw new Error(`${label} has duplicate key: ${key}`);
    }
    const value = property.value;
    // `args.x` forwards the caller's own typed args channel into the child.
    // It is a read-only source, valid only for an args binding.
    if (
      value.type === "MemberExpression" &&
      !value.computed &&
      value.object.type === "Identifier" &&
      value.object.name === "args" &&
      value.property.type === "Identifier"
    ) {
      if (isReturns) {
        throw new Error(
          `${label}.${key} cannot bind an args projection to a returns sink`,
        );
      }
      mapping[key] = { kind: "argsProjection", key: value.property.name };
      continue;
    }
    // `span.item` / `span.index` feed a `$map` member's element and index into a
    // child arg; `span.result` is the member's output sink, valid only as a
    // returns binding.
    if (
      value.type === "MemberExpression" &&
      !value.computed &&
      value.object.type === "Identifier" &&
      value.object.name === "span" &&
      value.property.type === "Identifier"
    ) {
      const member = value.property.name;
      if (member === "item" || member === "index") {
        if (isReturns) {
          throw new Error(
            `${label}.${key} cannot bind span.${member} to a returns sink`,
          );
        }
        mapping[key] = { kind: "span", owner: "map", key: member };
        continue;
      }
      if (member === "result") {
        if (!isReturns) {
          throw new Error(
            `${label}.${key} cannot bind span.result as an args source`,
          );
        }
        mapping[key] = { kind: "span", owner: "map", key: "result" };
        continue;
      }
      throw new Error(
        `${label}.${key} references an unknown span member: span.${member}`,
      );
    }
    if (value.type !== "Identifier") {
      throw new Error(
        `${label}.${key} must reference a caller cell identifier or args.* projection`,
      );
    }
    if (!visibleCellNames.has(value.name)) {
      throw new Error(
        `${label}.${key} references unknown caller cell: ${value.name}`,
      );
    }
    if (isReturns && boundCells.has(value.name)) {
      throw new Error(
        `${label} binds caller cell ${value.name} more than once`,
      );
    }
    boundCells.add(value.name);
    mapping[key] = { kind: "cell", cell: value.name };
  }
  return mapping;
}

function parseObserveCall(
  expression: acorn.CallExpression,
  method: "observe" | "observeOrAsk",

  availableHostModules: ReadonlyMap<string, string> = new Map(),
  expressionContext?: ExpressionParseContext,
):
  | ObserveAction
  | ObserveOrAskAction
  | ObserveGroupAction
  | ObserveOrAskGroupAction {
  const cellArg = expression.arguments[0];
  if (cellArg && cellArg.type === "ObjectExpression") {
    return parseObserveGroupCall(expression, method, cellArg);
  }
  if (!cellArg || cellArg.type === "SpreadElement") {
    throw new Error(
      `$${method}() requires a cell target or a cell group object as the first argument`,
    );
  }
  const target = parseCellTarget(
    cellArg,
    availableHostModules,
    expressionContext,
  );
  assertOrdinaryCellTarget(target, `$${method}()`);

  const questionArg = expression.arguments[1];
  const question =
    questionArg && questionArg.type !== "SpreadElement"
      ? parseSemanticString(
          questionArg,
          availableHostModules,
          expressionContext,
        )
      : undefined;

  return {
    id: UNSTAMPED_ID,
    kind: method,
    target,
    question,
    loc: locOf(expression),
  };
}

/**
 * Parses the grouped observation form `$observe({ a, b })`. Cells are bound by
 * same-name binding: every entry must be a shorthand cell reference, so a
 * renamed entry such as `{ x: age }`, a computed key, or a spread is rejected.
 * Each cell keeps its own `observing` question, so the grouped form takes no
 * override question.
 */
function parseObserveGroupCall(
  expression: acorn.CallExpression,
  method: "observe" | "observeOrAsk",
  objectArg: acorn.ObjectExpression,
): ObserveGroupAction | ObserveOrAskGroupAction {
  if (expression.arguments.length !== 1) {
    throw new Error(
      `$${method}({ ... }) takes only the cell group; each cell uses its own observing question`,
    );
  }
  const targets: CellTarget[] = [];
  for (const property of objectArg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`$${method}({ ... }) does not support spread`);
    }
    if (property.computed || property.key.type !== "Identifier") {
      throw new Error(`$${method}({ ... }) does not support computed keys`);
    }
    if (
      !property.shorthand ||
      property.value.type !== "Identifier" ||
      property.value.name !== property.key.name
    ) {
      throw new Error(
        `$${method}({ ... }) uses same-name binding; rename is not supported for ${property.key.name}`,
      );
    }
    const name = property.key.name;
    if (targets.some(([root]) => root === name)) {
      throw new Error(`$${method}({ ... }) lists cell ${name} more than once`);
    }
    targets.push([name]);
  }
  if (targets.length === 0) {
    throw new Error(`$${method}({ ... }) requires at least one cell`);
  }
  return {
    id: UNSTAMPED_ID,
    kind: method === "observe" ? "observeGroup" : "observeOrAskGroup",
    targets,
    loc: locOf(expression),
  };
}

function assertOrdinaryCellTarget(target: CellTarget, owner: string): void {
  const [root] = target;
  if (root === "args" || root === "returns" || root === "span") {
    throw new Error(`${owner} cannot target reserved namespace ${root}`);
  }
}

function parseCellMutationCall(
  expression: acorn.CallExpression,
  availableHostModules: Map<string, string>,

  context: "action" | "effects",
  expressionContext?: ExpressionParseContext,
): SetAction | UnsetAction | SetReturnAction | undefined {
  if (expression.callee.type !== "MemberExpression") return undefined;
  if (expression.callee.computed) return undefined;
  if (expression.callee.property.type !== "Identifier") return undefined;
  const method = expression.callee.property.name;
  if (method !== "$set" && method !== "$unset") return undefined;

  const calleeObject = expression.callee.object;
  if (calleeObject.type === "Super") return undefined;
  if (method === "$unset") {
    if (expression.arguments.length !== 0) {
      throw new Error("$unset() does not accept arguments");
    }
    const target = parseCellTarget(
      calleeObject,
      availableHostModules,
      expressionContext,
    );
    assertOrdinaryCellTarget(target, "$unset()");
    if (target.length !== 1) {
      throw new Error("$unset() requires a direct cell target");
    }
    return {
      id: UNSTAMPED_ID,
      kind: "unset",
      target,
      loc: locOf(expression),
    };
  }
  if (calleeObject.type === "Identifier" && calleeObject.name === "returns") {
    throw new Error("returns.$set(...) is not supported");
  }

  const valueArg = expression.arguments[0];
  if (!valueArg || valueArg.type === "SpreadElement") {
    throw new Error("$set() requires a value");
  }
  if (expression.arguments.length !== 1) {
    throw new Error("$set() takes exactly one value");
  }

  const value = parseExpression(
    valueArg,
    availableHostModules,
    true,
    expressionContext,
  );

  if (
    calleeObject.type === "MemberExpression" &&
    !calleeObject.computed &&
    calleeObject.object.type === "Identifier" &&
    calleeObject.property.type === "Identifier" &&
    calleeObject.object.name === "returns"
  ) {
    if (context !== "effects") {
      throw new Error(
        "returns.*.$set(...) is only allowed inside this.effects",
      );
    }
    return {
      id: UNSTAMPED_ID,
      kind: "set-return",
      key: calleeObject.property.name,
      value,
      loc: locOf(expression),
    };
  }

  const target = parseCellTarget(
    calleeObject,
    availableHostModules,
    expressionContext,
  );
  assertOrdinaryCellTarget(target, "$set()");
  return {
    id: UNSTAMPED_ID,
    kind: "set",
    target,
    value,
    loc: locOf(expression),
  };
}

function parseTriggerStatements(
  statements: acorn.Statement[],

  availableHostModules: Map<string, string>,
): TriggerStatement[] {
  return statements.flatMap<TriggerStatement>((statement) => {
    if (statement.type === "LabeledStatement") {
      if (statement.label.type !== "Identifier") {
        throw new Error("this.trigger labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.trigger labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement.label.name,
          body: parseTriggerStatements(
            statement.body.body,
            availableHostModules,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "BreakStatement") {
      if (!statement.label || statement.label.type !== "Identifier") {
        throw new Error("this.trigger break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(statement.test, availableHostModules, true),
          consequent: parseTriggerStatements(
            getBlockStatements(statement.consequent),
            availableHostModules,
          ),
          alternate: statement.alternate
            ? parseTriggerStatements(
                getBlockStatements(statement.alternate),
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement.argument
            ? parseExpression(statement.argument, availableHostModules, true)
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.trigger", statement);
    }
    const expression = statement.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(
        `Unsupported this.trigger expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observe"
    ) {
      return [
        parseObserveCall(expression, "observe", availableHostModules) as
          | ObserveAction
          | ObserveGroupAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const mutation = parseCellMutationCall(
      expression,
      availableHostModules,
      "action",
    );
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }

    throw new Error("Unsupported this.trigger call");
  });
}

function parseGuardStatements(
  statements: acorn.Statement[],

  availableHostModules: Map<string, string>,
): GuardStatement[] {
  return statements.flatMap<GuardStatement>((statement) => {
    if (statement.type === "LabeledStatement") {
      if (statement.label.type !== "Identifier") {
        throw new Error("this.guard labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.guard labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement.label.name,
          body: parseGuardStatements(statement.body.body, availableHostModules),
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "BreakStatement") {
      if (!statement.label || statement.label.type !== "Identifier") {
        throw new Error("this.guard break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(statement.test, availableHostModules, true),
          consequent: parseGuardStatements(
            getBlockStatements(statement.consequent),
            availableHostModules,
          ),
          alternate: statement.alternate
            ? parseGuardStatements(
                getBlockStatements(statement.alternate),
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement.argument
            ? parseGuardReturnValue(
                statement.argument as acorn.Expression,
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.guard", statement);
    }
    const expression = statement.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(
        `Unsupported this.guard expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observe"
    ) {
      return [
        parseObserveCall(expression, "observe", availableHostModules) as
          | ObserveAction
          | ObserveGroupAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const mutation = parseCellMutationCall(
      expression,
      availableHostModules,
      "action",
    );
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }

    throw new Error("Unsupported this.guard call");
  });
}

function parseCatchDeflectionStatements(
  statements: acorn.Statement[],

  availableHostModules: Map<string, string>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  enclosing: EnclosingNode,
): CatchDeflectionStatement[] {
  const expressionContext: ExpressionParseContext = {
    deflectionTargets: { availableImports, visibleNodeNames, enclosing },
  };
  const parseHookExpression = (expression: acorn.Expression): ValueExpression =>
    parseExpression(expression, availableHostModules, true, expressionContext);

  return statements.flatMap<CatchDeflectionStatement>((statement) => {
    if (statement.type === "LabeledStatement") {
      if (statement.label.type !== "Identifier") {
        throw new Error(
          "this.catchDeflection labels must use identifier names",
        );
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error(
          "this.catchDeflection labels must target a block statement",
        );
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement.label.name,
          body: parseCatchDeflectionStatements(
            statement.body.body,
            availableHostModules,
            availableImports,
            visibleNodeNames,
            enclosing,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "BreakStatement") {
      if (!statement.label || statement.label.type !== "Identifier") {
        throw new Error(
          "this.catchDeflection break statements must specify a label",
        );
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseHookExpression(statement.test),
          consequent: parseCatchDeflectionStatements(
            getBlockStatements(statement.consequent),
            availableHostModules,
            availableImports,
            visibleNodeNames,
            enclosing,
          ),
          alternate: statement.alternate
            ? parseCatchDeflectionStatements(
                getBlockStatements(statement.alternate),
                availableHostModules,
                availableImports,
                visibleNodeNames,
                enclosing,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement.argument
            ? parseHookExpression(statement.argument as acorn.Expression)
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.catchDeflection", statement);
    }
    const expression = statement.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(
        `Unsupported this.catchDeflection expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observe"
    ) {
      return [
        parseObserveCall(
          expression,
          "observe",
          availableHostModules,
          expressionContext,
        ) as ObserveAction | ObserveGroupAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observeOrAsk"
    ) {
      return [
        parseObserveCall(
          expression,
          "observeOrAsk",
          availableHostModules,
          expressionContext,
        ),
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const mutation = parseCellMutationCall(
      expression,
      availableHostModules,
      "action",
      expressionContext,
    );
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }

    throw new Error("Unsupported this.catchDeflection call");
  });
}

function parseGuardReturnValue(
  expression: acorn.Expression,
  availableHostModules: Map<string, string>,
): ValueExpression {
  const parsed = parseExpression(expression, availableHostModules, true);
  if (parsed.kind !== "literal") {
    throw new Error(
      "this.guard must return State.SKIPPED, State.DEFLECTED, State.COVERED, or undefined",
    );
  }
  if (
    parsed.value !== "skipped" &&
    parsed.value !== "deflected" &&
    parsed.value !== "covered" &&
    parsed.value !== undefined &&
    parsed.value !== null
  ) {
    throw new Error(
      "this.guard must return State.SKIPPED, State.DEFLECTED, State.COVERED, or undefined",
    );
  }
  return parsed;
}

function parseEffectStatements(
  statements: acorn.Statement[],

  availableHostModules: Map<string, string>,
  expressionContext: ExpressionParseContext,
): EffectStatement[] {
  return statements.flatMap<EffectStatement>((statement) => {
    if (statement.type === "LabeledStatement") {
      if (statement.label.type !== "Identifier") {
        throw new Error("this.effects labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.effects labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement.label.name,
          body: parseEffectStatements(
            statement.body.body,
            availableHostModules,
            expressionContext,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "BreakStatement") {
      if (!statement.label || statement.label.type !== "Identifier") {
        throw new Error("this.effects break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(
            statement.test,
            availableHostModules,
            true,
            expressionContext,
          ),
          consequent: parseEffectStatements(
            getBlockStatements(statement.consequent),
            availableHostModules,
            expressionContext,
          ),
          alternate: statement.alternate
            ? parseEffectStatements(
                getBlockStatements(statement.alternate),
                availableHostModules,
                expressionContext,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (statement.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.effects", statement);
    }
    const expression = statement.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(
        `Unsupported this.effects expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observe"
    ) {
      return [
        parseObserveCall(
          expression,
          "observe",
          availableHostModules,
          expressionContext,
        ) as ObserveAction | ObserveGroupAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "$observeOrAsk"
    ) {
      throw new Error("$observeOrAsk() is forbidden inside this.effects");
    }

    const mutation = parseCellMutationCall(
      expression,
      availableHostModules,
      "effects",
      expressionContext,
    );
    if (mutation) return [mutation];

    const hostCall = parseStandaloneHostCall(
      expression,
      availableHostModules,
      expressionContext,
    );
    if (hostCall) return [hostCall];

    throw new Error("Unsupported this.effects call");
  });
}

function parseStandaloneHostCall(
  expression: acorn.CallExpression,

  availableHostModules: Map<string, string>,
  expressionContext?: ExpressionParseContext,
): HostCall | undefined {
  if (expression.callee.type === "Super") return undefined;
  const target = parseHostCallTarget(expression.callee, availableHostModules);
  if (!target) {
    const operation =
      expression.callee.type === "MemberExpression" &&
      !expression.callee.computed &&
      expression.callee.property.type === "Identifier"
        ? expression.callee.property.name
        : expression.callee.type === "MemberExpression" &&
            expression.callee.computed &&
            expression.callee.property.type === "Literal" &&
            typeof expression.callee.property.value === "string"
          ? expression.callee.property.value
          : undefined;
    if (operation?.startsWith("$")) {
      throw new Error(
        "Standalone host calls must be rooted in a declared host module import",
      );
    }
    return undefined;
  }
  if (!target.operation.startsWith("$") || target.operation.length === 1) {
    if (!target.operation.startsWith("$")) {
      throw new Error("Standalone host calls require a $-prefixed operation");
    }
    return undefined;
  }

  const args = expression.arguments.map((arg) => {
    if (arg.type === "SpreadElement") {
      throw new Error("Host calls do not support spread arguments");
    }
    return parseHostCallArgument(
      arg,
      availableHostModules,
      true,
      expressionContext,
    );
  });

  return {
    id: UNSTAMPED_ID,
    kind: "host-call",
    module: target.module,
    target: target.path,
    operation: target.operation.slice(1),
    arguments: args,
    loc: locOf(expression),
  };
}

function rejectUnsupportedInstructionIml(template: SemanticString): void {
  const text =
    template.kind === "literal"
      ? template.value
      : template.parts
          .filter(
            (part): part is TemplateStringPart & { kind: "text" } =>
              part.kind === "text",
          )
          .map((part) => part.value)
          .join("");
  if (text.includes(":::when") || text.includes(":::else")) {
    throw new Error(
      "Arc does not support :::when/:::else conditional IML in instruction literals",
    );
  }
}

function findCell(cells: Cell[], name: string): Cell | undefined {
  // `cells` accumulates outermost-first (ancestor chain then the current node),
  // so the last match is the innermost declaration — matching runtime lexical
  // resolution (`findCellOwner` walks the lexical parent chain outward), where a
  // node's own cell shadows a same-named ancestor cell.
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]!.name === name) return cells[index];
  }
  return undefined;
}

function hasCell(cells: Cell[], name: string): boolean {
  return findCell(cells, name) !== undefined;
}

/**
 * Validates one `$enter(...)` / `$enterLoop(...)` channel binding map against
 * the target's declared signature when the target is a same-document node. For
 * each binding: the target must declare the key; the bound source's provided
 * schema must be compatible with the declared channel schema. Imported targets
 * are checked at registration. A caller-cell `returns` sink may be bound to at
 * most one key.
 */
function validateEnterChannelBindings(
  statement: Extract<Statement, { kind: "enter-node" | "enter-loop" }>,
  cells: Cell[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const callLabel = statement.kind === "enter-loop" ? "$enterLoop" : "$enter";
  const references = options.references;
  const targetNode =
    references && !statement.target.imported
      ? references.nodeLookup?.get(statement.target.identifier)
      : undefined;
  const targetSignature = targetNode?.signature;
  const callerSignature = references?.currentNode.signature;

  // Resolves the schema a binding source provides, or records an issue.
  const sourceSpec = (
    source: EnterChannelBindings[string],
  ): ChannelSpec | undefined => {
    if (source.kind === "cell") {
      const cell = findCell(cells, source.cell);
      if (!cell) {
        issues.push({
          code: "UNKNOWN_CELL",
          message: `Unknown cell: ${source.cell}`,
          loc: statement.loc,
        });
        return undefined;
      }
      const spec = cellSpecToChannelSpec(cell);
      if (!spec) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() cannot bind cell ${source.cell} across an enter boundary`,
          loc: statement.loc,
        });
      }
      return spec;
    }
    if (source.kind === "argsProjection") {
      // Forwards the caller's own declared args channel.
      const declared = callerSignature?.args[source.key];
      if (!declared) {
        issues.push({
          code: "UNKNOWN_ARGS_PROJECTION",
          message: `${callLabel}() forwards args.${source.key}, which the enclosing node does not declare`,
          loc: statement.loc,
        });
      }
      return declared;
    }
    if (source.kind === "span") {
      const context = mapContextStack[mapContextStack.length - 1];
      if (!context) {
        issues.push({
          code: "SPAN_OUTSIDE_MAP",
          message: `${callLabel}() binds span.${source.key} outside a $map callback`,
          loc: statement.loc,
        });
        return undefined;
      }
      // `span.item` / `span.result` carry the map's receiver / results element
      // schema, so the caller-side compatibility check runs against the child's
      // declared channel like any other binding.
      if (source.key === "index") return { type: "index" };
      return source.key === "item" ? context.receiverSpec : context.resultsSpec;
    }
    return undefined;
  };

  for (const [key, source] of Object.entries(statement.args ?? {})) {
    const provided = sourceSpec(source);
    if (targetSignature) {
      const declared = targetSignature.args[key];
      if (!declared) {
        issues.push({
          code: "UNDECLARED_ARGS_KEY",
          message: `${callLabel}() binds args.${key}, which ${statement.target.identifier} does not declare`,
          loc: statement.loc,
        });
      } else if (provided && !reusableSpecCompatible(provided, declared)) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() args.${key} binding is incompatible with the declared channel type`,
          loc: statement.loc,
        });
      }
    }
  }

  const boundReturnCells = new Set<string>();
  for (const [key, source] of Object.entries(statement.returns ?? {})) {
    if (source.kind === "cell") {
      if (boundReturnCells.has(source.cell)) {
        issues.push({
          code: "ENTER_CHANNEL_DUPLICATE_CELL",
          message: `${callLabel}().returns binds caller cell ${source.cell} more than once`,
          loc: statement.loc,
        });
      }
      boundReturnCells.add(source.cell);
    }
    const provided = sourceSpec(source);
    if (targetSignature) {
      const declared = targetSignature.returns[key];
      if (!declared) {
        issues.push({
          code: "UNDECLARED_RETURNS_KEY",
          message: `${callLabel}() binds returns.${key}, which ${statement.target.identifier} does not declare`,
          loc: statement.loc,
        });
      } else if (provided && !reusableSpecCompatible(declared, provided)) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() returns.${key} binding is incompatible with the declared channel type`,
          loc: statement.loc,
        });
      }
    }
  }
}

type ExpressionScope = "ordinary" | "catchDeflection" | "effects";

type TargetBinding = "local" | "imported" | "self";

type ReferenceValidationContext = {
  currentNode: Node;
  visibleLocalNodes: ReadonlySet<string>;
  visibleImportNames: ReadonlySet<string>;
  /**
   * Same-document nodes visible for signature lookup, keyed by identifier. Used
   * to check `$enter(...)` channel bindings against the target's declared
   * signature; imported targets are checked at registration instead.
   */
  nodeLookup?: ReadonlyMap<string, Node>;
};

type ValidationOptions = {
  forbidArtifactSemanticRefs?: boolean;
  expressionScope?: ExpressionScope;
  references?: ReferenceValidationContext;
  hostModules?: ReadonlyMap<string, HostModuleSpec>;
};

const TRIGGER_VALIDATION_OPTIONS: ValidationOptions = {
  forbidArtifactSemanticRefs: true,
};

function validateDocumentShape(
  document: Document,
  issues: ValidationIssue[],
): void {
  const importNames = new Set<string>();
  for (const binding of document.imports) {
    if (importNames.has(binding.localName)) {
      issues.push({
        code: "DUPLICATE_IMPORT",
        message: `Duplicate import binding: ${binding.localName}`,
        loc: binding.loc,
      });
      continue;
    }
    importNames.add(binding.localName);
  }

  const rootNames = new Set<string>();
  for (const root of document.roots) {
    if (rootNames.has(root.identifier)) {
      issues.push({
        code: "DUPLICATE_ARC",
        message: `Duplicate arc: ${root.identifier}`,
        loc: root.loc,
      });
      continue;
    }
    rootNames.add(root.identifier);
  }
}

function validateNodeShape(
  node: Node,
  documentImportNames: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (node.identifier === "invoke") {
    issues.push({
      code: "RESERVED_NAME",
      message: "invoke is a reserved name and cannot name a node",
      loc: node.loc,
    });
  }
  // `parseNode` always sets this, so only hand-built or deserialized IR can
  // reach the trust boundary with it missing or misspelled.
  if (node.writeDiffMode !== "advance" && node.writeDiffMode !== "rewalk") {
    issues.push({
      code: "INVALID_WRITE_DIFF_MODE",
      message: `Invalid writeDiffMode: ${JSON.stringify(node.writeDiffMode)}. Expected "advance" or "rewalk"`,
      loc: node.loc,
    });
  }
  const cells = new Set<string>();
  for (const cell of node.cells) {
    if (cell.name === "invoke") {
      issues.push({
        code: "RESERVED_NAME",
        message: "invoke is a reserved name and cannot name a cell",
        loc: cell.loc,
      });
    }
    if (cells.has(cell.name)) {
      issues.push({
        code: "DUPLICATE_CELL",
        message: `Duplicate cell: ${cell.name}`,
        loc: cell.loc,
      });
      continue;
    }
    cells.add(cell.name);
  }

  const childNames = new Set<string>();
  for (const child of node.children) {
    if (childNames.has(child.identifier)) {
      issues.push({
        code: "DUPLICATE_NODE",
        message: `Duplicate child node: ${child.identifier}`,
        loc: child.loc,
      });
      continue;
    }
    childNames.add(child.identifier);
  }

  const importNames = new Set<string>();
  for (const importName of node.imports) {
    if (importNames.has(importName)) {
      issues.push({
        code: "DUPLICATE_NODE_IMPORT",
        message: `Duplicate node import visibility: ${importName}`,
        loc: node.loc,
      });
      continue;
    }
    importNames.add(importName);
    if (!documentImportNames.has(importName)) {
      issues.push({
        code: "UNKNOWN_IMPORT",
        message: `Node import visibility references an unknown import: ${importName}`,
        loc: node.loc,
      });
    }
  }
}

function resolveTargetBinding(
  identifier: string,
  references: ReferenceValidationContext,
): TargetBinding | undefined {
  const childNames = new Set(
    references.currentNode.children.map((child) => child.identifier),
  );
  if (
    identifier === references.currentNode.identifier &&
    !childNames.has(identifier) &&
    !references.visibleImportNames.has(identifier)
  ) {
    return "self";
  }
  if (references.visibleLocalNodes.has(identifier)) return "local";
  if (references.visibleImportNames.has(identifier)) return "imported";
  return undefined;
}

function resolveNodeStateBinding(
  identifier: string,
  references: ReferenceValidationContext,
): Exclude<TargetBinding, "self"> | undefined {
  if (references.visibleLocalNodes.has(identifier)) return "local";
  if (references.visibleImportNames.has(identifier)) return "imported";
  return undefined;
}

function validateTargetMode(
  target: EnterTarget,
  issues: ValidationIssue[],
  loc: SourceRange | undefined,
): boolean {
  if (
    target.mode === "canonical" ||
    target.mode === "forgetful" ||
    target.mode === "newcopy"
  ) {
    return true;
  }
  issues.push({
    code: "INVALID_TARGET_MODE",
    message: `Invalid target mode: ${String(target.mode)}`,
    loc,
  });
  return false;
}

function validateEnterTarget(
  target: EnterTarget,
  issues: ValidationIssue[],
  loc: SourceRange | undefined,
  references: ReferenceValidationContext | undefined,
): void {
  validateTargetMode(target, issues, loc);
  if (!references) return;

  const binding = resolveTargetBinding(target.identifier, references);
  if (!binding) {
    issues.push({
      code: "UNDEFINED_NODE",
      message: `Unknown node: ${target.identifier}`,
      loc,
    });
    return;
  }
  if (binding === "self") {
    issues.push({
      code: "SELF_ENTRY",
      message: `$enter() cannot re-enter the enclosing node ${target.identifier}`,
      loc,
    });
    return;
  }
  if (target.imported !== (binding === "imported")) {
    issues.push({
      code: "TARGET_IMPORT_MISMATCH",
      message: `Target ${target.identifier} has imported=${target.imported}, but resolves as ${binding}`,
      loc,
    });
  }
}

function validateDeflectionTarget(
  target: EnterTarget,
  issues: ValidationIssue[],
  loc: SourceRange | undefined,
  references: ReferenceValidationContext | undefined,
): void {
  if (target.mode !== "canonical") {
    issues.push({
      code: "INVALID_DEFLECTION_TARGET",
      message: "this.deflection.escaped() only accepts a canonical bare target",
      loc,
    });
  }
  if (!references) return;

  const binding = resolveTargetBinding(target.identifier, references);
  if (!binding) {
    issues.push({
      code: "UNDEFINED_NODE",
      message: `Unknown node: ${target.identifier}`,
      loc,
    });
    return;
  }
  if (target.imported !== (binding === "imported")) {
    issues.push({
      code: "TARGET_IMPORT_MISMATCH",
      message: `Target ${target.identifier} has imported=${target.imported}, but resolves as ${binding}`,
      loc,
    });
  }
}

type ResolvedCellTargetSpec =
  | { kind: "direct"; spec: CellSpec }
  | { kind: "decorated"; spec: ArrayElementSpec };

function cellTargetRoot(target: CellTarget): string {
  return target[0];
}

function formatCellTarget(target: CellTarget): string {
  let rendered = target[0];
  const [, ...accessors] = target;
  for (const accessor of accessors) {
    if (accessor.kind === "literal") {
      rendered += `[${JSON.stringify(accessor.value)}]`;
    } else if (accessor.kind === "cell") {
      rendered += `[${accessor.name}]`;
    } else {
      rendered += "[...]";
    }
  }
  return rendered;
}

function descendCellTargetSpec(
  spec: CellSpec,
  remainingAccessors: number,
  onNonContainer?: () => void,
): ArrayElementSpec | undefined {
  if (spec.type !== "array") {
    onNonContainer?.();
    return undefined;
  }
  const leafSpec = spec.element;
  if (remainingAccessors === 1) return leafSpec;
  return descendCellTargetSpec(
    leafSpec,
    remainingAccessors - 1,
    onNonContainer,
  );
}

function resolveCellTargetSpec(
  rootSpec: CellSpec,
  accessorCount: number,
  onNonContainer?: () => void,
): ResolvedCellTargetSpec | undefined {
  if (accessorCount === 0) return { kind: "direct", spec: rootSpec };
  const leafSpec = descendCellTargetSpec(
    rootSpec,
    accessorCount,
    onNonContainer,
  );
  return leafSpec ? { kind: "decorated", spec: leafSpec } : undefined;
}

function cellTargetSpec(
  target: CellTarget,
  cells: Cell[],
): ResolvedCellTargetSpec | undefined {
  const rootSpec = findCell(cells, cellTargetRoot(target));
  if (!rootSpec) return undefined;
  return resolveCellTargetSpec(rootSpec, target.length - 1);
}

function validateCellTarget(
  target: CellTarget,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
  loc: SourceRange | undefined,
): ResolvedCellTargetSpec | undefined {
  const [root, ...accessors] = target;
  const rootCell = findCell(cells, root);
  if (!rootCell) {
    issues.push({
      code: "UNKNOWN_CELL",
      message: `Unknown cell: ${root}`,
      loc,
    });
  } else if (accessors.length > 0) {
    // Resolving a subcell reads the current aggregate before replacing one leaf.
    recordCellRead(root);
  }

  for (const accessor of accessors) {
    validateExpression(accessor, cells, nodes, issues, options);
    if (
      expressionIsArray(
        accessor,
        cells,
        options.references?.currentNode.signature,
        options,
      )
    ) {
      issues.push({
        code: "ARRAY_AS_INDEX",
        message: "An array cannot be used as an array index",
        loc,
      });
    }
  }

  if (!rootCell) return undefined;
  return resolveCellTargetSpec(rootCell, accessors.length, () => {
    issues.push({
      code: "CELL_TARGET_NON_CONTAINER",
      message: `Cell target ${formatCellTarget(target)} accesses through a non-container value`,
      loc,
    });
  });
}

function validateObserveTarget(
  statement: ObserveAction | ObserveOrAskAction,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const targetSpec = validateCellTarget(
    statement.target,
    cells,
    nodes,
    issues,
    options,
    statement.loc,
  );
  if (!targetSpec) return;
  if (!isObservableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_OBSERVABLE_CELL",
      message: `$${statement.kind}() requires an observable cell: ${formatCellTarget(statement.target)}`,
      loc: statement.loc,
    });
  }
}

function validateObserveGroupTarget(
  statement: ObserveGroupAction | ObserveOrAskGroupAction,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const method = statement.kind === "observeGroup" ? "observe" : "observeOrAsk";
  for (const target of statement.targets) {
    const targetSpec = validateCellTarget(
      target,
      cells,
      nodes,
      issues,
      options,
      statement.loc,
    );
    if (!targetSpec) continue;
    if (!isObservableCellSpec(targetSpec.spec)) {
      issues.push({
        code: "NON_OBSERVABLE_CELL",
        message: `$${method}({ ... }) requires an observable cell: ${formatCellTarget(target)}`,
        loc: statement.loc,
      });
    }
  }
}

function validateSetTarget(
  statement: SetAction,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): boolean {
  const targetSpec = validateCellTarget(
    statement.target,
    cells,
    nodes,
    issues,
    options,
    statement.loc,
  );
  if (!targetSpec) return false;
  if (targetSpec.kind === "direct" && !isSettableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_SETTABLE_CELL",
      message: `Cell target cannot be set with $set(): ${formatCellTarget(statement.target)}`,
      loc: statement.loc,
    });
    return false;
  }
  return true;
}

function validateUnsetTarget(
  statement: UnsetAction,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): boolean {
  if (statement.target.length !== 1) {
    issues.push({
      code: "NON_UNSETTABLE_CELL",
      message: `$unset() requires a direct cell target: ${formatCellTarget(statement.target)}`,
      loc: statement.loc,
    });
    return false;
  }
  const targetSpec = validateCellTarget(
    statement.target,
    cells,
    nodes,
    issues,
    options,
    statement.loc,
  );
  if (!targetSpec) return false;
  if (targetSpec.kind !== "direct" || !isSettableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_UNSETTABLE_CELL",
      message: `Cell cannot be unset with $unset(): ${formatCellTarget(statement.target)}`,
      loc: statement.loc,
    });
    return false;
  }
  return true;
}

function validateNode(
  node: Node,
  context: {
    issues: ValidationIssue[];
    lintIssues: LintIssue[];
    cells: Cell[];
    visibleLocalNodes: ReadonlySet<string>;
    visibleImportNames: ReadonlySet<string>;
    documentImportNames: ReadonlySet<string>;
    nodeLookup: Map<string, Node>;
    bySeg: Map<Node, Map<SegKey, NodeReadSet>>;
    hostModules?: ReadonlyMap<string, HostModuleSpec>;
  },
): void {
  validateNodeShape(node, context.documentImportNames, context.issues);
  const cells = [...context.cells, ...node.cells];
  const childNames = new Set(node.children.map((child) => child.identifier));
  const visibleLocalNodes = new Set([
    ...context.visibleLocalNodes,
    ...childNames,
  ]);
  const visibleImportNames = new Set([
    ...context.visibleImportNames,
    ...node.imports,
  ]);
  const nodeNames = [...visibleLocalNodes, ...visibleImportNames];
  const nodeLookup = new Map(context.nodeLookup);
  for (const child of node.children) {
    nodeLookup.set(child.identifier, child);
  }
  const baseOptions: ValidationOptions = {
    expressionScope: "ordinary",
    hostModules: context.hostModules,
    references: {
      currentNode: node,
      visibleLocalNodes,
      visibleImportNames,
      nodeLookup,
    },
  };
  const triggerOptions: ValidationOptions = {
    ...baseOptions,
    ...TRIGGER_VALIDATION_OPTIONS,
  };
  const catchDeflectionOptions: ValidationOptions = {
    ...baseOptions,
    expressionScope: "catchDeflection",
  };
  const effectsOptions: ValidationOptions = {
    ...baseOptions,
    expressionScope: "effects",
  };

  // Collect this node's read-set from every SEG it owns. Children are validated
  // separately below with their own builder, so each node records only its own
  // condition-readable references.
  const builder: ReadSetBuilder = {
    cells: new Set(),
    nodeIdentifiers: new Set(),
    channels: new Map(),
  };
  const previousReadSet = activeReadSet;
  const previousSegReadSets = activeSegReadSets;
  const segReadSets = new Map<SegKey, NodeReadSet>();
  activeReadSet = builder;
  activeSegReadSets = segReadSets;
  try {
    for (const cell of node.cells) {
      if (isScalarObservableCell(cell) && cell.observing !== undefined) {
        validateSemanticString(
          cell.observing,
          cells,
          nodeNames,
          context.issues,
          baseOptions,
        );
      }
      if (
        isArrayCell(cell) &&
        cell.element.type !== "artifact" &&
        cell.element.observing !== undefined
      ) {
        validateSemanticString(
          cell.element.observing,
          cells,
          nodeNames,
          context.issues,
          baseOptions,
        );
      }
      if (cell.type === "artifact" && cell.initializer !== undefined) {
        validateExpression(
          cell.initializer,
          cells,
          nodeNames,
          context.issues,
          baseOptions,
        );
      }
    }

    for (const statement of node.statements) {
      validateStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        baseOptions,
      );
    }
    lintNodeStatements(node, {
      lintIssues: context.lintIssues,
      nodeLookup,
      cellTypes: new Map(cells.map((cell) => [cell.name, cell.type])),
      inInvoke: false,
    });
    lintNodeBareCellBooleans(node, context.lintIssues);
    lintNodeReadBeforeSet(node, context.lintIssues);
    for (const statement of node.trigger ?? []) {
      validateTriggerStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        triggerOptions,
      );
    }
    for (const statement of node.deflectWhen ?? []) {
      validateTriggerStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        baseOptions,
      );
    }
    for (const statement of node.guard ?? []) {
      validateGuardStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        baseOptions,
      );
    }
    for (const statement of node.effects ?? []) {
      validateEffectStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        effectsOptions,
      );
    }
    for (const statement of node.catchDeflection ?? []) {
      validateCatchDeflectionStatement(
        statement,
        cells,
        nodeNames,
        context.issues,
        [],
        catchDeflectionOptions,
      );
    }
  } finally {
    activeReadSet = previousReadSet;
    activeSegReadSets = previousSegReadSets;
  }
  segReadSets.set(nodeSegKey("body"), finalizeReadSet(builder));
  context.bySeg.set(node, segReadSets);

  for (const child of node.children) {
    validateNode(child, {
      issues: context.issues,
      lintIssues: context.lintIssues,
      cells: cells,
      // Accumulate all ancestor node names, matching parse-time visibility
      // (`nextVisibleNodeNames`) and runtime resolution (`resolveLexicalRef`
      // climbs `lexicalParentRef`). Cells already accumulate above.
      visibleLocalNodes,
      visibleImportNames,
      documentImportNames: context.documentImportNames,
      nodeLookup,
      bySeg: context.bySeg,
      hostModules: context.hostModules,
    });
  }
}

function validateStatement(
  statement: Statement,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
  options: ValidationOptions = {},
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, cells, nodes, issues, options);
    checkBooleanValue(
      statement.test,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    statement.consequent.forEach((entry) =>
      validateStatement(entry, cells, nodes, issues, labels, options),
    );
    statement.alternate?.forEach((entry) =>
      validateStatement(entry, cells, nodes, issues, labels, options),
    );
    return;
  }

  if (statement.kind === "label") {
    if (labels.includes(statement.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement.label}`,
        loc: statement.loc,
      });
    }
    statement.body.forEach((entry) =>
      validateStatement(
        entry,
        cells,
        nodes,
        issues,
        [...labels, statement.label],
        options,
      ),
    );
    return;
  }

  if (statement.kind === "break") {
    if (!labels.includes(statement.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement.label}`,
        loc: statement.loc,
      });
    }
    return;
  }

  if (statement.kind === "invoke") {
    // The body validates under the enclosing scope with an independent label
    // scope, and its reads collect into its own per-invoke read-set alongside
    // every enclosing set.
    const invokeBuilder: ReadSetBuilder = {
      cells: new Set(),
      nodeIdentifiers: new Set(),
      channels: new Map(),
    };
    activeInvokeBuilders.push(invokeBuilder);
    try {
      statement.body.forEach((entry) =>
        validateStatement(entry, cells, nodes, issues, [], options),
      );
    } finally {
      activeInvokeBuilders.pop();
    }
    activeSegReadSets?.set(
      invokeSegKey(statement.id),
      finalizeReadSet(invokeBuilder),
    );
    return;
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    validateObserveTarget(statement, cells, nodes, issues, options);
    if (statement.question !== undefined) {
      validateSemanticString(statement.question, cells, nodes, issues, options);
    }
    return;
  }

  if (
    statement.kind === "observeGroup" ||
    statement.kind === "observeOrAskGroup"
  ) {
    validateObserveGroupTarget(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "set") {
    validateSetTarget(statement, cells, nodes, issues, options);
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedCellAssignment(
      statement,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    return;
  }

  if (statement.kind === "unset") {
    validateUnsetTarget(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "set-return") {
    issues.push({
      code: "SET_RETURN_OUTSIDE_EFFECTS",
      message: "returns.*.$set(...) is only allowed inside this.effects",
      loc: statement.loc,
    });
    validateExpression(statement.value, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "enter-node" || statement.kind === "enter-loop") {
    validateEnterTarget(
      statement.target,
      issues,
      statement.loc,
      options.references,
    );
    validateEnterChannelBindings(statement, cells, issues, options);
    if (statement.kind === "enter-loop") {
      for (const entry of statement.resolveWhen) {
        validateTriggerStatement(entry, cells, nodes, issues, [], options);
      }
    }
    return;
  }

  if (statement.kind === "set-span") {
    const context = mapContextStack[mapContextStack.length - 1];
    if (!context) {
      issues.push({
        code: "SPAN_OUTSIDE_MAP",
        message: "span.result is only available inside a $map callback",
        loc: statement.loc,
      });
    } else {
      checkTypedAssignable(
        context.resultsSpec,
        statement.value,
        cells,
        options.references?.currentNode.signature,
        "SPAN_TYPE",
        "span.result.$set() value type is incompatible with the results element type",
        issues,
        statement.loc,
        options,
      );
    }
    validateExpression(statement.value, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "map") {
    validateMapStatement(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "host-call") {
    for (const argument of statement.arguments) {
      validateHostCallArgument(argument, cells, nodes, issues, options);
    }
    validateHostCall(statement, cells, issues, options);
    return;
  }

  validateSemanticString(statement.template, cells, nodes, issues, options);
  for (const entry of statement.resolveWhen ?? []) {
    validateTriggerStatement(entry, cells, nodes, issues, [], options);
  }
  for (const entry of statement.deflectWhen ?? []) {
    validateTriggerStatement(entry, cells, nodes, issues, [], options);
  }
}

/** The element schema of a `$map` receiver, for typing `span.item`. */
function arrayReferenceElementSpec(
  ref: ArrayReference,
  cells: Cell[],
  signature: NodeSignature | undefined,
): ArrayElementSpec | undefined {
  if (ref.kind === "cell") {
    const cell = findCell(cells, ref.name);
    return cell && isArrayCell(cell) ? cell.element : undefined;
  }
  const spec = signature?.[ref.namespace]?.[ref.key];
  return spec?.type === "array" ? spec.element : undefined;
}

/** The element schema of a `$map` `results` cell, for typing `span.result`. */
function arrayCellElementSpec(
  name: string,
  cells: Cell[],
): ArrayElementSpec | undefined {
  const cell = findCell(cells, name);
  return cell && isArrayCell(cell) ? cell.element : undefined;
}

function producerContext(
  cells: Cell[],
  signature: NodeSignature | undefined,
  options: ValidationOptions = {},
): ProducerContext {
  const map = mapContextStack[mapContextStack.length - 1];
  return {
    cells,
    signature,
    map: map
      ? {
          receiverSpec: map.receiverSpec,
          resultSpec: map.resultsSpec,
        }
      : undefined,
    resolveHostOperation:
      options.hostModules === undefined
        ? undefined
        : (call) => {
            const resolution = resolveHostOperation(options.hostModules!, call);
            return resolution.kind === "resolved"
              ? resolution.operation
              : undefined;
          },
  };
}

function checkNumericOperand(
  expression: ValueExpression,
  op: string,
  side: "left" | "right" | "argument",
  cells: Cell[],
  signature: NodeSignature | undefined,
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const judgment = arithmeticRule.checkProducer(
    expression,
    producerContext(cells, signature, options),
  );
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_NUMERIC_ARITHMETIC_OPERAND",
      message: `Arithmetic operator ${op} requires a numeric ${side} operand`,
    });
  }
}

function checkNumIsFiniteArgument(
  expression: ValueExpression,
  cells: Cell[],
  signature: NodeSignature | undefined,
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const judgment = numIsFiniteRule.checkProducer(
    expression,
    producerContext(cells, signature, options),
  );
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_NUMERIC_IS_FINITE_ARGUMENT",
      message: "Num.isFinite requires a numeric argument",
    });
  }
}

/**
 * Reports a type issue when a value expression's statically-known schema is
 * incompatible with a typed target — a `span.result` / `returns.*` sink element
 * type, or the cell a `span.*` / `args.*` / `returns.*` read flows
 * into. Skips a target or value whose schema is not statically known.
 */
function checkTypedAssignable(
  target: ChannelSpec | undefined,
  value: ValueExpression,
  cells: Cell[],
  signature: NodeSignature | undefined,
  code: string,
  label: string,
  issues: ValidationIssue[],
  loc: SourceRange | undefined,
  options: ValidationOptions,
): void {
  if (!target) return;
  const judgment = judgeProducerLanding(
    resolveProducer(value, producerContext(cells, signature, options)),
    target,
  );
  if (judgment.kind === "incompatible") {
    issues.push({ code, message: label, loc });
  }
}

/**
 * Rejects a cell write when both its source and destination value families are
 * statically known and disjoint. Unknown sources remain runtime-checked.
 */
function checkTypedCellAssignment(
  statement: SetAction,
  cells: Cell[],
  signature: NodeSignature | undefined,
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const targetSpec = cellTargetSpec(statement.target, cells);
  const destination =
    targetSpec === undefined
      ? undefined
      : cellSpecToChannelSpec(targetSpec.spec);
  let code: string;
  let message: string;
  if (destination?.type === "artifact") {
    code = "ARTIFACT_VALUE_TYPE";
    message = `${formatCellTarget(statement.target)}.$set() requires an Artifact value`;
  } else if (statement.value.kind === "span") {
    code = "SPAN_TYPE";
    message = `span.${statement.value.key} type is incompatible with ${formatCellTarget(statement.target)}`;
  } else if (statement.value.kind === "channel") {
    code = "CHANNEL_VALUE_TYPE";
    message = `${statement.value.namespace}.${statement.value.key} type is incompatible with ${formatCellTarget(statement.target)}`;
  } else {
    code = "CELL_VALUE_TYPE";
    message = `Value type is incompatible with ${formatCellTarget(statement.target)}`;
  }
  checkTypedAssignable(
    destination,
    statement.value,
    cells,
    signature,
    code,
    message,
    issues,
    statement.loc,
    options,
  );
}

/**
 * Validates a `$map` statement: its receiver reads an array, its `results` (when
 * present) is a writable array cell, and its callback body validates under the
 * invoke dialect with its own read-set captured under the map's scope.
 */
function validateMapStatement(
  statement: Extract<Statement, { kind: "map" }>,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const signature = options.references?.currentNode.signature;
  validateArrayReference(statement.receiver, "index", cells, issues, signature);
  if (statement.results !== undefined) {
    const cell = findCell(cells, statement.results);
    if (!cell) {
      issues.push({
        code: "UNKNOWN_CELL",
        message: `Unknown cell: ${statement.results}`,
        loc: statement.loc,
      });
    } else if (!isArrayCell(cell)) {
      issues.push({
        code: "MAP_RESULTS_NON_ARRAY",
        message: `$map() results cell ${statement.results} is not an array`,
        loc: statement.loc,
      });
    }
  }
  const receiverCell =
    statement.receiver.kind === "cell" ? statement.receiver.name : undefined;
  checkMapCallbackBody(
    statement.body,
    receiverCell,
    statement.results !== undefined,
    issues,
  );

  const context: MapValidationContext = {
    receiverSpec: arrayReferenceElementSpec(
      statement.receiver,
      cells,
      signature,
    ),
    resultsSpec:
      statement.results !== undefined
        ? arrayCellElementSpec(statement.results, cells)
        : undefined,
  };
  const mapBuilder: ReadSetBuilder = {
    cells: new Set(),
    nodeIdentifiers: new Set(),
    channels: new Map(),
  };
  activeInvokeBuilders.push(mapBuilder);
  mapContextStack.push(context);
  try {
    statement.body.forEach((entry) =>
      validateStatement(entry, cells, nodes, issues, [], options),
    );
  } finally {
    mapContextStack.pop();
    activeInvokeBuilders.pop();
  }
  activeSegReadSets?.set(
    invokeSegKey(statement.id),
    finalizeReadSet(mapBuilder),
  );
}

/**
 * Walks a `$map` callback body — descending `if` / `label` / `invoke` bodies —
 * and records the callback-only rejections: a nested `$map`, a non-`newcopy`
 * enter target at any depth, a write to the receiver cell, and any `span.result`
 * use in a forEach `$map` (no `results` binding).
 */
function checkMapCallbackBody(
  body: readonly Statement[],
  receiverCell: string | undefined,
  hasResults: boolean,
  issues: ValidationIssue[],
): void {
  const spanResultBinding = (bindings: EnterChannelBindings | undefined) =>
    Object.values(bindings ?? {}).some(
      (source) => source.kind === "span" && source.key === "result",
    );
  const visit = (list: readonly Statement[]): void => {
    for (const statement of list) {
      switch (statement.kind) {
        case "if":
          visit(statement.consequent);
          if (statement.alternate) visit(statement.alternate);
          break;
        case "label":
          visit(statement.body);
          break;
        case "invoke":
          visit(statement.body);
          break;
        case "map":
          issues.push({
            code: "MAP_NESTED",
            message: "$map cannot be nested inside a $map callback",
            loc: statement.loc,
          });
          break;
        case "enter-node":
        case "enter-loop":
          if (statement.target.mode !== "newcopy") {
            issues.push({
              code: "MAP_ENTER_NOT_NEWCOPY",
              message: `$map callback enter target ${statement.target.identifier} must be newcopy(...)`,
              loc: statement.loc,
            });
          }
          if (!hasResults && spanResultBinding(statement.returns)) {
            issues.push({
              code: "MAP_SPAN_RESULT_NO_RESULTS",
              message:
                "span.result is unavailable in a $map without a results binding",
              loc: statement.loc,
            });
          }
          if (
            receiverCell !== undefined &&
            Object.values(statement.returns ?? {}).some(
              (source) =>
                source.kind === "cell" && source.cell === receiverCell,
            )
          ) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement.loc,
            });
          }
          break;
        case "set":
        case "unset":
        case "observe":
        case "observeOrAsk":
          if (
            receiverCell !== undefined &&
            cellTargetRoot(statement.target) === receiverCell
          ) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement.loc,
            });
          }
          break;
        case "observeGroup":
        case "observeOrAskGroup":
          if (
            receiverCell !== undefined &&
            statement.targets.some(
              (target) => cellTargetRoot(target) === receiverCell,
            )
          ) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement.loc,
            });
          }
          break;
        case "set-span":
          if (!hasResults) {
            issues.push({
              code: "MAP_SPAN_RESULT_NO_RESULTS",
              message:
                "span.result is unavailable in a $map without a results binding",
              loc: statement.loc,
            });
          }
          break;
      }
    }
  };
  visit(body);
}

function validateTriggerStatement(
  statement: TriggerStatement,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
  options: ValidationOptions = {},
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, cells, nodes, issues, options);
    checkBooleanValue(
      statement.test,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    statement.consequent.forEach((entry) =>
      validateTriggerStatement(entry, cells, nodes, issues, labels, options),
    );
    statement.alternate?.forEach((entry) =>
      validateTriggerStatement(entry, cells, nodes, issues, labels, options),
    );
    return;
  }

  if (statement.kind === "label") {
    if (labels.includes(statement.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement.label}`,
        loc: statement.loc,
      });
    }
    statement.body.forEach((entry) =>
      validateTriggerStatement(
        entry,
        cells,
        nodes,
        issues,
        [...labels, statement.label],
        options,
      ),
    );
    return;
  }

  if (statement.kind === "break") {
    if (!labels.includes(statement.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement.label}`,
        loc: statement.loc,
      });
    }
    return;
  }

  if (statement.kind === "return") {
    if (statement.value) {
      validateExpression(statement.value, cells, nodes, issues, options);
      // A trigger, resolveWhen, or deflectWhen return is a boolean position.
      checkBooleanValue(
        statement.value,
        cells,
        options.references?.currentNode.signature,
        issues,
        options,
      );
    }
    return;
  }

  if (statement.kind === "observe") {
    validateObserveTarget(statement, cells, nodes, issues, options);
    if (statement.question !== undefined) {
      validateSemanticString(statement.question, cells, nodes, issues, options);
    }
    return;
  }

  if (statement.kind === "set") {
    validateSetTarget(statement, cells, nodes, issues, options);
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedCellAssignment(
      statement,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    return;
  }

  if (statement.kind === "unset") {
    validateUnsetTarget(statement, cells, nodes, issues, options);
    return;
  }
}

function validateGuardStatement(
  statement: GuardStatement,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
  options: ValidationOptions = {},
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, cells, nodes, issues, options);
    checkBooleanValue(
      statement.test,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    statement.consequent.forEach((entry) =>
      validateGuardStatement(entry, cells, nodes, issues, labels, options),
    );
    statement.alternate?.forEach((entry) =>
      validateGuardStatement(entry, cells, nodes, issues, labels, options),
    );
    return;
  }

  if (statement.kind === "label") {
    if (labels.includes(statement.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement.label}`,
        loc: statement.loc,
      });
    }
    statement.body.forEach((entry) =>
      validateGuardStatement(
        entry,
        cells,
        nodes,
        issues,
        [...labels, statement.label],
        options,
      ),
    );
    return;
  }

  if (statement.kind === "break") {
    if (!labels.includes(statement.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement.label}`,
        loc: statement.loc,
      });
    }
    return;
  }

  if (statement.kind === "return") {
    if (statement.value) {
      validateExpression(statement.value, cells, nodes, issues, options);
    }
    return;
  }

  if (statement.kind === "observe") {
    validateObserveTarget(statement, cells, nodes, issues, options);
    if (statement.question !== undefined) {
      validateSemanticString(statement.question, cells, nodes, issues, options);
    }
    return;
  }

  if (statement.kind === "set") {
    validateSetTarget(statement, cells, nodes, issues, options);
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedCellAssignment(
      statement,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    return;
  }

  if (statement.kind === "unset") {
    validateUnsetTarget(statement, cells, nodes, issues, options);
    return;
  }
}

function validateCatchDeflectionStatement(
  statement: CatchDeflectionStatement,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
  options: ValidationOptions = {},
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, cells, nodes, issues, options);
    checkBooleanValue(
      statement.test,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    statement.consequent.forEach((entry) =>
      validateCatchDeflectionStatement(
        entry,
        cells,
        nodes,
        issues,
        labels,
        options,
      ),
    );
    statement.alternate?.forEach((entry) =>
      validateCatchDeflectionStatement(
        entry,
        cells,
        nodes,
        issues,
        labels,
        options,
      ),
    );
    return;
  }

  if (statement.kind === "label") {
    if (labels.includes(statement.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement.label}`,
        loc: statement.loc,
      });
    }
    statement.body.forEach((entry) =>
      validateCatchDeflectionStatement(
        entry,
        cells,
        nodes,
        issues,
        [...labels, statement.label],
        options,
      ),
    );
    return;
  }

  if (statement.kind === "break") {
    if (!labels.includes(statement.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement.label}`,
        loc: statement.loc,
      });
    }
    return;
  }

  if (statement.kind === "return") {
    if (statement.value) {
      validateExpression(statement.value, cells, nodes, issues, options);
      checkBooleanValue(
        statement.value,
        cells,
        options.references?.currentNode.signature,
        issues,
        options,
      );
    }
    return;
  }

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    validateObserveTarget(statement, cells, nodes, issues, options);
    if (statement.question !== undefined) {
      validateSemanticString(statement.question, cells, nodes, issues, options);
    }
    return;
  }

  if (
    statement.kind === "observeGroup" ||
    statement.kind === "observeOrAskGroup"
  ) {
    validateObserveGroupTarget(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "set") {
    validateSetTarget(statement, cells, nodes, issues, options);
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedCellAssignment(
      statement,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    return;
  }

  if (statement.kind === "unset") {
    validateUnsetTarget(statement, cells, nodes, issues, options);
    return;
  }
}

function validateEffectStatement(
  statement: EffectStatement,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
  options: ValidationOptions = {},
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, cells, nodes, issues, options);
    checkBooleanValue(
      statement.test,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    statement.consequent.forEach((entry) =>
      validateEffectStatement(entry, cells, nodes, issues, labels, options),
    );
    statement.alternate?.forEach((entry) =>
      validateEffectStatement(entry, cells, nodes, issues, labels, options),
    );
    return;
  }

  if (statement.kind === "label") {
    if (labels.includes(statement.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement.label}`,
        loc: statement.loc,
      });
    }
    statement.body.forEach((entry) =>
      validateEffectStatement(
        entry,
        cells,
        nodes,
        issues,
        [...labels, statement.label],
        options,
      ),
    );
    return;
  }

  if (statement.kind === "break") {
    if (!labels.includes(statement.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement.label}`,
        loc: statement.loc,
      });
    }
    return;
  }

  if (statement.kind === "observe") {
    validateObserveTarget(statement, cells, nodes, issues, options);
    if (statement.question !== undefined) {
      validateSemanticString(statement.question, cells, nodes, issues, options);
    }
    return;
  }

  if (statement.kind === "observeGroup") {
    validateObserveGroupTarget(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "set") {
    validateSetTarget(statement, cells, nodes, issues, options);
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedCellAssignment(
      statement,
      cells,
      options.references?.currentNode.signature,
      issues,
      options,
    );
    return;
  }

  if (statement.kind === "unset") {
    validateUnsetTarget(statement, cells, nodes, issues, options);
    return;
  }

  if (statement.kind === "set-return") {
    const signature = options.references?.currentNode.signature;
    validateExpression(statement.value, cells, nodes, issues, options);
    checkTypedAssignable(
      signature?.returns[statement.key],
      statement.value,
      cells,
      signature,
      "CHANNEL_VALUE_TYPE",
      `returns.${statement.key}.$set() value type is incompatible with the declared channel type`,
      issues,
      statement.loc,
      options,
    );
    return;
  }

  for (const arg of statement.arguments) {
    validateHostCallArgument(arg, cells, nodes, issues, options);
  }
  validateHostCall(statement, cells, issues, options);
}

function validateHostCallArgument(
  arg: HostCallArgument,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions = {},
): void {
  if (arg.kind === "semantic") {
    validateSemanticString(arg.value, cells, nodes, issues, options);
    return;
  }
  if (arg.kind === "value") {
    if (containsBriefableExpression(arg.value)) {
      issues.push({
        code: "HOST_CALL_ARGUMENT",
        message: "Host call arguments cannot contain briefable expressions",
        loc: briefableExpressionLoc(arg.value),
      });
      return;
    }
    validateExpression(arg.value, cells, nodes, issues, options);
    return;
  }
  if (arg.kind === "array") {
    arg.elements.forEach((item) =>
      validateHostCallArgument(item, cells, nodes, issues, options),
    );
    return;
  }
  for (const item of Object.values(arg.value)) {
    validateHostCallArgument(item, cells, nodes, issues, options);
  }
}

function validateHostCall(
  action: HostCall,
  cells: Cell[],
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  if (options.hostModules === undefined) return;

  const path = [action.module, ...action.target, action.operation].join(".");
  const resolution = resolveHostOperation(options.hostModules, action);
  if (resolution.kind === "unresolved") {
    if (resolution.reason === "module") {
      issues.push({
        code: "HOST_MODULE_UNDECLARED",
        message: `Host module ${JSON.stringify(action.module)} has no injected declaration`,
        loc: action.loc,
      });
    } else if (resolution.reason === "member") {
      issues.push({
        code: "HOST_MEMBER_UNDECLARED",
        message: `Host action ${path} refers to undeclared member ${JSON.stringify(resolution.segment)}`,
        loc: action.loc,
      });
    } else {
      issues.push({
        code: "HOST_MEMBER_NOT_OPERATION",
        message: `Host action ${path} does not resolve to an operation`,
        loc: action.loc,
      });
    }
    return;
  }

  const operation = resolution.operation;
  if (action.arguments.length !== operation.parameters.length) {
    issues.push({
      code: "HOST_ARGUMENT_ARITY",
      message: `Host action ${path} requires ${operation.parameters.length} arguments but received ${action.arguments.length}`,
      loc: action.loc,
    });
    return;
  }

  const context = producerContext(
    cells,
    options.references?.currentNode.signature,
    options,
  );
  action.arguments.forEach((argument, index) => {
    const parameter = operation.parameters[index]!;
    if (
      judgeHostArgument(argument, parameter, context).kind === "incompatible"
    ) {
      issues.push({
        code: "HOST_ARGUMENT_TYPE",
        message: `Host action ${path} argument ${index + 1} is incompatible with its declared parameter spec`,
        loc: action.loc,
      });
    }
  });
}

function validateSemanticString(
  value: SemanticString,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions = {},
): void {
  if (value.kind === "literal") return;

  for (const part of value.parts) {
    if (part.kind === "ref" || part.kind === "hostVar") continue;
    if (part.kind === "expression") {
      if (containsBriefableExpression(part.expression)) {
        issues.push({
          code: "BRIEFABLE_TEMPLATE_EXPRESSION",
          message:
            "Template interpolation cannot contain judge() or host call expressions",
          loc: briefableExpressionLoc(part.expression),
        });
        continue;
      }
      if (
        expressionIsArtifact(
          part.expression,
          cells,
          options.references?.currentNode.signature,
          options,
        )
      ) {
        if (options.forbidArtifactSemanticRefs) {
          issues.push({
            code: "ARTIFACT_IN_TRIGGER",
            message:
              "Artifacts cannot be used inside this.trigger; trigger resolution must not depend on a workspace",
          });
        }
        continue;
      }
      validateExpression(part.expression, cells, nodes, issues, options);
      const judgment = interpolationRule.checkProducer(
        part.expression,
        producerContext(
          cells,
          options.references?.currentNode.signature,
          options,
        ),
      );
      if (judgment.kind === "incompatible") {
        issues.push({
          code: "INVALID_TEMPLATE_INTERPOLATION",
          message: "Value template interpolation cannot render this value",
          loc: briefableExpressionLoc(part.expression),
        });
      }
    }
  }
}

function briefableExpressionLoc(
  expression: ValueExpression,
): SourceRange | undefined {
  switch (expression.kind) {
    case "judge":
    case "host-call":
      return expression.loc;
    case "regexTest":
      return briefableExpressionLoc(expression.target);
    case "comparison":
    case "arithmetic":
    case "logical":
      return (
        briefableExpressionLoc(expression.left) ??
        briefableExpressionLoc(expression.right)
      );
    case "conditional":
      return (
        briefableExpressionLoc(expression.test) ??
        briefableExpressionLoc(expression.consequent) ??
        briefableExpressionLoc(expression.alternate)
      );
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return briefableExpressionLoc(expression.argument);
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          const loc = briefableExpressionLoc(part.expression);
          if (loc) return loc;
        }
      }
      return undefined;
    case "artifact":
      return briefableExpressionLoc(expression.path);
    case "arrayElementRead":
      return briefableExpressionLoc(expression.index);
    case "arrayLiteral":
      for (const element of expression.elements) {
        const loc = briefableExpressionLoc(element);
        if (loc) return loc;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Whether an expression is confidently a whole-array value — an array cell
 * reference, an array-typed `args.*`/`returns.*` channel, an array literal, or a
 * conditional both of whose arms are arrays. Used to reject a whole array in
 * ordering, arithmetic, or boolean positions. Conservative: anything not
 * provably an array returns `false`, and its runtime evaluation still poisons on
 * misuse.
 */
function expressionIsArray(
  expression: ValueExpression,
  cells: Cell[],
  signature: NodeSignature | undefined,
  options: ValidationOptions = {},
): boolean {
  switch (expression.kind) {
    case "arrayLiteral":
      return true;
    case "cell": {
      const cell = findCell(cells, expression.name);
      return !!cell && isArrayCell(cell);
    }
    case "channel":
      return (
        signature?.[expression.namespace][expression.key]?.type === "array"
      );
    case "conditional":
      return (
        expressionIsArray(expression.consequent, cells, signature, options) &&
        expressionIsArray(expression.alternate, cells, signature, options)
      );
    case "host-call": {
      const resolution = options.hostModules
        ? resolveHostOperation(options.hostModules, expression)
        : undefined;
      return (
        resolution?.kind === "resolved" &&
        resolution.operation.returns?.type === "array"
      );
    }
    default:
      return false;
  }
}

function expressionIsArtifact(
  expression: ValueExpression,
  cells: Cell[],
  signature: NodeSignature | undefined,
  options: ValidationOptions = {},
): boolean {
  return producerGuaranteesArtifact(
    resolveProducer(expression, producerContext(cells, signature, options)),
  );
}

/**
 * Flags a non-boolean value reaching a boolean position — an `if` test or a
 * `this.trigger` / `this.catchDeflection` / `resolveWhen` / `deflectWhen`
 * return. A ternary yields one of its branches, so each branch is checked in
 * turn. The always-boolean operand positions — a `&&`/`||` operand, a `!`
 * argument, a ternary test — are checked wherever they occur by
 * `validateExpression`, so they need no context here.
 */
function checkBooleanValue(
  expression: ValueExpression,
  cells: Cell[],
  signature: NodeSignature | undefined,
  issues: ValidationIssue[],
  options: ValidationOptions,
): void {
  const judgment = booleanRule.checkProducer(
    expression,
    producerContext(cells, signature, options),
  );
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_BOOLEAN_CONDITION",
      message:
        "Only a boolean value can be used in a boolean position; compare a non-boolean value explicitly",
    });
  }
}

/** Validates an array element / length read receiver and records its read. */
function validateArrayReference(
  array: Extract<ValueExpression, { kind: "arrayElementRead" }>["array"],
  operation: "index" | "length",
  cells: Cell[],
  issues: ValidationIssue[],
  signature: NodeSignature | undefined,
): void {
  if (array.kind === "channel") {
    recordChannelRead(array.namespace, array.key);
    // A channel receiver must be a declared array channel. An undeclared key or
    // a node without a signature is left to the runtime channel read.
    const declared = signature?.[array.namespace][array.key];
    if (declared && declared.type !== "array") {
      issues.push({
        code: operation === "index" ? "INDEX_NON_ARRAY" : "LENGTH_NON_ARRAY",
        message: `Channel ${array.namespace}.${array.key} is not an array; cannot read ${operation}`,
      });
    }
    return;
  }
  recordCellRead(array.name);
  const cell = findCell(cells, array.name);
  if (!cell) {
    issues.push({
      code: "UNKNOWN_CELL",
      message: `Unknown cell: ${array.name}`,
    });
    return;
  }
  if (!isArrayCell(cell)) {
    issues.push({
      code: operation === "index" ? "INDEX_NON_ARRAY" : "LENGTH_NON_ARRAY",
      message: `Cell ${array.name} is not an array; cannot read ${operation}`,
    });
  }
}

function validateExpression(
  expression: ValueExpression,
  cells: Cell[],
  nodes: string[],
  issues: ValidationIssue[],
  options: ValidationOptions = {},
): void {
  const signature = options.references?.currentNode.signature;
  switch (expression.kind) {
    case "arrayElementRead":
      validateArrayReference(
        expression.array,
        "index",
        cells,
        issues,
        signature,
      );
      validateExpression(expression.index, cells, nodes, issues, options);
      if (expressionIsArray(expression.index, cells, signature, options)) {
        issues.push({
          code: "ARRAY_AS_INDEX",
          message: "An array cannot be used as an array index",
        });
      }
      return;
    case "arrayLength":
      validateArrayReference(
        expression.array,
        "length",
        cells,
        issues,
        signature,
      );
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        validateExpression(element, cells, nodes, issues, options);
      }
      return;
    case "span":
      if (mapContextStack.length === 0) {
        issues.push({
          code: "SPAN_OUTSIDE_MAP",
          message: `span.${expression.key} is only available inside a $map callback`,
        });
      }
      return;
    case "cell":
    case "isUnset": {
      const name =
        expression.kind === "cell" ? expression.name : expression.cell;
      recordCellRead(name);
      const cell = findCell(cells, name);
      if (!cell) {
        issues.push({
          code: "UNKNOWN_CELL",
          message: `Unknown cell: ${name}`,
        });
        return;
      }
      if (!isValueExpressionCell(cell)) {
        issues.push({
          code: "NON_VALUE_CELL",
          message: `Cell cannot be used as an expression value: ${name}`,
        });
        return;
      }
      return;
    }
    case "nodeState":
      recordNodeStateRead(expression.identifier);
      if (options.references) {
        if (
          !resolveNodeStateBinding(expression.identifier, options.references)
        ) {
          issues.push({
            code: "UNDEFINED_NODE",
            message: `Unknown node: ${expression.identifier}`,
          });
        }
        return;
      }
      if (!nodes.includes(expression.identifier)) {
        issues.push({
          code: "UNDEFINED_NODE",
          message: `Unknown node: ${expression.identifier}`,
        });
      }
      return;
    case "deflectionEscaped":
      if (
        options.expressionScope !== "catchDeflection" &&
        options.expressionScope !== "effects"
      ) {
        issues.push({
          code: "DEFLECTION_ESCAPED_OUTSIDE_FINALIZATION",
          message:
            "this.deflection.escaped(...) is only available inside this.catchDeflection or this.effects",
        });
      }
      validateDeflectionTarget(
        expression.target,
        issues,
        undefined,
        options.references,
      );
      return;
    case "channel":
      // Channels (`args.*` / `returns.*`) are caller-backed live reads; record
      // them so a caller-cell change during child execution is caught. No
      // structural validation applies to a channel reference itself.
      recordChannelRead(expression.namespace, expression.key);
      return;
    case "channelIsUnset":
      recordChannelRead(expression.namespace, expression.key);
      return;
    case "judge":
      validateSemanticString(
        expression.question,
        cells,
        nodes,
        issues,
        options,
      );
      return;
    case "host-call":
      for (const arg of expression.arguments) {
        validateHostCallArgument(arg, cells, nodes, issues, options);
      }
      validateHostCall(expression, cells, issues, options);
      return;
    case "regexTest":
      validateExpression(expression.target, cells, nodes, issues, options);
      if (
        stringOperandRule.checkProducer(
          expression.target,
          producerContext(cells, signature, options),
        ).kind === "incompatible"
      ) {
        issues.push({
          code: expressionIsArtifact(
            expression.target,
            cells,
            signature,
            options,
          )
            ? "INVALID_ARTIFACT_OPERATION"
            : "REGEX_TARGET_TYPE",
          message: expressionIsArtifact(
            expression.target,
            cells,
            signature,
            options,
          )
            ? "Artifacts cannot be used in regular-expression tests"
            : "Regular-expression tests require a string target",
        });
      }
      return;
    case "dialogTurnsSince":
      validateExpression(expression.receiver, cells, nodes, issues, options);
      validateExpression(expression.baseline, cells, nodes, issues, options);
      return;
    // Dialog reads are bindings, not traversal-visible state: they are pinned
    // per walk rather than bracketed by the read-set, so they record nothing.
    case "dialogCursor":
      return;
    case "scope":
      return;
    case "pendingState":
      if (options.expressionScope !== "effects") {
        issues.push({
          code: "PENDING_STATE_OUTSIDE_EFFECTS",
          message: "this.pendingState is only available inside this.effects",
        });
      }
      return;
    case "enterCount":
      return;
    case "comparison": {
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      const isOrdering =
        expression.op === ">" ||
        expression.op === ">=" ||
        expression.op === "<" ||
        expression.op === "<=";
      const decision = comparisonRule.checkProducers(
        expression.op,
        expression.left,
        expression.right,
        producerContext(cells, signature, options),
      );
      if (decision.judgment.kind === "incompatible") {
        const artifact =
          expressionIsArtifact(expression.left, cells, signature, options) ||
          expressionIsArtifact(expression.right, cells, signature, options);
        const array =
          expressionIsArray(expression.left, cells, signature, options) ||
          expressionIsArray(expression.right, cells, signature, options);
        issues.push({
          code:
            isOrdering && artifact
              ? "INVALID_ARTIFACT_OPERATION"
              : isOrdering && array
                ? "ARRAY_ORDERING"
                : "COMPARISON_VALUE_TYPE",
          message:
            isOrdering && artifact
              ? "Artifacts cannot be ordered"
              : isOrdering && array
                ? "A whole array cannot be used in an ordering comparison"
                : "Comparison operands do not have a coherent shared domain",
        });
      }
      return;
    }
    case "arithmetic":
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      checkNumericOperand(
        expression.left,
        expression.op,
        "left",
        cells,
        signature,
        issues,
        options,
      );
      checkNumericOperand(
        expression.right,
        expression.op,
        "right",
        cells,
        signature,
        issues,
        options,
      );
      return;
    case "logical":
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      // `&&` and `||` are boolean operators: both operands are boolean positions
      // wherever the expression appears.
      checkBooleanValue(expression.left, cells, signature, issues, options);
      checkBooleanValue(expression.right, cells, signature, issues, options);
      return;
    case "conditional":
      validateExpression(expression.test, cells, nodes, issues, options);
      validateExpression(expression.consequent, cells, nodes, issues, options);
      validateExpression(expression.alternate, cells, nodes, issues, options);
      // Only the test is a boolean position; the branches are values of any type.
      checkBooleanValue(expression.test, cells, signature, issues, options);
      return;
    case "unary":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkBooleanValue(expression.argument, cells, signature, issues, options);
      return;
    case "numericUnary":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkNumericOperand(
        expression.argument,
        expression.op,
        "argument",
        cells,
        signature,
        issues,
        options,
      );
      return;
    case "numIsFinite":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkNumIsFiniteArgument(
        expression.argument,
        cells,
        signature,
        issues,
        options,
      );
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          validateExpression(part.expression, cells, nodes, issues, options);
          if (
            interpolationRule.checkProducer(
              part.expression,
              producerContext(cells, signature, options),
            ).kind === "incompatible"
          ) {
            issues.push({
              code: "INVALID_TEMPLATE_INTERPOLATION",
              message: "Value template interpolation cannot render this value",
              loc: briefableExpressionLoc(part.expression),
            });
          }
        }
      }
      return;
    case "artifact":
      validateExpression(expression.path, cells, nodes, issues, options);
      {
        const judgment = artifactPathRule.checkProducer(
          expression.path,
          producerContext(cells, signature, options),
        );
        if (judgment.kind === "incompatible") {
          issues.push({
            code: "ARTIFACT_PATH_TYPE",
            message: "Artifact path expression must produce a string value",
            loc: briefableExpressionLoc(expression.path),
          });
        }
      }
      return;
    default:
      return;
  }
}

export type * from "../types/parser.js";
export type { PayloadValue } from "../types/value.js";
