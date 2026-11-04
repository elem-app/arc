import { describe, expect, it } from "vitest";
import { hmd } from "../src/host-utils/index.js";
import { parse, validate } from "../src/parser/index.js";
import {
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import { admitHostArgument } from "../src/spec/resolution.js";
import { validateHostModuleSpec } from "../src/spec/validation.js";
import type {
  ArcTraversalSet,
  Document,
  HostCall,
  HostCallArgument,
  HostModuleSpec,
  HostParameterSpec,
  HostParameterValueSpec,
  PayloadValue,
} from "../src/types/index.js";
import { actionProgress, EMPTY_DIALOG, startRun } from "./helpers.js";

const SOURCE = "struct-host-parameters";
const REF = toArcRef(SOURCE, "Main");
const declaration = hmd.define({
  call: (
    _entry = hmd.Struct({ limit: hmd.Omittable(hmd.Num()), title: hmd.Str() }),
  ) => hmd.Bool(),
});
function document(body: string): Document {
  return parse(
    `"arc"; import Host from "host:test"; function Main() { ${body} }`,
  );
}
function runtimeFor(spec: HostModuleSpec, body: string): Runtime {
  return new Runtime({ hostModules: new Map([["test", spec]]) })
    .add(SOURCE, document(body))
    .init();
}
function callIn(doc: Document): HostCall {
  const call = doc.roots[0]!.statements[0];
  if (call?.kind !== "host-call") throw new Error("Expected host call");
  return call;
}
function argument(source: string): HostCallArgument {
  return callIn(document(`Host.$call(${source});`)).arguments[0]!;
}
function pendingCall(traversals: ArcTraversalSet) {
  for (const state of Object.values(traversals[0]!.frame.actionStates))
    if (state?.kind === "host-call" && state.status === "pending")
      return state.call;
  throw new Error("Expected pending call");
}
function normalized(parameter: unknown, returns?: unknown): unknown {
  return {
    kind: "namespace",
    members: {
      call: {
        kind: "operation",
        parameters: [parameter],
        ...(returns === undefined ? {} : { returns }),
      },
    },
  };
}
function registrationIssues(spec: HostModuleSpec, doc: Document) {
  const runtime = new Runtime({ hostModules: new Map([["test", spec]]) });
  try {
    runtime.add(SOURCE, doc);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeRegistrationError);
    expect(runtime.has(REF)).toBe(false);
    return (error as RuntimeRegistrationError).issues;
  }
  throw new Error("Expected registration rejection");
}

