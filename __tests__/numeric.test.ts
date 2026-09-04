/** Deterministic coverage for Arc's single-number language and runtime contract. */
import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import type { Document, PayloadValue } from "../src/types/index.js";
import {
  arc,
  EMPTY_DIALOG,
  groupObservation,
  progressBrief,
  progressTerminal,
  rootTraversal,
  TestRuntime as Runtime,
  singleObservation,
  startRun,
  startTerminal,
  startTrigger,
} from "./helpers.js";

function run(source: string, id: string) {
  const runtime = new Runtime().add(id, parse(source)).init();
  const traversal = runtime.newTraversal(arc(id, "Main"));
  traversal.phase = "entered";
  return {
    runtime,
    brief: startRun(runtime, [traversal], EMPTY_DIALOG),
  };
}

function runTerminal(source: string, id: string) {
  const runtime = new Runtime().add(id, parse(source)).init();
  const traversal = runtime.newTraversal(arc(id, "Main"));
  traversal.phase = "entered";
  return {
    runtime,
    brief: startTerminal(runtime, [traversal], EMPTY_DIALOG),
  };
}

function firstStatement(document: Document) {
  const statement = document.roots[0]?.statements[0];
  if (!statement) throw new Error("expected a statement");
  return statement;
}

function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFiniteNumber);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNonFiniteNumber);
  }
  return false;
}

function cloneDocument(document: Document): Document {
  return JSON.parse(JSON.stringify(document)) as Document;
}

