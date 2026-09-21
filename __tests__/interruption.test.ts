import { describe, expect, it } from "vitest";
import { parse, validate } from "../src/parser/index.js";
import type {
  ActionBrief,
  ActionReport,
  ArcTraversalSet,
  Document,
  TerminalBrief,
} from "../src/types/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  node,
  ownedChild,
  resolvedHostCalls,
  rootTraversal,
  TestRuntime as Runtime,
  settleTransitions,
} from "./helpers.js";

type Output = ActionBrief | TerminalBrief;
const id = "interruption";
function boot(body: string) {
  const document = parse(`"arc"; ${body}`);
  const runtime = new Runtime().add(id, document).init();
  const brief = actionProgress(
    settleTransitions(
      runtime,
      runtime.enterArc(arc(id, "Main"), EMPTY_DIALOG),
      EMPTY_DIALOG,
    ),
  );
  return { runtime, brief, document };
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
function restore(document: Document, traversals: ArcTraversalSet) {
  const runtime = new Runtime().add(id, document).init();
  return {
    runtime,
    output: settleTransitions(
      runtime,
      runtime.start(JSON.parse(JSON.stringify(traversals)), EMPTY_DIALOG),
      EMPTY_DIALOG,
    ),
  };
}
function interrupt(runtime: Runtime, brief: ActionBrief): Output {
  return next(runtime, brief, { move: "interrupt" });
}

it.each([
  ["local", "rebound"],
  ["local", "unbound"],
  ["referenced", "rebound"],
  ["referenced", "unbound"],
] as const)(
  "interruption.channels reconciles %s forwarded args when %s without restarting work",
  (kind, binding) => {
    const workSource = `function Work(args = { input: Str() }, returns = { output: Str() }) {
      this.guard = () => { if (judge(\`guard once\`)) return; return State.SKIPPED; };
      Api.$record(\`register once\`);
      $instruct(\`pending work\`);
      this.effects = () => {
        if (args.input.isUnset()) returns.output.$set("unbound");
        else returns.output.$set(args.input);
      };
    }`;
    const document = parse(`"arc"; import Api from "host:api";
      ${kind === "referenced" ? 'import { Work } from "worker";' : ""}
      function Main() {
        let a = Str(); let b = Str(); let output = Str(); let reroute = Bool();
        a.$set("a"); b.$set("b"); reroute.$set(false);
        this.catchInterruption = () => { reroute.$set(true); return true; };
        if (reroute == false) $enter(Wrapper, { args: { input: a } });
        else ${binding === "rebound" ? "$enter(Wrapper, { args: { input: b } });" : "$enter(Wrapper);"}
        function Wrapper(args = { input: Str() }) {
          $enter(Work, { args: { input: args.input }, returns: { output } });
        }
        ${kind === "local" ? workSource : ""}
      }`);
    const runtime = new Runtime();
    if (kind === "referenced") {
      runtime.add(
        "worker",
        parse(`"arc"; import Api from "host:api"; ${workSource}`),
      );
    }
    runtime.add(id, document).init();
    let brief = actionProgress(
      settleTransitions(
        runtime,
        runtime.enterArc(arc(id, "Main"), EMPTY_DIALOG),
        EMPTY_DIALOG,
      ),
    );
    brief = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      }),
    );
    brief = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        hostCalls: resolvedHostCalls(brief),
      }),
    );
    const findWork = (output: Output) =>
      kind === "local"
        ? ownedChild(rootTraversal(output), "Main.Work")!
        : output.traversals.find(
            (traversal) => traversal.ref === arc("worker", "Work"),
          )!;
    const before = findWork(brief);
    expect(before.enterChannels.args.input).toMatchObject({
      kind: "callerCell",
      cell: "a",
    });
    const resumed = actionProgress(interrupt(runtime, brief));
    const retained = findWork(resumed);
    expect(retained.enterChannels.args).toEqual(
      binding === "rebound"
        ? {
            input: {
              kind: "callerCell",
              ownerRef: node(id, "Main"),
              cell: "b",
            },
          }
        : {},
    );
    expect(retained.frame).toEqual(before.frame);
    expect(retained.guardCompleted).toBe(true);
    expect(retained.enterCount).toBe(before.enterCount);
    expect(resumed.judgments).toEqual([]);
    expect(resumed.hostCalls).toEqual([]);
    expect(resumed.instructions).toEqual(brief.instructions);
    const done = next(runtime, resumed, {
      move: "proceed",
      instructions: appliedInstructions(resumed),
    });
    expect(done).toMatchObject({ outcome: "covered" });
    expect(rootTraversal(done).cells.output).toBe(
      binding === "rebound" ? "b" : "unbound",
    );
  },
);

