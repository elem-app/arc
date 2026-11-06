import { describe, expect, it } from "vitest";
import { hmd } from "../src/host-utils/index.js";
import { validateDocumentStructure } from "../src/parser/document-grammar.js";
import { analyzeDocument, parse, validate } from "../src/parser/index.js";
import {
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import { validateSpec } from "../src/spec/validation.js";
import type {
  Cell,
  ChannelSpec,
  Document,
  FmtConfig,
  FmtExpression,
  HostCallArgument,
  Statement,
  TriggerStatement,
  ValidationIssue,
  ValueExpression,
} from "../src/types/index.js";
import { UNSTAMPED_ID } from "../src/types/ir.js";
import {
  EMPTY_DIALOG,
  rootTraversal,
  startRun,
  startTerminal,
} from "./helpers.js";

type Path = (string | number)[];
const rootPath: Path = ["roots", 0];
const actionPath: Path = [...rootPath, "statements", 0];
const text = { kind: "literal", value: "question" } as const;
const bool = { kind: "literal", value: true } as const;
const num = { kind: "literal", value: 1 } as const;
const target = {
  identifier: "Child",
  imported: false,
  mode: "canonical",
} as const;
const call = {
  id: UNSTAMPED_ID,
  kind: "host-call",
  module: "test",
  target: [],
  operation: "run",
  arguments: [],
} as const;
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } };
const hostModules = new Map([["test", hmd.define({ run: () => hmd.Bool() })]]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function emptyDocument(): Document {
  return {
    imports: [],
    hostModules: [],
    roots: [
      {
        identifier: "Main",
        forgetfulEntry: false,
        writeDiffMode: "advance",
        cells: [],
        children: [],
        statements: [],
        newcopyAliases: [],
        imports: [],
      },
    ],
  };
}
function fixture(): Document {
  return parse(`"arc";
    function Main(args = { input: Bool() }) {
      let cell = Bool();
      $enter(Child, { args: { input: cell }, returns: { output: cell } });
      function Child(args = { input: Bool() }, returns = { output: Bool() }) {}
    }`);
}
function at(document: unknown, path: Path): unknown {
  return path.reduce(
    (value, key) => (value as Record<string | number, unknown>)[key],
    document,
  );
}
function put(document: Document, path: Path, value: unknown): Document {
  (at(document, path.slice(0, -1)) as Record<string | number, unknown>)[
    path.at(-1)!
  ] = value;
  return document;
}
function printed(path: Path): string {
  return "$" + path.map((key) => `[${JSON.stringify(key)}]`).join("");
}
function structure(document: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateDocumentStructure(document, issues);
  return issues;
}
function rejects(document: Document, code?: string, path?: Path) {
  const issues = validate(document);
  expect(issues.length).toBeGreaterThan(0);
  expect(
    issues.some(
      (issue) =>
        (code === undefined || issue.code === code) &&
        (path === undefined || issue.message.includes(printed(path))),
    ),
  ).toBe(true);
  const runtime = new Runtime({ hostModules });
  try {
    runtime.add("invalid", document);
    expect.fail("malformed Document was registered");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeRegistrationError);
    expect(
      (error as RuntimeRegistrationError).issues.map(({ code, message }) => ({
        code,
        message,
      })),
    ).toEqual(
      issues
        .filter((issue) => issue.code !== "ELEMENT_ID")
        .map(({ code, message }) => ({ code, message })),
    );
  }
  expect(runtime.has(toArcRef("invalid", "Main"))).toBe(false);
}
function rejectsRawAndJson(document: Document, code?: string, path?: Path) {
  rejects(document, code, path);
  rejects(JSON.parse(JSON.stringify(document)) as Document, code, path);
}

// These fixtures are independent examples of each public variant, rather than
// being generated from the validator's schema tables.
const expressions = {
  literal: bool,
  cell: { kind: "cell", name: "cell" },
  isUnset: { kind: "isUnset", cell: "cell" },
  channel: { kind: "channel", namespace: "args", key: "input" },
  channelIsUnset: {
    kind: "channelIsUnset",
    namespace: "returns",
    key: "output",
  },
  arrayElementRead: {
    kind: "arrayElementRead",
    array: { kind: "cell", name: "items" },
    index: num,
  },
  arrayLength: {
    kind: "arrayLength",
    array: { kind: "channel", namespace: "args", key: "items" },
  },
  span: { kind: "span", owner: "map", key: "item" },
  field: {
    kind: "field",
    receiver: { kind: "cell", name: "request" },
    path: ["name"],
  },
  structLiteral: { kind: "structLiteral", fields: { name: text } },
  deflectionEscaped: { kind: "deflectionEscaped", target },
  dialogCursor: { kind: "dialogCursor" },
  dialogTurnsSince: {
    kind: "dialogTurnsSince",
    metric: "total",
    receiver: { kind: "dialogCursor" },
    baseline: { kind: "cell", name: "cursor" },
  },
  scope: { kind: "scope", name: "lastTurns", count: 2 },
  enterCount: { kind: "enterCount" },
  interruptionId: { kind: "interruptionId" },
  interruptionReason: { kind: "interruptionReason" },
  pendingState: { kind: "pendingState" },
  nodeState: { kind: "nodeState", identifier: "Child" },
  arithmetic: { kind: "arithmetic", op: "+", left: num, right: num },
  numericUnary: { kind: "numericUnary", op: "-", argument: num },
  judge: { id: UNSTAMPED_ID, kind: "judge", question: text },
  "host-call": { ...call, target: [], arguments: [] },
  artifact: { kind: "artifact", path: { kind: "literal", value: "file.md" } },
  fmt: { kind: "fmt", value: text, config: {} },
  "template-string": {
    kind: "template-string",
    parts: [
      { kind: "text", value: "value: " },
      { kind: "expression", expression: num },
    ],
  },
  arrayLiteral: { kind: "arrayLiteral", elements: [num] },
  regexTest: { kind: "regexTest", pattern: "a+", flags: "i", target: text },
  comparison: { kind: "comparison", op: "==", left: num, right: num },
  numIsFinite: { kind: "numIsFinite", argument: num },
  logical: { kind: "logical", op: "&&", left: bool, right: bool },
  conditional: {
    kind: "conditional",
    test: bool,
    consequent: num,
    alternate: num,
  },
  unary: { kind: "unary", op: "!", argument: bool },
} satisfies {
  [K in ValueExpression["kind"]]: Extract<ValueExpression, { kind: K }>;
};
const statements = {
  observe: {
    id: UNSTAMPED_ID,
    kind: "observe",
    target: ["cell"],
    question: text,
  },
  observeOrAsk: {
    id: UNSTAMPED_ID,
    kind: "observeOrAsk",
    target: ["cell"],
    question: text,
  },
  observeGroup: { id: UNSTAMPED_ID, kind: "observeGroup", targets: [["cell"]] },
  observeOrAskGroup: {
    id: UNSTAMPED_ID,
    kind: "observeOrAskGroup",
    targets: [["cell"]],
  },
  set: { id: UNSTAMPED_ID, kind: "set", target: ["cell"], value: bool },
  unset: { id: UNSTAMPED_ID, kind: "unset", target: ["cell"] },
  "set-return": {
    id: UNSTAMPED_ID,
    kind: "set-return",
    key: "output",
    value: bool,
  },
  "set-span": { id: UNSTAMPED_ID, kind: "set-span", owner: "map", value: bool },
  break: { id: UNSTAMPED_ID, kind: "break", label: "done" },
  if: {
    id: UNSTAMPED_ID,
    kind: "if",
    test: bool,
    consequent: [],
    alternate: [],
  },
  label: { id: UNSTAMPED_ID, kind: "label", label: "done", body: [] },
  "enter-node": {
    id: UNSTAMPED_ID,
    kind: "enter-node",
    target,
    args: {},
    returns: {},
  },
  "enter-loop": {
    id: UNSTAMPED_ID,
    kind: "enter-loop",
    target,
    resolveWhen: [],
    args: {},
    returns: {},
  },
  instruction: {
    id: UNSTAMPED_ID,
    kind: "instruction",
    mode: "once",
    template: text,
    hostParams: { extra: true },
  },
  invoke: { id: UNSTAMPED_ID, kind: "invoke", body: [] },
  map: {
    id: UNSTAMPED_ID,
    kind: "map",
    receiver: { kind: "cell", name: "items" },
    results: "results",
    body: [],
  },
  "host-call": { ...call, target: [], arguments: [] },
  return: { id: UNSTAMPED_ID, kind: "return", value: bool },
} satisfies {
  [K in (Statement | TriggerStatement)["kind"]]: Extract<
    Statement | TriggerStatement,
    { kind: K }
  >;
};
const hostArguments = {
  value: { kind: "value", value: bool },
  semantic: { kind: "semantic", value: text },
  array: { kind: "array", elements: [{ kind: "value", value: bool }] },
  object: { kind: "object", value: { flag: { kind: "value", value: bool } } },
} satisfies {
  [K in HostCallArgument["kind"]]: Extract<HostCallArgument, { kind: K }>;
};