describe("Struct host parameters", () => {
  it("struct.hmd captures optional fields recursive composites and numeric key order", () => {
    const spec = hmd.define({
      call: (
        _value = hmd.Omittable(
          hmd.Struct({
            "10": hmd.Num(),
            "2": hmd.Str(),
            optional: hmd.Omittable(hmd.Struct({ flag: hmd.Bool() })),
            rows: hmd.Array(
              hmd.Struct({ pair: hmd.Tuple([hmd.Index(), hmd.Artifact()]) }),
            ),
            empty: hmd.Struct({}),
          }),
        ),
      ) => {},
    });
    expect(spec.members.call).toEqual({
      kind: "operation",
      parameters: [
        {
          type: "omittable",
          spec: {
            type: "struct",
            fields: {
              "10": { type: "number" },
              "2": { type: "string" },
              optional: {
                type: "omittable",
                spec: { type: "struct", fields: { flag: { type: "boolean" } } },
              },
              rows: {
                type: "array",
                element: {
                  type: "struct",
                  fields: {
                    pair: {
                      type: "tuple",
                      elements: [{ type: "index" }, { type: "artifact" }],
                    },
                  },
                },
              },
              empty: { type: "struct", fields: {} },
            },
          },
        },
      ],
    });
    expect(validateHostModuleSpec(spec)).toEqual([]);
    expect(
      actionProgress(
        runtimeFor(spec, "Host.$call();").enterArc(REF, EMPTY_DIALOG),
      ).hostCalls[0]!.arguments,
    ).toEqual([]);
  });

  it("struct.hmd rejects malformed maps unsafe names reused markers and illegal placement", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        getterCalls++;
        return hmd.Str();
      },
    });
    for (const fields of [
      null,
      [],
      new Date(),
      accessor,
      { [Symbol("field")]: 1 },
      Object.defineProperty({}, "hidden", { value: 1 }),
      { field: {} },
    ])
      expect(() =>
        hmd.define({ call: (_value = hmd.Struct(fields as never)) => {} }),
      ).toThrow(/Invalid host module declaration/);
    for (const name of ["", "__proto__", "prototype", "constructor"])
      expect(() =>
        hmd.define({
          call: (
            _value = hmd.Struct(Object.fromEntries([[name, hmd.Str()]])),
          ) => {},
        }),
      ).toThrow(/Struct field names/);
    expect(getterCalls).toBe(0);
    expect(() => hmd.Struct({})).toThrow(/only.*inside hmd.define/);
    let previous: ReturnType<typeof hmd.Str>;
    hmd.define({ call: (_value = (previous = hmd.Str())) => {} });
    expect(() =>
      hmd.define({ call: (_value = hmd.Struct({ old: previous })) => {} }),
    ).toThrow(/composite/);
    expect(() =>
      hmd.define({
        call: () => {
          const marker = hmd.Str();
          hmd.Struct({ a: marker, b: marker });
        },
      }),
    ).toThrow(/composite/);
    expect(() =>
      hmd.define({
        // @ts-expect-error Struct results cannot carry omittable fields.
        call: () => hmd.Array(hmd.Struct({ name: hmd.Omittable(hmd.Str()) })),
      }),
    ).toThrow(/result must be an Arc channel spec/);
    expect(() =>
      hmd.define({
        call: (
          _value = hmd.Struct({
            // @ts-expect-error Array elements cannot be omittable.
            bad: hmd.Array(hmd.Omittable(hmd.Str())),
          }),
        ) => {},
      }),
    ).toThrow(/value marker/);
    expect(() =>
      hmd.define({
        call: (
          _value = hmd.Struct({
            // @ts-expect-error Omittable cannot wrap Omittable.
            bad: hmd.Omittable(hmd.Omittable(hmd.Num())),
          }),
        ) => {},
      }),
    ).toThrow(/value marker/);
  });

  it("struct.normalized validates exact maps cycles optional placement and result restrictions", () => {
    const optional = { type: "omittable", spec: { type: "string" } };
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "field", {
      enumerable: true,
      get() {
        getterCalls++;
        return { type: "string" };
      },
    });
    const cyclic: { type: string; fields: Record<string, unknown> } = {
      type: "struct",
      fields: {},
    };
    cyclic.fields.self = cyclic;
    const invalid = [
      { type: "struct" },
      { type: "struct", fields: {}, extra: true },
      { type: "struct", fields: {}, "": true },
      ...[
        null,
        [],
        new Date(),
        accessor,
        { [Symbol("x")]: { type: "string" } },
        Object.defineProperty({}, "hidden", { value: { type: "string" } }),
        { name: null },
      ].map((fields) => ({ type: "struct", fields })),
      ...["", "__proto__", "prototype", "constructor"].map((name) => ({
        type: "struct",
        fields: Object.fromEntries([[name, { type: "string" }]]),
      })),
      cyclic,
      { type: "struct", fields: { a: { type: "omittable", spec: optional } } },
      { type: "struct", fields: { a: { type: "array", element: optional } } },
      {
        type: "struct",
        fields: { a: { type: "tuple", elements: [optional] } },
      },
    ];
    for (const value of invalid) {
      expect(validateHostModuleSpec(normalized(value)).length).toBeGreaterThan(
        0,
      );
      expect(
        () =>
          new Runtime({
            hostModules: new Map([
              ["test", normalized(value) as HostModuleSpec],
            ]),
          }),
      ).toThrow(/INVALID_HOST_MODULE_SPEC/);
    }
    for (const result of [
      {
        type: "array",
        element: { type: "struct", fields: { file: { type: "artifact" } } },
      },
      { type: "struct", fields: { file: { type: "artifact" } } },
      {
        type: "struct",
        fields: { name: { type: "omittable", spec: { type: "string" } } },
      },
    ])
      expect(
        validateHostModuleSpec(normalized({ type: "string" }, result)).length,
      ).toBeGreaterThan(0);
    expect(getterCalls).toBe(0);
    expect(
      validateHostModuleSpec(
        normalized({
          type: "struct",
          fields: Object.assign(Object.create(null), {
            a: optional,
            b: { type: "number" },
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("struct.ownership privately clones nested optional Enum fields", () => {
    const colors = ["red", "blue"];
    const spec = hmd.define({
      call: (
        _entry = hmd.Struct({
          nested: hmd.Omittable(hmd.Struct({ color: hmd.Enum(colors) })),
        }),
      ) => {},
    });
    colors[0] = "green";
    const runtime = new Runtime({ hostModules: new Map([["test", spec]]) });
    const operation = spec.members.call;
    if (operation?.kind !== "operation") throw new Error("Expected operation");
    const root = operation.parameters[0];
    if (root?.type !== "struct") throw new Error("Expected Struct");
    const nested = root.fields.nested;
    if (nested?.type !== "omittable" || nested.spec.type !== "struct")
      throw new Error("Expected nested Struct");
    const color = nested.spec.fields.color;
    if (color?.type !== "enum") throw new Error("Expected Enum");
    expect(color.values).toEqual(["red", "blue"]);
    color.values[0] = "green";
    root.fields.extra = { type: "number" };
    runtime
      .add(SOURCE, document('Host.$call({ nested: { color: "red" } });'))
      .init();
    expect(
      actionProgress(runtime.enterArc(REF, EMPTY_DIALOG)).hostCalls[0]!
        .arguments,
    ).toEqual([{ nested: { color: "red" } }]);
  });

  it("struct.source rejects duplicate unsafe and non-data object properties", () => {
    for (const source of [
      '{ title: "a", title: "b" }',
      '{ "": 1 }',
      '{ __proto__: "x" }',
      '{ prototype: "x" }',
      '{ constructor: "x" }',
      '{ ["title"]: "x" }',
      "{ ...x }",
      '{ get title() { return "x"; } }',
      "{ title() {} }",
    ])
      expect(() => document(`Host.$call(${source});`)).toThrow();
  });

  it("struct.public-document rejects malformed object arguments without host declarations", () => {
    const field = argument('"x"');
    const malformed: unknown[] = [
      null,
      false,
      {},
      { kind: "unknown", value: {} },
      { kind: "object" },
      { kind: "object", value: null },
      { kind: "object", value: [] },
      { kind: "object", value: { title: { kind: "array", elements: null } } },
      {
        kind: "object",
        value: {
          title: {
            kind: "semantic",
            value: { kind: "template-string", parts: [null] },
          },
        },
      },
      { kind: "object", value: { title: { kind: "value", value: null } } },
      { kind: "object", value: {}, extra: 1 },
      {
        kind: "object",
        value: {
          title: {
            kind: "value",
            value: { kind: "literal", value: { path: "notes/a.md" } },
          },
        },
      },
      {
        kind: "object",
        value: {
          title: { kind: "value", value: { kind: "literal", value: [] } },
        },
      },
      ...["", "__proto__", "prototype", "constructor"].map((name) => ({
        kind: "object",
        value: Object.fromEntries([[name, field]]),
      })),
    ];
    for (const value of malformed) {
      for (const roundTrip of [false, true]) {
        const doc = document('Host.$call({ title: "x" });');
        callIn(doc).arguments[0] = value as HostCallArgument;
        const input = roundTrip
          ? (JSON.parse(JSON.stringify(doc)) as Document)
          : doc;
        expect(validate(input)).toContainEqual(
          expect.objectContaining({ code: "HOST_CALL_ARGUMENT" }),
        );
        expect(registrationIssues(declaration, input)).toContainEqual(
          expect.objectContaining({ code: "HOST_CALL_ARGUMENT" }),
        );
      }
    }
  });

  it("struct.public-document rejects unset children before JSON erases them", () => {
    const doc = document('Host.$call({ title: "x" });');
    callIn(doc).arguments[0] = {
      kind: "object",
      value: { title: undefined },
    } as unknown as HostCallArgument;
    expect(validate(doc)).toContainEqual(
      expect.objectContaining({ code: "HOST_CALL_ARGUMENT" }),
    );
    expect(registrationIssues(declaration, doc)).toContainEqual(
      expect.objectContaining({ code: "HOST_CALL_ARGUMENT" }),
    );
  });

  it("struct.public-document rejects hostile descriptors and cycles before typed walks", () => {
    let getterCalls = 0;
    const field = argument('"x"');
    const cyclic: Record<string, unknown> = {};
    cyclic.title = { kind: "object", value: cyclic };
    for (const fields of [
      Object.defineProperty({}, "title", {
        enumerable: true,
        get() {
          getterCalls++;
          return field;
        },
      }),
      Object.defineProperty({}, "title", { value: field }),
      { title: field, [Symbol("hidden")]: field },
      Object.assign(Object.create({ inherited: true }), { title: field }),
      cyclic,
    ]) {
      const doc = document('Host.$call({ title: "x" });');
      callIn(doc).arguments[0] = {
        kind: "object",
        value: fields as Record<string, HostCallArgument>,
      };
      expect(validate(doc)).toContainEqual(
        expect.objectContaining({ code: "INVALID_PUBLIC_IR" }),
      );
      expect(registrationIssues(declaration, doc)).toContainEqual(
        expect.objectContaining({ code: "INVALID_PUBLIC_IR" }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("struct.registration checks exact fields empty shapes and optional ordering", () => {
    for (const source of [
      "{}",
      '{ title: "x", extra: 1 }',
      "{ title: 1 }",
      '{ title: "x", limit: true }',
      "[]",
      '"x"',
    ]) {
      const doc = document(`Host.$call(${source});`);
      expect(validate(doc)).toEqual([]);
      expect(registrationIssues(declaration, doc)).toContainEqual(
        expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }),
      );
    }
    for (const source of [
      '{ title: "x" }',
      '{ title: "x", limit: 3 }',
      '{ limit: 3, title: "x" }',
    ])
      expect(
        actionProgress(
          runtimeFor(declaration, `Host.$call(${source});`).enterArc(
            REF,
            EMPTY_DIALOG,
          ),
        ).hostCalls[0]!.arguments,
      ).toEqual([
        source.includes("limit") ? { title: "x", limit: 3 } : { title: "x" },
      ]);
    for (const spec of [
      hmd.define({ call: (_value = hmd.Struct({})) => {} }),
      hmd.define({
        call: (_value = hmd.Struct({ title: hmd.Omittable(hmd.Str()) })) => {},
      }),
    ])
      expect(
        actionProgress(
          runtimeFor(spec, "Host.$call({});").enterArc(REF, EMPTY_DIALOG),
        ).hostCalls[0]!.arguments,
      ).toEqual([{}]);
  });

  it("struct.registration definite errors dominate unknown fields in every order", () => {
    for (const fields of [
      { color: { type: "enum", values: ["red"] }, count: { type: "number" } },
      { count: { type: "number" }, color: { type: "enum", values: ["red"] } },
    ] satisfies Record<string, HostParameterSpec>[]) {
      const spec = normalized({ type: "struct", fields }) as HostModuleSpec;
      for (const entries of [
        "color: color, count: true",
        "count: true, color: color",
      ])
        expect(
          registrationIssues(
            spec,
            document(
              `let color = Str(); color.$set("red"); Host.$call({ ${entries} });`,
            ),
          ),
        ).toContainEqual(
          expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }),
        );
      for (const color of ["red", "green"]) {
        const result = runtimeFor(
          spec,
          `let color = Str(); color.$set("${color}"); Host.$call({ color: color, count: 1 });`,
        ).enterArc(REF, EMPTY_DIALOG);
        if (color === "red")
          expect(actionProgress(result).hostCalls).toHaveLength(1);
        else {
          expect(result.issues).toContainEqual(
            expect.objectContaining({ reasonCode: "invalid-host-argument" }),
          );
          expect("hostCalls" in result).toBe(false);
        }
      }
    }
  });

  it("struct.composition preserves every marker and ordinary field names through emission", () => {
    const spec = hmd.define({
      call: (
        _value = hmd.Struct({
          rows: hmd.Array(
            hmd.Struct({ pair: hmd.Tuple([hmd.Index(), hmd.Artifact()]) }),
          ),
          tuple: hmd.Tuple([
            hmd.Struct({ flag: hmd.Bool() }),
            hmd.Array(hmd.Num()),
          ]),
          context: hmd.Omittable(
            hmd.Struct({
              text: hmd.SemanticText(),
              cursor: hmd.Dialog.Cursor(),
            }),
          ),
          kind: hmd.Str(),
          type: hmd.Str(),
          observeAs: hmd.Str(),
          hostParams: hmd.Str(),
          toString: hmd.Str(),
        }),
      ) => {},
    });
    const runtime = runtimeFor(
      spec,
      'Host.$call({ rows: [{ pair: [0, Artifact("notes/a.md")] }], tuple: [{ flag: true }, [2, 3]], context: { text: `Ask ${user}`, cursor: Dialog.cursor }, kind: "k", type: "t", observeAs: "o", hostParams: "h", toString: "s" });',
    );
    expect(
      actionProgress(runtime.enterArc(REF, EMPTY_DIALOG)).hostCalls[0]!
        .arguments,
    ).toEqual([
      {
        rows: [{ pair: [0, { path: "notes/a.md" }] }],
        tuple: [{ flag: true }, [2, 3]],
        context: {
          text: [
            { kind: "text", value: "Ask " },
            { kind: "entity", name: "user" },
          ],
          cursor: EMPTY_DIALOG.cursor,
        },
        kind: "k",
        type: "t",
        observeAs: "o",
        hostParams: "h",
        toString: "s",
      },
    ]);
  });

  it("struct.admission rejects malformed concrete fields without running getters", () => {
    const ir = argument('{ title: "x" }');
    const spec: HostParameterValueSpec = {
      type: "struct",
      fields: {
        title: { type: "string" },
        limit: { type: "omittable", spec: { type: "number" } },
      },
    };
    let getterCalls = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.title = cyclic;
    for (const rendered of [
      null,
      undefined,
      [],
      "x",
      {},
      { title: undefined },
      { title: null },
      { title: "x", extra: 1 },
      { title: "x", limit: 1 },
      new Date(),
      cyclic,
      Object.defineProperty({}, "title", {
        enumerable: true,
        get() {
          getterCalls++;
          return "x";
        },
      }),
      Object.defineProperty({}, "title", { value: "x" }),
      { title: "x", [Symbol("hidden")]: 1 },
    ])
      expect(
        admitHostArgument(ir, rendered as PayloadValue, spec).admitted,
      ).toBe(false);
    expect(getterCalls).toBe(0);
    expect(
      admitHostArgument(
        ir,
        Object.assign(Object.create(null), { title: "x" }),
        spec,
      ),
    ).toEqual({ admitted: true });
  });

  it("struct.admission reports nested Enum finite Artifact and omission violations", () => {
    const cases: [string, PayloadValue, HostParameterValueSpec, string][] = [
      [
        '{ row: { color: "red" } }',
        { row: { color: "green" } },
        {
          type: "struct",
          fields: {
            row: {
              type: "struct",
              fields: { color: { type: "enum", values: ["red"] } },
            },
          },
        },
        '$["row"]["color"]',
      ],
      [
        "{ items: [[1]] }",
        { items: [[Infinity]] },
        {
          type: "struct",
          fields: {
            items: {
              type: "array",
              element: { type: "tuple", elements: [{ type: "number" }] },
            },
          },
        },
        '$["items"][0][0]',
      ],
      [
        '{ file: Artifact("notes/a.md") }',
        { file: { path: "../escape" } },
        { type: "struct", fields: { file: { type: "artifact" } } },
        '$["file"]',
      ],
      [
        "{ limit: 1 }",
        {},
        {
          type: "struct",
          fields: { limit: { type: "omittable", spec: { type: "number" } } },
        },
        '$["limit"]',
      ],
    ];
    for (const [source, value, spec, path] of cases)
      expect(admitHostArgument(argument(source), value, spec)).toMatchObject({
        admitted: false,
        violation: { path },
      });
  });

  it("struct.authority rejects identical-carrier Struct and Artifact substitutions recursively", () => {
    const struct: HostParameterValueSpec = {
      type: "struct",
      fields: { path: { type: "string" } },
    };
    const artifact: HostParameterValueSpec = { type: "artifact" };
    for (const nested of [false, true])
      for (const [source, ownSpec, otherSpec] of [
        ['{ path: "notes/a.md" }', struct, artifact],
        ['Artifact("notes/a.md")', artifact, struct],
      ] as const) {
        const wrapSource = nested ? `{ item: ${source} }` : source;
        const wrap = (spec: HostParameterValueSpec): HostParameterValueSpec =>
          nested ? { type: "struct", fields: { item: spec } } : spec;
        const rendered = nested
          ? { item: { path: "notes/a.md" } }
          : { path: "notes/a.md" };
        expect(
          registrationIssues(
            normalized(wrap(otherSpec)) as HostModuleSpec,
            document(`Host.$call(${wrapSource});`),
          ),
        ).toContainEqual(
          expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }),
        );
        // Restoration uses this same authored-argument admission boundary.
        expect(
          admitHostArgument(argument(wrapSource), rendered, wrap(otherSpec))
            .admitted,
        ).toBe(false);
        expect(
          admitHostArgument(argument(wrapSource), rendered, wrap(ownSpec))
            .admitted,
        ).toBe(true);
        const spec = normalized(wrap(ownSpec)) as HostModuleSpec;
        const body = `Host.$call(${wrapSource});`;
        const first = actionProgress(
          runtimeFor(spec, body).enterArc(REF, EMPTY_DIALOG),
        );
        expect(first.hostCalls[0]!.arguments).toEqual([rendered]);
        expect(
          startRun(
            runtimeFor(spec, body),
            JSON.parse(JSON.stringify(first.traversals)) as ArcTraversalSet,
            EMPTY_DIALOG,
          ).hostCalls,
        ).toEqual(first.hostCalls);
      }
  });

  it("struct.authority keeps nested semantic and concrete lookalikes distinct", () => {
    const spec = hmd.define({
      call: (_value = hmd.Struct({ text: hmd.SemanticText() })) => {},
    });
    const lookalike = '{ text: [{ kind: "entity", name: "user" }] }';
    expect(
      registrationIssues(spec, document(`Host.$call(${lookalike});`)),
    ).toContainEqual(expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }));
    const destination: HostParameterValueSpec = {
      type: "struct",
      fields: { text: { type: "semanticText" } },
    };
    const rendered = { text: [{ kind: "entity", name: "user" }] };
    expect(
      admitHostArgument(argument(lookalike), rendered, destination).admitted,
    ).toBe(false);
    expect(
      admitHostArgument(argument("{ text: `${user}` }"), rendered, destination)
        .admitted,
    ).toBe(true);
    expect(
      registrationIssues(
        hmd.define({ call: (_value = hmd.Struct({ text: hmd.Str() })) => {} }),
        document("Host.$call({ text: `${user}` });"),
      ),
    ).toContainEqual(expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }));
    expect(
      admitHostArgument(argument("{ text: `${user}` }"), rendered, {
        type: "struct",
        fields: { text: { type: "string" } },
      }).admitted,
    ).toBe(false);
  });

  it("struct.execution preserves optional fields in expressions actions triggers and effects", () => {
    for (const source of ['{ title: "x" }', '{ title: "x", limit: 2 }']) {
      const expected = source.includes("limit")
        ? { title: "x", limit: 2 }
        : { title: "x" };
      for (const body of [
        `Host.$call(${source});`,
        `let result = Bool(); result.$set(Host.call(${source}));`,
        `this.effects = () => { Host.$call(${source}); };`,
      ]) {
        const runtime = runtimeFor(declaration, body);
        const brief = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
        expect(brief.hostCalls[0]!.arguments).toEqual([expected]);
        const done = runtime.progress(
          brief,
          {
            move: "proceed",
            hostCalls: {
              [brief.hostCalls[0]!.id]: { status: "resolved", value: true },
            },
          },
          EMPTY_DIALOG,
        );
        expect(done.issues).toEqual([]);
        expect(done.canProgress).toBe(false);
      }
      const runtime = runtimeFor(
        declaration,
        `this.trigger = () => Host.call(${source});`,
      );
      const brief = runtime.startTrigger([], EMPTY_DIALOG);
      expect(brief.hostCalls[0]!.arguments).toEqual([expected]);
      expect(
        runtime.progressTrigger(
          brief,
          {
            hostCalls: {
              [brief.hostCalls[0]!.id]: { status: "resolved", value: true },
            },
          },
          EMPTY_DIALOG,
        ).issues,
      ).toEqual([]);
    }
  });

  it("struct.execution rejects invalid concrete fields across call contexts", () => {
    for (const expression of [
      '{ title: "x", limit: 1 / 0 }',
      "{ title: missing }",
    ]) {
      const setup = "let missing = Str();";
      for (const body of [
        `${setup} Host.$call(${expression});`,
        `${setup} let result = Bool(); result.$set(Host.call(${expression}));`,
        `${setup} this.effects = () => { Host.$call(${expression}); };`,
      ]) {
        const result = runtimeFor(declaration, body).enterArc(
          REF,
          EMPTY_DIALOG,
        );
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            reasonCode: expression.includes("missing")
              ? "unset-value"
              : "invalid-host-argument",
          }),
        );
        expect("hostCalls" in result).toBe(false);
      }
    }
    const result = runtimeFor(
      declaration,
      'this.trigger = () => Host.call({ title: "x", limit: 1 / 0 });',
    ).startTrigger([], EMPTY_DIALOG);
    expect(result.hostCalls).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "invalid-host-argument" }),
    );
  });

  it("struct.persistence preserves retries and rejects altered optional field presence", () => {
    const spec = hmd.define({
      call: (
        _entry = hmd.Struct({
          title: hmd.Str(),
          context: hmd.Omittable(
            hmd.Struct({ count: hmd.Num(), limit: hmd.Omittable(hmd.Num()) }),
          ),
        }),
      ) => {},
    });
    for (const source of [
      '{ title: "x" }',
      '{ title: "x", context: { count: 1 } }',
      '{ title: "x", context: { count: 1, limit: 2 } }',
    ])
      for (const body of [
        `Host.$call(${source});`,
        `this.effects = () => { Host.$call(${source}); };`,
      ]) {
        const runtime = runtimeFor(spec, body);
        const first = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
        const retry = actionProgress(
          runtime.progress(first, { move: "proceed" }, EMPTY_DIALOG),
        );
        expect(retry.hostCalls).toEqual(first.hostCalls);
        const restarted = runtimeFor(spec, body);
        const replay = startRun(
          restarted,
          JSON.parse(JSON.stringify(retry.traversals)) as ArcTraversalSet,
          EMPTY_DIALOG,
        );
        expect(replay.hostCalls).toEqual(first.hostCalls);
        const done = restarted.progress(
          replay,
          {
            move: "proceed",
            hostCalls: { [replay.hostCalls[0]!.id]: { status: "resolved" } },
          },
          EMPTY_DIALOG,
        );
        expect(done.issues).toEqual([]);
        expect(done.canProgress).toBe(false);
        const original = first.hostCalls[0]!.arguments[0];
        for (const value of [
          {},
          { title: "x", extra: 1 },
          { title: 1 },
          { title: "x", context: { count: "bad" } },
          { title: "x" },
          { title: "x", context: { count: 1 } },
          { title: "x", context: { count: 1, limit: 2 } },
        ]) {
          if (JSON.stringify(value) === JSON.stringify(original)) continue;
          const corrupt = JSON.parse(
            JSON.stringify(first.traversals),
          ) as ArcTraversalSet;
          pendingCall(corrupt).arguments[0] = value;
          expect(() =>
            startRun(runtimeFor(spec, body), corrupt, EMPTY_DIALOG),
          ).toThrow(/Invalid persisted traversal state/);
        }
      }
  });

  it("struct.persistence rejects array length and nested field corruption", () => {
    const spec = hmd.define({
      call: (
        _value = hmd.Struct({
          rows: hmd.Array(hmd.Struct({ name: hmd.Str() })),
          pair: hmd.Tuple([hmd.Struct({ count: hmd.Num() })]),
        }),
      ) => {},
    });
    const body = 'Host.$call({ rows: [{ name: "x" }], pair: [{ count: 1 }] });';
    const first = actionProgress(
      runtimeFor(spec, body).enterArc(REF, EMPTY_DIALOG),
    );
    for (const value of [
      { rows: [], pair: [{ count: 1 }] },
      { rows: [{ name: "x" }, { name: "extra" }], pair: [{ count: 1 }] },
      { rows: [{ name: "x" }], pair: [] },
      { rows: [{ name: "x" }], pair: [{ count: 1 }, { count: 2 }] },
      { rows: [{ name: "x" }], pair: [{}] },
    ]) {
      const corrupt = JSON.parse(
        JSON.stringify(first.traversals),
      ) as ArcTraversalSet;
      pendingCall(corrupt).arguments[0] = value;
      expect(() =>
        startRun(runtimeFor(spec, body), corrupt, EMPTY_DIALOG),
      ).toThrow(/Invalid persisted traversal state/);
    }
  });

  it("struct.regression rejects host calls nested inside Struct fields", () => {
    expect(() =>
      document('Host.$call({ title: Host.call({ title: "x" }) });'),
    ).toThrow(/briefable/);
  });
});
