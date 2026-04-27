import type * as acorn from "acorn";
import { parse as acornParse } from "acorn";

import type {
  BreakStatement,
  CatchDeflectionStatement,
  Document,
  EffectStatement,
  GuardStatement,
  HostCallArgument,
  HostEffectStatement,
  HostModuleBinding,
  IfStatement,
  InstructionAction,
  LabelStatement,
  Node,
  ObserveAction,
  ObserveOrAskAction,
  ResolutionStatement,
  SemanticPart,
  SemanticString,
  SetAction,
  SetReturnAction,
  SourceRange,
  Statement,
  TriggerStatement,
  ValidationIssue,
  ValueExpression,
  Variable,
} from "../types.js";
import {
  getBlockStatements,
  getFunctionBody,
  getMemberTarget,
  getThisProperty,
  isAssignmentExpression,
  isBreakStatement,
  isCallExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isLabeledStatement,
  isLiteral,
  isNewExpression,
  isReturnStatement,
  isTemplateLiteral,
  isVariableDeclaration,
  locOf,
  parseExpression,
  parseHostCallTarget,
  parseTemplateLiteral,
} from "./ast.js";
import { parseTarget } from "./targets.js";

const HOST_MODULE_SOURCE_PREFIX = "host:";

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

  const version = extractVersion(program.body);
  if (version !== "v2") {
    throw new Error('Expected "use arc v2" directive');
  }

  const imports: Document["imports"] = [];
  const hostModules: HostModuleBinding[] = [];

  for (const statement of program.body) {
    if (!isImportDeclaration(statement)) continue;
    const source = String(statement.source.value);
    const isHostModuleImport = source.startsWith(HOST_MODULE_SOURCE_PREFIX);
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        if (isHostModuleImport) {
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
    if (isFunctionDeclaration(statement) && statement.id?.name) {
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
        "Export syntax is not supported; use a plain top-level function declaration",
      );
    }
  }

  if (rootFunctions.length === 0) {
    throw new Error("No top-level function declarations found");
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

  const document: Document = {
    version: "v2",
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

/**
 * Validates a parsed `Document` without reparsing source text.
 *
 * This is useful when a caller already has a document and wants structured
 * diagnostics instead of an exception from `parse(...)`.
 */
export function validate(document: Document): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const root of document.roots) {
    validateNode(root, {
      issues,
      variables: [],
      nodes: [
        ...root.children.map((child) => child.identifier),
        ...document.imports.map((entry) => entry.localName),
      ],
    });
  }
  return issues;
}

function extractVersion(
  body: Array<acorn.Statement | acorn.ModuleDeclaration>,
): string | undefined {
  const first = body[0];
  if (!first || !isExpressionStatement(first)) return undefined;
  const expression = first.expression;
  if (!isLiteral(expression) || typeof expression.value !== "string") {
    return undefined;
  }
  const match = expression.value.match(/^use arc (\S+)$/);
  return match?.[1];
}

function parseHostModuleName(source: string): string {
  const module = source.slice(HOST_MODULE_SOURCE_PREFIX.length);
  if (!module) {
    throw new Error("Host module import source must include a module name");
  }
  return module;
}