type Example = {
  label: string;
  document: Document;
  path: Path;
  optional: string[];
};
function example(
  label: string,
  value: unknown,
  path: Path,
  optional: string[] = [],
  document = emptyDocument(),
): Example {
  return { label, document: put(document, path, value), path, optional };
}
function expressionDocument(): Document {
  const document = emptyDocument();
  document.roots[0]!.statements = [
    { id: UNSTAMPED_ID, kind: "if", test: bool, consequent: [] },
  ];
  return document;
}
const examples: Example[] = [
  { label: "Document", document: emptyDocument(), path: [], optional: [] },
  example("node", emptyDocument().roots[0], rootPath),
  example("signature", { args: {}, returns: {} }, [...rootPath, "signature"]),
  example(
    "Arc import",
    { importedName: "Other", localName: "Other", source: "other", loc },
    ["imports", 0],
    ["loc"],
  ),
  example(
    "host import",
    {
      importedName: "default",
      localName: "Test",
      module: "test",
      source: "host:test",
      loc,
    },
    ["hostModules", 0],
    ["loc"],
  ),
  example(
    "newcopy alias",
    { identifier: "copy", target: "Child", imported: false },
    [...rootPath, "newcopyAliases", 0],
  ),
  example("source range", loc, [...rootPath, "loc"]),
  example(
    "source position",
    loc.start,
    [...rootPath, "loc", "start"],
    [],
    put(emptyDocument(), [...rootPath, "loc"], clone(loc)),
  ),
  ...Object.entries(expressions).map(([kind, value]) =>
    example(
      `expression ${kind}`,
      value,
      [...actionPath, "test"],
      ["id", "loc", ...(kind === "scope" ? ["count"] : [])],
      expressionDocument(),
    ),
  ),
  ...Object.entries(statements).map(([kind, value]) =>
    example(
      `statement ${kind}`,
      value,
      kind === "return" ? [...rootPath, "trigger", 0] : actionPath,
      [
        "id",
        "loc",
        "question",
        "alternate",
        "args",
        "returns",
        "hostParams",
        "results",
        ...(kind === "return" ? ["value"] : []),
      ],
      kind === "return"
        ? put(emptyDocument(), [...rootPath, "trigger"], [])
        : emptyDocument(),
    ),
  ),
  ...Object.entries(hostArguments).map(([kind, value]) =>
    example(
      `host argument ${kind}`,
      value,
      [...actionPath, "arguments", 0],
      [],
      put(emptyDocument(), actionPath, { ...call, arguments: [] }),
    ),
  ),
  example(
    "enter target",
    target,
    [...actionPath, "target"],
    [],
    put(emptyDocument(), actionPath, { ...statements["enter-node"] }),
  ),
  ...[
    ["args", { kind: "cell", cell: "cell" }],
    ["args", { kind: "argsProjection", key: "input" }],
    ["args", { kind: "span", owner: "map", key: "item" }],
    ["returns", { kind: "span", owner: "map", key: "result" }],
  ].map(([direction, binding]) =>
    example(
      `binding ${String(direction)} ${(binding as { kind: string }).kind}`,
      binding,
      [...actionPath, String(direction), "input"],
      [],
      put(emptyDocument(), actionPath, {
        ...statements["enter-node"],
        args: {},
        returns: {},
      }),
    ),
  ),
  ...[
    { kind: "cell", name: "items" },
    { kind: "channel", namespace: "args", key: "items" },
  ].map((value) =>
    example(
      `array reference ${value.kind}`,
      value,
      [...actionPath, "receiver"],
      [],
      put(emptyDocument(), actionPath, { ...statements.map }),
    ),
  ),
  ...[
    { kind: "text", value: "text" },
    { kind: "expression", expression: num },
    { kind: "ref", name: "user" },
    { kind: "hostVar", module: "test", path: ["value"] },
  ].map((value) =>
    example(
      `semantic part ${value.kind}`,
      value,
      [...rootPath, "guidance", "parts", 0],
      [],
      put(emptyDocument(), [...rootPath, "guidance"], {
        kind: "template-string",
        parts: [],
      }),
    ),
  ),
  example("semantic literal", text, [...rootPath, "guidance"]),
  example("semantic template", { kind: "template-string", parts: [] }, [
    ...rootPath,
    "guidance",
  ]),
  ...["number", "integer"].map((kind) =>
    example(
      `observeAs ${kind}`,
      { kind, min: 0, max: 10 },
      [...rootPath, "cells", 0, "observeAs"],
      ["min", "max"],
      put(emptyDocument(), [...rootPath, "cells", 0], {
        name: "cell",
        type: "number",
      }),
    ),
  ),
];
const specs = {
  boolean: { type: "boolean" },
  string: { type: "string" },
  enum: { type: "enum", values: ["a", "b"] },
  number: { type: "number" },
  union: { type: "union", members: [{ type: "number" }, { type: "string" }] },
  artifact: { type: "artifact" },
  dialogCursor: { type: "dialogCursor" },
  index: { type: "index" },
  array: { type: "array", element: { type: "string" } },
  struct: { type: "struct", fields: { name: { type: "string" } } },
} satisfies { [K in ChannelSpec["type"]]: Extract<ChannelSpec, { type: K }> };
for (const [type, spec] of Object.entries(specs)) {
  const document = emptyDocument();
  document.roots[0]!.signature = { args: {}, returns: {} };
  examples.push(
    example(
      `channel spec ${type}`,
      spec,
      [...rootPath, "signature", "args", "input"],
      [],
      document,
    ),
  );
  if (type !== "index")
    examples.push(
      example(
        `cell ${type}`,
        { ...spec, name: "cell", loc },
        [...rootPath, "cells", 0],
        ["loc"],
      ),
    );
  if (!["array", "index", "dialogCursor"].includes(type)) {
    examples.push(
      example(
        `cell element ${type}`,
        spec,
        [...rootPath, "cells", 0, "element"],
        [],
        put(emptyDocument(), [...rootPath, "cells", 0], {
          name: "items",
          type: "array",
          element: spec,
        }),
      ),
    );
    examples.push(
      example(
        `channel element ${type}`,
        spec,
        [...rootPath, "signature", "args", "input", "element"],
        [],
        put(emptyDocument(), [...rootPath, "signature"], {
          args: { input: { type: "array", element: spec } },
          returns: {},
        }),
      ),
    );
  }
}

