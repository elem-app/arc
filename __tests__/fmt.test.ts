import { describe, expect, it } from "vitest";

import { hmd } from "../src/host-utils/index.js";
import { parse, validate } from "../src/parser/index.js";
import {
  cloneValueExpression,
  normalizeValueExpression,
} from "../src/runtime/state.js";
import { checkFmtEvidence } from "../src/spec/fmt.js";
import { fmtRule, type ProducerEvidence } from "../src/spec/resolution.js";
import type {
  FmtConfig,
  FmtExpression,
  HostModuleSpec,
} from "../src/types/index.js";
import {
  actionTerminal,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  rootTraversal,
  TestRuntime as Runtime,
  startRun,
  startTerminal,
} from "./helpers.js";

const source = "fmt-tests";
const dynamic: ProducerEvidence = { kind: "dynamic" };

function setup(
  body: string,
  imports = "",
  hostModules?: ReadonlyMap<string, HostModuleSpec>,
) {
  const document = parse(`"arc"; ${imports} function Main() { ${body} }`);
  const runtime = new Runtime({ hostModules }).add(source, document).init();
  const seeded = runtime.newTraversal(arc(source, "Main"));
  seeded.phase = "entered";
  return { document, runtime, seeded };
}

function evaluate(expression: string, preparation = "") {
  const { runtime, seeded } = setup(
    `let result = Str(); ${preparation} result.$set(${expression});`,
  );
  return startTerminal(runtime, [seeded], EMPTY_DIALOG);
}

function result(expression: string, preparation = "") {
  const terminal = evaluate(expression, preparation);
  expect(rootTraversal(terminal).phase).toBe("completed");
  return rootTraversal(terminal).cells.result;
}

const people =
  'let people = Array(Struct({ name: Str() })); people.$set([{ name: "Ada" }, { name: "Grace" }]);';

