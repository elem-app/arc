import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import {
  Runtime,
  toArcRef,
  toNodeRef,
  toNodeRefParts,
} from "../src/runtime/index.js";
import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  Dialog,
  NodeRef,
  NodeTraversal,
} from "../src/types.js";

function arc(source: string, id: string): ArcRef {
  return toArcRef(source, id);
}

function node(source: string, identifier: string): NodeRef {
  return toNodeRef(source, identifier.split("."));
}

function nodeIdentifier(ref: NodeRef): string {
  return toNodeRefParts(ref).path.join(".");
}

function ownedChild(
  traversal: ArcTraversal | NodeTraversal,
  identifier: string,
): NodeTraversal | undefined {
  return traversal.ownedChildren.find(
    (child) => nodeIdentifier(child.ref) === identifier,
  );
}

function rootTraversal(brief: ActionBrief): ArcTraversal {
  const root = brief.traversals.find(
    (traversal) => traversal.returnTo === null,
  );
  if (!root) throw new Error("Missing root traversal");
  return root;
}

const EMPTY_DIALOG: Dialog = { lastTurns: [] };

function progressBrief(
  runtime: Runtime,
  brief: ReturnType<Runtime["start"]>,
  report: ActionReport,
  dialog: Dialog = EMPTY_DIALOG,
): ActionBrief {
  return runtime.progress(brief, report, dialog);
}

const SOURCE = `
"use arc v2";

function Metal() {
  this.displayName = "Metal";

  this.trigger = () => {
    if (judge(\`\${user} asks about music\`)) {
      return true;
    }
    return false;
  };

  enter(Surface);

  function Surface() {
    const subgenre = new Enum(["unknown", "thrash", "doom"]);
    subgenre.observing = \`what subgenre does \${user} like\`;
    observeOrAsk(subgenre);
    \`Talk about \${subgenre}.\`;
  }
}
`;