describe("public Document grammar", () => {
  it("fmt.public-ir enforces local strata and config data-property grammar", () => {
    const source = "fmt-public-document";
    const base = parse(
      '"arc"; function Main() { let text = Str(); text.$set(fmt("a")); }',
    );
    for (const config of [
      { str: undefined },
      { array: undefined },
      { array: { style: undefined } },
      { struct: { style: undefined } },
      [],
    ]) {
      const document = JSON.parse(JSON.stringify(base)) as Document;
      const statement = document.roots[0]!.statements[0]!;
      if (statement.kind !== "set" || statement.value.kind !== "fmt")
        throw new Error("expected formatting");
      statement.value.config = config as FmtConfig;
      expect(validate(document)).toContainEqual(
        expect.objectContaining({ code: "INVALID_FMT_CONFIG" }),
      );
      expect(() => new Runtime().add(source, document)).toThrow();
    }
    let called = false;
    const getter = Object.defineProperty({}, "str", {
      enumerable: true,
      get() {
        called = true;
        return "bare";
      },
    });
    const statement = base.roots[0]!.statements[0]!;
    if (statement.kind !== "set" || statement.value.kind !== "fmt")
      throw new Error("expected formatting");
    statement.value.config = getter;
    expect(() => new Runtime().add(source, base)).toThrow();
    expect(called).toBe(false);
    const local = parse(
      '"arc"; function Main() { let items = Array(Str()); items.$set(["x"]); items[0].$set("y"); }',
    );
    const write = local.roots[0]!.statements[1]!;
    if (write.kind !== "set") throw new Error("expected element write");
    Reflect.set(write.target, "1", {
      kind: "fmt",
      value: { kind: "literal", value: 0 },
      config: {},
    });
    for (const document of [
      local,
      JSON.parse(JSON.stringify(local)) as Document,
    ]) {
      expect(validate(document)).toContainEqual(
        expect.objectContaining({ code: "INVALID_EXPRESSION_STRATUM" }),
      );
      expect(() => new Runtime().add(source, document)).toThrow();
    }
  });

  it("fmt.public-ir validates raw and deserialized expressions atomically", () => {
    const source = "fmt-public-document";
    const base = parse(
      '"arc"; function Main() { let text = Str(); text.$set(fmt("a")); }',
    );
    const cases: unknown[] = [
      { kind: "fmt", value: { kind: "literal", value: "a" } },
      { kind: "fmt", config: {} },
      {
        kind: "fmt",
        value: { kind: "literal", value: "a" },
        config: {},
        extra: 1,
      },
      {
        kind: "fmt",
        value: { kind: "literal", value: "a" },
        config: { str: "bad" },
      },
      {
        kind: "fmt",
        value: { kind: "literal", value: "a" },
        config: { array: { style: "json", parentheses: "[]" } },
      },
      { kind: "fmt", value: { kind: "dialogCursor" }, config: {} },
      { kind: "fmt", value: { kind: "invalid" }, config: {} },
    ];
    for (const expression of cases) {
      const document = JSON.parse(JSON.stringify(base)) as Document;
      const statement = document.roots[0]!.statements[0]!;
      if (statement.kind !== "set") throw new Error("expected set");
      statement.value = expression as FmtExpression;
      for (const raw of [
        document,
        JSON.parse(JSON.stringify(document)) as Document,
      ]) {
        expect(validate(raw).length).toBeGreaterThan(0);
        const runtime = new Runtime();
        expect(() => runtime.add(source, raw)).toThrow();
        expect(runtime.has(toArcRef(source, "Main"))).toBe(false);
        expect(() => runtime.add(source, base).init()).not.toThrow();
      }
    }
    const valid = JSON.parse(JSON.stringify(base)) as Document;
    expect(validate(valid)).toEqual([]);
    const runtime = new Runtime().add(source, valid).init();
    const seeded = runtime.newTraversal(toArcRef(source, "Main"));
    seeded.phase = "entered";
    expect(
      rootTraversal(startTerminal(runtime, [seeded], EMPTY_DIALOG)).cells.text,
    ).toBe("a");
  });

  it.each([
    [
      "unknown enter binding",
      (document: Document) => {
        Object.assign(document.roots[0]!.statements[0]!, {
          args: { input: { kind: "object", value: {} } },
        });
      },
    ],
    [
      "array binding map",
      (document: Document) => {
        Object.assign(document.roots[0]!.statements[0]!, { args: [] });
      },
    ],
    [
      "null binding source",
      (document: Document) => {
        Object.assign(document.roots[0]!.statements[0]!, {
          args: { input: null },
        });
      },
    ],
    [
      "args projection returns sink",
      (document: Document) => {
        Object.assign(document.roots[0]!.statements[0]!, {
          returns: { output: { kind: "argsProjection", key: "input" } },
        });
      },
    ],
    [
      "unknown statement",
      (document: Document) => {
        Object.assign(document.roots[0]!.statements[0]!, { kind: "unknown" });
      },
    ],
    [
      "missing cells",
      (document: Document) => {
        Reflect.deleteProperty(document.roots[0]!, "cells");
      },
    ],
  ] as const)(
    "document.grammar rejects %s before typed analysis",
    (_name, mutate) => {
      const document = fixture();
      mutate(document);
      rejectsRawAndJson(document, "INVALID_DOCUMENT_SHAPE");
    },
  );

  it.each(examples)(
    "document.grammar validates exact record grammar for $label",
    ({ document: original, path, optional }) => {
      expect(structure(original)).toEqual([]);
      const record = at(original, path) as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (optional.includes(key)) continue;
        const missing = clone(original);
        Reflect.deleteProperty(at(missing, path) as object, key);
        rejectsRawAndJson(missing, undefined, path);
        const wrong = clone(original);
        put(
          wrong,
          [...path, key],
          record.kind === "literal" && key === "value" ? [] : null,
        );
        rejectsRawAndJson(wrong, undefined, path);
      }
      const extra = clone(original);
      put(extra, [...path, "unknown"], true);
      rejectsRawAndJson(extra, undefined, [...path, "unknown"]);
      for (const discriminator of ["kind", "type"])
        if (Object.hasOwn(record, discriminator)) {
          const unknown = clone(original);
          put(unknown, [...path, discriminator], "unknown");
          rejectsRawAndJson(unknown, undefined, path);
        }
    },
  );

  it("document.grammar checks optional fields when supplied and supports absent data properties", () => {
    const document = parse(
      '"arc"; function Main() { let cell = Bool(); $instruct(`work`); }',
    );
    document.roots[0]!.guidance = undefined;
    expect(validate(document)).toEqual([]);
    const variants: [Path, unknown][] = [
      [[...rootPath, "guidance"], null],
      [[...rootPath, "displayName"], false],
      [[...rootPath, "description"], []],
      [[...rootPath, "signature"], null],
      [[...rootPath, "trigger"], {}],
      [[...rootPath, "loc"], {}],
      [[...rootPath, "cells", 0, "observing"], null],
      [[...actionPath, "id"], 1],
      [[...actionPath, "inheritedDeflectWhen"], "yes"],
    ];
    for (const [path, value] of variants)
      rejectsRawAndJson(put(clone(document), path, value), undefined, path);
  });

  it("document.grammar distinguishes declaration fields from shared spec semantics", () => {
    const extra = { type: "boolean", arbitrary: true };
    expect(validateSpec(extra)).toBeUndefined();
    for (const role of ["cell", "channel", "cell-element", "channel-element"]) {
      const document = emptyDocument();
      const path =
        role === "cell"
          ? [...rootPath, "cells", 0]
          : role === "cell-element"
            ? [...rootPath, "cells", 0, "element"]
            : role === "channel"
              ? [...rootPath, "signature", "args", "input"]
              : [...rootPath, "signature", "args", "input", "element"];
      document.roots[0]!.cells = [
        { name: "items", type: "array", element: { type: "boolean" } },
      ];
      document.roots[0]!.signature = {
        args: { input: { type: "array", element: { type: "boolean" } } },
        returns: {},
      };
      rejectsRawAndJson(
        put(document, path, {
          ...extra,
          ...(role === "cell" ? { name: "cell" } : {}),
        }),
        "INVALID_SPEC",
        [...path, "arbitrary"],
      );
    }
    const document = emptyDocument();
    const declarations: Cell[] = [
      { name: "cell", type: "boolean", observing: text, loc },
      {
        name: "count",
        type: "number",
        observeAs: { kind: "integer", min: 0 },
        observing: text,
      },
      {
        name: "items",
        type: "array",
        element: {
          type: "number",
          observeAs: { kind: "number", max: 5 },
          observing: text,
        },
      },
      {
        name: "file",
        type: "artifact",
        initializer: {
          kind: "artifact",
          path: { kind: "literal", value: "file.md" },
        },
      },
    ];
    document.roots[0]!.cells = declarations;
    expect(validate(document)).toEqual([]);
    expect(() => new Runtime().add("valid", document).init()).not.toThrow();
    for (const type of Object.keys(specs)) {
      for (const values of [[], ["same", "same"], [true]]) {
        if (type !== "enum") continue;
        const invalid = emptyDocument();
        invalid.roots[0]!.cells = [
          { name: "bad", type: "enum", values: values as string[] },
        ];
        rejectsRawAndJson(invalid, "INVALID_SPEC");
      }
    }
    for (const field of [
      "name",
      "loc",
      "observing",
      "observeAs",
      "initializer",
    ]) {
      const invalid = emptyDocument();
      invalid.roots[0]!.signature = {
        args: { input: { type: "boolean" } },
        returns: {},
      };
      put(
        invalid,
        [...rootPath, "signature", "args", "input", field],
        field === "name" ? "cell" : field === "loc" ? loc : text,
      );
      rejectsRawAndJson(
        invalid,
        field === "observeAs" ? "INVALID_NUMERIC_OBSERVE_AS" : "INVALID_SPEC",
      );
    }
    for (const element of [
      { type: "index" },
      { type: "dialogCursor" },
      { type: "array", element: { type: "string" } },
      { type: "artifact", initializer: expressions.artifact },
      { type: "boolean", name: "cell" },
    ]) {
      const invalid = emptyDocument();
      put(invalid, [...rootPath, "cells", 0], {
        name: "items",
        type: "array",
        element,
      });
      rejectsRawAndJson(invalid, "INVALID_SPEC");
    }
  });
});