describe("value formatting", () => {
  it.each(["fmt()", "fmt(...[])", 'fmt("a", {}, {})', 'fmt(...["a"], {})'])(
    "fmt.syntax rejects invalid arguments %s",
    (expression) => {
      expect(() =>
        setup(`let result = Str(); result.$set(${expression});`),
      ).toThrow(/Invalid fmt arguments/);
    },
  );

  it("fmt.syntax reserves the built-in name across source and public Documents", () => {
    for (const body of [
      "function fmt() {}",
      "function Main() { let fmt = Str(); }",
      'import fmt from "host:renderer"; function Main() {}',
      'import { Render as fmt } from "./renderer.arc"; function Main() {}',
    ]) {
      expect(() => parse(`"arc"; ${body}`)).toThrow(/reserved/);
    }
    const documents = [
      parse('"arc"; function Main() {}'),
      parse('"arc"; function Main() { let item = Str(); }'),
      parse('"arc"; import Renderer from "host:renderer"; function Main() {}'),
      parse(
        '"arc"; import { Render as Renderer } from "./renderer.arc"; function Main() {}',
      ),
    ];
    documents[0]!.roots[0]!.identifier = "fmt";
    documents[1]!.roots[0]!.cells[0]!.name = "fmt";
    documents[2]!.hostModules[0]!.localName = "fmt";
    documents[3]!.imports[0]!.localName = "fmt";
    for (const document of documents) {
      for (const candidate of [
        document,
        JSON.parse(JSON.stringify(document)),
      ]) {
        expect(validate(candidate)).toContainEqual(
          expect.objectContaining({
            message: expect.stringMatching(/reserved/),
          }),
        );
        expect(() => new Runtime().add(source, candidate)).toThrow(/reserved/);
      }
    }
  });

  it("fmt.syntax accepts channels named fmt", () => {
    const document = parse(`"arc";
      function Main(args = { fmt: Str() }, returns = { fmt: Str() }) {
        this.effects = () => { returns.fmt.$set(fmt(args.fmt)); };
      }`);
    const runtime = new Runtime().add(source, document).init();
    const terminal = actionTerminal(
      runtime.enterArc(arc(source, "Main"), EMPTY_DIALOG, {
        args: { fmt: "hello" },
      }),
    );
    expect(rootTraversal(terminal).phase).toBe("completed");
    expect(terminal.returns).toEqual({ fmt: "hello" });
  });

  it("fmt.authority defers unknown alternatives and admits disjoint refined records", () => {
    const artifact: ProducerEvidence = {
      kind: "fact",
      fact: { kind: "provenance", provenance: "artifact" },
    };
    expect(
      checkFmtEvidence({
        kind: "alternatives",
        alternatives: [artifact, dynamic],
      }),
    ).toEqual({ kind: "unknown" });
    const alternatives: ProducerEvidence = {
      kind: "alternatives",
      alternatives: [
        {
          kind: "struct",
          fields: {
            tag: {
              kind: "fact",
              fact: { kind: "provenance", provenance: "index" },
            },
            file: artifact,
          },
        },
        {
          kind: "struct",
          fields: {
            tag: { kind: "fact", fact: { kind: "literal", value: -1 } },
            file: {
              kind: "struct",
              fields: {
                path: {
                  kind: "fact",
                  fact: { kind: "carrier", carrier: "string" },
                },
              },
            },
          },
        },
      ],
    };
    expect(checkFmtEvidence(alternatives)).toEqual({
      kind: "compatible",
    });
    expect(
      fmtRule.projectValue(
        alternatives,
        { tag: 0, file: { path: "a.md" } },
        {},
      ),
    ).toEqual({ admitted: true, value: '{"tag":0,"file":"a.md"}' });
    expect(
      fmtRule.projectValue(
        alternatives,
        { tag: -1, file: { path: "a.md" } },
        {},
      ),
    ).toEqual({ admitted: true, value: '{"tag":-1,"file":{"path":"a.md"}}' });
    const struct: ProducerEvidence = {
      kind: "fact",
      fact: {
        kind: "site",
        spec: { type: "struct", fields: { name: { type: "string" } } },
      },
    };
    expect(fmtRule.projectValue(struct, {}, {})).toMatchObject({
      admitted: false,
      violation: { detail: 'Missing Struct field at $["name"]' },
    });
    expect(
      fmtRule.projectValue(struct, { name: "Ada", extra: true }, {}),
    ).toMatchObject({
      admitted: false,
      violation: { detail: 'Undeclared Struct field at $["extra"]' },
    });
  });
  it("fmt.json never invokes inherited conversion hooks", () => {
    let called = false;
    for (const prototype of [Object.prototype, Array.prototype]) {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let actual;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          value() {
            called = true;
            return "unexpected";
          },
        });
        actual = fmtRule.projectValue(
          dynamic,
          [{ name: "Ada", tags: ["math"] }],
          { array: { style: "json" } },
        );
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(called).toBe(false);
      expect(actual).toEqual({
        admitted: true,
        value: '[{"name":"Ada","tags":["math"]}]',
      });
    }
  });
  it("fmt.context emits plain Artifact text and supports formatted observation questions", () => {
    const { runtime, seeded } = setup(
      'let file = Artifact("a.md"); let answer = Str({ observing: `question ${fmt(file, { str: "json" })}` }); $instruct(`${user}: ${fmt(file)}`); $observe(answer);',
    );
    const first = startRun(runtime, [seeded], EMPTY_DIALOG);
    expect(first.instructions[0]?.text).toEqual([
      { kind: "entity", name: "user" },
      { kind: "text", value: ": a.md" },
    ]);
    const next = progressBrief(runtime, first, {
      move: "proceed",
      instructions: appliedInstructions(first),
    });
    expect(next.observations[0]).toMatchObject({ question: 'question "a.md"' });
  });

  it("fmt.host formats a declared Struct result and a judgment result", () => {
    const modules = new Map([
      ["people", hmd.define({ get: () => hmd.Struct({ name: hmd.Str() }) })],
    ]);
    const { runtime, seeded } = setup(
      "let result = Str(); result.$set(fmt(People.get()));",
      'import People from "host:people";',
      modules,
    );
    const first = startRun(runtime, [seeded], EMPTY_DIALOG);
    const terminal = progressTerminal(runtime, first, {
      move: "proceed",
      hostCalls: {
        [first.hostCalls[0]!.id]: {
          status: "resolved",
          value: { name: "Ada" },
        },
      },
    });
    expect(rootTraversal(terminal).cells.result).toBe('{"name":"Ada"}');
    const judgment = setup(
      "let result = Str(); result.$set(fmt(judge(`ready`)));",
    );
    const pending = startRun(judgment.runtime, [judgment.seeded], EMPTY_DIALOG);
    const done = progressTerminal(judgment.runtime, pending, {
      move: "proceed",
      judgments: { [pending.judgments[0]!.id]: true },
    });
    expect(rootTraversal(done).cells.result).toBe("true");
  });

  it("fmt.failure emits no consuming instruction or host call after admission fails", () => {
    for (const body of [
      "$instruct(`${fmt(1 / 0)}`);",
      "Writer.$save(fmt(1 / 0));",
    ]) {
      const { runtime, seeded } = setup(
        body,
        'import Writer from "host:writer";',
      );
      const terminal = startTerminal(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(terminal).phase).toBe("poisoned");
      expect(terminal.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "non-finite-number" }),
      );
      expect("instructions" in terminal).toBe(false);
      expect("hostCalls" in terminal).toBe(false);
    }
  });

  it.each([
    ['fmt("")', ""],
    ['fmt("Ada")', "Ada"],
    ['fmt("Ada", {})', "Ada"],
    ["fmt(true)", "true"],
    ["fmt(false)", "false"],
    ["fmt(1.25)", "1.25"],
    ["fmt(-0)", "0"],
    ["fmt(5 / 2)", "2.5"],
    ["fmt([])", ""],
    ['fmt([], { array: { style: "json" } })', "[]"],
    ["fmt({})", "{}"],
    ['fmt(["a"])', "a"],
    ['fmt(["a", "b"])', "a, b"],
    ['fmt(["a", "b"], { str: "json" })', '"a", "b"'],
    ['fmt([1, false, "a"])', "1, false, a"],
  ])("fmt.defaults renders %s", (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });

  it.each(["", "[]", "()", "{}"])(
    "fmt.layout supports delimiters %j",
    (parentheses) => {
      const config = JSON.stringify({
        array: { separator: " / ", parentheses },
      });
      expect(result(`fmt([1, 2], ${config})`)).toBe(
        `${parentheses[0] ?? ""}1 / 2${parentheses[1] ?? ""}`,
      );
      expect(result(`fmt([], ${config})`)).toBe(parentheses);
    },
  );

  it("fmt.subtree renders the authored Array Struct instruction and JSON override", () => {
    const { runtime, seeded } = setup(`${people}
      $instruct(\`explain \${fmt(people, { array: { separator: ", ", parentheses: "[]" }, struct: { style: "json" }, str: "bare" })}\`);
      $instruct(\`json \${fmt(people, { str: "bare", array: { style: "json" } })}\`);
      $instruct(\`default \${fmt(people)}\`);`);
    let brief = startRun(runtime, [seeded], EMPTY_DIALOG);
    const texts = [brief.instructions[0]?.text];
    for (let index = 0; index < 2; index++) {
      brief = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      texts.push(brief.instructions[0]?.text);
    }
    expect(texts).toEqual([
      'explain [{"name":"Ada"}, {"name":"Grace"}]',
      'json [{"name":"Ada"},{"name":"Grace"}]',
      'default {"name":"Ada"}, {"name":"Grace"}',
    ]);
  });

  it("fmt.subtree JSON Struct overrides nested array layout and string modes", () => {
    const text = result(
      'fmt({ name: "Ada", tags: ["math", "logic"], nested: { ready: true } }, { array: { separator: " / ", parentheses: "()" }, str: "bare" })',
    );
    expect(text).toBe(
      '{"name":"Ada","tags":["math","logic"],"nested":{"ready":true}}',
    );
    expect(JSON.parse(text as string)).toEqual({
      name: "Ada",
      tags: ["math", "logic"],
      nested: { ready: true },
    });
    expect(
      result(
        'fmt([["a", "b"], { names: ["c"] }], { str: "bare", array: { style: "json" } })',
      ),
    ).toBe('[["a","b"],{"names":["c"]}]');
  });

  it("fmt.json escapes strings and preserves evaluated nested record order", () => {
    const value = 'quote" slash/ backslash\\\n\t\u0000 😀 \ud800';
    const encoded = result(`fmt(${JSON.stringify(value)}, { str: "json" })`);
    expect(JSON.parse(encoded as string)).toBe(value);
    const text = result(
      'fmt({ "10": "ten", "2": "two", z: { b: 2, a: 1 }, a: -0 })',
    );
    expect(text).toBe('{"2":"two","10":"ten","z":{"b":2,"a":1},"a":0}');
    const record =
      "let item = Struct({ a: Num(), b: Num() }); item.$set({ b: 2, a: 1 });";
    expect(result("fmt(item)", record)).toBe('{"b":2,"a":1}');
  });

  it("fmt.nesting applies fresh config and one JSON encoding layer per call", () => {
    const original = '{"name":"Ada"}';
    expect(result('fmt(fmt({ name: "Ada" }), { str: "bare" })')).toBe(original);
    expect(result('fmt(fmt({ name: "Ada" }), { str: "json" })')).toBe(
      JSON.stringify(original),
    );
    expect(
      result(
        'fmt(fmt(fmt({ name: "Ada" }), { str: "json" }), { str: "json" })',
      ),
    ).toBe(JSON.stringify(JSON.stringify(original)));
    expect(result('fmt(fmt("a", { str: "json" }))')).toBe('"a"');
    expect(
      result('fmt([fmt({ name: "Ada" })], { array: { style: "json" } })'),
    ).toBe('["{\\"name\\":\\"Ada\\"}"]');
  });

  it("fmt.inputs supports typed scalar cells fields indexed fields and fmt names", () => {
    expect(
      result(
        "fmt(items[i])",
        'let items = Array(Struct({ fmt: Str() })); let i = Num(); i.$set(0); items.$set([{ fmt: "json" }]);',
      ),
    ).toBe('{"fmt":"json"}');
    expect(
      result(
        "fmt(item.fmt)",
        'let item = Struct({ fmt: Str() }); item.$set({ fmt: "json" });',
      ),
    ).toBe("json");
    expect(
      result(
        "fmt(item)",
        'let item = Struct({ fmt: Str() }); item.$set({ fmt: "json" });',
      ),
    ).toBe('{"fmt":"json"}');
    expect(
      result(
        "fmt(value)",
        'let value = Enum(["cold", "warm"]); value.$set("warm");',
      ),
    ).toBe("warm");
    expect(
      result("fmt(value)", "let value = RangedInt(1, 5); value.$set(2.5);"),
    ).toBe("2.5");
    expect(result("fmt(true ? 3 : { a: 1 })")).toBe("3");
    expect(result("fmt(false ? 3 : { a: 1 })")).toBe('{"a":1}');
  });

  it("fmt.inputs supports map items indices channels returns and Artifact paths", () => {
    const document = parse(`"arc";
      function Main(args = { input: Struct({ name: Str() }), index: Index() }, returns = { output: Str() }) {
        let people = Array(Struct({ name: Str() }));
        let rendered = Array(Str());
        let path = Artifact(fmt(args.input.name));
        let output = Str();
        this.effects = () => {
          returns.output.$set(\`\${fmt(rendered)} / \${fmt(args.index)} / \${fmt(path)}\`);
          output.$set(fmt(returns.output));
        };
        people.$set([args.input]);
        people.$map(() => { span.result.$set(\`\${fmt(span.index)}:\${fmt(span.item)}\`); }, rendered);

      }`);
    const runtime = new Runtime().add(source, document).init();
    const brief = runtime.enterArc(arc(source, "Main"), EMPTY_DIALOG, {
      args: { input: { name: "Ada" }, index: 2 },
    });
    expect(rootTraversal(brief).cells.output).toBe(
      '0:{"name":"Ada"} / 2 / Ada',
    );
  });

  it("fmt.authority projects Artifacts and retains ordinary path records", () => {
    expect(result('fmt(Artifact("a.md"))')).toBe("a.md");
    expect(result('fmt(Artifact("a.md"), { str: "json" })')).toBe('"a.md"');
    expect(result('fmt({ path: "a.md" })')).toBe('{"path":"a.md"}');
    expect(
      result(
        'fmt([Artifact("a.md"), Artifact("b.md")], { array: { style: "json" } })',
      ),
    ).toBe('["a.md","b.md"]');
    expect(result('fmt({ file: Artifact("a.md") })')).toBe('{"file":"a.md"}');
    expect(
      result(
        "fmt(files)",
        'let files = Array(Artifact()); files.$set([Artifact("a.md"), Artifact("b.md")]);',
      ),
    ).toBe("a.md, b.md");
    expect(
      fmtRule.projectValue(dynamic, { path: "a.md", user: 1, self: 2 }, {}),
    ).toEqual({ admitted: true, value: '{"path":"a.md","user":1,"self":2}' });
  });

  it.each([
    'fmt(true ? Artifact("a.md") : { path: "a.md" })',
    'fmt(true ? [Artifact("a.md")] : [{ path: "a.md" }])',
    'fmt({ file: true ? Artifact("a.md") : { path: "a.md" } })',
    'fmt(true ? { file: Artifact("a.md") } : { file: { path: "a.md" } })',
    "fmt(Dialog.cursor)",
    "fmt(null)",
  ])("fmt.authority rejects incompatible operand %s", (expression) => {
    expect(() =>
      parse(
        `"arc"; function Main() { let text = Str(); text.$set(${expression}); }`,
      ),
    ).toThrow(/INVALID_FMT_OPERAND/);
  });

  it("fmt.authority accepts disjoint and identical conditional interpretations", () => {
    expect(result('fmt(true ? Artifact("a.md") : { path: 3 })')).toBe("a.md");
    expect(result('fmt(true ? Artifact("a.md") : Artifact("b.md"))')).toBe(
      "a.md",
    );
    expect(
      result('fmt(false ? fmt(Artifact("a.md")) : fmt({ path: "a.md" }))'),
    ).toBe('{"path":"a.md"}');
    expect(
      result(
        'fmt(true ? { tag: "file", value: Artifact("a.md") } : { tag: "record", value: { path: "a.md" } })',
      ),
    ).toBe('{"tag":"file","value":"a.md"}');
  });

  it.each([
    "null",
    '"json"',
    '{ str: "quoted" }',
    '{ unknown: "x" }',
    '{ array: { unknown: "x" } }',
    '{ array: { parentheses: "<>" } }',
    "{ array: { separator: 3 } }",
    '{ array: { style: "json", separator: "," } }',
    '{ struct: { style: "bare" } }',
    '{ array: { style: "json" }, str: "invalid" }',
    '{ str: "bare", str: "json" }',
    '{ ["str"]: "bare" }',
    "{ str }",
    "{ ...{} }",
    '{ get str() { return "bare"; } }',
    "{ str() {} }",
    '{ str: (true ? "bare" : "json") }',
    "{ str: `bare` }",
    "...[]",
  ])("fmt.config rejects static configuration %s", (config) => {
    expect(() =>
      parse(
        `"arc"; function Main() { let text = Str(); text.$set(fmt("a", ${config})); }`,
      ),
    ).toThrow(/Invalid fmt configuration/);
  });

  it("fmt.config accepts literal keys and ignores config property order", () => {
    expect(
      result(
        'fmt(["a", "b"], { "str": "json", "array": { "parentheses": "[]" } })',
      ),
    ).toBe('["a", "b"]');
    expect(
      result(
        'fmt([{ name: "Ada" }], { str: "bare", struct: {}, array: { style: "json" } })',
      ),
    ).toBe(
      result(
        'fmt([{ name: "Ada" }], { array: { style: "json" }, struct: {}, str: "bare" })',
      ),
    );
  });

  it.each([
    "$instruct(`${fmt(API.value())}`);",
    "$instruct(`${fmt(judge(`x`))}`);",
    'let xs = Array(Str()); xs.$set(["a"]); xs[fmt(0)].$set("b");',
    'let text = Str(); text.$set(fmt(/a/.test(fmt("a"))));',
    'let flag = Bool(); flag.$set(fmt("a"));',
    "if (fmt(true)) { $instruct(`x`); }",
  ])(
    "fmt.context rejects expression outside its owning contract %s",
    (body) => {
      expect(() =>
        parse(`"arc"; import API from "host:api"; function Main() { ${body} }`),
      ).toThrow();
    },
  );

  it("fmt.host preserves host fmt operations and formats resumed result strings", () => {
    const modules = new Map([
      [
        "renderer",
        hmd.define({
          fmt: (value = hmd.Str()) => hmd.Str(),
          accept: (value = hmd.Str()) => {},
        }),
      ],
    ]);
    const { runtime, seeded } = setup(
      'let result = Str(); result.$set(fmt(Renderer.fmt("hello"), { str: "json" })); Renderer.$accept(fmt(result));',
      'import Renderer from "host:renderer";',
      modules,
    );
    const first = startRun(runtime, [seeded], EMPTY_DIALOG);
    expect(first.hostCalls[0]).toMatchObject({
      module: "renderer",
      operation: "fmt",
      arguments: ["hello"],
    });
    const next = progressBrief(runtime, first, {
      move: "proceed",
      hostCalls: {
        [first.hostCalls[0]!.id]: { status: "resolved", value: 'a"b' },
      },
    });
    expect(rootTraversal(next).cells.result).toBe('"a\\"b"');
    expect(next.hostCalls[0]).toMatchObject({
      operation: "accept",
      arguments: ['"a\\"b"'],
    });
  });

  it("fmt.failure poisons unset and nonfinite inputs without writing destination", () => {
    for (const [expression, preparation, code] of [
      ["fmt(missing)", "let missing = Str();", "unset-value"],
      ["fmt(1 / 0)", "", "non-finite-number"],
      ["fmt({ nested: [1, 0 / 0] })", "", "non-finite-number"],
    ]) {
      const { runtime, seeded } = setup(
        `let result = Str(); ${preparation} result.$set(${expression});`,
      );
      seeded.cells.result = "before";
      const terminal = startTerminal(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(terminal).phase).toBe("poisoned");
      expect(rootTraversal(terminal).cells.result).toBe("before");
      expect(terminal.issues).toContainEqual(
        expect.objectContaining({ reasonCode: code }),
      );
    }
  });

  it("fmt.failure validates dynamic carriers refinements and nominal ambiguity", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let called = false;
    const accessor = Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        called = true;
        return "x";
      },
    });
    for (const value of [
      null,
      { a: undefined },
      [undefined],
      Array(1),
      new Date(),
      accessor,
      cycle,
      {
        toJSON() {
          called = true;
          return "x";
        },
      },
    ]) {
      expect(fmtRule.projectValue(dynamic, value, {})).toMatchObject({
        admitted: false,
        violation: { code: "invalid-fmt-value" },
      });
    }
    expect(called).toBe(false);
    expect(
      fmtRule.projectValue(dynamic, { scores: [1, Infinity] }, {}),
    ).toMatchObject({
      admitted: false,
      violation: {
        code: "non-finite-number",
        detail:
          'Numeric value must be finite before formatting at $["scores"][1]',
      },
    });
    const enumEvidence: ProducerEvidence = {
      kind: "fact",
      fact: { kind: "site", spec: { type: "enum", values: ["ok"] } },
    };
    expect(fmtRule.projectValue(enumEvidence, "bad", {})).toMatchObject({
      admitted: false,
    });
    const artifact: ProducerEvidence = {
      kind: "fact",
      fact: { kind: "provenance", provenance: "artifact" },
    };
    expect(
      fmtRule.projectValue(artifact, { path: "../bad" }, {}),
    ).toMatchObject({ admitted: false });
    expect(
      fmtRule.projectValue(
        { kind: "alternatives", alternatives: [artifact, dynamic] },
        { path: "a.md" },
        {},
      ),
    ).toMatchObject({
      admitted: false,
      violation: { detail: "Ambiguous formatting authority at $" },
    });
  });

  it("fmt.isolation clones config and normalizes equivalent defaults", () => {
    const expression: FmtExpression = {
      kind: "fmt",
      value: { kind: "literal", value: "a" },
      config: {},
    };
    const explicit: FmtConfig = {
      str: "bare",
      struct: { style: "json" },
      array: { separator: ", ", parentheses: "" },
    };
    expect(normalizeValueExpression(expression)).toEqual(
      normalizeValueExpression({ ...expression, config: explicit }),
    );
    expect(normalizeValueExpression(expression)).not.toEqual(
      normalizeValueExpression({ ...expression, config: { str: "json" } }),
    );
    const clone = cloneValueExpression({ ...expression, config: explicit });
    explicit.str = "json";
    expect(clone).toMatchObject({ config: { str: "bare" } });
    const { document, runtime, seeded } = setup(
      'let text = Str(); text.$set(fmt(["a", "b"], { array: { parentheses: "[]" } }));',
    );
    const statement = document.roots[0]!.statements[0]!;
    if (statement.kind !== "set" || statement.value.kind !== "fmt")
      throw new Error("expected fmt write");
    statement.value.config.array = { parentheses: "()", separator: "/" };
    expect(
      rootTraversal(startTerminal(runtime, [seeded], EMPTY_DIALOG)).cells.text,
    ).toBe("[a, b]");
  });
});