function parseNode(
  fn: acorn.FunctionDeclaration | acorn.AnonymousFunctionDeclaration,
  availableImports: Set<string>,
  availableHostModules: Map<string, string>,
  visibleNodeNames: Set<string>,
  visibleVariableNames: Set<string>,
  inheritedDeflectWhen?: ResolutionStatement[],
): Node {
  if (!fn.id?.name) {
    throw new Error("Nodes must use named function declarations");
  }

  const variables: Variable[] = [];
  const childFunctions = new Map<string, acorn.FunctionDeclaration>();
  let resumable = true;
  let displayName: string | undefined;
  let description: string | undefined;
  let guidance: SemanticString | undefined;
  let trigger: TriggerStatement[] | undefined;
  let deflectWhen: ResolutionStatement[] | undefined;
  let catchDeflection: CatchDeflectionStatement[] | undefined;
  let catchDeflectionBody: acorn.Statement[] | undefined;
  let guard: GuardStatement[] | undefined;
  let effects: EffectStatement[] | undefined;
  const handledStatements = new Set<acorn.Statement>();
  const nextActionId = createActionIdAllocator();

  for (const statement of fn.body.body) {
    if (isVariableDeclaration(statement)) {
      const parsedVariables = parseVariableDeclarations(statement);
      if (parsedVariables.length > 0) {
        variables.push(...parsedVariables);
        handledStatements.add(statement);
      }
      continue;
    }

    if (isFunctionDeclaration(statement) && statement.id) {
      childFunctions.set(statement.id.name, statement);
      handledStatements.add(statement);
      continue;
    }

    if (!isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!isAssignmentExpression(expression) || expression.operator !== "=") {
      continue;
    }

    const thisProperty = getThisProperty(expression.left as acorn.Expression);
    if (thisProperty === "observing") {
      throw new Error(
        "this.observing is not supported in Arc; use variable.observing for extraction guidance or this.guidance for node guidance",
      );
    }
    if (thisProperty === "displayName") {
      if (
        !isLiteral(expression.right) ||
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
        !isLiteral(expression.right) ||
        typeof expression.right.value !== "string"
      ) {
        throw new Error("this.description must be a string literal");
      }
      description = expression.right.value;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "guidance") {
      if (!isTemplateLiteral(expression.right)) {
        throw new Error("this.guidance must be a template literal");
      }
      guidance = parseTemplateLiteral(expression.right);
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "resumable") {
      if (
        !isLiteral(expression.right) ||
        typeof expression.right.value !== "boolean"
      ) {
        throw new Error("this.resumable must be a boolean literal");
      }
      resumable = expression.right.value;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "trigger") {
      trigger = parseTriggerArrowFunction(
        expression.right,
        "this.trigger",
        nextActionId,
        availableHostModules,
      );
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "deflectWhen") {
      deflectWhen = parseResolutionDefinition(
        expression.right,
        "this.deflectWhen",
        nextActionId,
        availableHostModules,
      );
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "catchDeflection") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.catchDeflection must be an arrow function");
      }
      const body = getFunctionBody(expression.right);
      if (!body) throw new Error("this.catchDeflection must be a function");
      catchDeflectionBody = body;
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "guard") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.guard must be an arrow function");
      }
      const body = getFunctionBody(expression.right);
      if (!body) throw new Error("this.guard must be a function");
      guard = parseGuardStatements(body, nextActionId, availableHostModules);
      handledStatements.add(statement);
      continue;
    }
    if (thisProperty === "effects") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.effects must be an arrow function");
      }
      const body = getFunctionBody(expression.right);
      if (!body) throw new Error("this.effects must be a function");
      effects = parseEffectStatements(body, nextActionId, availableHostModules);
      handledStatements.add(statement);
      continue;
    }

    const member = getMemberTarget(expression.left as acorn.Expression);
    if (member?.property === "observing") {
      const variable = variables.find((entry) => entry.name === member.object);
      if (!variable) {
        throw new Error(
          `Unknown variable for observing assignment: ${member.object}`,
        );
      }
      if (!isTemplateLiteral(expression.right)) {
        throw new Error(
          `${member.object}.observing must be a template literal`,
        );
      }
      variable.observing = parseTemplateLiteral(expression.right);
      handledStatements.add(statement);
    }
  }

  const effectiveDeflectWhen = deflectWhen ?? inheritedDeflectWhen;
  const nextVisibleNodeNames = new Set([
    ...visibleNodeNames,
    ...childFunctions.keys(),
  ]);
  const nextVisibleVariableNames = new Set([
    ...visibleVariableNames,
    ...variables.map((entry) => entry.name),
  ]);
  if (catchDeflectionBody) {
    catchDeflection = parseCatchDeflectionStatements(
      catchDeflectionBody,
      nextActionId,
      availableHostModules,
      availableImports,
      nextVisibleNodeNames,
    );
  }
  const children = [...childFunctions.values()].map((child) =>
    parseNode(
      child,
      availableImports,
      availableHostModules,
      nextVisibleNodeNames,
      nextVisibleVariableNames,
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
      nextVisibleVariableNames,
      availableHostModules,
      nextActionId,
      effectiveDeflectWhen,
    ),
  );
  const freshAliases = collectFreshNodeAliases(statements);

  return {
    identifier: fn.id.name,
    displayName,
    description,
    guidance,
    resumable,
    variables,
    statements,
    children,
    freshAliases,
    imports: [...availableImports],
    trigger,
    deflectWhen,
    catchDeflection,
    guard,
    effects,
    loc: locOf(fn),
  };
}