describe("Document roles and shared entry points", () => {
  it("document.grammar validates recursive children in every local consumer", () => {
    const judge = expressions.judge;
    const invalid = [
      { ...expressions.arrayElementRead, index: judge },
      { ...expressions.dialogTurnsSince, receiver: judge },
      { ...expressions.dialogTurnsSince, baseline: judge },
      { ...expressions.regexTest, target: judge },
      {
        ...expressions.arrayElementRead,
        index: { ...expressions.arithmetic, left: judge },
      },
      {
        ...expressions.arrayElementRead,
        index: { ...expressions.numericUnary, argument: judge },
      },
      {
        ...expressions.arrayElementRead,
        index: { kind: "scope", name: "lastUserMessage", count: 1 },
      },
    ];
    for (const expression of invalid)
      rejectsRawAndJson(
        put(expressionDocument(), [...actionPath, "test"], expression),
      );
    rejectsRawAndJson(
      put(emptyDocument(), actionPath, {
        ...statements.set,
        target: ["items", judge],
      }),
      "INVALID_EXPRESSION_STRATUM",
    );
    for (const source of [
      "let items = Array(Bool()); items[judge(`index`)].$set(true);",
      "let cell = Bool(); cell.$set(/test/.test(judge(`string?`)));",
    ]) {
      expect(() => parse(`"arc"; function Main() { ${source} }`)).toThrow();
    }
  });

  it("document.grammar preserves value and semantic template placement", () => {
    for (const part of [
      { kind: "ref", name: "user" },
      { kind: "hostVar", module: "test", path: ["value"] },
    ]) {
      const valid = emptyDocument();
      valid.roots[0]!.guidance = {
        kind: "template-string",
        parts: [part],
      } as never;
      expect(validate(valid)).toEqual([]);
      rejectsRawAndJson(
        put(expressionDocument(), [...actionPath, "test"], {
          kind: "template-string",
          parts: [part],
        }),
        "INVALID_EXPRESSION_STRATUM",
      );
    }
    rejectsRawAndJson(
      put(expressionDocument(), [...actionPath, "test"], {
        kind: "cell",
        cell: "cell",
      }),
      "INVALID_EXPRESSION_STRATUM",
    );
    rejects(
      put(expressionDocument(), [...actionPath, "test"], {
        kind: "literal",
        value: undefined,
      }),
      "INVALID_EXPRESSION_STRATUM",
    );
    expect(() =>
      parse(
        '"arc"; function Main() { let cell = Str(); cell.$set(`${user}`); }',
      ),
    ).toThrow();
  });

  it("document.grammar enforces hook dialects through nested control flow", () => {
    const hooks = [
      "trigger",
      "guard",
      "deflectWhen",
      "catchDeflection",
      "catchInterruption",
      "effects",
    ] as const;
    for (const hook of hooks) {
      const document = emptyDocument();
      put(
        document,
        [...rootPath, hook],
        [
          {
            ...statements.if,
            consequent: [
              { ...statements.label, body: [statements.instruction] },
            ],
          },
        ],
      );
      rejectsRawAndJson(document, "INVALID_DOCUMENT_SHAPE", [
        ...rootPath,
        hook,
        0,
        "consequent",
        0,
        "body",
        0,
      ]);
      expect(() =>
        parse(
          `"arc"; function Main() { this.${hook} = () => { if (true) { label: { $instruct(\`work\`); } } }; }`,
        ),
      ).toThrow();
    }
    for (const action of [
      { ...statements.instruction, deflectWhen: [statements.instruction] },
      {
        ...statements.instruction,
        mode: "persistent",
        resolveWhen: [statements.instruction],
      },
      { ...statements["enter-loop"], resolveWhen: [statements.instruction] },
      { ...statements.invoke, body: [statements.return] },
      { ...statements.map, body: [statements.return] },
    ]) {
      rejectsRawAndJson(
        put(emptyDocument(), actionPath, action),
        "INVALID_DOCUMENT_SHAPE",
      );
    }
    for (const hook of ["trigger", "guard", "deflectWhen", "effects"]) {
      rejectsRawAndJson(
        put(emptyDocument(), [...rootPath, hook], [statements.observeOrAsk]),
        "INVALID_DOCUMENT_SHAPE",
      );
    }
  });

  it("document.grammar shares instruction configuration rules with source", () => {
    const cases = [
      [
        "$instructLoop(`work`);",
        { ...statements.instruction, mode: "persistent" },
      ],
      [
        "$instruct(`work`, { resolveWhen: () => true });",
        { ...statements.instruction, resolveWhen: [statements.return] },
      ],
    ] as const;
    for (const [source, action] of cases) {
      expect(() => parse(`"arc"; function Main() { ${source} }`)).toThrow();
      rejectsRawAndJson(
        put(emptyDocument(), actionPath, action),
        "INVALID_DOCUMENT_SHAPE",
        [...actionPath, "resolveWhen"],
      );
    }
    rejectsRawAndJson(
      put(emptyDocument(), actionPath, {
        ...statements.instruction,
        inheritedDeflectWhen: true,
      }),
      "INVALID_DOCUMENT_SHAPE",
      [...actionPath, "deflectWhen"],
    );
    for (const source of [
      "$instruct(`work`);",
      "$instructLoop(`work`, { resolveWhen: () => true });",
      "this.deflectWhen = () => false; invoke(() => { $instruct(`work`); });",
    ]) {
      const document = parse(`"arc"; function Main() { ${source} }`);
      expect(validate(clone(document))).toEqual([]);
      expect(() =>
        new Runtime().add("valid", clone(document)).init(),
      ).not.toThrow();
    }
  });

  it("document.grammar rejects reserved channel names in declarations", () => {
    for (const key of ["state", "length", "isUnset"]) {
      for (const namespace of ["args", "returns"]) {
        expect(() =>
          parse(`"arc"; function Main(${namespace} = { ${key}: Bool() }) {}`),
        ).toThrow(/reserved/);
        const document = emptyDocument();
        document.roots[0]!.signature = { args: {}, returns: {} };
        put(document, [...rootPath, "signature", namespace, key], {
          type: "boolean",
        });
        rejectsRawAndJson(document, "INVALID_CHANNEL_KEY", [
          ...rootPath,
          "signature",
          namespace,
          key,
        ]);
      }
    }
  });

  it("document.grammar checks binding direction without an imported declaration", () => {
    for (const operation of ["$enter", "$enterLoop"]) {
      const resolution =
        operation === "$enterLoop" ? ", resolveWhen: () => true" : "";
      const base = `"arc"; import { Child } from "child"; function Main(args = { input: Bool() }) { let cell = Bool(); ${operation}(Child, { args: { input: cell }, returns: { output: cell } ${resolution} }); }`;
      for (const [direction, binding, source] of [
        ["returns", { kind: "argsProjection", key: "input" }, "args.input"],
        ["returns", { kind: "span", owner: "map", key: "item" }, "span.item"],
        ["returns", { kind: "span", owner: "map", key: "index" }, "span.index"],
        ["args", { kind: "span", owner: "map", key: "result" }, "span.result"],
      ] as const) {
        const document = parse(base);
        const key = direction === "args" ? "input" : "output";
        put(document, [...actionPath, direction, key], binding);
        rejectsRawAndJson(document, "INVALID_DOCUMENT_SHAPE", [
          ...actionPath,
          direction,
          key,
        ]);
        expect(() =>
          parse(base.replace(`${key}: cell`, `${key}: ${source}`)),
        ).toThrow();
      }
      const projection = parse(
        base.replace("input: cell", "input: args.input"),
      );
      expect(validate(projection)).toEqual([]);
      expect(() => new Runtime().add("valid", projection)).not.toThrow();
      const document = parse(base);
      put(document, [...actionPath, "args", "input"], {
        kind: "span",
        owner: "map",
        key: "item",
      });
      rejectsRawAndJson(document, "SPAN_OUTSIDE_MAP");
    }
  });

  it("document.grammar accepts all map binding directions for enter and enterLoop", () => {
    for (const operation of ["$enter", "$enterLoop"]) {
      const resolution =
        operation === "$enterLoop" ? ", resolveWhen: () => true" : "";
      const document =
        parse(`"arc"; function Main(args = { forwarded: Str() }) {
        let items = Array(Str()); let results = Array(Str());
        items.$map(() => { ${operation}(newcopy(Child), { args: { value: span.item, index: span.index, forwarded: args.forwarded }, returns: { output: span.result } ${resolution} }); }, results);
        function Child(args = { value: Str(), index: Index(), forwarded: Str() }, returns = { output: Str() }) {}
      }`);
      expect(validate(document)).toEqual([]);
      expect(validate(clone(document))).toEqual([]);
      expect(() =>
        new Runtime().add("valid", clone(document)).init(),
      ).not.toThrow();
    }
  });

  it("document.grammar validates grouped observations in trigger and guard scopes", () => {
    for (const hook of ["trigger", "guard"]) {
      const document = parse(
        `"arc"; function Main() { let cell = Bool(); this.${hook} = () => { $observe({ cell }); }; }`,
      );
      put(document, [...rootPath, hook, 0, "targets"], [["missing"]]);
      rejectsRawAndJson(document, "UNKNOWN_CELL");
      expect(() =>
        parse(
          `"arc"; function Main() { this.${hook} = () => { $observe({ missing }); }; }`,
        ),
      ).toThrow(/UNKNOWN_CELL/);
    }
    for (const targets of [[["cell"], ["cell"]], [["items", num]]]) {
      rejectsRawAndJson(
        put(emptyDocument(), actionPath, {
          ...statements.observeGroup,
          targets,
        }),
        "INVALID_DOCUMENT_SHAPE",
        [...actionPath, "targets"],
      );
    }
  });

  it("document.grammar validates guidance references and non-suspending Artifact initializers", () => {
    for (const source of [
      "this.guidance = `${missing}`;",
      "let file = Artifact(Host.path());",
    ]) {
      expect(() =>
        parse(
          `"arc"; import Host from "host:test"; function Main() { ${source} }`,
        ),
      ).toThrow();
    }
    const document = emptyDocument();
    document.roots[0]!.guidance = {
      kind: "template-string",
      parts: [
        { kind: "expression", expression: { kind: "cell", name: "missing" } },
      ],
    };
    rejectsRawAndJson(document, "UNKNOWN_CELL");
    for (const expression of [
      expressions.judge,
      { ...call, target: [], arguments: [] },
    ]) {
      const invalid = emptyDocument();
      invalid.roots[0]!.cells = [
        {
          name: "file",
          type: "artifact",
          initializer: { kind: "artifact", path: expression },
        },
      ];
      rejectsRawAndJson(invalid, "INVALID_ARTIFACT_CELL_SPEC");
    }
    const semanticArtifact = emptyDocument();
    semanticArtifact.roots[0]!.guidance = {
      kind: "template-string",
      parts: [
        {
          kind: "expression",
          expression: {
            kind: "artifact",
            path: { kind: "cell", name: "missing" },
          },
        },
      ],
    };
    rejectsRawAndJson(semanticArtifact, "UNKNOWN_CELL");
  });

  it("document.grammar keeps authored map keys and payload shapes in their declared roles", () => {
    const keys = ["kind", "type", "value", "observeAs", "hostParams"];
    const document = emptyDocument();
    document.roots[0]!.signature = {
      args: Object.fromEntries(keys.map((key) => [key, { type: "boolean" }])),
      returns: {},
    };
    document.roots[0]!.hostParams = {
      kind: "host-call",
      type: "number",
      value: { kind: "object", value: { malformed: true } },
      observeAs: "ordinary data",
      hostParams: { kind: "judge", id: "" },
    };
    expect(validate(document)).toEqual([]);
    expect(() => new Runtime().add("valid", document).init()).not.toThrow();
    const host = parse(
      '"arc"; import Host from "host:test"; function Main() { Host.$run({}); }',
    );
    put(
      host,
      [...actionPath, "arguments", 0, "value"],
      Object.fromEntries(
        keys.map((key) => [key, { kind: "value", value: bool }]),
      ),
    );
    expect(validate(host)).toEqual([]);
    const registry = new Map([
      [
        "test",
        hmd.define({
          run: (
            _value = hmd.Struct({
              kind: hmd.Bool(),
              type: hmd.Bool(),
              value: hmd.Bool(),
              observeAs: hmd.Bool(),
              hostParams: hmd.Bool(),
            }),
          ) => {},
        }),
      ],
    ]);
    expect(() =>
      new Runtime({ hostModules: registry }).add("valid", host).init(),
    ).not.toThrow();
    put(host, [...actionPath, "arguments", 0, "value", "hostParams"], {
      kind: "value",
      value: { nested: undefined },
    });
    rejects(host, "HOST_CALL_ARGUMENT");
  });

  it("document.grammar revalidates shared identity for each structural role and lexical scope", () => {
    for (const reverse of [false, true]) {
      const document = fixture();
      const shared = { kind: "object", value: {} };
      put(document, [...actionPath, "args", "input"], shared);
      document.roots[0]!.statements.push({
        ...call,
        target: [],
        arguments: [shared],
      } as never);
      if (reverse) document.roots[0]!.statements.reverse();
      const entryIndex = reverse ? 1 : 0;
      rejects(document, "INVALID_DOCUMENT_SHAPE", [
        ...rootPath,
        "statements",
        entryIndex,
        "args",
        "input",
      ]);
    }
    const shared = { kind: "cell", name: "onlyHere" } as const;
    const document = emptyDocument();
    document.roots.push({ ...emptyDocument().roots[0]!, identifier: "Second" });
    for (const [index, root] of document.roots.entries()) {
      root.cells = [
        { name: "dest", type: "boolean" },
        ...(index === 0
          ? [{ name: "onlyHere", type: "boolean" } as const]
          : []),
      ];
      root.statements = [
        { ...statements.set, target: ["dest"], value: shared },
      ];
    }
    rejects(document, "UNKNOWN_CELL");
    document.roots[1]!.cells.push({ name: "onlyHere", type: "boolean" });
    expect(
      validate(document).every((issue) => issue.code === "ELEMENT_ID"),
    ).toBe(true);
    expect(() => new Runtime().add("valid", document).init()).not.toThrow();
  });

  it("document.grammar orders safety grammar and semantic diagnostics with stable paths", () => {
    const document = parse(
      '"arc"; import Host from "host:test"; function Main() { let cell = Bool(); cell.$set(true); }',
    );
    document.hostModules[0]!.localName = "$enter";
    put(document, [...actionPath, "value"], {
      kind: "literal",
      value: undefined,
    });
    const shape = validate(document);
    expect(shape.map((issue) => issue.code)).toEqual([
      "INVALID_EXPRESSION_STRATUM",
    ]);
    expect(shape[0]?.message).toContain(
      printed([...actionPath, "value", "value"]),
    );
    expect(shape[0]?.loc).toEqual(document.roots[0]!.statements[0]!.loc);
    put(document, [...actionPath, "value"], bool);
    expect(validate(document).map((issue) => issue.code)).toEqual([
      "RESERVED_IMPORT_ALIAS",
    ]);
    const siblings = emptyDocument();
    put(siblings, [...rootPath, "cells"], null);
    put(siblings, [...rootPath, "statements"], {});
    const expected = validate(siblings);
    expect(expected.map((issue) => issue.message)).toEqual([
      `Invalid Document at ${printed([...rootPath, "cells"])}: expected an array`,
      `Invalid Document at ${printed([...rootPath, "statements"])}: expected an array`,
    ]);
    expect(validate(siblings)).toEqual(expected);
    const analysis = analyzeDocument(siblings);
    expect(analysis.lintIssues).toEqual([]);
    expect(analysis.rewalkPlan.bySeg.size).toBe(0);
    const malformedLoc = clone(document);
    put(malformedLoc, [...actionPath, "loc"], {
      start: { line: 0, column: -1 },
      end: {},
    });
    expect(
      validate(malformedLoc).every(
        (issue) => issue.loc === undefined || issue.loc.start.line > 0,
      ),
    ).toBe(true);
  });
});