describe("numeric semantics", () => {
  describe("numeric.source-ir", () => {
    it("parses Num and RangedInt shorthand into one canonical numeric cell kind", () => {
      const document = parse(`
"arc";
function Main() {
  let free = Num({ observeAs: { kind: "number", min: -2.5, max: 4 } });
  let count = RangedInt(-3, 7, { observing: "a count" });
}
`);

      expect(document.roots[0]?.cells).toMatchObject([
        {
          name: "free",
          type: "number",
          observeAs: { kind: "number", min: -2.5, max: 4 },
        },
        {
          name: "count",
          type: "number",
          observeAs: { kind: "integer", min: -3, max: 7 },
        },
      ]);
    });

    it("uses distinct comparison, arithmetic, numeric-unary, and predicate IR", () => {
      const document = parse(`
"arc";
function Main() {
  let n = Num();
  let ok = Bool();
  n.$set(-(6 / 3) + 1);
  ok.$set(Num.isFinite(n * 2) == true);
}
`);
      expect(firstStatement(document)).toMatchObject({
        kind: "set",
        value: {
          kind: "arithmetic",
          op: "+",
          left: {
            kind: "numericUnary",
            argument: { kind: "arithmetic", op: "/" },
          },
        },
      });
      expect(document.roots[0]?.statements[1]).toMatchObject({
        value: {
          kind: "comparison",
          left: { kind: "numIsFinite", argument: { kind: "arithmetic" } },
        },
      });
    });

    it("rejects strict equality and unsupported arithmetic operators", () => {
      expect(() =>
        parse(`"arc"; function Main() { let b = Bool(); b.$set(1 === 1); }`),
      ).toThrow(/Unsupported binary operator: ===/);
      expect(() =>
        parse(`"arc"; function Main() { let n = Num(); n.$set(2 ** 3); }`),
      ).toThrow(/Unsupported binary operator/);
    });

    it.each([
      ["strict inequality", "1 !== 2"],
      ["unary plus", "+1"],
      ["bitwise", "1 & 2"],
      ["shift", "1 << 2"],
      ["increment", "n++"],
      ["decrement", "n--"],
      ["compound assignment", "n += 1"],
    ])("rejects unsupported numeric syntax: %s", (_label, expression) => {
      expect(() =>
        parse(
          `"arc"; function Main() { let n = Num(); n.$set(${expression}); }`,
        ),
      ).toThrow();
    });

    it.each([
      ["missing kind", "{ min: 0 }"],
      ["unknown kind", '{ kind: "decimal" }'],
      ["extra field", '{ kind: "number", step: 1 }'],
      ["inverted bounds", '{ kind: "number", min: 2, max: 1 }'],
      ["fractional integer bound", '{ kind: "integer", min: 0.5 }'],
      ["unsafe integer bound", '{ kind: "integer", max: 9007199254740992 }'],
    ])("rejects a numeric observeAs with %s", (_label, observeAs) => {
      expect(() =>
        parse(
          `"arc"; function Main() { let n = Num({ observeAs: ${observeAs} }); }`,
        ),
      ).toThrow();
    });

    it("rejects invalid RangedInt bounds and arity", () => {
      for (const source of [
        '"arc"; function Main() { let n = RangedInt(1, 0); }',
        '"arc"; function Main() { let n = RangedInt(0.5, 1); }',
        '"arc"; function Main() { let n = RangedInt(0, 9007199254740992); }',
        '"arc"; function Main() { let n = RangedInt(0, 1, {}, 2); }',
      ]) {
        expect(() => parse(source)).toThrow();
      }
    });

    it.each([
      ["string", "`x` + 1"],
      ["boolean", "true * 1"],
      ["null", "null - 1"],
      ["array", "[1] / 1"],
      ["value template", "`value ${1}` + 1"],
      ["comparison", "(1 == 1) + 1"],
      ["logical expression", "(true && false) + 1"],
      ["regex", '/x/.test("x") + 1'],
      ["dialog scope", "Dialog.lastTurns(2) + 1"],
      ["dialog cursor", "Dialog.cursor + 1"],
      ["judgment", "judge(`number`) + 1"],
      ["node state literal", "State.COVERED + 1"],
      ["unset predicate", "n.isUnset() + 1"],
      ["finite predicate", "Num.isFinite(1) + 1"],
      ["known nonnumeric conditional", '(true ? "x" : "y") + 1'],
    ])("statically rejects a known nonnumeric %s operand", (_label, value) => {
      expect(() =>
        parse(`"arc"; function Main() { let n = Num(); n.$set(${value}); }`),
      ).toThrow(/NON_NUMERIC_ARITHMETIC_OPERAND/);
    });

    it("statically diagnoses right and unary nonnumeric arithmetic operands", () => {
      expect(() =>
        parse('"arc"; function Main() { let n = Num(); n.$set(1 + "x"); }'),
      ).toThrow(/NON_NUMERIC_ARITHMETIC_OPERAND/);
      expect(() =>
        parse('"arc"; function Main() { let n = Num(); n.$set(-"x"); }'),
      ).toThrow(/NON_NUMERIC_ARITHMETIC_OPERAND/);
    });

    it("statically rejects a known nonnumeric Num.isFinite argument", () => {
      expect(() =>
        parse(
          `"arc"; function Main() { let b = Bool(); b.$set(Num.isFinite([1 / 0])); }`,
        ),
      ).toThrow(/NON_NUMERIC_IS_FINITE_ARGUMENT/);
    });

    it.each([
      ["direct write", "let n = Num(); n.$set(1e309);"],
      ["array", "let n = Array(Num()); n.$set([1e309]);"],
      ["arithmetic", "let n = Num(); n.$set(1 + 1e309);"],
      [
        "local index",
        "let a = Array(Str()); a.$set([`x`]); a[1e309].$set(`y`);",
      ],
      [
        "local index arithmetic",
        "let a = Array(Str()); a.$set([`x`]); a[0 + 1e309].$set(`y`);",
      ],
      ["value template", "let s = Str(); s.$set(`${1e309}`);"],
      ["semantic template", "$instruct(`${1e309}`);"],
      ["host-call argument", "let n = Num(); n.$set(api.value(1e309));"],
      [
        "nested host-call argument",
        "let n = Num(); n.$set(api.value({ nested: [1e309] }));",
      ],
      ["node host params", "this.hostParams = { nested: [1e309] };"],
      [
        "nested node host params",
        "function Child() { this.hostParams = { nested: [1e309] }; }",
      ],
      [
        "instruction host params",
        "$instruct(`x`, { hostParams: { nested: [1e309] } });",
      ],
      [
        "number observation bound",
        'let n = Num({ observeAs: { kind: "number", max: 1e309 } });',
      ],
      ["ranged shorthand bound", "let n = RangedInt(-1e309, 1);"],
      ["last turns", "let s = Str(); s.$set(Dialog.lastTurns(1e309));"],
    ])(
      "rejects a non-finite numeric literal in %s before IR is returned",
      (_label, body) => {
        let thrown: unknown;
        try {
          parse(`"arc"; function Main() { ${body} }`);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).toMatchObject({
          code: "NON_FINITE_NUMBER",
          message: "Numeric literal must be finite",
          loc: expect.any(Object),
        });
        expect(Object.keys(thrown as object)).toEqual(["code", "loc"]);
        expect(thrown).not.toHaveProperty("reasonCode");
      },
    );

    it("gives parser-wide non-finite diagnostics precedence over contextual signed syntax", () => {
      expect(() =>
        parse(`"arc"; function Main() { this.hostParams = { n: -1e309 }; }`),
      ).toThrow(
        expect.objectContaining({ code: "NON_FINITE_NUMBER" }) as Error,
      );
      expect(() =>
        parse(`"arc"; function Main() { this.hostParams = { n: -1 }; }`),
      ).toThrow(/this\.hostParams only supports literal metadata values/);
      expect(() =>
        parse(
          `"arc"; function Main() { let s = Str(); s.$set(Dialog.lastTurns(-1)); }`,
        ),
      ).toThrow(
        "Dialog.lastTurns() count must be a non-negative safe-integer literal",
      );
      expect(() =>
        parse(
          `"arc"; function Main() { let s = Str(); s.$set(Dialog.lastTurns(1.5)); }`,
        ),
      ).toThrow(
        "Dialog.lastTurns() count must be a non-negative safe-integer literal",
      );
      expect(() =>
        parse(
          `"arc"; function Main() { let s = Str(); s.$set(Dialog.lastTurns(9007199254740992)); }`,
        ),
      ).toThrow(
        "Dialog.lastTurns() count must be a non-negative safe-integer literal",
      );

      const endpoint = parse(
        `"arc"; function Main() { let s = Str(); s.$set(Dialog.lastTurns(9007199254740991)); }`,
      );
      expect(firstStatement(endpoint)).toMatchObject({
        value: { kind: "scope", name: "lastTurns", count: 9007199254740991 },
      });
    });

    it.each([
      ["a.b", '$["a.b"]'],
      ["a[0]", '$["a[0]"]'],
      ["", '$[""]'],
      ['a"b', '$["a\\\"b"]'],
      ["a\\b", '$["a\\\\b"]'],
      ["0", '$["0"]'],
    ])("uses an unambiguous public-IR path for object key %j", (key, path) => {
      const document = parse(`"arc"; function Main() { let n = Num(); }`);
      (document as unknown as Record<string, unknown>)[key] =
        Number.POSITIVE_INFINITY;
      expect(validate(document)).toContainEqual({
        code: "NON_FINITE_NUMBER",
        message: `Document contains a non-finite number at ${path}`,
      });
    });

    it("validates hand-built numeric IR without mutating it", () => {
      const document = parse(`
"arc";
function Main() {
  let n = Num();
  n.$set(1);
}
`);
      const statement = firstStatement(document);
      if (statement.kind !== "set") throw new Error("expected set");
      statement.value = { kind: "literal", value: Number.POSITIVE_INFINITY };

      expect(validate(document)).toContainEqual(
        expect.objectContaining({
          code: "NON_FINITE_NUMBER",
          message: expect.stringContaining(
            '$["roots"][0]["statements"][0]["value"]["value"]',
          ),
        }),
      );
      expect(
        (statement.value as { kind: "literal"; value: number }).value,
      ).toBe(Number.POSITIVE_INFINITY);
      expect(() => new Runtime().add("invalid-ir", document).init()).toThrow(
        /NON_FINITE_NUMBER/,
      );
      expect(
        (statement.value as { kind: "literal"; value: number }).value,
      ).toBe(Number.POSITIVE_INFINITY);
    });

    it("rejects legacy numeric specs and malformed observeAs in public IR", () => {
      const legacy = parse(`"arc"; function Main() { let n = Num(); }`);
      Object.assign(legacy.roots[0]!.cells[0]!, {
        type: "rangedInt",
        min: 0,
        max: 1,
      });
      expect(validate(legacy)).toContainEqual(
        expect.objectContaining({ code: "NON_CANONICAL_NUMERIC_SPEC" }),
      );

      const malformed = parse(`"arc"; function Main() { let n = Num(); }`);
      Object.assign(malformed.roots[0]!.cells[0]!, {
        observeAs: { kind: "integer", min: 0.5, extra: true },
      });
      expect(validate(malformed)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "INVALID_NUMERIC_OBSERVE_AS" }),
        ]),
      );
    });

    it("rejects nonnumeric typed host results before arithmetic consumes them", () => {
      const execute = (source: string, expression: string) => {
        const runtime = new Runtime()
          .add(
            source,
            parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(${expression});
}
`),
          )
          .init();
        const traversal = runtime.newTraversal(arc(source, "Main"));
        traversal.phase = "entered";
        const first = startRun(runtime, [traversal], EMPTY_DIALOG);
        return progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [first.hostCalls[0]!.id]: { status: "resolved", value: "text" },
          },
        });
      };

      expect(
        execute("numeric-dynamic-right", "1 + api.value()").issues,
      ).toContainEqual(
        expect.objectContaining({
          reasonCode: "host-call-result-type",
        }),
      );
      expect(
        execute("numeric-dynamic-unary", "-api.value()").issues,
      ).toContainEqual(
        expect.objectContaining({
          reasonCode: "host-call-result-type",
        }),
      );
    });

    it("rejects malformed public arithmetic operators and local strata", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items.$set(["x"]);
  items[0].$set("y");
}
`);
      const target = document.roots[0]!.statements[1]!;
      if (target.kind !== "set") throw new Error("expected set");
      target.target[1] = {
        kind: "arithmetic",
        op: "+",
        left: { kind: "literal", value: 0 },
        right: {
          id: "bad",
          kind: "host-call",
          module: "x",
          target: [],
          operation: "value",
          arguments: [],
        },
      } as never;
      const value = document.roots[0]!.statements[0]!;
      if (value.kind !== "set") throw new Error("expected set");
      value.value = {
        kind: "arithmetic",
        op: "^" as never,
        left: { kind: "literal", value: 1 },
        right: { kind: "literal", value: 2 },
      };

      expect(validate(document)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "INVALID_ARITHMETIC_OPERATOR" }),
          expect.objectContaining({ code: "INVALID_EXPRESSION_STRATUM" }),
        ]),
      );
    });

    it("validates every canonical numeric public-IR refinement", () => {
      const base = parse(`
"arc";
function Main() {
  let n = Num({ observeAs: { kind: "integer", min: 0, max: 4 } });
  let b = Bool();
  n.$set(1 + 2);
  b.$set(Num.isFinite(n));
}
`);
      const cases: Array<{
        code: string;
        mutate(document: Document): void;
      }> = [
        {
          code: "INVALID_NUMERIC_OBSERVE_AS",
          mutate(document) {
            (
              document.roots[0]!.cells[0]! as {
                observeAs?: { kind: "integer"; min?: number };
              }
            ).observeAs = {
              kind: "integer",
              min: 0.5,
            };
          },
        },
        {
          code: "INVALID_NUMERIC_OBSERVE_AS",
          mutate(document) {
            (
              document.roots[0]!.cells[0]! as {
                observeAs?: { kind: "number"; min?: number; max?: number };
              }
            ).observeAs = {
              kind: "number",
              min: 5,
              max: 4,
            };
          },
        },
        {
          code: "INVALID_COMPARISON_OPERATOR",
          mutate(document) {
            const statement = document.roots[0]!.statements[1]!;
            if (statement.kind !== "set") throw new Error("expected set");
            statement.value = {
              kind: "comparison",
              op: "===" as never,
              left: { kind: "literal", value: 1 },
              right: { kind: "literal", value: 1 },
            };
          },
        },
        {
          code: "INVALID_NUMERIC_UNARY_OPERATOR",
          mutate(document) {
            const statement = document.roots[0]!.statements[0]!;
            if (statement.kind !== "set") throw new Error("expected set");
            statement.value = {
              kind: "numericUnary",
              op: "+" as never,
              argument: { kind: "literal", value: 1 },
            };
          },
        },
        {
          code: "INVALID_NUM_IS_FINITE_EXPRESSION",
          mutate(document) {
            const statement = document.roots[0]!.statements[1]!;
            if (statement.kind !== "set") throw new Error("expected set");
            statement.value = { kind: "numIsFinite" } as never;
          },
        },
        {
          code: "INVALID_DIALOG_LAST_TURNS_COUNT",
          mutate(document) {
            const statement = document.roots[0]!.statements[0]!;
            if (statement.kind !== "set") throw new Error("expected set");
            statement.value = {
              kind: "scope",
              name: "lastTurns",
              count: 1.5,
            } as never;
          },
        },
      ];

      for (const entry of cases) {
        const document = cloneDocument(base);
        entry.mutate(document);
        expect(validate(document), entry.code).toContainEqual(
          expect.objectContaining({ code: entry.code }),
        );
        expect(
          () =>
            new Runtime()
              .add(`numeric-public-ir-${entry.code}`, document)
              .init(),
          entry.code,
        ).toThrow(entry.code);
      }
    });

    it("validates Runtime.add atomically and normalizes only its private clone", () => {
      const valid = parse(`
"arc";
function Main() {
  let n = Num();
  n.$set(1);
}
`);
      const invalid = cloneDocument(valid);
      const invalidStatement = firstStatement(invalid);
      if (invalidStatement.kind !== "set") throw new Error("expected set");
      invalidStatement.value = {
        kind: "literal",
        value: Number.NaN,
      };

      const runtime = new Runtime();
      expect(() => runtime.add("atomic", invalid)).toThrow(/NON_FINITE_NUMBER/);
      expect(
        (invalidStatement.value as { kind: "literal"; value: number }).value,
      ).toBeNaN();

      const negativeZero = cloneDocument(valid);
      const acceptedStatement = firstStatement(negativeZero);
      if (acceptedStatement.kind !== "set") throw new Error("expected set");
      acceptedStatement.value = { kind: "literal", value: -0 };
      expect(validate(negativeZero)).toEqual([]);
      expect(
        Object.is(
          (acceptedStatement.value as { kind: "literal"; value: number }).value,
          -0,
        ),
      ).toBe(true);
      runtime.add("atomic", negativeZero);
      runtime.init();
      expect(
        Object.is(
          (acceptedStatement.value as { kind: "literal"; value: number }).value,
          -0,
        ),
      ).toBe(true);
      const traversal = runtime.newTraversal(arc("atomic", "Main"));
      traversal.phase = "entered";
      const brief = startTerminal(runtime, [traversal], EMPTY_DIALOG);
      expect(Object.is(rootTraversal(brief).cells.n, -0)).toBe(false);
    });

    it("treats channel assignment as directional from Index to Num", () => {
      expect(() =>
        parse(`
"arc";
function Main(args = { at: Index() }) {
  $enter(Child, { args: { n: args.at } });
  function Child(args = { n: Num() }) {}
}
`),
      ).not.toThrow();

      expect(() =>
        parse(`
"arc";
function Main(args = { n: Num() }) {
  $enter(Child, { args: { at: args.n } });
  function Child(args = { at: Index() }) {}
}
`),
      ).toThrow(/ENTER_CHANNEL_INCOMPATIBLE/);
    });

    it("admits arithmetic through comparison in boolean hooks but rejects bare arithmetic", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  this.trigger = () => 1 + 2 > 2;
}
`),
      ).not.toThrow();
      expect(() =>
        parse(`