describe("runtime", () => {
  it("registers multiple roots from one document by declaration identifier", () => {
    const document = parse(`
"use arc v2";

function First() {
  \`one\`;
}

function Second() {
  \`two\`;
}
`);
    const runtime = new Runtime().add("main-arc", document);

    expect(runtime.has(arc("main-arc", "First"))).toBe(true);
    expect(runtime.has(arc("main-arc", "Second"))).toBe(true);
  });

  it("builds a trigger brief and yields an owned child as the active traversal", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const dialog: Dialog = {
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    };
    const metalRef = arc("metal-arc", "Metal");

    const triggerBrief = runtime.startTrigger(dialog);

    expect(triggerBrief.matchableArcs).toEqual([]);
    expect(triggerBrief.judgments).toHaveLength(1);
    expect(triggerBrief.judgments[0]).toMatchObject({
      sourceRef: node("metal-arc", "Metal"),
    });

    const triggerOutcome = runtime.progressTrigger(triggerBrief, {
      match: metalRef,
      judgments: {
        [triggerBrief.judgments[0]!.id]: true,
      },
    });

    expect(triggerOutcome.matched).toEqual(metalRef);
    const matchedTraversal = triggerOutcome.traversals.find(
      (t) => t.ref === metalRef,
    );
    expect(matchedTraversal).toMatchObject({
      ref: metalRef,
      phase: "entered",
      enterCount: 1,
    });

    const brief = runtime.start(triggerOutcome.traversals, dialog);

    expect(rootTraversal(brief).ref).toEqual(metalRef);
    expect(brief.canProgress).toBe(true);
    expect(brief.active).toEqual(node("metal-arc", "Metal.Surface"));
    expect(brief.observations).toHaveLength(1);
    expect(brief.allowedMoves).toContain("proceed");

    const surface = ownedChild(rootTraversal(brief), "Metal.Surface");
    expect(surface?.ref).toEqual(node("metal-arc", "Metal.Surface"));
  });

  it("seeds traversal variables from trigger observations before entry", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const topic = new Enum(["unknown", "metal"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    observe(topic);
    if (topic === "metal") {
      return true;
    }
    return false;
  };
}
`);
    const runtime = new Runtime().add("trigger-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "let's talk about music" }],
    });

    const outcome = runtime.progressTrigger(triggerBrief, {
      observations: {
        [triggerBrief.observations[0]!.id]: {
          status: "resolved",
          value: "metal",
        },
      },
    });

    expect(outcome.matched).toEqual(arc("trigger-arc", "Main"));
    const matched = outcome.traversals.find((t) => t.ref === outcome.matched);
    expect(matched?.variables.topic).toBe("metal");
    expect(matched?.enterCount).toBe(1);
  });

  it("treats unknown trigger observations as non-blocking for observe()", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const topic = new Enum(["unknown", "metal"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    observe(topic);
    return topic === "metal";
  };
}
`);
    const runtime = new Runtime().add("trigger-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "hello there" }],
    });

    const outcome = runtime.progressTrigger(triggerBrief, {
      observations: {
        [triggerBrief.observations[0]!.id]: { status: "unknown" },
      },
    });

    expect(outcome.matched).toBeUndefined();
    expect(
      outcome.traversals.find(
        (traversal) => traversal.ref === arc("trigger-arc", "Main"),
      ),
    ).toBeUndefined();
  });

  it("evaluates this.enterCount inside trigger functions across re-entry", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.trigger = () => {
    if (
      this.enterCount === 0 &&
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
    const runtime = new Runtime().add("trigger-arc", document);

    const firstBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "music" }],
    });

    expect(firstBrief.judgments.map((item) => item.question)).toEqual([
      "user mentions music for the first time",
    ]);

    const firstOutcome = runtime.progressTrigger(firstBrief, {
      judgments: { [firstBrief.judgments[0]!.id]: true },
    });

    expect(
      firstOutcome.traversals.find((t) => t.ref === firstOutcome.matched)
        ?.enterCount,
    ).toBe(1);

    const secondBrief = runtime.startTrigger(
      {
        lastTurns: [{ role: "user", message: "music again" }],
      },
      firstOutcome.traversals,
    );

    expect(secondBrief.judgments.map((item) => item.question)).toEqual([
      "user mentions music again",
    ]);

    const secondOutcome = runtime.progressTrigger(secondBrief, {
      judgments: { [secondBrief.judgments[0]!.id]: true },
    });

    expect(
      secondOutcome.traversals.find((t) => t.ref === secondOutcome.matched)
        ?.enterCount,
    ).toBe(2);
  });

  it("does not infer a trigger match when multiple arcs are matchable", () => {
    const first = parse(`
"use arc v2";
function First() {
  this.trigger = () => {
    return true;
  };
}
`);
    const second = parse(`
"use arc v2";
function Second() {
  this.trigger = () => {
    return true;
  };
}
`);
    const runtime = new Runtime()
      .add("first-arc", first)
      .add("second-arc", second);

    const triggerBrief = runtime.startTrigger({ lastTurns: [] });
    const outcome = runtime.progressTrigger(triggerBrief, {});

    expect(triggerBrief.matchableArcs).toEqual([
      arc("first-arc", "First"),
      arc("second-arc", "Second"),
    ]);
    expect(outcome.matched).toBeUndefined();
    expect(outcome.traversals).toEqual([]);
  });

  it("auto-selects the only matchable arc when trigger report omits match", () => {
    const document = parse(`
"use arc v2";

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
    const runtime = new Runtime().add("single-match-trigger-arc", document);
    const triggerBrief = runtime.startTrigger({ lastTurns: [] });

    expect(triggerBrief.matchableArcs).toEqual([
      arc("single-match-trigger-arc", "First"),
    ]);

    const outcome = runtime.progressTrigger(triggerBrief, {});
    expect(outcome.matched).toEqual(arc("single-match-trigger-arc", "First"));
  });

  it("resolves imported arcs by source first, then root identifier", () => {
    const main = parse(`
"use arc v2";

import { AnotherArc as IntroArc } from "another-arc";

function Main() {
  enter(IntroArc);
}
`);
    const expected = parse(`
"use arc v2";

function AnotherArc() {
  \`expected\`;
}
`);
    const wrong = parse(`
"use arc v2";

function AnotherArc() {
  \`wrong\`;
}
`);

    const runtime = new Runtime()
      .add("main-arc", main)
      .add("another-arc", expected)
      .add("wrong-arc", wrong);

    const seeded = runtime.createTraversal(arc("main-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual(["expected"]);
    expect(rootTraversal(brief).refChildren).toEqual([
      arc("another-arc", "AnotherArc"),
    ]);
  });

  it("records needs-user/proceed flow against the active owned child", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const dialog: Dialog = {
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    };

    const triggerBrief = runtime.startTrigger(dialog);
    const triggerOutcome = runtime.progressTrigger(triggerBrief, {
      match: arc("metal-arc", "Metal"),
      judgments: {
        [triggerBrief.judgments[0]!.id]: true,
      },
    });

    const brief = runtime.start(triggerOutcome.traversals, dialog);
    const afterAsk = progressBrief(
      runtime,
      brief,
      {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "needs-user" },
        },
      },
      dialog,
    );

    expect(afterAsk.canProgress).toBe(true);
    expect(afterAsk.active).toEqual(node("metal-arc", "Metal.Surface"));
    expect(afterAsk.observations).toHaveLength(1);
    expect(rootTraversal(afterAsk).phase).toBe("entered");

    const resumed = runtime.start(afterAsk.traversals, {
      lastTurns: [
        { role: "user", message: "what music are you into?" },
        { role: "user", message: "I like thrash" },
      ],
    });
    const afterProceed = progressBrief(runtime, resumed, {
      move: "proceed",
      observations: {
        [resumed.observations[0]!.id]: {
          status: "resolved",
          value: "thrash",
        },
      },
    });

    expect(afterProceed.instructions.map((item) => item.text)).toEqual([
      "Talk about thrash.",
    ]);
    expect(afterProceed.canProgress).toBe(false);
    expect(rootTraversal(afterProceed).phase).toBe("completed");
    expect(
      ownedChild(rootTraversal(afterProceed), "Metal.Surface")?.variables
        .subgenre,
    ).toBe("thrash");
  });

  it("treats bare instruction literals as one-shot instructions", () => {
    const document = parse(`
"use arc v2";

function Main() {
  \`hello\`;
}
`);
    const runtime = new Runtime().add("once-arc", document);
    const seeded = runtime.createTraversal(arc("once-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions).toMatchObject([
      {
        mode: "once",
        phase: "apply",
        text: "hello",
        postcheck: undefined,
      },
    ]);
    expect(brief.allowedMoves).toEqual(["proceed", "defer"]);

    const afterProceed = progressBrief(runtime, brief, { move: "proceed" });
    expect(afterProceed.instructions).toEqual([]);
    expect(afterProceed.canProgress).toBe(false);
    expect(rootTraversal(afterProceed).phase).toBe("completed");
  });

  it("rejects deflect move while an instruction brief is pending", () => {
    const document = parse(`
"use arc v2";

function Main() {
  \`hello\`;
}
`);
    const runtime = new Runtime().add("instruction-move-arc", document);
    const seeded = runtime.createTraversal(arc("instruction-move-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.allowedMoves).toEqual(["proceed", "defer"]);
    expect(() => progressBrief(runtime, brief, { move: "deflect" })).toThrow(
      /Illegal turn move: deflect/,
    );
  });

  it("prefers deflectWhen over resolveWhen when both evaluate true", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`);
    const runtime = new Runtime().add("instruction-precedence-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruction-precedence-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    const deflect = brief.judgments.find(
      (item) => item.question === "user wants to leave this topic",
    );
    const resolve = brief.judgments.find(
      (item) => item.question === "self covered the topic enough",
    );
    expect(deflect).toBeDefined();
    expect(resolve).toBeDefined();

    const nextBrief = progressBrief(runtime, brief, {
      move: "proceed",
      judgments: {
        [deflect!.id]: true,
        [resolve!.id]: true,
      },
    });

    expect(nextBrief.canProgress).toBe(false);
    expect(rootTraversal(nextBrief).state).toBe("deflected");
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("captures only currently reachable postchecks and defers deeper checks", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.observing = \`is \${self} ready\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      observe(ready);
      if (ready === true) {
        return judge(\`\${self} covered the topic enough\`);
      }
      return false;
    },
  });
}
`);
    const runtime = new Runtime().add("instruction-postcheck-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruction-postcheck-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.observations).toHaveLength(1);
    expect(brief.judgments).toEqual([]);
    expect(brief.instructions[0]).toMatchObject({
      phase: "apply",
      postcheck: {
        judgmentIds: [],
        observationIds: [brief.observations[0]!.id],
        hostCallIds: [],
      },
    });

    const afterReady = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });
    expect(afterReady.instructions[0]).toMatchObject({
      phase: "postcheck",
      postcheck: {
        judgmentIds: [afterReady.judgments[0]!.id],
        observationIds: [],
        hostCallIds: [],
      },
    });
    expect(afterReady.observations).toEqual([]);
    expect(afterReady.judgments.map((item) => item.question)).toEqual([
      "self covered the topic enough",
    ]);
  });

  it("re-emits resolution observe after terminal false clears function frame", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.observing = \`is \${self} ready\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      observe(ready);
      return ready === true;
    },
  });
}
`);
    const runtime = new Runtime().add(
      "instruction-observe-unknown-arc",
      document,
    );
    const seeded = runtime.createTraversal(
      arc("instruction-observe-unknown-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.observations).toHaveLength(1);

    const afterUnknown = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: { status: "unknown" },
      },
    });
    expect(afterUnknown.observations).toHaveLength(1);
    expect(afterUnknown.observations[0]?.question).toEqual("is self ready");
    expect(afterUnknown.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "apply",
      },
    ]);

    const nextBrief = progressBrief(runtime, afterUnknown, {
      move: "proceed",
    });
    expect(nextBrief.observations).toHaveLength(1);
    expect(nextBrief.observations[0]?.question).toEqual("is self ready");
    expect(nextBrief.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "postcheck",
      },
    ]);
  });

  it("re-emits trigger observe after terminal false clears trigger function frame", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.observing = \`is \${user} ready\`;
  this.trigger = () => {
    observe(ready);
    return ready === true;
  };
}
`);
    const runtime = new Runtime().add("trigger-frame-reset-arc", document);
    const seeded = runtime.createTraversal(
      arc("trigger-frame-reset-arc", "Main"),
    );

    const firstBrief = runtime.startTrigger({ lastTurns: [] }, [seeded]);
    expect(firstBrief.observations).toHaveLength(1);

    const firstOutcome = runtime.progressTrigger(firstBrief, {
      observations: {
        [firstBrief.observations[0]!.id]: { status: "unknown" },
      },
    });
    expect(firstOutcome.matched).toBeUndefined();

    const secondBrief = runtime.startTrigger(
      { lastTurns: [{ role: "user", message: "still not sure" }] },
      firstOutcome.traversals,
    );
    expect(secondBrief.observations).toHaveLength(1);
    expect(secondBrief.observations[0]?.question).toEqual("is user ready");
  });

  it("resolves instruct implicitly after handback", () => {
    const document = parse(`
"use arc v2";

function Main() {
  instruct(\`Mention this once.\`);
  \`after\`;
}
`);
    const runtime = new Runtime().add("instruct-implicit-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruct-implicit-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.instructions.map((item) => item.text)).toEqual([
      "Mention this once.",
      "after",
    ]);
    expect(brief.judgments).toEqual([]);

    const resolved = progressBrief(runtime, brief, { move: "proceed" });
    expect(resolved.instructions).toEqual([]);
    expect(resolved.canProgress).toBe(false);
  });

  it("includes host-call resolution probes in instruction postcheck ids", () => {
    const document = parse(`
"use arc v2";

import Dice from "host:rng";

function Main() {
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      return Dice.roll(20) > 10;
    },
  });
}
`);
    const runtime = new Runtime().add(
      "instruction-hostcall-postcheck-arc",
      document,
    );
    const seeded = runtime.createTraversal(
      arc("instruction-hostcall-postcheck-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.hostCalls).toHaveLength(1);
    expect(brief.judgments).toEqual([]);
    expect(brief.observations).toEqual([]);
    expect(brief.instructions[0]).toMatchObject({
      phase: "apply",
      postcheck: {
        judgmentIds: [],
        observationIds: [],
        hostCallIds: [brief.hostCalls[0]!.id],
      },
    });
  });

  it("asks authored resolution questions for persistent instructions after handback", () => {
    const document = parse(`
"use arc v2";

function Main() {
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
  \`after\`;
}
`);
    const runtime = new Runtime().add("persistent-arc", document);
    const seeded = runtime.createTraversal(arc("persistent-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.instructions.map((item) => item.text)).toEqual([
      "Carry the topic.",
    ]);
    expect(brief.instructions[0]?.phase).toBe("apply");
    expect(brief.judgments.map((item) => item.question)).toEqual([
      "self covered the topic enough",
    ]);
    expect(brief.instructions[0]?.postcheck).toEqual({
      judgmentIds: [brief.judgments[0]!.id],
      observationIds: [],
      hostCallIds: [],
    });
    expect(brief.allowedMoves).toEqual(["proceed", "defer"]);

    const afterHandback = progressBrief(runtime, brief, { move: "proceed" });
    expect(afterHandback.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "postcheck",
      },
    ]);
    expect(afterHandback.judgments.map((item) => item.question)).toEqual([
      "self covered the topic enough",
    ]);

    const afterFalse = progressBrief(runtime, afterHandback, {
      move: "proceed",
      judgments: { [afterHandback.judgments[0]!.id]: false },
    });
    expect(afterFalse.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "apply",
      },
    ]);

    const resolutionBrief = progressBrief(runtime, afterFalse, {
      move: "proceed",
    });
    expect(resolutionBrief.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "postcheck",
      },
    ]);
    const afterTrue = progressBrief(runtime, resolutionBrief, {
      move: "proceed",
      judgments: { [resolutionBrief.judgments[0]!.id]: true },
    });
    expect(afterTrue.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("does not consume instruction postcheck answers on defer", () => {
    const document = parse(`
"use arc v2";

function Main() {
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
  \`after\`;
}
`);
    const runtime = new Runtime().add("instruction-defer-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruction-defer-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.instructions.map((item) => item.text)).toEqual([
      "Carry the topic.",
    ]);
    expect(brief.judgments.map((item) => item.question)).toEqual([
      "self covered the topic enough",
    ]);

    const deferred = progressBrief(runtime, brief, {
      move: "defer",
      judgments: { [brief.judgments[0]!.id]: true },
    });
    expect(deferred.instructions).toMatchObject([
      {
        text: "Carry the topic.",
        phase: "postcheck",
      },
    ]);
    expect(deferred.judgments.map((item) => item.question)).toEqual([
      "self covered the topic enough",
    ]);

    const resumed = progressBrief(runtime, deferred, {
      move: "proceed",
      judgments: { [deferred.judgments[0]!.id]: true },
    });
    expect(resumed.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("accepts batched instruction deflect/resolve semantics in one report", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.observing = \`is \${self} ready\`;
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      observe(ready);
      return ready === true;
    },
  });
  \`after\`;
}
`);
    const runtime = new Runtime().add("instruction-batched-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruction-batched-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    const handback = progressBrief(runtime, brief, { move: "proceed" });

    const deflectCheck = handback.judgments.find(
      (item) => item.question === "user wants to leave this topic",
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

  it("derives instruction deflection from authored deflectWhen", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`);
    const runtime = new Runtime().add("instruction-deflect-arc", document);
    const seeded = runtime.createTraversal(
      arc("instruction-deflect-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    const resolutionBrief = progressBrief(runtime, brief, { move: "proceed" });

    expect(resolutionBrief.judgments.map((item) => item.question)).toEqual([
      "user wants to leave this topic",
      "self covered the topic enough",
    ]);

    const deflected = progressBrief(runtime, resolutionBrief, {
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

  it("blocks on a semantic guard and records skipped state on the owned child traversal", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Optional);
  \`after guard\`;

  function Optional() {
    this.guard = () => {
      if (!judge(\`\${user} wants optional content\`)) {
        return State.SKIPPED;
      }
    };
    \`optional\`;
  }
}
`);
    const runtime = new Runtime().add("guard-semantic-arc", document);
    const seeded = runtime.createTraversal(arc("guard-semantic-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], {
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

  it("yields host call briefs for expression host calls and resumes on report", () => {
    const document = parse(`
"use arc v2";

import Dice from "host:rng";

function Main() {
  const lucky = new Boolean();
  lucky.set(Dice.roll(20));

  if (lucky === true) {
    \`critical hit\`;
  }
}
`);

    const runtime = new Runtime().add("host-call-arc", document);
    const seeded = runtime.createTraversal(arc("host-call-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.hostCalls).toHaveLength(1);
    expect(brief.hostCalls[0]).toMatchObject({
      sourceRef: node("host-call-arc", "Main"),
      module: "rng",
      operation: "roll",
      arguments: [20],
    });
    const resumed = progressBrief(runtime, brief, {
      move: "proceed",
      hostCalls: {
        [brief.hostCalls[0]!.id]: true,
      },
    });

    expect(rootTraversal(resumed).variables.lucky).toBe(true);
    expect(resumed.hostCalls).toEqual([]);
    expect(resumed.instructions.map((item) => item.text)).toEqual([
      "critical hit",
    ]);
  });

  it("applies set() sequentially inside effects after observations resolve", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  const interest = new Enum(["cold", "warm"]);
  const topic = new Enum(["unknown", "metal"]);
  interest.observing = \`how interested is \${user}\`;

  this.effects = () => {
    observe(interest);
    if (interest === "warm") {
      topic.set("metal");
    }
    if (topic === "metal") {
      Memoir.facts.apply(\`\${user} likes metal\`);
    }
  };
}
`);

    const runtime = new Runtime().add("effects-arc", document);
    const seeded = runtime.createTraversal(arc("effects-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], {
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

    expect(rootTraversal(nextBrief).variables.interest).toBe("warm");
    expect(rootTraversal(nextBrief).variables.topic).toBe("metal");
    expect(nextBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["user likes metal"],
      },
    ]);
    expect(rootTraversal(nextBrief).phase).toBe("completed");
  });

  it("continues past observe() when the host reports unknown", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  const interest = new Enum(["cold", "warm"]);
  const topic = new Enum(["unknown", "metal"]);
  interest.observing = \`how interested is \${user}\`;

  this.effects = () => {
    observe(interest);
    if (interest === "warm") {
      topic.set("metal");
    }
    if (topic === "metal") {
      Memoir.facts.apply(\`\${user} likes metal\`);
    }
  };
}
`);

    const runtime = new Runtime().add("effects-arc", document);
    const seeded = runtime.createTraversal(arc("effects-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], {
      lastTurns: [{ role: "user", message: "I like metal" }],
    });

    const nextBrief = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: { status: "unknown" },
      },
    });

    expect(rootTraversal(nextBrief).variables.interest).toBeUndefined();
    expect(rootTraversal(nextBrief).variables.topic).toBeUndefined();
    expect(nextBrief.hostEffects).toEqual([]);
    expect(rootTraversal(nextBrief).phase).toBe("completed");
  });

  it("preserves an existing value when observe() reports unknown", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const interest = new Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;
  interest.set("warm");
  observe(interest);
}
`);

    const runtime = new Runtime().add("observe-arc", document);
    const seeded = runtime.createTraversal(arc("observe-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    const nextBrief = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: { status: "unknown" },
      },
    });

    expect(rootTraversal(nextBrief).variables.interest).toBe("warm");
    expect(rootTraversal(nextBrief).phase).toBe("completed");
  });

  it("suppresses duplicate host effects across repeated briefs for one traversal", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  const ready = new Boolean();
  ready.observing = \`is \${user} ready\`;

  this.effects = () => {
    Memoir.facts.apply(\`idempotent effect\`);
    observe(ready);
  };
}
`);
    const runtime = new Runtime().add("idempotent-effects-arc", document);
    const seeded = runtime.createTraversal(
      arc("idempotent-effects-arc", "Main"),
    );
    seeded.phase = "entered";
    const firstBrief = runtime.start([seeded], { lastTurns: [] });

    expect(firstBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["idempotent effect"],
      },
    ]);
    expect(firstBrief.observations).toHaveLength(1);

    const secondBrief = progressBrief(runtime, firstBrief, {
      move: "proceed",
      observations: {
        [firstBrief.observations[0]!.id]: { status: "needs-user" },
      },
    });

    expect(secondBrief.hostEffects).toEqual([]);
    expect(secondBrief.observations).toHaveLength(1);
  });

  it("runs active child effects when the child is deflected", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.apply(\`\${user} deflected intro\`);
    };

    observeOrAsk(topic);
  }
}
`);

    const runtime = new Runtime().add("deflect-effects-arc", document);
    const seeded = runtime.createTraversal(arc("deflect-effects-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });
    const nextBrief = progressBrief(runtime, brief, { move: "deflect" });

    expect(nextBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["user deflected intro"],
      },
    ]);
    expect(ownedChild(rootTraversal(nextBrief), "Main.Intro")?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("runs child deflection effects before blocked ancestor effects", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.apply(\`parent effect\`);
  };

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.apply(\`child effect\`);
    };

    observeOrAsk(topic);
  }
}
`);

    const runtime = new Runtime().add("deflect-parent-effects-arc", document);
    const seeded = runtime.createTraversal(
      arc("deflect-parent-effects-arc", "Main"),
    );
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });
    const nextBrief = progressBrief(runtime, brief, { move: "deflect" });

    expect(nextBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["child effect"],
      },
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["parent effect"],
      },
    ]);
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("finishes deflection after effect observations resolve", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "metal"]);
    const interest = new Enum(["unknown", "warm"]);
    topic.observing = \`what topic does \${user} want\`;
    interest.observing = \`how interested is \${user}\`;

    this.effects = () => {
      observe(interest);
      if (interest === "warm") {
        Memoir.facts.apply(\`\${user} left with warm interest\`);
      }
    };

    observeOrAsk(topic);
  }
}
`);

    const runtime = new Runtime().add("deflect-observe-effects-arc", document);
    const seeded = runtime.createTraversal(
      arc("deflect-observe-effects-arc", "Main"),
    );
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });
    const afterDeflect = progressBrief(runtime, brief, { move: "deflect" });

    expect(afterDeflect.canProgress).toBe(true);
    expect(afterDeflect.observations).toHaveLength(1);
    expect(afterDeflect.observations[0]).toMatchObject({
      variable: "interest",
      mode: "observe",
    });
    expect(rootTraversal(afterDeflect).phase).toBe("entered");
    expect(ownedChild(rootTraversal(afterDeflect), "Main.Intro")?.state).toBe(
      "deflected",
    );

    const nextBrief = progressBrief(runtime, afterDeflect, {
      move: "proceed",
      observations: {
        [afterDeflect.observations[0]!.id]: {
          status: "resolved",
          value: "warm",
        },
      },
    });

    expect(nextBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["user left with warm interest"],
      },
    ]);
    expect(nextBrief.canProgress).toBe(false);
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("supports defer without mutating the yielded traversal", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    });
    const triggerOutcome = runtime.progressTrigger(triggerBrief, {
      match: arc("metal-arc", "Metal"),
      judgments: {
        [triggerBrief.judgments[0]!.id]: true,
      },
    });

    const brief = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    const yielded = JSON.parse(JSON.stringify(brief.traversals));
    const nextBrief = progressBrief(runtime, brief, { move: "defer" });

    expect(nextBrief.traversals).toEqual(yielded);
    expect(nextBrief.traversals).not.toBe(brief.traversals);
  });

  it("keeps resolved action state for resumable nodes and drops it for non-resumable ones", () => {
    const resumableDocument = parse(`
"use arc v2";

function Main() {
  const topic = new Enum(["unknown", "metal"]);
  topic.observing = \`what topic does \${user} want\`;

  \`intro\`;
  observeOrAsk(topic);
  \`after \${topic}\`;
}
`);
    const resumableRuntime = new Runtime().add(
      "resumable-arc",
      resumableDocument,
    );
    const resumableSeeded = resumableRuntime.createTraversal(
      arc("resumable-arc", "Main"),
    );
    resumableSeeded.phase = "entered";
    const resumableInitial = resumableRuntime.start([resumableSeeded], {
      lastTurns: [{ role: "user", message: "hi" }],
    });
    const resumableAsk = progressBrief(resumableRuntime, resumableInitial, {
      move: "proceed",
    });
    const resumableResumed = resumableRuntime.start(
      runtimeAfterAsk(resumableRuntime, resumableAsk),
      {
        lastTurns: [{ role: "user", message: "later" }],
      },
    );

    expect(resumableInitial.instructions.map((item) => item.text)).toEqual([
      "intro",
    ]);
    expect(resumableResumed.instructions).toEqual([]);

    const nonResumableDocument = parse(`
"use arc v2";

function Main() {
  this.resumable = false;
  const topic = new Enum(["unknown", "metal"]);
  topic.observing = \`what topic does \${user} want\`;

  \`intro\`;
  observeOrAsk(topic);
  \`after \${topic}\`;
}
`);
    const nonResumableRuntime = new Runtime().add(
      "non-resumable-arc",
      nonResumableDocument,
    );
    const nonResumableSeeded = nonResumableRuntime.createTraversal(
      arc("non-resumable-arc", "Main"),
    );
    nonResumableSeeded.phase = "entered";
    const nonResumableInitial = nonResumableRuntime.start(
      [nonResumableSeeded],
      {
        lastTurns: [{ role: "user", message: "hi" }],
      },
    );
    const nonResumableAsk = progressBrief(
      nonResumableRuntime,
      nonResumableInitial,
      {
        move: "proceed",
      },
    );
    const nonResumableResumed = nonResumableRuntime.start(
      runtimeAfterAsk(nonResumableRuntime, nonResumableAsk),
      {
        lastTurns: [{ role: "user", message: "later" }],
      },
    );

    expect(nonResumableResumed.instructions.map((item) => item.text)).toEqual([
      "intro",
    ]);
  });

  it("retries deflected children but auto-skips covered children on trigger restart", () => {
    const retryDocument = parse(`
"use arc v2";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.resumable = false;

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;
    observeOrAsk(topic);
    \`after \${topic}\`;
  }
}
`);
    const runtime = new Runtime().add("retry-arc", retryDocument);
    const firstOutcome = runtime.progressTrigger(
      runtime.startTrigger({ lastTurns: [] }),
      {
        match: arc("retry-arc", "Main"),
      },
    );
    const firstBrief = runtime.start(firstOutcome.traversals, {
      lastTurns: [],
    });
    const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

    expect(ownedChild(deflected.traversals[0]!, "Main.Intro")?.state).toBe(
      "deflected",
    );

    const restartedOutcome = runtime.progressTrigger(
      runtime.startTrigger({ lastTurns: [] }, deflected.traversals),
      { match: arc("retry-arc", "Main") },
    );
    const restartedBrief = runtime.start(restartedOutcome.traversals, {
      lastTurns: [],
    });

    expect(restartedBrief.active).toEqual(node("retry-arc", "Main.Intro"));
    expect(restartedBrief.observations).toHaveLength(1);

    const coveredDocument = parse(`
"use arc v2";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.resumable = false;

  enter(Intro);
  \`after\`;

  function Intro() {
    \`intro\`;
  }
}
`);
    const coveredRuntime = new Runtime().add("covered-arc", coveredDocument);
    const coveredOutcome = coveredRuntime.progressTrigger(
      coveredRuntime.startTrigger({ lastTurns: [] }),
      {
        match: arc("covered-arc", "Main"),
      },
    );
    const firstCoveredBrief = coveredRuntime.start(coveredOutcome.traversals, {
      lastTurns: [],
    });

    expect(firstCoveredBrief.instructions.map((item) => item.text)).toEqual([
      "intro",
    ]);

    const secondCoveredBrief = progressBrief(
      coveredRuntime,
      firstCoveredBrief,
      {
        move: "proceed",
      },
    );

    expect(secondCoveredBrief.instructions.map((item) => item.text)).toEqual([
      "after",
    ]);

    const completedCoveredBrief = progressBrief(
      coveredRuntime,
      secondCoveredBrief,
      {
        move: "proceed",
      },
    );

    const restartedCoveredOutcome = coveredRuntime.progressTrigger(
      coveredRuntime.startTrigger(
        { lastTurns: [] },
        completedCoveredBrief.traversals,
      ),
      { match: arc("covered-arc", "Main") },
    );
    const restartedCoveredBrief = coveredRuntime.start(
      restartedCoveredOutcome.traversals,
      { lastTurns: [] },
    );

    expect(restartedCoveredBrief.instructions.map((item) => item.text)).toEqual(
      ["after"],
    );
  });

  it("re-enters a suspended arc with incremented enterCount after trigger restart", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.trigger = () => {
    return true;
  };

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;
    observeOrAsk(topic);
  }
}
`);
    const runtime = new Runtime().add("suspend-reenter-arc", document);
    const firstOutcome = runtime.progressTrigger(
      runtime.startTrigger({ lastTurns: [] }),
      { match: arc("suspend-reenter-arc", "Main") },
    );
    const firstBrief = runtime.start(firstOutcome.traversals, {
      lastTurns: [],
    });
    const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

    const suspendedRoot = rootTraversal(deflected);
    expect(suspendedRoot.phase).toBe("suspended");
    expect(suspendedRoot.enterCount).toBe(1);

    const restarted = runtime.progressTrigger(
      runtime.startTrigger({ lastTurns: [] }, deflected.traversals),
      { match: arc("suspend-reenter-arc", "Main") },
    );
    const restartedRoot = restarted.traversals.find(
      (item) => item.ref === arc("suspend-reenter-arc", "Main"),
    );
    expect(restartedRoot).toMatchObject({
      phase: "entered",
      enterCount: 2,
      state: undefined,
    });
  });

  it("marks the active node deflected when the report deflects", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    });
    const triggerOutcome = runtime.progressTrigger(triggerBrief, {
      match: arc("metal-arc", "Metal"),
      judgments: {
        [triggerBrief.judgments[0]!.id]: true,
      },
    });

    const brief = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    const nextBrief = progressBrief(runtime, brief, { move: "deflect" });

    expect(nextBrief.active).toEqual(node("metal-arc", "Metal.Surface"));
    expect(nextBrief.canProgress).toBe(false);
    expect(ownedChild(rootTraversal(nextBrief), "Metal.Surface")?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("allows nested children to read outer variables lexically", () => {
    const document = parse(`