describe("Document safety and ownership", () => {
  it("document.grammar assigns every unsafe graph location to INVALID_PUBLIC_IR without invoking getters", () => {
    let calls = 0;
    const getter = () => {
      calls++;
      throw new Error("getter ran");
    };
    const factories: (() => unknown)[] = [
      () =>
        Object.defineProperty({}, "value", { enumerable: true, get: getter }),
      () => Object.defineProperty({}, "hidden", { value: true }),
      () => ({ [Symbol("key")]: true }),
      () => new Date(0),
      () => Object.create({ inherited: true }),
      () => {
        const value: unknown[] = [];
        value.length = 2;
        return value;
      },
      () => Object.assign([], { extra: true }),
      () => Object.defineProperty([true], "0", { get: getter }),
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      () => Symbol("value"),
      () => 1n,
      () => getter,
    ];
    for (const factory of factories)
      for (const position of [
        "node payload",
        "instruction payload",
        "extra IR field",
      ]) {
        const document = parse('"arc"; function Main() { $instruct(`work`); }');
        const path =
          position === "node payload"
            ? [...rootPath, "hostParams"]
            : position === "instruction payload"
              ? [...actionPath, "hostParams"]
              : [...rootPath, "extra"];
        put(document, path, factory());
        rejects(document, "INVALID_PUBLIC_IR", path);
        expect(
          validate(document).every(
            (issue) => issue.code === "INVALID_PUBLIC_IR",
          ),
        ).toBe(true);
      }
    expect(calls).toBe(0);
  });

  it("document.grammar assigns safe payload carrier violations only at actual payload positions", () => {
    for (const value of [null, { nested: undefined }, [undefined]]) {
      for (const path of [
        [...rootPath, "hostParams"],
        [...actionPath, "hostParams"],
      ]) {
        const document = parse('"arc"; function Main() { $instruct(`work`); }');
        put(document, path, value);
        rejects(document, "INVALID_PAYLOAD_VALUE", path);
        expect(
          validate(document).every(
            (issue) => issue.code === "INVALID_PAYLOAD_VALUE",
          ),
        ).toBe(true);
      }
    }
    const document = emptyDocument();
    document.roots[0]!.hostParams = Object.assign(
      Object.create(null) as Record<string, boolean>,
      { ordinary: true },
    );
    expect(validate(document)).toEqual([]);
    expect(() => new Runtime().add("valid", document)).not.toThrow();
  });

  it("document.grammar preserves ownership and atomicity while stamping only a validated private clone", () => {
    const document = parse(
      '"arc"; function Main() { $instruct(`original`); } function Second() {}',
    );
    Reflect.deleteProperty(document.roots[0]!.statements[0]!, "id");
    const valid = clone(document);
    Object.assign(document.roots[1]!, { cells: null });
    const before = JSON.stringify(document);
    const runtime = new Runtime().add("existing", emptyDocument());
    expect(() => runtime.add("same-source", document)).toThrow(
      RuntimeRegistrationError,
    );
    expect(JSON.stringify(document)).toBe(before);
    expect(runtime.has(toArcRef("existing", "Main"))).toBe(true);
    expect(runtime.has(toArcRef("same-source", "Main"))).toBe(false);
    expect(runtime.has(toArcRef("same-source", "Second"))).toBe(false);
    expect(validate(valid).map((issue) => issue.code)).toEqual(["ELEMENT_ID"]);
    runtime.add("same-source", valid).init();
    expect(valid.roots[0]!.statements[0]).not.toHaveProperty("id");
    Object.assign(valid.roots[0]!.statements[0]!, {
      template: { kind: "literal", value: "mutated" },
    });
    const traversal = runtime.newTraversal(toArcRef("same-source", "Main"));
    traversal.phase = "entered";
    expect(
      startRun(runtime, [traversal], EMPTY_DIALOG).instructions.map(
        (item) => item.text,
      ),
    ).toEqual(["original"]);
  });
});

