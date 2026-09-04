import { describe, expect, it } from "vitest";

import { hmd } from "../src/host-utils/index.js";
import { analyzeDocument, parse } from "../src/parser/index.js";
import {
  createArtifactValue,
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import { admitHostArgument } from "../src/spec/resolution.js";
import { validateHostModuleSpec } from "../src/spec/validation.js";
import {
  nodeSegKey,
  type ArcTraversalSet,
  type HostCallArgument,
  type HostModuleSpec,
} from "../src/types/index.js";

import {
  actionProgress,
  EMPTY_DIALOG,
  progressBrief,
  resolvedHostCalls,
  rootTraversal,
  startRun,
  startTerminal,
} from "./helpers.js";

const STORE_DECLARATION = hmd.define({
  lookup: (name = hmd.Str()) => hmd.Artifact(),
  archive: (artifact = hmd.Artifact()) => {},
  home: {
    rebuild: () => hmd.Bool(),
  },
});

function hostModules(
  declaration: HostModuleSpec = STORE_DECLARATION,
): ReadonlyMap<string, HostModuleSpec> {
  return new Map([["store", declaration]]);
}

function registrationIssues(
  runtime: Runtime,
  source: string,
  document: ReturnType<typeof parse>,
): RuntimeRegistrationError["issues"] {
  try {
    runtime.add(source, document);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeRegistrationError);
    return (error as RuntimeRegistrationError).issues;
  }
  throw new Error("Expected Runtime.add() to reject the document");
}