it.each(["rebound", "unbound"] as const)(
  "interruption.channels uses the reached entry return destination when %s",
  (binding) => {
    const { runtime, brief } = boot(`function Main() {
      let a = Str(); let b = Str(); let reroute = Bool(); reroute.$set(false);
      this.catchInterruption = () => { reroute.$set(true); return true; };
      if (reroute == false) $enter(Work, { returns: { output: a } });
      else ${binding === "rebound" ? "$enter(Work, { returns: { output: b } });" : "$enter(Work);"}
      function Work(returns = { output: Str() }) {
        $instruct(\`pending work\`);
        this.effects = () => returns.output.$set("done");
      }
    }`);
    const before = ownedChild(rootTraversal(brief), "Main.Work")!;
    const resumed = actionProgress(interrupt(runtime, brief));
    const retained = ownedChild(rootTraversal(resumed), "Main.Work")!;
    expect(retained.enterChannels.returns).toEqual(
      binding === "rebound"
        ? {
            output: {
              kind: "callerCell",
              ownerRef: node(id, "Main"),
              cell: "b",
            },
          }
        : {},
    );
    expect(retained.frame).toEqual(before.frame);
    expect(retained.enterCount).toBe(before.enterCount);
    const done = next(runtime, resumed, {
      move: "proceed",
      instructions: appliedInstructions(resumed),
    });
    expect(done).toMatchObject({ outcome: "covered" });
    expect(rootTraversal(done).cells.a).toBeUndefined();
    expect(rootTraversal(done).cells.b).toBe(
      binding === "rebound" ? "done" : undefined,
    );
  },
);