"arc";
function Main() {
  this.trigger = () => 1 + 2;
}
`),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });
  });

  describe("numeric.arithmetic-runtime", () => {
    it("uses JavaScript-number arithmetic without division truncation", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let exact = Num();
  let fraction = Num();
  let remainder = Num();
  exact.$set(6 / 3);
  fraction.$set(7 / 3);
  remainder.$set(-7 % 3);
}
`,
        "numeric-arithmetic",
      );

      expect(rootTraversal(brief).cells).toMatchObject({
        exact: 2,
        fraction: 7 / 3,
        remainder: -1,
      });
    });

    it("evaluates every arithmetic operator with JavaScript precedence and exact equality", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let precedence = Num();
  let grouped = Num();
  let subtraction = Num();
  let product = Num();
  let half = Bool();
  let decimalExact = Bool();
  let decimalInexact = Bool();
  precedence.$set(1 + 2 * 3);
  grouped.$set((1 + 2) * 3);
  subtraction.$set(5 - -2);
  product.$set(-3 * 4);
  half.$set(1 / 2 == 0.5);
  decimalExact.$set(1 / 10 * 10 == 1);
  decimalInexact.$set(1 / 10 * 3 != 0.3);
}
`,
        "numeric-operators",
      );

      expect(rootTraversal(brief).cells).toMatchObject({
        precedence: 7,
        grouped: 9,
        subtraction: 7,
        product: -12,
        half: true,
        decimalExact: true,
        decimalInexact: true,
      });
    });

    it("exposes raw IEEE-754 invalid results only to arithmetic and Num.isFinite", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let addOverflow = Bool();
  let multiplyOverflow = Bool();
  let dividePositive = Bool();
  let divideNegative = Bool();
  let invalidDivide = Bool();
  let invalidRemainder = Bool();
  let recovered = Bool();
  let subnormal = Bool();
  let negativeZero = Bool();
  addOverflow.$set(Num.isFinite(1e308 + 1e308));
  multiplyOverflow.$set(Num.isFinite(1e308 * 2));
  dividePositive.$set(Num.isFinite(1 / 0));
  divideNegative.$set(Num.isFinite(-1 / 0));
  invalidDivide.$set(Num.isFinite(0 / 0));
  invalidRemainder.$set(Num.isFinite(1 % 0));
  recovered.$set(Num.isFinite(1 / (1e308 * 2)));
  subnormal.$set(Num.isFinite(5e-324));
  if (Num.isFinite(-0)) negativeZero.$set(true);
}
`,
        "numeric-raw-ieee",
      );

      expect(rootTraversal(brief).cells).toMatchObject({
        addOverflow: false,
        multiplyOverflow: false,
        dividePositive: false,
        divideNegative: false,
        invalidDivide: false,
        invalidRemainder: false,
        recovered: true,
        subnormal: true,
        negativeZero: true,
      });
      expect(brief.issues).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reasonCode: "division-by-zero" }),
        ]),
      );
    });

    it("allows Num.isFinite to inspect overflow and a later operation to recover", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let overflowed = Bool();
  let recovered = Num();
  overflowed.$set(Num.isFinite(2 * 1e308));
  recovered.$set(1 / (2 * 1e308));
}
`,
        "numeric-finite",
      );

      expect(rootTraversal(brief).cells.overflowed).toBe(false);
      expect(rootTraversal(brief).cells.recovered).toBe(0);
      expect(rootTraversal(brief).phase).toBe("completed");
    });

    it("keeps unset evaluation and dynamic wrong types distinct", () => {
      const unset = runTerminal(
        `