describe("host module declarations", () => {
  it("hmd define normalizes operations and nested namespaces", () => {
    expect(STORE_DECLARATION).toEqual({
      kind: "namespace",
      members: {
        lookup: {
          kind: "operation",
          parameters: [{ type: "string" }],
          returns: { type: "artifact" },
        },
        archive: {
          kind: "operation",
          parameters: [{ type: "artifact" }],
        },
        home: {
          kind: "namespace",
          members: {
            rebuild: {
              kind: "operation",
              parameters: [],
              returns: { type: "boolean" },
            },
          },
        },
      },
    });
  });

  it("hmd define captures positional parameters and optional results", () => {
    expect(
      hmd.define({
        convert: (source = hmd.Str(), enabled = hmd.Bool()) => hmd.Num(),
        archive: (artifact = hmd.Artifact()) => {},
      }),
    ).toEqual({
      kind: "namespace",
      members: {
        convert: {
          kind: "operation",
          parameters: [{ type: "string" }, { type: "boolean" }],
          returns: { type: "number" },
        },
        archive: {
          kind: "operation",
          parameters: [{ type: "artifact" }],
        },
      },
    });
  });

  it("hmd define reduces nested array and tuple markers", () => {
    expect(
      hmd.define({
        transform: (
          groups = hmd.Array(hmd.Array(hmd.Str())),
          pair = hmd.Tuple([hmd.Num(), hmd.Artifact()]),
        ) => hmd.Array(hmd.Enum(["ready", "done"])),
      }),
    ).toEqual({
      kind: "namespace",
      members: {
        transform: {
          kind: "operation",
          parameters: [
            {
              type: "array",
              element: { type: "array", element: { type: "string" } },
            },
            {
              type: "tuple",
              elements: [{ type: "number" }, { type: "artifact" }],
            },
          ],
          returns: {
            type: "array",
            element: { type: "enum", values: ["ready", "done"] },
          },
        },
      },
    });
  });

  it("hmd define admits Artifact-array results and enforces remaining result restrictions", () => {
    expect(() =>
      hmd.define({
        invalid: (() => hmd.SemanticText()) as () => void,
      }),
    ).toThrow(/result must be an Arc channel spec/);
    expect(
      hmd.define({
        collect: () => hmd.Array(hmd.Artifact()),
      }),
    ).toEqual({
      kind: "namespace",
      members: {
        collect: {
          kind: "operation",
          parameters: [],
          returns: { type: "array", element: { type: "artifact" } },
        },
      },
    });
    expect(() =>
      hmd.define({
        invalid: () => hmd.Enum(["same", "same"]),
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      hmd.define({
        invalid: (() => ({})) as () => void,
      }),
    ).toThrow(/declaration marker/);

    const values = ["ready", "done"];
    const declaration = hmd.define({ state: () => hmd.Enum(values) });
    values[0] = "changed";
    expect(declaration.members.state).toMatchObject({
      returns: { type: "enum", values: ["ready", "done"] },
    });
  });

  it("hmd define rejects malformed namespace trees and member names", () => {
    const accessor = {};
    Object.defineProperty(accessor, "run", {
      enumerable: true,
      get: () => () => {},
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolMember = { run: () => {} };
    Object.defineProperty(symbolMember, Symbol("hidden"), {
      enumerable: true,
      value: () => {},
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("unreachable reflection failure");
        },
      },
    );
    const revokedProxy = Proxy.revocable({}, {});
    revokedProxy.revoke();
    for (const declaration of [
      null,
      [],
      { $run: () => {} },
      { run: 1 },
      accessor,
      cyclic,
      symbolMember,
      throwingProxy,
      revokedProxy.proxy,
      Object.assign(Object.create(Date.prototype), { run: () => {} }),
    ]) {
      expect(() => hmd.define(declaration as never)).toThrow(
        expect.objectContaining({ code: "HOST_MODULE_DECLARATION" }),
      );
    }
  });

  it("hmd markers require the active operation capture", () => {
    expect(() => hmd.Str()).toThrow(
      expect.objectContaining({ code: "HOST_MODULE_DECLARATION" }),
    );
  });

  it("hmd define rejects async functions before invoking them", async () => {
    let invoked = false;
    const operation = async () => {
      invoked = true;
      await 0;
      return hmd.Str();
    };

    expect(() =>
      hmd.define({ invalid: operation as unknown as () => void }),
    ).toThrow(/must be synchronous/);
    expect(invoked).toBe(false);
    await Promise.resolve();
  });

  it("hmd define observes returned promise rejections before failing", async () => {
    const nodeGlobal = globalThis as typeof globalThis & {
      process: {
        on(
          event: "unhandledRejection",
          listener: (reason: unknown) => void,
        ): void;
        off(
          event: "unhandledRejection",
          listener: (reason: unknown) => void,
        ): void;
      };
      setImmediate(callback: () => void): void;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let continued = false;
    const operation = () =>
      Promise.resolve().then(() => {
        continued = true;
        return hmd.Str();
      });
    nodeGlobal.process.on("unhandledRejection", onUnhandled);
    try {
      expect(() =>
        hmd.define({ invalid: operation as unknown as () => void }),
      ).toThrow(/must be synchronous/);
      await new Promise<void>((resolve) => nodeGlobal.setImmediate(resolve));
      expect(continued).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      nodeGlobal.process.off("unhandledRejection", onUnhandled);
    }
  });

  it("hmd define rejects cross capture tokens", () => {
    let previous: ReturnType<(typeof hmd)["Str"]> | undefined;
    hmd.define({
      first: (value = (previous = hmd.Str())) => {},
    });

    expect(() =>
      hmd.define({
        second: (value = hmd.Array(previous!)) => {},
      }),
    ).toThrow(/composite declaration markers are invalid/);
  });

  it("arc host utils exposes the hmd declaration surface", () => {
    expect(Object.keys(hmd)).toEqual([
      "define",
      "Bool",
      "Str",
      "Enum",
      "Num",
      "Index",
      "Artifact",
      "Dialog",
      "Array",
      "Tuple",
      "SemanticText",
    ]);
  });

  it("host module specs validate exact recursive public shapes", () => {
    const malformed = {
      kind: "namespace",
      members: {
        call: {
          kind: "operation",
          parameters: [
            {
              type: "tuple",
              elements: [{ type: "string" }, , { type: "boolean" }],
            },
          ],
        },
      },
    };

    expect(validateHostModuleSpec(malformed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-host-module-spec",
          path: expect.stringContaining("elements[1]"),
        }),
      ]),
    );

    const cyclic = {
      kind: "namespace",
      members: {} as Record<string, unknown>,
    };
    cyclic.members.self = cyclic;
    expect(validateHostModuleSpec(cyclic)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-host-module-spec",
          detail: expect.stringContaining("cyclic"),
        }),
      ]),
    );

    const accessor = {
      kind: "namespace",
      members: {},
    };
    Object.defineProperty(accessor, "extra", {
      enumerable: true,
      get: () => "unreachable",
    });
    expect(validateHostModuleSpec(accessor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-host-module-spec",
          detail: expect.stringContaining("data properties"),
        }),
      ]),
    );
  });
});

