import { validateHostModuleSpec, validateSpec } from "../spec/validation.js";
import type {
  ChannelSpec,
  HostModuleSpec,
  HostNamespaceSpec,
  HostOperationSpec,
  HostParameterSpec,
} from "../types/spec.js";

declare const tokenType: unique symbol;

type DeclarationToken<Spec extends HostParameterSpec = HostParameterSpec> = {
  readonly [tokenType]: Spec;
};

type OperationDeclaration = (
  ...parameters: never[]
) => DeclarationToken<ChannelSpec> | void;

type NamespaceDeclaration = {
  readonly [name: string]: NamespaceDeclaration | OperationDeclaration;
};

type CaptureFrame = {
  path: string;
  tokens: DeclarationToken[];
};

type TokenRecord = {
  frame: CaptureFrame;
  spec: HostParameterSpec;
};

type DeclarationError = Error & {
  code: "HOST_MODULE_DECLARATION";
  path: string;
};

const tokenRecords = new WeakMap<object, TokenRecord>();
const declarationErrors = new WeakSet<Error>();
const asyncFunctionPrototype = Object.getPrototypeOf(async function () {});

let activeCapture: CaptureFrame | undefined;

/** Defines one normalized host-module declaration from HMD notation. */
function define<const Declaration extends NamespaceDeclaration>(
  declaration: Declaration,
): HostModuleSpec {
  if (activeCapture) {
    declarationError(
      activeCapture.path,
      "hmd.define() cannot run inside an operation declaration",
    );
  }
  const spec = normalizeNamespace(declaration, "$", new WeakSet());
  const issue = validateHostModuleSpec(spec)[0];
  if (issue) {
    declarationError(issue.path, issue.detail);
  }
  return spec;
}

function normalizeNamespace(
  value: unknown,
  path: string,
  visiting: WeakSet<object>,
): HostNamespaceSpec {
  const object = inspectNamespace(value, path);
  if (visiting.has(object)) {
    declarationError(path, "cyclic namespace declarations are unsupported");
  }
  visiting.add(object);
  try {
    const members: [string, HostNamespaceSpec | HostOperationSpec][] = [];
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") {
        declarationError(path, "symbol member names are unsupported");
      }
      const memberPath = propertyPath(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        declarationError(
          memberPath,
          "members must be enumerable data properties",
        );
      }
      if (key.length === 0 || key.startsWith("$")) {
        declarationError(
          memberPath,
          "member names must be nonempty and cannot begin with $",
        );
      }
      const member = descriptor.value;
      if (typeof member === "function") {
        members.push([key, captureOperation(member, memberPath)]);
      } else {
        members.push([key, normalizeNamespace(member, memberPath, visiting)]);
      }
    }
    return {
      kind: "namespace",
      members: Object.fromEntries(members),
    };
  } catch (error) {
    if (isDeclarationError(error)) throw error;
    declarationError(path, "declaration object could not be inspected", error);
  } finally {
    visiting.delete(object);
  }
}

function inspectNamespace(value: unknown, path: string): object {
  if (!value || typeof value !== "object") {
    declarationError(path, "expected a plain declaration object");
  }
  let array: boolean;
  let prototype: object | null;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    declarationError(path, "declaration object could not be inspected", error);
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) {
    declarationError(path, "expected a plain declaration object");
  }
  return value;
}