"arc";
function Main() {
  let n = Num();
  let ok = Bool();
  ok.$set(Num.isFinite(n));
}
`,
        "numeric-unset",
      ).brief;
      expect(unset.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "unset-value" }),
      );

      const arithmeticUnset = runTerminal(
        `
"arc";
function Main() {
  let source = Num();
  let result = Num();
  result.$set(source + 1);
}
`,
        "numeric-arithmetic-unset",
      ).brief;
      expect(arithmeticUnset.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "unset-value" }),
      );

      const runtime = new Runtime()
        .add(
          "numeric-dynamic-type",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.value() + 1);
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-dynamic-type", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      const retried = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: "text" },
        },
      });
      expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
      expect(retried.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "host-call-result-type",
        }),
      );
    });

    it("rejects a nonnumeric typed host result before Num.isFinite consumes it", () => {
      const runtime = new Runtime()
        .add(
          "numeric-dynamic-finite-type",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let ok = Bool();
  ok.$set(Num.isFinite(api.value()));
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-dynamic-finite-type", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      const retried = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: { value: 1 } },
        },
      });
      expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
      expect(retried.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "host-call-result-type",
        }),
      );
    });

    it.each([
      ["boolean", true],
      ["array", [1]],
      ["object", { value: 1 }],
    ])(
      "rejects a typed %s host result before arithmetic consumes it",
      (kind, value) => {
        const source = `numeric-dynamic-arithmetic-${kind}`;
        const runtime = new Runtime()
          .add(
            source,
            parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.value() + 1);
}
`),
          )
          .init();
        const traversal = runtime.newTraversal(arc(source, "Main"));
        traversal.phase = "entered";
        const first = startRun(runtime, [traversal], EMPTY_DIALOG);
        const retried = progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [first.hostCalls[0]!.id]: { status: "resolved", value: value },
          },
        });
        expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
        expect(retried.issues).toContainEqual(
          expect.objectContaining({
            reasonCode: "host-call-result-type",
          }),
        );
      },
    );

    it.each([
      ["string", "text"],
      ["boolean", true],
      ["array", [1]],
    ])(
      "rejects a typed %s host result before Num.isFinite consumes it",
      (kind, value) => {
        const source = `numeric-dynamic-finite-${kind}`;
        const runtime = new Runtime()
          .add(
            source,
            parse(`
"arc";
import api from "host:api";
function Main() {
  let ok = Bool();
  ok.$set(Num.isFinite(api.value()));
}
`),
          )
          .init();
        const traversal = runtime.newTraversal(arc(source, "Main"));
        traversal.phase = "entered";
        const first = startRun(runtime, [traversal], EMPTY_DIALOG);
        const retried = progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [first.hostCalls[0]!.id]: { status: "resolved", value: value },
          },
        });
        expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
        expect(retried.issues).toContainEqual(
          expect.objectContaining({
            reasonCode: "host-call-result-type",
          }),
        );
      },
    );

    it("poisons strict writes and comparisons of non-finite arithmetic", () => {
      const write = runTerminal(
        `
"arc";
function Main() {
  let n = Num();
  n.$set(2 * 1e308);
}
`,
        "numeric-write-overflow",
      ).brief;
      expect(write.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before cell write",
        }),
      );
      expect(rootTraversal(write).cells.n).toBeUndefined();

      const comparison = runTerminal(
        `
"arc";
function Main() {
  let decided = Bool();
  if (2 * 1e308 < 3 * 1e308) decided.$set(true);
}
`,
        "numeric-comparison-overflow",
      ).brief;
      expect(comparison.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before numeric comparison",
        }),
      );
      expect(rootTraversal(comparison).cells.decided).toBeUndefined();

      const nestedComparison = runTerminal(
        `
"arc";
function Main() {
  let decided = Bool();
  decided.$set([1 / 0] == [1]);
}
`,
        "numeric-nested-comparison-overflow",
      ).brief;
      expect(nestedComparison.issues).toContainEqual(
        expect.objectContaining({
          reason:
            "Numeric value must be finite before numeric comparison at $[0]",
        }),
      );
      expect(rootTraversal(nestedComparison).cells.decided).toBeUndefined();
    });

    it.each([
      ["==", "2 * 1e308 == 3 * 1e308"],
      ["!=", "0 / 0 != 0 / 0"],
      ["<", "2 * 1e308 < 3 * 1e308"],
      ["<=", "2 * 1e308 <= 3 * 1e308"],
      [">", "2 * 1e308 > 3 * 1e308"],
      [">=", "2 * 1e308 >= 3 * 1e308"],
    ])(
      "rejects a non-finite operand before %s produces a result",
      (_op, expression) => {
        const brief = runTerminal(
          `
"arc";
function Main() {
  let result = Bool();
  result.$set(${expression});
}
`,
          `numeric-comparison-${_op}`,
        ).brief;
        expect(brief.issues).toContainEqual(
          expect.objectContaining({
            reasonCode: "non-finite-number",
            reason: "Numeric value must be finite before numeric comparison",
          }),
        );
        expect(rootTraversal(brief).cells.result).toBeUndefined();
      },
    );

    it("rejects non-finite values independently at every numeric write boundary", () => {
      const wholeArray = runTerminal(
        `
"arc";
function Main() {
  let values = Array(Num());
  values.$set([1 / 0]);
}
`,
        "numeric-array-write",
      ).brief;
      expect(wholeArray.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before array write at $[0]",
        }),
      );
      expect(rootTraversal(wholeArray).cells.values).toBeUndefined();

      const element = runTerminal(
        `
"arc";
function Main() {
  let values = Array(Num());
  values.$set([1]);
  values[0].$set(1 / 0);
}
`,
        "numeric-array-element-write",
      ).brief;
      expect(element.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before array element write",
        }),
      );
      expect(rootTraversal(element).cells.values).toBeUndefined();

      const span = runTerminal(
        `
"arc";
function Main() {
  let input = Array(Num());
  let output = Array(Num());
  input.$set([1]);
  input.$map(() => span.result.$set(1 / 0), output);
}
`,
        "numeric-span-write",
      ).brief;
      expect(span.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before span result write",
        }),
      );
      expect(rootTraversal(span).cells.output).toBeUndefined();

      const returned = runTerminal(
        `
"arc";
function Main(args = {}, returns = { output: Num() }) {
  this.effects = () => {
    returns.output.$set(1 / 0);
  };
}
`,
        "numeric-return-write",
      ).brief;
      expect(returned.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before return write",
        }),
      );
      expect(
        rootTraversal(returned).enterChannels.stagedReturns.output,
      ).toBeUndefined();
    });

    it("supports local arithmetic in array reads and decorated targets", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let items = Array(Str());
  let chosen = Str();
  items.$set(["a", "b", "c"]);
  chosen.$set(items[(0 + 2) - 1]);
  items[1 + (2 - 1)].$set("z");
}
`,
        "numeric-local-index",
      );
      expect(rootTraversal(brief).cells.chosen).toBe("b");
      expect(rootTraversal(brief).cells.items).toEqual(["a", "b", "z"]);

      expect(() =>
        parse(`