describe("host action source forms", () => {
  it("uses the same host-call IR throughout the action graph", () => {
    const document = parse(`
"arc";
import Store from "host:store";
function Main() {
  let items = Array(Str());
  Store.$archive(Artifact("direct.md"));
  if (true) { Store.$archive(Artifact("if.md")); }
  named: { Store.$archive(Artifact("label.md")); }
  invoke(() => { Store.$archive(Artifact("invoke.md")); });
  items.$map(() => { Store.$archive(Artifact("map.md")); });
  this.effects = () => { Store.$archive(Artifact("effects.md")); };
}
`);
    const root = document.roots[0]!;
    expect(root.statements[0]).toMatchObject({
      kind: "host-call",
      operation: "archive",
    });
    expect(root.statements[1]).toMatchObject({
      kind: "if",
      consequent: [{ kind: "host-call", operation: "archive" }],
    });
    expect(root.statements[2]).toMatchObject({
      kind: "label",
      body: [{ kind: "host-call", operation: "archive" }],
    });
    expect(root.statements[3]).toMatchObject({
      kind: "invoke",
      body: [{ kind: "host-call", operation: "archive" }],
    });
    expect(root.statements[4]).toMatchObject({
      kind: "map",
      body: [{ kind: "host-call", operation: "archive" }],
    });
    expect(root.effects).toMatchObject([
      { kind: "host-call", operation: "archive" },
    ]);
  });

  it("rejects an unsigiled host call used as a standalone statement", () => {
    expect(() =>
      parse(`
"arc";
import Store from "host:store";
function Main() { Store.archive(Artifact("notes/a.md")); }
`),
    ).toThrow(/Standalone host calls require a \$-prefixed operation/);
  });

  it("standalone host calls require a dollar sigil at every authored use site", () => {
    expect(() =>
      parse(`
"arc";
import Store from "host:store";
function Main() {
  this.effects = () => {
    Store.archive(Artifact("notes/a.md"));
  };
}
`),
    ).toThrow(/Standalone host calls require a \$-prefixed operation/);
  });

  it("nested host calls strip only the final action sigil in IR", () => {
    const document = parse(`
"arc";
import Store from "host:store";
function Main() {
  this.effects = () => {
    Store.home["$rebuild"]();
  };
}
`);

    expect(document.roots[0]?.effects?.[0]).toMatchObject({
      kind: "host-call",
      module: "store",
      target: ["home"],
      operation: "rebuild",
    });
  });

  it("operations with returns may be used as expressions or standalone calls", () => {
    const runtime = new Runtime({ hostModules: hostModules() });
    expect(() =>
      runtime.add(
        "both-modes",
        parse(`
"arc";
import Store from "host:store";
function Main() {
  let rebuilt = Bool();
  rebuilt.$set(Store.home.rebuild());
  this.effects = () => {
    Store.home.$rebuild();
  };
}
`),
      ),
    ).not.toThrow();
  });

  it("standalone calls discard a declared result and block later work", () => {
    const modules = new Map([["store", hmd.define({ next: () => hmd.Num() })]]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "standalone-result-discard",
        parse(`
"arc";
import Store from "host:store";
function Main() {
  Store.$next();
  $instruct(\`after call\`);
}
`),
      )
      .init();
    const traversal = runtime.newTraversal(
      toArcRef("standalone-result-discard", "Main"),
    );
    traversal.phase = "entered";

    const call = startRun(runtime, [traversal], EMPTY_DIALOG);
    expect(call.instructions).toEqual([]);
    expect(call.hostCalls).toHaveLength(1);

    const instruction = progressBrief(runtime, call, {
      move: "proceed",
      hostCalls: {
        [call.hostCalls[0]!.id]: {
          status: "resolved",
          value: "ignored despite the declared Num result",
        },
      },
    });
    expect(instruction.instructions.map((item) => item.text)).toEqual([
      "after call",
    ]);
  });

  it("operations without returns are rejected by value-demanding consumers only", () => {
    const modules = hostModules();
    expect(() =>
      new Runtime({ hostModules: modules }).add(
        "effect-only",
        parse(`
"arc";
import Store from "host:store";
function Main() {
  this.effects = () => {
    Store.$archive(Artifact("notes/a.md"));
  };
}
`),
      ),
    ).not.toThrow();

    const demanded = [
      [
        "cell",
        `
  let value = Bool();
  value.$set(Store.archive(Artifact("notes/a.md")));
`,
        "CELL_VALUE_TYPE",
      ],
      [
        "boolean",
        `
  if (Store.archive(Artifact("notes/a.md"))) {}
`,
        "NON_BOOLEAN_CONDITION",
      ],
      [
        "arithmetic",
        `
  let value = Num();
  value.$set(Store.archive(Artifact("notes/a.md")) + 1);
`,
        "NON_NUMERIC_ARITHMETIC_OPERAND",
      ],
      [
        "artifact",
        `
  let value = Artifact();
  value.$set(Artifact(Store.archive(Artifact("notes/a.md"))));
`,
        "ARTIFACT_PATH_TYPE",
      ],
    ] as const;
    for (const [name, body, code] of demanded) {
      const issues = registrationIssues(
        new Runtime({ hostModules: modules }),
        `no-result-${name}`,
        parse(`
"arc";
import Store from "host:store";
function Main() {
${body}
}
`),
      );
      expect(issues).toContainEqual(expect.objectContaining({ code }));
    }

    const channelIssues = registrationIssues(
      new Runtime({ hostModules: modules }),
      "no-result-channel",
      parse(`
"arc";
import Store from "host:store";
function Main(args = {}, returns = { ok: Bool() }) {
  this.effects = () => {
    returns.ok.$set(Store.archive(Artifact("notes/a.md")));
  };
}
`),
    );
    expect(channelIssues).toContainEqual(
      expect.objectContaining({ code: "CHANNEL_VALUE_TYPE" }),
    );

    const interpolationIssues = registrationIssues(
      new Runtime({ hostModules: modules }),
      "no-result-interpolation",
      parse(`
"arc";
import Store from "host:store";
function Main() {
  let text = Str();
  text.$set(\`result: \${Store.archive(Artifact("notes/a.md"))}\`);
}
`),
    );
    expect(interpolationIssues).toContainEqual(
      expect.objectContaining({ code: "INVALID_TEMPLATE_INTERPOLATION" }),
    );
  });
});

