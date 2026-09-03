/**
 * Behavior tests for the Action Forms area (`act.*` entries in
 * specs/testing.md), ported from the original monolith test files
 * (`parser.test.ts`, `runtime.test.ts`). Every case feeds a deterministic Arc
 * source string and injects semantic results through reports, so there is no
 * nondeterminism and no flakiness mitigation is needed.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { applyUnset } from "../src/runtime/evaluate.js";
import { createArtifactValue } from "../src/runtime/index.js";
import {
  createAccumulator,
  createEmptyArcTraversal,
  type RegistryEntry,
} from "../src/runtime/state.js";
import type { ArcTraversalSet, Dialog } from "../src/types/index.js";
import {
  actionProgress,
  actionTerminal,
  appliedHostEffects,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  groupObservation,
  METAL_SOURCE,
  node,
  ownedChild,
  progressBrief,
  progressTerminal,
  renderSemanticTextForTest,
  rootTraversal,
  TestRuntime as Runtime,
  singleObservation,
  startRun,
  startTerminal,
  startTrigger,
  withExperimentalRewalk,
} from "./helpers.js";

describe("action forms", () => {
  describe("act.set", () => {
    it("re-walks from the top after set() changes action graph branch reachability", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready != true) {
    ready.$set(true);
  } else {
    $instruct(\`now ready\`);  }
}
`),
        "Main",
      );
      const runtime = new Runtime().add("set-rewalk-arc", document).init();
      const seeded = runtime.newTraversal(arc("set-rewalk-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "now ready",
      ]);
      expect(rootTraversal(brief).cells.ready).toBe(true);
    });

    it("set() of the same value advances without a redundant re-walk", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let x = Bool();
  x.$set(true);
  x.$set(true);
  if (x == true) {
    $instruct(\`ready\`);
  }
}
`),
        "Main",
      );
      const runtime = new Runtime().add("n1-arc", document).init();
      const seeded = runtime.newTraversal(arc("n1-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["ready"]);
      expect(rootTraversal(brief).cells.x).toBe(true);
    });

    it("rejects invalid set() arity", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool();
  ready.$set();
}
`),
      ).toThrow(/requires a value/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool();
  ready.$set(true, false);
}
`),
      ).toThrow(/takes exactly one value/);
    });
  });

  describe("act.unset", () => {
    it("parses unset in node bodies and hook statement subsets", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  this.trigger = () => {
    ready.$unset();
    return false;
  };
  this.guard = () => {
    ready.$unset();
    return State.COVERED;
  };
  this.catchDeflection = () => {
    ready.$unset();
    return false;
  };
  this.effects = () => {
    ready.$unset();
  };

  ready.$unset();
  $instruct(\`wait\`, {
    deflectWhen: () => {
      ready.$unset();
      return false;
    },
  });
}
`);

      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({ kind: "unset" });
      expect(root.trigger?.[0]).toMatchObject({ kind: "unset" });
      expect(root.guard?.[0]).toMatchObject({ kind: "unset" });
      expect(root.catchDeflection?.[0]).toMatchObject({ kind: "unset" });
      expect(root.effects?.[0]).toMatchObject({ kind: "unset" });
      expect(root.statements[1]).toMatchObject({
        kind: "instruction",
        deflectWhen: [{ kind: "unset" }, { kind: "return" }],
      });
    });

    it("clears a cell and re-walks the action graph", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  ready.$set(true);
  if (ready == true) {
    ready.$unset();
  }
  if (ready.isUnset()) {
    $instruct(\`unset\`);
  }
}
`);
      const runtime = new Runtime().add("unset-rewalk-arc", document).init();
      const seeded = runtime.newTraversal(arc("unset-rewalk-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["unset"]);
      expect(rootTraversal(brief).cells.ready).toBeUndefined();
    });

    it("advances without re-walking when the cell is already unset", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$unset();
}
`);
      const root = document.roots[0]!;
      const statement = root.statements[0]!;
      expect(statement.kind).toBe("unset");
      if (statement.kind !== "unset") throw new Error("Expected unset action");

      const ref = arc("unset-no-rewalk-arc", "Main");
      const entry: RegistryEntry = {
        arc: ref,
        document,
        root,
        importRefs: {},
        hostModules: new Map(),
      };
      const traversal = createEmptyArcTraversal(ref, root);
      const accum = createAccumulator(
        new Map([[ref, entry]]),
        entry,
        traversal,
        [traversal],
        EMPTY_DIALOG,
        "apply",
        true,
      );

      expect(applyUnset(statement, traversal, root, accum)).toEqual({
        status: "resolved",
        value: { changed: false },
      });
    });

    it("rejects arguments and unknown cells while permitting Artifact unset", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool();
  ready.$unset(true);
}
`),
      ).toThrow(/does not accept arguments/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  missing.$unset();
}
`),
      ).toThrow(/UNKNOWN_CELL/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let report = Artifact("report.md");
  report.$unset();
}
`),
      ).not.toThrow();
    });
  });

  describe("act.observe", () => {
    it("continues past $observe() when the host reports unknown", () => {
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

      const nextBrief = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "unknown" },
        },
      });

      expect(rootTraversal(nextBrief).cells.interest).toBeUndefined();
      expect(rootTraversal(nextBrief).cells.topic).toBeUndefined();
      expect("hostEffects" in nextBrief).toBe(false);
      expect(rootTraversal(nextBrief).phase).toBe("completed");
    });

    it("preserves an existing value when $observe() reports unknown", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;
  interest.$set("warm");
  $observe(interest);
}
`);

      const runtime = new Runtime().add("observe-arc", document).init();
      const seeded = runtime.newTraversal(arc("observe-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      const nextBrief = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "unknown" },
        },
      });

      expect(rootTraversal(nextBrief).cells.interest).toBe("warm");
      expect(rootTraversal(nextBrief).phase).toBe("completed");
    });

    it("carries a prior set() value as the observation brief currentValue", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"], {
    observing: \`how interested is \${user}\`,
  });
  interest.$set("warm");
  $observe(interest);
}
`);
      const runtime = new Runtime()
        .add("observe-current-value-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-current-value-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.observations).toHaveLength(1);
      expect(singleObservation(brief.observations[0]).currentValue).toBe(
        "warm",
      );
      expect(singleObservation(brief.observations[0]).meta).toEqual({
        type: "enum",
        values: ["cold", "warm"],
      });
    });

    it("briefs and resolves one array element as a scalar cell target", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str({ observing: \`the selected item\` }));
  items.$set(["alpha", "beta"]);
  $observe(items[1]);
}
`);
      const runtime = new Runtime()
        .add("observe-array-element-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-array-element-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const observation = singleObservation(brief.observations[0]);
      expect(observation).toMatchObject({
        cell: "items[1]",
        currentValue: "beta",
        meta: { type: "string" },
      });
      expect(renderSemanticTextForTest(observation.question)).toBe(
        "the selected item",
      );

      const done = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [observation.id]: { status: "resolved", value: "BETA" },
        },
      });

      expect(rootTraversal(done).cells.items).toEqual(["alpha", "BETA"]);
      expect(rootTraversal(done).phase).toBe("completed");
    });
  });

  describe("act.observe-or-ask", () => {
    it("re-walks from the top after $observeOrAsk() resolves normally", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $instruct(\`before\`);  }

  $observeOrAsk(ready);

  if (ready == true) {
    $instruct(\`after\`);  }
}
`),
        "Main",
      );
      const runtime = new Runtime().add("observe-rewalk-arc", document).init();
      const seeded = runtime.newTraversal(arc("observe-rewalk-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
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

      expect(next.instructions.map((item) => item.text)).toEqual(["before"]);
      const after = progressBrief(runtime, next, {
        move: "proceed",
        instructions: appliedInstructions(next),
      });
      expect(after.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("re-evaluates structural if flow after $observeOrAsk() re-walks the current SEG", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $instruct(\`before\`);  }

  if (true) {
    $observeOrAsk(ready);
  }

  if (ready == true) {
    $instruct(\`after\`);  }
}
`),
        "Main",
      );
      const runtime = new Runtime()
        .add("observe-branch-rewalk-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-branch-rewalk-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
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

      expect(next.instructions.map((item) => item.text)).toEqual(["before"]);
      const after = progressBrief(runtime, next, {
        move: "proceed",
        instructions: appliedInstructions(next),
      });
      expect(after.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("records needs-user/proceed flow against the active owned child", () => {
      const document = parse(METAL_SOURCE);
      const runtime = new Runtime().add("metal-arc", document).init();
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
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

      const brief = startRun(runtime, triggerOutcome.traversals, dialog);
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

      const resumed = startRun(runtime, afterAsk.traversals, {
        cursor: { user: 0, self: 0 },
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
        ownedChild(rootTraversal(afterProceed), "Metal.Surface")?.cells
          .subgenre,
      ).toBe("thrash");

      const completed = progressTerminal(runtime, afterProceed, {
        move: "proceed",
        instructions: appliedInstructions(afterProceed),
      });
      expect(completed.canProgress).toBe(false);
      expect(rootTraversal(completed).phase).toBe("completed");
    });

    it("resurfaces observeOrAsk when the host reports unknown", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool({
    observing: \`is \${user} ready\`,
  });
  $observeOrAsk(ready);
  $instruct(\`after\`);
}
`);
      const runtime = new Runtime().add("ask-unknown-arc", document).init();
      const seeded = runtime.newTraversal(arc("ask-unknown-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.observations).toHaveLength(1);

      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "unknown" },
        },
      });

      expect(next.observations.map((item) => item.id)).toEqual([
        brief.observations[0]!.id,
      ]);
      expect(next.instructions).toEqual([]);
      expect(rootTraversal(next).cells.ready).toBeUndefined();
    });
  });

  describe("act.instruct", () => {
    it("rejects resolveWhen for $instruct()", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $instruct(\`Carry this topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`),
      ).toThrow(/instruct\(\) does not support resolveWhen/);
    });

    it("treats $instruct() as one-shot instructions", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`hello\`);}
`);
      const runtime = new Runtime().add("once-arc", document).init();
      const seeded = runtime.newTraversal(arc("once-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions).toMatchObject([
        {
          mode: "once",
          phase: "apply",
          text: "hello",
          postcheck: undefined,
        },
      ]);
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);

      const afterProceed = progressTerminal(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      expect("instructions" in afterProceed).toBe(false);
      expect(afterProceed.canProgress).toBe(false);
      expect(rootTraversal(afterProceed).phase).toBe("completed");
    });

    it("resolves a one-shot instruction only after its application report", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`Mention this once.\`);
  $instruct(\`after\`);}
`);
      const runtime = new Runtime()
        .add("instruct-implicit-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("instruct-implicit-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "Mention this once.",
      ]);
      expect(brief.judgments).toEqual([]);

      const unacknowledged = progressBrief(runtime, brief, { move: "proceed" });
      expect(unacknowledged.instructions).toEqual(brief.instructions);

      const resolved = progressBrief(runtime, unacknowledged, {
        move: "proceed",
        instructions: appliedInstructions(unacknowledged),
      });
      expect(resolved.instructions.map((item) => item.text)).toEqual(["after"]);

      const completed = progressTerminal(runtime, resolved, {
        move: "proceed",
        instructions: appliedInstructions(resolved),
      });
      expect("instructions" in completed).toBe(false);
      expect(completed.canProgress).toBe(false);
    });

    it("keeps an applied one-shot resolved through a same-handback deflection", () => {
      const document = parse(`
"arc";

function Main() {
  this.catchDeflection = () => true;
  $instruct(\`Say it.\`, { deflectWhen: \`user changed topic\` });
}
`);
      const runtime = new Runtime()
        .add("instruct-lap-deflect-applied-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruct-lap-deflect-applied-arc", "Main"),
      );
      seeded.phase = "entered";
      const issued = startRun(runtime, [seeded], EMPTY_DIALOG);
      const check = issued.instructions[0]!.postcheck!.judgmentIds[0]!;

      // The lap short-circuits on the deflection but honors the application
      // evidence from the same handback: the one-shot stays resolved, so the
      // catch rewalk completes the node instead of re-presenting it.
      const caught = progressTerminal(runtime, issued, {
        move: "proceed",
        instructions: appliedInstructions(issued),
        judgments: { [check]: true },
      });
      expect("instructions" in caught).toBe(false);
      expect(rootTraversal(caught).phase).toBe("completed");
    });

    it("re-presents an unapplied one-shot after its deflection is caught", () => {
      const document = parse(`
"arc";

function Main() {
  this.catchDeflection = () => true;
  $instruct(\`Say it.\`, { deflectWhen: \`user changed topic\` });
}
`);
      const runtime = new Runtime()
        .add("instruct-lap-deflect-unapplied-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruct-lap-deflect-unapplied-arc", "Main"),
      );
      seeded.phase = "entered";
      const issued = startRun(runtime, [seeded], EMPTY_DIALOG);
      const check = issued.instructions[0]!.postcheck!.judgmentIds[0]!;

      // No finished evidence at the short-circuit: the lap ends unfinished and
      // the catch rewalk starts a fresh lap, re-presenting the instruction.
      const caught = progressBrief(runtime, issued, {
        move: "proceed",
        judgments: { [check]: true },
      });
      expect(caught.instructions).toMatchObject([
        { text: "Say it.", phase: "apply" },
      ]);
      expect(rootTraversal(caught).phase).toBe("entered");
    });
  });

  describe("act.instruct-loop", () => {
    it("requires resolveWhen for $instructLoop()", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $instructLoop(\`Carry this topic.\`);
}
`),
      ).toThrow(/instructLoop\(\) requires resolveWhen/);
    });

    it("parses instructLoop and instruct with authored resolution rules", () => {
      const document = parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;

  $instructLoop(\`Carry this topic.\`, {
    resolveWhen: () => {
      $observe(ready);
      return ready;
    },
  });

  $instruct(\`Mention this once.\`, {
    deflectWhen: \`\${user} is bored\`,
  });

  let ready = Bool();
}
`);

      const root = document.roots[0]!;
      expect(root.deflectWhen).toBeDefined();
      expect(root.statements[0]).toMatchObject({
        kind: "instruction",
        mode: "persistent",
      });
      expect(
        (
          root.statements[0] as Extract<
            (typeof root.statements)[number],
            { kind: "instruction" }
          >
        ).resolveWhen,
      ).toBeDefined();
      expect(root.statements[1]).toMatchObject({
        kind: "instruction",
        mode: "once",
      });
      expect(
        (
          root.statements[1] as Extract<
            (typeof root.statements)[number],
            { kind: "instruction" }
          >
        ).deflectWhen,
      ).toBeDefined();
    });

    it("prefers deflectWhen over resolveWhen when both evaluate true", () => {
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
        .add("instruction-precedence-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruction-precedence-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const deflect = brief.judgments.find(
        (item) =>
          renderSemanticTextForTest(item.question) ===
          "user wants to leave this topic",
      );
      const resolve = brief.judgments.find(
        (item) =>
          renderSemanticTextForTest(item.question) ===
          "self covered the topic enough",
      );
      expect(deflect).toBeDefined();
      expect(resolve).toBeDefined();

      const nextBrief = progressTerminal(runtime, brief, {
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

    it("banks a settled resolveWhen while deflectWhen stays open", () => {
      const document = parse(`
"arc";

function Main() {
  $instructLoop(\`Carry it.\`, {
    deflectWhen: \`user left the topic\`,
    resolveWhen: \`topic is covered\`,
  });
}
`);
      const runtime = new Runtime()
        .add("loop-bank-resolve-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("loop-bank-resolve-arc", "Main"));
      seeded.phase = "entered";
      const issued = startRun(runtime, [seeded], EMPTY_DIALOG);
      const questionOf = (id: string) => {
        const item = issued.judgments.find((judgment) => judgment.id === id);
        return item ? renderSemanticTextForTest(item.question) : undefined;
      };
      const checks = issued.instructions[0]!.postcheck!.judgmentIds;
      const resolveId = checks.find(
        (id) => questionOf(id) === "topic is covered",
      )!;
      const deflectId = checks.find(
        (id) => questionOf(id) === "user left the topic",
      )!;

      // The settled resolveWhen keeps its consultation: the next brief poses
      // only the open deflect check, never re-asking the answered question.
      const waiting = progressBrief(runtime, issued, {
        move: "proceed",
        judgments: { [resolveId]: true },
      });
      expect(waiting.judgments.map((item) => item.id)).toEqual([deflectId]);
      expect(waiting.instructions[0]!.postcheck?.judgmentIds).toEqual([
        deflectId,
      ]);

      // The banked true is read at the decision: deflect settles false and the
      // loop resolves without the resolve question ever re-posing.
      const resolved = progressTerminal(runtime, waiting, {
        move: "proceed",
        judgments: { [deflectId]: false },
      });
      expect("instructions" in resolved).toBe(false);
      expect(rootTraversal(resolved).phase).toBe("completed");
    });

    it("banks a settled deflectWhen while resolveWhen stays open", () => {
      const document = parse(`
"arc";

function Main() {
  $instructLoop(\`Carry it.\`, {
    deflectWhen: \`user left the topic\`,
    resolveWhen: \`topic is covered\`,
  });
}
`);
      const runtime = new Runtime()
        .add("loop-bank-deflect-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("loop-bank-deflect-arc", "Main"));
      seeded.phase = "entered";
      const issued = startRun(runtime, [seeded], EMPTY_DIALOG);
      const questionOf = (id: string) => {
        const item = issued.judgments.find((judgment) => judgment.id === id);
        return item ? renderSemanticTextForTest(item.question) : undefined;
      };
      const checks = issued.instructions[0]!.postcheck!.judgmentIds;
      const resolveId = checks.find(
        (id) => questionOf(id) === "topic is covered",
      )!;
      const deflectId = checks.find(
        (id) => questionOf(id) === "user left the topic",
      )!;

      const waiting = progressBrief(runtime, issued, {
        move: "proceed",
        judgments: { [deflectId]: false },
      });
      expect(waiting.judgments.map((item) => item.id)).toEqual([resolveId]);

      const resolved = progressTerminal(runtime, waiting, {
        move: "proceed",
        judgments: { [resolveId]: true },
      });
      expect("instructions" in resolved).toBe(false);
      expect(rootTraversal(resolved).phase).toBe("completed");
    });

    it("restores a banked resolveWhen consultation onto a fresh runtime", () => {
      const source = `
"arc";

function Main() {
  $instructLoop(\`Carry it.\`, {
    deflectWhen: \`user left the topic\`,
    resolveWhen: \`topic is covered\`,
  });
}
`;
      const first = new Runtime()
        .add("loop-bank-restore-arc", parse(source))
        .init();
      const seeded = first.newTraversal(arc("loop-bank-restore-arc", "Main"));
      seeded.phase = "entered";
      const issued = startRun(first, [seeded], EMPTY_DIALOG);
      const questionOf = (id: string) => {
        const item = issued.judgments.find((judgment) => judgment.id === id);
        return item ? renderSemanticTextForTest(item.question) : undefined;
      };
      const checks = issued.instructions[0]!.postcheck!.judgmentIds;
      const resolveId = checks.find(
        (id) => questionOf(id) === "topic is covered",
      )!;
      const deflectId = checks.find(
        (id) => questionOf(id) === "user left the topic",
      )!;
      const waiting = progressBrief(first, issued, {
        move: "proceed",
        judgments: { [resolveId]: true },
      });

      const second = new Runtime()
        .add("loop-bank-restore-arc", parse(source))
        .init();
      const restored = startRun(
        second,
        JSON.parse(JSON.stringify(waiting.traversals)) as ArcTraversalSet,
        EMPTY_DIALOG,
      );
      expect(restored.judgments.map((item) => item.id)).toEqual([deflectId]);

      const resolved = progressTerminal(second, restored, {
        move: "proceed",
        judgments: { [deflectId]: false },
      });
      expect("instructions" in resolved).toBe(false);
      expect(rootTraversal(resolved).phase).toBe("completed");
    });

    it("resolves the loop when a banked resolveWhen meets a later deflection", () => {
      const document = parse(`
"arc";

function Main() {
  this.catchDeflection = () => true;
  $instructLoop(\`Carry it.\`, {
    deflectWhen: \`user left the topic\`,
    resolveWhen: \`topic is covered\`,
  });
}
`);
      const runtime = new Runtime()
        .add("loop-bank-deflected-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("loop-bank-deflected-arc", "Main"),
      );
      seeded.phase = "entered";
      const issued = startRun(runtime, [seeded], EMPTY_DIALOG);
      const questionOf = (id: string) => {
        const item = issued.judgments.find((judgment) => judgment.id === id);
        return item ? renderSemanticTextForTest(item.question) : undefined;
      };
      const checks = issued.instructions[0]!.postcheck!.judgmentIds;
      const resolveId = checks.find(
        (id) => questionOf(id) === "topic is covered",
      )!;
      const deflectId = checks.find(
        (id) => questionOf(id) === "user left the topic",
      )!;

      const waiting = progressBrief(runtime, issued, {
        move: "proceed",
        judgments: { [resolveId]: true },
      });

      // The lap short-circuits on the deflection but honors the banked
      // finished evidence: the loop stays resolved, so the catch rewalk
      // completes the node instead of re-presenting it.
      const caught = progressTerminal(runtime, waiting, {
        move: "proceed",
        judgments: { [deflectId]: true },
      });
      expect("instructions" in caught).toBe(false);
      expect(rootTraversal(caught).phase).toBe("completed");
    });

    it("re-emits resolution observe when terminal false repeats the instruction", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${self} ready\`;
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      $observe(ready);
      return ready == true;
    },
  });
}
`);
      const runtime = new Runtime()
        .add("instruction-observe-unknown-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruction-observe-unknown-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.observations).toHaveLength(1);

      const afterUnknown = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "unknown" },
        },
      });
      expect(afterUnknown.observations).toHaveLength(1);
      expect(
        renderSemanticTextForTest(
          singleObservation(afterUnknown.observations[0]).question,
        ),
      ).toEqual("is self ready");
      expect(afterUnknown.instructions).toMatchObject([
        {
          text: "Carry the topic.",
          phase: "apply",
        },
      ]);

      const nextBrief = progressBrief(runtime, afterUnknown, {
        move: "proceed",
        instructions: appliedInstructions(afterUnknown),
      });
      expect(nextBrief.observations).toHaveLength(1);
      expect(
        renderSemanticTextForTest(
          singleObservation(nextBrief.observations[0]).question,
        ),
      ).toEqual("is self ready");
      expect(nextBrief.instructions).toMatchObject([
        {
          text: "Carry the topic.",
          phase: "postcheck",
        },
      ]);
    });
  });

  describe("act.instruction-text", () => {
    it("accepts string literals in semantic text positions", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str({ observing: "plain observing" });
  let detail = Str();
  $instruct("plain instruct");
  $instructLoop("plain loop", { resolveWhen: "plain resolve" });
  if (judge("plain judge")) {
    $observe(topic, "plain observe");
  }
  $observeOrAsk(detail, "plain ask");
}
`);

      expect(document.roots[0]?.cells[0]).toMatchObject({
        observing: { kind: "literal", value: "plain observing" },
      });
      expect(document.roots[0]?.statements).toHaveLength(4);
    });

    it("renders cells and ternary expressions in explicit instructions", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm", "hot"]);
  interest.$set("warm");
  $instruct(\`Interest is \${interest}; \${interest >= "warm" ? "lean in" : "hold back"}.\`);}
`);
      const runtime = new Runtime()
        .add("instruction-rendering-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("instruction-rendering-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "Interest is warm; lean in.",
      ]);
    });

    it("rejects conditional IML in instruction literals", () => {
      const source = `
"arc";
function Bad() {
  $enter(Step);
  function Step() {
    $instruct(\`      :::when \${true}
      bad
      :::
    \`);  }
}
`;

      expect(() => parse(source)).toThrow(
        /does not support :::when\/:::else conditional IML/,
      );
    });

    it("allows non-conditional directives to remain in the instruction template", () => {
      const source = `
"arc";
function Directive() {
  $enter(Step);
  function Step() {
    $instruct(\`      :::replace
      Bring in a stronger phrasing.
      :::
    \`);  }
}
`;

      const document = parse(source);
      const step = document.roots[0]?.children.find(
        (child) => child.identifier === "Step",
      );
      const instruction = step?.statements[0];

      expect(instruction).toMatchObject({ kind: "instruction" });
      expect(JSON.stringify(instruction)).toContain(":::replace");
    });
  });

  describe("act.instruction-literal", () => {
    it("rejects bare string and template expression statements", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  "plain";
}
`),
      ).toThrow(/Unsupported Arc expression statement/);

      expect(() =>
        parse(`
"arc";

function Main() {
  \`plain\`;
}
`),
      ).toThrow(/Unsupported Arc expression statement/);
    });

    it("rejects unsupported statements and expressions in node action graphs", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  while (true) {
    $instruct(\`nope\`);  }
}
`),
      ).toThrow("`while` is not supported in an Arc action graph");

      expect(() =>
        parse(`
"arc";
function Bad() {
  nope();
}
`),
      ).toThrow(/Unsupported Arc expression statement/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  const local = 1;
}
`),
      ).toThrow(
        "Node-body declarations must use supported Arc cell constructors",
      );
    });
  });

  describe("act.judge", () => {
    it("accepts judge() inside set() value expressions", () => {
      const document = parse(`
"arc";
function Bad() {
  let ready = Bool();
  ready.$set(judge(\`is \${user} ready\`));
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        value: { kind: "judge" },
      });
    });

    it("resolves judge() in a set() value position from the reported boolean", () => {
      const document = parse(`
"arc";

function Main() {
  let lucky = Bool();
  lucky.$set(judge(\`is \${user} feeling lucky\`));
  if (lucky == true) {
    $instruct(\`fortune favors\`);
  }
}
`);
      const runtime = new Runtime().add("judge-set-arc", document).init();
      const seeded = runtime.newTraversal(arc("judge-set-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.judgments).toHaveLength(1);

      const next = progressBrief(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      });

      expect(rootTraversal(next).cells.lucky).toBe(true);
      expect(next.instructions.map((item) => item.text)).toEqual([
        "fortune favors",
      ]);
    });
  });

  describe("expr.artifact-construction", () => {
    it("artifact.construct lowers identical source syntax to contextual IR", () => {
      const document = parse(`
"arc";
function Main() {
  let artifact = Artifact("x.md");
  artifact.$set(Artifact("x.md"));
}
`);

      expect(document.roots[0]!.cells[0]).toMatchObject({
        name: "artifact",
        type: "artifact",
        initializer: {
          kind: "artifact",
          path: { kind: "literal", value: "x.md" },
        },
      });
      expect(document.roots[0]!.statements[0]).toMatchObject({
        kind: "set",
        target: ["artifact"],
        value: {
          kind: "artifact",
          path: { kind: "literal", value: "x.md" },
        },
      });
    });

    it.each([
      ["zero arguments", "Artifact()"],
      ["multiple arguments", 'Artifact("a.md", "b.md")'],
      ["spread argument", "Artifact(...paths)"],
      ["object expression", 'Artifact({ path: "a.md" })'],
    ])(
      "artifact.construct rejects invalid value-site argument forms: %s",
      (_case, expression) => {
        expect(() =>
          parse(`
"arc";
import Files from "host:files";
function Main() {
  let path = Str();
  let artifact = Artifact("initial.md");
  artifact.$set(${expression});
}
`),
        ).toThrow(/Artifact value/);
      },
    );

    it.each([
      ["number literal", "42"],
      ["boolean literal", "true"],
      ["null literal", "null"],
      ["Artifact value", 'Artifact("nested.md")'],
    ])(
      "artifact.construct rejects a statically non-string path expression: %s",
      (_case, expression) => {
        expect(() =>
          parse(`
"arc";
function Main() {
  let artifact = Artifact("initial.md");
  artifact.$set(Artifact(${expression}));
}
`),
        ).toThrow(/ARTIFACT_PATH_TYPE/);
      },
    );

    it.each([
      ["empty", ""],
      ["absolute", "/absolute.md"],
      ["dot segment", "docs/./note.md"],
      ["parent segment", "docs/../note.md"],
    ])("artifact.construct rejects invalid literal path: %s", (_case, path) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let artifact = Artifact("initial.md");
  artifact.$set(Artifact(${JSON.stringify(path)}));
}
`),
      ).toThrow(/Artifact value path/);
    });

    it("artifact.construct snapshots a Str expression at the action position", () => {
      const runtime = new Runtime()
        .add(
          "artifact-dynamic-construction",
          parse(`
"arc";
function Main() {
  let linked = Str();
  let first = Artifact("first.md");
  let second = Artifact("second.md");
  linked.$set("docs/a.md");
  first.$set(Artifact(linked));
  linked.$set("docs/b.md");
  second.$set(Artifact(linked));
}
`),
        )
        .init();

      const terminal = actionTerminal(
        runtime.enterArc(
          arc("artifact-dynamic-construction", "Main"),
          EMPTY_DIALOG,
        ),
      );
      const cells = rootTraversal(terminal).cells;
      expect(cells.first).toEqual(createArtifactValue("docs/a.md"));
      expect(cells.second).toEqual(createArtifactValue("docs/b.md"));
      expect(cells.first).not.toBe(cells.second);
    });

    it("artifact.construct poisons before mutation for unset and invalid dynamic paths", () => {
      for (const [name, setup, pathExpression, reasonCode] of [
        ["unset-direct", "", "slug", "unset-value"],
        [
          "unset-template",
          "",
          "`docs/${slug}.md`",
          "invalid-template-interpolation",
        ],
        ["invalid", 'slug.$set("..");', "slug", "invalid-artifact-path"],
      ] as const) {
        const runtime = new Runtime()
          .add(
            `artifact-${name}-construction`,
            parse(`
"arc";
function Main() {
  let slug = Str();
  let artifact = Artifact("initial.md");
  ${setup}
  artifact.$set(Artifact(${pathExpression}));
}
`),
          )
          .init();
        const seeded = runtime.newTraversal(
          arc(`artifact-${name}-construction`, "Main"),
        );
        seeded.phase = "entered";
        seeded.cells.artifact = createArtifactValue("initial.md");
        const terminal = startTerminal(runtime, [seeded], EMPTY_DIALOG);
        expect(rootTraversal(terminal).cells.artifact).toEqual(
          createArtifactValue("initial.md"),
        );
        expect(terminal.issues[0]).toMatchObject({ reasonCode });
      }
    });

    it("artifact.construct rejects invalid Artifact operations", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let result = Bool();
  result.$set(Artifact("x.md") < Artifact("y.md"));
}
`),
      ).toThrow(/INVALID_ARTIFACT_OPERATION/);
    });
  });

  describe("act.host-call", () => {
    it("uses the declaration to distinguish Artifact and object-shaped arguments", () => {
      const document = parse(`
"arc";
import Sink from "host:sink";
function Main() {
  let accepted = Bool();
  accepted.$set(Sink.accept(Artifact("docs/result.md")));
}
`);
      const runtime = new Runtime()
        .add("host-argument-provenance", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("host-argument-provenance", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);
      expect(first.hostCalls[0]!.arguments).toEqual([
        createArtifactValue("docs/result.md"),
      ]);

      const objectArgument = parse(`
"arc";
import Sink from "host:sink";
function Main() {
  let accepted = Bool();
  accepted.$set(Sink.accept({ path: "docs/result.md" }));
}
`);
      expect(() =>
        new Runtime().add("host-object-argument", objectArgument),
      ).toThrow(/HOST_ARGUMENT_TYPE/);
    });

    it("poisons before emitting a host call with an unset value argument", () => {
      const document = parse(`
"arc";

import Store from "host:store";

function Main() {
  let topic = Str();
  let accepted = Bool();
  accepted.$set(Store.accepts(topic));
  topic.$set("pricing");
}
`);
      const runtime = new Runtime()
        .add("host-call-unset-arg-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("host-call-unset-arg-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect("hostCalls" in brief).toBe(false);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unset-value",
        }),
      ]);
    });

    it("parses host call expressions in set() and condition positions", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  lucky.$set(Dice.roll(20));

  if (Dice.roll(6)) {
    $instruct(\`critical hit\`);  }
}
`);

      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "set",
        value: {
          kind: "host-call",
          module: "rng",
          operation: "roll",
        },
      });
      expect(root.statements[1]).toMatchObject({
        kind: "if",
        test: {
          kind: "host-call",
          module: "rng",
          operation: "roll",
        },
      });
    });

    it("parses static bracket host call targets in expression positions", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  lucky.$set(Dice["table"].roller["roll"](20));

  if (Dice["roll"](6)) {
    $instruct(\`critical hit\`);  }
}
`);

      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "set",
        value: {
          kind: "host-call",
          module: "rng",
          target: ["table", "roller"],
          operation: "roll",
        },
      });
      expect(root.statements[1]).toMatchObject({
        kind: "if",
        test: {
          kind: "host-call",
          module: "rng",
          target: [],
          operation: "roll",
        },
      });
    });

    it("rejects dynamic computed host call targets", () => {
      expect(() =>
        parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let method = Str();
  let lucky = Bool();
  lucky.$set(Dice[method](20));
}
`),
      ).toThrow(/Host calls do not support computed member access/);
    });

    it("rejects host calls nested inside host call arguments", () => {
      expect(() =>
        parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  lucky.$set(Dice.roll(Dice.roll(6)) >= 3);
}
`),
      ).toThrow(/Host call arguments cannot contain briefable expressions/);
    });

    it("rejects a resolved-once host-effect spelling in value position", () => {
      expect(() =>
        parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  lucky.$set(Dice.$roll());
}
`),
      ).toThrow(/\$-prefixed host operations are only valid as host effects/);
    });

    it("reuses computed cells across value expression positions", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";
import Score from "host:scorer";
import Memoir from "host:memoir";

function Main() {
  let roll = Num();
  let lucky = Bool();
  let score = Num();

  roll.$set(Dice.roll(20));
  lucky.$set(roll > 10);
  score.$set(Score.score(roll, lucky ? "boost" : "plain"));

  if (lucky && score >= 50) {
    $instruct(\`Rolled \${roll}; \${lucky ? "lucky" : "plain"} score \${score}.\`);  }

  this.effects = () => {
    if (lucky) {
      Memoir.facts.$apply(
        \`roll: \${roll}; score: \${score}; label: \${lucky ? "lucky" : "plain"}\`,
      );
    }
  };
}
`);

      const runtime = new Runtime()
        .add("value-expression-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("value-expression-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);
      expect(first.hostCalls[0]).toMatchObject({
        module: "rng",
        operation: "roll",
        arguments: [20],
      });

      const second = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: 17,
        },
      });

      expect(rootTraversal(second).cells.roll).toBe(17);
      expect(rootTraversal(second).cells.lucky).toBe(true);
      expect(second.hostCalls).toHaveLength(1);
      expect(second.hostCalls[0]).toMatchObject({
        module: "scorer",
        operation: "score",
        arguments: [17, "boost"],
      });

      const third = progressBrief(runtime, second, {
        move: "proceed",
        hostCalls: {
          [second.hostCalls[0]!.id]: 88,
        },
      });

      expect(rootTraversal(third).cells.score).toBe(88);
      expect(third.instructions.map((item) => item.text)).toEqual([
        "Rolled 17; lucky score 88.",
      ]);

      const emitted = progressBrief(runtime, third, {
        move: "proceed",
        instructions: appliedInstructions(third),
      });

      expect(emitted.hostEffects).toEqual([
        {
          id: expect.any(String),
          sourceRef: node("value-expression-arc", "Main"),
          module: "memoir",
          target: ["facts"],
          operation: "apply",
          arguments: ["roll: 17; score: 88; label: lucky"],
        },
      ]);
      expect(rootTraversal(emitted).phase).toBe("entered");

      const completed = progressTerminal(runtime, emitted, {
        move: "proceed",
        hostEffects: appliedHostEffects(emitted),
      });

      expect("hostEffects" in completed).toBe(false);
      expect(rootTraversal(completed).phase).toBe("completed");
    });

    it("re-evaluates a host value call when a later evaluation reaches it", () => {
      const document = parse(`
"arc";

import Gate from "host:gate";

function Main() {
  this.trigger = () => Gate.isOpen();
}
`);
      const runtime = new Runtime()
        .add("host-call-rewalk-arc", document)
        .init();
      const first = startTrigger(runtime, EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);

      const unmatched = runtime.progressTrigger(
        first,
        {
          hostCalls: { [first.hostCalls[0]!.id]: false },
        },
        EMPTY_DIALOG,
      );
      expect(unmatched.matched).toBeUndefined();

      const later = startTrigger(runtime, EMPTY_DIALOG, unmatched.traversals);
      expect(later.hostCalls).toHaveLength(1);
      expect(later.hostCalls[0]).toMatchObject({
        module: "gate",
        operation: "isOpen",
      });
    });

    it("keeps Artifact host templates semantic while materialized paths are strings", () => {
      const runtime = new Runtime()
        .add(
          "artifact-host-argument-contexts",
          parse(`
"arc";
import Store from "host:store";
function Main() {
  let note = Artifact("docs/note.md");
  let pathText = Str();
  let accepted = Bool();
  pathText.$set(\`\${note}\`);
  accepted.$set(Store.send(note, \`\${note}\`, pathText));
}
`),
        )
        .init();

      const brief = actionProgress(
        runtime.enterArc(
          arc("artifact-host-argument-contexts", "Main"),
          EMPTY_DIALOG,
        ),
      );
      expect(brief.hostCalls[0]?.arguments).toEqual([
        createArtifactValue("docs/note.md"),
        [{ kind: "artifact", path: "docs/note.md" }],
        "docs/note.md",
      ]);
    });

    it("keeps host call string and template arguments as semantic text", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply("plain", \`semantic \${user}\`);
  };
}
`);

      const effect = document.roots[0]?.effects?.[0];
      expect(effect).toMatchObject({
        kind: "host-call",
        arguments: [
          { kind: "semantic", value: { kind: "literal", value: "plain" } },
          { kind: "semantic", value: { kind: "template-string" } },
        ],
      });
    });
  });

  describe("act.observe-group", () => {
    const GROUP_SOURCE = `
"arc";

function Main() {
  let name = Str();
  let age = Num({ observeAs: { kind: "integer", min: 0, max: 99 } });
  name.observing = \`the user's name\`;
  age.observing = \`the user's age\`;
  $observe({ name, age });
  if (name == "John") {
    $instruct(\`greet John\`);
  }
}
`;

    function startGroupRun() {
      const document = parse(GROUP_SOURCE);
      const runtime = new Runtime().add("group-arc", document).init();
      const seeded = runtime.newTraversal(arc("group-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      return { runtime, brief };
    }

    it("parses grouped observe forms with same-name cell bindings", () => {
      const document = parse(`
"arc";

function Main() {
  let name = Str();
  let age = Num({ observeAs: { kind: "integer", min: 0, max: 99 } });
  $observe({ name, age });
  $observeOrAsk({ name, age });
}
`);
      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "observeGroup",
        targets: [["name"], ["age"]],
      });
      expect(root.statements[1]).toMatchObject({
        kind: "observeOrAskGroup",
        targets: [["name"], ["age"]],
      });
    });

    it.each([
      ["a renamed binding", "$observe({ handle: name })", /same-name binding/],
      ["a computed key", "$observe({ [name]: name })", /computed keys/],
      ["a spread", "$observe({ ...rest })", /does not support spread/],
      ["a duplicate cell", "$observe({ name, name })", /more than once/],
      ["an empty group", "$observe({})", /at least one cell/],
      [
        "a second argument",
        "$observe({ name }, `q`)",
        /takes only the cell group/,
      ],
    ])("rejects %s", (_case, call, message) => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let name = Str();
  ${call};
}
`),
      ).toThrow(message);
    });

    it("rejects an unknown cell in a group", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let name = Str();
  $observe({ name, missing });
}
`),
      ).toThrow(/UNKNOWN_CELL/);
    });

    it("rejects a non-observable cell in a group", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let name = Str();
  let at = Dialog.Cursor();
  $observe({ name, at });
}
`),
      ).toThrow(/NON_OBSERVABLE_CELL/);
    });

    it("emits one grouped brief on the shared observation channel", () => {
      const { brief } = startGroupRun();
      expect(brief.observations).toHaveLength(1);
      const group = groupObservation(brief.observations[0]);
      expect(group.mode).toBe("observe");
      expect(group.fields.map((field) => field.cell)).toEqual(["name", "age"]);
      const [nameField, ageField] = group.fields;
      expect(nameField!.meta).toMatchObject({ type: "string" });
      expect(renderSemanticTextForTest(nameField!.question)).toBe(
        "the user's name",
      );
      expect(ageField!.meta).toMatchObject({
        type: "rangedInt",
        min: 0,
        max: 99,
      });
    });

    it("writes every resolved field together before advancing", () => {
      const { runtime, brief } = startGroupRun();
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              age: { status: "resolved", value: 30 },
            },
          },
        },
      });
      expect(rootTraversal(next).cells.name).toBe("John");
      expect(rootTraversal(next).cells.age).toBe(30);
      // The single atomic commit completes before the following branch runs.
      expect(next.instructions.map((item) => item.text)).toEqual([
        "greet John",
      ]);
    });

    it("skips an unknown field and settles the group", () => {
      const { runtime, brief } = startGroupRun();
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              age: { status: "unknown" },
            },
          },
        },
      });
      expect(rootTraversal(next).cells.name).toBe("John");
      expect(rootTraversal(next).cells.age).toBeUndefined();
      expect(next.observations).toEqual([]);
    });

    it("writes nothing and re-emits when the report omits a field", () => {
      const { runtime, brief } = startGroupRun();
      const groupId = brief.observations[0]!.id;
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [groupId]: {
            fields: { name: { status: "resolved", value: "John" } },
          },
        },
      });
      expect(next.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          reasonCode: "observation-group-incomplete",
        }),
      ]);
      expect(rootTraversal(next).cells.name).toBeUndefined();
      expect(next.observations).toHaveLength(1);
    });

    it("writes nothing and re-emits when a field value fails its cell type", () => {
      const { runtime, brief } = startGroupRun();
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              age: { status: "resolved", value: 200 },
            },
          },
        },
      });
      expect(next.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          reasonCode: "observation-range",
        }),
      ]);
      expect(rootTraversal(next).cells.name).toBeUndefined();
      expect(next.observations).toHaveLength(1);
    });

    it("re-emits an observeOrAsk group while a field needs the user", () => {
      const document = parse(`
"arc";

function Main() {
  let name = Str();
  let age = Num({ observeAs: { kind: "integer", min: 0, max: 99 } });
  name.observing = \`the user's name\`;
  age.observing = \`the user's age\`;
  $observeOrAsk({ name, age });
}
`);
      const runtime = new Runtime().add("group-ask-arc", document).init();
      const seeded = runtime.newTraversal(arc("group-ask-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(groupObservation(brief.observations[0]).mode).toBe("observeOrAsk");

      const pending = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              age: { status: "needs-user" },
            },
          },
        },
      });
      // A needs-user field writes nothing and re-emits the whole group.
      expect(rootTraversal(pending).cells.name).toBeUndefined();
      expect(pending.observations).toHaveLength(1);

      const done = progressTerminal(runtime, pending, {
        move: "proceed",
        observations: {
          [pending.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              age: { status: "resolved", value: 30 },
            },
          },
        },
      });
      expect(rootTraversal(done).cells.name).toBe("John");
      expect(rootTraversal(done).cells.age).toBe(30);
    });

    const GROUP_ARRAY_SOURCE = `
"arc";

function Main() {
  let name = Str();
  let findings = Array(Str({ observing: \`a finding the user mentioned\` }));
  name.observing = \`the user's name\`;
  $observe({ name, findings });
}
`;

    function startGroupArrayRun() {
      const document = parse(GROUP_ARRAY_SOURCE);
      const runtime = new Runtime().add("group-array-arc", document).init();
      const seeded = runtime.newTraversal(arc("group-array-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      return { runtime, brief };
    }

    it("briefs an array group field with element metadata and writes its whole list", () => {
      const { runtime, brief } = startGroupArrayRun();
      const group = groupObservation(brief.observations[0]);
      const findingsField = group.fields.find(
        (field) => field.cell === "findings",
      );
      expect(findingsField!.meta).toEqual({
        type: "array",
        element: { type: "string" },
      });

      const done = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              findings: { status: "resolved", value: ["one", "two"] },
            },
          },
        },
      });
      expect(rootTraversal(done).cells.name).toBe("John");
      expect(rootTraversal(done).cells.findings).toEqual(["one", "two"]);
      expect("observations" in done).toBe(false);
    });

    it("writes nothing and re-emits when an array group field has a bad element", () => {
      const { runtime, brief } = startGroupArrayRun();
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            fields: {
              name: { status: "resolved", value: "John" },
              findings: { status: "resolved", value: ["one", 2] },
            },
          },
        },
      });
      expect(next.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          reasonCode: "observation-type",
        }),
      ]);
      // The group is atomic: the valid sibling field is not written either.
      expect(rootTraversal(next).cells.name).toBeUndefined();
      expect(rootTraversal(next).cells.findings).toBeUndefined();
      expect(next.observations).toHaveLength(1);
    });
  });

  describe("act.observe-array", () => {
    it("briefs an array observation with element metadata and writes the whole list", () => {
      const document = parse(`
"arc";

function Main() {
  let findings = Array(Str({ observing: \`a finding \${user} mentioned\` }));
  $observe(findings);
}
`);
      const runtime = new Runtime().add("observe-array-arc", document).init();
      const seeded = runtime.newTraversal(arc("observe-array-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(singleObservation(brief.observations[0]).meta).toEqual({
        type: "array",
        element: { type: "string" },
      });

      const done = progressTerminal(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: ["one", "two"],
          },
        },
      });

      expect(rootTraversal(done).cells.findings).toEqual(["one", "two"]);
      expect(rootTraversal(done).phase).toBe("completed");
    });

    it("rejects an array observation whose element fails the element type", () => {
      const document = parse(`
"arc";

function Main() {
  let scores = Array(Num({ observeAs: { kind: "integer", min: 1, max: 5 } }));
  $observe(scores);
}
`);
      const runtime = new Runtime()
        .add("observe-array-type-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("observe-array-type-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: [1, 9],
          },
        },
      });

      expect(next.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          briefId: brief.observations[0]!.id,
          reasonCode: "observation-range",
        }),
      ]);
      expect(rootTraversal(next).cells.scores).toBeUndefined();
    });
  });
});