function collectFreshNodeAliases(
  statements: Statement[],
): Node["freshAliases"] {
  const aliases: Node["freshAliases"] = [];

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
    if (
      (statement.kind === "enter-node" || statement.kind === "enter-loop") &&
      statement.target.fresh
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

function parseVariableDeclarations(
  statement: acorn.VariableDeclaration,
): Variable[] {
  const variables: Variable[] = [];

  for (const declaration of statement.declarations) {
    const id = declaration.id;
    if (
      !declaration.init ||
      !isNewExpression(declaration.init) ||
      !isIdentifier(id)
    ) {
      continue;
    }

    const callee = declaration.init.callee;
    if (!isIdentifier(callee)) continue;

    if (callee.name === "Enum") {
      const arg = declaration.init.arguments[0];
      const config = parseVariableConfig(
        id.name,
        callee.name,
        declaration.init.arguments[1],
      );
      if (
        !arg ||
        arg.type === "SpreadElement" ||
        arg.type !== "ArrayExpression"
      ) {
        throw new Error(`Enum variable ${id.name} requires an array literal`);
      }
      const values = arg.elements.map((element) => {
        if (
          !element ||
          element.type !== "Literal" ||
          typeof element.value !== "string"
        ) {
          throw new Error(`Enum variable ${id.name} requires string values`);
        }
        return element.value;
      });
      variables.push({
        name: id.name,
        type: "enum",
        values,
        ...config,
        loc: locOf(id),
      });
      continue;
    }

    if (callee.name === "Boolean") {
      const config = parseVariableConfig(
        id.name,
        callee.name,
        declaration.init.arguments[0],
      );
      variables.push({
        name: id.name,
        type: "boolean",
        ...config,
        loc: locOf(id),
      });
      continue;
    }

    if (callee.name === "RangedInt") {
      const minArg = declaration.init.arguments[0];
      const maxArg = declaration.init.arguments[1];
      const config = parseVariableConfig(
        id.name,
        callee.name,
        declaration.init.arguments[2],
      );
      if (
        !minArg ||
        !maxArg ||
        minArg.type === "SpreadElement" ||
        maxArg.type === "SpreadElement" ||
        !isLiteral(minArg) ||
        !isLiteral(maxArg) ||
        typeof minArg.value !== "number" ||
        typeof maxArg.value !== "number"
      ) {
        throw new Error(
          `RangedInt variable ${id.name} requires numeric min/max literals`,
        );
      }
      variables.push({
        name: id.name,
        type: "rangedInt",
        min: minArg.value,
        max: maxArg.value,
        ...config,
        loc: locOf(id),
      });
    }
  }

  return variables;
}

function parseVariableConfig(
  variableName: string,
  constructorName: string,
  arg: acorn.Expression | acorn.SpreadElement | undefined,
): Pick<Variable, "observing"> {
  if (!arg) return {};
  if (arg.type === "SpreadElement" || arg.type !== "ObjectExpression") {
    throw new Error(
      `${constructorName} variable ${variableName} config must be an object literal`,
    );
  }

  const config: Pick<Variable, "observing"> = {};
  for (const property of arg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(
        `${constructorName} variable ${variableName} config does not support spread`,
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
        `${constructorName} variable ${variableName} has unsupported config key: ${key ?? "<computed>"}`,
      );
    }
    if (!isTemplateLiteral(property.value)) {
      throw new Error(
        `${constructorName} variable ${variableName} observing config must be a template literal`,
      );
    }
    config.observing = parseTemplateLiteral(property.value);
  }
  return config;
}

function parseNodeStatement(
  statement: acorn.Statement,
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  handledStatements: ReadonlySet<acorn.Statement>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleVariableNames: Set<string>,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
  defaultDeflectWhen?: ResolutionStatement[],
): Statement[] {
  if (handledStatements.has(statement)) {
    return [];
  }

  if (isLabeledStatement(statement)) {
    if (!isIdentifier(statement.label)) {
      throw new Error("Arc labels must use identifier names");
    }
    if (statement.body.type !== "BlockStatement") {
      throw new Error("Arc labels must target a block statement");
    }
    const parsed: LabelStatement = {
      kind: "label",
      label: statement.label.name,
      body: parseStatementList(
        statement.body.body,
        childFunctions,
        handledStatements,
        availableImports,
        visibleNodeNames,
        visibleVariableNames,
        availableHostModules,
        nextActionId,
        defaultDeflectWhen,
      ),
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (isBreakStatement(statement)) {
    if (!statement.label || !isIdentifier(statement.label)) {
      throw new Error("Arc break statements must specify a label");
    }
    const parsed: BreakStatement = {
      kind: "break",
      label: statement.label.name,
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (isIfStatement(statement)) {
    const parsed: IfStatement = {
      kind: "if",
      test: parseExpression(statement.test, availableHostModules, nextActionId),
      consequent: parseStatementList(
        getBlockStatements(statement.consequent),
        childFunctions,
        handledStatements,
        availableImports,
        visibleNodeNames,
        visibleVariableNames,
        availableHostModules,
        nextActionId,
      ),
      alternate: statement.alternate
        ? parseStatementList(
            getBlockStatements(statement.alternate),
            childFunctions,
            handledStatements,
            availableImports,
            visibleNodeNames,
            visibleVariableNames,
            availableHostModules,
            nextActionId,
          )
        : undefined,
      loc: locOf(statement),
    };
    return [parsed];
  }

  if (!isExpressionStatement(statement)) {
    throw new Error(`Unsupported Arc statement: ${statement.type}`);
  }
  const expression = statement.expression;
  if (isAssignmentExpression(expression)) {
    throw new Error(
      "Unsupported Arc assignment; only this.* config and variable.observing assignments are allowed",
    );
  }

  const action = parseActionExpression(
    expression,
    childFunctions,
    availableImports,
    visibleNodeNames,
    visibleVariableNames,
    availableHostModules,
    nextActionId,
    defaultDeflectWhen,
  );
  if (!action) {
    throw new Error(
      "Unsupported Arc expression statement; use an instruction template literal, instruct(), instructLoop(), observe(), observeOrAsk(), enter(), enterLoop(), or variable.set()",
    );
  }
  return [action];
}

function parseStatementList(
  statements: acorn.Statement[],
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  handledStatements: ReadonlySet<acorn.Statement>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleVariableNames: Set<string>,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
  defaultDeflectWhen?: ResolutionStatement[],
): Statement[] {
  return statements.flatMap((statement) =>
    parseNodeStatement(
      statement,
      childFunctions,
      handledStatements,
      availableImports,
      visibleNodeNames,
      visibleVariableNames,
      availableHostModules,
      nextActionId,
      defaultDeflectWhen,
    ),
  );
}

function parseActionExpression(
  expression: acorn.Expression,
  childFunctions: Map<string, acorn.FunctionDeclaration>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleVariableNames: Set<string>,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
  defaultDeflectWhen?: ResolutionStatement[],
): Statement | undefined {
  if (isTemplateLiteral(expression)) {
    const template = parseTemplateLiteral(expression);
    rejectUnsupportedInstructionIml(template);
    return createInstructionAction(
      template,
      "once",
      nextActionId,
      locOf(expression),
      undefined,
      defaultDeflectWhen,
    );
  }

  if (isCallExpression(expression)) {
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observe"
    ) {
      return parseObserveCall(expression, "observe", nextActionId);
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observeOrAsk"
    ) {
      return parseObserveCall(expression, "observeOrAsk", nextActionId);
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }
    if (
      expression.callee.type === "Identifier" &&
      (expression.callee.name === "instructLoop" ||
        expression.callee.name === "instruct")
    ) {
      return parseInstructionCall(
        expression,
        availableHostModules,
        nextActionId,
        defaultDeflectWhen,
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "enter"
    ) {
      return parseEnterCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleVariableNames,
        nextActionId,
      );
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "enterLoop"
    ) {
      return parseEnterLoopCall(
        expression,
        availableImports,
        visibleNodeNames,
        visibleVariableNames,
        availableHostModules,
        nextActionId,
      );
    }

    const set = parseSetCall(
      expression,
      availableHostModules,
      nextActionId,
      "action",
    );
    if (set) return set;
  }

  return undefined;
}

function parseTriggerArrowFunction(
  expression: acorn.Expression,
  label: string,
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): TriggerStatement[] {
  if (expression.type !== "ArrowFunctionExpression") {
    throw new Error(`${label} must be an arrow function`);
  }
  const body = getFunctionBody(expression);
  if (!body) throw new Error(`${label} must be a function`);
  return parseTriggerStatements(body, nextActionId, availableHostModules);
}

function parseResolutionDefinition(
  expression: acorn.Expression,
  label: string,
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): ResolutionStatement[] {
  if (expression.type === "ArrowFunctionExpression") {
    return parseTriggerArrowFunction(
      expression,
      label,
      nextActionId,
      availableHostModules,
    );
  }

  const question = parseGuidance(expression);
  return [
    {
      kind: "return",
      value: {
        id: nextActionId(),
        kind: "judge",
        question,
        loc: question.loc,
      },
      loc: question.loc,
    },
  ];
}

function createInstructionAction(
  template: SemanticString,
  mode: InstructionAction["mode"],
  nextActionId: () => number,
  loc: SourceRange | undefined,
  resolveWhen?: ResolutionStatement[],
  deflectWhen?: ResolutionStatement[],
): InstructionAction {
  return {
    id: nextActionId(),
    kind: "instruction",
    mode,
    template,
    resolveWhen,
    deflectWhen,
    loc,
  };
}

function parseInstructionCall(
  expression: acorn.CallExpression,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
  defaultDeflectWhen?: ResolutionStatement[],
): InstructionAction {
  const callee =
    expression.callee.type === "Identifier"
      ? expression.callee.name
      : undefined;
  if (callee !== "instructLoop" && callee !== "instruct") {
    throw new Error("Unsupported instruction call");
  }

  const textArg = expression.arguments[0];
  if (!textArg || textArg.type === "SpreadElement") {
    throw new Error(`${callee}() requires an instruction template literal`);
  }
  const template = parseGuidance(textArg);
  rejectUnsupportedInstructionIml(template);

  if (expression.arguments.length > 2) {
    throw new Error(
      `${callee}() accepts at most an instruction and one options object`,
    );
  }

  let resolveWhen: ResolutionStatement[] | undefined;
  let deflectWhen: ResolutionStatement[] | undefined;
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
      if (key !== "resolveWhen" && key !== "deflectWhen") {
        throw new Error(
          `${callee}() has unsupported option key: ${key ?? "<computed>"}`,
        );
      }
      const parsed = parseResolutionDefinition(
        property.value,
        `${callee}().${key}`,
        nextActionId,
        availableHostModules,
      );
      if (key === "resolveWhen") resolveWhen = parsed;
      if (key === "deflectWhen") deflectWhen = parsed;
    }
  }

  const mode: InstructionAction["mode"] =
    callee === "instruct" ? "once" : "persistent";
  if (mode === "persistent" && !resolveWhen) {
    throw new Error("instructLoop() requires resolveWhen");
  }
  if (mode === "once" && resolveWhen) {
    throw new Error("instruct() does not support resolveWhen");
  }

  return createInstructionAction(
    template,
    mode,
    nextActionId,
    locOf(expression),
    resolveWhen,
    deflectWhen ?? defaultDeflectWhen,
  );
}

function parseEnterCall(
  expression: acorn.CallExpression,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
  visibleVariableNames: Set<string>,
  nextActionId: () => number,
): Statement {
  const target = parseTarget(expression.arguments[0], "enter", {
    availableImports,
    visibleNodeNames,
  });
  if (expression.arguments.length > 2) {
    throw new Error("enter() accepts a target and an optional options object");
  }

  const optionsArg = expression.arguments[1];
  let args: Record<string, string> | undefined;
  let returns: Record<string, string> | undefined;

  if (optionsArg) {
    if (
      optionsArg.type === "SpreadElement" ||
      optionsArg.type !== "ObjectExpression"
    ) {
      throw new Error("enter() options must be an object literal");
    }
    const seenKeys = new Set<string>();
    for (const property of optionsArg.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("enter() options do not support spread");
      }
      if (property.computed) {
        throw new Error("enter() options do not support computed keys");
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
          `enter() has unsupported option key: ${key ?? "<computed>"}`,
        );
      }
      if (seenKeys.has(key)) {
        throw new Error(`enter() options has duplicate key: ${key}`);
      }
      seenKeys.add(key);
      const parsed = parseEnterChannelMap(
        property.value,
        `enter().${key}`,
        visibleVariableNames,
      );
      if (key === "args") args = parsed;
      if (key === "returns") returns = parsed;
    }
  }

  return {
    id: nextActionId(),
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
  visibleVariableNames: Set<string>,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
): Statement {
  const target = parseTarget(expression.arguments[0], "enterLoop", {
    availableImports,
    visibleNodeNames,
  });
  if (expression.arguments.length !== 2) {
    throw new Error("enterLoop() accepts a target and one options object");
  }

  const optionsArg = expression.arguments[1];
  if (
    !optionsArg ||
    optionsArg.type === "SpreadElement" ||
    optionsArg.type !== "ObjectExpression"
  ) {
    throw new Error("enterLoop() options must be an object literal");
  }

  let resolveWhen: ResolutionStatement[] | undefined;
  let args: Record<string, string> | undefined;
  let returns: Record<string, string> | undefined;
  const seenKeys = new Set<string>();
  for (const property of optionsArg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error("enterLoop() options do not support spread");
    }
    if (property.computed) {
      throw new Error("enterLoop() options do not support computed keys");
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
        `enterLoop() has unsupported option key: ${key ?? "<computed>"}`,
      );
    }
    if (seenKeys.has(key)) {
      throw new Error(`enterLoop() options has duplicate key: ${key}`);
    }
    seenKeys.add(key);
    if (key === "resolveWhen") {
      resolveWhen = parseResolutionDefinition(
        property.value,
        "enterLoop().resolveWhen",
        nextActionId,
        availableHostModules,
      );
      continue;
    }
    const parsed = parseEnterChannelMap(
      property.value,
      `enterLoop().${key}`,
      visibleVariableNames,
    );
    if (key === "args") args = parsed;
    if (key === "returns") returns = parsed;
  }

  if (!resolveWhen) {
    throw new Error("enterLoop() requires resolveWhen");
  }

  return {
    id: nextActionId(),
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
    | "enter().args"
    | "enter().returns"
    | "enterLoop().args"
    | "enterLoop().returns",
  visibleVariableNames: Set<string>,
): Record<string, string> {
  if (expression.type !== "ObjectExpression") {
    throw new Error(`${label} must be an object literal`);
  }
  const mapping: Record<string, string> = {};
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
    if (!isIdentifier(property.value)) {
      throw new Error(
        `${label}.${key} must reference a caller variable identifier`,
      );
    }
    if (!visibleVariableNames.has(property.value.name)) {
      throw new Error(
        `${label}.${key} references unknown caller variable: ${property.value.name}`,
      );
    }
    mapping[key] = property.value.name;
  }
  return mapping;
}