"arc";
import api from "host:api";
function Main() {
  let items = Array(Str());
  items[api.value()].$set("x");
}
`),
      ).toThrow(/Unsupported value expression/);
    });

    it("requires safe integers at every index consumer", () => {
      const read = runTerminal(
        `
"arc";
function Main() {
  let items = Array(Str());
  let chosen = Str();
  items.$set(["a"]);
  chosen.$set(items[9007199254740992]);
}
`,
        "numeric-unsafe-index",
      ).brief;
      expect(read.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "invalid-array-index" }),
      );

      expect(() =>
        parse(`
"arc";
function Main(args = {}, returns = { at: Index() }) {
  this.effects = () => {
    returns.at.$set(9007199254740992);
  };
}
`),
      ).toThrow(/CHANNEL_VALUE_TYPE/);

      const target = runTerminal(
        `
"arc";
function Main() {
  let items = Array(Str());
  items.$set(["a"]);
  items[9007199254740992].$set("b");
}
`,
        "numeric-unsafe-index-target",
      ).brief;
      expect(target.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "invalid-array-index" }),
      );
      expect(rootTraversal(target).cells.items).toBeUndefined();

      const observation = runTerminal(
        `
"arc";
function Main() {
  let items = Array(Str({ observing: "an item" }));
  items.$set(["a"]);
  $observe(items[9007199254740992]);
}
`,
        "numeric-unsafe-index-observation",
      ).brief;
      expect("observations" in observation).toBe(false);
      expect(observation.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "invalid-array-index" }),
      );
    });

    it("normalizes negative zero when it crosses a write boundary", () => {
      const { brief } = runTerminal(
        `