describe("interruption", () => {
  it("interruption.syntax validates explicit boolean completion and separate hook IDs", () => {
    const valid = [
      "() => true",
      "() => { if (judge(`catch?`)) return true; else return false; }",
      "() => { choose: { if (judge(`leave?`)) break choose; return true; } return false; }",
    ];
    for (const hook of valid) {
      const document = parse(
        `"arc"; function Main() { this.catchInterruption = ${hook}; $instruct(\`work\`); }`,
      );
      expect(document.roots[0]!.catchInterruption?.[0]?.id).toMatch(
        /^catchInterruption\//,
      );
      expect(document.roots[0]!.statements[0]!.id).toBe("body/0");
      expect(validate(document)).toEqual([]);
    }
    for (const hook of [
      "function () { return true; }",
      "async () => true",
      "(event) => true",
      "() => {}",
      "() => { return; }",
      "() => undefined",
      "() => 1",
      "() => { if (judge(`catch?`)) return true; }",
      "() => { exit: { break exit; return true; } }",
    ]) {
      expect(() =>
        parse(`"arc"; function Main() { this.catchInterruption = ${hook}; }`),
      ).toThrow();
    }
    expect(() =>
      parse(
        '"arc"; function Main() { this.catchInterruption = () => true; this.catchInterruption = () => false; }',
      ),
    ).toThrow(/Duplicate/);
    for (const expression of [
      "this.interruption",
      "this.pendingState",
      "this.deflection.escaped(Main)",
    ]) {
      expect(() =>
        parse(
          `"arc"; function Main() { this.catchInterruption = () => ${expression}; }`,
        ),
      ).toThrow();
    }
  });

  it("interruption.public-ir rejects fallthrough bare returns and runtime-assigned guard states", () => {
    const template = parse(
      '"arc"; function Main() { this.catchInterruption = () => true; function Child() { this.guard = () => State.SKIPPED; } $enter(Child); }',
    );
    for (const hook of [
      [],
      [{ id: "catchInterruption/0", kind: "return" }],
      [
        {
          id: "catchInterruption/0",
          kind: "return",
          value: { kind: "literal", value: undefined },
        },
      ],
    ]) {
      const document: Document = JSON.parse(JSON.stringify(template));
      document.roots[0]!.catchInterruption =
        hook as Document["roots"][number]["catchInterruption"];
      expect(
        validate(document).some(
          (issue) => issue.code === "INVALID_INTERRUPTION_RETURN",
        ),
      ).toBe(true);
      expect(() => new Runtime().add(id, document)).toThrow();
    }
    const guard = template.roots[0]!.children[0]!.guard![0]!;
    if (guard.kind !== "return") throw new Error("Expected return");
    guard.value = { kind: "literal", value: "interrupted" };
    expect(
      validate(template).some((issue) => issue.code === "INVALID_GUARD_RETURN"),
    ).toBe(true);
    expect(() =>
      parse(
        '"arc"; function Main() { function Child() { this.guard = () => State.INTERRUPTED; } $enter(Child); }',
      ),
    ).toThrow(/this.guard/);
  });

  it("interruption.root retains unapplied work and explicitly continues after restoration", () => {
    const { runtime, brief, document } = boot(
      "function Main() { let closed = Bool(); this.effects = () => closed.$set(true); $instruct(`work`); }",
    );
    const before = rootTraversal(brief);
    const stopped = interrupt(runtime, brief);
    expect(stopped).toMatchObject({
      canProgress: false,
      outcome: "interrupted",
      root: arc(id, "Main"),
      issues: [],
    });
    expect(stopped).not.toHaveProperty("returns");
    expect(stopped).not.toHaveProperty("instructions");
    const retained = rootTraversal(stopped);
    expect(retained).toMatchObject({
      state: "interrupted",
      phase: "entered",
      enterCount: before.enterCount,
    });
    expect(retained.frame).toEqual(before.frame);
    expect(retained.cells.closed).toBeUndefined();
    const resumed = restore(document, stopped.traversals);
    const work = actionProgress(resumed.output);
    expect(rootTraversal(stopped).state).toBe("interrupted");
    expect(rootTraversal(work).state).toBeUndefined();
    expect(work.instructions.map((item) => item.text)).toEqual(["work"]);
    expect(rootTraversal(work).enterCount).toBe(before.enterCount);
    const again = interrupt(resumed.runtime, work);
    expect(rootTraversal(again).state).toBe("interrupted");
    const continued = restore(document, again.traversals);
    const pending = actionProgress(continued.output);
    const done = next(continued.runtime, pending, {
      move: "proceed",
      instructions: appliedInstructions(pending),
    });
    expect(done).toMatchObject({ canProgress: false, outcome: "covered" });
    expect(rootTraversal(done).cells.closed).toBe(true);
  });

  it("interruption.wrapper retains child pins actions entry identity and completed guard", () => {
    const { runtime, brief } = boot(`import Api from "host:api";
      function Main() {
        let route = Bool(); route.$set(false);
        function Work() {
          this.guard = () => { if (judge(\`guard\`)) return; return State.SKIPPED; };
          Api.$record(\`registered\`);
          if (route == false) { if (judge(\`child decision\`)) $instruct(\`child work\`); }
        }
        function Wrapper() {
          this.catchInterruption = () => { route.$set(true); return Work.state == State.INTERRUPTED; };
          if (route == false) { if (judge(\`wrapper decision\`)) $enter(Work); }
          else $enter(Work);
        }
        $enter(Wrapper);
      }`);
    let work = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      }),
    );
    work = actionProgress(
      next(runtime, work, {
        move: "proceed",
        judgments: { [work.judgments[0]!.id]: true },
      }),
    );
    expect(work.hostCalls[0]?.operation).toBe("record");
    work = actionProgress(
      next(runtime, work, {
        move: "proceed",
        hostCalls: resolvedHostCalls(work),
      }),
    );
    work = actionProgress(
      next(runtime, work, {
        move: "proceed",
        judgments: { [work.judgments[0]!.id]: true },
      }),
    );
    const childBefore = ownedChild(rootTraversal(work), "Main.Work")!;
    const resumed = actionProgress(interrupt(runtime, work));
    const child = ownedChild(rootTraversal(resumed), "Main.Work")!;
    expect(resumed.instructions.map((item) => item.text)).toEqual([
      "child work",
    ]);
    expect(resumed.judgments).toEqual([]);
    expect(resumed.hostCalls).toEqual([]);
    expect(child.state).toBeUndefined();
    expect(child.enterCount).toBe(childBefore.enterCount);
    expect(child.frame).toEqual(childBefore.frame);
    expect(child.enterChannels).toEqual(childBefore.enterChannels);
    expect(rootTraversal(resumed).cells.route).toBe(true);
  });

  it("interruption.transition preserves child and owners before parent catch evaluation", () => {
    const { runtime, brief, document } = boot(`function Main() {
      this.catchInterruption = () => { if (/parent/.test(Dialog.lastUserMessage)) return judge(\`parent catch\`); return false; };
      invoke(() => { $enter(Child); });
      function Child() { $instruct(\`child\`); }
    }`);
    const before = rootTraversal(brief);
    const transition = actionProgress(
      runtime.progress(
        brief,
        { move: "interrupt" },
        {
          cursor: { user: 1, self: 0 },
          lastTurns: [{ role: "user", message: "child" }],
        },
      ),
    );
    expect(transition.transition?.position).toBe(node(id, "Main"));
    expect(transition.judgments).toEqual([]);
    expect(transition.instructions).toEqual([]);
    const crossed = rootTraversal(transition);
    expect(crossed.frame).toEqual(before.frame);
    const child = ownedChild(crossed, "Main.Child")!;
    expect(child.state).toBe("interrupted");
    expect(child.frame).toEqual(ownedChild(before, "Main.Child")!.frame);
    expect(child.enteredBy).toEqual(
      ownedChild(before, "Main.Child")!.enteredBy,
    );
    const fresh = new Runtime().add(id, document).init();
    const restoredGate = actionProgress(
      fresh.start(
        JSON.parse(JSON.stringify(transition.traversals)),
        EMPTY_DIALOG,
      ),
    );
    expect(restoredGate.transition).toEqual(transition.transition);
    const parent = actionProgress(
      fresh.progress(
        restoredGate,
        { move: "proceed" },
        {
          cursor: { user: 2, self: 0 },
          lastTurns: [{ role: "user", message: "parent" }],
        },
      ),
    );
    expect(parent.judgments).toHaveLength(1);
    expect(ownedChild(rootTraversal(parent), "Main.Child")?.state).toBe(
      "interrupted",
    );
    const resumed = actionProgress(
      next(fresh, parent, {
        move: "proceed",
        judgments: { [parent.judgments[0]!.id]: true },
      }),
    );
    expect(resumed.instructions[0]?.text).toBe("child");
    expect(
      ownedChild(rootTraversal(resumed), "Main.Child")?.state,
    ).toBeUndefined();
  });

  it("interruption.guard resumes unfinished work before a caught body restart", () => {
    const { runtime, brief } = boot(`function Main() {
      $enter(Child);
      function Child() {
        this.guard = () => { if (judge(\`guard pending\`)) return; return State.SKIPPED; };
        this.catchInterruption = () => true;
        $instruct(\`body\`);
      }
    }`);
    expect(ownedChild(rootTraversal(brief), "Main.Child")?.guardCompleted).toBe(
      false,
    );
    const caught = actionProgress(interrupt(runtime, brief));
    expect(caught.judgments[0]?.id).toBe(brief.judgments[0]?.id);
    expect(caught.instructions).toEqual([]);
    const work = actionProgress(
      next(runtime, caught, {
        move: "proceed",
        judgments: { [caught.judgments[0]!.id]: true },
      }),
    );
    expect(ownedChild(rootTraversal(work), "Main.Child")?.guardCompleted).toBe(
      true,
    );
    expect(work.instructions[0]?.text).toBe("body");
    expect(actionProgress(interrupt(runtime, work)).judgments).toEqual([]);
  });

  it("interruption.guard deflection catch retains the completed guard outcome", () => {
    const { brief } = boot(`function Main() { $enter(Child); function Child() {
      this.guard = () => State.DEFLECTED;
      this.catchDeflection = () => true;
      $instruct(\`after caught guard\`);
    } }`);
    expect(brief.instructions[0]?.text).toBe("after caught guard");
    expect(ownedChild(rootTraversal(brief), "Main.Child")?.guardCompleted).toBe(
      true,
    );
  });

  it("interruption.guard covered outcomes run suspendable closing effects", () => {
    const { runtime, brief } =
      boot(`import Api from "host:api"; function Main() {
      $enter(Child); $instruct(\`after\`);
      function Child() { this.guard = () => State.COVERED; this.effects = () => Api.$record(\`closed\`); $instruct(\`forbidden body\`); }
    }`);
    expect(brief.hostCalls[0]?.arguments).toEqual(["closed"]);
    expect(brief.allowedMoves).not.toContain("interrupt");
    expect(
      ownedChild(rootTraversal(brief), "Main.Child")?.state,
    ).toBeUndefined();
    const after = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        hostCalls: resolvedHostCalls(brief),
      }),
    );
    expect(after.instructions[0]?.text).toBe("after");
    expect(ownedChild(rootTraversal(after), "Main.Child")?.state).toBe(
      "covered",
    );
  });

  it("interruption.guard later skipped attempts rerun guards and retain action resolutions", () => {
    const { runtime, brief } = boot(`function Main() {
      let ready = Bool(); ready.$set(false);
      $enter(Child); ready.$set(true); $enter(Child);
      function Child() { this.guard = () => { if (ready == false) return State.SKIPPED; }; $instruct(\`retried\`); }
    }`);
    expect(brief.instructions[0]?.text).toBe("retried");
    expect(ownedChild(rootTraversal(brief), "Main.Child")?.enterCount).toBe(2);
    const done = next(runtime, brief, {
      move: "proceed",
      instructions: appliedInstructions(brief),
    });
    expect(done).toMatchObject({ outcome: "covered" });
  });

  it.each([
    ["instruction apply", "$instruct(`work`);"],
    ["standalone host call", "Api.$record(`work`);"],
    ["expression host call", "if (Api.value() > 0) $instruct(`later`);"],
    ["observation", "$observe(value);"],
    ["judgment", "if (judge(`work`)) $instruct(`later`);"],
  ])(
    "interruption.admission preserves pending %s without manufactured results",
    (_label, body) => {
      const { runtime, brief } = boot(
        `import Api from "host:api"; function Main() { let value = Num(); this.catchInterruption = () => true; ${body} }`,
      );
      expect(brief.allowedMoves).toContain("interrupt");
      const before = rootTraversal(brief).frame.actionStates;
      const caught = actionProgress(interrupt(runtime, brief));
      expect(rootTraversal(caught).frame.actionStates).toEqual(before);
      expect(caught.instructions).toEqual(brief.instructions);
      expect(caught.hostCalls).toEqual(brief.hostCalls);
      expect(caught.observations).toEqual(brief.observations);
      expect(caught.judgments).toEqual(brief.judgments);
    },
  );

  it("interruption.admission rejects bundled results and transition moves without mutation", () => {
    const { runtime, brief } = boot("function Main() { $instruct(`work`); }");
    for (const field of [
      "instructions",
      "judgments",
      "observations",
      "hostCalls",
    ]) {
      const rejected = actionProgress(
        next(runtime, brief, { move: "interrupt", [field]: {} }),
      );
      expect(rejected.issues[0]?.kind).toBe("invalid-report");
      expect(rootTraversal(rejected)).toEqual(rootTraversal(brief));
    }
    const document = parse(
      '"arc"; function Main() { $enter(Child); function Child() { $instruct(`child`); } }',
    );
    const other = new Runtime().add(id, document).init();
    const gate = actionProgress(other.enterArc(arc(id, "Main"), EMPTY_DIALOG));
    expect(gate.transition).toBeDefined();
    expect(gate.allowedMoves).not.toContain("interrupt");
    const rejected = actionProgress(
      other.progress(gate, { move: "interrupt" }, EMPTY_DIALOG),
    );
    expect(rejected.transition).toEqual(gate.transition);
    expect(rejected.traversals).toEqual(gate.traversals);
  });

  it.each([
    ["interrupt", "interrupt"],
    ["interrupt", "deflect"],
    ["deflect", "interrupt"],
    ["deflect", "deflect"],
  ] as const)(
    "interruption.replacement %s is replaced by %s across restoration",
    (first, replacement) => {
      const { runtime, brief, document } = boot(`function Main() {
      let seen = Bool();
      this.catchInterruption = () => { seen.$set(true); return judge(\`interrupt catch\`); };
      this.catchDeflection = () => { seen.$set(true); return judge(\`deflect catch\`); };
      if (judge(\`main\`)) $instruct(\`work\`);
    }`);
      const caught = actionProgress(next(runtime, brief, { move: first }));
      expect(rootTraversal(caught).cells.seen).toBe(true);
      expect(rootTraversal(caught).control).toMatchObject({
        reason: first === "interrupt" ? "interrupted" : "deflected",
        phase: "catch",
      });
      const reconstructed = restore(document, caught.traversals);
      const replaced = actionProgress(
        next(reconstructed.runtime, actionProgress(reconstructed.output), {
          move: replacement,
        }),
      );
      expect(replaced.judgments).toHaveLength(1);
      expect(rootTraversal(replaced).control).toMatchObject({
        reason: replacement === "interrupt" ? "interrupted" : "deflected",
        phase: "catch",
      });
      expect(rootTraversal(replaced).activeFrame?.activeSeg.kind).toBe(
        replacement === "interrupt" ? "catchInterruption" : "catch",
      );
      const resumed = actionProgress(
        next(reconstructed.runtime, replaced, {
          move: "proceed",
          judgments: { [replaced.judgments[0]!.id]: true },
        }),
      );
      expect(rootTraversal(resumed).cells.seen).toBe(true);
      expect(rootTraversal(resumed).control).toBeUndefined();
      expect(resumed.judgments[0]?.id).toBe(brief.judgments[0]?.id);
    },
  );
});

