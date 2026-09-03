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