"arc";
function Main() {
  let n = Num();
  n.$set(-0);
}
`,
        "numeric-negative-zero",
      );
      expect(rootTraversal(brief).cells.n).toBe(0);
      expect(Object.is(rootTraversal(brief).cells.n, -0)).toBe(false);
    });

    it("rejects non-finite value and semantic template interpolation before text", () => {
      const value = runTerminal(
        '"arc"; function Main() { let text = Str(); text.$set(`value: ${1 / 0}`); }',
        "numeric-value-template",
      ).brief;
      expect(value.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason:
            "Numeric value must be finite before value-template interpolation",
        }),
      );

      const semantic = runTerminal(
        '"arc"; function Main() { $instruct(`value: ${1 / 0}`); }',
        "numeric-semantic-template",
      ).brief;
      expect(semantic.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason:
            "Numeric value must be finite before semantic-template interpolation",
        }),
      );
      expect("instructions" in semantic).toBe(false);

      const nestedValue = runTerminal(
        '"arc"; function Main() { let text = Str(); text.$set(`value: ${[1 / 0]}`); }',
        "numeric-nested-value-template",
      ).brief;
      expect(nestedValue.issues).toContainEqual(
        expect.objectContaining({
          reason:
            "Numeric value must be finite before value-template interpolation at $[0]",
        }),
      );

      const nestedSemantic = runTerminal(
        '"arc"; function Main() { $instruct(`value: ${[1 / 0]}`); }',
        "numeric-nested-semantic-template",
      ).brief;
      expect(nestedSemantic.issues).toContainEqual(
        expect.objectContaining({
          reason:
            "Numeric value must be finite before semantic-template interpolation at $[0]",
        }),
      );
      expect("instructions" in nestedSemantic).toBe(false);
    });

    it("does not persist a non-finite compound pin while a later operand blocks", () => {
      const runtime = new Runtime()
        .add(
          "numeric-pin-admission",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let decided = Bool();
  decided.$set([1 / 0] == api.values());
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-pin-admission", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);
      expect(containsNonFiniteNumber(first.traversals)).toBe(false);

      const revived = JSON.parse(
        JSON.stringify(first.traversals),
      ) as typeof first.traversals;
      const restarted = new Runtime()
        .add(
          "numeric-pin-admission",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let decided = Bool();
  decided.$set([1 / 0] == api.values());
}
`),
        )
        .init();
      const rebuilt = startRun(restarted, revived, EMPTY_DIALOG);
      expect(rebuilt.hostCalls.map((call) => call.id)).toEqual(
        first.hostCalls.map((call) => call.id),
      );
      expect(containsNonFiniteNumber(rebuilt.traversals)).toBe(false);

      const poisoned = progressTerminal(restarted, rebuilt, {
        move: "proceed",
        hostCalls: {
          [rebuilt.hostCalls[0]!.id]: { status: "resolved", value: [1] },
        },
      });
      expect(poisoned.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "non-finite-number" }),
      );
    });

    it("does not persist scalar overflow before a later host-call suspension", () => {
      const runtime = new Runtime()
        .add(
          "numeric-scalar-pin-admission",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(2 * 1e308 + api.value());
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-scalar-pin-admission", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);
      expect(containsNonFiniteNumber(first.traversals)).toBe(false);

      const poisoned = progressTerminal(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: 1 },
        },
      });
      expect("hostCalls" in poisoned).toBe(false);
      expect(poisoned.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "non-finite-number",
          reason: "Numeric value must be finite before cell write",
        }),
      );
    });

    it.each([
      {
        case: "arithmetic",
        declaration: "let result = Num();",
        expression: "api.left() + api.right()",
        left: "not-a-number" as PayloadValue,
        right: 1 as PayloadValue,
      },
      {
        case: "comparison",
        declaration: "let result = Bool();",
        expression: "api.left() < api.right()",
        left: { invalid: true } as PayloadValue,
        right: 1 as PayloadValue,
      },
    ])(
      "does not pin an invalid typed left result while $case waits on the right",
      ({ case: caseName, declaration, expression, left, right }) => {
        const source = `numeric-replayed-${caseName}`;
        const arcSource = `
"arc";
import api from "host:api";
function Main() {
  ${declaration}
  result.$set(${expression});
}
`;
        const runtime = new Runtime().add(source, parse(arcSource)).init();
        const traversal = runtime.newTraversal(arc(source, "Main"));
        traversal.phase = "entered";

        const first = startRun(runtime, [traversal], EMPTY_DIALOG);
        expect(first.hostCalls).toHaveLength(1);
        const second = progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [first.hostCalls[0]!.id]: { status: "resolved", value: left },
          },
        });
        expect(second.hostCalls).toHaveLength(1);
        expect(second.hostCalls[0]!.id).toBe(first.hostCalls[0]!.id);
        expect(second.issues).toContainEqual(
          expect.objectContaining({ reasonCode: "host-call-result-type" }),
        );

        // Restore after the invalid left result. It never hydrated the pin, so
        // the same left call remains pending with the same identity.
        const restored = JSON.parse(
          JSON.stringify(second.traversals),
        ) as typeof second.traversals;
        const restarted = new Runtime().add(source, parse(arcSource)).init();
        const replayed = startRun(restarted, restored, EMPTY_DIALOG);
        expect(replayed.hostCalls.map((call) => call.id)).toEqual(
          second.hostCalls.map((call) => call.id),
        );

        const rightPending = progressBrief(restarted, replayed, {
          move: "proceed",
          hostCalls: {
            [replayed.hostCalls[0]!.id]: { status: "resolved", value: 1 },
          },
        });
        expect(rightPending.hostCalls).toHaveLength(1);
        const completed = progressTerminal(restarted, rightPending, {
          move: "proceed",
          hostCalls: {
            [rightPending.hostCalls[0]!.id]: {
              status: "resolved",
              value: right,
            },
          },
        });
        expect(rootTraversal(completed).phase).toBe("completed");
      },
    );
  });

  describe("numeric.runtime-api-boundaries", () => {
    it("compiles numeric observation constraints into the existing flat metadata", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let free = Num({ observing: "a value", observeAs: { kind: "number", min: -1, max: 1 } });
  let count = RangedInt(0, 10, { observing: "a count" });
  $observe({ free, count });
}
`,
        "numeric-observation-meta",
      );
      const group = groupObservation(brief.observations[0]);
      expect(group.fields[0]?.meta).toEqual({
        type: "number",
        min: -1,
        max: 1,
      });
      expect(group.fields[1]?.meta).toEqual({
        type: "rangedInt",
        min: 0,
        max: 10,
      });
    });

    it("fills omitted integer bounds and preserves unconstrained number metadata", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let free = Num({ observing: "free" });
  let lower = Num({ observing: "lower", observeAs: { kind: "integer", min: 2 } });
  let upper = Num({ observing: "upper", observeAs: { kind: "integer", max: 8 } });
  $observe({ free, lower, upper });
}
`,
        "numeric-observation-default-bounds",
      );
      const group = groupObservation(brief.observations[0]);
      expect(group.fields.map((field) => field.meta)).toEqual([
        { type: "number" },
        {
          type: "rangedInt",
          min: 2,
          max: Number.MAX_SAFE_INTEGER,
        },
        {
          type: "rangedInt",
          min: Number.MIN_SAFE_INTEGER,
          max: 8,
        },
      ]);
    });

    it("keeps observation bounds out of direct numeric writes and currentValue", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let n = Num({ observing: "a small integer", observeAs: { kind: "integer", min: 0, max: 4 } });
  n.$set(5.5);
  $observe(n);
}
`,
        "numeric-observation-current-outside",
      );
      const observation = singleObservation(brief.observations[0]);
      expect(observation.currentValue).toBe(5.5);
      expect(rootTraversal(brief).cells.n).toBe(5.5);
    });

    it("validates observation constraints and normalizes reported negative zero", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let n = Num({ observing: "a value", observeAs: { kind: "integer", min: 0, max: 4 } });
  $observe(n);
}
`,
        "numeric-observation-report",
      );
      const observation = singleObservation(brief.observations[0]);
      const rejected = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [observation.id]: { status: "resolved", value: 4.5 },
        },
      });
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({
          briefId: observation.id,
          reasonCode: "observation-type",
        }),
      );

      const accepted = progressTerminal(runtime, rejected, {
        move: "proceed",
        observations: {
          [observation.id]: { status: "resolved", value: -0 },
        },
      });
      expect(rootTraversal(accepted).cells.n).toBe(0);
      expect(Object.is(rootTraversal(accepted).cells.n, -0)).toBe(false);
    });

    it("normalizes negative zero in array and grouped observations", () => {
      const arrays = run(
        `
"arc";
function Main() {
  let values = Array(Num({ observing: "values" }));
  $observe(values);
}
`,
        "numeric-array-observation",
      );
      const arrayObservation = singleObservation(arrays.brief.observations[0]);
      const arrayDone = progressTerminal(arrays.runtime, arrays.brief, {
        move: "proceed",
        observations: {
          [arrayObservation.id]: { status: "resolved", value: [-0, 1] },
        },
      });
      expect(rootTraversal(arrayDone).cells.values).toEqual([0, 1]);
      expect(
        Object.is((rootTraversal(arrayDone).cells.values as number[])[0], -0),
      ).toBe(false);

      const grouped = run(
        `
"arc";
function Main() {
  let a = Num({ observing: "a" });
  let b = Num({ observing: "b" });
  $observe({ a, b });
}
`,
        "numeric-group-observation",
      );
      const group = groupObservation(grouped.brief.observations[0]);
      const groupDone = progressTerminal(grouped.runtime, grouped.brief, {
        move: "proceed",
        observations: {
          [group.id]: {
            fields: {
              a: { status: "resolved", value: -0 },
              b: { status: "resolved", value: 2 },
            },
          },
        },
      });
      expect(Object.is(rootTraversal(groupDone).cells.a, -0)).toBe(false);
    });

    it("normalizes a decorated numeric array-element observation", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let values = Array(Num({ observing: "one value" }));
  values.$set([1]);
  $observe(values[0]);
}
`,
        "numeric-array-element-observation",
      );
      const observation = singleObservation(brief.observations[0]);
      const done = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [observation.id]: { status: "resolved", value: -0 },
        },
      });
      const value = (rootTraversal(done).cells.values as number[])[0];
      expect(value).toBe(0);
      expect(Object.is(value, -0)).toBe(false);
    });

    it("keeps grouped numeric observation validation atomic", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let a = Num({ observing: "a" });
  let b = Num({ observing: "b" });
  $observe({ a, b });
}
`,
        "numeric-atomic-group-observation",
      );
      const group = groupObservation(brief.observations[0]);
      const rejected = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [group.id]: {
            fields: {
              a: { status: "resolved", value: -0 },
              b: { status: "resolved", value: Number.NaN },
            },
          },
        },
      });
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({
          kind: "invalid-item",
          briefId: group.id,
          reasonCode: "observation-type",
        }),
      );
      expect(rootTraversal(rejected).cells.a).toBeUndefined();
      expect(rootTraversal(rejected).cells.b).toBeUndefined();
      expect(rejected.observations).toHaveLength(1);

      const accepted = progressTerminal(runtime, rejected, {
        move: "proceed",
        observations: {
          [group.id]: {
            fields: {
              a: { status: "resolved", value: -0 },
              b: { status: "resolved", value: 2 },
            },
          },
        },
      });
      expect(Object.is(rootTraversal(accepted).cells.a, -0)).toBe(false);
      expect(rootTraversal(accepted).cells.b).toBe(2);
    });

    it("rejects non-finite and unsafe integer observations without poisoning", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let n = Num({ observing: "a safe integer", observeAs: { kind: "integer" } });
  $observe(n);
}
`,
        "numeric-invalid-observation-values",
      );
      const observation = singleObservation(brief.observations[0]);

      for (const value of [Number.POSITIVE_INFINITY, 9007199254740992]) {
        const rejected = progressBrief(runtime, brief, {
          move: "proceed",
          observations: {
            [observation.id]: { status: "resolved", value },
          },
        });
        expect(rejected.issues).toContainEqual(
          expect.objectContaining({
            kind: "invalid-item",
            briefId: observation.id,
            reasonCode: "observation-type",
          }),
        );
        expect(rejected.observations).toHaveLength(1);
        expect(rootTraversal(rejected).phase).not.toBe("poisoned");
      }
    });

    it("rejects and re-emits a recursively non-finite host-call result", () => {
      const runtime = new Runtime()
        .add(
          "numeric-host-result",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.value());
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-host-result", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      const id = first.hostCalls[0]!.id;
      const rejected = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [id]: {
            status: "resolved",
            value: { nested: [1, Number.POSITIVE_INFINITY] },
          },
        },
      });
      expect(rejected.issues).toContainEqual({
        kind: "invalid-item",
        briefId: id,
        reasonCode: "host-call-non-finite-number",
        reason: `Invalid host call result for ${id}: non-finite number at $["nested"][1]`,
      });
      expect(rejected.hostCalls.map((call) => call.id)).toEqual([id]);

      const accepted = progressTerminal(runtime, rejected, {
        move: "proceed",
        hostCalls: { [id]: { status: "resolved", value: -0 } },
      });
      expect(rootTraversal(accepted).cells.n).toBe(0);
      expect(Object.is(rootTraversal(accepted).cells.n, -0)).toBe(false);
    });

    it("recursively normalizes accepted host results without mutating the report", () => {
      const runtime = new Runtime()
        .add(
          "numeric-host-result-negative-zero",
          parse(`
