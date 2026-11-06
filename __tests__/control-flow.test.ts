/**
 * Behavior tests for the Control Flow area (`flow.*` entries in
 * specs/testing.md).
 *
 * Ported from `parser.test.ts` and `runtime.test.ts` per the coverage
 * manifest. Every case feeds a deterministic Arc source string and injects
 * semantic results through reports, so there is no nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  node,
  progressBrief,
  progressTerminal,
  rootTraversal,
  TestRuntime as Runtime,
  settleTransitions,
  startRun,
  startTerminal,
  startTrigger,
} from "./helpers.js";

describe("control flow", () => {
  describe("flow.if-else", () => {
    it("allows equality comparisons while unset equals nothing", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (ready == ready) {
    $instruct(\`equal\`);
  } else {
    $instruct(\`different\`);
  }
  ready.$set(true);
}
`);
      const runtime = new Runtime().add("unset-equality-arc", document).init();
      const seeded = runtime.newTraversal(arc("unset-equality-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("entered");
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "different",
      ]);
    });

    it.each([
      ["condition", "ready"],
      ["logical AND", "ready && true"],
      ["logical OR", "ready || false"],
      ["negation", "!ready"],
      ["ternary condition", "ready ? true : false"],
    ])("poisons when %s evaluates an unset value", (_label, expression) => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (${expression}) {
    $instruct(\`go\`);
  }
  ready.$set(true);
}
`);
      const runtime = new Runtime().add("unset-boolean-arc", document).init();
      const seeded = runtime.newTraversal(arc("unset-boolean-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unset-value",
        }),
      ]);
    });

    it.each([
      ["unset > value", 'score > "low"'],
      ["unset >= value", 'score >= "low"'],
      ["unset < value", 'score < "high"'],
      ["unset <= value", 'score <= "high"'],
      ["value > unset", '"high" > score'],
      ["value >= unset", '"high" >= score'],
      ["value < unset", '"low" < score'],
      ["value <= unset", '"low" <= score'],
    ])("evaluates %s as false without coercion", (_label, expression) => {
      const document = parse(`
"arc";

function Main() {
  let score = Enum(["low", "high"]);
  if (${expression}) {
    $instruct(\`ordered\`);
  } else {
    $instruct(\`not ordered\`);
  }
  score.$set("high");
}
`);
      const runtime = new Runtime().add("unset-ordering-arc", document).init();
      const seeded = runtime.newTraversal(arc("unset-ordering-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("entered");
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "not ordered",
      ]);
      expect(brief.issues).toEqual([]);
    });

    it("routes on a regex test against a Str cell value", () => {
      const document = parse(`
"arc";

function Main() {
  let answer = Str();
  answer.$set("yes please");
  if (/yes/i.test(answer)) {
    $instruct(\`agreed\`);
  } else {
    $instruct(\`declined\`);
  }
}
`);
      const runtime = new Runtime().add("regex-str-arc", document).init();
      const seeded = runtime.newTraversal(arc("regex-str-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["agreed"]);
    });

    it("routes on a ternary conditional in a branch condition", () => {
      const document = parse(`
"arc";

function Main() {
  let mode = Enum(["fast", "slow"]);
  mode.$set("fast");
  if (mode == "fast" ? true : false) {
    $instruct(\`sprint\`);
  } else {
    $instruct(\`stroll\`);
  }
}
`);
      const runtime = new Runtime().add("ternary-branch-arc", document).init();
      const seeded = runtime.newTraversal(arc("ternary-branch-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["sprint"]);
    });

    it("routes on a regex test against Dialog.lastTurns(n) text", () => {
      const document = parse(`
"arc";

function Main() {
  if (/guitar/i.test(Dialog.lastTurns(2))) {
    $instruct(\`talk gear\`);
  } else {
    $instruct(\`change topic\`);
  }
}
`);
      const runtime = new Runtime().add("last-turns-arc", document).init();
      const seeded = runtime.newTraversal(arc("last-turns-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 3, self: 2 },
        lastTurns: [
          { role: "user", message: "It rained all week" },
          { role: "user", message: "I bought a guitar" },
          { role: "self", message: "Nice, what kind?" },
        ],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "talk gear",
      ]);
    });
  });

  describe("flow.label-break", () => {
    it("parses labeled blocks and labeled break statements in action graphs", () => {
      const document = parse(`
"arc";
function Main() {
  branch: {
    $instruct(\`one\`);    break branch;
    $instruct(\`two\`);  }
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "label",
        label: "branch",
        body: [
          { kind: "instruction" },
          { kind: "break", label: "branch" },
          { kind: "instruction" },
        ],
      });
    });

    it("rejects labels that do not target blocks", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  branch: if (true) {
    $instruct(\`nope\`);  }
}
`),
      ).toThrow(/labels must target a block statement/);
    });

    it("parses labeled blocks and labeled break statements in effects", () => {
      const document = parse(`
"arc";
function Main() {
  this.effects = () => {
    branch: {
      break branch;
    }
  };
}
`);

      expect(document.roots[0]?.effects?.[0]).toMatchObject({
        kind: "label",
        label: "branch",
        body: [{ kind: "break", label: "branch" }],
      });
    });

    it("rejects break statements without a label", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  branch: {
    break;
  }
}
`),
      ).toThrow(/break/i);
    });

    it("supports labeled break with the label outside an if branch", () => {
      const document = parse(`
"arc";

function Main() {
  fork: {
    if (true) {
      $instruct(\`first\`);      break fork;
    }
    $instruct(\`fallback\`);  }

  $enter(After);

  function After() {
    $instruct(\`after\`);  }
}
`);
      const runtime = new Runtime()
        .add("break-outside-if-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("break-outside-if-arc", "Main"));
      seeded.phase = "entered";

      const branchBrief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(branchBrief.instructions.map((item) => item.text)).toEqual([
        "first",
      ]);

      const afterBrief = progressBrief(runtime, branchBrief, {
        move: "proceed",
        instructions: appliedInstructions(branchBrief),
      });

      expect(afterBrief.instructions.map((item) => item.text)).toEqual([
        "after",
      ]);
    });

    it("supports labeled break with the label inside an if branch", () => {
      const document = parse(`
"arc";

function Main() {
  if (true) {
    branch: {
      $instruct(\`inner\`);      break branch;
      $instruct(\`skipped\`);    }
  }

  $enter(After);

  function After() {
    $instruct(\`after\`);  }
}
`);
      const runtime = new Runtime().add("break-inside-if-arc", document).init();
      const seeded = runtime.newTraversal(arc("break-inside-if-arc", "Main"));
      seeded.phase = "entered";

      const branchBrief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(branchBrief.instructions.map((item) => item.text)).toEqual([
        "inner",
      ]);

      const afterBrief = progressBrief(runtime, branchBrief, {
        move: "proceed",
        instructions: appliedInstructions(branchBrief),
      });

      expect(afterBrief.instructions.map((item) => item.text)).toEqual([
        "after",
      ]);
    });

    it("propagates labeled breaks through nested labels until the target matches", () => {
      const document = parse(`
"arc";

function Main() {
  outer: {
    inner: {
      $instruct(\`inner\`);      break outer;
      $instruct(\`skipped inner\`);    }
    $instruct(\`skipped outer\`);  }

  $enter(After);

  function After() {
    $instruct(\`after\`);  }
}
`);
      const runtime = new Runtime().add("nested-break-arc", document).init();
      const seeded = runtime.newTraversal(arc("nested-break-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual(["inner"]);

      const afterBrief = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });

      expect(afterBrief.instructions.map((item) => item.text)).toEqual([
        "after",
      ]);
    });

    it("unwinds labeled breaks in effects, trigger, and invoke bodies at runtime", () => {
      const effectsDocument = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let ready = Bool();
  ready.$set(true);

  this.effects = () => {
    branch: {
      if (ready == true) {
        break branch;
      }
      Memoir.facts.$apply(\`never emitted\`);
    }
  };
}
`);
      const effectsRuntime = new Runtime()
        .add("break-effects-arc", effectsDocument)
        .init();
      const effectsSeeded = effectsRuntime.newTraversal(
        arc("break-effects-arc", "Main"),
      );
      effectsSeeded.phase = "entered";
      const effectsBrief = startTerminal(
        effectsRuntime,
        [effectsSeeded],
        EMPTY_DIALOG,
      );
      expect("hostCalls" in effectsBrief).toBe(false);
      expect(rootTraversal(effectsBrief).phase).toBe("completed");

      const triggerDocument = parse(`
"arc";

function Main() {
  let topic = Str();
  topic.observing = \`what topic\`;

  this.trigger = () => {
    route: {
      if (this.enterCount == 0) {
        break route;
      }
      $observe(topic);
    }
    if (judge(\`greets\`)) {
      return true;
    }
    return false;
  };
}
`);
      const triggerRuntime = new Runtime()
        .add("break-trigger-arc", triggerDocument)
        .init();
      const triggerBrief = startTrigger(triggerRuntime, EMPTY_DIALOG);
      expect(triggerBrief.observations).toEqual([]);
      expect(triggerBrief.judgments).toHaveLength(1);

      const invokeDocument = parse(`
"arc";

function Main() {
  let mark = Bool();

  invoke(() => {
    branch: {
      if (mark != true) {
        break branch;
      }
      mark.$set(true);
    }
  });

  if (mark == true) {
    $instruct(\`wrote\`);
  } else {
    $instruct(\`skipped\`);
  }
}
`);
      const invokeRuntime = new Runtime()
        .add("break-invoke-arc", invokeDocument)
        .init();
      const invokeSeeded = invokeRuntime.newTraversal(
        arc("break-invoke-arc", "Main"),
      );
      invokeSeeded.phase = "entered";
      const invokeBrief = startRun(invokeRuntime, [invokeSeeded], EMPTY_DIALOG);
      expect(invokeBrief.instructions.map((item) => item.text)).toEqual([
        "skipped",
      ]);
    });

    it("a break after a resumed enter unwinds through the label-body frame", () => {
      const document = parse(`
"arc";

function Main() {
  fork: {
    $enter(Child);
    break fork;
    $instruct(\`skipped\`);
  }
  $instruct(\`after fork\`);

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime()
        .add("break-after-resume-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("break-after-resume-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(
        node("break-after-resume-arc", "Main.Child"),
      );

      // After Child covers, "after" resumes onto `break fork`. The label must be
      // on the body frame so unwindSegBreak finds "fork" and lands on "after
      // fork", skipping "skipped".
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "after fork",
      ]);
    });

    it("gives the invoke body an independent label scope so a name can shadow an outer label", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  scope: {
    invoke(() => {
      scope: {
        x.$set(true);
        break scope;
      }
    });
  }
}
`);
      const issues = validate(document);
      expect(
        issues.filter((issue) => issue.code === "DUPLICATE_LABEL"),
      ).toEqual([]);
    });
  });

  describe("flow.unreached-branch", () => {
    it("flow.unreached-branch retains completed and pending actions when the same branch becomes reachable again", () => {
      const document = parse(`
"arc";
function Main() {
  let enabled = Bool();
  let pendingValue = Str();
  let tailValue = Str();
  enabled.$set(true);
  this.catchDeflection = () => {
    $observe(enabled);
    return true;
  };
  if (enabled == true) {
    $instruct("once");
    $observeOrAsk(pendingValue);
  }
  $observeOrAsk(tailValue);
}
`);
      const runtime = new Runtime()
        .add("unreached-branch-arc", document)
        .init();
      const first = actionProgress(
        settleTransitions(
          runtime,
          runtime.enterArc(arc("unreached-branch-arc", "Main"), EMPTY_DIALOG),
          EMPTY_DIALOG,
        ),
      );
      expect(first.instructions.map((item) => item.text)).toEqual(["once"]);
      const pending = progressBrief(runtime, first, {
        move: "proceed",
        instructions: appliedInstructions(first),
      });
      expect(pending.observations).toHaveLength(1);
      expect(pending.observations[0]).toMatchObject({ cell: "pendingValue" });
      const hide = progressBrief(runtime, pending, { move: "deflect" });
      expect(hide.observations).toHaveLength(1);
      expect(hide.observations[0]).toMatchObject({ cell: "enabled" });
      const hidden = progressBrief(runtime, hide, {
        move: "proceed",
        observations: {
          [hide.observations[0]!.id]: { status: "resolved", value: false },
        },
      });
      expect(hidden.instructions).toEqual([]);
      expect(hidden.observations).toHaveLength(1);
      expect(hidden.observations[0]).toMatchObject({ cell: "tailValue" });
      expect(rootTraversal(hidden).cells.enabled).toBe(false);
      const show = progressBrief(runtime, hidden, { move: "deflect" });
      expect(show.observations).toHaveLength(1);
      expect(show.observations[0]).toMatchObject({ cell: "enabled" });
      const enabledAgain = progressBrief(runtime, show, {
        move: "proceed",
        observations: {
          [show.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      expect(enabledAgain.instructions).toEqual([]);
      expect(enabledAgain.observations).toHaveLength(1);
      expect(enabledAgain.observations[0]).toMatchObject({
        cell: "pendingValue",
        id: pending.observations[0]!.id,
      });
      expect(rootTraversal(enabledAgain).cells.enabled).toBe(true);
      const tail = progressBrief(runtime, enabledAgain, {
        move: "proceed",
        observations: {
          [enabledAgain.observations[0]!.id]: {
            status: "resolved",
            value: "retained",
          },
        },
      });
      expect(tail.instructions).toEqual([]);
      expect(tail.observations).toHaveLength(1);
      expect(tail.observations[0]).toMatchObject({
        cell: "tailValue",
        id: hidden.observations[0]!.id,
      });
      const done = progressTerminal(runtime, tail, {
        move: "proceed",
        observations: {
          [tail.observations[0]!.id]: { status: "resolved", value: "finished" },
        },
      });
      expect(done).toMatchObject({ outcome: "covered", issues: [] });
      expect(rootTraversal(done).cells).toMatchObject({
        enabled: true,
        pendingValue: "retained",
        tailValue: "finished",
      });
    });
  });
});
