/**
 * Behavioral tests for the Protocol `trans.*` entries: node transition briefs
 * — their shapes, coalescing, exclusivity, non-latching, and persistence.
 *
 * Transition tests drive `runtime.start` / `runtime.progress` directly: the
 * shared drivers in helpers.ts acknowledge transitions silently and would hide
 * the behavior under test.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import type { ArcTraversalSet, Dialog } from "../src/types/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  node,
  resolvedHostCalls,
  rootTraversal,
  TestRuntime as Runtime,
  startTrigger,
} from "./helpers.js";

describe("node transitions", () => {
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
    const runtime = new Runtime().add("transition-entry-arc", document).init();
    const seeded = runtime.newTraversal(arc("transition-entry-arc", "Main"));
    seeded.phase = "entered";
    return { runtime, seeded };
  }

  describe("trans.initializers", () => {
    const dialog = (message: string): Dialog => ({
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message }],
      view: message,
    });

    it.each(["owned", "imported", "newcopy", "forgetful"] as const)(
      "trans.initializers gates %s paths before evaluation and restores exactly once",
      (mode) => {
        const child = `
function Child(args = { prefix: Str() }) {
  let file = Artifact(\`\${args.prefix}/\${Dialog.lastUserMessage}.md\`);
  let copy = Artifact(\`copy/\${file}\`);
  this.guard = () => { if (judge("skip")) return State.SKIPPED; };
  $instruct(\`use \${file} and \${copy}\`);
}
`;
        const target =
          mode === "newcopy" || mode === "forgetful"
            ? `${mode}(Child)`
            : "Child";
        const source = `
"arc";
${mode === "imported" ? 'import { Child } from "initializer-child";' : ""}
function Main() {
  let prefix = Str();
  prefix.$set("notes");
  $enter(${target}, { args: { prefix } });
  ${mode === "imported" ? "" : child}
}
`;
        const makeRuntime = () => {
          const runtime = new Runtime().add("initializer-entry", parse(source));
          if (mode === "imported") {
            runtime.add("initializer-child", parse(`"arc"; ${child}`));
          }
          return runtime.init();
        };
        const runtime = makeRuntime();
        const entry = actionProgress(
          runtime.enterArc(arc("initializer-entry", "Main"), dialog("parent")),
        );
        expect(entry.transition).toBeDefined();
        expect(entry.judgments).toEqual([]);
        expect(entry.instructions).toEqual([]);
        const serialized = JSON.stringify(entry.traversals);
        expect(serialized).not.toContain("parent.md");

        const restoredRuntime = makeRuntime();
        const restored = actionProgress(
          restoredRuntime.start(
            JSON.parse(serialized) as ArcTraversalSet,
            dialog("restoring"),
          ),
        );
        expect(restored.transition).toEqual(entry.transition);
        expect(JSON.stringify(restored.traversals)).toBe(serialized);
        const rejected = actionProgress(
          restoredRuntime.progress(
            restored,
            { move: "deflect" },
            dialog("rejected"),
          ),
        );
        expect(rejected.issues[0]?.kind).toBe("invalid-report");
        expect(rejected.transition).toEqual(entry.transition);
        expect(JSON.stringify(rejected.traversals)).toBe(serialized);

        const guard = actionProgress(
          restoredRuntime.progress(
            rejected,
            { move: "proceed" },
            dialog("child"),
          ),
        );
        expect(guard.transition).toBeUndefined();
        expect(guard.judgments).toHaveLength(1);
        const finalRuntime = makeRuntime();
        const restoredGuard = actionProgress(
          finalRuntime.start(
            JSON.parse(JSON.stringify(guard.traversals)) as ArcTraversalSet,
            dialog("later"),
          ),
        );
        const work = actionProgress(
          finalRuntime.progress(
            restoredGuard,
            {
              move: "proceed",
              judgments: { [restoredGuard.judgments[0]!.id]: false },
            },
            dialog("later"),
          ),
        );
        expect(work.instructions[0]?.text).toEqual([
          { kind: "text", value: "use " },
          { kind: "artifact", path: "notes/child.md" },
          { kind: "text", value: " and " },
          { kind: "artifact", path: "copy/notes/child.md" },
        ]);
      },
    );

    it("trans.initializers splits an enter chain at an intermediate initializer", () => {
      const runtime = new Runtime()
        .add(
          "initializer-chain",
          parse(`
"arc";
function Main() {
  $enter(A);
  function A() {
    let file = Artifact(\`\${Dialog.lastUserMessage}.md\`);
    $enter(B);
    function B() { $instruct(\`use \${file}\`); }
  }
}
`),
        )
        .init();
      const entry = actionProgress(
        runtime.enterArc(arc("initializer-chain", "Main"), dialog("parent")),
      );
      expect(entry.transition?.entered).toEqual([
        node("initializer-chain", "Main.A"),
      ]);
      expect(entry.transition?.position).toBe(
        node("initializer-chain", "Main.A"),
      );
      const nested = actionProgress(
        runtime.progress(entry, { move: "proceed" }, dialog("a")),
      );
      expect(nested.transition?.entered).toEqual([
        node("initializer-chain", "Main.A.B"),
      ]);
      const work = actionProgress(
        runtime.progress(nested, { move: "proceed" }, dialog("b")),
      );
      expect(work.instructions[0]?.text).toEqual([
        { kind: "text", value: "use " },
        { kind: "artifact", path: "a.md" },
      ]);
    });

    it.each([
      { parent: "../invalid", child: "valid.md", outcome: "work" },
      { parent: "valid.md", child: "../invalid", outcome: "poisoned" },
    ])(
      "trans.initializers validates the acknowledged path with outcome $outcome",
      ({ parent, child, outcome }) => {
        const runtime = new Runtime()
          .add(
            "initializer-validation",
            parse(`
"arc";
function Main() {
  $enter(Child);
  function Child() {
    let file = Artifact(Dialog.lastUserMessage);
    $instruct(\`use \${file}\`);
  }
}
`),
          )
          .init();
        const entry = actionProgress(
          runtime.enterArc(
            arc("initializer-validation", "Main"),
            dialog(parent),
          ),
        );
        expect(entry.transition?.position).toBe(
          node("initializer-validation", "Main.Child"),
        );
        const next = runtime.progress(
          entry,
          { move: "proceed" },
          dialog(child),
        );
        if (outcome === "poisoned") {
          expect(next.canProgress).toBe(false);
          expect(next.issues[0]?.reasonCode).toBe("invalid-artifact-path");
        } else {
          expect(actionProgress(next).instructions[0]?.text).toEqual([
            { kind: "text", value: "use " },
            { kind: "artifact", path: "valid.md" },
          ]);
        }
      },
    );
  });

  describe("trans.shapes", () => {
    it("yields an exclusive entry transition carrying the position's host params", () => {
      const { runtime, seeded } = guardedChildRuntime();
      const brief = actionProgress(runtime.start([seeded], EMPTY_DIALOG));

      expect(brief.transition).toBeDefined();
      expect(brief.transition?.entered).toEqual([
        node("transition-entry-arc", "Main.Child"),
      ]);
      expect(brief.transition?.exited).toEqual([]);
      expect(brief.transition?.position).toBe(
        node("transition-entry-arc", "Main.Child"),
      );
      expect(brief.transition?.hostParams).toEqual({
        consumer: { id: "reviewer" },
      });
      expect(brief.canProgress).toBe(true);
      expect([...brief.allowedMoves].sort()).toEqual(["poison", "proceed"]);
      // Exclusivity: a transition brief carries no other work.
      expect(brief.judgments).toEqual([]);
      expect(brief.observations).toEqual([]);
      expect(brief.hostCalls).toEqual([]);
      expect(brief.hostCalls).toEqual([]);
      expect(brief.instructions).toEqual([]);
    });

    it("yields an exit transition before the caller evaluates under the new view", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  if (/later/.test(Dialog.lastUserMessage)) {
    $instruct(\`after later\`);  }

  function Child() {
    if (judge(\`is it ready\`)) {
      $instruct(\`ready\`);    }
  }
}
`);
      const runtime = new Runtime().add("transition-exit-arc", document).init();
      const seeded = runtime.newTraversal(arc("transition-exit-arc", "Main"));
      seeded.phase = "entered";

      const entry = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(entry.transition?.entered).toEqual([
        node("transition-exit-arc", "Main.Child"),
      ]);
      const judging = actionProgress(
        runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(judging.judgments).toHaveLength(1);

      // The judgment resolves false, the child covers, and its exit yields before
      // Main's dialog-gated branch evaluates.
      const exit = actionProgress(
        runtime.progress(
          judging,
          {
            move: "proceed",
            judgments: { [judging.judgments[0]!.id]: false },
          },
          EMPTY_DIALOG,
        ),
      );
      expect(exit.transition?.exited).toEqual([
        node("transition-exit-arc", "Main.Child"),
      ]);
      expect(exit.transition?.position).toBe(
        node("transition-exit-arc", "Main"),
      );

      // Main's branch condition evaluates against the acknowledging dialog.
      const after = actionProgress(
        runtime.progress(
          exit,
          { move: "proceed" },
          {
            cursor: { user: 1, self: 0 },
            lastTurns: [{ role: "user", message: "later please" }],
          },
        ),
      );
      expect(after.instructions.map((item) => item.text)).toEqual([
        "after later",
      ]);
    });
  });

  describe("trans.coalescing", () => {
    it("coalesces a guard-less enter chain into one multi-element transition", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(A);
  function A() {
    $enter(B);
    function B() {
      $instruct(\`b work\`);    }
  }
}
`);
      const runtime = new Runtime()
        .add("transition-chain-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("transition-chain-arc", "Main"));
      seeded.phase = "entered";

      const brief = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(brief.transition?.entered).toEqual([
        node("transition-chain-arc", "Main.A"),
        node("transition-chain-arc", "Main.A.B"),
      ]);
      expect(brief.transition?.position).toBe(
        node("transition-chain-arc", "Main.A.B"),
      );
    });

    it("coalesces an uncaught deflection into one exit transition at the catching ancestor", () => {
      const document = parse(`
"arc";

function Main() {
  let caught = Bool();
  $enter(C);
  $instruct(\`after\`);
  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };

  function C() {
    $enter(K);
    function K() {
      $instruct(\`k work\`, {
        deflectWhen: \`\${user} wants out\`,
      });
    }
  }
}
`);
      const runtime = new Runtime()
        .add("transition-deflect-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("transition-deflect-arc", "Main"),
      );
      seeded.phase = "entered";

      const entry = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(entry.transition?.entered).toEqual([
        node("transition-deflect-arc", "Main.C"),
        node("transition-deflect-arc", "Main.C.K"),
      ]);
      const work = actionProgress(
        runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(work.instructions.map((item) => item.text)).toEqual(["k work"]);
      expect(work.judgments).toHaveLength(1);

      // Deflection unwinds K and C without their own hooks; the coalesced exits
      // pause at Main, the first ancestor with a catch.
      const pendingDeflection = actionProgress(
        runtime.progress(
          work,
          { move: "proceed", judgments: { [work.judgments[0]!.id]: true } },
          EMPTY_DIALOG,
        ),
      );
      expect(pendingDeflection.allowedMoves).toEqual(["deflect"]);
      expect(pendingDeflection.transition).toBeUndefined();
      const exit = actionProgress(
        runtime.progress(pendingDeflection, { move: "deflect" }, EMPTY_DIALOG),
      );
      expect(exit.transition?.exited).toEqual([
        node("transition-deflect-arc", "Main.C.K"),
        node("transition-deflect-arc", "Main.C"),
      ]);
      expect(exit.transition?.position).toBe(
        node("transition-deflect-arc", "Main"),
      );

      const caught = actionProgress(
        runtime.progress(exit, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(rootTraversal(caught).cells.caught).toBe(true);
    });
  });

  describe("trans.exclusivity", () => {
    it("evaluates enterLoop resolveWhen under the exit acknowledgment's dialog", () => {
      const document = parse(`
"arc";

function Main() {
  $enterLoop(newcopy(Child), {
    resolveWhen: () => {
      return /stop/.test(Dialog.lastUserMessage);
    },
  });
  $instruct(\`after loop\`);
  function Child() {
    $instruct(\`child step\`);  }
}
`);
      const runtime = new Runtime().add("transition-loop-arc", document).init();
      const seeded = runtime.newTraversal(arc("transition-loop-arc", "Main"));
      seeded.phase = "entered";

      const entry = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(entry.transition?.entered).toHaveLength(1);
      const work = actionProgress(
        runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(work.instructions.map((item) => item.text)).toEqual([
        "child step",
      ]);

      // The covered iteration's exit yields before resolveWhen evaluates; the
      // acknowledging dialog is what the hook sees.
      const exit = actionProgress(
        runtime.progress(
          work,
          { move: "proceed", instructions: appliedInstructions(work) },
          EMPTY_DIALOG,
        ),
      );
      expect(exit.transition?.exited).toHaveLength(1);
      expect(exit.transition?.position).toBe(
        node("transition-loop-arc", "Main"),
      );

      const resolved = actionProgress(
        runtime.progress(
          exit,
          { move: "proceed" },
          {
            cursor: { user: 1, self: 0 },
            lastTurns: [{ role: "user", message: "please stop" }],
          },
        ),
      );
      expect(resolved.instructions.map((item) => item.text)).toEqual([
        "after loop",
      ]);
    });

    it("surfaces declared effects on the brief after the entry transition, not with it", () => {
      const document = parse(`
"arc";

import Writer from "host:writer";

function Main() {
  $enter(Child);
  $instruct(\`after\`);
  function Child() {
    this.effects = () => {
      Writer.$save(\`child done\`);
    };

    $instruct(\`child work\`);  }
}
`);
      const runtime = new Runtime()
        .add("transition-effects-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("transition-effects-arc", "Main"),
      );
      seeded.phase = "entered";

      const entry = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(entry.transition).toBeDefined();
      expect(entry.hostCalls).toEqual([]);

      const work = actionProgress(
        runtime.progress(entry, { move: "proceed" }, EMPTY_DIALOG),
      );
      expect(work.instructions.map((item) => item.text)).toEqual([
        "child work",
      ]);

      // The child's declared effects surface only after its work resolves, on a
      // transition-free brief, and hold the frontier until applied.
      const effects = actionProgress(
        runtime.progress(
          work,
          { move: "proceed", instructions: appliedInstructions(work) },
          EMPTY_DIALOG,
        ),
      );
      expect(effects.transition).toBeUndefined();
      expect(effects.hostCalls).toHaveLength(1);

      const exit = actionProgress(
        runtime.progress(
          effects,
          { move: "proceed", hostCalls: resolvedHostCalls(effects) },
          EMPTY_DIALOG,
        ),
      );
      expect(exit.transition?.exited).toEqual([
        node("transition-effects-arc", "Main.Child"),
      ]);
    });
  });

  describe("trans.non-latching", () => {
    it("latches no transition for a set-driven re-walk inside one node body", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;
  $observeOrAsk(ready);
  if (ready == true) {
    $instruct(\`go\`);
  }
}
`);
      const runtime = new Runtime().add("rewalk-no-latch-arc", document).init();
      const seeded = runtime.newTraversal(arc("rewalk-no-latch-arc", "Main"));
      seeded.phase = "entered";

      const first = actionProgress(runtime.start([seeded], EMPTY_DIALOG));
      expect(first.transition).toBeUndefined();
      expect(first.observations).toHaveLength(1);

      // The resolved observation re-walks the body and fires the gated branch;
      // the re-walk is not a position change, so no transition rides the brief.
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
      expect(second.transition).toBeUndefined();
      expect(second.instructions.map((item) => item.text)).toEqual(["go"]);
    });

    it("records no pending transitions during trigger probing", () => {
      const document = parse(`
"arc";

function Main() {
  this.trigger = () => {
    if (judge(\`\${user} asks for main\`)) {
      return true;
    }
    return false;
  };

  $enter(Child);
  function Child() {
    $instruct(\`child work\`);  }
}
`);
      const runtime = new Runtime()
        .add("transition-trigger-arc", document)
        .init();
      const trigger = startTrigger(runtime, EMPTY_DIALOG);
      expect(
        trigger.traversals.every(
          (traversal) => traversal.pendingTransition === undefined,
        ),
      ).toBe(true);
    });
  });

  describe("trans.persistence", () => {
    it("re-carries the transition when a report is rejected", () => {
      const { runtime, seeded } = guardedChildRuntime();
      const brief = actionProgress(runtime.start([seeded], EMPTY_DIALOG));

      const rebriefed = actionProgress(
        runtime.progress(brief, { move: "deflect" }, GO_DIALOG),
      );
      expect(rebriefed.transition).toEqual(brief.transition);
      expect(
        rebriefed.issues.some((issue) => issue.kind === "invalid-report"),
      ).toBe(true);
    });
  });
});