"use arc v2";

function Outer() {
  const a = new Boolean();
  a.set(true);
  enter(Inner);

  function Inner() {
    if (a === true) {
      \`inner sees outer\`;
    }
  }
}
`);
    const runtime = new Runtime().add("outer-arc", document);
    const seeded = runtime.createTraversal(arc("outer-arc", "Outer"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "inner sees outer",
    ]);
    expect(rootTraversal(brief).variables.a).toBe(true);
    expect(
      ownedChild(rootTraversal(brief), "Outer.Inner")?.state,
    ).toBeUndefined();
  });

  it("attaches lexically owned sibling children to the lexical owner, not the immediate caller", () => {
    const document = parse(`
"use arc v2";

function A() {
  enter(B);

  function B() {
    enter(C);
  }

  function C() {
    const ready = new Boolean();
    ready.observing = \`is \${user} ready\`;
    observeOrAsk(ready);
  }
}
`);
    const runtime = new Runtime().add("owner-arc", document);
    const seeded = runtime.createTraversal(arc("owner-arc", "A"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.active).toEqual(node("owner-arc", "A.C"));

    const root = rootTraversal(brief);
    const b = ownedChild(root, "A.B");
    const c = ownedChild(root, "A.C");

    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(b?.ownedChildren).toEqual([]);
    expect(c?.ref).toEqual(node("owner-arc", "A.C"));
  });

  it("supports labeled break with the label outside an if branch", () => {
    const document = parse(`
"use arc v2";

function Main() {
  fork: {
    if (true) {
      \`first\`;
      break fork;
    }
    \`fallback\`;
  }

  enter(After);

  function After() {
    \`after\`;
  }
}
`);
    const runtime = new Runtime().add("break-outside-if-arc", document);
    const seeded = runtime.createTraversal(arc("break-outside-if-arc", "Main"));
    seeded.phase = "entered";

    const branchBrief = runtime.start([seeded], { lastTurns: [] });

    expect(branchBrief.instructions.map((item) => item.text)).toEqual([
      "first",
    ]);

    const afterBrief = progressBrief(runtime, branchBrief, { move: "proceed" });

    expect(afterBrief.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("supports labeled break with the label inside an if branch", () => {
    const document = parse(`
"use arc v2";

function Main() {
  if (true) {
    branch: {
      \`inner\`;
      break branch;
      \`skipped\`;
    }
  }

  enter(After);

  function After() {
    \`after\`;
  }
}
`);
    const runtime = new Runtime().add("break-inside-if-arc", document);
    const seeded = runtime.createTraversal(arc("break-inside-if-arc", "Main"));
    seeded.phase = "entered";

    const branchBrief = runtime.start([seeded], { lastTurns: [] });

    expect(branchBrief.instructions.map((item) => item.text)).toEqual([
      "inner",
    ]);

    const afterBrief = progressBrief(runtime, branchBrief, { move: "proceed" });

    expect(afterBrief.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("propagates labeled breaks through nested labels until the target matches", () => {
    const document = parse(`
"use arc v2";

function Main() {
  outer: {
    inner: {
      \`inner\`;
      break outer;
      \`skipped inner\`;
    }
    \`skipped outer\`;
  }

  enter(After);

  function After() {
    \`after\`;
  }
}
`);
    const runtime = new Runtime().add("nested-break-arc", document);
    const seeded = runtime.createTraversal(arc("nested-break-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual(["inner"]);

    const afterBrief = progressBrief(runtime, brief, { move: "proceed" });

    expect(afterBrief.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("rejects invalid action reports: illegal move, bogus judgment id, bogus observation id", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "music" }],
    });
    const triggerOutcome = runtime.progressTrigger(triggerBrief, {
      match: arc("metal-arc", "Metal"),
      judgments: { [triggerBrief.judgments[0]!.id]: true },
    });
    const brief = runtime.start(triggerOutcome.traversals, { lastTurns: [] });

    expect(() =>
      progressBrief(runtime, brief, { move: "deflect" as "proceed" }),
    ).not.toThrow();

    const brief2 = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    expect(() =>
      progressBrief(runtime, brief2, {
        move: "proceed",
        judgments: { "bogus-id": true },
      }),
    ).toThrow(/Unknown judgment id in action report/);

    const brief3 = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    expect(() =>
      progressBrief(runtime, brief3, {
        move: "proceed",
        observations: { "bogus-id": { status: "resolved", value: "x" } },
      }),
    ).toThrow(/Unknown observation id in action report/);
  });

  it("rejects stale host call ids in action reports", () => {
    const document = parse(`
"use arc v2";

import Dice from "host:rng";

function Main() {
  const lucky = new Boolean();
  lucky.set(Dice.roll(20));
  \`after\`;
}
`);
    const runtime = new Runtime().add("action-host-id-arc", document);
    const seeded = runtime.createTraversal(arc("action-host-id-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.hostCalls).toHaveLength(1);
    const staleId = brief.hostCalls[0]!.id;

    const afterHostCall = progressBrief(runtime, brief, {
      move: "proceed",
      hostCalls: { [staleId]: true },
    });
    expect(afterHostCall.hostCalls).toEqual([]);

    expect(() =>
      progressBrief(runtime, afterHostCall, {
        move: "proceed",
        hostCalls: { [staleId]: false },
      }),
    ).toThrow(/Unknown host call id in action report/);
  });

  it("rejects invalid trigger reports: unknown arc, bogus judgment id", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = runtime.startTrigger({
      lastTurns: [{ role: "user", message: "music" }],
    });

    expect(() =>
      runtime.progressTrigger(triggerBrief, {
        match: arc("nonexistent", "Nope"),
      }),
    ).toThrow(/Unknown arc selected in trigger report/);

    expect(() =>
      runtime.progressTrigger(triggerBrief, {
        judgments: { "bogus-id": true },
      }),
    ).toThrow(/Unknown judgment id in trigger report/);
  });

  it("resolves trigger host calls and rejects unknown trigger host call ids", () => {
    const document = parse(`
"use arc v2";

import Dice from "host:rng";

function Main() {
  this.trigger = () => {
    return Dice.roll(20);
  };
}
`);
    const runtime = new Runtime().add("trigger-host-id-arc", document);
    const triggerBrief = runtime.startTrigger({ lastTurns: [] });
    expect(triggerBrief.hostCalls).toHaveLength(1);

    expect(() =>
      runtime.progressTrigger(triggerBrief, {
        hostCalls: { "bogus-id": true },
      }),
    ).toThrow(/Unknown host call id in trigger report/);

    const accepted = runtime.progressTrigger(triggerBrief, {
      hostCalls: { [triggerBrief.hostCalls[0]!.id]: true },
    });
    expect(accepted.matched).toEqual(arc("trigger-host-id-arc", "Main"));
  });

  it("compares enum variables by declaration order, not lexicographic order", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const level = new Enum(["cold", "warm", "hot"]);
  level.set("hot");

  if (level >= "warm") {
    \`above warm\`;
  }
  if (level < "warm") {
    \`below warm\`;
  }
  if (level > "cold") {
    \`above cold\`;
  }
}
`);
    const runtime = new Runtime().add("enum-arc", document);
    const seeded = runtime.createTraversal(arc("enum-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "above warm",
      "above cold",
    ]);
  });

  it("commits returns channel values when an entered child reaches COVERED", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  const verdict = new Boolean();

  ready.set(true);
  enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child({ args, returns }) {
    this.effects = () => {
      if (args.ready === true) {
        returns.verdict.set(true);
      }
    };
  }
}
`);
    const runtime = new Runtime().add("enter-channels-arc", document);
    const seeded = runtime.createTraversal(arc("enter-channels-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(rootTraversal(brief).variables.verdict).toBe(true);
    expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
      "covered",
    );
    expect(rootTraversal(brief).phase).toBe("completed");
  });

  it("reads args.* in normal action flow for child branching", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.set(true);

  enter(Child, {
    args: { ready },
  });

  function Child({ args }) {
    if (args.ready === true) {
      \`ready branch\`;
    } else {
      \`fallback branch\`;
    }
  }
}
`);
    const runtime = new Runtime().add("enter-args-action-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-args-action-arc", "Main"),
    );
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "ready branch",
    ]);
  });

  it("reads args.* in normal action flow for false branch", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();
  ready.set(false);

  enter(Child, {
    args: { ready },
  });

  function Child({ args }) {
    if (args.ready === true) {
      \`ready branch\`;
    } else {
      \`fallback branch\`;
    }
  }
}
`);
    const runtime = new Runtime().add("enter-args-action-false-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-args-action-false-arc", "Main"),
    );
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "fallback branch",
    ]);
  });

  it("does not commit returns channel values when the child is SKIPPED", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const verdict = new Boolean();

  enter(Child, {
    returns: { verdict },
  });

  function Child({ returns }) {
    this.guard = () => {
      return State.SKIPPED;
    };
    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("enter-channels-skip-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-channels-skip-arc", "Main"),
    );
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(rootTraversal(brief).variables.verdict).toBeUndefined();
    expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
      "skipped",
    );
  });

  it("does not commit returns channel values when the child is DEFLECTED", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const verdict = new Boolean();
  enter(Child, { returns: { verdict } });

  function Child({ returns }) {
    const topic = new Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      returns.verdict.set(true);
    };

    observeOrAsk(topic);
  }
}
`);
    const runtime = new Runtime().add("enter-channels-deflect-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-channels-deflect-arc", "Main"),
    );
    seeded.phase = "entered";
    const firstBrief = runtime.start([seeded], { lastTurns: [] });
    const afterDeflect = progressBrief(runtime, firstBrief, {
      move: "deflect",
    });

    expect(rootTraversal(afterDeflect).variables.verdict).toBeUndefined();
    expect(ownedChild(rootTraversal(afterDeflect), "Main.Child")?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(afterDeflect).phase).toBe("suspended");
  });

  it("fails fast at runtime when args channel keys are not wired by enter()", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child);

  function Child({ args }) {
    this.effects = () => {
      if (args.ready === true) {
      }
      if (args.ready === false) {
      }
    };
  }
}
`);
    const runtime = new Runtime().add("enter-missing-args-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-missing-args-arc", "Main"),
    );
    seeded.phase = "entered";

    expect(() => runtime.start([seeded], { lastTurns: [] })).toThrow(
      /Unknown args channel key "ready"/,
    );
  });

  it("fails fast at runtime when args channel keys are read in normal action flow but not wired", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child);

  function Child({ args }) {
    if (args.ready === true) {
      \`ready\`;
    }
  }
}
`);
    const runtime = new Runtime().add(
      "enter-missing-args-action-arc",
      document,
    );
    const seeded = runtime.createTraversal(
      arc("enter-missing-args-action-arc", "Main"),
    );
    seeded.phase = "entered";

    expect(() => runtime.start([seeded], { lastTurns: [] })).toThrow(
      /Unknown args channel key "ready"/,
    );
  });

  it("fails fast at runtime when returns channel keys are not wired by enter()", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child, {
    returns: {},
  });

  function Child({ returns }) {
    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("enter-missing-returns-arc", document);
    const seeded = runtime.createTraversal(
      arc("enter-missing-returns-arc", "Main"),
    );
    seeded.phase = "entered";

    expect(() => runtime.start([seeded], { lastTurns: [] })).toThrow(
      /Unknown return channel key "verdict"/,
    );
  });

  it("evaluates regexTest expressions at runtime", () => {
    const document = parse(`
"use arc v2";

function Main() {
  if (/metal/i.test(Dialog.lastUserMessage)) {
    \`matched\`;
  }
  if (/jazz/.test(Dialog.lastUserMessage)) {
    \`no match\`;
  }
}
`);
    const runtime = new Runtime().add("regex-arc", document);
    const seeded = runtime.createTraversal(arc("regex-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], {
      lastTurns: [{ role: "user", message: "I love Metal" }],
    });

    expect(brief.instructions.map((item) => item.text)).toEqual(["matched"]);
  });

  it("replans against the latest dialog passed to progress", () => {
    const document = parse(`
"use arc v2";

function Main() {
  \`first\`;
  if (/later/i.test(Dialog.lastUserMessage)) {
    \`second\`;
  }
}
`);
    const runtime = new Runtime().add("dialog-arc", document);
    const seeded = runtime.createTraversal(arc("dialog-arc", "Main"));
    seeded.phase = "entered";

    const firstDialog: Dialog = {
      lastTurns: [{ role: "user", message: "hello" }],
    };
    const secondDialog: Dialog = {
      lastTurns: [{ role: "user", message: "later now" }],
    };

    const brief = runtime.start([seeded], firstDialog);
    expect(brief.instructions.map((item) => item.text)).toEqual(["first"]);

    const nextBrief = progressBrief(
      runtime,
      brief,
      { move: "proceed" },
      secondDialog,
    );

    expect(nextBrief.instructions.map((item) => item.text)).toEqual(["second"]);
  });
});

function runtimeAfterAsk(
  runtime: Runtime,
  brief: ReturnType<Runtime["start"]>,
): ArcTraversalSet {
  return progressBrief(runtime, brief, {
    move: "proceed",
    observations: {
      [brief.observations[0]!.id]: { status: "needs-user" },
    },
  }).traversals;
}