function parseObserveCall(
  expression: acorn.CallExpression,
  method: "observe" | "observeOrAsk",
  nextActionId: () => number,
): ObserveAction | ObserveOrAskAction {
  const variableArg = expression.arguments[0];
  if (
    !variableArg ||
    variableArg.type === "SpreadElement" ||
    !isIdentifier(variableArg)
  ) {
    throw new Error(
      `${method}() requires a variable identifier as the first argument`,
    );
  }

  const questionArg = expression.arguments[1];
  const question =
    questionArg && questionArg.type !== "SpreadElement"
      ? parseGuidance(questionArg)
      : undefined;

  return {
    id: nextActionId(),
    kind: method,
    variable: variableArg.name,
    question,
    loc: locOf(expression),
  };
}

function parseSetCall(
  expression: acorn.CallExpression,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
  context: "action" | "effects",
): SetAction | SetReturnAction | undefined {
  if (expression.callee.type !== "MemberExpression") return undefined;
  if (expression.callee.computed) return undefined;
  if (!isIdentifier(expression.callee.property)) return undefined;
  if (expression.callee.property.name !== "set") return undefined;

  const valueArg = expression.arguments[0];
  if (!valueArg || valueArg.type === "SpreadElement") {
    throw new Error("set() requires a value");
  }
  if (expression.arguments.length !== 1) {
    throw new Error("set() takes exactly one value");
  }

  const calleeObject = expression.callee.object;
  const value = parseExpression(valueArg, availableHostModules, nextActionId);

  if (isIdentifier(calleeObject)) {
    return {
      id: nextActionId(),
      kind: "set",
      variable: calleeObject.name,
      value,
      loc: locOf(expression),
    };
  }

  if (
    calleeObject.type === "MemberExpression" &&
    !calleeObject.computed &&
    isIdentifier(calleeObject.object) &&
    isIdentifier(calleeObject.property) &&
    calleeObject.object.name === "returns"
  ) {
    if (context !== "effects") {
      throw new Error("returns.*.set(...) is only allowed inside this.effects");
    }
    return {
      id: nextActionId(),
      kind: "set-return",
      key: calleeObject.property.name,
      value,
      loc: locOf(expression),
    };
  }

  return undefined;
}

