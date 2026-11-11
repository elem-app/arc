import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { Runtime, RuntimeRegistrationError } from "../src/runtime/index.js";

function registrationError(run: () => unknown): RuntimeRegistrationError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeRegistrationError);
  return thrown as RuntimeRegistrationError;
}

describe("Runtime.init", () => {
  const caller = (source = "op-arc") =>
    parse(`
"arc";
import { Op } from ${JSON.stringify(source)};
function Main() {
  let input = Str();
  $enter(Op, { args: { value: input } });
}
`);

  const op = (spec = "Str()") =>
    parse(`
"arc";
function Op(args = { value: ${spec} }) {}
`);

  const mapCaller = () =>
    parse(`
"arc";
import { Op } from "map-op";
function Main() {
  let input = Array(Str());
  let output = Array(Str());
  input.$map(() => {
    $enter(newcopy(Op), {
      args: { value: span.item, index: span.index },
      returns: { value: span.result },
    });
  }, output);
}
`);

  const mapOp = (
    valueSpec = "Str()",
    indexSpec = "Index()",
    returnSpec = "Str()",
  ) =>
    parse(`
"arc";
function Op(
  args = { value: ${valueSpec}, index: ${indexSpec} },
  returns = { value: ${returnSpec} },
) {}
`);

  it("rejects execution before initialization and seals after success", () => {
    const runtime = new Runtime().add(
      "main-arc",
      parse(`
"arc";
function Main() {}
`),
    );

    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    for (const execute of [
      () => runtime.newTraversal("arc:main-arc:Main"),
      () => runtime.startTrigger([], dialog),
      () => runtime.progressTrigger({} as never, {} as never, dialog),
      () => runtime.start([], dialog),
      () => runtime.enterArc("arc:main-arc:Main", dialog),
      () => runtime.progress({} as never, {} as never, dialog),
    ]) {
      expect(execute).toThrow(/Runtime\.init\(\)/);
    }
    expect(runtime.init()).toBe(runtime);
    expect(() => runtime.newTraversal("arc:main-arc:Main")).not.toThrow();
    expect(() =>
      runtime.add(
        "later",
        parse(`
"arc";
function Later() {}
`),
      ),
    ).toThrow(/cannot collect/);
  });

  it.each([
    [
      "an accessor field",
      (document: ReturnType<typeof parse>) => {
        Object.defineProperty(document.roots[0]!, "identifier", {
          enumerable: true,
          get: () => {
            throw new Error("the raw validator must not invoke accessors");
          },
        });
      },
    ],
    [
      "a symbol field",
      (document: ReturnType<typeof parse>) => {
        Object.defineProperty(document, Symbol("private"), {
          enumerable: true,
          value: true,
        });
      },
    ],
    [
      "a non-enumerable field",
      (document: ReturnType<typeof parse>) => {
        Object.defineProperty(document.roots[0]!, "private", {
          enumerable: false,
          value: true,
        });
      },
    ],
    [
      "an array hole",
      (document: ReturnType<typeof parse>) => {
        delete document.roots[0];
      },
    ],
  ])("rejects raw public IR containing %s before cloning", (_case, mutate) => {
    const document = parse(`
"arc";
function Main() {}
`);
    mutate(document);

    expect(() => new Runtime().add("malformed", document)).toThrow(
      /INVALID_PUBLIC_IR/,
    );
  });

  it("keeps collection retryable after a missing import", () => {
    const runtime = new Runtime().add("caller-arc", caller());
    expect(() => runtime.init()).toThrow(/UNRESOLVED_IMPORT/);
    expect(() => runtime.add("op-arc", op())).not.toThrow();
    expect(() => runtime.init()).not.toThrow();
  });

  it("reports every independent registry issue in one initialization error", () => {
    const document = parse(`
"arc";
import { Missing } from "missing-arc";
import { Op } from "op-arc";
function Main() {
  let input = Str();
  $enter(Missing, { args: { value: input } });
  $enter(Op, { args: { value: input, extra: input } });
}
`);
    const target = parse(`
"arc";
function Op(args = { value: Bool() }) {}
`);

    const collect = (targetFirst: boolean) => {
      const runtime = new Runtime();
      if (targetFirst) {
        runtime.add("op-arc", target).add("caller-arc", document);
      } else {
        runtime.add("caller-arc", document).add("op-arc", target);
      }
      return registrationError(() => runtime.init());
    };

    const targetFirst = collect(true);
    const callerFirst = collect(false);
    for (const error of [targetFirst, callerFirst]) {
      expect(error.operation).toBe("init");
      expect(error.issues).toHaveLength(3);
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "registry",
            code: "UNRESOLVED_IMPORT",
            source: "caller-arc",
            localName: "Missing",
          }),
          expect.objectContaining({
            phase: "registry",
            code: "ENTER_CHANNEL_UNDECLARED",
            namespace: "args",
            key: "extra",
          }),
          expect.objectContaining({
            phase: "registry",
            code: "ENTER_CHANNEL_INCOMPATIBLE",
            namespace: "args",
            key: "value",
          }),
        ]),
      );
      expect(error.message).toMatch(/UNRESOLVED_IMPORT/);
      expect(error.message).toMatch(/ENTER_CHANNEL_UNDECLARED/);
      expect(error.message).toMatch(/ENTER_CHANNEL_INCOMPATIBLE/);
    }
    expect(callerFirst.issues).toEqual(targetFirst.issues);
  });

  it("validates imported reusable bindings in either add order", () => {
    const targetFirst = new Runtime()
      .add("op-arc", op())
      .add("caller-arc", caller());
    expect(() => targetFirst.init()).not.toThrow();

    const callerFirst = new Runtime()
      .add("caller-arc", caller())
      .add("op-arc", op());
    expect(() => callerFirst.init()).not.toThrow();

    const incompatible = new Runtime()
      .add("caller-arc", caller())
      .add("op-arc", op("Bool()"));
    expect(() => incompatible.init()).toThrow(/ENTER_CHANNEL_INCOMPATIBLE/);
    expect(() =>
      incompatible.add(
        "unrelated",
        parse(`
"arc";
function Other() {}
`),
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "widened args",
      namespace: "args",
      body: 'let value = Enum(["a"]); ENTRY',
      binding: "value",
      target: "args = { value: Str() }",
      outcome: "accepted",
    },
    {
      name: "narrowed args",
      namespace: "args",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: 'args = { value: Enum(["a"]) }',
      outcome: "incompatible",
    },
    {
      name: "widened return sinks",
      namespace: "returns",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: 'returns = { value: Enum(["a"]) }',
      outcome: "accepted",
    },
    {
      name: "narrowed return sinks",
      namespace: "returns",
      body: 'let value = Enum(["a"]); ENTRY',
      binding: "value",
      target: "returns = { value: Str() }",
      outcome: "incompatible",
    },
    {
      name: "args without a signature",
      namespace: "args",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: "",
      outcome: "undeclared",
    },
    {
      name: "args with an empty signature",
      namespace: "args",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: "args = {}",
      outcome: "undeclared",
    },
    {
      name: "returns without a signature",
      namespace: "returns",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: "",
      outcome: "undeclared",
    },
    {
      name: "returns with an empty signature",
      namespace: "returns",
      body: "let value = Str(); ENTRY",
      binding: "value",
      target: "returns = {}",
      outcome: "undeclared",
    },
    {
      name: "widened forwarded args",
      namespace: "args",
      parameters: "args = { input: Index() }",
      body: "ENTRY",
      binding: "args.input",
      target: "args = { value: Num() }",
      outcome: "accepted",
    },
    {
      name: "narrowed forwarded args",
      namespace: "args",
      parameters: "args = { input: Num() }",
      body: "ENTRY",
      binding: "args.input",
      target: "args = { value: Index() }",
      outcome: "incompatible",
    },
    {
      name: "matching struct map items",
      namespace: "args",
      body: "let input = Array(Struct({ field: Num() })); input.$map(() => { ENTRY });",
      binding: "span.item",
      target: "args = { value: Struct({ field: Num() }) }",
      outcome: "accepted",
    },
    {
      name: "incompatible struct map items",
      namespace: "args",
      body: "let input = Array(Struct({ field: Num() })); input.$map(() => { ENTRY });",
      binding: "span.item",
      target: "args = { value: Struct({ field: Str() }) }",
      outcome: "incompatible",
    },
    {
      name: "widened map indices",
      namespace: "args",
      body: "let input = Array(Str()); input.$map(() => { ENTRY });",
      binding: "span.index",
      target: "args = { value: Num() }",
      outcome: "accepted",
    },
    {
      name: "incompatible map indices",
      namespace: "args",
      body: "let input = Array(Str()); input.$map(() => { ENTRY });",
      binding: "span.index",
      target: "args = { value: Bool() }",
      outcome: "incompatible",
    },
    {
      name: "widened map results",
      namespace: "returns",
      body: "let input = Array(Num()); let output = Array(Str()); input.$map(() => { ENTRY }, output);",
      binding: "span.result",
      target: 'returns = { value: Enum(["a"]) }',
      outcome: "accepted",
    },
    {
      name: "narrowed map results",
      namespace: "returns",
      body: 'let input = Array(Num()); let output = Array(Enum(["a"])); input.$map(() => { ENTRY }, output);',
      binding: "span.result",
      target: "returns = { value: Str() }",
      outcome: "incompatible",
    },
  ])(
    "compose.typed-binding local and imported enforcers agree on $name",
    ({ namespace, parameters, body, binding, target, outcome }) => {
      for (const entry of ["$enter", "$enterLoop"]) {
        const action = `${entry}(newcopy(Op), { ${namespace}: { value: ${binding} }, ${entry === "$enterLoop" ? "resolveWhen: () => true" : ""} });`;
        const targetSource = `function Op(${target}) {}`;
        const source = (imported: boolean) => `
"arc";
${imported ? 'import { Op } from "op-arc";' : ""}
function Main(${parameters ?? ""}) {
  ${body.replace("ENTRY", action)}
  ${imported ? "" : targetSource}
}
`;
        if (outcome === "accepted") {
          expect(() =>
            new Runtime().add("local", parse(source(false))).init(),
          ).not.toThrow();
        } else {
          const code =
            outcome === "incompatible"
              ? "ENTER_CHANNEL_INCOMPATIBLE"
              : namespace === "args"
                ? "UNDECLARED_ARGS_KEY"
                : "UNDECLARED_RETURNS_KEY";
          expect(() => parse(source(false))).toThrow(code);
        }

        const caller = parse(source(true));
        const callee = parse(`"arc"; ${targetSource}`);
        for (const targetFirst of [false, true]) {
          const runtime = new Runtime();
          const documents = [
            ["caller", caller],
            ["op-arc", callee],
          ] as const;
          for (const [name, document] of targetFirst
            ? [...documents].reverse()
            : documents) {
            runtime.add(name, document);
          }
          if (outcome === "accepted") {
            expect(() => runtime.init()).not.toThrow();
          } else {
            const error = registrationError(() => runtime.init());
            expect(error.operation).toBe("init");
            expect(error.issues).toEqual([
              expect.objectContaining({
                phase: "registry",
                code:
                  outcome === "incompatible"
                    ? "ENTER_CHANNEL_INCOMPATIBLE"
                    : "ENTER_CHANNEL_UNDECLARED",
                target: "Op",
                namespace,
                key: "value",
              }),
            ]);
          }
        }
      }
    },
  );

  it("rejects channel keys absent from an imported target signature", () => {
    const document = parse(`
"arc";
import { Op } from "op-arc";
function Main() {
  let input = Str();
  $enter(Op, { args: { missing: input } });
}
`);

    expect(() =>
      new Runtime().add("caller", document).add("op-arc", op()).init(),
    ).toThrow(/ENTER_CHANNEL_UNDECLARED/);
  });

  it("compose.typed-binding rejects every undeclared imported binding before execution", () => {
    for (const entry of ["$enter", "$enterLoop"]) {
      const document = parse(`
"arc";
import { Op } from "op-arc";
function Main() {
  let input = Bool();
  let output = Bool();
  if (false) {
    ${entry}(Op, {
      args: { input },
      returns: { output },
      ${entry === "$enterLoop" ? "resolveWhen: () => true" : ""}
    });
  }
}
`);
      const branch = document.roots[0]!.statements[0]!;
      if (branch.kind !== "if") throw new Error("Expected branch");
      const action = branch.consequent[0]!;
      if (action.kind !== "enter-node" && action.kind !== "enter-loop") {
        throw new Error("Expected entry");
      }
      action.args = {
        ...action.args,
        constructor: { kind: "cell" as const, cell: "input" },
      };
      for (const parameters of [
        "",
        "args = {}, returns = {}",
        "args = { other: Bool() }",
      ]) {
        const target = parse(`"arc"; function Op(${parameters}) {}`);
        for (const targetFirst of [false, true]) {
          const runtime = new Runtime();
          const documents = [
            ["caller", document],
            ["op-arc", target],
          ] as const;
          for (const [source, value] of targetFirst
            ? [...documents].reverse()
            : documents) {
            runtime.add(source, value);
          }
          const error = registrationError(() => runtime.init());
          expect(error.operation).toBe("init");
          expect(error.issues).toHaveLength(3);
          expect(error.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "ENTER_CHANNEL_UNDECLARED",
                namespace: "args",
                key: "input",
              }),
              expect.objectContaining({
                code: "ENTER_CHANNEL_UNDECLARED",
                namespace: "args",
                key: "constructor",
              }),
              expect.objectContaining({
                code: "ENTER_CHANNEL_UNDECLARED",
                namespace: "returns",
                key: "output",
              }),
            ]),
          );
          expect(() =>
            runtime.add("extra", parse('"arc"; function Extra() {}')),
          ).not.toThrow();
        }
      }
    }
  });

  it("carries map receiver and result element specs into imported bindings", () => {
    for (const documents of [
      [
        ["caller", mapCaller()],
        ["map-op", mapOp()],
      ],
      [
        ["map-op", mapOp()],
        ["caller", mapCaller()],
      ],
    ] as const) {
      const runtime = new Runtime();
      for (const [source, document] of documents) runtime.add(source, document);
      expect(() => runtime.init()).not.toThrow();
    }
  });

  it.each([
    ["span.item argument", "Bool()", "Index()", "Str()"],
    ["span.index argument", "Str()", "Bool()", "Str()"],
    ["span.result return", "Str()", "Index()", "Bool()"],
  ])(
    "rejects an incompatible imported map %s in either add order",
    (_case, valueSpec, indexSpec, returnSpec) => {
      for (const targetFirst of [false, true]) {
        const runtime = new Runtime();
        if (targetFirst) {
          runtime
            .add("map-op", mapOp(valueSpec, indexSpec, returnSpec))
            .add("caller", mapCaller());
        } else {
          runtime
            .add("caller", mapCaller())
            .add("map-op", mapOp(valueSpec, indexSpec, returnSpec));
        }
        expect(() => runtime.init()).toThrow(/ENTER_CHANNEL_INCOMPATIBLE/);
      }
    },
  );
});
