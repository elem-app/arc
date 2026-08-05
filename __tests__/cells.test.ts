/**
 * Behavior tests for the Cells area (`cell.*` entries in specs/testing.md).
 *
 * Ported from `parser.test.ts` and `runtime.test.ts` per the coverage manifest.
 * Every case feeds a deterministic Arc source string and injects semantic
 * results through reports, so there is no nondeterminism.
 */
import { parseExpressionAt } from "acorn";
import { describe, expect, it } from "vitest";

import { parseCellTarget } from "../src/parser/ast.js";
import { analyzeDocument, parse } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type { Dialog, SetAction } from "../src/types.js";
import { nodeSegKey } from "../src/types.js";
import {
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  renderSemanticTextForTest,
  rootTraversal,
  singleObservations,
  startRun,
  startTrigger,
} from "./helpers.js";

describe("cells", () => {
  describe("cell.declaration-form", () => {
    it("accepts call-form declarations for every cell type", () => {
      const document = parse(`
"arc";
function Main() {
  let interest = Enum(["cold", "warm"]);
  let ready = Bool();
  let note = Str();
  let score = RangedInt(1, 10);
  let cursor = Dialog.Cursor();
  let log = Artifact("research-log.md");
}
`);

      expect(
        document.roots[0]?.cells.map(({ name, type }) => ({ name, type })),
      ).toEqual([
        { name: "interest", type: "enum" },
        { name: "ready", type: "boolean" },
        { name: "note", type: "string" },
        { name: "score", type: "rangedInt" },
        { name: "cursor", type: "dialogCursor" },
        { name: "log", type: "artifact" },
      ]);
    });

    it.each([
      ["Enum", 'new Enum(["cold", "warm"])'],
      ["Bool", "new Bool()"],
      ["Str", "new Str()"],
      ["RangedInt", "new RangedInt(1, 10)"],
      ["Dialog.Cursor", "new Dialog.Cursor()"],
      ["Artifact", 'new Artifact("research-log.md")'],
    ])("rejects the former new %s declaration form", (_type, initializer) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  const value = ${initializer};
}
`),
      ).toThrow(
        /Arc cell declarations do not support new; use Type\(\.\.\.\) instead/,
      );
    });

    it("rejects new when another declarator uses the call form", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool(), legacy = new Bool();
}
`),
      ).toThrow(
        /Arc cell declarations do not support new; use Type\(\.\.\.\) instead/,
      );
    });

    it("rejects a non-cell declarator mixed with a cell declaration", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool(), local = 1;
}
`),
      ).toThrow(
        "Node-body declarations must use supported Arc cell constructors",
      );
    });
  });

  describe("cell.enum", () => {
    it("compares enum values with <= and !== by ordinal position", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm", "hot"]);
  interest.$set("warm");
  if (interest <= "hot") {
    $instruct(\`within\`);
  }
  if (interest != "cold") {
    $instruct(\`not cold\`);
  }
  if (interest <= "cold") {
    $instruct(\`too low\`);
  }
}
`);
      const runtime = new Runtime().add("enum-le-ne-arc", document);
      const seeded = runtime.newTraversal(arc("enum-le-ne-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["within"]);
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      expect(next.instructions.map((item) => item.text)).toEqual(["not cold"]);
    });

    it("compares enum values by ordinal position, not lexicographic order", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let interest = Enum(["cold", "lukewarm", "curious", "enthusiastic"]);
  let topic = Enum(["unknown", "metal"]);
  interest.observing = \`how interested is \${user}\`;

  this.effects = () => {
    $observe(interest);
    if (interest >= "curious") {
      topic.$set("metal");
    }
    if (topic == "metal") {
      Memoir.facts.$apply(\`\${user} is engaged\`);
    }
  };
}
`);

      const runtime = new Runtime().add("ordinal-arc", document);
      const seeded = runtime.newTraversal(arc("ordinal-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "kinda" }],
      });

      const lukewarmBrief = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: "lukewarm",
          },
        },
      });

      expect(rootTraversal(lukewarmBrief).cells.interest).toBe("lukewarm");
      expect(rootTraversal(lukewarmBrief).cells.topic).toBeUndefined();
      expect(lukewarmBrief.hostEffects).toEqual([]);

      const runtime2 = new Runtime().add("ordinal-arc", document);
      const seeded2 = runtime2.newTraversal(arc("ordinal-arc", "Main"));
      seeded2.phase = "entered";
      const brief2 = startRun(runtime2, [seeded2], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "very" }],
      });

      const curiousBrief = progressBrief(runtime2, brief2, {
        move: "proceed",
        observations: {
          [brief2.observations[0]!.id]: {
            status: "resolved",
            value: "curious",
          },
        },
      });

      expect(rootTraversal(curiousBrief).cells.interest).toBe("curious");
      expect(rootTraversal(curiousBrief).cells.topic).toBe("metal");
      expect(curiousBrief.hostEffects).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
      expect(
        renderSemanticTextForTest(curiousBrief.hostEffects[0]!.arguments[0]!),
      ).toBe("user is engaged");
    });

    it("compares enum cells by declaration order, not lexicographic order", () => {
      const document = parse(`
"arc";

function Main() {
  let level = Enum(["cold", "warm", "hot"]);
  level.$set("hot");

  if (level >= "warm") {
    $instruct(\`above warm\`);  }
  if (level < "warm") {
    $instruct(\`below warm\`);  }
  if (level > "cold") {
    $instruct(\`above cold\`);  }
}
`);
      const runtime = new Runtime().add("enum-arc", document);
      const seeded = runtime.newTraversal(arc("enum-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "above warm",
      ]);
      const next = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      expect(next.instructions.map((item) => item.text)).toEqual([
        "above cold",
      ]);
    });
  });

  describe("cell.enum-invalid", () => {
    it("returns invalid-item when $observe() values do not match the cell type", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;
  $observe(interest);
}
`);
      const runtime = new Runtime().add("observe-type-arc", document);
      const seeded = runtime.newTraversal(arc("observe-type-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

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

    it("applies the valid subset while an out-of-values enum item re-yields", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;

  this.trigger = () => {
    $observe(interest);
    if (interest == "warm") {
      return true;
    }
    return false;
  };
}

function Other() {
  let topic = Str();
  topic.observing = \`what topic did \${user} mention\`;

  this.trigger = () => {
    $observe(topic);
    return false;
  };
}
`);
      const runtime = new Runtime().add("enum-subset-arc", document);
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "metal is great" }],
      };
      const brief = startTrigger(runtime, dialog);
      expect(brief.observations).toHaveLength(2);
      const interestItem = singleObservations(brief).find(
        (item) => item.cell === "interest",
      );
      const topicItem = singleObservations(brief).find(
        (item) => item.cell === "topic",
      );

      const next = runtime.progressTrigger(
        brief,
        {
          observations: {
            [interestItem!.id]: { status: "resolved", value: "scorching" },
            [topicItem!.id]: { status: "resolved", value: "metal" },
          },
        },
        dialog,
      );

      expect(next.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          briefId: interestItem!.id,
          reasonCode: "observation-enum",
        }),
      ]);
      expect(next.matched).toBeUndefined();
      expect(next.observations.map((item) => item.id)).toEqual([
        interestItem!.id,
      ]);

      const resolved = runtime.progressTrigger(
        next,
        {
          observations: {
            [interestItem!.id]: { status: "resolved", value: "warm" },
          },
        },
        dialog,
      );

      expect(resolved.matched).toEqual(arc("enum-subset-arc", "Main"));
      const matched = resolved.traversals.find(
        (t) => t.ref === resolved.matched,
      );
      expect(matched?.cells.interest).toBe("warm");
      const other = resolved.traversals.find(
        (t) => t.ref === arc("enum-subset-arc", "Other"),
      );
      expect(other?.cells.topic).toBe("metal");
    });
  });

  describe("cell.bool", () => {
    it("accepts observing config in cell declaration forms", () => {
      const document = parse(`
"arc";
function Main() {
  let ready = Bool({
    observing: \`is \${user} ready\`,
  });
  let note = Str({
    observing: \`what note did \${user} give\`,
  });
  let interest = Enum(["cold", "warm"], {
    observing: \`how interested is \${user}\`,
  });
  let skill = RangedInt(1, 10, {
    observing: \`how skilled is \${user}\`,
  });
}
`);

      expect(document.roots[0]?.cells.map((item) => item.name)).toEqual([
        "ready",
        "note",
        "interest",
        "skill",
      ]);
      expect(
        document.roots[0]?.cells.map((item) =>
          item.type === "dialogCursor" ||
          item.type === "artifact" ||
          item.type === "array"
            ? undefined
            : item.observing,
        ),
      ).toEqual([
        expect.objectContaining({ kind: "template-string" }),
        expect.objectContaining({ kind: "template-string" }),
        expect.objectContaining({ kind: "template-string" }),
        expect.objectContaining({ kind: "template-string" }),
      ]);
    });
  });

  describe("cell.str", () => {
    it("parses Str as an observable string cell", () => {
      const document = parse(`
"arc";
function Main() {
  let note = Str();
  note.observing = \`what plain text should be stored\`;
  note.$set("hello");
}
`);

      expect(document.roots[0]?.cells).toEqual([
        {
          name: "note",
          type: "string",
          observing: expect.objectContaining({ kind: "template-string" }),
          loc: expect.any(Object),
        },
      ]);
      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        target: ["note"],
        value: { kind: "literal", value: "hello" },
      });
    });

    it("stores arbitrary Str values from observation and set()", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str({
    observing: \`what topic did \${user} mention\`,
  });
  let summary = Str();

  $observe(topic);
  summary.$set("plain free-form text");

  if (/metal/.test(topic)) {
    $instruct(\`topic matched\`);  }
}
`);
      const runtime = new Runtime().add("str-observe-arc", document);
      const seeded = runtime.newTraversal(arc("str-observe-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(singleObservations(brief)[0]?.meta).toEqual({
        type: "string",
        values: undefined,
        min: undefined,
        max: undefined,
      });

      const nextBrief = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: "black metal history",
          },
        },
      });

      expect(rootTraversal(nextBrief).cells.topic).toBe("black metal history");
      expect(rootTraversal(nextBrief).cells.summary).toBe(
        "plain free-form text",
      );
      expect(nextBrief.instructions.map((item) => item.text)).toEqual([
        "topic matched",
      ]);
    });

    it("returns invalid-item when Str observations resolve to non-strings", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str({
    observing: \`what topic did \${user} mention\`,
  });
  $observe(topic);
}
`);
      const runtime = new Runtime().add("str-observe-type-arc", document);
      const seeded = runtime.newTraversal(arc("str-observe-type-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      const nextBrief = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: {
            status: "resolved",
            value: 42,
          },
        },
      });

      expect(nextBrief.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          briefId: brief.observations[0]!.id,
          reasonCode: "observation-type",
        }),
      ]);
      expect(nextBrief.observations.map((item) => item.id)).toEqual([
        brief.observations[0]!.id,
      ]);
    });
  });

  describe("cell.ranged-int", () => {
    it("compares RangedInt values at the declared boundaries", () => {
      const document = parse(`
"arc";

function Main() {
  let score = RangedInt(1, 20);
  score.$set(20);
  if (score >= 20) {
    $instruct(\`at max\`);
  }
  if (score > 20) {
    $instruct(\`beyond max\`);
  }
  if (score <= 1) {
    $instruct(\`at min\`);
  }
}
`);
      const runtime = new Runtime().add("ranged-int-compare-arc", document);
      const seeded = runtime.newTraversal(
        arc("ranged-int-compare-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["at max"]);
      expect(rootTraversal(brief).cells.score).toBe(20);
    });

    it("carries RangedInt bounds in observation meta and rejects out-of-range values", () => {
      const document = parse(`
"arc";

function Main() {
  let score = RangedInt(1, 20, {
    observing: \`how skilled is \${user}\`,
  });
  $observe(score);
}
`);
      const runtime = new Runtime().add("ranged-int-observe-arc", document);
      const seeded = runtime.newTraversal(
        arc("ranged-int-observe-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(singleObservations(brief)[0]!.meta).toEqual({
        type: "rangedInt",
        min: 1,
        max: 20,
      });

      const rejected = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: 42 },
        },
      });

      expect(rejected.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          briefId: brief.observations[0]!.id,
          reasonCode: "observation-range",
        }),
      ]);
      expect(rejected.observations.map((item) => item.id)).toEqual([
        brief.observations[0]!.id,
      ]);
    });
  });

  describe("cell.ranged-int-bounds", () => {
    it("poisons traversal when set() writes a RangedInt outside its bounds", () => {
      const document = parse(`
"arc";

function Main() {
  let score = RangedInt(0, 10);
  score.$set(11);
}
`);
      const runtime = new Runtime().add("ranged-int-bounds-arc", document);
      const seeded = runtime.newTraversal(arc("ranged-int-bounds-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cell-out-of-range",
          reason: expect.stringContaining("outside 0..10"),
        }),
      ]);
    });
  });

  describe("cell.cursor", () => {
    it("rejects observing Dialog cursor cells", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  $observe(startedAt);
}
`),
      ).toThrow(/observe\(\) requires an observable cell: startedAt/);

      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  $observeOrAsk(startedAt);
}
`),
      ).toThrow(/observeOrAsk\(\) requires an observable cell: startedAt/);
    });

    it("poisons traversal for non-cursor assignments to cursor cells", () => {
      const numberAssignment = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(1);
}
`);
      const runtime2 = new Runtime().add(
        "dialog-number-cursor-arc",
        numberAssignment,
      );
      const seeded2 = runtime2.newTraversal(
        arc("dialog-number-cursor-arc", "Main"),
      );
      seeded2.phase = "entered";
      const invalidAssignment = startRun(runtime2, [seeded2], EMPTY_DIALOG);
      expect(rootTraversal(invalidAssignment).phase).toBe("poisoned");
      expect(invalidAssignment.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-dialog-cursor",
          reason: expect.stringContaining("must be a valid Dialog cursor"),
        }),
      ]);
    });

    it("snapshots Dialog.cursor and counts scoped turns locally", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  this.hostParams = { consumer: { id: "reviewer" } };

  startedAt.$set(Dialog.cursor);

  $instructLoop(\`wait\`, {
    resolveWhen: () => {
      return Dialog.cursor.userTurnsSince(startedAt) >= 2 &&
        Dialog.cursor.selfTurnsSince(startedAt) >= 1 &&
        Dialog.cursor.totalTurnsSince(startedAt) >= 3;
    },
  });
}
`);

      const runtime = new Runtime().add("dialog-cursor-arc", document);
      const seeded = runtime.newTraversal(arc("dialog-cursor-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.hostCalls).toEqual([]);
      expect(first.instructions.map((item) => item.text)).toEqual(["wait"]);
      expect(rootTraversal(first).cells.startedAt).toEqual({
        user: 0,
        self: 0,
      });

      const second = progressBrief(
        runtime,
        first,
        { move: "proceed" },
        { cursor: { user: 2, self: 1 }, lastTurns: [] },
      );
      expect(second.hostCalls).toEqual([]);
      expect(second.instructions.map((item) => item.text)).toEqual([]);
      expect(rootTraversal(second).phase).toBe("completed");
    });
  });

  describe("cell.is-unset", () => {
    it("reads unset state reactively and treats falsey assigned values as defined", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  let note = Str();
  let count = RangedInt(0, 10);
  let mark = Dialog.Cursor();

  if (
    ready.isUnset() &&
    note.isUnset() &&
    count.isUnset() &&
    mark.isUnset()
  ) {
    $instruct(\`unset\`);
  }

  ready.$set(false);
  note.$set("");
  count.$set(0);
  mark.$set(Dialog.cursor);

  if (
    !ready.isUnset() &&
    !note.isUnset() &&
    !count.isUnset() &&
    !mark.isUnset()
  ) {
    $instruct(\`defined\`);
  }
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "if",
        test: { kind: "logical" },
      });
      const readSet = analyzeDocument(document)
        .rewalkPlan.bySeg.get(document.roots[0]!)
        ?.get(nodeSegKey("body"));
      expect(readSet?.cells).toEqual(
        expect.arrayContaining(["ready", "note", "count", "mark"]),
      );

      const runtime = new Runtime().add("is-unset-arc", document);
      const seeded = runtime.newTraversal(arc("is-unset-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["unset"]);

      const second = progressBrief(runtime, first, {
        move: "proceed",
        instructions: appliedInstructions(first),
      });
      expect(second.instructions.map((item) => item.text)).toEqual(["defined"]);
      expect(rootTraversal(second).cells).toMatchObject({
        ready: false,
        note: "",
        count: 0,
        mark: { user: 0, self: 0 },
      });
    });

    it("distinguishes an unknown observation from an observed value", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str({
    observing: \`what topic did \${user} mention\`,
  });

  $observe(topic);
  if (topic.isUnset()) {
    $instruct(\`unset\`);
  } else {
    $instruct(\`observed\`);
  }
}
`);

      const run = (name: string) => {
        const runtime = new Runtime().add(name, document);
        const seeded = runtime.newTraversal(arc(name, "Main"));
        seeded.phase = "entered";
        return { runtime, first: startRun(runtime, [seeded], EMPTY_DIALOG) };
      };

      const unknown = run("is-unset-unknown-arc");
      const afterUnknown = progressBrief(unknown.runtime, unknown.first, {
        move: "proceed",
        observations: {
          [unknown.first.observations[0]!.id]: { status: "unknown" },
        },
      });
      expect(afterUnknown.instructions.map((item) => item.text)).toEqual([
        "unset",
      ]);

      const observed = run("is-unset-observed-arc");
      const afterObserved = progressBrief(observed.runtime, observed.first, {
        move: "proceed",
        observations: {
          [observed.first.observations[0]!.id]: {
            status: "resolved",
            value: "metal",
          },
        },
      });
      expect(afterObserved.instructions.map((item) => item.text)).toEqual([
        "observed",
      ]);
    });

    it("rejects arguments, unknown cells, and mention-only Artifact cells", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool();
  if (ready.isUnset(true)) {}
}
`),
      ).toThrow(/does not accept arguments/);

      expect(() =>
        parse(`
"arc";
function Main() {
  if (missing.isUnset()) {}
}
`),
      ).toThrow(/Unknown cell: missing/);

      expect(() =>
        parse(`
"arc";
function Main() {
  let report = Artifact("report.md");
  if (report.isUnset()) {}
}
`),
      ).toThrow(/Cell cannot be used as an expression value: report/);
    });
  });

  describe("cell.artifact", () => {
    it("parses Artifact as a non-observable local cell", () => {
      const document = parse(`
"arc";
function Main() {
  let note = Artifact("research-log.md");
  $instruct(\`Update \${note}.\`);}
`);

      expect(document.roots[0]?.cells).toEqual([
        {
          name: "note",
          type: "artifact",
          path: "research-log.md",
          loc: expect.any(Object),
        },
      ]);
    });

    it("rejects artifacts in scalar value positions", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact("research-log.md");
  if (note) {
    $instruct(\`bad\`);  }
}
`),
      ).toThrow(/NON_VALUE_CELL/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact("research-log.md");
  note.$set("bad");
}
`),
      ).toThrow(/NON_SETTABLE_CELL/);
    });

    it("rejects artifacts inside activation triggers", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact("research-log.md");
  this.trigger = () => {
    return judge(\`should use \${note}\`);
  };
  $instruct(\`ok\`);}
`),
      ).toThrow(/ARTIFACT_IN_TRIGGER/);
    });

    it("rejects observing artifact cells", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let log = Artifact("log.md");
  $observe(log);
}
`),
      ).toThrow(/observe\(\) requires an observable cell/);

      expect(() =>
        parse(`