function captureOperation(
  operation: (...parameters: never[]) => unknown,
  path: string,
): HostOperationSpec {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(operation);
  } catch (error) {
    declarationError(path, "operation function could not be inspected", error);
  }
  if (prototype === asyncFunctionPrototype) {
    declarationError(path, "operation declarations must be synchronous");
  }
  if (activeCapture) {
    declarationError(path, "operation declaration capture cannot be reentered");
  }

  const frame: CaptureFrame = { path, tokens: [] };
  activeCapture = frame;
  let result: unknown;
  try {
    result = operation();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      declarationError(path, "operation declarations must be synchronous");
    }
  } catch (error) {
    if (isDeclarationError(error)) throw error;
    declarationError(path, "operation declaration threw during capture", error);
  } finally {
    activeCapture = undefined;
  }

  let parameterTokens = frame.tokens;
  let returns: ChannelSpec | undefined;
  if (result !== undefined) {
    const resultToken = asToken(result, path, "operation result");
    const record = tokenRecords.get(resultToken as object);
    if (
      !record ||
      record.frame !== frame ||
      frame.tokens[frame.tokens.length - 1] !== resultToken
    ) {
      declarationError(
        path,
        "operation result must be its final captured declaration marker",
      );
    }
    if (!isChannelSpec(record.spec)) {
      declarationError(path, "operation result must be an Arc channel spec");
    }
    parameterTokens = frame.tokens.slice(0, -1);
    returns = cloneParameterSpec(record.spec) as ChannelSpec;
  }

  return {
    kind: "operation",
    parameters: parameterTokens.map((token) => {
      const record = tokenRecords.get(token as object);
      if (!record || record.frame !== frame) {
        declarationError(path, "operation parameter marker is invalid");
      }
      return cloneParameterSpec(record.spec);
    }),
    ...(returns ? { returns } : {}),
  };
}

function createToken<Spec extends HostParameterSpec>(
  spec: Spec,
  children: readonly DeclarationToken[] = [],
): DeclarationToken<Spec> {
  const frame = activeCapture;
  if (!frame) {
    declarationError("$", "hmd markers can only be used inside hmd.define()");
  }
  if (children.length > frame.tokens.length) {
    declarationError(frame.path, "composite declaration markers are invalid");
  }
  const offset = frame.tokens.length - children.length;
  for (const [index, child] of children.entries()) {
    const record = tokenRecords.get(child as object);
    if (
      !record ||
      record.frame !== frame ||
      frame.tokens[offset + index] !== child
    ) {
      declarationError(
        frame.path,
        "composite markers must consume their current captured children",
      );
    }
  }
  frame.tokens.splice(offset, children.length);

  const token = Object.freeze({}) as DeclarationToken<Spec>;
  tokenRecords.set(token as object, {
    frame,
    spec: cloneParameterSpec(spec),
  });
  frame.tokens.push(token);
  return token;
}

function scalarToken<Spec extends HostParameterSpec>(
  spec: Spec,
): DeclarationToken<Spec> {
  return createToken(spec);
}

function enumToken(values: readonly string[]): DeclarationToken<{
  type: "enum";
  values: string[];
}> {
  const copied = inspectStringArray(values, activeCapture?.path ?? "$", "Enum");
  const spec = { type: "enum", values: copied } as const;
  const violation = validateSpec(spec);
  if (violation) {
    declarationError(activeCapture?.path ?? "$", violation.detail);
  }
  return createToken(spec);
}

function arrayToken<Spec extends HostParameterSpec>(
  element: DeclarationToken<Spec>,
): DeclarationToken<{ type: "array"; element: Spec }> {
  const record = tokenRecord(element, activeCapture?.path ?? "$", "Array");
  return createToken(
    {
      type: "array",
      element: cloneParameterSpec(record.spec) as Spec,
    },
    [element],
  );
}

function tupleToken<const Tokens extends readonly DeclarationToken[]>(
  elements: Tokens,
): DeclarationToken<{
  type: "tuple";
  elements: HostParameterSpec[];
}> {
  const copied = inspectTokenArray(
    elements,
    activeCapture?.path ?? "$",
    "Tuple",
  );
  return createToken(
    {
      type: "tuple",
      elements: copied.map((element) =>
        cloneParameterSpec(
          tokenRecord(element, activeCapture?.path ?? "$", "Tuple").spec,
        ),
      ),
    },
    copied,
  );
}

