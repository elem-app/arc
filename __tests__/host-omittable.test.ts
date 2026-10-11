import { describe, expect, it } from "vitest";

import { hmd } from "../src/host-utils/index.js";
import { parse } from "../src/parser/index.js";
import {
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import { validateHostModuleSpec } from "../src/spec/validation.js";
import type {
  ArcTraversalSet,
  HostModuleSpec,
  HostParameterValueSpec,
} from "../src/types/index.js";

import { actionProgress, EMPTY_DIALOG, startRun } from "./helpers.js";

const SOURCE = "omittable-host-parameters";
const REF = toArcRef(SOURCE, "Main");

function document(body: string) {
  return parse(
    `"arc"; import Host from "host:test"; function Main() { ${body} }`,
  );
}

function runtimeFor(declaration: HostModuleSpec, body: string) {
  return new Runtime({ hostModules: new Map([["test", declaration]]) })
    .add(SOURCE, document(body))
    .init();
}

function pendingCall(traversals: ArcTraversalSet) {
  for (const state of Object.values(traversals[0]!.frame.actionStates)) {
    if (state?.kind === "host-call" && state.status === "pending")
      return state.call;
  }
  throw new Error("Expected a captured pending host call");
}

describe("omittable host parameters", () => {
  it("omittable.hmd captures whole scalar and composite parameters", () => {
    const declaration = hmd.define({
      call: (
        _required = hmd.Str(),
        _number = hmd.Omittable(hmd.Num()),
        _array = hmd.Omittable(hmd.Array(hmd.Artifact())),
        _tuple = hmd.Omittable(
          hmd.Tuple([hmd.Enum(["red", "blue"]), hmd.SemanticText()]),
        ),
      ) => hmd.Bool(),
    });
    expect(declaration.members.call).toEqual({
      kind: "operation",
      parameters: [
        { type: "string" },
        { type: "omittable", spec: { type: "number" } },
        {
          type: "omittable",
          spec: { type: "array", element: { type: "artifact" } },
        },
        {
          type: "omittable",
          spec: {
            type: "tuple",
            elements: [
              { type: "enum", values: ["red", "blue"] },
              { type: "semanticText" },
            ],
          },
        },
      ],
      returns: { type: "boolean" },
    });
    expect(validateHostModuleSpec(declaration)).toEqual([]);
  });

  it("omittable.hmd rejects invalid placement with declaration paths and static marker types", () => {
    const invalid = [
      () =>
        hmd.define({
          call: (_a = hmd.Omittable(hmd.Num()), _b = hmd.Str()) => {},
        }),
      () =>
        hmd.define({
          // @ts-expect-error Omittable requires a value marker.
          call: (_a = hmd.Omittable(hmd.Omittable(hmd.Str()))) => {},
        }),
      () =>
        hmd.define({
          // @ts-expect-error Array members must be value markers.
          call: (_a = hmd.Array(hmd.Omittable(hmd.Str()))) => {},
        }),
      () =>
        hmd.define({
          // @ts-expect-error Tuple members must be value markers.
          call: (_a = hmd.Tuple([hmd.Omittable(hmd.Str())])) => {},
        }),
      // @ts-expect-error Omittable is a parameter-only marker.
      () => hmd.define({ call: () => hmd.Omittable(hmd.Str()) }),
    ];
    for (const declare of invalid) {
      expect(declare).toThrow(/Invalid host module declaration at .*call/);
    }
    expect(() => hmd.Omittable(hmd.Num())).toThrow(/only.*inside hmd.define/);
  });

  it("omittable.normalized rejects malformed wrappers and illegal placement", () => {
    const wrapper = { type: "omittable", spec: { type: "string" } };
    const invalid = [
      { parameters: [wrapper, { type: "number" }], path: ".parameters[1]" },
      { parameters: [{ type: "omittable" }], path: ".parameters[0].spec" },
      {
        parameters: [{ ...wrapper, extra: true }],
        path: '.parameters[0]["extra"]',
      },
      {
        parameters: [{ type: "omittable", spec: wrapper }],
        path: ".parameters[0].spec",
      },
      {
        parameters: [{ type: "array", element: wrapper }],
        path: ".parameters[0].element",
      },
      {
        parameters: [{ type: "tuple", elements: [wrapper] }],
        path: ".parameters[0].elements[0]",
      },
      {
        parameters: [{ type: "omittable", spec: undefined }],
        path: ".parameters[0].spec",
      },
      { parameters: [], returns: wrapper, path: ".returns" },
    ];
    for (const { path, ...operation } of invalid) {
      const declaration = {
        kind: "namespace",
        members: { call: { kind: "operation", ...operation } },
      };
      expect(validateHostModuleSpec(declaration)).toContainEqual(
        expect.objectContaining({
          path: `$.members["call"]${path}`,
        }),
      );
      expect(
        () =>
          new Runtime({
            hostModules: new Map([["test", declaration as HostModuleSpec]]),
          }),
      ).toThrow(/INVALID_HOST_MODULE_SPEC/);
    }
  });

  it("omittable.ownership clones wrapped composite specs into runtime ownership", () => {
    const colors = ["red", "blue"];
    const declaration = hmd.define({
      call: (_colors = hmd.Omittable(hmd.Array(hmd.Enum(colors)))) => {},
    });
    colors[0] = "green";
    const runtime = new Runtime({
      hostModules: new Map([["test", declaration]]),
    });
    const operation = declaration.members.call;
    if (operation?.kind !== "operation") throw new Error("Expected operation");
    expect(operation.parameters).toEqual([
      {
        type: "omittable",
        spec: {
          type: "array",
          element: { type: "enum", values: ["red", "blue"] },
        },
      },
    ]);
    const parameter = operation.parameters[0];
    if (
      parameter?.type !== "omittable" ||
      parameter.spec.type !== "array" ||
      parameter.spec.element.type !== "enum"
    ) {
      throw new Error("Expected wrapped Enum array");
    }
    parameter.spec.element.values[0] = "green";
    operation.parameters.push({ type: "number" });
    runtime.add(SOURCE, document('Host.$call(["red"]);')).init();
    expect(
      actionProgress(runtime.enterArc(REF, EMPTY_DIALOG)).hostCalls[0]
        ?.arguments,
    ).toEqual([["red"]]);
  });

  it("omittable.arity accepts every permitted prefix and rejects missing required or excess arguments", () => {
    for (const required of [0, 1, 2]) {
      for (const omittable of [0, 1, 2]) {
        const total = required + omittable;
        const declaration: HostModuleSpec = {
          kind: "namespace",
          members: {
            call: {
              kind: "operation",
              parameters: [
                ...Array.from(
                  { length: required },
                  (): HostParameterValueSpec => ({ type: "number" }),
                ),
                ...Array.from({ length: omittable }, () => ({
                  type: "omittable" as const,
                  spec: { type: "number" as const },
                })),
              ],
            },
          },
        };
        for (let count = 0; count <= total + 1; count++) {
          const args = Array.from({ length: count }, (_, index) => index + 1);
          const body = `Host.$call(${args.join(",")});`;
          if (count >= required && count <= total) {
            const runtime = runtimeFor(declaration, body);
            expect(
              actionProgress(runtime.enterArc(REF, EMPTY_DIALOG)).hostCalls[0]
                ?.arguments,
            ).toEqual(args);
          } else {
            try {
              runtimeFor(declaration, body);
              throw new Error("Expected arity rejection");
            } catch (error) {
              expect(error).toBeInstanceOf(RuntimeRegistrationError);
              expect((error as RuntimeRegistrationError).issues).toContainEqual(
                expect.objectContaining({
                  code: "HOST_ARGUMENT_ARITY",
                  message: expect.stringContaining(
                    `requires ${required === total ? total : `${required} to ${total}`} arguments but received ${count}`,
                  ),
                }),
              );
            }
          }
        }
      }
    }
  });

  it("omittable.supplied rejects provably incompatible arguments before registration", () => {
    const declaration = hmd.define({
      call: (_value = hmd.Omittable(hmd.Num())) => {},
    });
    expect(() => runtimeFor(declaration, 'Host.$call("wrong");')).toThrow(
      /incompatible with its declared parameter spec/,
    );
  });

  it("omittable.supplied retains unset finite and indexed composite admission", () => {
    const cases = [
      {
        spec: hmd.define({ call: (_value = hmd.Omittable(hmd.Num())) => {} }),
        body: "let n = Num(); Host.$call(n);",
        code: "unset-value",
      },
      {
        spec: hmd.define({ call: (_value = hmd.Omittable(hmd.Num())) => {} }),
        body: "Host.$call(1 / 0);",
        code: "invalid-host-argument",
      },
      {
        spec: hmd.define({
          call: (_value = hmd.Omittable(hmd.Array(hmd.Num()))) => {},
        }),
        body: "Host.$call([1, 1 / 0]);",
        code: "invalid-host-argument",
        path: "$[0][1]",
      },
      {
        spec: hmd.define({
          call: (
            _value = hmd.Omittable(hmd.Tuple([hmd.Num(), hmd.Enum(["red"])])),
          ) => {},
        }),
        body: 'let color = Str(); color.$set("green"); Host.$call([1, color]);',
        code: "invalid-host-argument",
        path: "$[0][1]",
      },
    ];
    for (const { spec, body, code, path } of cases) {
      const runtime = runtimeFor(spec, body);
      const terminal = runtime.enterArc(REF, EMPTY_DIALOG);
      expect(terminal.canProgress).toBe(false);
      expect(terminal.issues).toContainEqual(
        expect.objectContaining({ reasonCode: code }),
      );
      if (path) expect(JSON.stringify(terminal.issues)).toContain(path);
      expect("hostCalls" in terminal).toBe(false);
    }
  });

  it("omittable.execution preserves supplied values in expression action trigger and effect calls", () => {
    const declaration = hmd.define({
      call: (_name = hmd.Str(), _count = hmd.Omittable(hmd.Num())) =>
        hmd.Bool(),
    });
    for (const argumentSource of ['"x"', '"x", 10']) {
      const expected = argumentSource.includes(",") ? ["x", 10] : ["x"];
      for (const body of [
        `Host.$call(${argumentSource});`,
        `let result = Bool(); result.$set(Host.call(${argumentSource}));`,
        `this.effects = () => { Host.$call(${argumentSource}); };`,
      ]) {
        const runtime = runtimeFor(declaration, body);
        const brief = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
        expect(brief.hostCalls[0]?.arguments).toEqual(expected);
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
        `this.trigger = () => Host.call(${argumentSource});`,
      );
      const trigger = runtime.startTrigger([], EMPTY_DIALOG);
      expect(trigger.hostCalls[0]?.arguments).toEqual(expected);
      const done = runtime.progressTrigger(
        trigger,
        {
          hostCalls: {
            [trigger.hostCalls[0]!.id]: { status: "resolved", value: true },
          },
        },
        EMPTY_DIALOG,
      );
      expect(done.hostCalls).toEqual([]);
      expect(done.issues).toEqual([]);
    }
  });

  it("omittable.persistence preserves omitted suffixes through retries and JSON restoration", () => {
    const declaration = hmd.define({
      call: (
        _name = hmd.Omittable(hmd.Str()),
        _count = hmd.Omittable(hmd.Num()),
      ) => {},
    });
    for (const args of ["", '"x"', '"x", 10']) {
      for (const body of [
        `Host.$call(${args});`,
        `this.effects = () => { Host.$call(${args}); };`,
      ]) {
        const runtime = runtimeFor(declaration, body);
        const first = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
        const retry = actionProgress(
          runtime.progress(first, { move: "proceed" }, EMPTY_DIALOG),
        );
        expect(retry.hostCalls).toEqual(first.hostCalls);
        const restored = JSON.parse(
          JSON.stringify(retry.traversals),
        ) as ArcTraversalSet;
        const restarted = runtimeFor(declaration, body);
        const replay = startRun(restarted, restored, EMPTY_DIALOG);
        expect(replay.hostCalls).toEqual(first.hostCalls);
        const done = restarted.progress(
          replay,
          {
            move: "proceed",
            hostCalls: { [replay.hostCalls[0]!.id]: { status: "resolved" } },
          },
          EMPTY_DIALOG,
        );
        expect(done.canProgress).toBe(false);
        expect(done.issues).toEqual([]);
      }
    }
  });

  it("omittable.persistence rejects corrupted capture lengths and supplied values", () => {
    const declaration = hmd.define({
      call: (_name = hmd.Str(), _count = hmd.Omittable(hmd.Num())) => {},
    });
    for (const body of [
      'Host.$call("x");',
      'this.effects = () => { Host.$call("x"); };',
    ]) {
      const runtime = runtimeFor(declaration, body);
      const first = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
      for (const args of [[], ["x", 10], [42], ["x", 10, 20]]) {
        const restored = JSON.parse(
          JSON.stringify(first.traversals),
        ) as ArcTraversalSet;
        pendingCall(restored).arguments = args;
        expect(() =>
          startRun(runtimeFor(declaration, body), restored, EMPTY_DIALOG),
        ).toThrow(/Invalid persisted traversal state/);
      }
    }
    const body = 'Host.$call("x", 10);';
    const runtime = runtimeFor(declaration, body);
    const first = actionProgress(runtime.enterArc(REF, EMPTY_DIALOG));
    for (const args of [["x"], ["x", "wrong"]]) {
      const restored = JSON.parse(
        JSON.stringify(first.traversals),
      ) as ArcTraversalSet;
      pendingCall(restored).arguments = args;
      expect(() =>
        startRun(runtimeFor(declaration, body), restored, EMPTY_DIALOG),
      ).toThrow(/Invalid persisted traversal state/);
    }
  });
});