"arc";

function Main() {
  let log = Artifact("log.md");
  $observeOrAsk(log);
}
`),
      ).toThrow(/observeOrAsk\(\) requires an observable cell/);
    });

    it("preserves entity and artifact references in host-facing semantic text", () => {
      const instructionDocument = parse(`
"arc";

function Main() {
  let note = Artifact("research-log.md");
  let topic = Enum(["pricing", "support"]);
  topic.$set("pricing");
  $instruct(\`Tell \${user} to update \${note} with \${topic}.\`);
}
`);
      const instructionRuntime = new Runtime().add(
        "semantic-text-instruction-arc",
        instructionDocument,
      );
      const instructionTraversal = instructionRuntime.newTraversal(
        arc("semantic-text-instruction-arc", "Main"),
      );
      instructionTraversal.phase = "entered";
      const instructionBrief = startRun(
        instructionRuntime,
        [instructionTraversal],
        EMPTY_DIALOG,
      );
      expect(instructionBrief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Tell " },
        { kind: "entity", name: "user" },
        { kind: "text", value: " to update " },
        { kind: "artifact", path: "research-log.md" },
        { kind: "text", value: " with pricing." },
      ]);

      const observationDocument = parse(`
"arc";

function Main() {
  let ready = Bool();
  let note = Artifact("research-log.md");
  $observe(ready, \`Is \${user} ready after reading \${note}?\`);
}
`);
      const observationRuntime = new Runtime().add(
        "semantic-text-observation-arc",
        observationDocument,
      );
      const observationTraversal = observationRuntime.newTraversal(
        arc("semantic-text-observation-arc", "Main"),
      );
      observationTraversal.phase = "entered";
      const observationBrief = startRun(
        observationRuntime,
        [observationTraversal],
        EMPTY_DIALOG,
      );
      expect(singleObservations(observationBrief)[0]?.question).toEqual([
        { kind: "text", value: "Is " },
        { kind: "entity", name: "user" },
        { kind: "text", value: " ready after reading " },
        { kind: "artifact", path: "research-log.md" },
        { kind: "text", value: "?" },
      ]);

      const judgmentDocument = parse(`
"arc";

function Main() {
  let note = Artifact("research-log.md");
  if (judge(\`Should \${self} use \${note}?\`)) {
    $instruct(\`Proceed.\`);  }
}
`);
      const judgmentRuntime = new Runtime().add(
        "semantic-text-judgment-arc",
        judgmentDocument,
      );
      const judgmentTraversal = judgmentRuntime.newTraversal(
        arc("semantic-text-judgment-arc", "Main"),
      );
      judgmentTraversal.phase = "entered";
      const judgmentBrief = startRun(
        judgmentRuntime,
        [judgmentTraversal],
        EMPTY_DIALOG,
      );
      expect(judgmentBrief.judgments[0]?.question).toEqual([
        { kind: "text", value: "Should " },
        { kind: "entity", name: "self" },
        { kind: "text", value: " use " },
        { kind: "artifact", path: "research-log.md" },
        { kind: "text", value: "?" },
      ]);
    });
  });

  describe("cell.artifact-template", () => {
    it("parses Artifact path templates as value expressions", () => {
      const document = parse(`
"arc";
function Main() {
  let slug = Str();
  let note = Artifact(\`\${slug}.md\`);
}
`);

      expect(document.roots[0]?.cells).toEqual([
        {
          name: "slug",
          type: "string",
          loc: expect.any(Object),
        },
        {
          name: "note",
          type: "artifact",
          path: {
            kind: "template-string",
            parts: [
              {
                kind: "expression",
                expression: { kind: "cell", name: "slug" },
              },
              { kind: "text", value: ".md" },
            ],
          },
          loc: expect.any(Object),
        },
      ]);
    });

    it("rejects invalid artifact paths", () => {
      for (const path of [
        "",
        "/absolute.md",
        ".",
        "..",
        "./x.md",
        "x/./y.md",
        "x/../y.md",
      ]) {
        expect(() =>
          parse(`
"arc";
function Bad() {
  let note = Artifact("${path}");
}
`),
        ).toThrow(/Artifact note path/);
      }
    });

    it("rejects semantic-only interpolation in Artifact path templates", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact(\`\${user}.md\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);
    });

    it("rejects briefable interpolation in Artifact path templates", () => {
      expect(() =>
        parse(`
"arc";
import Slugs from "host:slugs";

function Bad() {
  let note = Artifact(\`\${Slugs.next()}.md\`);
}
`),
      ).toThrow(/Artifact note path cannot contain judge\(\) or host call/);
    });

    it("renders dynamic Artifact path templates from cell state", () => {
      const document = parse(`
"arc";

function Main() {
  let slug = Str();
  let note = Artifact(\`notes/\${slug}.md\`);
  slug.$set("pricing");
  $instruct(\`Update \${note}.\`);
}
`);
      const runtime = new Runtime().add("dynamic-artifact-path-arc", document);
      const traversal = runtime.newTraversal(
        arc("dynamic-artifact-path-arc", "Main"),
      );
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Update " },
        { kind: "artifact", path: "notes/pricing.md" },
        { kind: "text", value: "." },
      ]);
    });

    it("poisons traversal when a dynamic Artifact path renders invalid", () => {
      const document = parse(`
"arc";

function Main() {
  let slug = Str();
  let note = Artifact(\`notes/\${slug}.md\`);
  slug.$set("../escape");
  $instruct(\`Update \${note}.\`);
}
`);
      const runtime = new Runtime().add(
        "invalid-dynamic-artifact-path-arc",
        document,
      );
      const traversal = runtime.newTraversal(
        arc("invalid-dynamic-artifact-path-arc", "Main"),
      );
      traversal.phase = "entered";

      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-artifact-path",
          reason: expect.stringContaining(
            'Artifact note path cannot contain "." or ".." segments',
          ),
        }),
      ]);
    });

    it("poisons traversal when an empty or absolute Artifact path renders", () => {
      const empty = parse(`
"arc";

function Main() {
  let slug = Str();
  let note = Artifact(\`\${slug}\`);
  slug.$set("");
  $instruct(\`Update \${note}.\`);
}
`);
      const emptyRuntime = new Runtime().add("empty-artifact-path-arc", empty);
      const emptySeeded = emptyRuntime.newTraversal(
        arc("empty-artifact-path-arc", "Main"),
      );
      emptySeeded.phase = "entered";
      const emptyBrief = startRun(emptyRuntime, [emptySeeded], EMPTY_DIALOG);
      expect(rootTraversal(emptyBrief).phase).toBe("poisoned");
      expect(emptyBrief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-artifact-path",
        }),
      ]);

      const absolute = parse(`
"arc";

function Main() {
  let slug = Str();
  let note = Artifact(\`/\${slug}.md\`);
  slug.$set("report");
  $instruct(\`Update \${note}.\`);
}
`);
      const absoluteRuntime = new Runtime().add(
        "absolute-artifact-path-arc",
        absolute,
      );
      const absoluteSeeded = absoluteRuntime.newTraversal(
        arc("absolute-artifact-path-arc", "Main"),
      );
      absoluteSeeded.phase = "entered";
      const absoluteBrief = startRun(
        absoluteRuntime,
        [absoluteSeeded],
        EMPTY_DIALOG,
      );
      expect(rootTraversal(absoluteBrief).phase).toBe("poisoned");
      expect(absoluteBrief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-artifact-path",
        }),
      ]);
    });
  });

  describe("cell.observing", () => {
    it("rejects invalid cell declaration configs", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool(\`is \${user} ready\`);
}
`),
      ).toThrow(/Bool cell ready config must be an object literal/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool({
    observed: \`is \${user} ready\`,
  });
}
`),
      ).toThrow(/unsupported config key: observed/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let ready = Bool({
    observing: 1,
  });
}
`),
      ).toThrow(/Semantic text must be a string or template literal/);
    });

    it.each([
      [
        "duplicate declaration keys",
        `let topic = Str({
    observing: \`first\`,
    observing: \`second\`,
  });`,
      ],
      [
        "a declaration config followed by an assignment",
        `let topic = Str({ observing: \`first\` });
  topic.observing = \`second\`;`,
      ],
      [
        "repeated assignments",
        `let topic = Str();
  topic.observing = \`first\`;
  topic.observing = \`second\`;`,
      ],
    ])("rejects %s", (_case, declaration) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  ${declaration}
}
`),
      ).toThrow("Duplicate cell config assignment: topic.observing");
    });

    it("prefers the per-call observation question over the declared observing", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"], {
    observing: \`default question\`,
  });
  let ready = Bool({
    observing: \`default readiness\`,
  });
  $observe(interest, \`override question\`);
  $observeOrAsk(ready, \`override ask\`);
}
`);
      const runtime = new Runtime().add("observe-override-arc", document);
      const seeded = runtime.newTraversal(arc("observe-override-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.observations).toHaveLength(1);
      expect(brief.observations[0]!.mode).toBe("observe");
      expect(
        renderSemanticTextForTest(singleObservations(brief)[0]!.question),
      ).toBe("override question");

      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "warm" },
        },
      });
      expect(next.observations).toHaveLength(1);
      expect(next.observations[0]!.mode).toBe("observeOrAsk");
      expect(
        renderSemanticTextForTest(singleObservations(next)[0]!.question),
      ).toBe("override ask");
    });

    it("rejects this.observing and accepts cell.$set()", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  this.observing = \`nope\`;
}
`),
      ).toThrow(/this\.observing is not supported/);

      const document = parse(`
"arc";
function Good() {
  let ready = Bool();
  ready.$set(true);
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        target: ["ready"],
        value: { kind: "literal", value: true },
      });
    });
  });

  describe("cell.bare-boolean", () => {
    it.each([
      ["branch condition", "ready"],
      ["logical AND operand", "ready && true"],
      ["logical OR operand", "false || ready"],
      ["negation operand", "!ready"],
      ["ternary condition", "ready ? true : false"],
    ])("warns on a bare cell in a %s", (_label, expression) => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(true);
  if (${expression}) {
    $instruct(\`go\`);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "bare-cell-boolean",
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "bare-cell-boolean",
          severity: "warning",
        }),
      ]);
    });

    it("warns inside a value expression and a boolean hook return", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  let result = Bool();
  this.trigger = () => {
    $observe(ready);
    return ready;
  };
  result.$set(ready && true);
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "bare-cell-boolean",
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({ severity: "warning" }),
        expect.objectContaining({ severity: "warning" }),
      ]);
    });

    it("does not warn on explicit equality or isUnset()", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (ready == true) {
    $instruct(\`ready\`);
  }
  if (ready.isUnset()) {
    ready.$set(true);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "bare-cell-boolean",
      );

      expect(lintIssues).toEqual([]);
    });
  });

  describe("cell.boolean-position", () => {
    const booleanTest = (decl: string, test: string) =>
      `"arc";\nfunction Main() { ${decl} if (${test}) { $instruct(\`go\`); } }`;

    it.each([
      ["a Str cell", `let x = Str(); x.$set('a');`],
      ["a RangedInt cell", `let x = RangedInt(1, 10); x.$set(3);`],
      ["an Enum cell", `let x = Enum(['low', 'high']); x.$set('high');`],
      [
        "a Dialog.Cursor cell",
        `let x = Dialog.Cursor(); x.$set(Dialog.cursor);`,
      ],
    ])("rejects %s used directly as a boolean", (_label, decl) => {
      for (const test of [
        "x",
        "x && true",
        "false || x",
        "!x",
        "x ? true : false",
      ]) {
        expect(() => parse(booleanTest(decl, test))).toThrow(
          /NON_BOOLEAN_CONDITION/,
        );
      }
    });

    it("accepts an explicit comparison of a non-Bool cell", () => {
      expect(() =>
        parse(booleanTest(`let x = RangedInt(1, 10); x.$set(3);`, "x > 0")),
      ).not.toThrow();
    });

    it("rejects a non-boolean && operand in a value position", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let s = Str(); s.$set('a'); let f = Bool(); f.$set(s && true); $instruct(\`go\`); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("rejects a non-boolean value in a trigger if-test", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let topic = Str(); this.trigger = () => { $observe(topic); if (topic) { return true; } return false; }; $instruct(\`go\`); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("rejects a non-boolean trigger return", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let topic = Str(); this.trigger = () => topic; $instruct(\`go\`); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("rejects a non-boolean catchDeflection return", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let topic = Str(); this.catchDeflection = () => topic; topic.$set("pricing"); $instruct(\`go\`); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("checks statically typed array elements and map spans in boolean positions", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); items.$set(["x"]); if (items[0]) { $instruct(\`go\`); } }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); items.$set(["x"]); items.$map(() => { if (span.item) { $instruct(\`go\`); } }); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); items.$set(["x"]); items.$map(() => { if (span.index) { $instruct(\`go\`); } }); }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Bool()); items.$set([true]); if (items[0]) { $instruct(\`element\`); } items.$map(() => { if (span.item) { $instruct(\`span\`); } }); }`,
        ),
      ).not.toThrow();
    });

    it("poisons when an unknown-typed host call resolves to a non-boolean condition", () => {
      const document = parse(`
"arc";

import Flags from "host:flags";

function Main() {
  if (Flags.enabled()) {
    $instruct(\`go\`);
  }
}
`);
      const runtime = new Runtime().add("host-boolean-position-arc", document);
      const seeded = runtime.newTraversal(
        arc("host-boolean-position-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);

      const poisoned = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: { [first.hostCalls[0]!.id]: "enabled" },
      });

      expect(rootTraversal(poisoned).phase).toBe("poisoned");
      expect(poisoned.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "non-boolean-value",
        }),
      ]);
    });
  });

  describe("cell.dead-read", () => {
    it("errors on a cell read but never assigned anywhere in scope", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (ready == true) {
    $instruct(\`go\`);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("notices a cell read before it is set on the same path", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (ready == true) {
    $instruct(\`go\`);
  }
  ready.$set(true);
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-before-assignment",
          severity: "notice",
        }),
      ]);
    });

    it("treats a decorated write as a root read rather than initialization", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items[0].$set("x");
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("records a dynamic target accessor as a cell read", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let index = RangedInt(0, 1);
  items.$set(["a", "b"]);
  items[index].$set("x");
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("accepts a cell set before it is read", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(true);
  if (ready == true) {
    $instruct(\`go\`);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([]);
    });

    it("counts a cell interpolated into instruction text as a read", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  $instruct(\`let us talk about \${topic}\`);
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("notices a semantic-text read before the cell is set", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  $instruct(\`let us talk about \${topic}\`);
  topic.$set(\`pricing\`);
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-before-assignment",
          severity: "notice",
        }),
      ]);
    });

    it("counts a $map results array as an assignment of that cell", () => {
      const document = parse(`
"arc";

function Main() {
  let items = Array(Str());
  let labels = Array(Str());
  items.$set(["a", "b"]);
  items.$map(() => span.result.$set(span.item), labels);
  $instruct(\`Report \${labels}.\`);
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([]);
    });

    it("errors on a $map over a receiver array that is never assigned", () => {
      const document = parse(`
"arc";

function Main() {
  let items = Array(Str());
  items.$map(() => $instruct(\`Review \${span.item}.\`));
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("errors on a $map callback reading a cell nothing assigns", () => {
      const document = parse(`
"arc";

function Main() {
  let items = Array(Str());
  let tone = Str();
  items.$set(["a"]);
  items.$map(() => $instruct(\`Review \${span.item} in a \${tone} tone.\`));
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-without-assignment",
          severity: "error",
        }),
      ]);
    });

    it("accepts a cell a $map callback assigns and a later statement reads", () => {
      const document = parse(`
"arc";

function Main() {
  let items = Array(Str());
  let reviewed = Bool();
  items.$set(["a"]);
  items.$map(() => reviewed.$set(true));
  if (reviewed == true) {
    $instruct(\`done\`);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      // The callback assigns it, so the read is not dead; an empty input runs
      // the callback zero times, so the read is still ordered before a certain
      // assignment.
      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "read-before-assignment",
          severity: "notice",
        }),
      ]);
    });

    it("does not flag a child reading a cell its ancestor assigns", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.$set(true);
  $enter(Child);

  function Child() {
    if (ready == true) {
      $instruct(\`go\`);
    }
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter((issue) =>
        issue.code.startsWith("read-"),
      );

      expect(lintIssues).toEqual([]);
    });

    it("poisons traversal when value-template interpolation is unset", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  let summary = Str();
  summary.$set(\`topic-\${topic}\`);
}
`);

      const runtime = new Runtime().add("value-string-unset-arc", document);
      const seeded = runtime.newTraversal(
        arc("value-string-unset-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reason: expect.stringContaining(
            "Template interpolation must resolve to a primitive value",
          ),
        }),
      ]);
    });

    it("poisons traversal when semantic-text interpolation is unset", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  $instruct(\`talk about \${topic}\`);
  topic.$set(\`pricing\`);
}
`);

      const runtime = new Runtime().add("semantic-string-unset-arc", document);
      const seeded = runtime.newTraversal(
        arc("semantic-string-unset-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-template-interpolation",
        }),
      ]);
    });

    it("poisons traversal when set() reads an unset cell", () => {
      const document = parse(`
"arc";

function Main() {
  let source = Str();
  let copy = Str();
  copy.$set(source);
}
`);
      const runtime = new Runtime().add("dead-read-set-arc", document);
      const seeded = runtime.newTraversal(arc("dead-read-set-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-cell-assignment",
        }),
      ]);
    });

    // Pins reference validation: undeclared cell references reject at parse.
    it("rejects unknown cell references", () => {
      const source = `
"arc";
function Bad() {
  if (missing == true) {
    $enter(Step);
  }
  function Step() {
    $instruct(\`hi\`);  }
}
`;

      expect(() => parse(source)).toThrow(/UNKNOWN_CELL/);
    });
  });

  describe("cell.array", () => {
    it("parses Array(elementCell) as an array cell carrying its element spec", () => {
      const document = parse(`
"arc";
function Main() {
  let findings = Array(Str({ observing: \`a finding \${user} mentioned\` }));
  let scores = Array(RangedInt(1, 5));
}
`);

      expect(document.roots[0]?.cells).toEqual([
        {
          name: "findings",
          type: "array",
          element: {
            type: "string",
            observing: expect.objectContaining({ kind: "template-string" }),
          },
          loc: expect.any(Object),
        },
        {
          name: "scores",
          type: "array",
          element: { type: "rangedInt", min: 1, max: 5 },
          loc: expect.any(Object),
        },
      ]);
    });

    it("rejects a bare element constructor, nesting, and extra arguments in Array()", () => {
      expect(() =>
        parse(`"arc";\nfunction Main() { let findings = Array(Str); }`),
      ).toThrow(/element must be a constructed scalar cell/);
      expect(() =>
        parse(`"arc";\nfunction Main() { let grid = Array(Array(Str())); }`),
      ).toThrow(/cannot nest arrays/);
      expect(() =>
        parse(`"arc";\nfunction Main() { let two = Array(Str(), Str()); }`),
      ).toThrow(/takes exactly one element constructor/);
    });

    it("parses direct and decorated cell targets into root-plus-accessor tuples", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let index = RangedInt(0, 10);
  items.$set(["a", "b"]);
  items[0].$set("x");
  items[index].$set("y");
  $observe(items[index]);
}
`);

      expect(document.roots[0]?.statements).toMatchObject([
        { kind: "set", target: ["items"] },
        {
          kind: "set",
          target: ["items", { kind: "literal", value: 0 }],
        },
        {
          kind: "set",
          target: ["items", { kind: "cell", name: "index" }],
        },
        {
          kind: "observe",
          target: ["items", { kind: "cell", name: "index" }],
        },
      ]);
    });

    it("normalizes raw nested cell-target AST accessors from root outward", () => {
      // Current cell schemas reject this path during document validation. Call
      // the AST helper directly to protect recursive normalization order.
      const nested = parseExpressionAt("a.b[i]", 0, {
        ecmaVersion: "latest",
      });
      const dotted = parseExpressionAt("a.b", 0, { ecmaVersion: "latest" });
      const bracketed = parseExpressionAt('a["b"]', 0, {
        ecmaVersion: "latest",
      });

      expect(parseCellTarget(nested)).toEqual([
        "a",
        { kind: "literal", value: "b" },
        { kind: "cell", name: "i" },
      ]);
      expect(parseCellTarget(dotted)).toEqual(parseCellTarget(bracketed));
    });

    it("normalizes dot access as a string accessor and rejects scalar traversal", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items.value.$set("x");
}
`);
      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        target: ["items", { kind: "literal", value: "value" }],
      });

      expect(() =>
        parse(`
"arc";
function Main() {
  let item = Str();
  item.value.$set("x");
}
`),
      ).toThrow(/CELL_TARGET_NON_CONTAINER/);
    });

    it("rejects access past an array's scalar element", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let items = Array(Str());
  items[0][0].$set("x");
}
`),
      ).toThrow(/CELL_TARGET_NON_CONTAINER/);
    });

    it("keeps unset direct-only and keeps returns root assignment unsupported", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let items = Array(Str());
  items[0].$unset();
}
`),
      ).toThrow(/\$unset\(\) requires a direct cell target/);
      expect(() =>
        parse(`
"arc";
function Main() {
  returns.$set({ value: true });
}
`),
      ).toThrow(/returns\.\$set\(\.\.\.\) is not supported/);
    });
  });

  describe("cell.array-values", () => {
    it("stores a whole array literal via $set", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items.$set(["a", "b", "c"]);
}
`);
      const runtime = new Runtime().add("array-set-arc", document);
      const seeded = runtime.newTraversal(arc("array-set-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.items).toEqual(["a", "b", "c"]);
    });

    it("replaces one existing array element without changing its siblings", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items.$set(["a", "b", "c"]);
  items[1].$set("B");
}
`);
      const runtime = new Runtime().add("array-element-set-arc", document);
      const seeded = runtime.newTraversal(arc("array-element-set-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.items).toEqual(["a", "B", "c"]);
    });

    it("uses a dynamic index for an array-element write", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let index = RangedInt(0, 10);
  items.$set(["a", "b", "c"]);
  index.$set(2);
  items[index].$set("C");
}
`);
      const runtime = new Runtime().add(
        "array-element-dynamic-set-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("array-element-dynamic-set-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.items).toEqual(["a", "b", "C"]);
    });

    it.each([
      ["unset", "", "unset-value"],
      ["fractional", 'items.$set(["a"]);', "invalid-array-index", "0.5"],
      ["out-of-range", 'items.$set(["a"]);', "array-index-out-of-range", "1"],
    ])(
      "poisons an element write with an %s array target",
      (_caseName, setup, reasonCode, index = "0") => {
        const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  ${setup}
  items[${index}].$set("x");
}
`);
        const runtime = new Runtime().add(
          `array-element-${_caseName}-arc`,
          document,
        );
        const seeded = runtime.newTraversal(
          arc(`array-element-${_caseName}-arc`, "Main"),
        );
        seeded.phase = "entered";

        const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

        expect(rootTraversal(brief).phase).toBe("poisoned");
        expect(brief.issues).toEqual([
          expect.objectContaining({
            kind: "poisoned-traversal",
            reasonCode,
          }),
        ]);
      },
    );

    it("poisons a hand-authored negative array target index", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  items.$set(["a"]);
  items[0].$set("x");
}
`);
      const action = document.roots[0]!.statements[1] as SetAction;
      action.target[1] = { kind: "literal", value: -1 };
      const runtime = new Runtime().add("array-element-negative-arc", document);
      const seeded = runtime.newTraversal(
        arc("array-element-negative-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-array-index",
        }),
      ]);
    });

    it("poisons a non-numeric dynamic array target index", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let index = Str();
  items.$set(["a"]);
  index.$set("first");
  items[index].$set("x");
}
`);
      const runtime = new Runtime().add(
        "array-element-string-index-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("array-element-string-index-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-array-index",
        }),
      ]);
    });

    it("validates an array-element write against the element bounds", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([3]);
  scores[0].$set(6);
}
`);
      const runtime = new Runtime().add("array-element-bounds-arc", document);
      const seeded = runtime.newTraversal(
        arc("array-element-bounds-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cell-out-of-range",
        }),
      ]);
    });

    it("clears a set array via $unset", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let wasSet = Bool();
  items.$set(["a", "b", "c"]);
  if (items.isUnset() == false) {
    wasSet.$set(true);
  }
  items.$unset();
}
`);
      const runtime = new Runtime().add("array-unset-arc", document);
      const seeded = runtime.newTraversal(arc("array-unset-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      // `wasSet` witnesses the array held a value; `$unset()` then cleared it.
      expect(rootTraversal(brief).cells.wasSet).toBe(true);
      expect(rootTraversal(brief).cells.items).toBeUndefined();
    });

    it("compares arrays structurally by value, order, and length", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let same = Bool();
  let reordered = Bool();
  let shorter = Bool();
  let different = Bool();
  let neqSame = Bool();
  let neqReordered = Bool();
  items.$set(["a", "b"]);
  if (items == ["a", "b"]) { same.$set(true); } else { same.$set(false); }
  if (items == ["b", "a"]) { reordered.$set(true); } else { reordered.$set(false); }
  if (items == ["a"]) { shorter.$set(true); } else { shorter.$set(false); }
  if (items == ["x", "y"]) { different.$set(true); } else { different.$set(false); }
  if (items != ["a", "b"]) { neqSame.$set(true); } else { neqSame.$set(false); }
  if (items != ["b", "a"]) { neqReordered.$set(true); } else { neqReordered.$set(false); }
}
`);
      const runtime = new Runtime().add("array-eq-arc", document);
      const seeded = runtime.newTraversal(arc("array-eq-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      const cells = rootTraversal(brief).cells;
      // Only the identical list matches; reordered, shorter, and value-different
      // lists compare unequal — an all-arrays-equal impl would fail these.
      expect(cells.same).toBe(true);
      expect(cells.reordered).toBe(false);
      expect(cells.shorter).toBe(false);
      expect(cells.different).toBe(false);
      // `!==` between two set arrays is the negation, distinguishing values —
      // an impl returning false for every set-array inequality would fail
      // `neqReordered`.
      expect(cells.neqSame).toBe(false);
      expect(cells.neqReordered).toBe(true);
    });

    it("applies the unset-comparison rule to an unset array", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let eqUnset = Bool();
  let neqUnset = Bool();
  eqUnset.$set(items == ["a"]);
  neqUnset.$set(items != ["a"]);
}
`);
      const runtime = new Runtime().add("array-unset-cmp-arc", document);
      const seeded = runtime.newTraversal(arc("array-unset-cmp-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.eqUnset).toBe(false);
      expect(rootTraversal(brief).cells.neqUnset).toBe(true);
    });

    it("interpolates an array value into a template as comma-joined text", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let summary = Str();
  items.$set(["a", "b", "c"]);
  summary.$set(\`items: \${items}\`);
}
`);
      const runtime = new Runtime().add("array-template-arc", document);
      const seeded = runtime.newTraversal(arc("array-template-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.summary).toBe("items: a,b,c");
    });

    it("rejects ordering, boolean, and negation of a whole array at parse", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); let f = Bool(); if (items > ["a"]) { f.$set(true); } }`,
        ),
      ).toThrow(/ARRAY_ORDERING/);
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); let f = Bool(); if (items && f) { f.$set(true); } }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let items = Array(Str()); let f = Bool(); if (!items) { f.$set(true); } }`,
        ),
      ).toThrow(/NON_BOOLEAN_CONDITION/);
    });

    it("poisons the traversal when a fractional value writes a ranged-int element", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([1, 2.5]);
}
`);
      const runtime = new Runtime().add("array-frac-arc", document);
      const seeded = runtime.newTraversal(arc("array-frac-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-cell-assignment",
        }),
      ]);
    });

    it("poisons the traversal when an out-of-range value writes an element", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([1, 9]);
}
`);
      const runtime = new Runtime().add("array-range-arc", document);
      const seeded = runtime.newTraversal(arc("array-range-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cell-out-of-range",
        }),
      ]);
    });
  });

  describe("cell.array-read", () => {
    it("reads an element by bracket index and reads length", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let first = Str();
  let count = RangedInt(0, 100);
  items.$set(["x", "y", "z"]);
  first.$set(items[0]);
  count.$set(items.length);
}
`);
      const runtime = new Runtime().add("array-read-arc", document);
      const seeded = runtime.newTraversal(arc("array-read-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.first).toBe("x");
      expect(rootTraversal(brief).cells.count).toBe(3);
    });

    it("poisons the traversal on an out-of-range index", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let first = Str();
  items.$set(["only"]);
  first.$set(items[3]);
}
`);
      const runtime = new Runtime().add("array-oob-arc", document);
      const seeded = runtime.newTraversal(arc("array-oob-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "array-index-out-of-range",
        }),
      ]);
    });

    it("poisons the traversal when indexing or reading length of an unset array", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let count = RangedInt(0, 100);
  count.$set(items.length);
}
`);
      const runtime = new Runtime().add("array-unset-arc", document);
      const seeded = runtime.newTraversal(arc("array-unset-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "unset-value",
        }),
      ]);
    });

    it("rejects reading length of a non-array cell at parse", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let note = Str(); let n = RangedInt(0, 9); n.$set(note.length); }`,
        ),
      ).toThrow(/LENGTH_NON_ARRAY/);
    });
  });
});
