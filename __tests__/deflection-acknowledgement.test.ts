import { describe, expect, it } from "vitest";
import { parse } from "../src/parser/index.js";
import type {
  ActionBrief,
  ActionReport,
  ArcTraversalSet,
  TerminalBrief,
  Traversal,
} from "../src/types/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  node,
  ownedChild,
  renderSemanticTextForTest,
  rootTraversal,
  TestRuntime as Runtime,
  settleTransitions,
} from "./helpers.js";

type Output = ActionBrief | TerminalBrief;
const sourceId = "deflection-ack";
function boot(source: string) {
  const document = parse(source);
  const runtime = new Runtime().add(sourceId, document).init();
  const output = settleTransitions(
    runtime,
    runtime.enterArc(arc(sourceId, "Main"), EMPTY_DIALOG),
    EMPTY_DIALOG,
  );
  return { runtime, document, output };
}
function next(
  runtime: Runtime,
  brief: ActionBrief,
  report: ActionReport,
): Output {
  return settleTransitions(
    runtime,
    runtime.progress(brief, report, EMPTY_DIALOG),
    EMPTY_DIALOG,
  );
}
function required(output: Output): ActionBrief {
  const brief = actionProgress(output);
  expect(brief.deflection).toEqual({ origin: brief.active });
  expect(brief.allowedMoves).toEqual(["deflect"]);
  expect(brief.transition).toBeUndefined();
  for (const work of [
    brief.instructions,
    brief.judgments,
    brief.observations,
    brief.hostCalls,
  ])
    expect(work).toEqual([]);
  expect(rootTraversal(brief).phase).toBe("entered");
  return brief;
}
function json(traversals: ArcTraversalSet): ArcTraversalSet {
  return JSON.parse(JSON.stringify(traversals));
}
const guarded = `"arc";
function Main() {
  let guards = Num(); let catches = Num(); let effects = Num();
  guards.$set(0); catches.$set(0); effects.$set(0);
  $enter(Child);
  function Child() {
    this.guard = () => { guards.$set(guards + 1); return State.DEFLECTED; };
    this.catchDeflection = () => { catches.$set(catches + 1); return false; };
    this.effects = () => { effects.$set(effects + 1); };
  }
}`;
const instruction = `"arc";
function Main() {
  this.catchDeflection = () => true;
  $instruct(\`work\`, { deflectWhen: \`leave\` });
}`;
function requestInstruction(runtime: Runtime, output: Output, applied = true) {
  const brief = actionProgress(output);
  return required(
    next(runtime, brief, {
      move: "proceed",
      ...(applied ? { instructions: appliedInstructions(brief) } : {}),
      judgments: { [brief.judgments[0]!.id]: true },
    }),
  );
}