describe("interruption composition", () => {
  it("interruption.invoke-map preserves prior members staged output and nested owner continuations", () => {
    const { runtime, brief, document } =
      boot(`import Api from "host:api"; function Main() {
      let items = Array(Str()); let out = Array(Str()); items.$set(["a", "b"]);
      this.catchInterruption = () => true;
      invoke(() => { items.$map(() => {
        span.result.$set(span.item);
        invoke(() => { Api.$record(span.item); });
      }, out); });
    }`);
    const second = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        hostCalls: resolvedHostCalls(brief),
      }),
    );
    expect(second.hostCalls[0]?.arguments).toEqual(["b"]);
    const before = rootTraversal(second);
    const caught = actionProgress(interrupt(runtime, second));
    expect(rootTraversal(caught).frame.actionStates).toEqual(
      before.frame.actionStates,
    );
    const pendingMap = Object.values(
      rootTraversal(caught).frame.actionStates,
    ).find((state) => state?.kind === "map");
    expect(pendingMap).toMatchObject({
      status: "pending",
      map: {
        pinnedInput: ["a", "b"],
        nextIndex: 1,
        terminals: ["a"],
        staged: { set: true, value: "b" },
      },
    });
    expect(caught.hostCalls).toEqual(second.hostCalls);
    const restored = restore(document, caught.traversals);
    const work = actionProgress(restored.output);
    const done = next(restored.runtime, work, {
      move: "proceed",
      hostCalls: resolvedHostCalls(work),
    });
    expect(done).toMatchObject({ outcome: "covered" });
    expect(rootTraversal(done).cells.out).toEqual(["a", "b"]);
  });

  it("interruption.map child escalation retains pending copies bindings and return destinations", () => {
    const { runtime, brief, document } = boot(
      `function Main() {
      let items = Array(Str()); let out = Array(Str()); items.$set(["a", "b"]);
      this.catchInterruption = () => true;
      items.$map(() => { $enter(newcopy(Work), { args: { input: span.item }, returns: { output: span.result } }); }, out);
      function Work(args = { input: Str() }, returns = { output: Str() }) {
        $instruct(\`work \${args.input}\`);
        this.effects = () => returns.output.$set(args.input);
      }
    }`.replace("\${args.input}", "${args.input}"),
    );
    const second = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      }),
    );
    expect(second.instructions[0]?.text).toBe("work b");
    const before = rootTraversal(second);
    const caught = actionProgress(interrupt(runtime, second));
    expect(caught.instructions).toEqual(second.instructions);
    const copy = rootTraversal(caught).ephemeralChildren[0]!;
    expect(copy.ref).toBe(before.ephemeralChildren[0]!.ref);
    expect(copy.enterCount).toBe(before.ephemeralChildren[0]!.enterCount);
    expect(copy.enterChannels).toEqual(
      before.ephemeralChildren[0]!.enterChannels,
    );
    expect(copy.state).toBeUndefined();
    expect(rootTraversal(caught).cells.out).toBeUndefined();
    const restored = restore(document, caught.traversals);
    const work = actionProgress(restored.output);
    const done = next(restored.runtime, work, {
      move: "proceed",
      instructions: appliedInstructions(work),
    });
    expect(rootTraversal(done).cells.out).toEqual(["a", "b"]);
  });

  it.each(["canonical", "forgetful", "newcopy"])(
    "interruption.entry retains pending %s progress and return transaction",
    (mode) => {
      const target = mode === "canonical" ? "Work" : `${mode}(Work)`;
      const { runtime, brief } =
        boot(`import Api from "host:api"; function Main() {
      let input = Str(); let output = Str(); input.$set("original");
      this.catchInterruption = () => true;
      $enter(${target}, { args: { input }, returns: { output } });
      function Work(args = { input: Str() }, returns = { output: Str() }) {
        Api.$record(\`registered\`);
        $instruct(\`pending\`);
        this.effects = () => returns.output.$set(args.input);
      }
    }`);
      const work = actionProgress(
        next(runtime, brief, {
          move: "proceed",
          hostCalls: resolvedHostCalls(brief),
        }),
      );
      const before = rootTraversal(work);
      const caught = actionProgress(interrupt(runtime, work));
      const after = rootTraversal(caught);
      const child =
        mode === "newcopy"
          ? after.ephemeralChildren[0]!
          : after.ownedChildren[0]!;
      const previous =
        mode === "newcopy"
          ? before.ephemeralChildren[0]!
          : before.ownedChildren[0]!;
      expect(child.frame).toEqual(previous.frame);
      expect(child.enterCount).toBe(previous.enterCount);
      expect(child.enterChannels).toEqual(previous.enterChannels);
      expect(caught.hostCalls).toEqual([]);
      expect(after.cells.output).toBeUndefined();
      const done = next(runtime, caught, {
        move: "proceed",
        instructions: appliedInstructions(caught),
      });
      expect(rootTraversal(done).cells.output).toBe("original");
    },
  );

  it("interruption.loop retains its pending entry and retries a skipped next iteration", () => {
    const { runtime, brief } = boot(`function Main() {
      let ready = Bool(); ready.$set(false);
      this.catchInterruption = () => true;
      $enterLoop(Work, { resolveWhen: () => { if (ready == false) { ready.$set(true); return false; } return true; } });
      function Work() { this.guard = () => { if (ready == false) return State.SKIPPED; }; $instruct(\`loop work\`); }
    }`);
    expect(ownedChild(rootTraversal(brief), "Main.Work")?.enterCount).toBe(2);
    const caught = actionProgress(interrupt(runtime, brief));
    expect(ownedChild(rootTraversal(caught), "Main.Work")?.enterCount).toBe(2);
    expect(caught.instructions).toEqual(brief.instructions);
    const done = next(runtime, caught, {
      move: "proceed",
      instructions: appliedInstructions(caught),
    });
    expect(done).toMatchObject({ outcome: "covered" });
  });

  it("interruption.postcheck retains applied instruction evidence without reapplying", () => {
    const { runtime, brief } = boot(`function Main() {
      this.catchInterruption = () => true;
      $instructLoop(\`apply once\`, { resolveWhen: () => judge(\`confirmed\`) });
    }`);
    const postcheck = actionProgress(
      next(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      }),
    );
    expect(postcheck.instructions[0]?.phase).toBe("postcheck");
    const caught = actionProgress(interrupt(runtime, postcheck));
    expect(caught.instructions[0]?.phase).toBe("postcheck");
    expect(rootTraversal(caught).frame.actionStates).toEqual(
      rootTraversal(postcheck).frame.actionStates,
    );
    const done = next(runtime, caught, {
      move: "proceed",
      judgments: { [caught.judgments[0]!.id]: true },
    });
    expect(done).toMatchObject({ outcome: "covered" });
  });

  it("interruption.hook performs ask observation writes and expression host calls across restoration", () => {
    const { runtime, brief, document } =
      boot(`import Flags from "host:flags"; function Main() {
      let answer = Bool(); let observed = Num();
      this.catchInterruption = () => {
        $observeOrAsk(answer); $observe(observed);
        check: { if (answer == false) break check; return Flags.enabled(); }
        return false;
      };
      $instruct(\`main work\`);
    }`);
    const ask = actionProgress(interrupt(runtime, brief));
    const stillAsking = actionProgress(
      next(runtime, ask, {
        move: "proceed",
        observations: { [ask.observations[0]!.id]: { status: "needs-user" } },
      }),
    );
    expect(stillAsking.observations[0]?.id).toBe(ask.observations[0]?.id);
    const observed = actionProgress(
      next(runtime, stillAsking, {
        move: "proceed",
        observations: {
          [stillAsking.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      }),
    );
    const restored = restore(document, observed.traversals);
    const observation = actionProgress(restored.output);
    const host = actionProgress(
      next(restored.runtime, observation, {
        move: "proceed",
        observations: {
          [observation.observations[0]!.id]: { status: "resolved", value: 7 },
        },
      }),
    );
    expect(rootTraversal(host).state).toBeUndefined();
    expect(host.hostCalls).toHaveLength(1);
    const work = actionProgress(
      next(restored.runtime, host, {
        move: "proceed",
        hostCalls: {
          [host.hostCalls[0]!.id]: { status: "resolved", value: true },
        },
      }),
    );
    expect(work.instructions[0]?.text).toBe("main work");
    expect(rootTraversal(work).cells).toMatchObject({
      answer: true,
      observed: 7,
    });
    expect(rootTraversal(work).frame.evaluatorActionStates).toEqual({});
  });

  it("interruption.skipped exit acknowledgment completes the attempt without body work", () => {
    const document = parse(
      '"arc"; function Main() { $enter(Child); $instruct(`parent`); function Child() { this.guard = () => State.SKIPPED; $instruct(`forbidden`); } }',
    );
    const runtime = new Runtime().add(id, document).init();
    const entry = actionProgress(
      runtime.enterArc(arc(id, "Main"), EMPTY_DIALOG),
    );
    const exit = actionProgress(
      runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG),
    );
    expect(exit.transition?.exited).toEqual([node(id, "Main.Child")]);
    const skipped = ownedChild(rootTraversal(exit), "Main.Child")!;
    expect(skipped).toMatchObject({
      state: "skipped",
      enterCount: 1,
      guardCompleted: true,
    });
    const after = actionProgress(
      runtime.progress(exit, { move: "proceed" }, EMPTY_DIALOG),
    );
    expect(after.instructions[0]?.text).toBe("parent");
    expect(ownedChild(rootTraversal(after), "Main.Child")).toEqual({
      ...skipped,
      enteredBy: undefined,
    });
  });

  it("interruption.replacement parent deflection retains interrupted child for later entry", () => {
    const { runtime, brief } = boot(`function Main() {
      this.catchDeflection = () => true;
      $enter(Wrapper);
      function Wrapper() {
        this.catchInterruption = () => judge(\`wrapper catch\`);
        $enter(Work);
        function Work() { $instruct(\`child retained\`); }
      }
    }`);
    const before = ownedChild(rootTraversal(brief), "Main.Wrapper")!
      .ownedChildren[0]!;
    const catching = actionProgress(interrupt(runtime, brief));
    const marked = ownedChild(rootTraversal(catching), "Main.Wrapper")!
      .ownedChildren[0]!;
    expect(marked.state).toBe("interrupted");
    const resumed = actionProgress(
      next(runtime, catching, { move: "deflect" }),
    );
    const child = ownedChild(rootTraversal(resumed), "Main.Wrapper")!
      .ownedChildren[0]!;
    expect(child.state).toBeUndefined();
    expect(child.frame).toEqual(before.frame);
    expect(child.enterCount).toBe(before.enterCount);
    expect(resumed.instructions[0]?.text).toBe("child retained");
  });
});