function tokenRecord(value: unknown, path: string, owner: string): TokenRecord {
  const token = asToken(value, path, `${owner} child`);
  const record = tokenRecords.get(token as object);
  if (!record) {
    declarationError(path, `${owner} requires declaration marker children`);
  }
  return record;
}

function asToken(
  value: unknown,
  path: string,
  owner: string,
): DeclarationToken {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    declarationError(path, `${owner} must be a declaration marker`);
  }
  if (!tokenRecords.has(value as object)) {
    declarationError(path, `${owner} must be a declaration marker`);
  }
  return value as DeclarationToken;
}

function inspectStringArray(
  value: readonly string[],
  path: string,
  owner: string,
): string[] {
  const elements = inspectOrdinaryArray(value, path, owner);
  return elements.map((element) => {
    if (typeof element !== "string") {
      declarationError(path, `${owner} values must be strings`);
    }
    return element;
  });
}

function inspectTokenArray(
  value: readonly DeclarationToken[],
  path: string,
  owner: string,
): DeclarationToken[] {
  return inspectOrdinaryArray(value, path, owner).map((element) =>
    asToken(element, path, `${owner} element`),
  );
}

function inspectOrdinaryArray(
  value: readonly unknown[],
  path: string,
  owner: string,
): unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      declarationError(path, `${owner} requires an ordinary array`);
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        declarationError(path, `${owner} arrays must be dense enumerable data`);
      }
      result.push(descriptor.value);
    }
    const extra = Reflect.ownKeys(value).find((key) => {
      if (key === "length") return false;
      if (typeof key !== "string") return true;
      const index = Number(key);
      return (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index) !== key ||
        index >= value.length
      );
    });
    if (extra !== undefined) {
      declarationError(path, `${owner} arrays cannot have extra properties`);
    }
    return result;
  } catch (error) {
    if (isDeclarationError(error)) throw error;
    declarationError(path, `${owner} array could not be inspected`, error);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
}

function isChannelSpec(spec: HostParameterSpec): spec is ChannelSpec {
  switch (spec.type) {
    case "boolean":
    case "string":
    case "enum":
    case "number":
    case "index":
    case "artifact":
    case "dialogCursor":
      return true;
    case "array":
      return (
        spec.element.type === "boolean" ||
        spec.element.type === "string" ||
        spec.element.type === "enum" ||
        spec.element.type === "number" ||
        spec.element.type === "artifact"
      );
    case "tuple":
    case "semanticText":
      return false;
  }
}

function cloneParameterSpec(spec: HostParameterSpec): HostParameterSpec {
  switch (spec.type) {
    case "enum":
      return { type: "enum", values: [...spec.values] };
    case "array":
      return { type: "array", element: cloneParameterSpec(spec.element) };
    case "tuple":
      return {
        type: "tuple",
        elements: spec.elements.map(cloneParameterSpec),
      };
    default:
      return { type: spec.type };
  }
}

function propertyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function isDeclarationError(error: unknown): error is DeclarationError {
  return error instanceof Error && declarationErrors.has(error);
}

function declarationError(
  path: string,
  detail: string,
  cause?: unknown,
): never {
  const error = Object.assign(
    new Error(`Invalid host module declaration at ${path}: ${detail}`),
    {
      code: "HOST_MODULE_DECLARATION" as const,
      path,
      ...(cause === undefined ? {} : { cause }),
    },
  );
  declarationErrors.add(error);
  throw error;
}

export const hmd = Object.freeze({
  define,
  Bool: () => scalarToken({ type: "boolean" }),
  Str: () => scalarToken({ type: "string" }),
  Enum: enumToken,
  Num: () => scalarToken({ type: "number" }),
  Index: () => scalarToken({ type: "index" }),
  Artifact: () => scalarToken({ type: "artifact" }),
  Dialog: Object.freeze({
    Cursor: () => scalarToken({ type: "dialogCursor" }),
  }),
  Array: arrayToken,
  Tuple: tupleToken,
  SemanticText: () => scalarToken({ type: "semanticText" }),
});
