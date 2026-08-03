/**
 * Behavior tests for the Composition area (`compose.*` entries in
 * specs/testing.md).
 *
 * Ported from `parser.test.ts` and `runtime.test.ts` per the coverage
 * manifest. Every case feeds a deterministic Arc source string and injects
 * semantic results through reports, so there is no nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type { EnterNodeAction } from "../src/types.js";
import {
  arc,
  EMPTY_DIALOG,
  ephemeralChild,
  node,
  ownedChild,
  progressBrief,
  rootTraversal,
  singleObservations,
  startRun,
  withExperimentalRewalk,
} from "./helpers.js";

describe("composition", () => {
  describe("compose.children", () => {
    it("allows nested children to read outer cells lexically", () => {
      const document = parse(`
"arc";

function Outer() {
  let a = Bool();
  a.$set(true);
  $enter(Inner);

  function Inner() {
    if (a == true) {
      $instruct(\`inner sees outer\`);    }
  }
}
`);
      const runtime = new Runtime().add("outer-arc", document);
      const seeded = runtime.newTraversal(arc("outer-arc", "Outer"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "inner sees outer",
      ]);
      expect(rootTraversal(brief).cells.a).toBe(true);
      expect(
        ownedChild(rootTraversal(brief), "Outer.Inner")?.state,
      ).toBeUndefined();
    });

    it("attaches lexically owned sibling children to the lexical owner, not the immediate caller", () => {
      const document = parse(`
"arc";

function A() {
  $enter(B);

  function B() {
    $enter(C);
  }

  function C() {
    let ready = Bool();
    ready.observing = \`is \${user} ready\`;
    $observeOrAsk(ready);
  }
}
`);
      const runtime = new Runtime().add("owner-arc", document);
      const seeded = runtime.newTraversal(arc("owner-arc", "A"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.active).toEqual(node("owner-arc", "A.C"));

      const root = rootTraversal(brief);
      const b = ownedChild(root, "A.B");
      const c = ownedChild(root, "A.C");

      expect(b).toBeDefined();
      expect(c).toBeDefined();
      expect(b?.ownedChildren).toEqual([]);
      expect(c?.ref).toEqual(node("owner-arc", "A.C"));
    });
  });

  describe("compose.imports", () => {
    it("resolves imported arcs by source first, then root identifier", () => {
      const main = parse(`
"arc";

import { AnotherArc as IntroArc } from "another-arc";

function Main() {
  $enter(IntroArc);
}
`);
      const expected = parse(`
"arc";

function AnotherArc() {
  $instruct(\`expected\`);}
`);
      const wrong = parse(`
"arc";

function AnotherArc() {
  $instruct(\`wrong\`);}
`);

      const runtime = new Runtime()
        .add("main-arc", main)
        .add("another-arc", expected)
        .add("wrong-arc", wrong);

      const seeded = runtime.newTraversal(arc("main-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

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

    it("reads an imported arc's state and keeps its scope isolated from the caller", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  let topic = Str();
  topic.$set("main-topic");
  $enter(Intro);
  if (Intro.state == State.COVERED) {
    $instruct(\`import covered\`);
  }
}
`);
      const intro = parse(`
"arc";

function Intro() {
  let topic = Str();
  topic.$set("intro-topic");
  $instruct(\`intro\`);
}
`);
      const runtime = new Runtime()
        .add("import-state-arc", main)
        .add("intro-arc", intro);
      const seeded = runtime.newTraversal(arc("import-state-arc", "Main"));
      seeded.phase = "entered";

      const firstBrief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
      ]);

      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
      });
      expect(secondBrief.instructions.map((item) => item.text)).toEqual([
        "import covered",
      ]);
      expect(rootTraversal(secondBrief).cells.topic).toBe("main-topic");
      const imported = secondBrief.traversals.find(
        (traversal) => traversal.ref === arc("intro-arc", "Intro"),
      );
      expect(imported?.cells.topic).toBe("intro-topic");
    });

    it("an imported arc's completion bubbles back to the caller enter", () => {
      const main = parse(`
"arc";

import { Topic } from "topic-arc";

function Main() {
  $enter(Topic);
  $instruct(\`main tail\`);
}
`);
      const topic = parse(`
"arc";

function Topic() {
  let t = Enum(["unknown", "metal"]);
  t.observing = \`what topic\`;
  $observeOrAsk(t);
  $instruct(\`topic done\`);
}
`);
      const runtime = new Runtime()
        .add("main-arc", main)
        .add("topic-arc", topic);
      const seeded = runtime.newTraversal(arc("main-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.observations).toHaveLength(1);
      expect(first.active).toEqual(node("topic-arc", "Topic"));

      const atTopicDone = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "metal" },
        },
      });
      expect(atTopicDone.instructions.map((item) => item.text)).toEqual([
        "topic done",
      ]);

      const atMain = progressBrief(runtime, atTopicDone, { move: "proceed" });
      expect(atMain.instructions.map((item) => item.text)).toEqual([
        "main tail",
      ]);
      expect(atMain.active).toEqual(node("main-arc", "Main"));
    });

    it("an imported arc deflection propagates to the caller catchDeflection", () => {
      const main = parse(`
"arc";

import { Topic } from "topic-arc";

function Main() {
  let recovered = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Topic)) {
      recovered.$set(true);
      return true;
    }
    return false;
  };

  if (recovered == true) {
    $instruct(\`recovered\`);
  }

  $enter(Topic);
}
`);
      const topic = parse(`
"arc";

function Topic() {
  let t = Enum(["unknown", "metal"]);
  t.observing = \`what topic\`;
  $observeOrAsk(t);
}
`);
      const runtime = new Runtime()
        .add("main-deflect-arc", main)
        .add("topic-arc", topic);
      const seeded = runtime.newTraversal(arc("main-deflect-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("topic-arc", "Topic"));

      const caught = progressBrief(runtime, first, { move: "deflect" });
      expect(caught.instructions.map((item) => item.text)).toEqual([
        "recovered",
      ]);
      expect(rootTraversal(caught).cells.recovered).toBe(true);
    });
  });

  describe("compose.node-state", () => {
    it("reflects a forgetful canonical entry's new terminal state through Child.state", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $enter(forgetful(Child));

  if (Child.state == State.SKIPPED) {
    $instruct(\`forgetful entry skipped\`);  }

  function Child() {
    let shouldSkip = Bool();

    this.guard = () => {
      if (shouldSkip == true) {
        return State.SKIPPED;
      }
    };

    this.effects = () => {
      shouldSkip.$set(true);
    };

    $instruct(\`child body\`);  }
}
`);
      const runtime = new Runtime().add("forgetful-state-arc", document);
      const traversal = runtime.newTraversal(
        arc("forgetful-state-arc", "Main"),
      );
      traversal.phase = "entered";

      const firstBrief = startRun(runtime, [traversal], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "child body",
      ]);

      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
      });
      expect(secondBrief.instructions.map((item) => item.text)).toEqual([
        "forgetful entry skipped",
      ]);
      expect(ownedChild(rootTraversal(secondBrief), "Main.Child")?.state).toBe(
        "skipped",
      );
    });

    it("covering a child re-walks a caller branch gated on its node state", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  if (Child.state == State.COVERED) {
    $enter(AnotherChild);
  }
  $enter(Child);

  function Child() {
    let done = Bool();
    done.$set(true);
  }

  function AnotherChild() {
    $instruct(\`another\`);
  }
}
`),
        "Main",
      );
      const runtime = new Runtime().add("n5-arc", document);
      const seeded = runtime.newTraversal(arc("n5-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      // Child covers synchronously; the wide enter snapshot sees Child.state change
      // undefined -> covered, so the caller re-walks and the gated enter runs.
      expect(brief.instructions.map((item) => item.text)).toEqual(["another"]);
      expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
        "covered",
      );
    });

    it("rejects unknown node references in state expressions", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  if (Missing.state == State.COVERED) {
    $instruct(\`nope\`);  }
}
`),
      ).toThrow(/UNDEFINED_NODE/);
    });
  });

  describe("compose.enter", () => {
    it.each([
      "$enter(Worker)",
      "$enterLoop(Worker, { resolveWhen: `done` })",
      "$enter(forgetful(Worker))",
      "$enter(newcopy(Worker))",
    ])("rejects %s that re-enters the enclosing node", (call) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Worker);

  function Worker() {
    ${call};
    $instruct(\`work\`);
  }
}
`),
      ).toThrow(/cannot re-enter the enclosing node/);
    });

    it("rejects self-entry uniformly at a root arc", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Main);
  $instruct(\`root\`);
}
`),
      ).toThrow(/cannot re-enter the enclosing node/);
    });

    it("commits returns channel values when an entered child reaches COVERED", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  let verdict = Bool();

  ready.$set(true);
  $enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child(args = { ready: Bool() }, returns = { verdict: Bool() }) {
    this.effects = () => {
      if (args.ready == true) {
        returns.verdict.$set(true);
      }
    };
  }
}
`);
      const runtime = new Runtime().add("enter-channels-arc", document);
      const seeded = runtime.newTraversal(arc("enter-channels-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(rootTraversal(brief).cells.verdict).toBe(true);
      expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
        "covered",
      );
      expect(rootTraversal(brief).phase).toBe("completed");
    });

    it("does not force a forgetful entry of a covered imported arc on plain enter", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(Intro);
  $enter(Intro);
  $instruct(\`done\`);}
`);
      const intro = parse(`
"arc";

function Intro() {
  $instruct(\`intro\`);}
`);
      const runtime = new Runtime()
        .add("main-arc", main)
        .add("intro-arc", intro);
      const seeded = runtime.newTraversal(arc("main-arc", "Main"));
      seeded.phase = "entered";

      const firstBrief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
      ]);

      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
      });
      expect(secondBrief.instructions.map((item) => item.text)).toEqual([
        "done",
      ]);
      expect(
        secondBrief.traversals.find(
          (traversal) => traversal.ref === arc("intro-arc", "Intro"),
        )?.enterCount,
      ).toBe(1);
    });

    it("commits a reported observation after re-deriving a covered child", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Work);
  $enter(forgetful(Work));
  $instruct(\`done\`);

  function Work() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;

    $enter(Inner);
    $observe(topic);

    function Inner() {
      $instruct(\`inner intro\`);
    }
  }
}
`);
      // The forgetful entry clears Work's frame, so its first walk re-reaches
      // $enter(Inner) while Inner is still covered. Re-deriving the covered child
      // must not latch a transition, or the interposing transition brief
      // swallows the observation report and the host loops forever:
      // observation, answer eaten, transition, re-ask.
      const runtime = new Runtime().add("rederive-commit-arc", document);
      const seeded = runtime.newTraversal(arc("rederive-commit-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual([
        "inner intro",
      ]);
      const observing = progressBrief(runtime, first, { move: "proceed" });
      expect(singleObservations(observing).map((item) => item.cell)).toEqual([
        "topic",
      ]);

      const forgetfulEntryBrief = progressBrief(runtime, observing, {
        move: "proceed",
        observations: {
          [observing.observations[0]!.id]: {
            status: "resolved",
            value: "metal",
          },
        },
      });
      expect(
        singleObservations(forgetfulEntryBrief).map((item) => item.cell),
      ).toEqual(["topic"]);
      expect(singleObservations(forgetfulEntryBrief)[0]!.currentValue).toBe(
        "metal",
      );
      expect(forgetfulEntryBrief.instructions).toEqual([]);

      const done = progressBrief(runtime, forgetfulEntryBrief, {
        move: "proceed",
        observations: {
          [forgetfulEntryBrief.observations[0]!.id]: {
            status: "resolved",
            value: "metal",
          },
        },
      });
      expect(done.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("resolves a second enter site targeting an already-covered child without a transition", () => {
      const document = parse(`
"arc";

function Main() {
  let go = Bool();
  go.observing = \`should main revisit\`;

  $enter(Child);
  $observe(go);
  if (go == true) {
    $enter(Child);
    $instruct(\`after revisit\`);
  }

  function Child() {
    $instruct(\`child intro\`);
  }
}
`);
      // The re-walk after go flips true reaches the second $enter(Child) while
      // Child is already covered. Re-deriving the covered child is not an entry
      // — Child never runs — so no transition may ride the answer's brief.
      // Driven with raw progress: the shared drivers acknowledge transitions
      // silently and would hide a spurious one.
      const runtime = new Runtime().add("second-site-covered-arc", document);
      const seeded = runtime.newTraversal(
        arc("second-site-covered-arc", "Main"),
      );
      seeded.phase = "entered";

      const entry = runtime.start([seeded], EMPTY_DIALOG);
      expect(entry.transition).toBeDefined();
      const intro = runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG);
      expect(intro.instructions.map((item) => item.text)).toEqual([
        "child intro",
      ]);
      const exit = runtime.progress(intro, { move: "proceed" }, EMPTY_DIALOG);
      expect(exit.transition).toBeDefined();
      const observing = runtime.progress(
        exit,
        { move: "proceed" },
        EMPTY_DIALOG,
      );
      expect(singleObservations(observing).map((item) => item.cell)).toEqual([
        "go",
      ]);

      const revisited = runtime.progress(
        observing,
        {
          move: "proceed",
          observations: {
            [observing.observations[0]!.id]: {
              status: "resolved",
              value: true,
            },
          },
        },
        EMPTY_DIALOG,
      );

      expect(revisited.transition).toBeUndefined();
      expect(revisited.instructions.map((item) => item.text)).toEqual([
        "after revisit",
      ]);
      expect(ownedChild(rootTraversal(revisited), "Main.Child")?.state).toBe(
        "covered",
      );
      expect(
        ownedChild(rootTraversal(revisited), "Main.Child")?.enterCount,
      ).toBe(1);
    });
  });

  describe("compose.enter-loop", () => {
    it("requires resolveWhen for $enterLoop()", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $enterLoop(Child, {});

  function Child() {}
}
`),
      ).toThrow(/enterLoop\(\) requires resolveWhen/);
    });

    it("keeps $enterLoop() returns transactional until the whole loop resolves", () => {
      const document = parse(`
"arc";

function Main() {
  let stop = Bool({
    observing: \`should the loop stop\`,
  });
  let verdict = Bool();

  $enterLoop(newcopy(Child), {
    resolveWhen: () => {
      $observe(stop);
      return stop == true;
    },
    returns: { verdict },
  });

  $instruct(\`after\`);
  function Child(returns = { verdict: Bool() }) {
    $instruct(\`child step\`, {
      deflectWhen: \`\${user} wants to switch topics\`,
    });

    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-loop-transaction-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-loop-transaction-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual([
        "child step",
      ]);

      const waitingForStop = progressBrief(runtime, first, {
        move: "proceed",
        judgments: {
          [first.judgments[0]!.id]: false,
        },
      });
      expect(waitingForStop.observations).toHaveLength(1);
      expect(rootTraversal(waitingForStop).cells.verdict).toBeUndefined();

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
      expect(rootTraversal(secondIteration).cells.verdict).toBeUndefined();

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
      expect(rootTraversal(afterDeflect).cells.verdict).toBeUndefined();
      expect(rootTraversal(afterDeflect).phase).toBe("suspended");
    });

    it("commits transactional $enterLoop() returns only on whole-loop resolution", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();
  let stop = Bool();
  stop.$set(true);

  $enterLoop(newcopy(Child), {
    resolveWhen: () => {
      return stop == true;
    },
    returns: { verdict },
  });

  $instruct(\`after\`);
  function Child(returns = { verdict: Bool() }) {
    $instruct(\`child step\`);

    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-loop-commit-arc", document);
      const seeded = runtime.newTraversal(arc("enter-loop-commit-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const resolved = progressBrief(runtime, first, {
        move: "proceed",
      });

      expect(rootTraversal(resolved).cells.verdict).toBe(true);
      expect(resolved.instructions.map((item) => item.text)).toEqual(["after"]);
    });
  });

  describe("compose.target-shapes", () => {
    it.each(["forgetful", "newcopy"])(
      "rejects invalid %s wrapper arity and arguments",
      (wrapper) => {
        const source = (target: string) => `
"arc";
function Main() {
  $enter(${target});
  function Child() {}
}
`;

        expect(() => parse(source(`${wrapper}()`))).toThrow(
          new RegExp(`${wrapper}\\(\\) accepts exactly one`),
        );
        expect(() => parse(source(`${wrapper}(Child, Child)`))).toThrow(
          new RegExp(`${wrapper}\\(\\) accepts exactly one`),
        );
        expect(() => parse(source(`${wrapper}("Child")`))).toThrow(
          new RegExp(
            `${wrapper}\\(\\) requires a node or imported arc identifier`,
          ),
        );
      },
    );
  });

  describe("compose.newcopy", () => {
    it("parses newcopy targets and synthesizes aliases for anonymous copies", () => {
      const document = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(newcopy(Child));
  $enterLoop(newcopy(Intro), {
    resolveWhen: () => {
      return true;
    },
  });

  function Child() {
    $instruct(\`child\`);  }
}
`);

      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "Child", imported: false, mode: "newcopy" },
      });
      expect(root.statements[1]).toMatchObject({
        kind: "enter-loop",
        target: { identifier: "Intro", imported: true, mode: "newcopy" },
      });
      expect(root.newcopyAliases).toEqual([
        { identifier: "Child#body/0", target: "Child", imported: false },
        { identifier: "Intro#body/1", target: "Intro", imported: true },
      ]);
    });

    it("stores newcopy owned children as anonymous copies in ephemeralChildren", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(newcopy(Child));

  function Child() {
    let ready = Bool();
    $observeOrAsk(ready);
  }
}
`);
      const runtime = new Runtime().add("newcopy-owned-arc", document);
      const traversal = runtime.newTraversal(arc("newcopy-owned-arc", "Main"));
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(brief.active).toEqual(
        node("newcopy-owned-arc", "Main.Child#body/0"),
      );
      expect(rootTraversal(brief).ownedChildren).toHaveLength(0);
      const child = ephemeralChild(rootTraversal(brief), "Main.Child#body/0");
      expect(child?.ref).toEqual(
        node("newcopy-owned-arc", "Main.Child#body/0"),
      );
    });

    it("stores newcopy imported arcs as anonymous copies instead of root traversals", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(newcopy(Intro));
}
`);
      const intro = parse(`
"arc";

function Intro() {
  let topic = Bool();
  $observeOrAsk(topic);
}
`);
      const runtime = new Runtime()
        .add("main-arc", main)
        .add("intro-arc", intro);
      const traversal = runtime.newTraversal(arc("main-arc", "Main"));
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(brief.active).toEqual(node("main-arc", "Main.Intro#body/0"));
      expect(brief.traversals).toHaveLength(1);
      expect(rootTraversal(brief).refChildren).toEqual([]);
      const child = ephemeralChild(rootTraversal(brief), "Main.Intro#body/0");
      expect(child?.ref).toEqual(node("main-arc", "Main.Intro#body/0"));
    });

    it("walks nested owned and anonymous-copy traversals with synthetic refs", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(newcopy(B));

  function B() {
    $enter(C);

    function C() {
      $enter(newcopy(D));

      function D() {
        let ready = Bool();
        $observeOrAsk(ready);
      }
    }
  }
}
`);
      const runtime = new Runtime().add("nested-newcopy-arc", document);
      const traversal = runtime.newTraversal(arc("nested-newcopy-arc", "Main"));
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(brief.active).toEqual(
        node("nested-newcopy-arc", "Main.B#body/0.C.D#body/0"),
      );
      const b = ephemeralChild(rootTraversal(brief), "Main.B#body/0");
      expect(b?.ref).toEqual(node("nested-newcopy-arc", "Main.B#body/0"));
      const c = b ? ownedChild(b, "Main.B#body/0.C") : undefined;
      expect(c?.ref).toEqual(node("nested-newcopy-arc", "Main.B#body/0.C"));
      const d = c ? ephemeralChild(c, "Main.B#body/0.C.D#body/0") : undefined;
      expect(d?.ref).toEqual(
        node("nested-newcopy-arc", "Main.B#body/0.C.D#body/0"),
      );
    });

    it("goes past $enter(newcopy(...)) after the newcopy child resolves", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(newcopy(Child));
  $instruct(\`done\`);
  function Child() {
    let ready = Bool();
    $observeOrAsk(ready);
  }
}
`);
      const runtime = new Runtime().add("newcopy-resolution-arc", document);
      const traversal = runtime.newTraversal(
        arc("newcopy-resolution-arc", "Main"),
      );
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);
      expect(brief.active).toEqual(
        node("newcopy-resolution-arc", "Main.Child#body/0"),
      );
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

      expect(next.active).toEqual(node("newcopy-resolution-arc", "Main"));
      expect(next.instructions).toHaveLength(1);
      const child = ephemeralChild(rootTraversal(next), "Main.Child#body/0");
      expect(child?.state).toBe("covered");
    });

    it("replaces a completed newcopy target with a blank anonymous copy", () => {
      // Mirror image of the forgetful-entry case: a `newcopy` target re-entered at the same
      // site after the prior iteration covered is replaced by a blank anonymous
      // traversal — cleared frame AND reset cells. The `seen`-gated instruct
      // never fires across iterations, where forgetful (which preserves `seen`) makes
      // it fire. Pins the same-site re-fire-is-stateless invariant that the newcopy
      // anonymous-copy machinery (replacing a terminal
      // traversal) provides.
      const document = parse(`
"arc";

function Main() {
  let stop = Bool({ observing: \`should the loop stop\` });
  $enterLoop(newcopy(Child), {
    resolveWhen: () => {
      $observe(stop);
      return stop == true;
    },
  });
  $instruct(\`done\`);
  function Child() {
    let seen = Bool();
    $instruct(\`intro\`);
    if (seen == true) {
      $instruct(\`again\`);
    }
    this.effects = () => {
      seen.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("newcopy-reentry-arc", document);
      const seeded = runtime.newTraversal(arc("newcopy-reentry-arc", "Main"));
      seeded.phase = "entered";

      // Iteration 1: newcopy Child, `seen` unset -> only "intro".
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["intro"]);

      // Child covers (effects set `seen` on the ephemeral); the loop asks `stop`.
      const askStop1 = progressBrief(runtime, first, { move: "proceed" });
      expect(askStop1.observations).toHaveLength(1);

      // resolveWhen false -> iteration 2 replaces the covered Child with a newcopy
      // one, so `seen` is unset again and "again" does NOT fire.
      const second = progressBrief(runtime, askStop1, {
        move: "proceed",
        observations: {
          [askStop1.observations[0]!.id]: { status: "resolved", value: false },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual(["intro"]);

      // Stop the loop and fall through to the tail.
      const askStop2 = progressBrief(runtime, second, { move: "proceed" });
      const done = progressBrief(runtime, askStop2, {
        move: "proceed",
        observations: {
          [askStop2.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      expect(done.instructions.map((item) => item.text)).toEqual(["done"]);
    });
  });

  describe("compose.forgetful", () => {
    it("parses forgetful targets without synthesizing newcopy aliases", () => {
      const document = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(forgetful(Child));
  $enterLoop(forgetful(Intro), {
    resolveWhen: () => {
      return true;
    },
  });

  function Child() {
    $instruct(\`child\`);  }
}
`);

      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "enter-node",
        target: {
          identifier: "Child",
          imported: false,
          mode: "forgetful",
        },
      });
      expect(root.statements[1]).toMatchObject({
        kind: "enter-loop",
        target: {
          identifier: "Intro",
          imported: true,
          mode: "forgetful",
        },
      });
      expect(root.newcopyAliases).toEqual([]);
    });

    it("forces a forgetful entry of a covered canonical child with preserved cells", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $enter(forgetful(Child));
  $instruct(\`done\`);
  function Child() {
    let seen = Bool();
    $instruct(\`intro\`);
    if (seen == true) {
      $instruct(\`again\`);    }

    this.effects = () => {
      seen.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("forgetful-covered-arc", document);
      const traversal = runtime.newTraversal(
        arc("forgetful-covered-arc", "Main"),
      );
      traversal.phase = "entered";

      const firstBrief = startRun(runtime, [traversal], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
      ]);

      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
      });
      const child = ownedChild(rootTraversal(secondBrief), "Main.Child");
      expect(child?.enterCount).toBe(2);
      expect(child?.cells.seen).toBe(true);
      expect(secondBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
        "again",
      ]);
      const thirdBrief = progressBrief(runtime, secondBrief, {
        move: "proceed",
      });
      expect(thirdBrief.instructions.map((item) => item.text)).toEqual([
        "done",
      ]);
      expect(ownedChild(rootTraversal(thirdBrief), "Main.Child")?.state).toBe(
        "covered",
      );
    });

    it("forces a forgetful entry of a covered imported arc with preserved cells", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(Intro);
  $enter(forgetful(Intro));
  $instruct(\`done\`);
}
`);
      const intro = parse(`
"arc";

function Intro() {
  let seen = Bool();
  $instruct(\`intro\`);
  if (seen == true) {
    $instruct(\`again\`);
  }

  this.effects = () => {
    seen.$set(true);
  };
}
`);
      const runtime = new Runtime()
        .add("forgetful-import-arc", main)
        .add("intro-arc", intro);
      const seeded = runtime.newTraversal(arc("forgetful-import-arc", "Main"));
      seeded.phase = "entered";

      const firstBrief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
      ]);

      const secondBrief = progressBrief(runtime, firstBrief, {
        move: "proceed",
      });
      const imported = secondBrief.traversals.find(
        (traversal) => traversal.ref === arc("intro-arc", "Intro"),
      );
      expect(imported?.enterCount).toBe(2);
      expect(imported?.cells.seen).toBe(true);
      expect(secondBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
        "again",
      ]);

      const thirdBrief = progressBrief(runtime, secondBrief, {
        move: "proceed",
      });
      expect(thirdBrief.instructions.map((item) => item.text)).toEqual([
        "done",
      ]);
    });

    it("iterates enterLoop over a forgetful target with preserved child cells", () => {
      const document = parse(`
"arc";

function Main() {
  $enterLoop(forgetful(Child), {
    resolveWhen: \`covered enough\`,
  });
  $instruct(\`tail\`);

  function Child() {
    let seen = Bool();
    $instruct(\`intro\`);
    if (seen == true) {
      $instruct(\`again\`);
    }

    this.effects = () => {
      seen.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("loop-forgetful-arc", document);
      const seeded = runtime.newTraversal(arc("loop-forgetful-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["intro"]);

      // First iteration covers; the loop hook judges false, so a second
      // iteration starts a forgetful entry of the canonical child: `seen`
      // survives, and the frame resets.
      const afterFirst = progressBrief(runtime, first, { move: "proceed" });
      expect(afterFirst.judgments).toHaveLength(1);
      const second = progressBrief(runtime, afterFirst, {
        move: "proceed",
        judgments: { [afterFirst.judgments[0]!.id]: false },
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "intro",
        "again",
      ]);
      const child = ownedChild(rootTraversal(second), "Main.Child");
      expect(child?.enterCount).toBe(2);

      const afterSecond = progressBrief(runtime, second, { move: "proceed" });
      expect(afterSecond.judgments).toHaveLength(1);
      const resolved = progressBrief(runtime, afterSecond, {
        move: "proceed",
        judgments: { [afterSecond.judgments[0]!.id]: true },
      });
      expect(resolved.instructions.map((item) => item.text)).toEqual(["tail"]);
    });
  });

  describe("compose.args", () => {
    it("parses $enter() args/returns channel wiring with same-name bindings", () => {
      const document = parse(`
"arc";
function Main() {
  let ready = Bool();
  let verdict = Bool();

  $enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child(args = { ready: Bool() }, returns = { verdict: Bool() }) {
    this.effects = () => {
      if (args.ready == true) {
        returns.verdict.$set(true);
      }
    };
  }
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "Child", mode: "canonical" },
        args: { ready: { kind: "cell", cell: "ready" } },
        returns: { verdict: { kind: "cell", cell: "verdict" } },
      });
      const child = document.roots[0]?.children.find(
        (entry) => entry.identifier === "Child",
      );
      expect(child?.effects?.[0]).toMatchObject({ kind: "if" });
      if (child?.effects?.[0]?.kind !== "if") {
        throw new Error("expected child effects if statement");
      }
      expect(child.effects[0].test).toMatchObject({
        kind: "binary",
        left: { kind: "channel", namespace: "args", key: "ready" },
        right: { kind: "literal", value: true },
      });
      expect(child.effects[0].consequent[0]).toMatchObject({
        kind: "set-return",
        key: "verdict",
      });
    });

    it("parses $enter() renamed channel bindings decoupling caller cell names", () => {
      const document = parse(`
"arc";
function Main() {
  let ready = Bool();
  let finalVerdict = Bool();

  $enter(Child, {
    args: { go: ready },
    returns: { verdict: finalVerdict },
  });

  function Child(args = { go: Bool() }, returns = { verdict: Bool() }) {
    this.effects = () => {
      if (args.go == true) {
        returns.verdict.$set(true);
      }
    };
  }
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "Child", mode: "canonical" },
        args: { go: { kind: "cell", cell: "ready" } },
        returns: { verdict: { kind: "cell", cell: "finalVerdict" } },
      });
    });

    it("reads renamed and aliased args bindings from the caller cell", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(true);

  $enter(Child, {
    args: { ready, go: ready },
  });

  function Child(args = { ready: Bool(), go: Bool() }) {
    if (args.go == true) {
      $instruct(\`go branch\`);    }
    if (args.ready == true) {
      $instruct(\`ready branch\`);    }
  }
}
`);
      const runtime = new Runtime().add("enter-renamed-args-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-renamed-args-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "go branch",
        "ready branch",
      ]);
    });

    it("rejects $enter() channel bindings that reference unknown caller cells", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool();
  $enter(Child, {
    args: { ready },
    returns: { verdict },
  });
  function Child() {}
}
`),
      ).toThrow(/unknown caller cell: verdict/);
    });

    it("rejects spread and computed keys in $enter() channel objects", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let ready = Bool();
  $enter(Child, { args: { ...ready } });

  function Child() {}
}
`),
      ).toThrow(/does not support spread/);

      expect(() =>
        parse(`
"arc";

function Main() {
  let ready = Bool();
  $enter(Child, { args: { [ready]: ready } });

  function Child() {}
}
`),
      ).toThrow(/does not support computed keys/);
    });

    it("reads args.* in normal action flow for child branching", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(true);

  $enter(Child, {
    args: { ready },
  });

  function Child(args = { ready: Bool() }) {
    if (args.ready == true) {
      $instruct(\`ready branch\`);    } else {
      $instruct(\`fallback branch\`);    }
  }
}
`);
      const runtime = new Runtime().add("enter-args-action-arc", document);
      const seeded = runtime.newTraversal(arc("enter-args-action-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "ready branch",
      ]);
    });

    it("reads args.* in normal action flow for false branch", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(false);

  $enter(Child, {
    args: { ready },
  });

  function Child(args = { ready: Bool() }) {
    if (args.ready == true) {
      $instruct(\`ready branch\`);    } else {
      $instruct(\`fallback branch\`);    }
  }
}
`);
      const runtime = new Runtime().add(
        "enter-args-action-false-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("enter-args-action-false-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "fallback branch",
      ]);
    });

    it("poisons traversal at runtime when args channel keys are not wired by $enter()", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);

  function Child() {
    this.effects = () => {
      if (args.ready == true) {
      }
      if (args.ready == false) {
      }
    };
  }
}
`);
      const runtime = new Runtime().add("enter-missing-args-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-missing-args-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.canProgress).toBe(false);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unknown-channel-key",
          reason: expect.stringContaining('Unknown args channel key "ready"'),
        }),
      ]);
    });

    it("poisons traversal when args channel keys are read in normal action flow but not wired", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);

  function Child() {
    if (args.ready == true) {
      $instruct(\`ready\`);    }
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

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.canProgress).toBe(false);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unknown-channel-key",
          reason: expect.stringContaining('Unknown args channel key "ready"'),
        }),
      ]);
    });

    it("rejects reading an args channel into a cell of an incompatible type", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(args = { label: Str() }) {
    let n = RangedInt(0, 9);
    n.$set(args.label);
  }
}
`),
      ).toThrow(/CHANNEL_VALUE_TYPE/);
    });

    it("accepts reading an args channel into a compatible cell", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(args = { label: Str() }) {
    let copy = Str();
    copy.$set(args.label);
  }
}
`),
      ).not.toThrow();
    });
  });

  describe("compose.returns", () => {
    it("rejects returns.*.$set(...) outside this.effects", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let verdict = Bool();
  $enter(Child, { returns: { verdict } });
  function Child() {
    returns.verdict.$set(true);
  }
}
`),
      ).toThrow(/only allowed inside this\.effects/);
    });

    it("rejects returns.*.$set(...) outside this.effects even inside action control flow", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let verdict = Bool();
  $enter(Child, { returns: { verdict } });
  function Child() {
    if (true) {
      returns.verdict.$set(true);
    }
  }
}
`),
      ).toThrow(/only allowed inside this\.effects/);
    });

    it("commits a renamed returns binding into the bound caller cell", () => {
      const document = parse(`
"arc";

function Main() {
  let finalVerdict = Bool();

  $enter(Child, {
    returns: { verdict: finalVerdict },
  });

  function Child(returns = { verdict: Bool() }) {
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-renamed-returns-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-renamed-returns-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(rootTraversal(brief).cells.finalVerdict).toBe(true);
      expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
        "covered",
      );
    });

    it("rejects binding one caller cell to two returns keys", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let verdict = Bool();
  $enter(Child, { returns: { a: verdict, b: verdict } });
  function Child() {}
}
`),
      ).toThrow(/binds caller cell verdict more than once/);
    });

    it("surfaces duplicate returns caller cell bindings as a structured validation issue", () => {
      const document = parse(`
"arc";
function Main() {
  let verdict = Bool();
  $enter(Child, { returns: { verdict } });
  function Child() {}
}
`);
      const enterAction = document.roots[0]?.statements[0] as EnterNodeAction;
      enterAction.returns = {
        a: { kind: "cell", cell: "verdict" },
        b: { kind: "cell", cell: "verdict" },
      };

      const issues = validate(document);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: "ENTER_CHANNEL_DUPLICATE_CELL",
          message: "$enter().returns binds caller cell verdict more than once",
          loc: enterAction.loc,
        }),
      );
    });

    it("does not commit returns channel values when the child is SKIPPED", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();

  $enter(Child, {
    returns: { verdict },
  });

  function Child(returns = { verdict: Bool() }) {
    this.guard = () => {
      return State.SKIPPED;
    };
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-channels-skip-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-channels-skip-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(rootTraversal(brief).cells.verdict).toBeUndefined();
      expect(ownedChild(rootTraversal(brief), "Main.Child")?.state).toBe(
        "skipped",
      );
    });

    it("does not commit returns channel values when the child is DEFLECTED", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();
  $enter(Child, { returns: { verdict } });

  function Child(returns = { verdict: Bool() }) {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      returns.verdict.$set(true);
    };

    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("enter-channels-deflect-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-channels-deflect-arc", "Main"),
      );
      seeded.phase = "entered";
      const firstBrief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const afterDeflect = progressBrief(runtime, firstBrief, {
        move: "deflect",
      });

      expect(rootTraversal(afterDeflect).cells.verdict).toBeUndefined();
      expect(ownedChild(rootTraversal(afterDeflect), "Main.Child")?.state).toBe(
        "deflected",
      );
      expect(rootTraversal(afterDeflect).phase).toBe("suspended");
    });

    it("leaves caller cells unchanged for wired return keys the child never set", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();
  let note = Str();
  verdict.$set(false);
  note.$set("untouched");
  $enter(Child, {
    returns: { verdict, note },
  });
  $instruct(\`tail\`);

  function Child(returns = { verdict: Bool(), note: Str() }) {
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("partial-returns-arc", document);
      const seeded = runtime.newTraversal(arc("partial-returns-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(rootTraversal(brief).cells.verdict).toBe(true);
      expect(rootTraversal(brief).cells.note).toBe("untouched");
    });

    it("poisons traversal when returns channel keys are not wired by $enter()", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child, {
    returns: {},
  });

  function Child() {
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-missing-returns-arc", document);
      const seeded = runtime.newTraversal(
        arc("enter-missing-returns-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.canProgress).toBe(false);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unknown-channel-key",
          reason: expect.stringContaining(
            "returns.verdict.$set() targets an undeclared returns channel",
          ),
        }),
      ]);
    });

    it("rejects a returns.*.$set(...) value of an incompatible type", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let out = Str();
  $enter(Child, { returns: { out } });
  function Child(returns = { out: Str() }) {
    this.effects = () => {
      returns.out.$set(0);
    };
  }
}
`),
      ).toThrow(/CHANNEL_VALUE_TYPE/);
    });

    it("accepts a returns.*.$set(...) value of a compatible type", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let out = Str();
  $enter(Child, { returns: { out } });
  function Child(returns = { out: Str() }) {
    this.effects = () => {
      returns.out.$set("x");
    };
  }
}
`),
      ).not.toThrow();
    });
  });

  describe("compose.signature", () => {
    it("parses typed args/returns parameters into a node signature", () => {
      const document = parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(
    args = { input: Str(), idx: Index() },
    returns = { output: Str() },
  ) {
    this.effects = () => {
      returns.output.$set("fixed");
    };
  }
}
`);
      const op = document.roots[0]?.children.find(
        (entry) => entry.identifier === "Op",
      );
      expect(op?.signature).toEqual({
        args: { input: { type: "string" }, idx: { type: "index" } },
        returns: { output: { type: "string" } },
      });
    });

    it("rejects the old destructured parameter form", () => {
      expect(() =>
        parse(`"arc";\nfunction Main() { function Op({ args }) {} }`),
      ).toThrow(/Node parameters must be/);
    });

    it("rejects Index() as a cell declaration", () => {
      expect(() =>
        parse(`"arc";\nfunction Main() { let n = Index(); }`),
      ).toThrow(/Index\(\) is a channel-only type/);
    });
  });

  describe("compose.typed-binding", () => {
    it("rejects an incompatible binding", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Str();
  $enter(Op, { args: { flag: note } });
  function Op(args = { flag: Bool() }) {}
}
`),
      ).toThrow(/ENTER_CHANNEL_INCOMPATIBLE/);
    });

    it("rejects an undeclared channel key", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool();
  $enter(Op, { args: { missing: ready } });
  function Op(args = { ready: Bool() }) {}
}
`),
      ).toThrow(/UNDECLARED_ARGS_KEY/);
    });
  });

  describe("compose.unbound-channel", () => {
    it("reads a declared-unbound args channel as unset", () => {
      const document = parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(args = { ready: Bool() }) {
    if (args.ready.isUnset()) {
      $instruct(\`unbound\`);
    }
    if (args.ready == true) {
      $instruct(\`bound-true\`);
    }
  }
}
`);
      const runtime = new Runtime().add("unbound-args-arc", document);
      const seeded = runtime.newTraversal(arc("unbound-args-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["unbound"]);
      expect(rootTraversal(brief).phase).not.toBe("poisoned");
    });

    it("stages a declared-unbound return and commits nothing at resolution", () => {
      const document = parse(`
"arc";
function Main() {
  $enter(Op);
  $instruct(\`tail\`);
  function Op(returns = { output: Str() }) {
    this.effects = () => {
      returns.output.$set("private");
    };
  }
}
`);
      const runtime = new Runtime().add("unbound-returns-arc", document);
      const seeded = runtime.newTraversal(arc("unbound-returns-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).not.toBe("poisoned");
      expect(brief.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(ownedChild(rootTraversal(brief), "Main.Op")?.state).toBe(
        "covered",
      );
    });

    it("forwards a caller args projection into a child args channel", () => {
      const document = parse(`
"arc";
function Main() {
  let ready = Bool();
  ready.$set(true);
  $enter(Mid, { args: { ready } });
  function Mid(args = { ready: Bool() }) {
    $enter(Leaf, { args: { flag: args.ready } });
    function Leaf(args = { flag: Bool() }) {
      if (args.flag == true) {
        $instruct(\`leaf saw true\`);
      }
    }
  }
}
`);
      const runtime = new Runtime().add("args-projection-arc", document);
      const seeded = runtime.newTraversal(arc("args-projection-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "leaf saw true",
      ]);
    });

    it("carries a Dialog.Cursor through a typed returns channel", () => {
      const document = parse(`
"arc";
function Main() {
  let mark = Dialog.Cursor();
  $enter(Op, { returns: { at: mark } });
  function Op(returns = { at: Dialog.Cursor() }) {
    this.effects = () => {
      returns.at.$set(Dialog.cursor);
    };
  }
}
`);
      const runtime = new Runtime().add("cursor-returns-arc", document);
      const seeded = runtime.newTraversal(arc("cursor-returns-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 2, self: 1 },
        lastTurns: [],
      });

      expect(rootTraversal(brief).cells.mark).toMatchObject({
        user: 2,
        self: 1,
      });
    });

    it("rejects an incompatible imported-target binding at registration", () => {
      const caller = parse(`
"arc";
import { Op } from "op-arc";
function Main() {
  let note = Str();
  $enter(Op, { args: { flag: note } });
}
`);
      const opDoc = parse(`
"arc";
function Op(args = { flag: Bool() }) {}
`);
      const runtime = new Runtime().add("op-arc", opDoc);
      expect(() => runtime.add("caller-arc", caller)).toThrow(
        /ENTER_CHANNEL_INCOMPATIBLE/,
      );
    });

    it("rejects an incompatible imported binding regardless of registration order", () => {
      const caller = parse(`
"arc";
import { Op } from "op2-arc";
function Main() {
  let note = Str();
  $enter(Op, { args: { flag: note } });
}
`);
      const opDoc = parse(`
"arc";
function Op(args = { flag: Bool() }) {}
`);
      // Caller registered first (import unresolved), then the target arrives.
      const runtime = new Runtime().add("caller2-arc", caller);
      expect(() => runtime.add("op2-arc", opDoc)).toThrow(
        /ENTER_CHANNEL_INCOMPATIBLE/,
      );
      // The failed add left the runtime unchanged: a compatible target registers.
      const compatible = parse(`
"arc";
function Op(args = { flag: Str() }) {}
`);
      expect(() => runtime.add("op2-arc", compatible)).not.toThrow();
    });

    it("rejects a length read on a non-array channel", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(args = { flag: Bool() }) {
    let n = RangedInt(0, 9);
    n.$set(args.flag.length);
  }
}
`),
      ).toThrow(/LENGTH_NON_ARRAY/);
    });

    it("rejects a whole-array channel in a boolean position", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  $enter(Op);
  function Op(args = { items: Array(Str()) }) {
    let f = Bool();
    if (args.items && f) {
      f.$set(true);
    }
  }
}
`),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("rejects reserved names as channel keys", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { function Op(args = { length: Str() }) {} }`,
        ),
      ).toThrow(/reserved and cannot name a channel/);
    });

    it("resolves a binding cell innermost-first when a child shadows an ancestor", () => {
      // Ancestor `flag` is a Str(); the caller node's own `flag` shadows it as a
      // Bool(). Binding must validate against the innermost Bool(), matching
      // runtime resolution: a compatible Bool() binding is accepted and an
      // incompatible Str() write is rejected.
      const accepted = parse(`
"arc";
function Main() {
  let flag = Str();
  function Caller() {
    let flag = Bool();
    $enter(Op, { args: { in: flag } });
    function Op(args = { in: Bool() }) {}
  }
}
`);
      expect(accepted.roots[0]?.identifier).toBe("Main");

      expect(() =>
        parse(`
"arc";
function Main() {
  let flag = Str();
  function Caller() {
    let flag = Bool();
    $enter(Op, { args: { in: flag } });
    function Op(args = { in: Str() }) {}
  }
}
`),
      ).toThrow(/ENTER_CHANNEL_INCOMPATIBLE/);
    });

    it("resolves an imported binding cell innermost-first under shadowing", () => {
      const opDoc = parse(`
"arc";
function Op(returns = { out: Bool() }) {}
`);
      // Caller's own `flag` (Bool) shadows the ancestor `flag` (Str); binding it
      // to a Bool() returns channel is compatible and must register.
      const goodCaller = parse(`
"arc";
import { Op } from "shadow-op-arc";
function Main() {
  let flag = Str();
  function Caller() {
    let flag = Bool();
    $enter(Op, { returns: { out: flag } });
  }
}
`);
      const runtime = new Runtime().add("shadow-op-arc", opDoc);
      expect(() => runtime.add("good-caller-arc", goodCaller)).not.toThrow();

      // The ancestor Str() would pass against a Str() channel, but the innermost
      // Bool() must be used — so an incompatible Str() channel is rejected.
      const opStr = parse(`
"arc";
function Op(returns = { out: Str() }) {}
`);
      const badCaller = parse(`
"arc";
import { Op } from "shadow-op2-arc";
function Main() {
  let flag = Str();
  function Caller() {
    let flag = Bool();
    $enter(Op, { returns: { out: flag } });
  }
}
`);
      const runtime2 = new Runtime().add("shadow-op2-arc", opStr);
      expect(() => runtime2.add("bad-caller-arc", badCaller)).toThrow(
        /ENTER_CHANNEL_INCOMPATIBLE/,
      );
    });
  });
});