it("interruption.imported retains referenced entry channels guard and registration work", () => {
  const parent =
    parse(`"arc"; import Api from "host:api"; import { Work } from "worker";
    function Main() { let input = Str(); let output = Str(); input.$set("retained");
      this.catchInterruption = () => Work.state == State.INTERRUPTED;
      Api.$record(\`timer registered\`);
      $enter(Work, { args: { input }, returns: { output } });
    }`);
  const child =
    parse(`"arc"; function Work(args = { input: Str() }, returns = { output: Str() }) {
    this.guard = () => { if (judge(\`enter guard\`)) return; return State.SKIPPED; };
    $instruct(\`imported work\`); this.effects = () => returns.output.$set(args.input);
  }`);
  const create = () =>
    new Runtime().add("worker", child).add(id, parent).init();
  const runtime = create();
  let brief = actionProgress(
    settleTransitions(
      runtime,
      runtime.enterArc(arc(id, "Main"), EMPTY_DIALOG),
      EMPTY_DIALOG,
    ),
  );
  brief = actionProgress(
    next(runtime, brief, {
      move: "proceed",
      hostCalls: resolvedHostCalls(brief),
    }),
  );
  brief = actionProgress(
    next(runtime, brief, {
      move: "proceed",
      judgments: { [brief.judgments[0]!.id]: true },
    }),
  );
  const before = brief.traversals.find(
    (item) => item.ref === arc("worker", "Work"),
  )!;
  const resumed = actionProgress(interrupt(runtime, brief));
  const retained = resumed.traversals.find((item) => item.ref === before.ref)!;
  expect(retained.frame).toEqual(before.frame);
  expect(retained.enterChannels).toEqual(before.enterChannels);
  expect(retained.enterCount).toBe(before.enterCount);
  expect(retained.state).toBeUndefined();
  expect(resumed.hostCalls).toEqual([]);
  const fresh = create();
  const work = actionProgress(
    settleTransitions(
      fresh,
      fresh.start(JSON.parse(JSON.stringify(resumed.traversals)), EMPTY_DIALOG),
      EMPTY_DIALOG,
    ),
  );
  const done = next(fresh, work, {
    move: "proceed",
    instructions: appliedInstructions(work),
  });
  expect(rootTraversal(done).cells.output).toBe("retained");
});

