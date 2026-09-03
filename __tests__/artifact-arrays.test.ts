import { describe, expect, it } from "vitest";

import { hmd } from "../src/host-utils/index.js";
import { analyzeDocument, parse, validate } from "../src/parser/index.js";
import type {
  ArrayValue as RuntimeArrayValue,
  PrimitiveArrayValue as RuntimePrimitiveArrayValue,
} from "../src/runtime/index.js";
import {
  isPrimitiveArrayValue,
  Runtime,
  RuntimeRegistrationError,
} from "../src/runtime/index.js";
import type {
  ArcTraversalSet,
  ArrayElementSpec,
  ArrayValue,
  ArtifactArrayCell,
  ArtifactArraySpec,
  HostModuleSpec,
  PrimitiveArrayValue,
} from "../src/types/index.js";
import { createArtifactValue } from "../src/value-utils.js";

import {
  actionProgress,
  actionTerminal,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  rootTraversal,
  settleTransitions,
  startTerminal,
} from "./helpers.js";

function terminal(source: string, id: string) {
  const runtime = new Runtime().add(id, parse(source)).init();
  const traversal = runtime.newTraversal(arc(id, "Main"));
  traversal.phase = "entered";
  return startTerminal(runtime, [traversal], EMPTY_DIALOG);
}

function hostModules(
  declaration: HostModuleSpec,
): ReadonlyMap<string, HostModuleSpec> {
  return new Map([["artifacts", declaration]]);
}

