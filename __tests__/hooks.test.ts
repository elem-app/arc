/**
 * Behavior tests for the Hooks area (`hook.*` entries in specs/testing.md),
 * ported from the original monolith test files (`parser.test.ts`,
 * `runtime.test.ts`). Every case feeds a deterministic Arc source string and
 * injects semantic results through reports, so there is no nondeterminism and
 * no flakiness mitigation is needed.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import type { Dialog } from "../src/types/index.js";
import {
  actionProgress,
  appliedHostEffects,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  METAL_SOURCE,
  node,
  ownedChild,
  progressBrief,
  progressTerminal,
  renderSemanticTextForTest,
  rootTraversal,
  TestRuntime as Runtime,
  singleObservations,
  startRun,
  startTerminal,
  startTrigger,
  withExperimentalRewalk,
} from "./helpers.js";

describe("hooks", () => {
  describe("hook.trigger-eval", () => {
    it("builds a trigger brief and yields an owned child as the active traversal", () => {
      const document = parse(METAL_SOURCE);
      const runtime = new Runtime().add("metal-arc", document).init();
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "what music are you into?" }],
      };
      const metalRef = arc("metal-arc", "Metal");

      const triggerBrief = startTrigger(runtime, dialog);

      expect(triggerBrief.matchableArcs).toEqual([]);
      expect(triggerBrief.judgments).toHaveLength(1);
      expect(triggerBrief.judgments[0]).toMatchObject({
        sourceRef: node("metal-arc", "Metal"),
      });

      const triggerOutcome = runtime.progressTrigger(
        triggerBrief,
        {
          preferredMatch: metalRef,
          judgments: {
            [triggerBrief.judgments[0]!.id]: true,
          },
        },
        dialog,
      );

      expect(triggerOutcome.matched).toEqual(metalRef);
      const matchedTraversal = triggerOutcome.traversals.find(
        (t) => t.ref === metalRef,
      );
      expect(matchedTraversal).toMatchObject({
        ref: metalRef,
        phase: "entered",
        enterCount: 1,
      });

      const brief = startRun(runtime, triggerOutcome.traversals, dialog);

      expect(rootTraversal(brief).ref).toEqual(metalRef);
      expect(brief.canProgress).toBe(true);
      expect(brief.active).toEqual(node("metal-arc", "Metal.Surface"));
      expect(brief.observations).toHaveLength(1);
      expect(brief.allowedMoves).toContain("proceed");

      const surface = ownedChild(rootTraversal(brief), "Metal.Surface");
      expect(surface?.ref).toEqual(node("metal-arc", "Metal.Surface"));
    });

    it("re-emits trigger observe after terminal false clears trigger function frame", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;
  this.trigger = () => {
    $observe(ready);
    return ready == true;
  };
}
`);
      const runtime = new Runtime()
        .add("trigger-frame-reset-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("trigger-frame-reset-arc", "Main"),
      );

      const firstBrief = startTrigger(runtime, EMPTY_DIALOG, [seeded]);
      expect(firstBrief.observations).toHaveLength(1);

      const firstOutcome = runtime.progressTrigger(
        firstBrief,
        {
          observations: {
            [firstBrief.observations[0]!.id]: { status: "unknown" },
          },
        },
        EMPTY_DIALOG,
      );
      expect(firstOutcome.matched).toBeUndefined();

      const secondBrief = startTrigger(
        runtime,
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "still not sure" }],
        },
        firstOutcome.traversals,
      );
      expect(secondBrief.observations).toHaveLength(1);
      expect(
        renderSemanticTextForTest(singleObservations(secondBrief)[0]!.question),
      ).toEqual("is user ready");
    });

    it("resolves trigger host calls and returns invalid-report for unknown trigger host call ids", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  this.trigger = () => {
    return Dice.roll(20) > 10;
  };
}
`);
      const runtime = new Runtime().add("trigger-host-id-arc", document).init();
      const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);
      expect(triggerBrief.hostCalls).toHaveLength(1);

      const bogus = runtime.progressTrigger(
        triggerBrief,
        {
          hostCalls: { "bogus-id": true },
        },
        EMPTY_DIALOG,
      );
      expect(bogus.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-report",
          reasonCode: "unknown-host-call-id",
        }),
      ]);

      const accepted = runtime.progressTrigger(
        triggerBrief,
        {
          hostCalls: { [triggerBrief.hostCalls[0]!.id]: 11 },
        },
        EMPTY_DIALOG,
      );
      expect(accepted.matched).toEqual(arc("trigger-host-id-arc", "Main"));
    });

    it("re-evaluates triggers against the latest dialog passed to progressTrigger", () => {
      const document = parse(`
"arc";

function Main() {
  this.trigger = () => {
    if (judge(\`the user wants to start\`)) {
      return /later/i.test(Dialog.lastUserMessage);
    }
    return false;
  };
}
`);
      const runtime = new Runtime().add("trigger-dialog-arc", document).init();
      const firstDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "hello" }],
      };
      const secondDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "later now" }],
      };

      const brief = startTrigger(runtime, firstDialog);
      expect(brief.judgments).toHaveLength(1);

      const outcome = runtime.progressTrigger(
        brief,
        {
          judgments: {
            [brief.judgments[0]!.id]: true,
          },
        },
        secondDialog,
      );

      expect(outcome.matched).toEqual(arc("trigger-dialog-arc", "Main"));
    });

    it("rejects unsupported statements inside trigger, guard, and effects", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  this.trigger = () => {
    const local = 1;
    return true;
  };
}
`),
      ).toThrow(/Cell declarations are only allowed directly in a node body/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  this.guard = () => {
    noop();
    return State.SKIPPED;
  };
}
`),
      ).toThrow(/Unsupported this\.guard call/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  this.effects = () => {
    while (true) {
      $observe(missing);
    }
  };
}
`),
      ).toThrow(/`while` is not supported in this\.effects/);
    });
  });

  describe("hook.trigger-state", () => {
    it("seeds traversal cells from trigger observations before entry", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Enum(["unknown", "metal"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    $observe(topic);
    if (topic == "metal") {
      return true;
    }
    return false;
  };
}
`);
      const runtime = new Runtime().add("trigger-arc", document).init();
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "let's talk about music" }],
      };
      const triggerBrief = startTrigger(runtime, dialog);

      const outcome = runtime.progressTrigger(
        triggerBrief,
        {
          observations: {
            [triggerBrief.observations[0]!.id]: {
              status: "resolved",
              value: "metal",
            },
          },
        },
        dialog,
      );

      expect(outcome.matched).toEqual(arc("trigger-arc", "Main"));
      const matched = outcome.traversals.find((t) => t.ref === outcome.matched);
      expect(matched?.cells.topic).toBe("metal");
      expect(matched?.enterCount).toBe(1);
    });

    it("treats unknown trigger observations as non-blocking for $observe()", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Enum(["unknown", "metal"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    $observe(topic);
    return topic == "metal";
  };
}
`);
      const runtime = new Runtime().add("trigger-arc", document).init();
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "hello there" }],
      };
      const triggerBrief = startTrigger(runtime, dialog);

      const outcome = runtime.progressTrigger(
        triggerBrief,
        {
          observations: {
            [triggerBrief.observations[0]!.id]: { status: "unknown" },
          },
        },
        dialog,
      );

      expect(outcome.matched).toBeUndefined();
      expect(
        outcome.traversals.find(
          (traversal) => traversal.ref === arc("trigger-arc", "Main"),
        ),
      ).toMatchObject({
        ref: arc("trigger-arc", "Main"),
        phase: "dormant",
      });
    });

    it("evaluates this.enterCount inside trigger functions across re-entry", () => {
      const document = parse(`
"arc";

function Main() {
  this.trigger = () => {
    if (
      this.enterCount == 0 &&
      judge(\`\${user} mentions music for the first time\`)
    ) {
      return true;
    }
    if (
      this.enterCount > 0 &&
      judge(\`\${user} mentions music again\`)
    ) {
      return true;
    }
  };
}
`);
      const runtime = new Runtime().add("trigger-arc", document).init();

      const firstDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "music" }],
      };
      const firstBrief = startTrigger(runtime, firstDialog);

      expect(
        firstBrief.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user mentions music for the first time"]);

      const firstOutcome = runtime.progressTrigger(
        firstBrief,
        {
          judgments: { [firstBrief.judgments[0]!.id]: true },
        },
        firstDialog,
      );

      expect(
        firstOutcome.traversals.find((t) => t.ref === firstOutcome.matched)
          ?.enterCount,
      ).toBe(1);

      const secondBrief = startTrigger(
        runtime,
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "music again" }],
        },
        firstOutcome.traversals,
      );

      expect(
        secondBrief.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user mentions music again"]);

      const secondDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "music again" }],
      };
      const secondOutcome = runtime.progressTrigger(
        secondBrief,
        {
          judgments: { [secondBrief.judgments[0]!.id]: true },
        },
        secondDialog,
      );

      expect(
        secondOutcome.traversals.find((t) => t.ref === secondOutcome.matched)
          ?.enterCount,
      ).toBe(2);
    });

    it("reports deps for unmatched trigger probes that leave traversal state", () => {
      const first = parse(`
"arc";
function First() {
  let topic = Enum(["unknown", "music"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    $observe(topic);
    return topic == "music";
  };
}
`);
      const second = parse(`
"arc";
function Second() {
  let topic = Enum(["unknown", "sports"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    $observe(topic);
    return topic == "sports";
  };
}
`);
      const runtime = new Runtime()
        .add("first-observe-arc", first)
        .add("second-observe-arc", second)
        .init();

      const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);
      const outcome = runtime.progressTrigger(
        triggerBrief,
        {
          observations: Object.fromEntries(
            triggerBrief.observations.map((observation) => [
              observation.id,
              { status: "unknown" },
            ]),
          ),
        },
        EMPTY_DIALOG,
      );

      expect(outcome.matched).toBeUndefined();
      expect(outcome.deps).toEqual([
        arc("first-observe-arc", "First"),
        arc("second-observe-arc", "Second"),
      ]);
      expect(outcome.traversals.map((traversal) => traversal.ref)).toEqual([
        arc("first-observe-arc", "First"),
        arc("second-observe-arc", "Second"),
      ]);
    });

    it("reports trigger traversal dependency ArcRefs including transitive imports", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";
import host from "host:mail";

function Main() {
  this.trigger = () => {
    return true;
  };
  $enter(Intro);
}
`);
      const intro = parse(`
"arc";
import { Shared } from "shared-arc";

function Intro() {
  this.trigger = () => {
    return false;
  };
  $enter(Shared);
}
`);
      const shared = parse(`
"arc";

function Shared() {
  this.trigger = () => {
    return false;
  };
  $instruct(\`Handle shared work.\`);
}
`);
      const runtime = new Runtime()
        .add("main-dependency-arc", main)
        .add("intro-arc", intro)
        .add("shared-arc", shared)
        .init();

      expect(runtime.startTrigger([], EMPTY_DIALOG).deps).toEqual([
        arc("main-dependency-arc", "Main"),
        arc("intro-arc", "Intro"),
        arc("shared-arc", "Shared"),
      ]);
    });
  });

  describe("hook.trigger-match", () => {
    it("does not infer a trigger match when multiple arcs are matchable", () => {
      const first = parse(`
"arc";
function First() {
  this.trigger = () => {
    return true;
  };
}
`);
      const second = parse(`
"arc";
function Second() {
  this.trigger = () => {
    return true;
  };
}
`);
      const runtime = new Runtime()
        .add("first-arc", first)
        .add("second-arc", second)
        .init();

      const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);
      const outcome = runtime.progressTrigger(triggerBrief, {}, EMPTY_DIALOG);

      expect(triggerBrief.matchableArcs).toEqual([
        arc("first-arc", "First"),
        arc("second-arc", "Second"),
      ]);
      expect(triggerBrief.deps).toEqual([
        arc("first-arc", "First"),
        arc("second-arc", "Second"),
      ]);
      expect(outcome.matched).toBeUndefined();
      expect(outcome.deps).toEqual([
        arc("first-arc", "First"),
        arc("second-arc", "Second"),
      ]);
      expect(outcome.traversals).toEqual([]);
    });

    it("auto-selects the only matchable arc when trigger report omits match", () => {
      const document = parse(`
"arc";

function First() {
  this.trigger = () => {
    return true;
  };
}

function Second() {
  this.trigger = () => {
    return false;
  };
}
`);
      const runtime = new Runtime()
        .add("single-match-trigger-arc", document)
        .init();
      const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);

      expect(triggerBrief.matched).toEqual(
        arc("single-match-trigger-arc", "First"),
      );
      expect(triggerBrief.matchableArcs).toEqual([]);
    });

    it("defers implicit auto-selection while another candidate has a pending judgment", () => {
      const document = parse(`
"arc";

function Immediate() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  this.trigger = () => {
    return judge(\`pending judgment matches\`);
  };
}
`);
      const source = "trigger-settlement-judgment-arc";
      const runtime = new Runtime().add(source, document).init();
      const immediateRef = arc(source, "Immediate");
      const pendingRef = arc(source, "Pending");

      const brief = startTrigger(runtime, EMPTY_DIALOG);

      expect(brief.matched).toBeUndefined();
      expect(brief.matchableArcs).toEqual([immediateRef]);
      expect(brief.judgments).toHaveLength(1);
      expect(brief.issues).toEqual([]);

      const unmatched = runtime.progressTrigger(
        brief,
        { judgments: { [brief.judgments[0]!.id]: false } },
        EMPTY_DIALOG,
      );
      expect(unmatched.matched).toEqual(immediateRef);

      const ambiguous = runtime.progressTrigger(
        brief,
        { judgments: { [brief.judgments[0]!.id]: true } },
        EMPTY_DIALOG,
      );
      expect(ambiguous.matched).toBeUndefined();
      expect(ambiguous.matchableArcs).toEqual([immediateRef, pendingRef]);
      expect(ambiguous.issues).toEqual([
        expect.objectContaining({
          kind: "ambiguous-match",
          matchableArcs: [immediateRef, pendingRef],
        }),
      ]);
    });

    it("defers implicit auto-selection while another candidate has a pending observation", () => {
      const document = parse(`
"arc";

function Immediate() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  let ready = Bool();
  ready.observing = \`pending observation matches\`;

  this.trigger = () => {
    $observe(ready);
    return ready == true;
  };
}
`);
      const source = "trigger-settlement-observation-arc";
      const runtime = new Runtime().add(source, document).init();
      const immediateRef = arc(source, "Immediate");
      const pendingRef = arc(source, "Pending");

      const brief = startTrigger(runtime, EMPTY_DIALOG);

      expect(brief.matched).toBeUndefined();
      expect(brief.matchableArcs).toEqual([immediateRef]);
      expect(brief.observations).toHaveLength(1);
      expect(brief.issues).toEqual([]);

      const unmatched = runtime.progressTrigger(
        brief,
        {
          observations: {
            [brief.observations[0]!.id]: { status: "resolved", value: false },
          },
        },
        EMPTY_DIALOG,
      );
      expect(unmatched.matched).toEqual(immediateRef);

      const ambiguous = runtime.progressTrigger(
        brief,
        {
          observations: {
            [brief.observations[0]!.id]: { status: "resolved", value: true },
          },
        },
        EMPTY_DIALOG,
      );
      expect(ambiguous.matched).toBeUndefined();
      expect(ambiguous.matchableArcs).toEqual([immediateRef, pendingRef]);
      expect(ambiguous.issues).toEqual([
        expect.objectContaining({
          kind: "ambiguous-match",
          matchableArcs: [immediateRef, pendingRef],
        }),
      ]);
    });

    it("defers implicit auto-selection while another candidate has a pending host call", () => {
      const document = parse(`
"arc";

import Gate from "host:gate";

function Immediate() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  this.trigger = () => {
    return Gate.ready();
  };
}
`);
      const source = "trigger-settlement-host-call-arc";
      const runtime = new Runtime().add(source, document).init();
      const immediateRef = arc(source, "Immediate");
      const pendingRef = arc(source, "Pending");

      const brief = startTrigger(runtime, EMPTY_DIALOG);

      expect(brief.matched).toBeUndefined();
      expect(brief.matchableArcs).toEqual([immediateRef]);
      expect(brief.hostCalls).toHaveLength(1);
      expect(brief.issues).toEqual([]);

      const unmatched = runtime.progressTrigger(
        brief,
        { hostCalls: { [brief.hostCalls[0]!.id]: false } },
        EMPTY_DIALOG,
      );
      expect(unmatched.matched).toEqual(immediateRef);

      const ambiguous = runtime.progressTrigger(
        brief,
        { hostCalls: { [brief.hostCalls[0]!.id]: true } },
        EMPTY_DIALOG,
      );
      expect(ambiguous.matched).toBeUndefined();
      expect(ambiguous.matchableArcs).toEqual([immediateRef, pendingRef]);
      expect(ambiguous.issues).toEqual([
        expect.objectContaining({
          kind: "ambiguous-match",
          matchableArcs: [immediateRef, pendingRef],
        }),
      ]);
    });

    it("an explicit matchable preferredMatch settles despite other pending trigger work", () => {
      const document = parse(`
"arc";

function Immediate() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  this.trigger = () => {
    return judge(\`pending preferred-match work\`);
  };
}
`);
      const source = "trigger-settlement-preferred-arc";
      const runtime = new Runtime().add(source, document).init();
      const immediateRef = arc(source, "Immediate");

      const brief = startTrigger(runtime, EMPTY_DIALOG);
      expect(brief.matchableArcs).toEqual([immediateRef]);
      expect(brief.judgments).toHaveLength(1);

      const selected = runtime.progressTrigger(
        brief,
        { preferredMatch: immediateRef },
        EMPTY_DIALOG,
      );

      expect(selected.matched).toEqual(immediateRef);
      expect(selected.matchableArcs).toEqual([]);
      expect(selected.judgments).toEqual([]);
      expect(selected.observations).toEqual([]);
      expect(selected.hostCalls).toEqual([]);
    });

    it("returns trigger-match-not-matchable when a retained preferredMatch settles unmatched beside one match", () => {
      const document = parse(`
"arc";

function Immediate() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  this.trigger = () => {
    return judge(\`pending committed match\`);
  };
}
`);
      const source = "trigger-settlement-preferred-unmatched-arc";
      const runtime = new Runtime().add(source, document).init();
      const immediateRef = arc(source, "Immediate");
      const pendingRef = arc(source, "Pending");

      const first = startTrigger(runtime, EMPTY_DIALOG);
      expect(first.matchableArcs).toEqual([immediateRef]);
      expect(first.judgments).toHaveLength(1);

      const waiting = runtime.progressTrigger(
        first,
        { preferredMatch: pendingRef },
        EMPTY_DIALOG,
      );
      expect(waiting.matched).toBeUndefined();
      expect(waiting.matchableArcs).toEqual([immediateRef]);
      expect(waiting.judgments).toHaveLength(1);
      expect(waiting.issues).toEqual([]);

      const failed = runtime.progressTrigger(
        waiting,
        { judgments: { [waiting.judgments[0]!.id]: false } },
        EMPTY_DIALOG,
      );

      expect(failed.matched).toBeUndefined();
      expect(failed.matchableArcs).toEqual([immediateRef]);
      expect(failed.judgments).toEqual([]);
      expect(failed.observations).toEqual([]);
      expect(failed.hostCalls).toEqual([]);
      expect(failed.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-report",
          reasonCode: "trigger-match-not-matchable",
        }),
      ]);
    });

    it("returns trigger-match-not-matchable instead of ambiguity when a retained preferredMatch settles unmatched beside multiple matches", () => {
      const document = parse(`
"arc";

function First() {
  this.trigger = () => {
    return true;
  };
}

function Second() {
  this.trigger = () => {
    return true;
  };
}

function Pending() {
  this.trigger = () => {
    return judge(\`pending committed match among alternatives\`);
  };
}
`);
      const source = "trigger-settlement-preferred-unmatched-ambiguous-arc";
      const runtime = new Runtime().add(source, document).init();
      const firstRef = arc(source, "First");
      const secondRef = arc(source, "Second");
      const pendingRef = arc(source, "Pending");

      const first = startTrigger(runtime, EMPTY_DIALOG);
      expect(first.matchableArcs).toEqual([firstRef, secondRef]);
      expect(first.judgments).toHaveLength(1);
      expect(first.issues).toEqual([]);

      const waiting = runtime.progressTrigger(
        first,
        { preferredMatch: pendingRef },
        EMPTY_DIALOG,
      );
      expect(waiting.matchableArcs).toEqual([firstRef, secondRef]);
      expect(waiting.judgments).toHaveLength(1);
      expect(waiting.issues).toEqual([]);

      const failed = runtime.progressTrigger(
        waiting,
        { judgments: { [waiting.judgments[0]!.id]: false } },
        EMPTY_DIALOG,
      );

      expect(failed.matched).toBeUndefined();
      expect(failed.matchableArcs).toEqual([firstRef, secondRef]);
      expect(failed.judgments).toEqual([]);
      expect(failed.observations).toEqual([]);
      expect(failed.hostCalls).toEqual([]);
      expect(failed.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-report",
          reasonCode: "trigger-match-not-matchable",
        }),
      ]);
    });

    it("returns ambiguous-match until a later trigger report names a preferred match", () => {
      const first = parse(`
"arc";

function First() {
  this.trigger = () => {
    return true;
  };
}
`);
      const second = parse(`
"arc";

function Second() {
  this.trigger = () => {
    return true;
  };
}
`);
      const runtime = new Runtime()
        .add("ambiguous-first-arc", first)
        .add("ambiguous-second-arc", second)
        .init();

      const brief = startTrigger(runtime, EMPTY_DIALOG);

      expect(brief.matched).toBeUndefined();
      expect(brief.matchableArcs).toEqual([
        arc("ambiguous-first-arc", "First"),
        arc("ambiguous-second-arc", "Second"),
      ]);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "ambiguous-match",
          matchableArcs: [
            arc("ambiguous-first-arc", "First"),
            arc("ambiguous-second-arc", "Second"),
          ],
        }),
      ]);

      const selected = runtime.progressTrigger(
        brief,
        {
          preferredMatch: arc("ambiguous-second-arc", "Second"),
        },
        EMPTY_DIALOG,
      );

      expect(selected.matched).toEqual(arc("ambiguous-second-arc", "Second"));
      expect(selected.matchableArcs).toEqual([]);
      expect(selected.judgments).toEqual([]);
      expect(selected.observations).toEqual([]);
      expect(selected.hostCalls).toEqual([]);
      expect(
        selected.traversals.find(
          (traversal) =>
            traversal.ref === arc("ambiguous-second-arc", "Second"),
        ),
      ).toMatchObject({
        ref: arc("ambiguous-second-arc", "Second"),
        phase: "entered",
        enterCount: 1,
      });
    });

    it("yields independent selected traversals for each preferredMatch from one brief (fan-out seeding invariant)", () => {
      const first = parse(`
"arc";

function First() {
  this.trigger = () => {
    return true;
  };
}
`);
      const second = parse(`
"arc";

function Second() {
  this.trigger = () => {
    return true;
  };
}
`);
      const runtime = new Runtime()
        .add("fanout-first-arc", first)
        .add("fanout-second-arc", second)
        .init();

      const firstRef = arc("fanout-first-arc", "First");
      const secondRef = arc("fanout-second-arc", "Second");

      const brief = startTrigger(runtime, EMPTY_DIALOG);
      expect(brief.matched).toBeUndefined();
      expect(brief.matchableArcs).toEqual([firstRef, secondRef]);

      // Derive each arc's seed by calling progressTrigger with a different
      // preferredMatch against the SAME stable brief.
      const selectFirst = runtime.progressTrigger(
        brief,
        { preferredMatch: firstRef },
        EMPTY_DIALOG,
      );
      const selectSecond = runtime.progressTrigger(
        brief,
        { preferredMatch: secondRef },
        EMPTY_DIALOG,
      );

      // Each probe selects its own arc, entered exactly once.
      expect(selectFirst.matched).toEqual(firstRef);
      expect(selectSecond.matched).toEqual(secondRef);
      expect(
        selectFirst.traversals.find((traversal) => traversal.ref === firstRef),
      ).toMatchObject({ ref: firstRef, phase: "entered", enterCount: 1 });
      expect(
        selectSecond.traversals.find(
          (traversal) => traversal.ref === secondRef,
        ),
      ).toMatchObject({ ref: secondRef, phase: "entered", enterCount: 1 });

      // The non-selected arc is never entered in the other probe's result.
      expect(
        selectFirst.traversals.find((traversal) => traversal.ref === secondRef)
          ?.phase,
      ).not.toBe("entered");
      expect(
        selectSecond.traversals.find((traversal) => traversal.ref === firstRef)
          ?.phase,
      ).not.toBe("entered");

      // Independence + non-mutation: re-deriving First's seed AFTER deriving
      // Second's yields an identical result, and the source brief is unchanged.
      const selectFirstAgain = runtime.progressTrigger(
        brief,
        { preferredMatch: firstRef },
        EMPTY_DIALOG,
      );
      expect(selectFirstAgain).toEqual(selectFirst);
      expect(brief.matchableArcs).toEqual([firstRef, secondRef]);
    });

    it("supports multi-round trigger resolution when later trigger work is unlocked by earlier answers", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let topic = Enum(["metal", "jazz"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    if (judge(\`\${user} is discussing music\`)) {
      $observe(topic);
      return topic == "metal";
    }
    return false;
  };
}
`),
        "Main",
      );
      const runtime = new Runtime().add("nested-trigger-arc", document).init();
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "let's talk about records" }],
      };

      const firstBrief = startTrigger(runtime, dialog);

      expect(firstBrief.matched).toBeUndefined();
      expect(firstBrief.judgments).toHaveLength(1);
      expect(firstBrief.observations).toHaveLength(0);

      const secondBrief = runtime.progressTrigger(
        firstBrief,
        {
          judgments: {
            [firstBrief.judgments[0]!.id]: true,
          },
        },
        dialog,
      );

      expect(secondBrief.matched).toBeUndefined();
      expect(secondBrief.judgments).toHaveLength(0);
      expect(secondBrief.observations).toHaveLength(1);
      expect(secondBrief.matchableArcs).toEqual([]);

      const thirdBrief = runtime.progressTrigger(
        secondBrief,
        {
          observations: {
            [secondBrief.observations[0]!.id]: {
              status: "resolved",
              value: "metal",
            },
          },
        },
        dialog,
      );

      // The observation write dials the consultation back, releasing the judge
      // pin: the judgment re-poses under the freshly derived route (its
      // question interpolates state) before the trigger can resolve.
      expect(thirdBrief.matched).toBeUndefined();
      expect(thirdBrief.judgments).toHaveLength(1);
      expect(thirdBrief.observations).toHaveLength(0);

      const finalBrief = runtime.progressTrigger(
        thirdBrief,
        {
          judgments: {
            [thirdBrief.judgments[0]!.id]: true,
          },
        },
        dialog,
      );

      expect(finalBrief.matched).toEqual(arc("nested-trigger-arc", "Main"));
      expect(finalBrief.judgments).toEqual([]);
      expect(finalBrief.observations).toEqual([]);
      expect(
        finalBrief.traversals.find(
          (traversal) => traversal.ref === arc("nested-trigger-arc", "Main"),
        ),
      ).toMatchObject({
        ref: arc("nested-trigger-arc", "Main"),
        phase: "entered",
        enterCount: 1,
      });
    });
  });

  describe("hook.deflect-when", () => {
    it("inherits the nearest node-level deflectWhen into instructions by default", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  $enter(Child);

  function Child() {
    $instructLoop(\`Stay on topic.\`, {
      resolveWhen: \`\${self} stayed on topic\`,
    });
  }
}
`);

      const child = document.roots[0]?.children.find(
        (entry) => entry.identifier === "Child",
      );
      const instruction = child?.statements[0];

      expect(instruction).toMatchObject({
        kind: "instruction",
        mode: "persistent",
      });
      expect(
        (instruction as Extract<typeof instruction, { kind: "instruction" }>)
          ?.deflectWhen,
      ).toBeDefined();
    });

    it("lets local deflectWhen override the inherited node default", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  $instructLoop(\`Stay on topic.\`, {
    resolveWhen: \`\${self} stayed on topic\`,
    deflectWhen: \`\${user} hates astronomy\`,
  });
}
`);

      const instruction = document.roots[0]?.statements[0];
      expect(instruction).toMatchObject({
        kind: "instruction",
        mode: "persistent",
      });
      const deflectWhen = (
        instruction as Extract<typeof instruction, { kind: "instruction" }>
      )?.deflectWhen;
      // Verify the local override won rather than the inherited
      // `${user} wants to stop`; a bare length check would pass either way.
      expect(deflectWhen).toMatchObject([
        {
          kind: "return",
          value: {
            kind: "judge",
            question: {
              kind: "template-string",
              parts: [
                { kind: "ref", name: "user" },
                { kind: "text", value: " hates astronomy" },
              ],
            },
          },
        },
      ]);
    });

    it("derives instruction deflection from authored deflectWhen", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`);
      const runtime = new Runtime()
        .add("instruction-deflect-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruction-deflect-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const resolutionBrief = progressBrief(runtime, brief, {
        move: "proceed",
      });

      expect(
        resolutionBrief.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual([
        "user wants to leave this topic",
        "self covered the topic enough",
      ]);

      const deflected = progressTerminal(runtime, resolutionBrief, {
        move: "proceed",
        judgments: {
          [resolutionBrief.judgments[0]!.id]: true,
          [resolutionBrief.judgments[1]!.id]: false,
        },
      });

      expect(deflected.canProgress).toBe(false);
      expect(rootTraversal(deflected).state).toBe("deflected");
      expect(rootTraversal(deflected).phase).toBe("suspended");
    });

    it("derives instruction deflection from inherited node-level deflectWhen after handback", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`);
      const runtime = new Runtime()
        .add("inherited-deflect-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("inherited-deflect-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "Carry the topic.",
      ]);

      const handback = progressBrief(runtime, brief, { move: "proceed" });

      expect(
        handback.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual([
        "user wants to leave this topic",
        "self covered the topic enough",
      ]);
    });

    // Instruction batching is disabled; retain this as future optimization
    // coverage without making it part of the current runtime suite.
    it.skip("accepts batched instruction deflect/resolve semantics in one report", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${self} ready\`;
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      $observe(ready);
      return ready == true;
    },
  });
  $instruct(\`after\`);}
`);
      const runtime = new Runtime()
        .add("instruction-batched-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruction-batched-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const handback = progressBrief(runtime, brief, { move: "proceed" });

      const deflectCheck = handback.judgments.find(
        (item) =>
          renderSemanticTextForTest(item.question) ===
          "user wants to leave this topic",
      );
      expect(deflectCheck).toBeDefined();
      expect(handback.observations).toHaveLength(1);

      const resolved = progressBrief(runtime, handback, {
        move: "proceed",
        judgments: { [deflectCheck!.id]: false },
        observations: {
          [handback.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });

      expect(rootTraversal(resolved).state).not.toBe("deflected");
      expect(resolved.instructions.map((item) => item.text)).toEqual(["after"]);
    });
  });

  describe("hook.catch-deflection", () => {
    it("parses catchDeflection with deflection.escaped(), labels, and set()", () => {
      const document = parse(`
"arc";
function Main() {
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    branch: {
      if (this.deflection.escaped(ProductIntro)) {
        wantsPricing.$set(true);
        break branch;
      }
    }
    return wantsPricing == true;
  };

  $enter(ProductIntro);

  function ProductIntro() {}
}
`);

      expect(document.roots[0]?.catchDeflection).toMatchObject([
        { kind: "label", label: "branch" },
        { kind: "return" },
      ]);
    });

    it("parses catchDeflection with $observeOrAsk() and expression-position judge()", () => {
      const document = parse(`
"arc";
function Main() {
  let route = Enum(["unknown", "pricing"]);
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    $observeOrAsk(route);
    if (route == "pricing" || judge(\`\${user} wants pricing\`)) {
      wantsPricing.$set(true);
      return true;
    }
    return false;
  };

  function ProductIntro() {}
}
`);

      expect(document.roots[0]?.catchDeflection).toMatchObject([
        { kind: "observeOrAsk", target: ["route"] },
        { kind: "if" },
        { kind: "return" },
      ]);
    });

    it.each(["newcopy", "forgetful"])(
      "rejects non-bare deflection.escaped() %s targets",
      (wrapper) => {
        expect(() =>
          parse(`
"arc";
function Main() {
  this.catchDeflection = () => {
    return this.deflection.escaped(${wrapper}(ProductIntro));
  };

  function ProductIntro() {}
}
`),
        ).toThrow(/this\.deflection\.escaped\(\) only accepts a bare target/);
      },
    );

    it("rejects deflection.escaped() outside finalization hooks", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  if (this.deflection.escaped(ProductIntro)) {
    $enter(ProductIntro);
  }

  function ProductIntro() {}
}
`),
      ).toThrow(
        "this.deflection.escaped(...) is only available inside this.catchDeflection or this.effects",
      );
    });

    it("accepts deflection.escaped() referencing the enclosing node — self-entry is impossible, so it is simply always false", () => {
      // Legal to write in both catchDeflection and effects; parses at a
      // non-root node and at a root arc alike.
      expect(() =>
        parse(`
"arc";
function Root() {
  this.catchDeflection = () => {
    return this.deflection.escaped(Root);
  };

  let flag = Bool();
  this.effects = () => {
    if (this.deflection.escaped(Root)) {
      flag.$set(true);
    }
  };

  $instruct(\`x\`);
}
`),
      ).not.toThrow();
    });

    it("allows deflection.escaped() naming a child the node entered", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  this.catchDeflection = () => {
    return this.deflection.escaped(Child);
  };

  $enter(Child);

  function Child() {
    $instruct(\`x\`);
  }
}
`),
      ).not.toThrow();
    });

    it("validates catchDeflection bodies, rejecting unknown observeOrAsk targets", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  this.catchDeflection = () => {
    $observeOrAsk(missing);
    return true;
  };
}
`),
      ).toThrow(/UNKNOWN_CELL/);
    });

    it("still catches its own instruction deflection and rewalks itself", () => {
      const document = parse(`
"arc";

function Main() {
  let caught = Bool();

  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };

  if (caught == true) {
    $instruct(\`caught\`);  } else {
    $instructLoop(\`intro\`, {
      deflectWhen: \`\${user} wants to switch topics\`,
      resolveWhen: \`\${self} finished intro\`,
    });
  }
}
`);
      const runtime = new Runtime()
        .add("self-instruction-catch-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("self-instruction-catch-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const handback = progressBrief(runtime, brief, { move: "proceed" });
      const deflect = handback.judgments.find(
        (item) =>
          renderSemanticTextForTest(item.question) ===
          "user wants to switch topics",
      );
      expect(deflect).toBeDefined();

      const caught = progressBrief(runtime, handback, {
        move: "proceed",
        judgments: { [deflect!.id]: true },
      });

      expect(rootTraversal(caught).state).toBeUndefined();
      expect(rootTraversal(caught).cells.caught).toBe(true);
      expect(caught.instructions.map((item) => item.text)).toEqual(["caught"]);
    });

    it("matches the immediate child rather than the nested deflection origin", () => {
      const document = parse(`
"arc";

function Main() {
  let caught = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Branch)) {
      caught.$set(true);
      return true;
    }
    return false;
  };

  if (caught != true) {
    $enter(Branch);
  }

  function Branch() {
    $enter(Leaf);

    function Leaf() {
      let topic = Enum(["unknown", "product"]);
      topic.observing = \`what topic does \${user} want\`;
      $observeOrAsk(topic);
    }
  }
}
`);
      const runtime = new Runtime()
        .add("nested-deflection-from-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("nested-deflection-from-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const caught = progressTerminal(runtime, brief, { move: "deflect" });

      expect(rootTraversal(caught).cells.caught).toBe(true);
      expect(rootTraversal(caught).state).toBe("covered");
      expect(
        ownedChild(rootTraversal(caught), "Main.Branch")?.finalizing,
      ).toBeUndefined();
      expect(
        ownedChild(
          ownedChild(rootTraversal(caught), "Main.Branch")!,
          "Main.Branch.Leaf",
        )?.state,
      ).toBe("deflected");
    });

    it("returns false for escaped(Self) on the node's own frontier deflection", () => {
      const document = parse(`
"arc";

function Main() {
  let caughtSelf = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Main)) {
      caughtSelf.$set(true);
      return true;
    }
    return false;
  };

  $instructLoop(\`intro\`, {
    deflectWhen: \`\${user} wants to leave\`,
    resolveWhen: \`\${self} finished intro\`,
  });
}
`);
      const runtime = new Runtime().add("self-isfrom-arc", document).init();
      const seeded = runtime.newTraversal(arc("self-isfrom-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const after = progressBrief(runtime, brief, { move: "deflect" });

      // Main entered nothing, so escaped(Main) is false: the hook does not
      // catch (caughtSelf stays unset).
      expect(rootTraversal(after).cells.caughtSelf).toBeUndefined();
    });

    it("matches escaped(Child) against a newcopy(Child) entry", () => {
      const document = parse(`
"arc";

function Main() {
  let caught = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Child)) {
      caught.$set(true);
      return true;
    }
    return false;
  };

  if (caught != true) {
    $enter(newcopy(Child));
  }

  function Child() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what topic does \${user} want\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("newcopy-isfrom-arc", document).init();
      const seeded = runtime.newTraversal(arc("newcopy-isfrom-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const caught = progressTerminal(runtime, brief, { move: "deflect" });

      // The anonymous copy resolves back to the canonical Child the author named,
      // so escaped(Child) matches and Main catches.
      expect(rootTraversal(caught).cells.caught).toBe(true);
      expect(rootTraversal(caught).state).toBe("covered");
    });

    it("runs effects and bubbles when catchDeflection returns false", () => {
      const document = parse(`
"arc";
import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply(\`parent effect\`);
  };

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;

    this.catchDeflection = () => {
      return false;
    };

    this.effects = () => {
      Memoir.facts.$apply(\`child effect\`);
    };

    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime()
        .add("catch-false-effects-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("catch-false-effects-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const childEffects = progressBrief(runtime, brief, { move: "deflect" });

      // The child's deflection effect is reported first; only then does the
      // deflection bubble into the parent's own effects.
      expect(
        childEffects.hostEffects.map((effect) => effect.arguments[0]),
      ).toEqual(["child effect"]);
      expect(
        ownedChild(rootTraversal(childEffects), "Main.Intro"),
      ).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "effects" },
      });

      const parentEffects = progressBrief(runtime, childEffects, {
        move: "proceed",
        hostEffects: appliedHostEffects(childEffects),
      });

      expect(
        parentEffects.hostEffects.map((effect) => effect.arguments[0]),
      ).toEqual(["parent effect"]);
      expect(rootTraversal(parentEffects)).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "effects" },
      });

      const deflected = progressTerminal(runtime, parentEffects, {
        move: "proceed",
        hostEffects: appliedHostEffects(parentEffects),
      });

      expect("hostEffects" in deflected).toBe(false);
      expect(rootTraversal(deflected).state).toBe("deflected");
    });

    it("resumes a blocking catchDeflection before deciding whether to catch", () => {
      const document = parse(`
"arc";

function Main() {
  let wantsPricing = Bool({
    observing: \`does \${user} want pricing\`,
  });

  this.catchDeflection = () => {
    $observe(wantsPricing);
    if (wantsPricing == true) {
      return true;
    }
    return false;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
  }

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    $observeOrAsk(topic);
  }

  function Pricing() {
    $instruct(\`pricing\`);  }
}
`);
      const runtime = new Runtime().add("blocking-catch-arc", document).init();
      const seeded = runtime.newTraversal(arc("blocking-catch-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const catching = progressBrief(runtime, brief, { move: "deflect" });

      expect(catching.active).toEqual(node("blocking-catch-arc", "Main"));
      expect(catching.observations).toHaveLength(1);
      expect(catching.observations[0]).toMatchObject({
        cell: "wantsPricing",
        mode: "observe",
      });
      expect(rootTraversal(catching)).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "catch" },
      });

      const routed = progressBrief(runtime, catching, {
        move: "proceed",
        observations: {
          [catching.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });

      expect(rootTraversal(routed).state).toBeUndefined();
      expect(routed.active).toEqual(node("blocking-catch-arc", "Main.Pricing"));
    });

    it("resumes a catchDeflection blocked on $observeOrAsk() before judging and routing", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let route = Enum(["unknown", "pricing"], {
    observing: \`is \${user} asking about pricing, or about something else\`,
  });
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    $observeOrAsk(route);
    if (route == "pricing" && judge(\`\${user} still wants pricing\`)) {
      wantsPricing.$set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
  }

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    $observeOrAsk(topic);
  }

  function Pricing() {
    $instruct(\`pricing\`);  }
}
`),
        "Main",
      );
      const runtime = new Runtime()
        .add("observe-or-ask-catch-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-or-ask-catch-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const catching = progressBrief(runtime, brief, { move: "deflect" });

      expect(catching.active).toEqual(node("observe-or-ask-catch-arc", "Main"));
      expect(catching.observations).toHaveLength(1);
      expect(catching.observations[0]).toMatchObject({
        cell: "route",
        mode: "observeOrAsk",
      });
      expect(rootTraversal(catching)).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "catch" },
      });

      const judging = progressBrief(runtime, catching, {
        move: "proceed",
        observations: {
          [catching.observations[0]!.id]: {
            status: "resolved",
            value: "pricing",
          },
        },
      });

      expect(
        judging.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user still wants pricing"]);
      expect(rootTraversal(judging)).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "catch" },
      });

      const flagged = progressBrief(runtime, judging, {
        move: "proceed",
        judgments: { [judging.judgments[0]!.id]: true },
      });

      // The catch's `$set(true)` dials the hook consultation back, releasing
      // the judge pin: the judgment re-poses before the catch resolves.
      expect(rootTraversal(flagged).cells.wantsPricing).toBe(true);
      expect(flagged.active).toEqual(node("observe-or-ask-catch-arc", "Main"));
      expect(
        flagged.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user still wants pricing"]);

      const routed = progressBrief(runtime, flagged, {
        move: "proceed",
        judgments: { [flagged.judgments[0]!.id]: true },
      });

      expect(rootTraversal(routed).state).toBeUndefined();
      expect(rootTraversal(routed).cells.wantsPricing).toBe(true);
      expect(routed.active).toEqual(
        node("observe-or-ask-catch-arc", "Main.Pricing"),
      );
      expect(routed.instructions.map((item) => item.text)).toEqual(["pricing"]);
    });

    it("deflects after a catchDeflection observeOrAsk resolves and judges false", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let route = Enum(["unknown", "pricing"], {
    observing: \`is \${user} asking about pricing, or about something else\`,
  });

  this.catchDeflection = () => {
    $observeOrAsk(route);
    if (route == "pricing" && judge(\`\${user} still wants pricing\`)) {
      return true;
    }
    return false;
  };

  this.effects = () => {
    Memoir.facts.$apply(\`root deflected\`);
  };

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime()
        .add("observe-or-ask-catch-false-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-or-ask-catch-false-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const catching = progressBrief(runtime, brief, { move: "deflect" });

      expect(catching.active).toEqual(
        node("observe-or-ask-catch-false-arc", "Main"),
      );
      expect(catching.observations).toHaveLength(1);
      expect(catching.observations[0]).toMatchObject({
        cell: "route",
        mode: "observeOrAsk",
      });

      const judging = progressBrief(runtime, catching, {
        move: "proceed",
        observations: {
          [catching.observations[0]!.id]: {
            status: "resolved",
            value: "pricing",
          },
        },
      });

      expect(
        judging.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user still wants pricing"]);

      const emitted = progressBrief(runtime, judging, {
        move: "proceed",
        judgments: { [judging.judgments[0]!.id]: false },
      });

      expect(emitted.hostEffects.map((effect) => effect.arguments[0])).toEqual([
        "root deflected",
      ]);
      expect(rootTraversal(emitted).phase).toBe("entered");

      const deflected = progressTerminal(runtime, emitted, {
        move: "proceed",
        hostEffects: appliedHostEffects(emitted),
      });

      expect("hostEffects" in deflected).toBe(false);
      expect(rootTraversal(deflected).state).toBe("deflected");
      expect(rootTraversal(deflected).phase).toBe("suspended");
    });

    it("runs effects after a blocking catchDeflection resumes false", () => {
      const document = parse(`
"arc";
import Memoir from "host:memoir";

function Main() {
  let shouldCatch = Bool({
    observing: \`does \${user} want to keep talking about this topic\`,
  });

  this.catchDeflection = () => {
    $observe(shouldCatch);
    return shouldCatch == true;
  };

  this.effects = () => {
    Memoir.facts.$apply(\`root deflected\`);
  };

  let topic = Enum(["unknown", "product"]);
  topic.observing = \`what topic does \${user} want\`;
  $observeOrAsk(topic);
}
`);
      const runtime = new Runtime()
        .add("blocking-catch-false-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("blocking-catch-false-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const catching = progressBrief(runtime, brief, { move: "deflect" });
      const deflected = progressBrief(runtime, catching, {
        move: "proceed",
        observations: {
          [catching.observations[0]!.id]: {
            status: "resolved",
            value: false,
          },
        },
      });

      expect(
        deflected.hostEffects.map((effect) => effect.arguments[0]),
      ).toEqual(["root deflected"]);
      expect(rootTraversal(deflected).phase).toBe("entered");

      const suspended = progressTerminal(runtime, deflected, {
        move: "proceed",
        hostEffects: appliedHostEffects(deflected),
      });

      expect("hostEffects" in suspended).toBe(false);
      expect(rootTraversal(suspended).state).toBe("deflected");
      expect(rootTraversal(suspended).phase).toBe("suspended");
    });
  });

  describe("hook.guard", () => {
    const GO_DIALOG: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "go ahead" }],
    };

    function guardedChildRuntime() {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $instruct(\`after child\`);
  function Child() {
    this.hostParams = { consumer: { id: "reviewer" } };
    this.guard = () => {
      if (!/go/.test(Dialog.lastUserMessage)) {
        return State.SKIPPED;
      }
    };

    $instruct(\`child work\`);  }
}
`);
      const runtime = new Runtime()
        .add("transition-entry-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("transition-entry-arc", "Main"));
      seeded.phase = "entered";
      return { runtime, seeded };
    }

    it("blocks on a semantic guard and records skipped state on the owned child traversal", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Optional);
  $instruct(\`after guard\`);
  function Optional() {
    this.guard = () => {
      if (!judge(\`\${user} wants optional content\`)) {
        return State.SKIPPED;
      }
    };
    $instruct(\`optional\`);  }
}
`);
      const runtime = new Runtime().add("guard-semantic-arc", document).init();
      const seeded = runtime.newTraversal(arc("guard-semantic-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "not now" }],
      });

      expect(brief.active).toEqual(node("guard-semantic-arc", "Main.Optional"));
      const nextBrief = progressBrief(runtime, brief, {
        move: "proceed",
        judgments: {
          [brief.judgments[0]!.id]: false,
        },
      });

      expect(ownedChild(rootTraversal(nextBrief), "Main.Optional")?.state).toBe(
        "skipped",
      );
      expect(nextBrief.instructions.map((item) => item.text)).toEqual([
        "after guard",
      ]);
    });

    it("lets a terminal child guard deflect its run for later re-entry", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Deflect);
  $instruct(\`must not run after deflection\`);

  function Deflect() {
    this.guard = () => State.DEFLECTED;
  }
}
`);
      const runtime = new Runtime().add("guard-deflect-arc", document).init();
      const seeded = runtime.newTraversal(arc("guard-deflect-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect("instructions" in brief).toBe(false);
      expect(rootTraversal(brief).state).toBe("deflected");
      expect(rootTraversal(brief).phase).toBe("suspended");
    });

    it("covers a node from its guard without running its body", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Done);
  if (Done.state == State.COVERED) {
    $instruct(\`after cover\`);
  }

  function Done() {
    this.guard = () => State.COVERED;
    $instruct(\`must not run when the guard covers\`);
  }
}
`);
      const runtime = new Runtime().add("guard-cover-arc", document).init();
      const seeded = runtime.newTraversal(arc("guard-cover-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(ownedChild(rootTraversal(brief), "Main.Done")?.state).toBe(
        "covered",
      );
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "after cover",
      ]);
    });

    it("forces a forgetful entry of a skipped canonical child and re-evaluates its guard", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  $enter(Child, {
    args: { ready },
  });
  ready.$set(true);
  $enter(forgetful(Child), {
    args: { ready },
  });
  $instruct(\`done\`);
  function Child(args = { ready: Bool() }) {
    this.guard = () => {
      if (args.ready != true) {
        return State.SKIPPED;
      }
    };

    $instruct(\`child\`);  }
}
`);
      const runtime = new Runtime()
        .add("forgetful-skipped-arc", document)
        .init();
      const traversal = runtime.newTraversal(
        arc("forgetful-skipped-arc", "Main"),
      );
      traversal.phase = "entered";

      const firstBrief = startRun(runtime, [traversal], EMPTY_DIALOG);
      const child = ownedChild(rootTraversal(firstBrief), "Main.Child");
      expect(child?.enterCount).toBe(2);
      expect(child?.state).toBeUndefined();
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "child",
      ]);

      const finalBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
        instructions: appliedInstructions(firstBrief),
      });
      expect(finalBrief.instructions.map((item) => item.text)).toEqual([
        "done",
      ]);
      expect(ownedChild(rootTraversal(finalBrief), "Main.Child")?.state).toBe(
        "covered",
      );
    });

    it("evaluates the entered node's guard against the acknowledging dialog", () => {
      const { runtime, seeded } = guardedChildRuntime();
      const transition = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(transition.transition).toBeDefined();

      // The ack dialog satisfies the guard even though the dialog that produced
      // the transition would not have.
      const work = actionProgress(
        runtime.progress(transition, { move: "proceed" }, GO_DIALOG),
      );
      expect(work.transition).toBeUndefined();
      expect(work.instructions.map((item) => item.text)).toEqual([
        "child work",
      ]);
    });

    it("skips the entered node when the acknowledging dialog fails its guard", () => {
      const { runtime, seeded } = guardedChildRuntime();
      const transition = actionProgress(runtime.start([seeded], EMPTY_DIALOG));

      // Guard skips under the (empty) ack dialog; the child's exit is the next
      // transition, and Main continues past it only after that acknowledgment.
      const exit = actionProgress(
        runtime.progress(transition, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(exit.transition?.exited).toEqual([
        node("transition-entry-arc", "Main.Child"),
      ]);
      expect(exit.transition?.position).toBe(
        node("transition-entry-arc", "Main"),
      );
      expect(exit.transition?.hostParams).toBeUndefined();

      const after = actionProgress(
        runtime.progress(exit, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(after.instructions.map((item) => item.text)).toEqual([
        "after child",
      ]);
    });
  });

  describe("hook.effects-run", () => {
    it("exposes covered as this.pendingState while covered effects remain unfinished", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let outcome = Enum(["unknown", "covered", "deflected"]);

  this.effects = () => {
    outcome.$set(this.pendingState);
    Memoir.facts.$apply(
      \`pending: \${this.pendingState}; stored: \${outcome}\`,
    );
  };
}
`);
      const runtime = new Runtime()
        .add("covered-pending-state-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("covered-pending-state-arc", "Main"),
      );
      seeded.phase = "entered";

      const effects = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(effects)).toMatchObject({
        phase: "entered",
        state: undefined,
        finalizing: { reason: "covered", phase: "effects" },
      });
      expect(
        renderSemanticTextForTest(effects.hostEffects[0]!.arguments[0]!),
      ).toBe("pending: covered; stored: covered");

      const completed = progressTerminal(runtime, effects, {
        move: "proceed",
        hostEffects: appliedHostEffects(effects),
      });

      expect(rootTraversal(completed)).toMatchObject({
        phase: "completed",
        state: "covered",
        finalizing: undefined,
      });
    });

    it("exposes deflected as this.pendingState without committing deflected state during effects", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;

  this.effects = () => {
    Memoir.facts.$apply(\`pending: \${this.pendingState}\`);
  };

  $observeOrAsk(ready);
}
`);
      const runtime = new Runtime()
        .add("deflected-pending-state-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("deflected-pending-state-arc", "Main"),
      );
      seeded.phase = "entered";
      const work = startRun(runtime, [seeded], EMPTY_DIALOG);

      const effects = progressBrief(runtime, work, { move: "deflect" });

      expect(rootTraversal(effects)).toMatchObject({
        phase: "entered",
        state: undefined,
        finalizing: {
          reason: "deflected",
          phase: "effects",
          // Own-frontier deflection entered nothing, so `from` is unset.
          deflection: {
            origin: node("deflected-pending-state-arc", "Main"),
          },
        },
      });
      const deflectedFinalizing = rootTraversal(effects).finalizing;
      expect(
        deflectedFinalizing?.reason === "deflected"
          ? deflectedFinalizing.deflection.from
          : "unreachable",
      ).toBeUndefined();
      expect(
        renderSemanticTextForTest(effects.hostEffects[0]!.arguments[0]!),
      ).toBe("pending: deflected");

      const suspended = progressTerminal(runtime, effects, {
        move: "proceed",
        hostEffects: appliedHostEffects(effects),
      });

      expect(rootTraversal(suspended)).toMatchObject({
        phase: "suspended",
        state: "deflected",
        finalizing: undefined,
      });
    });

    it("applies set() sequentially inside effects after observations resolve", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let interest = Enum(["cold", "warm"]);
  let topic = Enum(["unknown", "metal"]);
  interest.observing = \`how interested is \${user}\`;

  this.effects = () => {
    $observe(interest);
    if (interest == "warm") {
      topic.$set("metal");
    }
    if (topic == "metal") {
      Memoir.facts.$apply(\`\${user} likes metal\`);
    }
  };
}
`);

      const runtime = new Runtime().add("effects-arc", document).init();
      const seeded = runtime.newTraversal(arc("effects-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "I like metal" }],
      });

      const nextBrief = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: "warm",
          },
        },
      });

      expect(rootTraversal(nextBrief).cells.interest).toBe("warm");
      expect(rootTraversal(nextBrief).cells.topic).toBe("metal");
      expect(nextBrief.hostEffects).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
      expect(
        renderSemanticTextForTest(nextBrief.hostEffects[0]!.arguments[0]!),
      ).toBe("user likes metal");
      expect(rootTraversal(nextBrief).phase).toBe("entered");

      const completed = progressTerminal(runtime, nextBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(nextBrief),
      });

      expect("hostEffects" in completed).toBe(false);
      expect(rootTraversal(completed).phase).toBe("completed");
    });

    it("runs active child effects when the child is deflected", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.$apply(\`\${user} deflected intro\`);
    };

    $observeOrAsk(topic);
  }
}
`);

      const runtime = new Runtime().add("deflect-effects-arc", document).init();
      const seeded = runtime.newTraversal(arc("deflect-effects-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const nextBrief = progressBrief(runtime, brief, { move: "deflect" });

      expect(nextBrief.hostEffects).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
      expect(
        renderSemanticTextForTest(nextBrief.hostEffects[0]!.arguments[0]!),
      ).toBe("user deflected intro");
      expect(ownedChild(rootTraversal(nextBrief), "Main.Intro")).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "effects" },
      });
      expect(rootTraversal(nextBrief).phase).toBe("entered");

      const suspended = progressTerminal(runtime, nextBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(nextBrief),
      });

      expect("hostEffects" in suspended).toBe(false);
      expect(rootTraversal(suspended).state).toBe("deflected");
      expect(rootTraversal(suspended).phase).toBe("suspended");
    });

    it("exposes deflection.escaped() during deflected effects", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    if (
      this.pendingState == State.DEFLECTED &&
      this.deflection.escaped(Intro)
    ) {
      Memoir.facts.$apply(\`intro deflected\`);
    }
  };

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime()
        .add("effects-pending-deflection-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("effects-pending-deflection-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      const effects = progressBrief(runtime, brief, { move: "deflect" });

      expect(effects.hostEffects.map((effect) => effect.arguments[0])).toEqual([
        "intro deflected",
      ]);
      expect(rootTraversal(effects)).toMatchObject({
        state: undefined,
        finalizing: {
          reason: "deflected",
          phase: "effects",
          deflection: {
            origin: node("effects-pending-deflection-arc", "Main.Intro"),
            from: node("effects-pending-deflection-arc", "Main.Intro"),
          },
        },
      });
    });

    it("poisons deflection.escaped() during covered effects", () => {
      const document = parse(`
"arc";

function Main() {
  let matched = Bool();

  this.effects = () => {
    if (this.deflection.escaped(Child)) {
      matched.$set(true);
    }
  };

  function Child() {}
}
`);
      const runtime = new Runtime()
        .add("covered-pending-deflection-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("covered-pending-deflection-arc", "Main"),
      );
      seeded.phase = "entered";

      const poisoned = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(poisoned.issues).toHaveLength(1);
      expect(poisoned.issues[0]).toMatchObject({
        kind: "poisoned-traversal",
        reason:
          "this.deflection.escaped(...) is only available while a deflection is pending",
      });
    });

    it("does not run effects on an ancestor that catches child deflection", () => {
      const document = parse(`
"arc";
import Memoir from "host:memoir";

function Main() {
  let caught = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Intro)) {
      caught.$set(true);
      return true;
    }
    return false;
  };

  this.effects = () => {
    Memoir.facts.$apply(\`parent effect\`);
  };

  if (caught == true) {
    $instruct(\`after catch\`);  }

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.$apply(\`child effect\`);
    };

    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime()
        .add("catch-suppresses-effects-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("catch-suppresses-effects-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const childEffects = progressBrief(runtime, brief, { move: "deflect" });

      expect(
        childEffects.hostEffects.map((effect) => effect.arguments[0]),
      ).toEqual(["child effect"]);

      const caught = progressBrief(runtime, childEffects, {
        move: "proceed",
        hostEffects: appliedHostEffects(childEffects),
      });

      expect(caught.hostEffects).toEqual([]);
      expect(rootTraversal(caught).state).toBeUndefined();
      expect(caught.instructions.map((item) => item.text)).toEqual([
        "after catch",
      ]);
    });

    it("finishes deflection after effect observations resolve", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    let interest = Enum(["unknown", "warm"]);
    topic.observing = \`what topic does \${user} want\`;
    interest.observing = \`how interested is \${user}\`;

    this.effects = () => {
      $observe(interest);
      if (interest == "warm") {
        Memoir.facts.$apply(\`\${user} left with warm interest\`);
      }
    };

    $observeOrAsk(topic);
  }
}
`);

      const runtime = new Runtime()
        .add("deflect-observe-effects-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("deflect-observe-effects-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const afterDeflect = progressBrief(runtime, brief, { move: "deflect" });

      expect(afterDeflect.canProgress).toBe(true);
      expect(afterDeflect.observations).toHaveLength(1);
      expect(afterDeflect.observations[0]).toMatchObject({
        cell: "interest",
        mode: "observe",
      });
      expect(rootTraversal(afterDeflect).phase).toBe("entered");
      expect(
        ownedChild(rootTraversal(afterDeflect), "Main.Intro"),
      ).toMatchObject({
        state: undefined,
        finalizing: { reason: "deflected", phase: "effects" },
      });

      const nextBrief = progressBrief(runtime, afterDeflect, {
        move: "proceed",
        observations: {
          [afterDeflect.observations[0]!.id]: {
            status: "resolved",
            value: "warm",
          },
        },
      });

      expect(nextBrief.hostEffects).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
      expect(
        renderSemanticTextForTest(nextBrief.hostEffects[0]!.arguments[0]!),
      ).toBe("user left with warm interest");
      expect(nextBrief.canProgress).toBe(true);
      expect(rootTraversal(nextBrief).phase).toBe("entered");

      const suspended = progressTerminal(runtime, nextBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(nextBrief),
      });

      expect("hostEffects" in suspended).toBe(false);
      expect(suspended.canProgress).toBe(false);
      expect(rootTraversal(suspended).phase).toBe("suspended");
    });

    it("rejects observeOrAsk inside effects", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool();
  this.effects = () => {
    $observeOrAsk(ready);
  };
}
`),
      ).toThrow(/observeOrAsk\(\) is forbidden inside this\.effects/);
    });
  });

  describe("hook.effects-host", () => {
    it("re-surfaces an unreported host effect under one id until it is reported", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;

  this.effects = () => {
    Memoir.facts.$apply(\`idempotent effect\`);
    $observe(ready);
  };
}
`);
      const runtime = new Runtime()
        .add("idempotent-effects-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("idempotent-effects-arc", "Main"),
      );
      seeded.phase = "entered";
      const firstBrief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(firstBrief.hostEffects).toEqual([
        {
          id: expect.any(String),
          sourceRef: node("idempotent-effects-arc", "Main"),
          module: "memoir",
          target: ["facts"],
          operation: "apply",
          arguments: ["idempotent effect"],
        },
      ]);
      expect(firstBrief.observations).toHaveLength(1);

      // A progress that carries no effect feedback re-briefs the effect under
      // the same id instead of dropping or re-emitting it.
      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
        observations: {
          [firstBrief.observations[0]!.id]: { status: "needs-user" },
        },
      });

      expect(secondBrief.hostEffects).toEqual(firstBrief.hostEffects);
      expect(secondBrief.observations).toHaveLength(1);

      const thirdBrief = progressBrief(runtime, secondBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(secondBrief),
      });

      expect(thirdBrief.hostEffects).toEqual([]);
      expect(thirdBrief.observations).toHaveLength(1);
    });

    it("a reported effects host-call advances", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply(\`a note\`);
  };
}
`);
      const runtime = new Runtime().add("n8-arc", document).init();
      const seeded = runtime.newTraversal(arc("n8-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.hostEffects).toHaveLength(1);
      expect(brief.hostEffects[0]!.operation).toBe("apply");
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);
      expect(rootTraversal(brief).phase).toBe("entered");

      // A bare proceed leaves the unreported effect on the frontier.
      const unreported = progressBrief(runtime, brief, { move: "proceed" });

      expect(unreported.hostEffects).toEqual(brief.hostEffects);
      expect(rootTraversal(unreported).phase).toBe("entered");

      const confirmed = progressTerminal(runtime, unreported, {
        move: "proceed",
        hostEffects: appliedHostEffects(unreported),
      });

      expect("hostEffects" in confirmed).toBe(false);
      expect(rootTraversal(confirmed).phase).toBe("completed");
    });

    it("accepts poison move for an unconfirmed host-effect frontier", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply(\`a note\`);
  };
}
`);
      const runtime = new Runtime().add("n8b-arc", document).init();
      const seeded = runtime.newTraversal(arc("n8b-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.hostEffects).toHaveLength(1);
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);
      expect(rootTraversal(brief).phase).toBe("entered");

      const poisoned = progressTerminal(runtime, brief, {
        move: "poison",
        poisonReason: {
          reasonCode: "unsupported-host-effect",
          reason: "Unsupported host module memoir.facts.apply.",
        },
      });

      expect(rootTraversal(poisoned).phase).toBe("poisoned");
      expect("hostEffects" in poisoned).toBe(false);
      expect("allowedMoves" in poisoned).toBe(false);
      expect(poisoned.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unsupported-host-effect",
          reason: "Unsupported host module memoir.facts.apply.",
        }),
      ]);
    });

    it("waits for host-effect confirmation before entering the next node", () => {
      const document = parse(`
"arc";

import Mod from "host:mod";

function Main() {
  $enter(NonTail);
  $enter(Tail);

  function NonTail() {
    this.effects = () => {
      Mod.$doSomething();
    };
  }

  function Tail() {
    $instruct(\`tail\`);
  }
}
`);
      const runtime = new Runtime().add("n8c-arc", document).init();
      const seeded = runtime.newTraversal(arc("n8c-arc", "Main"));
      seeded.phase = "entered";
      const effectBrief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(effectBrief.hostEffects).toEqual([
        {
          id: expect.any(String),
          sourceRef: node("n8c-arc", "Main.NonTail"),
          module: "mod",
          target: [],
          operation: "doSomething",
          arguments: [],
        },
      ]);
      expect(effectBrief.instructions).toEqual([]);
      expect(effectBrief.allowedMoves).toEqual(["poison", "proceed"]);
      expect(
        ownedChild(rootTraversal(effectBrief), "Main.NonTail")?.state,
      ).toBe(undefined);
      expect(
        ownedChild(rootTraversal(effectBrief), "Main.Tail"),
      ).toBeUndefined();

      const tailBrief = progressBrief(runtime, effectBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(effectBrief),
      });

      expect(tailBrief.hostEffects).toEqual([]);
      expect(tailBrief.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(ownedChild(rootTraversal(tailBrief), "Main.NonTail")?.state).toBe(
        "covered",
      );
      expect(ownedChild(rootTraversal(tailBrief), "Main.Tail")?.state).toBe(
        undefined,
      );
    });

    it("parses static bracket host effect targets", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir["facts"].audit["$apply"](\`effect\`);
  };
}
`);

      expect(document.roots[0]?.effects?.[0]).toMatchObject({
        kind: "host-call",
        module: "memoir",
        target: ["facts", "audit"],
        operation: "apply",
      });
    });

    it("treats host effect string literals as semantic arguments", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply("effect");
  };
}
`);

      expect(document.roots[0]?.effects?.[0]).toMatchObject({
        kind: "host-call",
        arguments: [
          {
            kind: "semantic",
            value: { kind: "literal", value: "effect" },
          },
        ],
      });
    });
  });
});