it("interruption.forgetting clears prior action resolutions before a skipping guard", () => {
  const { runtime, brief } = boot(`import Api from "host:api"; function Main() {
    let skip = Bool(); skip.$set(false);
    $enter(Work); skip.$set(true); $enter(forgetful(Work));
    function Work() { this.guard = () => { if (skip == true) return State.SKIPPED; }; Api.$record(\`only first entry\`); }
  }`);
  const done = next(runtime, brief, {
    move: "proceed",
    hostCalls: resolvedHostCalls(brief),
  });
  const child = ownedChild(rootTraversal(done), "Main.Work")!;
  expect(child).toMatchObject({
    state: "skipped",
    enterCount: 2,
    guardCompleted: true,
  });
  expect(child.frame.actionStates).toEqual({});
});

it("interruption.enter-loop hook retains its completed iteration while catching", () => {
  const { runtime, brief } = boot(`function Main() {
    this.catchInterruption = () => true;
    $enterLoop(Work, { resolveWhen: () => judge(\`loop complete\`) });
    function Work() {}
  }`);
  const before = ownedChild(rootTraversal(brief), "Main.Work")!;
  const caught = actionProgress(interrupt(runtime, brief));
  expect(ownedChild(rootTraversal(caught), "Main.Work")).toEqual(before);
  expect(rootTraversal(caught).frame.actionStates).toEqual(
    rootTraversal(brief).frame.actionStates,
  );
  const done = next(runtime, caught, {
    move: "proceed",
    judgments: { [caught.judgments[0]!.id]: true },
  });
  expect(done).toMatchObject({ outcome: "covered" });
});