"arc";
import api from "host:api";
function Main() {
  let values = Array(Num());
  values.$set(api.values());
}
`),
        )
        .init();
      const traversal = runtime.newTraversal(
        arc("numeric-host-result-negative-zero", "Main"),
      );
      traversal.phase = "entered";
      const first = startRun(runtime, [traversal], EMPTY_DIALOG);
      const reportValue = [-0, 1];
      const accepted = progressTerminal(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: reportValue },
        },
      });
      expect(Object.is(reportValue[0], -0)).toBe(true);
      const stored = rootTraversal(accepted).cells.values as number[];
      expect(stored).toEqual([0, 1]);
      expect(Object.is(stored[0], -0)).toBe(false);
    });

    it.each([
      ["a.b", '$["a.b"]'],
      ["a[0]", '$["a[0]"]'],
      ["", '$[""]'],
      ['a"b', '$["a\\\"b"]'],
      ["a\\b", '$["a\\\\b"]'],
      ["0", '$["0"]'],
    ])(
      "uses an unambiguous host-result path for object key %j",
      (key, path) => {
        const runtime = new Runtime()
          .add(
            `numeric-host-result-path-${path}`,
            parse(`
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.value());
}
`),
          )
          .init();
        const source = `numeric-host-result-path-${path}`;
        const traversal = runtime.newTraversal(arc(source, "Main"));
        traversal.phase = "entered";
        const first = startRun(runtime, [traversal], EMPTY_DIALOG);
        const id = first.hostCalls[0]!.id;
        const rejected = progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [id]: {
              status: "resolved",
              value: { [key]: Number.NaN } as unknown as PayloadValue,
            },
          },
        });
        expect(rejected.issues).toContainEqual(
          expect.objectContaining({
            briefId: id,
            reasonCode: "host-call-non-finite-number",
            reason: `Invalid host call result for ${id}: non-finite number at ${path}`,
          }),
        );
      },
    );

    it("sanitizes trigger host-call results before they can choose a match", () => {
      const runtime = new Runtime()
        .add(
          "numeric-trigger-host-result",
          parse(`