describe("runtime host module analysis", () => {
  it("environment free analysis retains dynamic host call evidence", () => {
    const document = parse(`
"arc";
import Store from "host:store";

function Main() {
  let text = Str();
  text.$set(Store.lookup("name"));
}
`);

    expect(analyzeDocument(document).issues).toEqual([]);
    expect(
      registrationIssues(
        new Runtime({ hostModules: hostModules() }),
        "main",
        document,
      ),
    ).toContainEqual(expect.objectContaining({ code: "CELL_VALUE_TYPE" }));

    expect(() =>
      parse(`
"arc";
import Store from "host:store";
function Main() {
  if (Store.lookup("name") == Artifact("notes/a.md")) {}
}
`),
    ).not.toThrow();
  });

  it("runtime add rejects an undeclared imported host module atomically", () => {
    const runtime = new Runtime({ hostModules: hostModules() });
    const issues = registrationIssues(
      runtime,
      "missing-module",
      parse(`
"arc";
import Missing from "host:missing";
function Main() {
  let value = Str();
  value.$set(Missing.call());
}
`),
    );

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "HOST_MODULE_UNDECLARED" }),
    );
    expect(runtime.has(toArcRef("missing-module", "Main"))).toBe(false);
  });

  it("runtime add rejects missing members and invoked namespaces atomically", () => {
    const cases = [
      {
        code: "HOST_MEMBER_UNDECLARED",
        expression: "Store.missing()",
      },
      { code: "HOST_MEMBER_NOT_OPERATION", expression: "Store.home()" },
    ];
    for (const entry of cases) {
      const runtime = new Runtime({ hostModules: hostModules() });
      const issues = registrationIssues(
        runtime,
        `bad-path-${entry.code}`,
        parse(`
"arc";
import Store from "host:store";
function Main() {
  let value = Bool();
  value.$set(${entry.expression});
}
`),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ code: entry.code }),
      );
      expect(runtime.has(toArcRef(`bad-path-${entry.code}`, "Main"))).toBe(
        false,
      );
    }
  });

  it("runtime add rejects host argument arity and incompatible operands atomically", () => {
    const cases = [
      { code: "HOST_ARGUMENT_ARITY", argument: "" },
      { code: "HOST_ARGUMENT_TYPE", argument: "1" },
    ];
    for (const entry of cases) {
      const runtime = new Runtime({ hostModules: hostModules() });
      const issues = registrationIssues(
        runtime,
        `bad-argument-${entry.code}`,
        parse(`
"arc";
import Store from "host:store";
function Main() {
  let value = Artifact();
  value.$set(Store.lookup(${entry.argument}));
}
`),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({ code: entry.code }),
      );
      expect(runtime.has(toArcRef(`bad-argument-${entry.code}`, "Main"))).toBe(
        false,
      );
    }
  });

  it("runtime add rejects object host arguments without a supported spec", () => {
    const issues = registrationIssues(
      new Runtime({ hostModules: hostModules() }),
      "object-argument",
      parse(`
"arc";
import Store from "host:store";
function Main() {
  let value = Artifact();
  value.$set(Store.lookup({ name: "note" }));
}
`),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "HOST_ARGUMENT_TYPE" }),
    );
  });

  it("runtime add uses declared results in cell and return writes", () => {
    const cases = [
      `
let text = Str();
text.$set(Store.lookup("name"));
`,
      `
function Child(returns = { text: Str() }) {
  this.effects = () => {
    returns.text.$set(Store.lookup("name"));
  };
}
$enter(Child);
`,
    ];
    for (const [index, body] of cases.entries()) {
      const issues = registrationIssues(
        new Runtime({ hostModules: hostModules() }),
        `result-write-${index}`,
        parse(`
"arc";
import Store from "host:store";
function Main() {
${body}
}
`),
      );
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: index === 0 ? "CELL_VALUE_TYPE" : "CHANNEL_VALUE_TYPE",
        }),
      );
    }
  });

  it("runtime add uses declared results in boolean numeric string artifact and comparison rules", () => {
    const modules = new Map([
      [
        "typed",
        hmd.define({
          artifact: () => hmd.Artifact(),
          boolean: () => hmd.Bool(),
          number: () => hmd.Num(),
          string: () => hmd.Str(),
        }),
      ],
    ]);
    const incompatibleBodies = [
      "if (Typed.string()) {}",
      "let n = Num(); n.$set(Typed.string() + 1);",
      "let a = Artifact(); a.$set(Artifact(Typed.boolean()));",
      'let b = Bool(); b.$set(Typed.artifact() == "x.md");',
    ];
    for (const [index, body] of incompatibleBodies.entries()) {
      expect(() =>
        new Runtime({ hostModules: modules }).add(
          `typed-consumer-${index}`,
          parse(`
"arc";
import Typed from "host:typed";
function Main() {
  ${body}
}
`),
        ),
      ).toThrowError(RuntimeRegistrationError);
    }

    expect(() =>
      new Runtime({ hostModules: modules }).add(
        "typed-string-consumer",
        parse(`
"arc";
import Typed from "host:typed";
function Main() {
  let text = Str();
  text.$set(\`\${Typed.artifact()}\`);
}
`),
      ),
    ).not.toThrow();
  });

  it("runtime init retains its separate cross document compatibility responsibility", () => {
    const runtime = new Runtime({ hostModules: hostModules() })
      .add(
        "caller",
        parse(`
"arc";
import { Op } from "provider";
function Main() {
  let input = Str();
  $enter(Op, { args: { value: input } });
}
`),
      )
      .add(
        "provider",
        parse(`
"arc";
function Op(args = { value: Bool() }) {}
`),
      );

    expect(() => runtime.init()).toThrowError(RuntimeRegistrationError);
  });

  it("accepts declared expression and standalone calls with admitted operands", () => {
    const document = parse(`
"arc";
import Store from "host:store";

function Main() {
  let artifact = Artifact("notes/a.md");
  let found = Artifact();
  found.$set(Store.lookup("name"));
  this.effects = () => {
    Store.$archive(artifact);
  };
}
`);

    const runtime = new Runtime({ hostModules: hostModules() })
      .add("main", document)
      .init();
    expect(runtime).toBeInstanceOf(Runtime);
  });
});