describe("proto.deflection-acknowledgement", () => {
  it("deflection-ack.guard persists the origin before catch effects and propagation", () => {
    const { runtime, document, output } = boot(guarded);
    const pending = required(output);
    expect(pending.active).toBe(node(sourceId, "Main.Child"));
    const parent = rootTraversal(pending);
    expect(parent.cells).toMatchObject({ guards: 1, catches: 0, effects: 0 });
    expect(parent.control).toBeUndefined();
    expect(ownedChild(parent, "Main.Child")).toMatchObject({
      guardCompleted: true,
      state: undefined,
      control: {
        reason: "deflected",
        phase: "requested",
        deflection: { origin: pending.active },
      },
      enteredBy: { callerRef: node(sourceId, "Main") },
    });
    const fresh = new Runtime().add(sourceId, document).init();
    const restored = required(
      fresh.start(json(pending.traversals), EMPTY_DIALOG),
    );
    expect(restored).toEqual(pending);
    const done = next(fresh, restored, { move: "deflect" });
    expect(done).toMatchObject({ canProgress: false, outcome: "deflected" });
    expect(done).not.toHaveProperty("deflection");
    expect(rootTraversal(done).cells).toMatchObject({
      guards: 1,
      catches: 1,
      effects: 1,
    });
    expect(next(runtime, pending, { move: "deflect" })).toEqual(done);
  });

  it.each([
    ["proceed", { move: "proceed" }],
    ["interrupt", { move: "interrupt", interruption: { id: "external" } }],
    ["poison", { move: "poison" }],
    ["instructions", { move: "deflect", instructions: {} }],
    ["judgments", { move: "deflect", judgments: {} }],
    ["observations", { move: "deflect", observations: {} }],
    ["hostCalls", { move: "deflect", hostCalls: {} }],
    ["interruption", { move: "deflect", interruption: { id: "external" } }],
    ["poisonReason", { move: "deflect", poisonReason: { reason: "failure" } }],
  ] satisfies [string, ActionReport][])(
    "deflection-ack.validation rejects %s without losing the request",
    (_name, report) => {
      const { runtime, output } = boot(guarded);
      const pending = required(output);
      const rejected = required(next(runtime, pending, report));
      expect(rejected.issues).toMatchObject([{ kind: "invalid-report" }]);
      expect(rejected.traversals).toEqual(pending.traversals);
      expect(next(runtime, rejected, { move: "deflect" })).toMatchObject({
        outcome: "deflected",
      });
    },
  );

  it("deflection-ack.immutability isolates pending state from host mutation", () => {
    const { runtime, output } = boot(guarded);
    const pending = required(output);
    const original = json(pending.traversals);
    rootTraversal(pending).cells.guards = 900;
    ownedChild(rootTraversal(pending), "Main.Child")!.control = undefined;
    pending.allowedMoves.push("proceed");
    pending.deflection!.origin = node(sourceId, "Main");
    const retry = required(next(runtime, pending, { move: "proceed" }));
    expect(json(retry.traversals)).toEqual(original);
    expect(next(runtime, pending, { move: "deflect" })).toMatchObject({
      outcome: "deflected",
    });
  });

  it.each([true, false])(
    "deflection-ack.instruction preserves applied=%s across JSON acknowledgement",
    (applied) => {
      const { runtime, document, output } = boot(instruction);
      const pending = requestInstruction(runtime, output, applied);
      const state = Object.values(
        rootTraversal(pending).frame.actionStates,
      ).find((value) => value?.kind === "instruction");
      expect(state).toMatchObject(
        applied
          ? { status: "resolved" }
          : {
              status: "pending",
              instructionPhase: "apply",
              deflectWhenOutcome: true,
            },
      );
      const fresh = new Runtime().add(sourceId, document).init();
      const restored = required(
        fresh.start(json(pending.traversals), EMPTY_DIALOG),
      );
      const after = next(fresh, restored, { move: "deflect" });
      if (applied)
        expect(after).toMatchObject({ canProgress: false, outcome: "covered" });
      else
        expect(actionProgress(after).instructions).toMatchObject([
          { text: "work", phase: "apply" },
        ]);
    },
  );

  it("deflection-ack.loop banks split evidence and suppresses unrelated unfinished checks", () => {
    const { runtime, document, output } = boot(`"arc"; function Main() {
      this.catchDeflection = () => true;
      $instructLoop(\`work\`, { resolveWhen: \`finished\`, deflectWhen: \`leave\` });
    }`);
    const brief = actionProgress(output);
    const finished = brief.judgments.find(
      (item) => renderSemanticTextForTest(item.question) === "finished",
    )!.id;
    const leave = brief.judgments.find(
      (item) => renderSemanticTextForTest(item.question) === "leave",
    )!.id;
    const waiting = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
        judgments: { [finished]: true },
      }),
    );
    expect(waiting.judgments.map((item) => item.id)).toEqual([leave]);
    const pending = required(
      next(runtime, waiting, { move: "proceed", judgments: { [leave]: true } }),
    );
    const fresh = new Runtime().add(sourceId, document).init();
    const restored = required(
      fresh.start(json(pending.traversals), EMPTY_DIALOG),
    );
    expect(next(fresh, restored, { move: "deflect" })).toMatchObject({
      outcome: "covered",
    });
    const unfinished = required(
      next(runtime, brief, { move: "proceed", judgments: { [leave]: true } }),
    );
    expect(
      Object.values(rootTraversal(unfinished).frame.actionStates),
    ).toContainEqual(
      expect.objectContaining({ status: "pending", deflectWhenOutcome: true }),
    );
    expect(
      actionProgress(next(runtime, unfinished, { move: "deflect" }))
        .instructions[0]!.phase,
    ).toBe("apply");
  });

  it.each(["invoke", "map"] as const)(
    "deflection-ack.ownership retains nested %s until acknowledgement",
    (owner) => {
      const body =
        owner === "invoke"
          ? "invoke(() => { invoke(() => { $instruct(`work`, { deflectWhen: `leave` }); }); });"
          : "items.$map(() => { invoke(() => { $instruct(`work`, { deflectWhen: `leave` }); }); });";
      const { runtime, document, output } = boot(`"arc"; function Main() {
      let items = Array(Str()); items.$set(["a", "b"]);
      this.catchDeflection = () => judge(\`catch\`);
      ${body}
    }`);
      const pending = requestInstruction(runtime, output, false);
      expect(
        Object.values(rootTraversal(pending).frame.actionStates).some(
          (state) => state?.kind === owner && state.status === "pending",
        ),
      ).toBe(true);
      const fresh = new Runtime().add(sourceId, document).init();
      const restored = required(
        fresh.start(json(pending.traversals), EMPTY_DIALOG),
      );
      const catching = actionProgress(
        next(fresh, restored, { move: "deflect" }),
      );
      expect(renderSemanticTextForTest(catching.judgments[0]!.question)).toBe(
        "catch",
      );
      expect(
        Object.values(rootTraversal(catching).frame.actionStates).some(
          (state) => state?.kind === owner,
        ),
      ).toBe(false);
      expect(rootTraversal(catching).cells.items).toEqual(["a", "b"]);
      const resumed = new Runtime().add(sourceId, document).init();
      const catchAgain = actionProgress(
        resumed.start(json(catching.traversals), EMPTY_DIALOG),
      );
      expect(catchAgain.deflection).toBeUndefined();
      expect(catchAgain.allowedMoves).not.toEqual(["deflect"]);
      expect(catchAgain.judgments).toEqual(catching.judgments);
    },
  );

  it("deflection-ack.events requires a fresh acknowledgement after caught restart", () => {
    const { runtime, output } = boot(instruction);
    const first = requestInstruction(runtime, output, false);
    const work = next(runtime, first, { move: "deflect" });
    const second = requestInstruction(runtime, work, false);
    expect(
      actionProgress(next(runtime, second, { move: "deflect" }))
        .instructions[0]!.text,
    ).toBe("work");
  });

  it("deflection-ack.transitions acknowledges an outstanding transition before a retained request", () => {
    const { runtime, document, output } = boot(guarded);
    const pending = required(output);
    const saved = json(pending.traversals);
    saved[0]!.pendingTransition = { entered: [pending.active], exited: [] };
    const fresh = new Runtime().add(sourceId, document).init();
    const transition = actionProgress(fresh.start(saved, EMPTY_DIALOG));
    expect(transition.deflection).toBeUndefined();
    expect(transition.transition?.position).toBe(pending.active);
    expect(transition.allowedMoves).toEqual(["poison", "proceed"]);
    const requested = required(
      fresh.progress(transition, { move: "proceed" }, EMPTY_DIALOG),
    );
    expect(rootTraversal(requested).cells).toMatchObject({
      guards: 1,
      catches: 0,
    });
    expect(next(runtime, pending, { move: "deflect" })).toMatchObject({
      outcome: "deflected",
    });
  });

  it.each(["root", "child"] as const)(
    "deflection-ack.failure retains %s admission after catch effects and restarted-body errors",
    (origin) => {
      for (const failure of ["catch", "effects", "body"] as const) {
        const script = `let value = Num(); value.$set(1);
        this.catchDeflection = () => { ${failure === "catch" ? "value.$set(0 / 0);" : ""} return ${failure !== "effects"}; };
        ${failure === "effects" ? "this.effects = () => { value.$set(0 / 0); };" : ""}
        $instruct(\`work\`, { deflectWhen: \`leave\` });
        ${failure === "body" ? "value.$set(0 / 0);" : ""}`;
        const { runtime, output } = boot(
          `"arc"; function Main() { ${origin === "root" ? script : `$enter(Child); function Child() { ${script} }`} }`,
        );
        const pending = requestInstruction(runtime, output);
        const poisoned = runtime.progress(
          pending,
          { move: "deflect" },
          EMPTY_DIALOG,
        );
        expect(poisoned).toMatchObject({
          canProgress: false,
          outcome: "poisoned",
        });
        expect(rootTraversal(poisoned).activeFrame?.activeSeg).toEqual({
          kind: "catch",
        });
        const active: Traversal =
          origin === "root"
            ? rootTraversal(poisoned)
            : ownedChild(rootTraversal(poisoned), "Main.Child")!;
        expect(active.cells.value).toBe(1);
        if (origin === "child")
          expect(active.control).toMatchObject({
            reason: "deflected",
            phase: "catch",
          });
        expect(
          runtime.progress(pending, { move: "deflect" }, EMPTY_DIALOG),
        ).toEqual(poisoned);
      }
    },
  );

  it("deflection-ack.direct applies an ordinary host deflection without another request", () => {
    const { runtime, output } = boot(`"arc"; function Main() {
      if (judge(\`work\`)) $instruct(\`do work\`);
      this.catchDeflection = () => judge(\`catch\`);
    }`);
    const catching = actionProgress(
      next(runtime, actionProgress(output), { move: "deflect" }),
    );
    expect(renderSemanticTextForTest(catching.judgments[0]!.question)).toBe(
      "catch",
    );
    expect(catching.deflection).toBeUndefined();
    expect(catching.allowedMoves).not.toEqual(["deflect"]);
    expect(
      next(runtime, catching, {
        move: "interrupt",
        interruption: { id: "replacement" },
      }),
    ).toMatchObject({ outcome: "interrupted" });
  });
  it.each(["owned", "imported", "owned-copy", "imported-copy"])(
    "deflection-ack.origins reconstructs exact %s ownership and canonical propagation",
    (kind) => {
      const imported = kind.startsWith("imported");
      const copy = kind.endsWith("copy");
      const child = `function Child() {
      this.guard = () => State.DEFLECTED;
      this.catchDeflection = () => judge(\`child catch\`);
    }`;
      const main = parse(`"arc";
      ${imported ? 'import { Child } from "child-arc";' : ""}
      function Main() {
        let caught = Bool();
        this.catchDeflection = () => {
          caught.$set(this.deflection.escaped(Child)); return true;
        };
        if (caught != true) $enter(${copy ? "newcopy(Child)" : "Child"});
        $instruct(\`after\`);
        ${imported ? "" : child}
      }`);
      const create = () => {
        const runtime = new Runtime().add(sourceId, main);
        if (imported) runtime.add("child-arc", parse(`"arc"; ${child}`));
        return runtime.init();
      };
      const runtime = create();
      const entry = actionProgress(
        runtime.enterArc(arc(sourceId, "Main"), EMPTY_DIALOG),
      );
      expect(entry.transition).toBeDefined();
      const pending = required(next(runtime, entry, { move: "proceed" }));
      const parent = rootTraversal(pending);
      const origin = copy
        ? parent.ephemeralChildren[0]
        : imported
          ? pending.traversals.find(
              (value) => value.ref === arc("child-arc", "Child"),
            )
          : parent.ownedChildren[0];
      expect(origin?.control).toEqual({
        reason: "deflected",
        phase: "requested",
        deflection: { origin: pending.active },
      });
      expect(origin?.enteredBy?.callerRef).toBe(node(sourceId, "Main"));
      const fresh = create();
      const restored = required(
        fresh.start(json(pending.traversals), EMPTY_DIALOG),
      );
      expect(restored.active).toBe(pending.active);
      const catching = actionProgress(
        next(fresh, restored, { move: "deflect" }),
      );
      expect(renderSemanticTextForTest(catching.judgments[0]!.question)).toBe(
        "child catch",
      );
      const exit = actionProgress(
        fresh.progress(
          catching,
          {
            move: "proceed",
            judgments: { [catching.judgments[0]!.id]: false },
          },
          EMPTY_DIALOG,
        ),
      );
      expect(exit.transition?.exited).toEqual([pending.active]);
      expect(exit.transition?.position).toBe(node(sourceId, "Main"));
      const after = actionProgress(next(fresh, exit, { move: "proceed" }));
      expect(rootTraversal(after).cells.caught).toBe(true);
      expect(after.instructions[0]!.text).toBe("after");
    },
  );

  it.each(["guard", "policy"])(
    "deflection-ack.host-results preserves completed calls before a %s request",
    (kind) => {
      const { runtime, document, output } = boot(`"arc";
      import Api from "host:api";
      import Gate from "host:gate";
      function Main() {
        Api.$record(\`before\`);
        ${kind === "guard" ? "$enter(Child);" : "$instruct(`work`, { deflectWhen: () => Gate.ready() });"}
        function Child() {
          this.guard = () => { if (Gate.ready()) return State.DEFLECTED; };
        }
      }`);
      const call = actionProgress(output);
      expect(call.hostCalls[0]!.arguments).toEqual(["before"]);
      const work = actionProgress(
        next(runtime, call, {
          move: "proceed",
          hostCalls: { [call.hostCalls[0]!.id]: { status: "resolved" } },
        }),
      );
      const probe =
        kind === "policy"
          ? actionProgress(
              next(runtime, work, {
                move: "proceed",
                instructions: appliedInstructions(work),
              }),
            )
          : work;
      if (kind === "policy")
        expect(probe.instructions[0]!.phase).toBe("postcheck");
      const pending = required(
        next(runtime, probe, {
          move: "proceed",
          hostCalls: {
            [probe.hostCalls[0]!.id]: { status: "resolved", value: true },
          },
        }),
      );
      expect(
        Object.values(rootTraversal(pending).frame.actionStates),
      ).toContainEqual({ kind: "host-call", status: "resolved" });
      const fresh = new Runtime().add(sourceId, document).init();
      const restored = required(
        fresh.start(json(pending.traversals), EMPTY_DIALOG),
      );
      expect(next(fresh, restored, { move: "deflect" })).toMatchObject({
        outcome: "deflected",
      });
    },
  );

  it("deflection-ack.propagation suspends host catch work and crosses several parents with one acknowledgement", () => {
    const { runtime, document, output } = boot(`"arc";
      import Gate from "host:gate";
      function Main() {
        let caught = Bool();
        this.catchDeflection = () => { caught.$set(true); return true; };
        if (caught != true) $enter(Branch);
        $instruct(\`after\`);
        function Branch() {
          $enter(Leaf);
          function Leaf() {
            this.guard = () => State.DEFLECTED;
            this.catchDeflection = () => Gate.ready();
          }
        }
      }`);
    const pending = required(output);
    const catchCall = actionProgress(
      next(runtime, pending, { move: "deflect" }),
    );
    expect(catchCall.hostCalls[0]!.operation).toBe("ready");
    const fresh = new Runtime().add(sourceId, document).init();
    const restored = actionProgress(
      fresh.start(json(catchCall.traversals), EMPTY_DIALOG),
    );
    expect(restored.hostCalls).toEqual(catchCall.hostCalls);
    const exit = actionProgress(
      fresh.progress(
        restored,
        {
          move: "proceed",
          hostCalls: {
            [restored.hostCalls[0]!.id]: { status: "resolved", value: false },
          },
        },
        EMPTY_DIALOG,
      ),
    );
    expect(exit.transition?.exited).toEqual([
      node(sourceId, "Main.Branch.Leaf"),
      node(sourceId, "Main.Branch"),
    ]);
    expect(rootTraversal(exit).cells.caught).toBeUndefined();
    const after = actionProgress(next(fresh, exit, { move: "proceed" }));
    expect(rootTraversal(after).cells.caught).toBe(true);
    expect(after.instructions[0]!.text).toBe("after");
  });

  it("deflection-ack.map preserves completed members staged results and writes before abandonment", () => {
    const { runtime, document, output } = boot(`"arc";
      import Api from "host:api";
      function Main() {
        let items = Array(Str()); let results = Array(Str()); let changed = Num();
        items.$set(["a", "b"]); changed.$set(0);
        this.catchDeflection = () => judge(\`catch\`);
        items.$map(() => {
          changed.$set(changed + 1);
          span.result.$set(span.item);
          if (span.item == "a") Api.$record(\`first member\`);
          else $instruct(\`work\`, { deflectWhen: \`leave\` });
        }, results);
      }`);
    const call = actionProgress(output);
    const work = next(runtime, call, {
      move: "proceed",
      hostCalls: { [call.hostCalls[0]!.id]: { status: "resolved" } },
    });
    const pending = requestInstruction(runtime, work, false);
    const arena = Object.values(rootTraversal(pending).frame.actionStates).find(
      (state) => state?.kind === "map",
    );
    expect(arena).toMatchObject({
      kind: "map",
      status: "pending",
      map: {
        nextIndex: 1,
        pinnedInput: ["a", "b"],
        terminals: ["a"],
        staged: { set: true, value: "b" },
      },
    });
    expect(rootTraversal(pending).cells.changed).toBe(2);
    expect(rootTraversal(pending).cells.results).toBeUndefined();
    const fresh = new Runtime().add(sourceId, document).init();
    const restored = required(
      fresh.start(json(pending.traversals), EMPTY_DIALOG),
    );
    const catching = actionProgress(next(fresh, restored, { move: "deflect" }));
    expect(rootTraversal(catching).cells.changed).toBe(2);
    expect(rootTraversal(catching).cells.results).toBeUndefined();
    expect(
      Object.values(rootTraversal(catching).frame.actionStates).some(
        (state) => state?.kind === "map",
      ),
    ).toBe(false);
  });

  it("deflection-ack.direct-failure retains ordinary host report admission on an authored error", () => {
    const { runtime, output } = boot(`"arc"; function Main() {
      let value = Num(); value.$set(1);
      this.catchDeflection = () => { value.$set(0 / 0); return true; };
      if (judge(\`work\`)) $instruct(\`do work\`);
    }`);
    const poisoned = next(runtime, actionProgress(output), { move: "deflect" });
    expect(poisoned).toMatchObject({ outcome: "poisoned" });
    expect(rootTraversal(poisoned).activeFrame?.activeSeg).toEqual({
      kind: "catch",
    });
    expect(rootTraversal(poisoned).cells.value).toBe(1);
  });
});