it("interruption.false catch preserves completed consultation data without replaying it", () => {
  const { runtime, brief, document } = boot(`function Main() {
    let seen = Bool(); this.catchInterruption = () => { seen.$set(true); return false; };
    $instruct(\`pending\`);
  }`);
  const stopped = interrupt(runtime, brief);
  const retained = rootTraversal(stopped);
  expect(retained).toMatchObject({
    state: "interrupted",
    control: { reason: "interrupted", phase: "complete" },
    cells: { seen: true },
  });
  expect(Object.keys(retained.frame.evaluatorActionStates)).toContain(
    "catchInterruption",
  );
  const restored = restore(document, stopped.traversals);
  expect(restored.output).toMatchObject({ canProgress: true });
  expect(rootTraversal(restored.output).control).toEqual(retained.control);
  expect(rootTraversal(restored.output).frame.evaluatorActionStates).toEqual(
    retained.frame.evaluatorActionStates,
  );
});

it("interruption.replacement starts a fresh catch after completed interruption and authored deflection", () => {
  const { runtime, brief, document } = boot(`function Main() {
    this.catchInterruption = () => judge(\`catch interruption\`);
    this.catchDeflection = () => judge(\`catch deflection\`);
    this.deflectWhen = () => judge(\`leave work\`);
    $instruct(\`pending work\`);
  }`);
  const catching = actionProgress(interrupt(runtime, brief));
  const stopped = next(runtime, catching, {
    move: "proceed",
    judgments: { [catching.judgments[0]!.id]: false },
  });
  expect(stopped).toMatchObject({ outcome: "interrupted" });
  const restored = restore(document, stopped.traversals);
  const work = actionProgress(restored.output);
  const deflecting = actionProgress(
    next(restored.runtime, work, {
      move: "proceed",
      judgments: { [work.judgments[0]!.id]: true },
    }),
  );
  expect(rootTraversal(deflecting).control).toMatchObject({
    reason: "deflected",
    phase: "catch",
  });
  const interrupted = actionProgress(interrupt(restored.runtime, deflecting));
  expect(rootTraversal(interrupted).control).toEqual({
    reason: "interrupted",
    phase: "catch",
  });
  expect(interrupted.judgments).toHaveLength(1);
  expect(interrupted.judgments[0]!.id).toBe(catching.judgments[0]!.id);
});