"arc";
import api from "host:api";
function Main() {
  this.trigger = () => Num.isFinite(api.value());
}
`),
        )
        .init();
      const first = startTrigger(runtime, EMPTY_DIALOG);
      const id = first.hostCalls[0]!.id;
      const rejected = runtime.progressTrigger(
        first,
        {
          hostCalls: {
            [id]: { status: "resolved", value: Number.NEGATIVE_INFINITY },
          },
        },
        EMPTY_DIALOG,
      );
      expect(rejected.matched).toBeUndefined();
      expect(rejected.hostCalls.map((call) => call.id)).toEqual([id]);
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({
          kind: "invalid-item",
          briefId: id,
          reasonCode: "host-call-non-finite-number",
        }),
      );
    });

    it("rejects non-finite outgoing host-call arguments without emission", () => {
      const { brief } = runTerminal(
        `
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.number(1 / 0));
}
`,
        "numeric-host-argument",
      );
      expect("hostCalls" in brief).toBe(false);
      expect(brief.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "invalid-host-argument",
          reason: "Invalid host argument at $[0]: A finite number is required",
        }),
      );

      const nested = runTerminal(
        `
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.numbers([1 / 0]));
}
`,
        "numeric-nested-host-argument",
      ).brief;
      expect("hostCalls" in nested).toBe(false);
      expect(nested.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "invalid-host-argument",
          reason:
            "Invalid host argument at $[0][0]: A finite number is required",
        }),
      );
    });

    it("normalizes negative zero in outgoing host-call arguments", () => {
      const { brief } = run(
        `
"arc";
import api from "host:api";
function Main() {
  let n = Num();
  n.$set(api.number(0 * -1));
}
`,
        "numeric-host-argument-negative-zero",
      );
      expect(brief.hostCalls).toHaveLength(1);
      expect(brief.hostCalls[0]!.arguments).toEqual([0]);
      expect(Object.is(brief.hostCalls[0]!.arguments[0], -0)).toBe(false);
    });

    it("rejects a nested non-finite host-call payload before emission", () => {
      const { brief } = runTerminal(
        `
"arc";
import api from "host:api";
function Main() {
  this.effects = () => {
    api.$apply([1 / 0]);
  };
}
`,
        "numeric-host-call",
      );
      expect("hostCalls" in brief).toBe(false);
      expect(brief.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "invalid-host-argument",
          reason:
            "Invalid host argument at $[0][0]: A finite number is required",
        }),
      );

      const normalized = run(
        `
"arc";
import api from "host:api";
function Main() {
  this.effects = () => {
    api.$apply([0 * -1]);
  };
}
`,
        "numeric-host-call-negative-zero",
      ).brief;
      expect(normalized.hostCalls).toHaveLength(1);
      const argument = normalized.hostCalls[0]!.arguments[0] as number[];
      expect(argument[0]).toBe(0);
      expect(Object.is(argument[0], -0)).toBe(false);
    });
  });
});