describe("runtime host module boundaries", () => {
  it("all host-call briefs carry unsigiled operation names", () => {
    const modules = new Map([
      ["service", hmd.define({ run: () => hmd.Bool(), finish: () => {} })],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "brief-operation",
        parse(`
"arc";
import Service from "host:service";
function Main() {
  let result = Bool();
  result.$set(Service.run());
  this.effects = () => {
    Service.$finish();
  };
}
`),
      )
      .init();

    const call = actionProgress(
      runtime.enterArc(toArcRef("brief-operation", "Main"), EMPTY_DIALOG),
    );
    expect(call.hostCalls[0]?.operation).toBe("run");
    const effect = progressBrief(runtime, call, {
      move: "proceed",
      hostCalls: {
        [call.hostCalls[0]!.id]: { status: "resolved", value: true },
      },
    });
    expect(effect.hostCalls[0]?.operation).toBe("finish");
  });

  it("host calls admit concrete arguments before emitting a brief", () => {
    const modules = new Map([
      [
        "paint",
        hmd.define({
          choose: (color = hmd.Enum(["red", "blue"])) => hmd.Bool(),
        }),
      ],
    ]);
    const source = (value: string) => `
"arc";
import Paint from "host:paint";
function Main() {
  let color = Str();
  let accepted = Bool();
  color.$set(${JSON.stringify(value)});
  accepted.$set(Paint.choose(color));
}
`;

    const accepted = new Runtime({ hostModules: modules })
      .add("accepted-color", parse(source("red")))
      .init();
    const call = actionProgress(
      accepted.enterArc(toArcRef("accepted-color", "Main"), EMPTY_DIALOG),
    );
    expect(call.hostCalls[0]?.arguments).toEqual(["red"]);

    const rejected = new Runtime({ hostModules: modules })
      .add("rejected-color", parse(source("green")))
      .init();
    const terminal = startTerminal(
      rejected,
      [rejected.newTraversal(toArcRef("rejected-color", "Main"))].map(
        (traversal) => ({ ...traversal, phase: "entered" as const }),
      ),
      EMPTY_DIALOG,
    );
    expect("hostCalls" in terminal).toBe(false);
    expect(terminal.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "invalid-host-argument" }),
    );
  });

  it("this.effects stops at the first standalone host call", () => {
    const modules = new Map([
      [
        "paint",
        hmd.define({
          record: (color = hmd.Enum(["red", "blue"])) => {},
        }),
      ],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "effect-batch-admission",
        parse(`
"arc";
import Paint from "host:paint";
function Main() {
  let invalid = Str();
  invalid.$set("green");
  this.effects = () => {
    Paint.$record("red");
    Paint.$record(invalid);
  };
}
`),
      )
      .init();
    const traversal = runtime.newTraversal(
      toArcRef("effect-batch-admission", "Main"),
    );
    traversal.phase = "entered";
    const first = startRun(runtime, [traversal], EMPTY_DIALOG);

    expect(first.hostCalls).toHaveLength(1);
    expect(first.hostCalls[0]).toMatchObject({
      module: "paint",
      operation: "record",
      arguments: ["red"],
    });
    expect(first.issues).toEqual([]);

    const terminal = runtime.progress(
      first,
      { move: "proceed", hostCalls: resolvedHostCalls(first) },
      EMPTY_DIALOG,
    );

    expect(terminal.canProgress).toBe(false);
    expect(terminal.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "invalid-host-argument" }),
    );
  });

  it("semantic text parameters preserve structured SemanticText", () => {
    const modules = new Map([
      [
        "notes",
        hmd.define({
          record: (text = hmd.SemanticText()) => hmd.Bool(),
        }),
      ],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "semantic-text-parameter",
        parse(`
"arc";
import Notes from "host:notes";
function Main() {
  let note = Artifact("notes/a.md");
  let accepted = Bool();
  accepted.$set(Notes.record(\`Read \${note} for \${user}\`));
}
`),
      )
      .init();
    const brief = actionProgress(
      runtime.enterArc(
        toArcRef("semantic-text-parameter", "Main"),
        EMPTY_DIALOG,
      ),
    );

    expect(brief.hostCalls[0]?.arguments[0]).toEqual([
      { kind: "text", value: "Read " },
      { kind: "artifact", path: "notes/a.md" },
      { kind: "text", value: " for " },
      { kind: "entity", name: "user" },
    ]);
  });

  it("string parameters accept plain rendered semantic strings and reject structured semantic text", () => {
    const argument: HostCallArgument = {
      kind: "semantic",
      value: { kind: "literal", value: "plain" },
    };
    expect(admitHostArgument(argument, "plain", { type: "string" })).toEqual({
      admitted: true,
    });
    expect(
      admitHostArgument(argument, [{ kind: "entity", name: "user" }], {
        type: "string",
      }),
    ).toMatchObject({
      admitted: false,
      violation: { path: "$" },
    });
  });

  it("enum and numeric host parameters apply exact concrete admission", () => {
    const valueArgument: HostCallArgument = {
      kind: "value",
      value: { kind: "literal", value: "red" },
    };
    expect(
      admitHostArgument(valueArgument, "green", {
        type: "enum",
        values: ["red", "blue"],
      }),
    ).toMatchObject({ admitted: false, violation: { path: "$" } });
    expect(
      admitHostArgument(
        { kind: "value", value: { kind: "literal", value: 1 } },
        Number.POSITIVE_INFINITY,
        { type: "number" },
      ),
    ).toMatchObject({ admitted: false, violation: { path: "$" } });
  });

  it("recursive array and tuple parameters report the exact failing path", () => {
    const argument: HostCallArgument = {
      kind: "array",
      elements: [
        { kind: "semantic", value: { kind: "literal", value: "label" } },
        {
          kind: "array",
          elements: [{ kind: "value", value: { kind: "literal", value: 1 } }],
        },
      ],
    };
    expect(
      admitHostArgument(
        argument,
        ["label", [Number.POSITIVE_INFINITY]],
        {
          type: "tuple",
          elements: [
            { type: "string" },
            { type: "array", element: { type: "number" } },
          ],
        },
        "$[0]",
      ),
    ).toMatchObject({
      admitted: false,
      violation: { path: "$[0][1][0]" },
    });
  });

  it("typed host call results reject only the invalid report item and reemit it", () => {
    const modules = new Map([
      [
        "gates",
        hmd.define({ left: () => hmd.Bool(), right: () => hmd.Bool() }),
      ],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "typed-result-siblings",
        parse(`
"arc";
import Gates from "host:gates";
function Left() {
  this.trigger = () => Gates.left();
}
function Right() {
  this.trigger = () => Gates.right();
}
`),
      )
      .init();
    const first = runtime.startTrigger([], EMPTY_DIALOG);
    expect(first.hostCalls).toHaveLength(2);
    const left = first.hostCalls.find((call) => call.operation === "left")!;
    const right = first.hostCalls.find((call) => call.operation === "right")!;
    const retried = runtime.progressTrigger(
      first,
      {
        hostCalls: {
          [left.id]: { status: "resolved", value: false },
          [right.id]: { status: "resolved", value: "invalid" },
        },
      },
      EMPTY_DIALOG,
    );

    expect(retried.hostCalls.map((call) => call.id)).toEqual([right.id]);
    expect(retried.issues).toContainEqual(
      expect.objectContaining({
        briefId: right.id,
        reasonCode: "host-call-result-type",
      }),
    );
  });

  it("typed host call results accept valid siblings and retain generic sanitation", () => {
    const modules = new Map([
      [
        "gates",
        hmd.define({ left: () => hmd.Bool(), right: () => hmd.Bool() }),
      ],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "typed-result-generic-sanitization",
        parse(`
"arc";
import Gates from "host:gates";
function Left() {
  this.trigger = () => Gates.left();
}
function Right() {
  this.trigger = () => Gates.right();
}
`),
      )
      .init();
    const first = runtime.startTrigger([], EMPTY_DIALOG);
    const left = first.hostCalls.find((call) => call.operation === "left")!;
    const right = first.hostCalls.find((call) => call.operation === "right")!;
    const retried = runtime.progressTrigger(
      first,
      {
        hostCalls: {
          [left.id]: { status: "resolved", value: false },
          [right.id]: { status: "resolved", value: Number.POSITIVE_INFINITY },
        },
      },
      EMPTY_DIALOG,
    );

    expect(retried.hostCalls.map((call) => call.id)).toEqual([right.id]);
    expect(retried.issues).toContainEqual(
      expect.objectContaining({
        briefId: right.id,
        reasonCode: "host-call-non-finite-number",
      }),
    );
    const matched = runtime.progressTrigger(
      retried,
      { hostCalls: { [right.id]: { status: "resolved", value: true } } },
      EMPTY_DIALOG,
    );
    expect(matched.matched).toBe(
      toArcRef("typed-result-generic-sanitization", "Right"),
    );
  });

  it("typed host call results preserve explicit unset independently of the result spec", () => {
    const modules = new Map([
      ["values", hmd.define({ value: () => hmd.Str() })],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "typed-result-unset",
        parse(`
"arc";
import Values from "host:values";
function Main() {
  let value = Str();
  value.$set("initial");
  value.$set(Values.value());
}
`),
      )
      .init();
    const first = actionProgress(
      runtime.enterArc(toArcRef("typed-result-unset", "Main"), EMPTY_DIALOG),
    );
    const terminal = runtime.progress(
      first,
      {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: undefined },
        },
      },
      EMPTY_DIALOG,
    );

    expect(terminal).toMatchObject({
      canProgress: false,
      outcome: "poisoned",
    });
    expect(rootTraversal(terminal).phase).toBe("poisoned");
    expect(rootTraversal(terminal).cells.value).toBe("initial");
    expect(terminal.issues).toContainEqual(
      expect.objectContaining({
        kind: "poisoned-traversal",
        reasonCode: "invalid-cell-assignment",
        reason: "value.$set() requires a set value",
      }),
    );
    expect(terminal.issues).not.toContainEqual(
      expect.objectContaining({ reasonCode: "host-call-result-type" }),
    );
  });

  it("typed Artifact results use their declaration rather than payload shape", () => {
    const modules = new Map([
      [
        "values",
        hmd.define({
          artifact: () => hmd.Artifact(),
          text: () => hmd.Str(),
        }),
      ],
    ]);
    const artifactRuntime = new Runtime({ hostModules: modules })
      .add(
        "typed-artifact-result",
        parse(`
"arc";
import Values from "host:values";
function Main() {
  let value = Artifact();
  value.$set(Values.artifact());
}
`),
      )
      .init();
    const artifactCall = actionProgress(
      artifactRuntime.enterArc(
        toArcRef("typed-artifact-result", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const artifactDone = artifactRuntime.progress(
      artifactCall,
      {
        move: "proceed",
        hostCalls: {
          [artifactCall.hostCalls[0]!.id]: {
            status: "resolved",
            value: createArtifactValue("notes/a.md"),
          },
        },
      },
      EMPTY_DIALOG,
    );
    expect(rootTraversal(artifactDone).cells.value).toEqual(
      createArtifactValue("notes/a.md"),
    );

    const stringRuntime = new Runtime({ hostModules: modules })
      .add(
        "typed-string-result",
        parse(`
"arc";
import Values from "host:values";
function Main() {
  let value = Str();
  value.$set(Values.text());
}
`),
      )
      .init();
    const stringCall = actionProgress(
      stringRuntime.enterArc(
        toArcRef("typed-string-result", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const rejected = progressBrief(stringRuntime, stringCall, {
      move: "proceed",
      hostCalls: {
        [stringCall.hostCalls[0]!.id]: {
          status: "resolved",
          value: createArtifactValue("notes/a.md"),
        },
      },
    });
    expect(rejected.hostCalls[0]?.id).toBe(stringCall.hostCalls[0]!.id);
    expect(rejected.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "host-call-result-type" }),
    );
  });

  it("trigger and action host calls enforce the same result specs", () => {
    const modules = new Map([
      ["gate", hmd.define({ ready: () => hmd.Bool() })],
    ]);
    const runtime = new Runtime({ hostModules: modules })
      .add(
        "typed-trigger-action",
        parse(`
"arc";
import Gate from "host:gate";
function Main() {
  this.trigger = () => Gate.ready();
  if (Gate.ready()) {}
}
`),
      )
      .init();
    const trigger = runtime.startTrigger([], EMPTY_DIALOG);
    const triggerRetry = runtime.progressTrigger(
      trigger,
      {
        hostCalls: {
          [trigger.hostCalls[0]!.id]: { status: "resolved", value: "invalid" },
        },
      },
      EMPTY_DIALOG,
    );
    expect(triggerRetry.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "host-call-result-type" }),
    );

    const traversal = runtime.newTraversal(
      toArcRef("typed-trigger-action", "Main"),
    );
    traversal.phase = "entered";
    const action = startRun(runtime, [traversal], EMPTY_DIALOG);
    const actionRetry = progressBrief(runtime, action, {
      move: "proceed",
      hostCalls: {
        [action.hostCalls[0]!.id]: { status: "resolved", value: "invalid" },
      },
    });
    expect(actionRetry.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "host-call-result-type" }),
    );
  });

  it("accepted typed results pin and replay without persisted spec evidence", () => {
    const modules = new Map([
      ["gate", hmd.define({ ready: () => hmd.Bool() })],
    ]);
    const source = `
"arc";
import Gate from "host:gate";
function Main() {
  let topic = Str({ observing: \`topic\` });
  if (Gate.ready()) {
    $observe(topic);
  }
}
`;
    const runtime = new Runtime({ hostModules: modules })
      .add("typed-result-pin-replay", parse(source))
      .init();
    const call = actionProgress(
      runtime.enterArc(
        toArcRef("typed-result-pin-replay", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const blocked = progressBrief(runtime, call, {
      move: "proceed",
      hostCalls: {
        [call.hostCalls[0]!.id]: { status: "resolved", value: true },
      },
    });
    expect(blocked.observations).toHaveLength(1);

    const restored = JSON.parse(
      JSON.stringify(blocked.traversals),
    ) as ArcTraversalSet;
    const entries = Object.values(
      restored[0]!.frame.pinTapes[nodeSegKey("body")] ?? {},
    ).flat();
    expect(entries.find((entry) => entry.kind === "hostCall")).toEqual({
      kind: "hostCall",
      briefId: call.hostCalls[0]!.id,
      resolved: true,
      hasValue: true,
      value: true,
    });

    const restarted = new Runtime({ hostModules: modules })
      .add("typed-result-pin-replay", parse(source))
      .init();
    const replayed = startRun(restarted, restored, EMPTY_DIALOG);
    expect(replayed.hostCalls).toHaveLength(0);
    expect(replayed.observations).toHaveLength(1);
  });

  it("restored pins rederive host result evidence from the original action path", () => {
    const modules = new Map([
      ["files", hmd.define({ current: () => hmd.Artifact() })],
    ]);
    const source = `
"arc";
import Files from "host:files";
function Main() {
  let confirmed = Bool({ observing: \`whether the file is confirmed\` });
  if (Files.current() == Artifact("notes/current.md")) {
    $observe(confirmed);
  }
}
`;
    const runtime = new Runtime({ hostModules: modules })
      .add("typed-artifact-pin-evidence", parse(source))
      .init();
    const call = actionProgress(
      runtime.enterArc(
        toArcRef("typed-artifact-pin-evidence", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const blocked = progressBrief(runtime, call, {
      move: "proceed",
      hostCalls: {
        [call.hostCalls[0]!.id]: {
          status: "resolved",
          value: createArtifactValue("notes/current.md"),
        },
      },
    });
    expect(blocked.observations).toHaveLength(1);

    const restored = JSON.parse(
      JSON.stringify(blocked.traversals),
    ) as ArcTraversalSet;
    const restarted = new Runtime({ hostModules: modules })
      .add("typed-artifact-pin-evidence", parse(source))
      .init();
    const replayed = startRun(restarted, restored, EMPTY_DIALOG);

    expect(replayed.hostCalls).toHaveLength(0);
    expect(replayed.observations).toHaveLength(1);
    expect(replayed.issues).not.toContainEqual(
      expect.objectContaining({ reasonCode: "invalid-comparison-operands" }),
    );
  });
});