describe("Document import records", () => {
  it("document.grammar checks import identity after record validation", () => {
    const document = parse(
      '"arc"; import Host from "host:test"; function Main() {}',
    );
    const duplicate = clone(document);
    duplicate.hostModules.push(clone(duplicate.hostModules[0]!));
    rejectsRawAndJson(duplicate, "DUPLICATE_IMPORT");
    const collision = clone(document);
    collision.imports.push({
      importedName: "Other",
      localName: "Host",
      source: "other",
    });
    rejectsRawAndJson(collision, "DUPLICATE_IMPORT");
    const source = clone(document);
    source.hostModules[0]!.source = "host:another";
    rejectsRawAndJson(source, "INVALID_IMPORT_BINDING");
    const placement = emptyDocument();
    placement.imports.push({
      importedName: "Host",
      localName: "Host",
      source: "host:test",
    });
    rejectsRawAndJson(placement, "INVALID_IMPORT_BINDING");
    const malformed = clone(document);
    malformed.hostModules[0]!.importedName = "named";
    rejectsRawAndJson(malformed, "INVALID_DOCUMENT_SHAPE", [
      "hostModules",
      0,
      "importedName",
    ]);
  });
});

describe("Union declaration grammar", () => {
  it("union.grammar preserves ordered flat members a Union question and refinements at eligible positions", () => {
    const document = parse(`
      "arc";
      function Main(args = { input: Union([Num(), Str()]), index: Index() }, returns = { output: Array(Union([Num(), Str()])) }) {
        let choice = Union([Enum(["none"]), Str(), Str(), RangedInt(1, 5)], { observing: \`choice\` });
        let rows = Array(Union([Num(), Str()]));
        let record = Struct({ nested: Struct({ choice: Union([Bool(), Num()]) }) });
      }
    `);
    expect(validate(document)).toEqual([]);
    expect(document.roots[0]?.cells[0]).toMatchObject({
      type: "union",
      observing: {
        kind: "template-string",
        parts: [{ kind: "text", value: "choice" }],
      },
      members: [
        { type: "enum", values: ["none"] },
        { type: "string" },
        { type: "string" },
        {
          type: "number",
          observeAs: { kind: "integer", min: 1, max: 5 },
        },
      ],
    });
    expect(validate(JSON.parse(JSON.stringify(document)) as Document)).toEqual(
      [],
    );
  });

  it("union.grammar rejects nested Unions Index container members and malformed source lists", () => {
    const invalidMembers = [
      "Union([Num(), Str()])",
      "Index()",
      "Array(Num())",
      "Struct({})",
      "Artifact()",
      "Dialog.Cursor()",
      'Bool({ observing: "member" })',
      'Str({ observing: "member" })',
      'Enum(["none"], { observing: "member" })',
      'Num({ observing: "member" })',
      'RangedInt(1, 5, { observing: "member" })',
    ];
    for (const member of invalidMembers) {
      for (const declaration of [
        `function Main() { let value = Union([Num(), ${member}]); }`,
        `function Main() { let values = Array(Union([Num(), ${member}])); }`,
        `function Main() { let record = Struct({ choice: Union([Num(), ${member}]) }); }`,
        `function Main(args = { value: Union([Num(), ${member}]) }) {}`,
      ])
        expect(() => parse(`"arc"; ${declaration}`)).toThrow();
    }
    for (const members of [
      "[]",
      "[Num()]",
      "[Num, Str()]",
      "[Num(), , Str()]",
      "[...members, Num()]",
    ]) {
      expect(() =>
        parse(`"arc"; function Main() { let value = Union(${members}); }`),
      ).toThrow();
    }
    expect(() =>
      parse(
        '"arc"; function Main(args = { value: Union([Num(), Str()], { observing: `invalid` }) }) {}',
      ),
    ).toThrow();
    expect(() =>
      parse('"arc"; import Union from "host:service"; function Main() {}'),
    ).toThrow(/reserved/);
  });

  it("union.public-ir enforces the same member boundary in cells fields elements and channels", () => {
    const base =
      parse(`"arc"; function Main(args = { input: Union([Num(), Str()]) }, returns = { output: Union([Num(), Str()]) }) {
      let choice = Union([Num(), Str()]); let rows = Array(Union([Num(), Str()])); let record = Struct({ choice: Union([Num(), Str()]) });
    }`);
    const paths: Path[] = [
      ["roots", 0, "cells", 0],
      ["roots", 0, "cells", 1, "element"],
      ["roots", 0, "cells", 2, "fields", "choice"],
      ["roots", 0, "signature", "args", "input"],
      ["roots", 0, "signature", "returns", "output"],
    ];
    for (const path of paths)
      for (const members of [
        [],
        [{ type: "number" }],
        [{ type: "number" }, { type: "index" }],
        [
          { type: "number" },
          { type: "union", members: [{ type: "boolean" }, { type: "string" }] },
        ],
        [{ type: "number" }, { type: "struct", fields: {} }],
        [{ type: "number" }, { type: "boolean", extra: true }],
        [
          { type: "number" },
          { type: "string", observing: { kind: "literal", value: "member" } },
        ],
      ]) {
        const document = clone(base);
        put(document, [...path, "members"], members);
        expect(structure(document).length).toBeGreaterThan(0);
        expect(() => new Runtime().add("invalid-union", document)).toThrow(
          RuntimeRegistrationError,
        );
      }
  });
});
