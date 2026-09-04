import { describe, expect, expectTypeOf, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { createArtifactValue, isArtifactValue } from "../src/runtime/index.js";
import type {
  ActionBrief,
  ArcTraversalSet,
  CellValue,
  StateSnapshot,
  TerminalBrief,
} from "../src/types/index.js";
import {
  actionProgress,
  actionTerminal,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressTerminal,
  resolvedHostCalls,
  rootTraversal,
  TestRuntime as Runtime,
  settleTransitions,
} from "./helpers.js";

describe("Arc entry and terminal action output", () => {
  it("proto.arc-entry bypasses trigger consultation and activates only the requested Arc", () => {
    const runtime = new Runtime()
      .add(
        "direct-trigger-bypass",
        parse(`
"arc";

function Direct(args = { input: Str() }) {
  this.trigger = () => {
    if (judge(\`select direct\`)) {
      return true;
    }
    return false;
  };
  $instruct(\`direct: \${args.input}\`);
}

function Other() {
  this.trigger = () => true;
  $instruct(\`other\`);
}
`),
      )
      .init();

    const brief = actionProgress(
      runtime.enterArc(arc("direct-trigger-bypass", "Direct"), EMPTY_DIALOG, {
        args: { input: "ready" },
      }),
    );

    expect(brief.judgments).toEqual([]);
    expect(brief.instructions.map((item) => item.text)).toEqual([
      "direct: ready",
    ]);
    expect(brief.traversals).toHaveLength(1);
    expect(rootTraversal(brief)).toMatchObject({
      ref: arc("direct-trigger-bypass", "Direct"),
      phase: "entered",
      enterCount: 1,
    });
  });

  it("proto.arc-entry reaches the same first frontier as trigger selection", () => {
    const source = `
"arc";
function Main() {
  this.trigger = () => true;
  $instruct(\`first frontier\`);
}
`;
    const directRuntime = new Runtime()
      .add("frontier-equivalence", parse(source))
      .init();
    const direct = actionProgress(
      directRuntime.enterArc(arc("frontier-equivalence", "Main"), EMPTY_DIALOG),
    );

    const triggeredRuntime = new Runtime()
      .add("frontier-equivalence", parse(source))
      .init();
    const trigger = triggeredRuntime.startTrigger([], EMPTY_DIALOG);
    const selected = triggeredRuntime.progressTrigger(
      trigger,
      { preferredMatch: arc("frontier-equivalence", "Main") },
      EMPTY_DIALOG,
    );
    const triggered = actionProgress(
      triggeredRuntime.start(selected.traversals, EMPTY_DIALOG),
    );

    expect(direct.instructions).toEqual(triggered.instructions);
    expect(direct.active).toBe(triggered.active);

    const directTerminal = progressTerminal(directRuntime, direct, {
      move: "proceed",
      instructions: appliedInstructions(direct),
    });
    const triggeredTerminal = progressTerminal(triggeredRuntime, triggered, {
      move: "proceed",
      instructions: appliedInstructions(triggered),
    });
    expect(directTerminal).toMatchObject({
      root: arc("frontier-equivalence", "Main"),
      outcome: "covered",
    });
    expect(triggeredTerminal).toMatchObject({
      root: directTerminal.root,
      outcome: directTerminal.outcome,
    });
  });

  it("proto.arc-entry validates every channel family before execution", () => {
    const runtime = new Runtime()
      .add(
        "root-schema-families",
        parse(`
"arc";
function Main(args = {
  flag: Bool(),
  text: Str(),
  choice: Enum(["a", "b"]),
  amount: Num(),
  position: Index(),
  cursor: Dialog.Cursor(),
  items: Array(Str()),
}) {}
`),
      )
      .init();
    const arcRef = arc("root-schema-families", "Main");
    const validArgs = {
      flag: true,
      text: "value",
      choice: "b",
      amount: -0,
      position: 2,
      cursor: { user: 1, self: 1, view: "review" },
      items: ["x", "y"],
    } satisfies Record<string, CellValue>;

    const terminal = actionTerminal(
      runtime.enterArc(arcRef, EMPTY_DIALOG, { args: validArgs }),
    );
    expect(terminal.outcome).toBe("covered");
    const amountLink = rootTraversal(terminal).enterChannels.args.amount;
    if (amountLink?.kind !== "value") {
      throw new Error("expected a by-value Arc argument link");
    }
    expect(Object.is(amountLink.value, -0)).toBe(false);

    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { missing: true },
      }),
    ).toThrow(/Unknown args channel key/);
    expect(() =>
      runtime.enterArc(arc("root-schema-families", "Missing"), EMPTY_DIALOG),
    ).toThrow(/Unknown arc/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { choice: "c" },
      }),
    ).toThrow(/args\.choice/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { amount: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/finite/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { position: 1.5 },
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { cursor: { user: -1, self: 0 } },
      }),
    ).toThrow(/valid Dialog cursor/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: {
          cursor: {
            user: 0,
            self: 0,
            path: "cursor.md",
            extra: true,
          } as unknown as CellValue,
        },
      }),
    ).toThrow(/valid Dialog cursor/);
    expect(() =>
      runtime.enterArc(arcRef, EMPTY_DIALOG, {
        args: { items: ["x", 1] },
      }),
    ).toThrow(/requires a string value/);
  });

  it("proto.persistence revalidates restored cells and by-value channels against document specs", () => {
    const source = `
"arc";
function Main(
  args = { input: Str() },
  returns = { output: Artifact() },
) {
  let amount = Num();
  let note = Artifact();
  let cursor = Dialog.Cursor();
  let items = Array(Str());
  $instruct(\`pending\`);
}
`;
    const invalidCells: Array<[string, unknown, RegExp]> = [
      [
        "amount",
        "wrong",
        /Invalid persisted traversal state.*number guarantee/,
      ],
      [
        "note",
        { path: "note.md", extra: true },
        /Invalid persisted traversal state.*artifact guarantee/,
      ],
      [
        "cursor",
        { user: -1, self: 0 },
        /Invalid persisted traversal state.*dialogCursor guarantee/,
      ],
      [
        "items",
        ["ok", 1],
        /Invalid persisted traversal state.*array guarantee/,
      ],
    ];

    for (const [name, value, message] of invalidCells) {
      const runtime = new Runtime()
        .add("restored-cell-spec", parse(source))
        .init();
      const traversal = runtime.newTraversal(arc("restored-cell-spec", "Main"));
      traversal.phase = "entered";
      traversal.cells[name] = value as CellValue;
      expect(() => runtime.start([traversal], EMPTY_DIALOG)).toThrow(message);
    }

    const channelRuntime = new Runtime()
      .add("restored-channel-spec", parse(source))
      .init();
    const channelTraversal = channelRuntime.newTraversal(
      arc("restored-channel-spec", "Main"),
    );
    channelTraversal.phase = "entered";
    channelTraversal.enterChannels.args.input = {
      kind: "value",
      value: 1,
    };
    expect(() =>
      channelRuntime.startTrigger([channelTraversal], EMPTY_DIALOG),
    ).toThrow(/Invalid persisted traversal state.*string guarantee/);
  });

  it.each([
    [
      "cell",
      (snapshot: StateSnapshot) => {
        snapshot.cells.amount = "wrong";
      },
      /pre-snapshot cell amount violates its number guarantee/i,
    ],
    [
      "channel",
      (snapshot: StateSnapshot) => {
        snapshot.channels["args.gate"] = "wrong";
      },
      /pre-snapshot channel args\.gate violates its boolean guarantee/i,
    ],
  ])(
    "proto.persistence revalidates restored pre-snapshot %s values",
    (_label, corrupt, message) => {
      const runtime = new Runtime()
        .add(
          `restored-snapshot-${_label}`,
          parse(`
"arc";
function Main(args = { gate: Bool() }) {
  let amount = Num();
  amount.$set(1);
  if (args.gate == true && amount == 1) {
    $enter(Child);
  }
  function Child() {
    $instruct(\`pending\`);
  }
}
`),
        )
        .init();
      const brief = actionProgress(
        runtime.enterArc(
          arc(`restored-snapshot-${_label}`, "Main"),
          EMPTY_DIALOG,
          { args: { gate: true } },
        ),
      );
      const revived = JSON.parse(
        JSON.stringify(brief.traversals),
      ) as ArcTraversalSet;
      const state = Object.values(revived[0]!.frame.actionStates).find(
        (candidate) =>
          candidate?.kind === "enter-node" && candidate.preSnapshot,
      );
      if (state?.kind !== "enter-node" || !state.preSnapshot) {
        throw new Error("expected a persisted enter pre-snapshot");
      }
      corrupt(state.preSnapshot);

      expect(() => runtime.start(revived, EMPTY_DIALOG)).toThrow(message);
    },
  );

  it("artifact.channel.entry preserves args, initialized locals, persistence, and covered returns", () => {
    const source = `
"arc";
function Transform(
  args = { input: Artifact(), slug: Str() },
  returns = { output: Artifact() },
) {
  let output = Artifact(\`processed/\${args.slug}.md\`);
  $instruct(\`Read \${args.input} and write the result to \${output}\`);
  this.effects = () => {
    returns.output.$set(output);
  };
}
`;
    const firstRuntime = new Runtime()
      .add("artifact-entry", parse(source))
      .init();
    const input = createArtifactValue("incoming/source.md");
    const first = actionProgress(
      firstRuntime.enterArc(arc("artifact-entry", "Transform"), EMPTY_DIALOG, {
        args: { input, slug: "summary" },
      }),
    );
    (input as { path: string }).path = "mutated-after-entry.md";

    expect(first.instructions[0]?.text).toEqual([
      { kind: "text", value: "Read " },
      { kind: "artifact", path: "incoming/source.md" },
      { kind: "text", value: " and write the result to " },
      { kind: "artifact", path: "processed/summary.md" },
    ]);
    expect(rootTraversal(first).cells.output).toEqual(
      createArtifactValue("processed/summary.md"),
    );

    const revived = JSON.parse(
      JSON.stringify(first.traversals),
    ) as ArcTraversalSet;
    const secondRuntime = new Runtime()
      .add("artifact-entry", parse(source))
      .init();
    const restored = actionProgress(secondRuntime.start(revived, EMPTY_DIALOG));
    const terminal = progressTerminal(secondRuntime, restored, {
      move: "proceed",
      instructions: appliedInstructions(restored),
    });

    expect(terminal.returns?.output).toEqual(
      createArtifactValue("processed/summary.md"),
    );
    expect(isArtifactValue(terminal.returns?.output)).toBe(true);
  });

  it("artifact.channel.entry rejects structural and malformed direct arguments synchronously", () => {
    const runtime = new Runtime()
      .add(
        "artifact-entry-invalid",
        parse(`
"arc";
function Main(args = { input: Artifact() }) {}
`),
      )
      .init();
    const invalidValues: unknown[] = [
      "incoming.md",
      { kind: "artifact", path: "incoming.md" },
      {},
      { path: "incoming.md", extra: true },
      Object.assign(Object.create({}), { path: "incoming.md" }),
      Object.defineProperties(
        {},
        {
          path: { enumerable: true, get: () => "incoming.md" },
        },
      ),
      { path: 1 },
      { path: "" },
      { path: "/absolute.md" },
      { path: "a/../escape.md" },
    ];

    for (const value of invalidValues) {
      try {
        runtime.enterArc(arc("artifact-entry-invalid", "Main"), EMPTY_DIALOG, {
          args: { input: value as CellValue },
        });
        throw new Error("expected direct Artifact argument rejection");
      } catch (error) {
        expect(error).toMatchObject({ reasonCode: "invalid-arc-argument" });
      }
    }
  });

  it("artifact.channel.unbound allows isUnset and rejects unset template interpolations", () => {
    const runtime = new Runtime()
      .add(
        "artifact-unbound",
        parse(`
"arc";
function Read(args = { input: Artifact() }) {
  if (args.input.isUnset()) {
    $instruct(\`unset Artifact arg\`);
  }
  $instruct(\`Use \${args.input}\`);
}
function Initialize(args = { slug: Str() }) {
  let output = Artifact(\`\${args.slug}.md\`);
  $instruct(\`Use \${output}\`);
}
`),
      )
      .init();

    const first = actionProgress(
      runtime.enterArc(arc("artifact-unbound", "Read"), EMPTY_DIALOG),
    );
    expect(first.instructions.map((item) => item.text)).toEqual([
      "unset Artifact arg",
    ]);
    const readPoison = actionTerminal(
      runtime.progress(
        first,
        {
          move: "proceed",
          instructions: appliedInstructions(first),
        },
        EMPTY_DIALOG,
      ),
    );
    expect(readPoison.issues[0]).toMatchObject({
      reasonCode: "invalid-template-interpolation",
    });

    const initializerPoison = actionTerminal(
      runtime.enterArc(arc("artifact-unbound", "Initialize"), EMPTY_DIALOG),
    );
    expect(initializerPoison.issues[0]).toMatchObject({
      reasonCode: "invalid-template-interpolation",
    });
  });

  it("proto.arc-entry forwards cloned args by value and survives traversal persistence", () => {
    const source = `
"arc";
function Main(args = { flag: Bool(), items: Array(Str()) }) {
  $enter(Child, {
    args: { flag: args.flag, items: args.items },
  });
  function Child(args = { flag: Bool(), items: Array(Str()) }) {
    if (args.flag == true && args.items[0] == "kept") {
      $instruct(\`projected\`);
    }
  }
}
`;
    const first = new Runtime()
      .add("root-args-persistence", parse(source))
      .init();
    const items: CellValue = ["kept"];
    const transition = actionProgress(
      first.enterArc(arc("root-args-persistence", "Main"), EMPTY_DIALOG, {
        args: { flag: true, items },
      }),
    );
    (items as string[])[0] = "mutated";

    const revived = JSON.parse(
      JSON.stringify(transition.traversals),
    ) as ArcTraversalSet;
    const second = new Runtime()
      .add("root-args-persistence", parse(source))
      .init();
    const reyielded = actionProgress(second.start(revived, EMPTY_DIALOG));
    const projected = actionProgress(
      settleTransitions(second, reyielded, EMPTY_DIALOG),
    );

    expect(projected.instructions.map((item) => item.text)).toEqual([
      "projected",
    ]);
    expect(rootTraversal(projected).enterChannels.args.items).toMatchObject({
      kind: "value",
      value: ["kept"],
    });
  });

  it("proto.arc-entry leaves omitted declared args unset", () => {
    const runtime = new Runtime()
      .add(
        "root-omitted-arg",
        parse(`
"arc";
function Main(args = { optional: Bool() }) {
  if (args.optional.isUnset()) {
    $instruct(\`unset\`);
  }
}
`),
      )
      .init();

    const brief = actionProgress(
      runtime.enterArc(arc("root-omitted-arg", "Main"), EMPTY_DIALOG),
    );
    expect(brief.instructions.map((item) => item.text)).toEqual(["unset"]);
  });

  it("proto.action-result distinguishes frontier and terminal shapes", () => {
    const runtime = new Runtime()
      .add(
        "brief-shapes",
        parse(`
"arc";
function Main() {
  $instruct(\`work\`);
}
`),
      )
      .init();
    const frontier = actionProgress(
      runtime.enterArc(arc("brief-shapes", "Main"), EMPTY_DIALOG),
    );

    expect(frontier).toMatchObject({
      canProgress: true,
      allowedMoves: ["poison", "proceed"],
    });
    expect("outcome" in frontier).toBe(false);
    expect("returns" in frontier).toBe(false);

    const terminal = progressTerminal(runtime, frontier, {
      move: "proceed",
      instructions: appliedInstructions(frontier),
    });
    expect(terminal).toMatchObject({
      canProgress: false,
      root: arc("brief-shapes", "Main"),
      outcome: "covered",
    });
    for (const key of [
      "active",
      "allowedMoves",
      "hostCalls",
      "hostCalls",
      "judgments",
      "observations",
      "instructions",
      "transition",
    ]) {
      expect(key in terminal).toBe(false);
    }
    expectTypeOf(runtime.progress).parameter(0).toEqualTypeOf<ActionBrief>();
    expectTypeOf<TerminalBrief>().not.toExtend<ActionBrief>();
  });

  it("proto.action-result returns covered roots with absent, empty, and staged returns", () => {
    const runtime = new Runtime()
      .add(
        "root-return-results",
        parse(`
"arc";
function None() {}
function Unset(returns = { output: Str() }) {}
function Set(returns = { output: Str(), count: Num() }) {
  $instruct(\`work\`);
  this.effects = () => {
    returns.output.$set("done");
  };
}
`),
      )
      .init();

    const none = actionTerminal(
      runtime.enterArc(arc("root-return-results", "None"), EMPTY_DIALOG),
    );
    const unset = actionTerminal(
      runtime.enterArc(arc("root-return-results", "Unset"), EMPTY_DIALOG),
    );
    const setFrontier = actionProgress(
      runtime.enterArc(arc("root-return-results", "Set"), EMPTY_DIALOG),
    );
    const set = progressTerminal(runtime, setFrontier, {
      move: "proceed",
      instructions: appliedInstructions(setFrontier),
    });

    expect(none.outcome).toBe("covered");
    expect("returns" in none).toBe(false);
    expect(unset.returns).toEqual({});
    expect(set.returns).toEqual({ output: "done" });
  });

  it("proto.action-result reconstructs a blocked direct invocation and returns the same output", () => {
    const source = `
"arc";
function Main(args = { input: Str() }, returns = { output: Str() }) {
  $instruct(\`use \${args.input}\`);
  this.effects = () => {
    returns.output.$set(args.input);
  };
}
`;
    const first = new Runtime().add("root-return-resume", parse(source)).init();
    const blocked = actionProgress(
      first.enterArc(arc("root-return-resume", "Main"), EMPTY_DIALOG, {
        args: { input: "persisted" },
      }),
    );

    const second = new Runtime()
      .add("root-return-resume", parse(source))
      .init();
    const restored = actionProgress(
      second.start(
        JSON.parse(JSON.stringify(blocked.traversals)) as ArcTraversalSet,
        EMPTY_DIALOG,
      ),
    );
    const terminal = progressTerminal(second, restored, {
      move: "proceed",
      instructions: appliedInstructions(restored),
    });

    expect(restored.instructions.map((item) => item.text)).toEqual([
      "use persisted",
    ]);
    expect(terminal.returns).toEqual({ output: "persisted" });
  });

  it("proto.action-result withholds staged returns from deflected and poisoned roots", () => {
    const runtime = new Runtime()
      .add(
        "noncommitting-root-results",
        parse(`
"arc";
import api from "host:api";
function Deflected(returns = { output: Str(), artifact: Artifact() }) {
  let topic = Bool({ observing: \`topic\` });
  let candidate = Artifact("deflected.md");
  $observeOrAsk(topic);
  this.effects = () => {
    returns.output.$set("candidate");
    returns.artifact.$set(candidate);
    api.$record("deflected effect");
  };
}
function AuthoredPoison(returns = { output: Str(), artifact: Artifact() }) {
  let unset = Str();
  let candidate = Artifact("poisoned.md");
  this.effects = () => {
    returns.artifact.$set(candidate);
    returns.output.$set(unset);
  };
}
function HostPoison(returns = { output: Str() }) {
  $instruct(\`work\`);
}
`),
      )
      .init();

    const deflectFrontier = actionProgress(
      runtime.enterArc(
        arc("noncommitting-root-results", "Deflected"),
        EMPTY_DIALOG,
      ),
    );
    const deflectedEffects = actionProgress(
      runtime.progress(deflectFrontier, { move: "deflect" }, EMPTY_DIALOG),
    );
    const deflectedOutput = runtime.progress(
      deflectedEffects,
      {
        move: "proceed",
        hostCalls: resolvedHostCalls(deflectedEffects),
      },
      EMPTY_DIALOG,
    );
    const deflected = actionTerminal(deflectedOutput);
    const authored = actionTerminal(
      runtime.enterArc(
        arc("noncommitting-root-results", "AuthoredPoison"),
        EMPTY_DIALOG,
      ),
    );
    const hostFrontier = actionProgress(
      runtime.enterArc(
        arc("noncommitting-root-results", "HostPoison"),
        EMPTY_DIALOG,
      ),
    );
    const host = actionTerminal(
      runtime.progress(
        hostFrontier,
        {
          move: "poison",
          poisonReason: { reasonCode: "host-test", reason: "host stopped" },
        },
        EMPTY_DIALOG,
      ),
    );

    expect(deflected).toMatchObject({ outcome: "deflected" });
    expect(authored).toMatchObject({ outcome: "poisoned" });
    expect(host).toMatchObject({ outcome: "poisoned" });
    for (const terminal of [deflected, authored, host]) {
      expect("returns" in terminal).toBe(false);
    }
    expect(authored.issues[0]).toMatchObject({
      kind: "poisoned-traversal",
    });
    expect(host.issues[0]).toMatchObject({
      kind: "poisoned-traversal",
      reasonCode: "host-test",
    });
  });

  it("proto.action-result identifies the action Arc in a multi-Arc synchronous completion", () => {
    const runtime = new Runtime()
      .add(
        "multi-root-result",
        parse(`
"arc";
function First() {}
function Second() {}
`),
      )
      .init();
    const dormantFirst = runtime.newTraversal(
      arc("multi-root-result", "First"),
    );
    const enteredSecond = runtime.newTraversal(
      arc("multi-root-result", "Second"),
    );
    enteredSecond.phase = "entered";
    enteredSecond.enterCount = 1;

    const terminal = actionTerminal(
      runtime.start([dormantFirst, enteredSecond], EMPTY_DIALOG),
    );

    expect(terminal.root).toBe(arc("multi-root-result", "Second"));
    expect(terminal.outcome).toBe("covered");
    expect(terminal.traversals).toHaveLength(2);
  });
});
