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

function ephemeralChild(
  traversal: ArcTraversal | NodeTraversal,
  identifier: string,
): NodeTraversal | undefined {
  return traversal.ephemeralChildren.find(
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

function traversalByRef(
  brief: ActionBrief,
  ref: ArcRef,
): ArcTraversal | undefined {
  return brief.traversals.find((traversal) => traversal.ref === ref);
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

function startTrigger(
  runtime: Runtime,
  dialog: Dialog,
  traversals: ArcTraversalSet = runtime.newTraversalSet(),
) {
  return runtime.startTrigger(traversals, dialog);
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

    const brief = runtime.start(triggerOutcome.traversals, dialog);

    expect(rootTraversal(brief).ref).toEqual(metalRef);
    expect(brief.canProgress).toBe(true);
    expect(brief.active).toEqual(node("metal-arc", "Metal.Surface"));
    expect(brief.observations).toHaveLength(1);
    expect(brief.allowedMoves).toContain("proceed");

    const surface = ownedChild(rootTraversal(brief), "Metal.Surface");
    expect(surface?.ref).toEqual(node("metal-arc", "Metal.Surface"));
  });

  it("treats fresh owned children as pseudo-children stored in ephemeralChildren", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(fresh(Child));

  function Child() {
    const ready = new Boolean();
    observeOrAsk(ready);
  }
}
`);
    const runtime = new Runtime().add("fresh-owned-arc", document);
    const traversal = runtime.newTraversal(arc("fresh-owned-arc", "Main"));
    traversal.phase = "entered";

    const brief = runtime.start([traversal], EMPTY_DIALOG);

    expect(brief.active).toEqual(node("fresh-owned-arc", "Main.Child#0"));
    expect(rootTraversal(brief).ownedChildren).toHaveLength(0);
    const child = ephemeralChild(rootTraversal(brief), "Main.Child#0");
    expect(child?.ref).toEqual(node("fresh-owned-arc", "Main.Child#0"));
  });

  it("folds fresh imported arcs into pseudo-children instead of the root traversal set", () => {
    const main = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  enter(fresh(Intro));
}
`);
    const intro = parse(`
"use arc v2";

function Intro() {
  const topic = new Boolean();
  observeOrAsk(topic);
}
`);
    const runtime = new Runtime().add("main-arc", main).add("intro-arc", intro);
    const traversal = runtime.newTraversal(arc("main-arc", "Main"));
    traversal.phase = "entered";

    const brief = runtime.start([traversal], EMPTY_DIALOG);

    expect(brief.active).toEqual(node("main-arc", "Main.Intro#0"));
    expect(brief.traversals).toHaveLength(1);
    expect(rootTraversal(brief).refChildren).toEqual([]);
    const child = ephemeralChild(rootTraversal(brief), "Main.Intro#0");
    expect(child?.ref).toEqual(node("main-arc", "Main.Intro#0"));
  });

  it("walks nested owned and pseudo-child traversals with synthetic refs", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(fresh(B));

  function B() {
    enter(C);

    function C() {
      enter(fresh(D));

      function D() {
        const ready = new Boolean();
        observeOrAsk(ready);
      }
    }
  }
}
`);
    const runtime = new Runtime().add("nested-fresh-arc", document);
    const traversal = runtime.newTraversal(arc("nested-fresh-arc", "Main"));
    traversal.phase = "entered";

    const brief = runtime.start([traversal], EMPTY_DIALOG);

    expect(brief.active).toEqual(node("nested-fresh-arc", "Main.B#0.C.D#0"));
    const b = ephemeralChild(rootTraversal(brief), "Main.B#0");
    expect(b?.ref).toEqual(node("nested-fresh-arc", "Main.B#0"));
    const c = b ? ownedChild(b, "Main.B#0.C") : undefined;
    expect(c?.ref).toEqual(node("nested-fresh-arc", "Main.B#0.C"));
    const d = c ? ephemeralChild(c, "Main.B#0.C.D#0") : undefined;
    expect(d?.ref).toEqual(node("nested-fresh-arc", "Main.B#0.C.D#0"));
  });

  it("goes past enter(fresh(...)) after the fresh child resolves", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(fresh(Child));
  \`done\`;

  function Child() {
    const ready = new Boolean();
    observeOrAsk(ready);
  }
}
`);
    const runtime = new Runtime().add("fresh-resolution-arc", document);
    const traversal = runtime.newTraversal(arc("fresh-resolution-arc", "Main"));
    traversal.phase = "entered";

    const brief = runtime.start([traversal], EMPTY_DIALOG);
    expect(brief.active).toEqual(node("fresh-resolution-arc", "Main.Child#0"));
    expect(brief.observations).toHaveLength(1);

    const next = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(next.active).toEqual(node("fresh-resolution-arc", "Main"));
    expect(next.instructions).toHaveLength(1);
    const child = ephemeralChild(rootTraversal(next), "Main.Child#0");
    expect(child?.state).toBe("covered");
  });

  it("creates dormant root traversals with enterCount 0 until first entry", () => {
    const document = parse(`
"use arc v2";

function Main() {
  \`hello\`;
}
`);
    const runtime = new Runtime().add("dormant-enter-count-arc", document);
    const traversal = runtime.newTraversal(
      arc("dormant-enter-count-arc", "Main"),
    );

    expect(traversal.phase).toBe("dormant");
    expect(traversal.enterCount).toBe(0);

    traversal.phase = "entered";
    const brief = runtime.start([traversal], EMPTY_DIALOG);

    expect(rootTraversal(brief).enterCount).toBe(0);
    expect(brief.instructions.map((item) => item.text)).toEqual(["hello"]);
  });

  it("reopens a covered canonical child with preserved variables and a cleared frame", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child);
  enter(reopen(Child));
  \`done\`;

  function Child() {
    const seen = new Boolean();
    \`intro\`;

    if (seen === true) {
      \`again\`;
    }

    this.effects = () => {
      seen.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("reopen-covered-arc", document);
    const traversal = runtime.newTraversal(arc("reopen-covered-arc", "Main"));
    traversal.phase = "entered";

    const firstBrief = runtime.start([traversal], EMPTY_DIALOG);
    expect(firstBrief.instructions.map((item) => item.text)).toEqual(["intro"]);

    const secondBrief = progressBrief(runtime, firstBrief, { move: "proceed" });
    const child = ownedChild(rootTraversal(secondBrief), "Main.Child");
    expect(child?.enterCount).toBe(2);
    expect(child?.variables.seen).toBe(true);
    expect(secondBrief.instructions.map((item) => item.text)).toEqual([
      "intro",
      "again",
    ]);
    const thirdBrief = progressBrief(runtime, secondBrief, { move: "proceed" });
    expect(thirdBrief.instructions.map((item) => item.text)).toEqual(["done"]);
    expect(ownedChild(rootTraversal(thirdBrief), "Main.Child")?.state).toBe(
      "covered",
    );
  });

  it("reopens a skipped canonical child and re-evaluates its guard", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  enter(Child, {
    args: { ready },
  });
  ready.set(true);
  enter(reopen(Child), {
    args: { ready },
  });
  \`done\`;

  function Child({ args }) {
    this.guard = () => {
      if (args.ready !== true) {
        return State.SKIPPED;
      }
    };

    \`child\`;
  }
}
`);
    const runtime = new Runtime().add("reopen-skipped-arc", document);
    const traversal = runtime.newTraversal(arc("reopen-skipped-arc", "Main"));
    traversal.phase = "entered";

    const firstBrief = runtime.start([traversal], EMPTY_DIALOG);
    const child = ownedChild(rootTraversal(firstBrief), "Main.Child");
    expect(child?.enterCount).toBe(2);
    expect(child?.state).toBeUndefined();
    expect(firstBrief.instructions.map((item) => item.text)).toEqual(["child"]);

    const finalBrief = progressBrief(runtime, firstBrief, { move: "proceed" });
    expect(finalBrief.instructions.map((item) => item.text)).toEqual(["done"]);
    expect(ownedChild(rootTraversal(finalBrief), "Main.Child")?.state).toBe(
      "covered",
    );
  });

  it("reflects a reopened child's new terminal state through Child.state", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child);
  enter(reopen(Child));

  if (Child.state === State.SKIPPED) {
    \`reopened skipped\`;
  }

  function Child() {
    const shouldSkip = new Boolean();

    this.guard = () => {
      if (shouldSkip === true) {
        return State.SKIPPED;
      }
    };

    this.effects = () => {
      shouldSkip.set(true);
    };

    \`child body\`;
  }
}
`);
    const runtime = new Runtime().add("reopen-state-arc", document);
    const traversal = runtime.newTraversal(arc("reopen-state-arc", "Main"));
    traversal.phase = "entered";

    const firstBrief = runtime.start([traversal], EMPTY_DIALOG);
    expect(firstBrief.instructions.map((item) => item.text)).toEqual([
      "child body",
    ]);

    const secondBrief = progressBrief(runtime, firstBrief, { move: "proceed" });
    expect(secondBrief.instructions.map((item) => item.text)).toEqual([
      "reopened skipped",
    ]);
    expect(ownedChild(rootTraversal(secondBrief), "Main.Child")?.state).toBe(
      "skipped",
    );
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
    const dialog: Dialog = {
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
    const dialog: Dialog = {
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

    const firstDialog: Dialog = {
      lastTurns: [{ role: "user", message: "music" }],
    };
    const firstBrief = startTrigger(runtime, firstDialog);

    expect(firstBrief.judgments.map((item) => item.question)).toEqual([
      "user mentions music for the first time",
    ]);

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
        lastTurns: [{ role: "user", message: "music again" }],
      },
      firstOutcome.traversals,
    );

    expect(secondBrief.judgments.map((item) => item.question)).toEqual([
      "user mentions music again",
    ]);

    const secondDialog: Dialog = {
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

    const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);
    const outcome = runtime.progressTrigger(triggerBrief, {}, EMPTY_DIALOG);

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
    const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);

    expect(triggerBrief.matched).toEqual(
      arc("single-match-trigger-arc", "First"),
    );
    expect(triggerBrief.matchableArcs).toEqual([]);
  });

  it("returns ambiguous-match until a later trigger report names a preferred match", () => {
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
      .add("ambiguous-first-arc", first)
      .add("ambiguous-second-arc", second);

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
        (traversal) => traversal.ref === arc("ambiguous-second-arc", "Second"),
      ),
    ).toMatchObject({
      ref: arc("ambiguous-second-arc", "Second"),
      phase: "entered",
      enterCount: 1,
    });
  });

  it("supports multi-round trigger resolution when later trigger work is unlocked by earlier answers", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const topic = new Enum(["metal", "jazz"]);
  topic.observing = \`what topic is \${user} discussing\`;

  this.trigger = () => {
    if (judge(\`\${user} is discussing music\`)) {
      observe(topic);
      return topic === "metal";
    }
    return false;
  };
}
`);
    const runtime = new Runtime().add("nested-trigger-arc", document);
    const dialog: Dialog = {
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

    const finalBrief = runtime.progressTrigger(
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

    const seeded = runtime.newTraversal(arc("main-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual(["expected"]);
    expect(rootTraversal(brief).refChildren).toEqual([
      arc("another-arc", "AnotherArc"),
    ]);
    expect(
      brief.traversals.find(
        (traversal) => traversal.ref === arc("another-arc", "AnotherArc"),
      )?.enterCount,
    ).toBe(1);
  });

  it("does not reopen a covered imported arc on plain enter", () => {
    const main = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  enter(Intro);
  enter(Intro);
  \`done\`;
}
`);
    const intro = parse(`
"use arc v2";

function Intro() {
  \`intro\`;
}
`);
    const runtime = new Runtime().add("main-arc", main).add("intro-arc", intro);
    const seeded = runtime.newTraversal(arc("main-arc", "Main"));
    seeded.phase = "entered";

    const firstBrief = runtime.start([seeded], EMPTY_DIALOG);
    expect(firstBrief.instructions.map((item) => item.text)).toEqual(["intro"]);

    const secondBrief = progressBrief(runtime, firstBrief, { move: "proceed" });
    expect(secondBrief.instructions.map((item) => item.text)).toEqual(["done"]);
    expect(
      secondBrief.traversals.find(
        (traversal) => traversal.ref === arc("intro-arc", "Intro"),
      )?.enterCount,
    ).toBe(1);
  });

  it("records needs-user/proceed flow against the active owned child", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const dialog: Dialog = {
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    };

    const triggerBrief = startTrigger(runtime, dialog);
    const triggerOutcome = runtime.progressTrigger(
      triggerBrief,
      {
        preferredMatch: arc("metal-arc", "Metal"),
        judgments: {
          [triggerBrief.judgments[0]!.id]: true,
        },
      },
      dialog,
    );

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
    expect(afterProceed.canProgress).toBe(true);
    expect(rootTraversal(afterProceed).phase).toBe("entered");
    expect(
      ownedChild(rootTraversal(afterProceed), "Metal.Surface")?.variables
        .subgenre,
    ).toBe("thrash");

    const completed = progressBrief(runtime, afterProceed, {
      move: "proceed",
    });
    expect(completed.canProgress).toBe(false);
    expect(rootTraversal(completed).phase).toBe("completed");
  });

  it("treats bare instruction literals as one-shot instructions", () => {
    const document = parse(`
"use arc v2";

function Main() {
  \`hello\`;
}
`);
    const runtime = new Runtime().add("once-arc", document);
    const seeded = runtime.newTraversal(arc("once-arc", "Main"));
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
    expect(brief.allowedMoves).toEqual(["proceed"]);

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
    const seeded = runtime.newTraversal(arc("instruction-move-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.allowedMoves).toEqual(["proceed"]);
    const nextBrief = progressBrief(runtime, brief, { move: "deflect" });
    expect(nextBrief.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "illegal-move",
      }),
    ]);
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
    const seeded = runtime.newTraversal(
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

  it("captures only currently reachable postchecks and postpones deeper checks", () => {
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
    const seeded = runtime.newTraversal(
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
    const seeded = runtime.newTraversal(
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
    expect(afterUnknown.observations).toHaveLength(0);
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
    const seeded = runtime.newTraversal(arc("trigger-frame-reset-arc", "Main"));

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
    const seeded = runtime.newTraversal(arc("instruct-implicit-arc", "Main"));
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
    const seeded = runtime.newTraversal(
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
    const seeded = runtime.newTraversal(arc("persistent-arc", "Main"));
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
    expect(brief.allowedMoves).toEqual(["proceed"]);

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
    const seeded = runtime.newTraversal(arc("instruction-batched-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("instruction-deflect-arc", "Main"));
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

  it("derives instruction deflection from inherited node-level deflectWhen after handback", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;
  instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`);
    const runtime = new Runtime().add("inherited-deflect-arc", document);
    const seeded = runtime.newTraversal(arc("inherited-deflect-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.instructions.map((item) => item.text)).toEqual([
      "Carry the topic.",
    ]);

    const handback = progressBrief(runtime, brief, { move: "proceed" });

    expect(handback.judgments.map((item) => item.question)).toEqual([
      "user wants to leave this topic",
      "self covered the topic enough",
    ]);
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
    const seeded = runtime.newTraversal(arc("guard-semantic-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("host-call-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("effects-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("effects-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("observe-arc", "Main"));
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

  it("returns invalid-item when observe() values do not match the variable type", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const interest = new Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;
  observe(interest);
}
`);
    const runtime = new Runtime().add("observe-type-arc", document);
    const seeded = runtime.newTraversal(arc("observe-type-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    const nextBrief = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(nextBrief.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-item",
        briefId: brief.observations[0]!.id,
        reasonCode: "observation-enum",
      }),
    ]);
    expect(nextBrief.observations.map((item) => item.id)).toEqual([
      brief.observations[0]!.id,
    ]);
  });

  it("compares enum values by ordinal position, not lexicographic order", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  const interest = new Enum(["cold", "lukewarm", "curious", "enthusiastic"]);
  const topic = new Enum(["unknown", "metal"]);
  interest.observing = \`how interested is \${user}\`;

  this.effects = () => {
    observe(interest);
    if (interest >= "curious") {
      topic.set("metal");
    }
    if (topic === "metal") {
      Memoir.facts.apply(\`\${user} is engaged\`);
    }
  };
}
`);

    const runtime = new Runtime().add("ordinal-arc", document);
    const seeded = runtime.newTraversal(arc("ordinal-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], {
      lastTurns: [{ role: "user", message: "kinda" }],
    });

    const lukewarmBrief = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: { status: "resolved", value: "lukewarm" },
      },
    });

    expect(rootTraversal(lukewarmBrief).variables.interest).toBe("lukewarm");
    expect(rootTraversal(lukewarmBrief).variables.topic).toBeUndefined();
    expect(lukewarmBrief.hostEffects).toEqual([]);

    const runtime2 = new Runtime().add("ordinal-arc", document);
    const seeded2 = runtime2.newTraversal(arc("ordinal-arc", "Main"));
    seeded2.phase = "entered";
    const brief2 = runtime2.start([seeded2], {
      lastTurns: [{ role: "user", message: "very" }],
    });

    const curiousBrief = progressBrief(runtime2, brief2, {
      move: "proceed",
      observations: {
        [brief2.observations[0]!.id]: { status: "resolved", value: "curious" },
      },
    });

    expect(rootTraversal(curiousBrief).variables.interest).toBe("curious");
    expect(rootTraversal(curiousBrief).variables.topic).toBe("metal");
    expect(curiousBrief.hostEffects).toEqual([
      {
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: ["user is engaged"],
      },
    ]);
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
    const seeded = runtime.newTraversal(arc("idempotent-effects-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("deflect-effects-arc", "Main"));
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
    expect(rootTraversal(nextBrief).state).toBe("deflected");
    expect(rootTraversal(nextBrief).phase).toBe("suspended");
  });

  it("lets a parent catch child deflection, set a routing flag, and rewalk itself", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const wantsPricing = new Boolean();

  this.catchDeflection = () => {
    if (deflection.from(ProductIntro) && judge(\`\${user} wants pricing\`)) {
      wantsPricing.set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing === true) {
    enter(Pricing);
    wantsPricing.set(false);
  }

  enter(ProductIntro);

  function ProductIntro() {
    const topic = new Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    observeOrAsk(topic);
  }

  function Pricing() {
    const priceTopic = new Enum(["unknown", "pricing"]);
    priceTopic.observing = \`what pricing detail does \${user} want\`;
    observeOrAsk(priceTopic);
  }
}
`);

    const runtime = new Runtime().add("catch-deflection-arc", document);
    const seeded = runtime.newTraversal(arc("catch-deflection-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.active).toEqual(
      node("catch-deflection-arc", "Main.ProductIntro"),
    );

    const catching = progressBrief(runtime, brief, { move: "deflect" });
    expect(catching.active).toEqual(node("catch-deflection-arc", "Main"));
    expect(catching.judgments.map((item) => item.question)).toEqual([
      "user wants pricing",
    ]);
    expect(
      ownedChild(rootTraversal(catching), "Main.ProductIntro")?.state,
    ).toBe("deflected");

    const routed = progressBrief(runtime, catching, {
      move: "proceed",
      judgments: { [catching.judgments[0]!.id]: true },
    });

    expect(rootTraversal(routed).variables.wantsPricing).toBe(true);
    expect(routed.active).toEqual(node("catch-deflection-arc", "Main.Pricing"));
    expect(routed.observations).toHaveLength(1);

    const resumed = progressBrief(runtime, routed, {
      move: "proceed",
      observations: {
        [routed.observations[0]!.id]: {
          status: "resolved",
          value: "pricing",
        },
      },
    });

    expect(rootTraversal(resumed).variables.wantsPricing).toBe(false);
    expect(resumed.active).toEqual(
      node("catch-deflection-arc", "Main.ProductIntro"),
    );
    expect(resumed.observations).toHaveLength(1);
  });

  it("does not batch instruction frontiers across enter boundaries", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const wantsPricing = new Boolean();

  this.catchDeflection = () => {
    if (deflection.from(ProductIntro) && judge(\`\${user} wants pricing\`)) {
      wantsPricing.set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing === true) {
    enter(Pricing);
    wantsPricing.set(false);
  }

  enter(ProductIntro);

  function ProductIntro() {
    const topic = new Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    observeOrAsk(topic);
  }

  function Pricing() {
    \`pricing\`;
  }
}
`);

    const runtime = new Runtime().add(
      "enter-instruction-boundary-arc",
      document,
    );
    const seeded = runtime.newTraversal(
      arc("enter-instruction-boundary-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    const catching = progressBrief(runtime, brief, { move: "deflect" });
    const routed = progressBrief(runtime, catching, {
      move: "proceed",
      judgments: { [catching.judgments[0]!.id]: true },
    });

    expect(routed.active).toEqual(
      node("enter-instruction-boundary-arc", "Main.Pricing"),
    );
    expect(routed.instructions.map((item) => item.text)).toEqual(["pricing"]);
    expect(rootTraversal(routed).variables.wantsPricing).toBe(true);

    const resumed = progressBrief(runtime, routed, { move: "proceed" });

    expect(rootTraversal(resumed).variables.wantsPricing).toBe(false);
    expect(resumed.active).toEqual(
      node("enter-instruction-boundary-arc", "Main.ProductIntro"),
    );
  });

  it("catches an imported child deflection and rewalks the importing node", () => {
    const main = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  const wantsPricing = new Boolean();

  this.catchDeflection = () => {
    if (deflection.from(Intro)) {
      wantsPricing.set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing === true) {
    enter(Pricing);
    wantsPricing.set(false);
  }

  enter(Intro);

  function Pricing() {
    const priceTopic = new Enum(["unknown", "pricing"]);
    priceTopic.observing = \`what pricing detail does \${user} want\`;
    observeOrAsk(priceTopic);
  }
}
`);
    const intro = parse(`
"use arc v2";

function Intro() {
  const topic = new Enum(["unknown", "product"]);
  topic.observing = \`what product topic does \${user} want\`;
  observeOrAsk(topic);
}
`);
    const runtime = new Runtime()
      .add("main-import-catch-arc", main)
      .add("intro-arc", intro);
    const seeded = runtime.newTraversal(arc("main-import-catch-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    expect(brief.active).toEqual(node("intro-arc", "Intro"));

    const routed = progressBrief(runtime, brief, { move: "deflect" });

    expect(rootTraversal(routed).state).toBeUndefined();
    expect(traversalByRef(routed, arc("intro-arc", "Intro"))?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(routed).variables.wantsPricing).toBe(true);
    expect(routed.active).toEqual(
      node("main-import-catch-arc", "Main.Pricing"),
    );
  });

  it("propagates uncaught imported child deflection to the importing root", () => {
    const main = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  enter(Intro);
}
`);
    const intro = parse(`
"use arc v2";

function Intro() {
  const topic = new Enum(["unknown", "product"]);
  topic.observing = \`what product topic does \${user} want\`;
  observeOrAsk(topic);
}
`);
    const runtime = new Runtime()
      .add("main-import-deflect-arc", main)
      .add("intro-arc", intro);
    const seeded = runtime.newTraversal(arc("main-import-deflect-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    const deflected = progressBrief(runtime, brief, { move: "deflect" });

    expect(traversalByRef(deflected, arc("intro-arc", "Intro"))?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(deflected).state).toBe("deflected");
    expect(rootTraversal(deflected).phase).toBe("suspended");
  });

  it("catches its own instruction deflection and rewalks itself", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const caught = new Boolean();

  this.catchDeflection = () => {
    caught.set(true);
    return true;
  };

  if (caught === true) {
    \`caught\`;
  } else {
    instructLoop(\`intro\`, {
      deflectWhen: \`\${user} wants to switch topics\`,
      resolveWhen: \`\${self} finished intro\`,
    });
  }
}
`);
    const runtime = new Runtime().add("self-instruction-catch-arc", document);
    const seeded = runtime.newTraversal(
      arc("self-instruction-catch-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    const handback = progressBrief(runtime, brief, { move: "proceed" });
    const deflect = handback.judgments.find(
      (item) => item.question === "user wants to switch topics",
    );
    expect(deflect).toBeDefined();

    const caught = progressBrief(runtime, handback, {
      move: "proceed",
      judgments: { [deflect!.id]: true },
    });

    expect(rootTraversal(caught).state).toBeUndefined();
    expect(rootTraversal(caught).variables.caught).toBe(true);
    expect(caught.instructions.map((item) => item.text)).toEqual(["caught"]);
  });

  it("runs effects and bubbles when catchDeflection returns false", () => {
    const document = parse(`
"use arc v2";
import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.apply(\`parent effect\`);
  };

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;

    this.catchDeflection = () => {
      return false;
    };

    this.effects = () => {
      Memoir.facts.apply(\`child effect\`);
    };

    observeOrAsk(topic);
  }
}
`);
    const runtime = new Runtime().add("catch-false-effects-arc", document);
    const seeded = runtime.newTraversal(arc("catch-false-effects-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    const deflected = progressBrief(runtime, brief, { move: "deflect" });

    expect(deflected.hostEffects.map((effect) => effect.arguments[0])).toEqual([
      "child effect",
      "parent effect",
    ]);
    expect(ownedChild(rootTraversal(deflected), "Main.Intro")?.state).toBe(
      "deflected",
    );
    expect(rootTraversal(deflected).state).toBe("deflected");
  });

  it("does not run effects on an ancestor that catches child deflection", () => {
    const document = parse(`
"use arc v2";
import Memoir from "host:memoir";

function Main() {
  const caught = new Boolean();

  this.catchDeflection = () => {
    if (deflection.from(Intro)) {
      caught.set(true);
      return true;
    }
    return false;
  };

  this.effects = () => {
    Memoir.facts.apply(\`parent effect\`);
  };

  if (caught === true) {
    \`after catch\`;
  }

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.apply(\`child effect\`);
    };

    observeOrAsk(topic);
  }
}
`);
    const runtime = new Runtime().add("catch-suppresses-effects-arc", document);
    const seeded = runtime.newTraversal(
      arc("catch-suppresses-effects-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    const caught = progressBrief(runtime, brief, { move: "deflect" });

    expect(caught.hostEffects.map((effect) => effect.arguments[0])).toEqual([
      "child effect",
    ]);
    expect(rootTraversal(caught).state).toBeUndefined();
    expect(caught.instructions.map((item) => item.text)).toEqual([
      "after catch",
    ]);
  });

  it("resumes a blocking catchDeflection before deciding whether to catch", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const wantsPricing = new Boolean({
    observing: \`does \${user} want pricing\`,
  });

  this.catchDeflection = () => {
    observe(wantsPricing);
    if (wantsPricing === true) {
      return true;
    }
    return false;
  };

  if (wantsPricing === true) {
    enter(Pricing);
  }

  enter(Intro);

  function Intro() {
    const topic = new Enum(["unknown", "product"]);
    topic.observing = \`what product topic does \${user} want\`;
    observeOrAsk(topic);
  }

  function Pricing() {
    \`pricing\`;
  }
}
`);
    const runtime = new Runtime().add("blocking-catch-arc", document);
    const seeded = runtime.newTraversal(arc("blocking-catch-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    const catching = progressBrief(runtime, brief, { move: "deflect" });

    expect(catching.active).toEqual(node("blocking-catch-arc", "Main"));
    expect(catching.observations).toHaveLength(1);
    expect(catching.observations[0]).toMatchObject({
      variable: "wantsPricing",
      mode: "observe",
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

  it("runs effects after a blocking catchDeflection resumes false", () => {
    const document = parse(`
"use arc v2";
import Memoir from "host:memoir";

function Main() {
  const shouldCatch = new Boolean({
    observing: \`should this deflection be caught\`,
  });

  this.catchDeflection = () => {
    observe(shouldCatch);
    return shouldCatch === true;
  };

  this.effects = () => {
    Memoir.facts.apply(\`root deflected\`);
  };

  const topic = new Enum(["unknown", "product"]);
  topic.observing = \`what topic does \${user} want\`;
  observeOrAsk(topic);
}
`);
    const runtime = new Runtime().add("blocking-catch-false-arc", document);
    const seeded = runtime.newTraversal(
      arc("blocking-catch-false-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
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

    expect(deflected.hostEffects.map((effect) => effect.arguments[0])).toEqual([
      "root deflected",
    ]);
    expect(rootTraversal(deflected).state).toBe("deflected");
    expect(rootTraversal(deflected).phase).toBe("suspended");
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
    const seeded = runtime.newTraversal(
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
    const seeded = runtime.newTraversal(
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
    const resumableSeeded = resumableRuntime.newTraversal(
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
    const nonResumableSeeded = nonResumableRuntime.newTraversal(
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
      nonResumableAsk.traversals,
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
      startTrigger(runtime, EMPTY_DIALOG),
      {
        preferredMatch: arc("retry-arc", "Main"),
      },
      EMPTY_DIALOG,
    );
    const firstBrief = runtime.start(firstOutcome.traversals, {
      lastTurns: [],
    });
    const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

    expect(ownedChild(deflected.traversals[0]!, "Main.Intro")?.state).toBe(
      "deflected",
    );

    const restartedOutcome = runtime.progressTrigger(
      startTrigger(runtime, EMPTY_DIALOG, deflected.traversals),
      { preferredMatch: arc("retry-arc", "Main") },
      EMPTY_DIALOG,
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
      startTrigger(coveredRuntime, EMPTY_DIALOG),
      {
        preferredMatch: arc("covered-arc", "Main"),
      },
      EMPTY_DIALOG,
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
      startTrigger(
        coveredRuntime,
        EMPTY_DIALOG,
        completedCoveredBrief.traversals,
      ),
      { preferredMatch: arc("covered-arc", "Main") },
      EMPTY_DIALOG,
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
      startTrigger(runtime, EMPTY_DIALOG),
      { preferredMatch: arc("suspend-reenter-arc", "Main") },
      EMPTY_DIALOG,
    );
    const firstBrief = runtime.start(firstOutcome.traversals, {
      lastTurns: [],
    });
    const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

    const suspendedRoot = rootTraversal(deflected);
    expect(suspendedRoot.phase).toBe("suspended");
    expect(suspendedRoot.enterCount).toBe(1);

    const restarted = runtime.progressTrigger(
      startTrigger(runtime, EMPTY_DIALOG, deflected.traversals),
      { preferredMatch: arc("suspend-reenter-arc", "Main") },
      EMPTY_DIALOG,
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
    const triggerBrief = startTrigger(runtime, {
      lastTurns: [{ role: "user", message: "what music are you into?" }],
    });
    const triggerOutcome = runtime.progressTrigger(
      triggerBrief,
      {
        preferredMatch: arc("metal-arc", "Metal"),
        judgments: {
          [triggerBrief.judgments[0]!.id]: true,
        },
      },
      {
        lastTurns: [{ role: "user", message: "what music are you into?" }],
      },
    );

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
    const seeded = runtime.newTraversal(arc("outer-arc", "Outer"));
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
    const seeded = runtime.newTraversal(arc("owner-arc", "A"));
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
    const seeded = runtime.newTraversal(arc("break-outside-if-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("break-inside-if-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("nested-break-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual(["inner"]);

    const afterBrief = progressBrief(runtime, brief, { move: "proceed" });

    expect(afterBrief.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("returns invalid-report issues for invalid action reports", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = startTrigger(runtime, {
      lastTurns: [{ role: "user", message: "music" }],
    });
    const triggerOutcome = runtime.progressTrigger(
      triggerBrief,
      {
        preferredMatch: arc("metal-arc", "Metal"),
        judgments: { [triggerBrief.judgments[0]!.id]: true },
      },
      {
        lastTurns: [{ role: "user", message: "music" }],
      },
    );
    const brief = runtime.start(triggerOutcome.traversals, { lastTurns: [] });

    expect(() =>
      progressBrief(runtime, brief, { move: "deflect" as "proceed" }),
    ).not.toThrow();

    const brief2 = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    const afterBogusJudgment = progressBrief(runtime, brief2, {
      move: "proceed",
      judgments: { "bogus-id": true },
    });
    expect(afterBogusJudgment.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "unknown-judgment-id",
      }),
    ]);

    const brief3 = runtime.start(triggerOutcome.traversals, { lastTurns: [] });
    const afterBogusObservation = progressBrief(runtime, brief3, {
      move: "proceed",
      observations: { "bogus-id": { status: "resolved", value: "x" } },
    });
    expect(afterBogusObservation.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "unknown-observation-id",
      }),
    ]);
  });

  it("returns invalid-report for bogus host call ids in action reports", () => {
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
    const seeded = runtime.newTraversal(arc("action-host-id-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(brief.hostCalls).toHaveLength(1);
    const retried = progressBrief(runtime, brief, {
      move: "proceed",
      hostCalls: { "bogus-id": false },
    });
    expect(retried.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "unknown-host-call-id",
      }),
    ]);
  });

  it("returns invalid-report issues for invalid trigger reports", () => {
    const document = parse(SOURCE);
    const runtime = new Runtime().add("metal-arc", document);
    const triggerBrief = startTrigger(runtime, {
      lastTurns: [{ role: "user", message: "music" }],
    });

    const unknownArc = runtime.progressTrigger(
      triggerBrief,
      {
        preferredMatch: arc("nonexistent", "Nope"),
      },
      {
        lastTurns: [{ role: "user", message: "music" }],
      },
    );
    expect(unknownArc.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "unknown-trigger-match",
      }),
    ]);

    const bogusJudgment = runtime.progressTrigger(
      triggerBrief,
      {
        judgments: { "bogus-id": true },
      },
      {
        lastTurns: [{ role: "user", message: "music" }],
      },
    );
    expect(bogusJudgment.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-report",
        reasonCode: "unknown-judgment-id",
      }),
    ]);
  });

  it("resolves trigger host calls and returns invalid-report for unknown trigger host call ids", () => {
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
        hostCalls: { [triggerBrief.hostCalls[0]!.id]: true },
      },
      EMPTY_DIALOG,
    );
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
    const seeded = runtime.newTraversal(arc("enum-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], { lastTurns: [] });

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "above warm",
      "above cold",
    ]);
  });

  it("re-walks from the top after set() changes action graph branch reachability", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  if (ready !== true) {
    ready.set(true);
  } else {
    \`now ready\`;
  }
}
`);
    const runtime = new Runtime().add("set-rewalk-arc", document);
    const seeded = runtime.newTraversal(arc("set-rewalk-arc", "Main"));
    seeded.phase = "entered";
    const brief = runtime.start([seeded], EMPTY_DIALOG);

    expect(brief.instructions.map((item) => item.text)).toEqual(["now ready"]);
    expect(rootTraversal(brief).variables.ready).toBe(true);
  });

  it("re-walks from the top after observeOrAsk() resolves normally", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  if (ready === true) {
    \`before\`;
  }

  observeOrAsk(ready);

  if (ready === true) {
    \`after\`;
  }
}
`);
    const runtime = new Runtime().add("observe-rewalk-arc", document);
    const seeded = runtime.newTraversal(arc("observe-rewalk-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    expect(brief.observations).toHaveLength(1);

    const next = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(next.instructions.map((item) => item.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("re-evaluates structural if flow after observeOrAsk() re-walks the current SEG", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  if (ready === true) {
    \`before\`;
  }

  if (true) {
    observeOrAsk(ready);
  }

  if (ready === true) {
    \`after\`;
  }
}
`);
    const runtime = new Runtime().add("observe-branch-rewalk-arc", document);
    const seeded = runtime.newTraversal(
      arc("observe-branch-rewalk-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);
    expect(brief.observations).toHaveLength(1);

    const next = progressBrief(runtime, brief, {
      move: "proceed",
      observations: {
        [brief.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(next.instructions.map((item) => item.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("re-walks from the top after enter() resolves normally", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const verdict = new Boolean();

  if (verdict === true) {
    \`before\`;
  }

  enter(Child, {
    returns: { verdict },
  });

  if (verdict === true) {
    \`after\`;
  }

  function Child({ returns }) {
    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("enter-rewalk-arc", document);
    const seeded = runtime.newTraversal(arc("enter-rewalk-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], EMPTY_DIALOG);

    expect(brief.instructions.map((item) => item.text)).toEqual([
      "before",
      "after",
    ]);
    expect(rootTraversal(brief).variables.verdict).toBe(true);
  });

  it("keeps child internal resolution insulated from the caller enter()", () => {
    const document = parse(`
"use arc v2";

function Main() {
  enter(Child);
  \`after\`;

  function Child() {
    const ready = new Boolean({
      observing: \`is \${user} ready\`,
    });
    observeOrAsk(ready);
    \`child done\`;
  }
}
`);
    const runtime = new Runtime().add("enter-insulation-arc", document);
    const seeded = runtime.newTraversal(arc("enter-insulation-arc", "Main"));
    seeded.phase = "entered";

    const first = runtime.start([seeded], EMPTY_DIALOG);
    expect(first.active).toEqual(node("enter-insulation-arc", "Main.Child"));
    expect(first.observations).toHaveLength(1);

    const second = progressBrief(runtime, first, {
      move: "proceed",
      observations: {
        [first.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(second.instructions.map((item) => item.text)).toEqual([
      "child done",
    ]);
    expect(second.active).toEqual(node("enter-insulation-arc", "Main.Child"));

    const third = progressBrief(runtime, second, { move: "proceed" });
    expect(third.instructions.map((item) => item.text)).toEqual(["after"]);
    expect(third.active).toEqual(node("enter-insulation-arc", "Main"));
  });

  it("re-walks the caller SEG only after enter() resolves, even when the child captures caller variables", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  if (ready === true) {
    \`before\`;
  }

  enter(Child);
  \`after\`;

  function Child() {
    observeOrAsk(ready);
    \`child done\`;
  }
}
`);
    const runtime = new Runtime().add("enter-capture-seg-arc", document);
    const seeded = runtime.newTraversal(arc("enter-capture-seg-arc", "Main"));
    seeded.phase = "entered";

    const first = runtime.start([seeded], EMPTY_DIALOG);
    expect(first.active).toEqual(node("enter-capture-seg-arc", "Main.Child"));
    expect(first.observations).toHaveLength(1);

    const second = progressBrief(runtime, first, {
      move: "proceed",
      observations: {
        [first.observations[0]!.id]: {
          status: "resolved",
          value: true,
        },
      },
    });

    expect(rootTraversal(second).variables.ready).toBe(true);
    expect(second.instructions.map((item) => item.text)).toEqual([
      "child done",
      "before",
    ]);
    expect(second.active).toEqual(node("enter-capture-seg-arc", "Main"));

    const third = progressBrief(runtime, second, { move: "proceed" });

    expect(third.instructions.map((item) => item.text)).toEqual(["after"]);
    expect(third.active).toEqual(node("enter-capture-seg-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("enter-channels-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("enter-args-action-arc", "Main"));
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
    const seeded = runtime.newTraversal(
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
    const seeded = runtime.newTraversal(arc("enter-channels-skip-arc", "Main"));
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
    const seeded = runtime.newTraversal(
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

  it("keeps enterLoop() returns transactional until the whole loop resolves", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const stop = new Boolean({
    observing: \`should the loop stop\`,
  });
  const verdict = new Boolean();

  enterLoop(fresh(Child), {
    resolveWhen: () => {
      observe(stop);
      return stop === true;
    },
    returns: { verdict },
  });

  \`after\`;

  function Child({ returns }) {
    instruct(\`child step\`, {
      deflectWhen: \`\${user} wants to switch topics\`,
    });

    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("enter-loop-transaction-arc", document);
    const seeded = runtime.newTraversal(
      arc("enter-loop-transaction-arc", "Main"),
    );
    seeded.phase = "entered";

    const first = runtime.start([seeded], EMPTY_DIALOG);
    expect(first.instructions.map((item) => item.text)).toEqual(["child step"]);

    const waitingForStop = progressBrief(runtime, first, {
      move: "proceed",
      judgments: {
        [first.judgments[0]!.id]: false,
      },
    });
    expect(waitingForStop.observations).toHaveLength(1);
    expect(rootTraversal(waitingForStop).variables.verdict).toBeUndefined();

    const secondIteration = progressBrief(runtime, waitingForStop, {
      move: "proceed",
      observations: {
        [waitingForStop.observations[0]!.id]: {
          status: "resolved",
          value: false,
        },
      },
    });
    expect(secondIteration.instructions.map((item) => item.text)).toEqual([
      "child step",
    ]);
    expect(rootTraversal(secondIteration).variables.verdict).toBeUndefined();

    const secondResolution = progressBrief(runtime, secondIteration, {
      move: "proceed",
    });
    expect(secondResolution.judgments).toHaveLength(1);

    const afterDeflect = progressBrief(runtime, secondResolution, {
      move: "proceed",
      judgments: {
        [secondResolution.judgments[0]!.id]: true,
      },
    });
    expect(rootTraversal(afterDeflect).variables.verdict).toBeUndefined();
    expect(rootTraversal(afterDeflect).phase).toBe("suspended");
  });

  it("commits transactional enterLoop() returns only on whole-loop resolution", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const verdict = new Boolean();
  const stop = new Boolean();
  stop.set(true);

  enterLoop(fresh(Child), {
    resolveWhen: () => {
      return stop === true;
    },
    returns: { verdict },
  });

  \`after\`;

  function Child({ returns }) {
    instruct(\`child step\`);

    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
`);
    const runtime = new Runtime().add("enter-loop-commit-arc", document);
    const seeded = runtime.newTraversal(arc("enter-loop-commit-arc", "Main"));
    seeded.phase = "entered";

    const first = runtime.start([seeded], EMPTY_DIALOG);
    const resolved = progressBrief(runtime, first, {
      move: "proceed",
    });

    expect(rootTraversal(resolved).variables.verdict).toBe(true);
    expect(resolved.instructions.map((item) => item.text)).toEqual(["after"]);
  });

  it("poisons traversal at runtime when args channel keys are not wired by enter()", () => {
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
    const seeded = runtime.newTraversal(arc("enter-missing-args-arc", "Main"));
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(rootTraversal(brief).phase).toBe("poisoned");
    expect(brief.canProgress).toBe(false);
    expect(brief.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
      }),
    ]);
  });

  it("poisons traversal when args channel keys are read in normal action flow but not wired", () => {
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
    const seeded = runtime.newTraversal(
      arc("enter-missing-args-action-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(rootTraversal(brief).phase).toBe("poisoned");
    expect(brief.canProgress).toBe(false);
    expect(brief.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
      }),
    ]);
  });

  it("poisons traversal when returns channel keys are not wired by enter()", () => {
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
    const seeded = runtime.newTraversal(
      arc("enter-missing-returns-arc", "Main"),
    );
    seeded.phase = "entered";

    const brief = runtime.start([seeded], { lastTurns: [] });
    expect(rootTraversal(brief).phase).toBe("poisoned");
    expect(brief.canProgress).toBe(false);
    expect(brief.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
      }),
    ]);
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
    const seeded = runtime.newTraversal(arc("regex-arc", "Main"));
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
    const seeded = runtime.newTraversal(arc("dialog-arc", "Main"));
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

  it("re-evaluates triggers against the latest dialog passed to progressTrigger", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.trigger = () => {
    if (judge(\`the user wants to start\`)) {
      return /later/i.test(Dialog.lastUserMessage);
    }
    return false;
  };
}
`);
    const runtime = new Runtime().add("trigger-dialog-arc", document);
    const firstDialog: Dialog = {
      lastTurns: [{ role: "user", message: "hello" }],
    };
    const secondDialog: Dialog = {
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