function parseGuidance(node: acorn.Expression): SemanticString {
  if (isTemplateLiteral(node)) return parseTemplateLiteral(node);
  throw new Error("Semantic text must be a template literal");
}

function parseTriggerStatements(
  statements: acorn.Statement[],
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): TriggerStatement[] {
  return statements.flatMap<TriggerStatement>((statement) => {
    if (isLabeledStatement(statement)) {
      if (!isIdentifier(statement.label)) {
        throw new Error("this.trigger labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.trigger labels must target a block statement");
      }
      return [
        {
          kind: "label",
          label: statement.label.name,
          body: parseTriggerStatements(
            statement.body.body,
            nextActionId,
            availableHostModules,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (isBreakStatement(statement)) {
      if (!statement.label || !isIdentifier(statement.label)) {
        throw new Error("this.trigger break statements must specify a label");
      }
      return [
        {
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (isIfStatement(statement)) {
      return [
        {
          kind: "if",
          test: parseExpression(
            statement.test,
            availableHostModules,
            nextActionId,
          ),
          consequent: parseTriggerStatements(
            getBlockStatements(statement.consequent),
            nextActionId,
            availableHostModules,
          ),
          alternate: statement.alternate
            ? parseTriggerStatements(
                getBlockStatements(statement.alternate),
                nextActionId,
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (isReturnStatement(statement)) {
      return [
        {
          kind: "return",
          value: statement.argument
            ? parseExpression(
                statement.argument,
                availableHostModules,
                nextActionId,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (!isExpressionStatement(statement)) {
      throw new Error(`Unsupported this.trigger statement: ${statement.type}`);
    }
    const expression = statement.expression;
    if (!isCallExpression(expression)) {
      throw new Error(
        `Unsupported this.trigger expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observe"
    ) {
      return [
        parseObserveCall(expression, "observe", nextActionId) as ObserveAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const set = parseSetCall(
      expression,
      availableHostModules,
      nextActionId,
      "action",
    );
    if (set?.kind === "set") return [set];

    throw new Error(
      "Unsupported this.trigger call; use observe(), variable.set(), if, and return",
    );
  });
}

function parseGuardStatements(
  statements: acorn.Statement[],
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): GuardStatement[] {
  return statements.flatMap<GuardStatement>((statement) => {
    if (isLabeledStatement(statement)) {
      if (!isIdentifier(statement.label)) {
        throw new Error("this.guard labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.guard labels must target a block statement");
      }
      return [
        {
          kind: "label",
          label: statement.label.name,
          body: parseGuardStatements(
            statement.body.body,
            nextActionId,
            availableHostModules,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (isBreakStatement(statement)) {
      if (!statement.label || !isIdentifier(statement.label)) {
        throw new Error("this.guard break statements must specify a label");
      }
      return [
        {
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (isIfStatement(statement)) {
      return [
        {
          kind: "if",
          test: parseExpression(
            statement.test,
            availableHostModules,
            nextActionId,
          ),
          consequent: parseGuardStatements(
            getBlockStatements(statement.consequent),
            nextActionId,
            availableHostModules,
          ),
          alternate: statement.alternate
            ? parseGuardStatements(
                getBlockStatements(statement.alternate),
                nextActionId,
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (isReturnStatement(statement)) {
      return [
        {
          kind: "return",
          value: statement.argument
            ? parseGuardReturnValue(
                statement.argument as acorn.Expression,
                availableHostModules,
                nextActionId,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (!isExpressionStatement(statement)) {
      throw new Error(`Unsupported this.guard statement: ${statement.type}`);
    }
    const expression = statement.expression;
    if (!isCallExpression(expression)) {
      throw new Error(
        `Unsupported this.guard expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observe"
    ) {
      return [
        parseObserveCall(expression, "observe", nextActionId) as ObserveAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const set = parseSetCall(
      expression,
      availableHostModules,
      nextActionId,
      "action",
    );
    if (set?.kind === "set") return [set];

    throw new Error(
      "Unsupported this.guard call; use observe(), variable.set(), if, and return",
    );
  });
}

function parseCatchDeflectionStatements(
  statements: acorn.Statement[],
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
  availableImports: Set<string>,
  visibleNodeNames: Set<string>,
): CatchDeflectionStatement[] {
  const parseHookExpression = (expression: acorn.Expression): ValueExpression =>
    parseExpression(expression, availableHostModules, nextActionId, {
      availableImports,
      visibleNodeNames,
    });

  return statements.flatMap<CatchDeflectionStatement>((statement) => {
    if (isLabeledStatement(statement)) {
      if (!isIdentifier(statement.label)) {
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
          kind: "label",
          label: statement.label.name,
          body: parseCatchDeflectionStatements(
            statement.body.body,
            nextActionId,
            availableHostModules,
            availableImports,
            visibleNodeNames,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (isBreakStatement(statement)) {
      if (!statement.label || !isIdentifier(statement.label)) {
        throw new Error(
          "this.catchDeflection break statements must specify a label",
        );
      }
      return [
        {
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (isIfStatement(statement)) {
      return [
        {
          kind: "if",
          test: parseHookExpression(statement.test),
          consequent: parseCatchDeflectionStatements(
            getBlockStatements(statement.consequent),
            nextActionId,
            availableHostModules,
            availableImports,
            visibleNodeNames,
          ),
          alternate: statement.alternate
            ? parseCatchDeflectionStatements(
                getBlockStatements(statement.alternate),
                nextActionId,
                availableHostModules,
                availableImports,
                visibleNodeNames,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (isReturnStatement(statement)) {
      return [
        {
          kind: "return",
          value: statement.argument
            ? parseHookExpression(statement.argument as acorn.Expression)
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (!isExpressionStatement(statement)) {
      throw new Error(
        `Unsupported this.catchDeflection statement: ${statement.type}`,
      );
    }
    const expression = statement.expression;
    if (!isCallExpression(expression)) {
      throw new Error(
        `Unsupported this.catchDeflection expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observe"
    ) {
      return [
        parseObserveCall(expression, "observe", nextActionId) as ObserveAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "judge"
    ) {
      throw new Error("judge() must be used inside an expression");
    }

    const set = parseSetCall(
      expression,
      availableHostModules,
      nextActionId,
      "action",
    );
    if (set?.kind === "set") return [set];

    throw new Error(
      "Unsupported this.catchDeflection call; use observe(), variable.set(), if, and return",
    );
  });
}

function parseGuardReturnValue(
  expression: acorn.Expression,
  availableHostModules: Map<string, string>,
  nextActionId: () => number,
): ValueExpression {
  const parsed = parseExpression(
    expression,
    availableHostModules,
    nextActionId,
  );
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
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): EffectStatement[] {
  return statements.flatMap<EffectStatement>((statement) => {
    if (isLabeledStatement(statement)) {
      if (!isIdentifier(statement.label)) {
        throw new Error("this.effects labels must use identifier names");
      }
      if (statement.body.type !== "BlockStatement") {
        throw new Error("this.effects labels must target a block statement");
      }
      return [
        {
          kind: "label",
          label: statement.label.name,
          body: parseEffectStatements(
            statement.body.body,
            nextActionId,
            availableHostModules,
          ),
          loc: locOf(statement),
        },
      ];
    }

    if (isBreakStatement(statement)) {
      if (!statement.label || !isIdentifier(statement.label)) {
        throw new Error("this.effects break statements must specify a label");
      }
      return [
        {
          kind: "break",
          label: statement.label.name,
          loc: locOf(statement),
        },
      ];
    }

    if (isIfStatement(statement)) {
      return [
        {
          kind: "if",
          test: parseExpression(
            statement.test,
            availableHostModules,
            nextActionId,
          ),
          consequent: parseEffectStatements(
            getBlockStatements(statement.consequent),
            nextActionId,
            availableHostModules,
          ),
          alternate: statement.alternate
            ? parseEffectStatements(
                getBlockStatements(statement.alternate),
                nextActionId,
                availableHostModules,
              )
            : undefined,
          loc: locOf(statement),
        },
      ];
    }

    if (!isExpressionStatement(statement)) {
      throw new Error(`Unsupported this.effects statement: ${statement.type}`);
    }
    const expression = statement.expression;
    if (!isCallExpression(expression)) {
      throw new Error(
        `Unsupported this.effects expression statement: ${expression.type}`,
      );
    }

    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observe"
    ) {
      return [
        parseObserveCall(expression, "observe", nextActionId) as ObserveAction,
      ];
    }
    if (
      expression.callee.type === "Identifier" &&
      expression.callee.name === "observeOrAsk"
    ) {
      throw new Error("observeOrAsk() is forbidden inside this.effects");
    }

    const set = parseSetCall(
      expression,
      availableHostModules,
      nextActionId,
      "effects",
    );
    if (set) return [set];

    const hostEffect = parseHostEffect(
      expression,
      nextActionId,
      availableHostModules,
    );
    if (hostEffect) return [hostEffect];

    throw new Error(
      "Unsupported this.effects call; use observe(), variable.set(), returns.<key>.set(...), or a declared host effect",
    );
  });
}

function parseHostEffect(
  expression: acorn.CallExpression,
  nextActionId: () => number,
  availableHostModules: Map<string, string>,
): HostEffectStatement | undefined {
  if (expression.callee.type === "Super") return undefined;
  const target = parseHostCallTarget(expression.callee, availableHostModules);
  if (!target) {
    return undefined;
  }

  const args = expression.arguments.map((arg) => {
    if (arg.type === "SpreadElement") {
      throw new Error("Host calls do not support spread arguments");
    }
    return parseHostEffectArgument(arg);
  });

  return {
    id: nextActionId(),
    kind: "host-call",
    module: target.module,
    target: target.path,
    operation: target.operation,
    arguments: args,
    loc: locOf(expression),
  };
}

function parseHostEffectArgument(
  expression: acorn.Expression,
): HostCallArgument {
  if (isTemplateLiteral(expression)) {
    return { kind: "semantic", value: parseTemplateLiteral(expression) };
  }
  if (expression.type === "ArrayExpression") {
    return {
      kind: "array",
      value: expression.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Host call arrays do not support holes or spread");
        }
        return parseHostEffectArgument(element);
      }),
    };
  }
  if (expression.type === "ObjectExpression") {
    const value: Record<string, HostCallArgument> = {};
    for (const property of expression.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("Host call objects do not support spread");
      }
      if (property.computed) {
        throw new Error("Host call objects do not support computed keys");
      }
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal" &&
              typeof property.key.value === "string"
            ? property.key.value
            : undefined;
      if (!key) {
        throw new Error("Host call objects require string keys");
      }
      value[key] = parseHostEffectArgument(property.value);
    }
    return { kind: "object", value };
  }
  const value = parseExpression(expression);
  if (containsBriefableExpression(value)) {
    throw new Error("Host call arguments cannot contain briefable expressions");
  }
  return { kind: "value", value };
}

function createActionIdAllocator(): () => number {
  let nextId = 0;
  return () => nextId++;
}

function rejectUnsupportedInstructionIml(template: SemanticString): void {
  const text = template.parts
    .filter(
      (part): part is SemanticPart & { kind: "text" } => part.kind === "text",
    )
    .map((part) => part.value)
    .join("");
  if (text.includes(":::when") || text.includes(":::else")) {
    throw new Error(
      "Arc does not support :::when/:::else conditional IML in instruction literals",
    );
  }
}

function validateNode(
  node: Node,
  context: {
    issues: ValidationIssue[];
    variables: string[];
    nodes: string[];
  },
): void {
  const variableNames = [
    ...context.variables,
    ...node.variables.map((variable) => variable.name),
  ];
  const nodeNames = [
    ...context.nodes,
    ...node.children.map((child) => child.identifier),
    ...node.imports,
  ];
  for (const variable of node.variables) {
    if (variable.observing) {
      validateSemanticString(
        variable.observing,
        variableNames,
        nodeNames,
        context.issues,
      );
    }
  }

  for (const statement of node.statements) {
    validateStatement(statement, variableNames, nodeNames, context.issues);
  }
  for (const statement of node.trigger ?? []) {
    validateTriggerStatement(
      statement,
      variableNames,
      nodeNames,
      context.issues,
    );
  }
  for (const statement of node.deflectWhen ?? []) {
    validateTriggerStatement(
      statement,
      variableNames,
      nodeNames,
      context.issues,
    );
  }
  for (const statement of node.guard ?? []) {
    validateGuardStatement(statement, variableNames, nodeNames, context.issues);
  }
  for (const statement of node.effects ?? []) {
    validateEffectStatement(
      statement,
      variableNames,
      nodeNames,
      context.issues,
    );
  }

  for (const child of node.children) {
    validateNode(child, {
      issues: context.issues,
      variables: variableNames,
      nodes: [
        ...node.children.map((entry) => entry.identifier),
        ...node.imports,
      ],
    });
  }
}

function validateStatement(
  statement: Statement,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, variables, nodes, issues);
    statement.consequent.forEach((entry) =>
      validateStatement(entry, variables, nodes, issues, labels),
    );
    statement.alternate?.forEach((entry) =>
      validateStatement(entry, variables, nodes, issues, labels),
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
      validateStatement(entry, variables, nodes, issues, [
        ...labels,
        statement.label,
      ]),
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

  if (statement.kind === "observe" || statement.kind === "observeOrAsk") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    if (statement.question) {
      validateSemanticString(statement.question, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "set") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }

  if (statement.kind === "set-return") {
    issues.push({
      code: "SET_RETURN_OUTSIDE_EFFECTS",
      message: "returns.*.set(...) is only allowed inside this.effects",
      loc: statement.loc,
    });
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }

  if (statement.kind === "enter-node" || statement.kind === "enter-loop") {
    if (!nodes.includes(statement.target.identifier)) {
      issues.push({
        code: "UNDEFINED_NODE",
        message: `Unknown node: ${statement.target.identifier}`,
        loc: statement.loc,
      });
    }
    const callLabel = statement.kind === "enter-loop" ? "enterLoop" : "enter";
    for (const [key, variable] of Object.entries(statement.args ?? {})) {
      if (!variables.includes(variable)) {
        issues.push({
          code: "UNKNOWN_VARIABLE",
          message: `Unknown variable: ${variable}`,
          loc: statement.loc,
        });
      }
      if (variable !== key) {
        issues.push({
          code: "ENTER_CHANNEL_RENAME",
          message: `${callLabel}().args.${key} must use same-name binding (renaming is not supported)`,
          loc: statement.loc,
        });
      }
    }
    for (const [key, variable] of Object.entries(statement.returns ?? {})) {
      if (!variables.includes(variable)) {
        issues.push({
          code: "UNKNOWN_VARIABLE",
          message: `Unknown variable: ${variable}`,
          loc: statement.loc,
        });
      }
      if (variable !== key) {
        issues.push({
          code: "ENTER_CHANNEL_RENAME",
          message: `${callLabel}().returns.${key} must use same-name binding (renaming is not supported)`,
          loc: statement.loc,
        });
      }
    }
    if (statement.kind === "enter-loop") {
      for (const entry of statement.resolveWhen) {
        validateTriggerStatement(entry, variables, nodes, issues);
      }
    }
    return;
  }

  validateSemanticString(statement.template, variables, nodes, issues);
  for (const entry of statement.resolveWhen ?? []) {
    validateTriggerStatement(entry, variables, nodes, issues);
  }
  for (const entry of statement.deflectWhen ?? []) {
    validateTriggerStatement(entry, variables, nodes, issues);
  }
}

function validateTriggerStatement(
  statement: TriggerStatement,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, variables, nodes, issues);
    statement.consequent.forEach((entry) =>
      validateTriggerStatement(entry, variables, nodes, issues, labels),
    );
    statement.alternate?.forEach((entry) =>
      validateTriggerStatement(entry, variables, nodes, issues, labels),
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
      validateTriggerStatement(entry, variables, nodes, issues, [
        ...labels,
        statement.label,
      ]),
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
      validateExpression(statement.value, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "observe") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    if (statement.question) {
      validateSemanticString(statement.question, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "set") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }
}

function validateGuardStatement(
  statement: GuardStatement,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, variables, nodes, issues);
    statement.consequent.forEach((entry) =>
      validateGuardStatement(entry, variables, nodes, issues, labels),
    );
    statement.alternate?.forEach((entry) =>
      validateGuardStatement(entry, variables, nodes, issues, labels),
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
      validateGuardStatement(entry, variables, nodes, issues, [
        ...labels,
        statement.label,
      ]),
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
      validateExpression(statement.value, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "observe") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    if (statement.question) {
      validateSemanticString(statement.question, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "set") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }
}

function validateEffectStatement(
  statement: EffectStatement,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
  labels: string[] = [],
): void {
  if (statement.kind === "if") {
    validateExpression(statement.test, variables, nodes, issues);
    statement.consequent.forEach((entry) =>
      validateEffectStatement(entry, variables, nodes, issues, labels),
    );
    statement.alternate?.forEach((entry) =>
      validateEffectStatement(entry, variables, nodes, issues, labels),
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
      validateEffectStatement(entry, variables, nodes, issues, [
        ...labels,
        statement.label,
      ]),
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
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    if (statement.question) {
      validateSemanticString(statement.question, variables, nodes, issues);
    }
    return;
  }

  if (statement.kind === "set") {
    if (!variables.includes(statement.variable)) {
      issues.push({
        code: "UNKNOWN_VARIABLE",
        message: `Unknown variable: ${statement.variable}`,
        loc: statement.loc,
      });
    }
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }

  if (statement.kind === "set-return") {
    validateExpression(statement.value, variables, nodes, issues);
    return;
  }

  for (const arg of statement.arguments) {
    validateHostEffectArgument(arg, variables, nodes, issues);
  }
}

function validateHostEffectArgument(
  arg: HostCallArgument,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
): void {
  if (arg.kind === "semantic") {
    validateSemanticString(arg.value, variables, nodes, issues);
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
    validateExpression(arg.value, variables, nodes, issues);
    return;
  }
  if (arg.kind === "array") {
    arg.value.forEach((item) =>
      validateHostEffectArgument(item, variables, nodes, issues),
    );
    return;
  }
  for (const item of Object.values(arg.value)) {
    validateHostEffectArgument(item, variables, nodes, issues);
  }
}

function validateSemanticString(
  value: SemanticString,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
): void {
  for (const part of value.parts) {
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
      validateExpression(part.expression, variables, nodes, issues);
    }
  }
}

function containsBriefableExpression(expression: ValueExpression): boolean {
  switch (expression.kind) {
    case "judge":
    case "host-call":
      return true;
    case "regexTest":
      return containsBriefableExpression(expression.target);
    case "binary":
    case "logical":
      return (
        containsBriefableExpression(expression.left) ||
        containsBriefableExpression(expression.right)
      );
    case "unary":
      return containsBriefableExpression(expression.argument);
    default:
      return false;
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
    case "binary":
    case "logical":
      return (
        briefableExpressionLoc(expression.left) ??
        briefableExpressionLoc(expression.right)
      );
    case "unary":
      return briefableExpressionLoc(expression.argument);
    default:
      return undefined;
  }
}

function validateExpression(
  expression: ValueExpression,
  variables: string[],
  nodes: string[],
  issues: ValidationIssue[],
): void {
  switch (expression.kind) {
    case "variable":
      if (!variables.includes(expression.name)) {
        issues.push({
          code: "UNKNOWN_VARIABLE",
          message: `Unknown variable: ${expression.name}`,
        });
      }
      return;
    case "nodeState":
      if (!nodes.includes(expression.identifier)) {
        issues.push({
          code: "UNDEFINED_NODE",
          message: `Unknown node: ${expression.identifier}`,
        });
      }
      return;
    case "judge":
      validateSemanticString(expression.question, variables, nodes, issues);
      return;
    case "host-call":
      for (const arg of expression.arguments) {
        validateHostEffectArgument(arg, variables, nodes, issues);
      }
      return;
    case "regexTest":
      validateExpression(expression.target, variables, nodes, issues);
      return;
    case "binary":
    case "logical":
      validateExpression(expression.left, variables, nodes, issues);
      validateExpression(expression.right, variables, nodes, issues);
      return;
    case "unary":
      validateExpression(expression.argument, variables, nodes, issues);
      return;
    default:
      return;
  }
}

export type { Document, ValidationIssue } from "../types.js";
