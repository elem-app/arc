/**
 * Behavior tests for pin-tape semantics (`seg.pins` in specs/testing.md, plus
 * the pin-lifetime cases of `act.judge`, `act.host-call`,
 * `hook.catch-deflection`, `hook.trigger-match`, and `hook.deflect-when`).
 *
 * Every non-constant sigil-less evaluation pins once per walk: pins survive
 * suspension, seek, brief rebuild, and persistence, and release only through
 * dial-back. These cases pin the livelock fix (a judge-gated condition before
 * a later blocking action makes progress every brief) and the deliberate
 * counterpart (a state-changing rewalk re-asks under the fresh rendering).
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import {
  beginValuePin,
  settleHostCallPin,
  settleJudgmentPin,
} from "../src/runtime/pins.js";
import type { ArcTraversalSet, Dialog } from "../src/types/index.js";
import { nodeSegKey } from "../src/types/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  renderSemanticTextForTest,
  rootTraversal,
  TestRuntime as Runtime,
  startRun,
  startTrigger,
  withExperimentalRewalk,
} from "./helpers.js";

const GATED_OBSERVE_SOURCE = `
"arc";

function Main() {
  let topic = Str();
  topic.observing = \`what topic\`;

  if (judge(\`likes music\`)) {
    $observe(topic);
  }
  $instruct(\`done\`);
}
`;

describe("pins", () => {
  describe("seg.pins", () => {
    it("artifact.construct blocks and resumes a nested host path exactly once", () => {
      const document = parse(`
"arc";
import Slugs from "host:slugs";
function Main() {
  let artifact = Artifact("initial.md");
  artifact.$set(Artifact(Slugs.next()));
}
`);
      const statement = document.roots[0]!.statements[0]!;
      if (
        statement.kind !== "set" ||
        statement.value.kind !== "artifact" ||
        statement.value.path.kind !== "host-call"
      ) {
        throw new Error("expected dynamic Artifact construction");
      }
      expect(statement.value.path).toMatchObject({
        kind: "host-call",
        id: "body/0~0",
      });

      const runtime = new Runtime().add("artifact-host-path", document).init();
      const first = actionProgress(
        runtime.enterArc(arc("artifact-host-path", "Main"), EMPTY_DIALOG),
      );
      expect(first.hostCalls).toHaveLength(1);
      expect(first.hostCalls[0]).toMatchObject({
        module: "slugs",
        operation: "next",
      });

      const terminal = progressTerminal(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: {
            status: "resolved",
            value: "docs/current.md",
          },
        },
      });
      expect(rootTraversal(terminal).cells.artifact).toEqual({
        path: "docs/current.md",
      });
      expect("hostCalls" in terminal).toBe(false);
    });

    it("pins every non-constant expression node and completed semantic render", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  if (\`\${Dialog.lastUserMessage}\` == "go" && Dialog.cursor.totalTurnsSince(startedAt) >= 1) {
    $instruct(\`seen \${Dialog.lastUserMessage}\`);
  }
}
`);
      const runtime = new Runtime()
        .add("pin-expression-tree-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-expression-tree-arc", "Main"),
      );
      seeded.phase = "entered";
      seeded.cells.startedAt = { user: 0, self: 0 };

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "go" }],
      });
      expect(brief.instructions.map((item) => item.text)).toEqual(["seen go"]);

      const statementEntries = Object.values(
        rootTraversal(brief).frame.pinTapes?.[nodeSegKey("body")] ?? {},
      );
      const values = statementEntries
        .flat()
        .filter((entry) => entry.kind === "value");

      // Condition: logical, two binaries, a value template, lastUserMessage,
      // dialogTurnsSince, Dialog.cursor, and the stored baseline. Instruction:
      // the completed semantic render plus its lastUserMessage interpolation.
      expect(values).toHaveLength(10);
      expect(values.every((entry) => entry.resolved)).toBe(true);
      expect(values.some((entry) => entry.subtreeSize === 8)).toBe(true);
      expect(values.some((entry) => entry.subtreeSize === 3)).toBe(true);
      expect(values.some((entry) => entry.subtreeSize === 2)).toBe(true);
    });

    it("requires the tape as the sole source of sigil-less evaluation", () => {
      expect(() => beginValuePin({})).toThrow(/active pin scope/);
      expect(() => settleJudgmentPin({}, "judge:test", true)).toThrow(
        /active pin scope/,
      );
      expect(() =>
        settleHostCallPin({}, "host-call:test", { value: "reported" }),
      ).toThrow(/active pin scope/);
    });

    it("a judge-gated condition before a blocking observation does not livelock", () => {
      const runtime = new Runtime()
        .add(
          "pin-livelock-arc",
          withExperimentalRewalk(parse(GATED_OBSERVE_SOURCE), "Main"),
        )
        .init();
      const seeded = runtime.newTraversal(arc("pin-livelock-arc", "Main"));
      seeded.phase = "entered";

      // Brief 1: the gating judgment.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.judgments).toHaveLength(1);
      expect(first.observations).toHaveLength(0);

      // Brief 2: the answer pins, the seek lands on the observation — the
      // judgment is not re-posed.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.judgments).toHaveLength(0);
      expect(second.observations).toHaveLength(1);

      // Brief 3: the observation's own cell write dials the body back, so the
      // judgment re-poses — a fresh evaluation caused by the write, not the
      // livelock. Progress happened: the observation is settled.
      const third = progressBrief(runtime, second, {
        move: "proceed",
        observations: {
          [second.observations[0]!.id]: { status: "resolved", value: "jazz" },
        },
      });
      expect(third.judgments).toHaveLength(1);
      expect(third.observations).toHaveLength(0);
      expect(rootTraversal(third).cells.topic).toBe("jazz");

      // Brief 4: the re-asked judgment pins, the resolved observe is skipped,
      // and the trailing instruction surfaces. The walk terminates.
      const fourth = progressBrief(runtime, third, {
        move: "proceed",
        judgments: { [third.judgments[0]!.id]: true },
      });
      expect(fourth.judgments).toHaveLength(0);
      expect(fourth.instructions.map((item) => item.text)).toEqual(["done"]);

      const done = progressTerminal(runtime, fourth, {
        move: "proceed",
        instructions: appliedInstructions(fourth),
      });
      expect(rootTraversal(done).phase).toBe("completed");
    });

    it("retains earlier pins and accrues later expressions after a direct write", () => {
      const runtime = new Runtime()
        .add(
          "pin-write-advance-arc",
          parse(`
"arc";

function Main() {
  let ready = Bool();
  if (judge(\`may proceed\`)) {
    ready.$set(true);
  }
  if (ready == true) {
    $instruct(\`ready\`);
  }
}
`),
        )
        .init();
      const seeded = runtime.newTraversal(arc("pin-write-advance-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.judgments).toHaveLength(1);
      const beforeEntries = Object.values(
        rootTraversal(first).frame.pinTapes?.[nodeSegKey("body")] ?? {},
      ).flat();

      const advanced = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });

      expect(advanced.judgments).toHaveLength(0);
      expect(advanced.instructions.map((item) => item.text)).toEqual(["ready"]);
      const afterEntries = Object.values(
        rootTraversal(advanced).frame.pinTapes?.[nodeSegKey("body")] ?? {},
      ).flat();
      expect(afterEntries.length).toBeGreaterThan(beforeEntries.length);
      expect(afterEntries).toContainEqual(
        expect.objectContaining({
          kind: "judgment",
          briefId: first.judgments[0]!.id,
          resolved: true,
          value: true,
        }),
      );
    });

    it("a pure seek reuses the pinned judgment with no repeated ids", () => {
      const runtime = new Runtime()
        .add("pin-pure-seek-arc", parse(GATED_OBSERVE_SOURCE))
        .init();
      const seeded = runtime.newTraversal(arc("pin-pure-seek-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const judgmentId = first.judgments[0]!.id;

      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [judgmentId]: true },
      });
      expect(second.observations).toHaveLength(1);

      // An `unknown` observation consumes the action without writing: no state
      // change, no dial-back — the instruction surfaces on brief 3 and the
      // judgment id never repeats.
      const third = progressBrief(runtime, second, {
        move: "proceed",
        observations: {
          [second.observations[0]!.id]: { status: "unknown" },
        },
      });
      expect(third.judgments).toHaveLength(0);
      expect(third.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("a compound judge condition settles one side per brief without re-asking the other", () => {
      const document = parse(`
"arc";

function Main() {
  if (judge(\`likes music\`) && judge(\`likes metal\`)) {
    $instruct(\`both\`);
  }
  $instruct(\`after\`);
}
`);
      const runtime = new Runtime()
        .add("pin-compound-judge-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-compound-judge-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(
        first.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["likes music"]);

      // The left answer pins; only the right side briefs next.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(
        second.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["likes metal"]);

      const third = progressBrief(runtime, second, {
        move: "proceed",
        judgments: { [second.judgments[0]!.id]: true },
      });
      expect(third.judgments).toHaveLength(0);
      expect(third.instructions.map((item) => item.text)).toEqual(["both"]);
      const fourth = progressBrief(runtime, third, {
        move: "proceed",
        instructions: appliedInstructions(third),
      });
      expect(fourth.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("a judge-or-host-call condition keeps the pinned false while the host call blocks", () => {
      const document = parse(`
"arc";

import Score from "host:scorer";

function Main() {
  if (judge(\`certain\`) || Score.check() == "ok") {
    $instruct(\`in\`);
  }
  $instruct(\`out\`);
}
`);
      const runtime = new Runtime()
        .add("pin-judge-or-call-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("pin-judge-or-call-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.judgments).toHaveLength(1);
      expect(first.hostCalls).toHaveLength(0);

      // The false pins; the short-circuit falls through to the host call,
      // which briefs alone.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: false },
      });
      expect(second.judgments).toHaveLength(0);
      expect(second.hostCalls).toHaveLength(1);

      const third = progressBrief(runtime, second, {
        move: "proceed",
        hostCalls: {
          [second.hostCalls[0]!.id]: { status: "resolved", value: "ok" },
        },
      });
      expect(third.instructions.map((item) => item.text)).toEqual(["in"]);
      const fourth = progressBrief(runtime, third, {
        move: "proceed",
        instructions: appliedInstructions(third),
      });
      expect(fourth.instructions.map((item) => item.text)).toEqual(["out"]);
    });

    it("a judge inside a resolved $set value is skipped with its statement", () => {
      const document = parse(`
"arc";

function Main() {
  let count = Num();
  count.$set(judge(\`high\`) ? 9 : 1);
  $instruct(\`count \${count}\`);
}
`);
      const runtime = new Runtime().add("pin-set-value-arc", document).init();
      const seeded = runtime.newTraversal(arc("pin-set-value-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.judgments).toHaveLength(1);

      // The write dials the body back, but the `$set` resolved first: the
      // rewalk skips the whole statement — its entries, judge included — so the
      // judgment does not re-pose.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.judgments).toHaveLength(0);
      expect(second.instructions.map((item) => item.text)).toEqual(["count 9"]);
    });

    it("pins survive a JSON round-trip into a restarted runtime", () => {
      const source = `
"arc";

import Score from "host:scorer";

function Main() {
  let topic = Str();
  topic.observing = \`what topic\`;

  if (judge(\`likes music\`)) {
    if (Score.check() == "ok") {
      $observe(topic);
    }
  }
  $instruct(\`done\`);
}
`;
      const runtime = new Runtime()
        .add("pin-restart-arc", parse(source))
        .init();
      const seeded = runtime.newTraversal(arc("pin-restart-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const answered = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(answered.hostCalls).toHaveLength(1);
      const called = progressBrief(runtime, answered, {
        move: "proceed",
        hostCalls: {
          [answered.hostCalls[0]!.id]: { status: "resolved", value: "ok" },
        },
      });
      expect(called.observations).toHaveLength(1);

      // A fresh runtime rebuilding from the persisted traversal set replays
      // the judge and host-call pins from the tape: the rebuilt brief poses
      // only the still-blocked observation.
      const revived = JSON.parse(
        JSON.stringify(called.traversals),
      ) as ArcTraversalSet;
      const restarted = new Runtime()
        .add("pin-restart-arc", parse(source))
        .init();
      const rebuilt = startRun(restarted, revived, EMPTY_DIALOG);
      expect(rebuilt.judgments).toHaveLength(0);
      expect(rebuilt.hostCalls).toHaveLength(0);
      expect(rebuilt.observations).toHaveLength(1);
    });

    it("rejects a restored pin whose durable carrier invariant was corrupted", () => {
      const source = `
"arc";
import Score from "host:scorer";
function Main() {
  let topic = Str();
  if (Score.check() == "ok") {
    $observeOrAsk(topic);
  }
}
`;
      const runtime = new Runtime()
        .add("pin-corrupt-restore-arc", parse(source))
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-corrupt-restore-arc", "Main"),
      );
      seeded.phase = "entered";
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const blocked = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: "ok" },
        },
      });
      const restored = JSON.parse(
        JSON.stringify(blocked.traversals),
      ) as ArcTraversalSet;
      const entries = Object.values(
        restored[0]!.frame.pinTapes[nodeSegKey("body")] ?? {},
      ).flat();
      const hostPin = entries.find(
        (entry) => entry.kind === "hostCall" && entry.resolved,
      );
      if (hostPin?.kind !== "hostCall") {
        throw new Error("expected a resolved host-call pin");
      }
      hostPin.hasValue = true;
      hostPin.value = Number.NaN;

      const restarted = new Runtime()
        .add("pin-corrupt-restore-arc", parse(source))
        .init();
      expect(() => restarted.start(restored, EMPTY_DIALOG)).toThrow(
        /pin contains a non-finite number/i,
      );
    });

    it("pins a dynamic observation target across needs-user and JSON restart", () => {
      const source = `
"arc";
function Main() {
  let items = Array(Str({ observing: \`selected item\` }));
  let index = Num();
  items.$set(["a", "b"]);
  index.$set(0);
  $observeOrAsk(items[index]);
}
`;
      const firstRuntime = new Runtime()
        .add("pin-observation-target-arc", parse(source))
        .init();
      const seeded = firstRuntime.newTraversal(
        arc("pin-observation-target-arc", "Main"),
      );
      seeded.phase = "entered";
      const first = startRun(firstRuntime, [seeded], EMPTY_DIALOG);
      expect(first.observations[0]).toMatchObject({ cell: "items[0]" });

      const pending = progressBrief(firstRuntime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "needs-user" },
        },
      });
      expect(pending.observations[0]).toMatchObject({ cell: "items[0]" });

      const revived = JSON.parse(
        JSON.stringify(pending.traversals),
      ) as ArcTraversalSet;
      const revivedRoot = revived.find(
        (traversal) => traversal.enteredBy === undefined,
      );
      if (!revivedRoot) throw new Error("missing revived action root");
      revivedRoot.cells.index = 1;

      const restarted = new Runtime()
        .add("pin-observation-target-arc", parse(source))
        .init();
      const rebuilt = startRun(restarted, revived, EMPTY_DIALOG);
      expect(rebuilt.observations[0]).toMatchObject({ cell: "items[0]" });

      const done = progressTerminal(restarted, rebuilt, {
        move: "proceed",
        observations: {
          [rebuilt.observations[0]!.id]: {
            status: "resolved",
            value: "A",
          },
        },
      });
      expect(rootTraversal(done).cells.index).toBe(1);
      expect(rootTraversal(done).cells.items).toEqual(["A", "b"]);
    });

    it("an inner SEG's dial-back leaves the outer SEG's pins in place", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let done = Str();
  done.observing = \`done?\`;

  if (judge(\`outer gate\`)) {
    $enter(Child);
  }
  $observe(done);
  $instruct(\`fin\`);

  function Child() {
    let x = Str();
    x.observing = \`x?\`;
    $observe(x);
    $instruct(\`child got \${x}\`);
  }
}
`),
        "Main",
        "Main.Child",
      );
      const runtime = new Runtime()
        .add("pin-scoped-release-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-scoped-release-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(
        first.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["outer gate"]);

      const entered = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(entered.observations).toHaveLength(1);
      expect(entered.judgments).toHaveLength(0);

      // The child's observation write dials the CHILD body back; the outer
      // judge pin is untouched — no judgment re-poses.
      const childWorked = progressBrief(runtime, entered, {
        move: "proceed",
        observations: {
          [entered.observations[0]!.id]: { status: "resolved", value: "v" },
        },
      });
      expect(childWorked.judgments).toHaveLength(0);
      expect(childWorked.instructions.map((item) => item.text)).toEqual([
        "child got v",
      ]);

      // The child covers and the caller advances (its read-set is untouched by
      // the child's cell): the outer pin still holds through the bubble-up.
      const observing = progressBrief(runtime, childWorked, {
        move: "proceed",
        instructions: appliedInstructions(childWorked),
      });
      expect(observing.judgments).toHaveLength(0);
      expect(observing.observations).toHaveLength(1);

      // Main's own observation write dials MAIN's body back: now the outer
      // judge releases and re-asks, while the resolved enter stays pinned.
      const rewalked = progressBrief(runtime, observing, {
        move: "proceed",
        observations: {
          [observing.observations[0]!.id]: { status: "resolved", value: "yes" },
        },
      });
      expect(
        rewalked.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["outer gate"]);

      const finished = progressBrief(runtime, rewalked, {
        move: "proceed",
        judgments: { [rewalked.judgments[0]!.id]: true },
      });
      expect(finished.instructions.map((item) => item.text)).toEqual(["fin"]);
    });

    it("a judgment resolving under an advanced dialog with no write advances without re-asking", () => {
      const document = parse(`
"arc";

function Main() {
  if (judge(\`go?\`)) {
    $instruct(\`gone\`);
  }
  $instruct(\`tail\`);
}
`);
      const runtime = new Runtime()
        .add("pin-dialog-advance-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-dialog-advance-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.judgments).toHaveLength(1);

      // The dialog advanced two turns while the walk was suspended. The
      // judgment writes nothing, so the resolution advances — dialog
      // advancement alone is not a state change and releases no pins.
      const later: Dialog = {
        cursor: { user: 2, self: 2 },
        lastTurns: [{ role: "user", message: "still here" }],
      };
      const second = progressBrief(
        runtime,
        first,
        { move: "proceed", judgments: { [first.judgments[0]!.id]: true } },
        later,
      );
      expect(second.judgments).toHaveLength(0);
      expect(second.instructions.map((item) => item.text)).toEqual(["gone"]);
      const third = progressBrief(
        runtime,
        second,
        {
          move: "proceed",
          instructions: appliedInstructions(second),
        },
        later,
      );
      expect(third.instructions.map((item) => item.text)).toEqual(["tail"]);
    });
  });

  describe("hook.catch-deflection pins", () => {
    it("a catch consultation seeks its answered judge while a later leaf blocks", () => {
      const document = parse(`
"arc";

function Main() {
  let reason = Str();
  reason.observing = \`why the detour\`;

  this.catchDeflection = () => {
    if (judge(\`worth retrying\`)) {
      $observeOrAsk(reason);
      return true;
    }
    return false;
  };

  $enter(Child);

  function Child() {
    let topic = Str();
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("pin-catch-seek-arc", document).init();
      const seeded = runtime.newTraversal(arc("pin-catch-seek-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const catching = progressBrief(runtime, brief, { move: "deflect" });
      expect(
        catching.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["worth retrying"]);

      // The judge answer pins for the consultation; the hook's own blocked
      // observation briefs alone — the judgment is not re-posed by the seek.
      const asking = progressBrief(runtime, catching, {
        move: "proceed",
        judgments: { [catching.judgments[0]!.id]: true },
      });
      expect(asking.judgments).toHaveLength(0);
      expect(asking.observations).toHaveLength(1);
      expect(asking.observations[0]).toMatchObject({ cell: "reason" });
    });
  });

  describe("hook.deflect-when identity", () => {
    it("an inherited deflectWhen poses a distinct judgment per owning instruction", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  $instruct(\`one\`);
  $instruct(\`two\`);
}
`);
      const runtime = new Runtime()
        .add("pin-inherited-hook-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("pin-inherited-hook-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.instructions.map((item) => item.text)).toEqual(["one"]);
      expect(
        brief.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["user wants to stop"]);
      const firstId = brief.judgments[0]!.id;
      expect(brief.instructions[0]!.postcheck?.judgmentIds).toEqual([firstId]);

      const second = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
        judgments: { [firstId]: false },
      });
      expect(second.instructions.map((item) => item.text)).toEqual(["two"]);
      expect(
        second.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user wants to stop"]);
      const secondId = second.judgments[0]!.id;
      expect(firstId).not.toEqual(secondId);
      expect(second.instructions[0]!.postcheck?.judgmentIds).toEqual([
        secondId,
      ]);

      // The second owner's answer routes by its own id and deflects the node.
      const deflected = progressTerminal(runtime, second, {
        move: "proceed",
        judgments: { [secondId]: true },
      });
      expect(rootTraversal(deflected).phase).toBe("suspended");
      expect(rootTraversal(deflected).state).toBe("deflected");
    });
  });

  describe("hook.trigger-match pins", () => {
    const TRIGGER_SOURCE = `
"arc";

function Main() {
  this.trigger = () => {
    if (judge(\`about music\`)) {
      return judge(\`about metal\`);
    }
    return false;
  };

  $instruct(\`hello\`);
}
`;

    it("a trigger retry seeks the candidate's answered judge", () => {
      const runtime = new Runtime()
        .add("pin-trigger-seek-arc", parse(TRIGGER_SOURCE))
        .init();
      const dialog: Dialog = {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "records" }],
      };

      const first = startTrigger(runtime, dialog);
      expect(
        first.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["about music"]);

      // The retry round-trip seeks the consultation: the answered judge stays
      // pinned and only the newly reached judge poses.
      const second = runtime.progressTrigger(
        first,
        { judgments: { [first.judgments[0]!.id]: true } },
        dialog,
      );
      expect(
        second.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["about metal"]);

      const matched = runtime.progressTrigger(
        second,
        { judgments: { [second.judgments[0]!.id]: true } },
        dialog,
      );
      expect(matched.matched).toEqual(arc("pin-trigger-seek-arc", "Main"));
    });

    it("terminal candidates keep their outcomes and a chain-sent preferred match is retained", () => {
      const gated = `
"arc";

function Gated() {
  this.trigger = () => {
    if (judge(\`gated ready\`)) {
      return true;
    }
    return false;
  };

  $instruct(\`gated\`);
}
`;
      const eager = `
"arc";

function Eager() {
  this.trigger = () => {
    return judge(\`eager ready\`);
  };

  $instruct(\`eager\`);
}
`;
      const runtime = new Runtime()
        .add("pin-trigger-gated-arc", parse(gated))
        .add("pin-trigger-eager-arc", parse(eager))
        .init();
      const dialog: Dialog = {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "go" }],
      };

      const first = startTrigger(runtime, dialog);
      expect(first.judgments).toHaveLength(2);
      const eagerJudgment = first.judgments.find(
        (item) => renderSemanticTextForTest(item.question) === "eager ready",
      )!;
      const gatedJudgment = first.judgments.find(
        (item) => renderSemanticTextForTest(item.question) === "gated ready",
      )!;

      // Answer only the eager candidate, and send the still-blocked gated arc
      // as the preferred match: Eager turns terminal-matched, the preference
      // is retained on the chain, and only the gated judge re-poses.
      const second = runtime.progressTrigger(
        first,
        {
          preferredMatch: arc("pin-trigger-gated-arc", "Gated"),
          judgments: { [eagerJudgment.id]: true },
        },
        dialog,
      );
      expect(second.matched).toBeUndefined();
      expect(second.matchableArcs).toEqual([
        arc("pin-trigger-eager-arc", "Eager"),
      ]);
      expect(
        second.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["gated ready"]);

      // The gated answer makes both matchable. The terminal Eager candidate
      // was not re-run (its judge never re-posed), and the retained preferred
      // match selects Gated without re-sending it.
      const matched = runtime.progressTrigger(
        second,
        { judgments: { [gatedJudgment.id]: true } },
        dialog,
      );
      expect(matched.matched).toEqual(arc("pin-trigger-gated-arc", "Gated"));
    });

    it("does not rerun a terminal match while another trigger candidate remains open", () => {
      const source = "pin-trigger-terminal-match-arc";
      const runtime = new Runtime()
        .add(
          source,
          parse(`
"arc";

function Terminal() {
  this.trigger = () => {
    return judge(\`terminal candidate ready\`);
  };
}

function Open() {
  this.trigger = () => {
    return judge(\`open candidate ready\`);
  };
}
`),
        )
        .init();

      const first = startTrigger(runtime, EMPTY_DIALOG);
      const terminalJudgment = first.judgments.find(
        (item) =>
          renderSemanticTextForTest(item.question) ===
          "terminal candidate ready",
      )!;

      const second = runtime.progressTrigger(
        first,
        { judgments: { [terminalJudgment.id]: true } },
        EMPTY_DIALOG,
      );

      expect(second.matched).toBeUndefined();
      expect(second.matchableArcs).toEqual([arc(source, "Terminal")]);
      expect(
        second.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["open candidate ready"]);

      const third = runtime.progressTrigger(second, {}, EMPTY_DIALOG);

      expect(third.matched).toBeUndefined();
      expect(third.matchableArcs).toEqual([arc(source, "Terminal")]);
      expect(
        third.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["open candidate ready"]);

      const selected = runtime.progressTrigger(
        third,
        { judgments: { [third.judgments[0]!.id]: false } },
        EMPTY_DIALOG,
      );
      expect(selected.matched).toEqual(arc(source, "Terminal"));
    });

    it("a fresh startTrigger starts new consultations", () => {
      const runtime = new Runtime()
        .add("pin-trigger-fresh-arc", parse(TRIGGER_SOURCE))
        .init();
      const dialog: Dialog = {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "records" }],
      };

      const first = startTrigger(runtime, dialog);
      const second = runtime.progressTrigger(
        first,
        { judgments: { [first.judgments[0]!.id]: false } },
        dialog,
      );
      // The candidate is terminal-unmatched on this chain: nothing re-poses.
      expect(second.judgments).toHaveLength(0);
      expect(second.matchableArcs).toEqual([]);

      // A new turn starts a new consultation: the same trigger asks afresh
      // from its persisted traversals.
      const nextTurn = startTrigger(runtime, dialog, second.traversals);
      expect(
        nextTurn.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["about music"]);
    });
  });
});