describe("Artifact arrays", () => {
  it("artifact-array.type-ownership exports stored and primitive array domains from public barrels", () => {
    const element: ArrayElementSpec = { type: "artifact" };
    const spec: ArtifactArraySpec = { type: "array", element };
    const stored: ArrayValue = [createArtifactValue("stored.md")];
    const runtimeStored: RuntimeArrayValue = stored;
    const observed: PrimitiveArrayValue = ["plain", 1, true];
    const runtimeObserved: RuntimePrimitiveArrayValue = observed;

    expect(spec).toEqual({ type: "array", element: { type: "artifact" } });
    expect(runtimeStored).toEqual([createArtifactValue("stored.md")]);
    expect(isPrimitiveArrayValue(runtimeStored)).toBe(false);
    expect(isPrimitiveArrayValue(runtimeObserved)).toBe(true);
  });

  it("artifact-array.declaration parses cell and channel specs and rejects invalid element forms", () => {
    const document = parse(`
"arc";
function Main(
  args = { input: Array(Artifact()) },
  returns = { output: Array(Artifact()) },
) {
  let values = Array(Artifact());
}
`);

    expect(document.roots[0]?.cells[0]).toMatchObject({
      name: "values",
      type: "array",
      element: { type: "artifact" },
    });
    expect(document.roots[0]?.signature).toEqual({
      args: { input: { type: "array", element: { type: "artifact" } } },
      returns: { output: { type: "array", element: { type: "artifact" } } },
    });
    expect(() =>
      parse(`"arc"; function Main() { let values = Array(Artifact("x.md")); }`),
    ).toThrow(/Artifact\(\) element takes no arguments/);
    expect(() =>
      parse(
        `"arc"; function Main(args = { values: Array(Array(Artifact())) }) {}`,
      ),
    ).toThrow(/cannot nest arrays/);
    expect(() =>
      parse(`"arc"; function Main() { let values = Array(Dialog.Cursor()); }`),
    ).toThrow(/scalar or Artifact cell constructor/);
    expect(() =>
      parse(`"arc"; function Main() { let values = Array(Index()); }`),
    ).toThrow(/scalar or Artifact cell constructor/);
  });

  it("artifact-array.public-ir rejects declaration metadata on Artifact elements through validate and Runtime.add", () => {
    const document = parse(`
"arc";
function Main(args = { input: Array(Artifact()) }) {
  let values = Array(Artifact());
}
`);
    const root = document.roots[0]!;
    (root.cells[0] as ArtifactArrayCell).element = {
      type: "artifact",
      observing: { kind: "literal", value: "invalid" },
    } as never;
    (root.signature!.args.input as { element: object }).element = {
      type: "artifact",
      initializer: { kind: "literal", value: "invalid" },
    };

    expect(validate(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_SPEC",
          message: expect.stringContaining("observing"),
        }),
        expect.objectContaining({
          code: "INVALID_SPEC",
          message: expect.stringContaining("initializer"),
        }),
      ]),
    );
    expect(() => new Runtime().add("artifact-array-ir", document)).toThrow(
      RuntimeRegistrationError,
    );
  });

  it("artifact-array.observation rejects whole, indexed, grouped, and observe-or-ask targets", () => {
    const statements = [
      "$observe(values);",
      "$observe(values[0]);",
      "$observe({ values });",
      "$observeOrAsk(values);",
      "$observeOrAsk(values[0]);",
      "$observeOrAsk({ values });",
    ];
    for (const statement of statements) {
      expect(() =>
        parse(`
"arc";
function Main() {
  let values = Array(Artifact());
  values.$set([Artifact("one.md")]);
  ${statement}
}
`),
      ).toThrow(/requires an observable cell/);
    }
  });

  it("artifact-array.dead-read reports never-assigned and read-before-set arrays without flagging initialized Artifacts", () => {
    const neverAssignedBodies = [
      "count.$set(values.length);",
      "copy.$set(values[0]);",
      "values.$map(() => {});",
      'values[0].$set(Artifact("replacement.md"));',
    ];
    for (const body of neverAssignedBodies) {
      const neverAssigned = analyzeDocument(
        parse(`
"arc";
function Main() {
  let values = Array(Artifact());
  let count = Num();
  let copy = Artifact();
  ${body}
}
`),
      ).lintIssues.filter((issue) => issue.code.startsWith("read-"));
      expect(neverAssigned).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    }

    const readBeforeSet = analyzeDocument(
      parse(`
"arc";
function Main() {
  let values = Array(Artifact());
  let count = Num();
  count.$set(values.length);
  values.$set([]);
}
`),
    ).lintIssues.filter((issue) => issue.code.startsWith("read-"));
    expect(readBeforeSet).toEqual([
      expect.objectContaining({
        code: "read-before-assignment",
        severity: "notice",
      }),
    ]);

    const initialized = analyzeDocument(
      parse(`
"arc";
function Main() {
  let source = Artifact("source.md");
  let copy = Artifact();
  copy.$set(source);
}
`),
    ).lintIssues.filter((issue) => issue.code.startsWith("read-"));
    expect(initialized).toEqual([]);
  });

  it("artifact-array.cells support whole and indexed writes, reads, length, and structural equality", () => {
    const brief = terminal(
      `
"arc";
function Main() {
  let values = Array(Artifact());
  let empty = Array(Artifact());
  let cleared = Array(Artifact());
  let wasSet = Bool();
  let first = Artifact();
  let count = Num();
  let equal = Bool();
  let unequal = Bool();

  values.$set([Artifact("one.md"), Artifact("two.md")]);
  values[1].$set(Artifact("changed.md"));
  first.$set(values[0]);
  count.$set(values.length);
  equal.$set(values == [Artifact("one.md"), Artifact("changed.md")]);
  unequal.$set(values != [Artifact("one.md"), Artifact("other.md")]);
  empty.$set([]);
  cleared.$set([Artifact("temporary.md")]);
  if (cleared.isUnset() == false) {
    wasSet.$set(true);
  }
  cleared.$unset();
}
`,
      "artifact-array-cells",
    );

    expect(rootTraversal(brief).cells).toMatchObject({
      values: [
        createArtifactValue("one.md"),
        createArtifactValue("changed.md"),
      ],
      first: createArtifactValue("one.md"),
      count: 2,
      equal: true,
      unequal: true,
      empty: [],
      wasSet: true,
    });
    expect(rootTraversal(brief).cells.cleared).toBeUndefined();
  });

  it("artifact-array.conditional landing accepts only branches compatible with Artifact elements", () => {
    expect(() =>
      parse(`
"arc";
function Main() {
  let chooseFirst = Bool();
  let values = Array(Artifact());
  chooseFirst.$set(true);
  values.$set(
    chooseFirst == true ? [Artifact("one.md")] : [Artifact("two.md")],
  );
}
`),
    ).not.toThrow();

    expect(() =>
      parse(`
"arc";
function Main() {
  let chooseFirst = Bool();
  let values = Array(Artifact());
  chooseFirst.$set(true);
  values.$set(chooseFirst == true ? [Artifact("one.md")] : ["wrong"]);
}
`),
    ).toThrow(/CELL_VALUE_TYPE/);
  });

  it("artifact-array.interpolation rejects whole arrays and preserves indexed Artifact projection", () => {
    expect(() =>
      parse(`
"arc";
function Main() {
  let values = Array(Artifact());
  values.$set([Artifact("one.md")]);
  $instruct(\`Use \${values}.\`);
}
`),
    ).toThrow(/INVALID_TEMPLATE_INTERPOLATION/);

    const runtime = new Runtime()
      .add(
        "artifact-array-indexed-interpolation",
        parse(`
"arc";
function Main() {
  let values = Array(Artifact());
  let path = Str();
  values.$set([Artifact("one.md")]);
  path.$set(\`\${values[0]}\`);
  $instruct(\`Use \${values[0]}.\`);
}
`),
      )
      .init();
    const brief = actionProgress(
      runtime.enterArc(
        arc("artifact-array-indexed-interpolation", "Main"),
        EMPTY_DIALOG,
      ),
    );
    expect(rootTraversal(brief).cells.path).toBe("one.md");
    expect(brief.instructions[0]?.text).toEqual([
      { kind: "text", value: "Use " },
      { kind: "artifact", path: "one.md" },
      { kind: "text", value: "." },
    ]);
  });

  it("artifact-array.channels clone direct args and cross child and root returns", () => {
    const source = `
"arc";
function Main(
  args = { input: Array(Artifact()) },
  returns = { output: Array(Artifact()) },
) {
  let childOutput = Array(Artifact());
  $enter(Child, {
    args: { input: args.input },
    returns: { output: childOutput },
  });
  this.effects = () => {
    returns.output.$set(childOutput);
  };

  function Child(
    args = { input: Array(Artifact()) },
    returns = { output: Array(Artifact()) },
  ) {
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`;
    const runtime = new Runtime()
      .add("artifact-array-channels", parse(source))
      .init();
    const supplied = [createArtifactValue("input.md")];
    const terminalBrief = actionTerminal(
      settleTransitions(
        runtime,
        runtime.enterArc(arc("artifact-array-channels", "Main"), EMPTY_DIALOG, {
          args: { input: supplied },
        }),
        EMPTY_DIALOG,
      ),
    );
    (supplied[0] as { path: string }).path = "mutated.md";

    expect(rootTraversal(terminalBrief).cells.childOutput).toEqual([
      createArtifactValue("input.md"),
    ]);
    expect(terminalBrief.returns?.output).toEqual([
      createArtifactValue("input.md"),
    ]);
    expect(() =>
      runtime.enterArc(arc("artifact-array-channels", "Main"), EMPTY_DIALOG, {
        args: { input: [{ path: "/invalid.md" }] },
      }),
    ).toThrow(/\$\[0\]/);
  });

  it("artifact-array.runtime-init validates imported array and map bindings in either add order", () => {
    const caller = parse(`
"arc";
import { ItemOp, Pipe } from "artifact-array-ops";
function Main() {
  let input = Array(Artifact());
  let piped = Array(Artifact());
  let mapped = Array(Artifact());
  input.$set([Artifact("one.md")]);
  $enter(Pipe, { args: { input }, returns: { output: piped } });
  input.$map(() => {
    $enter(newcopy(ItemOp), {
      args: { input: span.item },
      returns: { output: span.result },
    });
  }, mapped);
}
`);
    const compatible = parse(`
"arc";
function Pipe(
  args = { input: Array(Artifact()) },
  returns = { output: Array(Artifact()) },
) {
  this.effects = () => { returns.output.$set(args.input); };
}
function ItemOp(
  args = { input: Artifact() },
  returns = { output: Artifact() },
) {
  this.effects = () => { returns.output.$set(args.input); };
}
`);

    expect(() =>
      new Runtime()
        .add("artifact-array-caller-a", caller)
        .add("artifact-array-ops", compatible)
        .init(),
    ).not.toThrow();
    expect(() =>
      new Runtime()
        .add("artifact-array-ops", compatible)
        .add("artifact-array-caller-b", caller)
        .init(),
    ).not.toThrow();

    const incompatible = parse(`
"arc";
function Pipe(
  args = { input: Array(Str()) },
  returns = { output: Array(Str()) },
) {}
function ItemOp(
  args = { input: Str() },
  returns = { output: Str() },
) {}
`);
    expect(() =>
      new Runtime()
        .add("artifact-array-caller-invalid", caller)
        .add("artifact-array-ops", incompatible)
        .init(),
    ).toThrow(RuntimeRegistrationError);
  });

  it("artifact-array.map carries Artifact authority through span.item and span.result", () => {
    const brief = terminal(
      `
"arc";
function Main() {
  let input = Array(Artifact());
  let output = Array(Artifact());
  input.$set([Artifact("one.md"), Artifact("two.md")]);
  input.$map(() => span.result.$set(span.item), output);
}
`,
      "artifact-array-map",
    );

    expect(rootTraversal(brief).cells.output).toEqual([
      createArtifactValue("one.md"),
      createArtifactValue("two.md"),
    ]);
  });

  it("artifact-array.map admits child args and child returns through Artifact span authority", () => {
    const brief = terminal(
      `
"arc";
function Main() {
  let input = Array(Artifact());
  let output = Array(Artifact());
  input.$set([Artifact("one.md"), Artifact("two.md")]);
  input.$map(() => {
    $enter(newcopy(Op), {
      args: { input: span.item },
      returns: { output: span.result },
    });
  }, output);

  function Op(
    args = { input: Artifact() },
    returns = { output: Artifact() },
  ) {
    this.effects = () => { returns.output.$set(args.input); };
  }
}
`,
      "artifact-array-map-child",
    );

    expect(rootTraversal(brief).cells.output).toEqual([
      createArtifactValue("one.md"),
      createArtifactValue("two.md"),
    ]);
  });

  it("artifact-array.map restores pinned and staged Artifact values across JSON", () => {
    const source = `
"arc";
function Main() {
  let input = Array(Artifact());
  let output = Array(Artifact());
  let gate = Bool();
  input.$set([Artifact("first.md"), Artifact("second.md")]);
  input.$map(() => {
    span.result.$set(span.item);
    $observeOrAsk(gate);
  }, output);
}
`;
    const runtime = new Runtime()
      .add("artifact-array-map-json", parse(source))
      .init();
    const traversal = runtime.newTraversal(
      arc("artifact-array-map-json", "Main"),
    );
    traversal.phase = "entered";
    const first = actionProgress(runtime.start([traversal], EMPTY_DIALOG));
    const second = actionProgress(
      runtime.progress(
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: true },
          },
        },
        EMPTY_DIALOG,
      ),
    );
    const restored = JSON.parse(
      JSON.stringify(second.traversals),
    ) as ArcTraversalSet;
    const fresh = new Runtime()
      .add("artifact-array-map-json", parse(source))
      .init();
    const revived = actionProgress(fresh.start(restored, EMPTY_DIALOG));
    const done = progressTerminal(fresh, revived, {
      move: "proceed",
      observations: {
        [revived.observations[0]!.id]: { status: "resolved", value: true },
      },
    });

    expect(rootTraversal(done).cells.output).toEqual([
      createArtifactValue("first.md"),
      createArtifactValue("second.md"),
    ]);
  });

  it("artifact-array.persistence rejects malformed restored members before replay", () => {
    const source = `
"arc";
function Main() {
  let values = Array(Artifact());
  values.$set([Artifact("valid.md")]);
  $instruct(\`hold\`);
}
`;
    const runtime = new Runtime()
      .add("artifact-array-invalid-restoration", parse(source))
      .init();
    const first = actionProgress(
      runtime.enterArc(
        arc("artifact-array-invalid-restoration", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const restored = JSON.parse(
      JSON.stringify(first.traversals),
    ) as ArcTraversalSet;
    const root = restored.find(
      (traversal) => traversal.enteredBy === undefined,
    )!;
    root.cells.values = [{ path: "/invalid.md" }];

    expect(() => runtime.start(restored, EMPTY_DIALOG)).toThrow(
      /Invalid persisted traversal state.*\$\[0\]/,
    );
  });

  it("artifact-array.host-modules admit whole arguments and typed results with indexed diagnostics", () => {
    const declaration = hmd.define({
      accept: (values = hmd.Array(hmd.Artifact())) => hmd.Bool(),
      load: () => hmd.Array(hmd.Artifact()),
    });
    const modules = hostModules(declaration);
    const argumentRuntime = new Runtime({ hostModules: modules })
      .add(
        "artifact-array-host-argument",
        parse(`
"arc";
import Artifacts from "host:artifacts";
function Main() {
  let values = Array(Artifact());
  let accepted = Bool();
  values.$set([Artifact("one.md")]);
  accepted.$set(Artifacts.accept(values));
}
`),
      )
      .init();
    const argumentBrief = actionProgress(
      argumentRuntime.enterArc(
        arc("artifact-array-host-argument", "Main"),
        EMPTY_DIALOG,
      ),
    );
    expect(argumentBrief.hostCalls[0]?.arguments).toEqual([
      [createArtifactValue("one.md")],
    ]);

    const channelRuntime = new Runtime({ hostModules: modules })
      .add(
        "artifact-array-host-channel-argument",
        parse(`
"arc";
import Artifacts from "host:artifacts";
function Main(args = { input: Array(Artifact()) }) {
  let accepted = Bool();
  accepted.$set(Artifacts.accept(args.input));
}
`),
      )
      .init();
    const channelBrief = actionProgress(
      channelRuntime.enterArc(
        arc("artifact-array-host-channel-argument", "Main"),
        EMPTY_DIALOG,
        { args: { input: [createArtifactValue("channel.md")] } },
      ),
    );
    expect(channelBrief.hostCalls[0]?.arguments).toEqual([
      [createArtifactValue("channel.md")],
    ]);

    const inlineRuntime = new Runtime({ hostModules: modules })
      .add(
        "artifact-array-host-inline-argument",
        parse(`
"arc";
import Artifacts from "host:artifacts";
function Main() {
  let accepted = Bool();
  accepted.$set(Artifacts.accept([Artifact("inline.md")]));
}
`),
      )
      .init();
    const inlineBrief = actionProgress(
      inlineRuntime.enterArc(
        arc("artifact-array-host-inline-argument", "Main"),
        EMPTY_DIALOG,
      ),
    );
    expect(inlineBrief.hostCalls[0]?.arguments).toEqual([
      [createArtifactValue("inline.md")],
    ]);

    const resultRuntime = new Runtime({ hostModules: modules })
      .add(
        "artifact-array-host-result",
        parse(`
"arc";
import Artifacts from "host:artifacts";
function Main() {
  let values = Array(Artifact());
  values.$set(Artifacts.load());
  $instruct(\`Use \${values[0]}\`);
}
`),
      )
      .init();
    const resultCall = actionProgress(
      resultRuntime.enterArc(
        arc("artifact-array-host-result", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const resultBrief = progressBrief(resultRuntime, resultCall, {
      move: "proceed",
      hostCalls: {
        [resultCall.hostCalls[0]!.id]: [createArtifactValue("loaded.md")],
      },
    });
    expect(rootTraversal(resultBrief).cells.values).toEqual([
      createArtifactValue("loaded.md"),
    ]);
    expect(resultBrief.instructions[0]?.text).toEqual([
      { kind: "text", value: "Use " },
      { kind: "artifact", path: "loaded.md" },
    ]);

    const invalidRuntime = new Runtime({ hostModules: modules })
      .add(
        "artifact-array-host-result-invalid",
        parse(`
"arc";
import Artifacts from "host:artifacts";
function Main() {
  let values = Array(Artifact());
  values.$set([Artifact("kept.md")]);
  values.$set(Artifacts.load());
}
`),
      )
      .init();
    const invalidCall = actionProgress(
      invalidRuntime.enterArc(
        arc("artifact-array-host-result-invalid", "Main"),
        EMPTY_DIALOG,
      ),
    );
    const retried = progressBrief(invalidRuntime, invalidCall, {
      move: "proceed",
      hostCalls: { [invalidCall.hostCalls[0]!.id]: [{ path: "/bad.md" }] },
    });
    expect(retried.hostCalls[0]?.id).toBe(invalidCall.hostCalls[0]!.id);
    expect(retried.issues).toContainEqual(
      expect.objectContaining({
        reasonCode: "host-call-result-type",
        reason: expect.stringContaining("$[0]"),
      }),
    );
    expect(rootTraversal(retried).cells.values).toEqual([
      createArtifactValue("kept.md"),
    ]);
  });

  it("artifact-array.pin-replay reuses typed host results without persisting provenance", () => {
    const modules = hostModules(
      hmd.define({ load: () => hmd.Array(hmd.Artifact()) }),
    );
    const source = `
"arc";
import Artifacts from "host:artifacts";
function Main() {
  let values = Array(Artifact());
  values.$set(Artifacts.load());
  $instruct(\`Use \${values[0]}\`);
}
`;
    const runtime = new Runtime({ hostModules: modules })
      .add("artifact-array-pin-replay", parse(source))
      .init();
    const call = actionProgress(
      runtime.enterArc(arc("artifact-array-pin-replay", "Main"), EMPTY_DIALOG),
    );
    const blocked = progressBrief(runtime, call, {
      move: "proceed",
      hostCalls: {
        [call.hostCalls[0]!.id]: [createArtifactValue("replayed.md")],
      },
    });
    const serialized = JSON.stringify(blocked.traversals);
    expect(serialized).not.toContain("provenance");
    expect(serialized).not.toContain("$arcNominalType");

    const restored = JSON.parse(serialized) as ArcTraversalSet;
    const fresh = new Runtime({ hostModules: modules })
      .add("artifact-array-pin-replay", parse(source))
      .init();
    const replayed = actionProgress(fresh.start(restored, EMPTY_DIALOG));
    expect(replayed.hostCalls).toHaveLength(0);
    expect(replayed.instructions[0]?.text).toEqual([
      { kind: "text", value: "Use " },
      { kind: "artifact", path: "replayed.md" },
    ]);
    const done = progressTerminal(fresh, replayed, {
      move: "proceed",
      instructions: appliedInstructions(replayed),
    });
    expect(rootTraversal(done).cells.values).toEqual([
      createArtifactValue("replayed.md"),
    ]);
  });
});
