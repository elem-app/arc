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
import { analyzeDocument, parse, validate } from "../src/parser/index.js";
import { createArtifactValue } from "../src/runtime/index.js";
import type { ArcTraversalSet, Dialog, SetAction } from "../src/types/index.js";
import { nodeSegKey } from "../src/types/index.js";
import {
  actionProgress,
  actionTerminal,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  renderSemanticTextForTest,
  rootTraversal,
  TestRuntime as Runtime,
  singleObservations,
  startRun,
  startTerminal,
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
        { name: "score", type: "number" },
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
    it("uses ordinal Enum ordering and ordinary string inequality", () => {
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
      const runtime = new Runtime().add("enum-le-ne-arc", document).init();
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

      const runtime = new Runtime().add("ordinal-arc", document).init();
      const seeded = runtime.newTraversal(arc("ordinal-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "kinda" }],
      });

      const lukewarmBrief = progressTerminal(runtime, brief, {
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
      expect("hostCalls" in lukewarmBrief).toBe(false);

      const runtime2 = new Runtime().add("ordinal-arc", document).init();
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
      expect(curiousBrief.hostCalls).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
      expect(
        renderSemanticTextForTest(curiousBrief.hostCalls[0]!.arguments[0]!),
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
      const runtime = new Runtime().add("enum-arc", document).init();
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

    it("uses one proven Enum domain for another matching Enum producer", () => {
      const document = parse(`
"arc";
function Main() {
  let left = Enum(["z", "a"]);
  let right = Enum(["z", "a"]);
  let ordered = Bool();
  left.$set("a");
  right.$set("z");
  ordered.$set(left > right);
}
`);
      const runtime = new Runtime().add("enum-domain", document).init();
      const seeded = runtime.newTraversal(arc("enum-domain", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(brief).cells.ordered).toBe(true);
    });

    it("uses ordinary string equality across Enum domains and nonmember literals", () => {
      const document = parse(`
"arc";
function Main() {
  let left = Enum(["same", "left"]);
  let right = Enum(["same", "right"]);
  let domainsDiffer = Bool();
  let outsideMatches = Bool();
  left.$set("left");
  right.$set("right");
  domainsDiffer.$set(left != right);
  outsideMatches.$set(left == "outside");
}
`);
      const runtime = new Runtime().add("enum-equality", document).init();
      const seeded = runtime.newTraversal(arc("enum-equality", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(brief).cells.domainsDiffer).toBe(true);
      expect(rootTraversal(brief).cells.outsideMatches).toBe(false);
    });

    it.each([
      ["a nonmember literal", 'let value = Enum(["a"]); if (value <= "b") {}'],
      [
        "a Str site",
        'let value = Enum(["a"]); let text = Str(); if (value <= text) {}',
      ],
      [
        "a conflicting Enum domain",
        'let left = Enum(["a", "b"]); let right = Enum(["a", "c"]); if (left <= right) {}',
      ],
    ])("rejects Enum ordering against %s", (_case, body) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  ${body}
}
`),
      ).toThrow(/COMPARISON_VALUE_TYPE/);
    });

    it("rejects an out-of-domain typed Enum host result before ordering", () => {
      const document = parse(`
"arc";
import Values from "host:values";
function Main() {
  let value = Enum(["cold", "warm"]);
  let ordered = Bool();
  value.$set("cold");
  ordered.$set(value <= Values.nextEnum());
}
`);
      const runtime = new Runtime().add("enum-dynamic-domain", document).init();
      const seeded = runtime.newTraversal(arc("enum-dynamic-domain", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const retried = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: "outside" },
        },
      });

      expect(rootTraversal(retried).phase).toBe("entered");
      expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
      expect(retried.issues).toContainEqual(
        expect.objectContaining({ reasonCode: "host-call-result-type" }),
      );
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
      const runtime = new Runtime().add("observe-type-arc", document).init();
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
      const runtime = new Runtime().add("enum-subset-arc", document).init();
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
  let skill = Num({
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
      const runtime = new Runtime().add("str-observe-arc", document).init();
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
      const runtime = new Runtime()
        .add("str-observe-type-arc", document)
        .init();
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

  describe("cell.numeric-observation-spec", () => {
    it("compares finite Num values exactly", () => {
      const document = parse(`
"arc";

function Main() {
  let score = Num();
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
      const runtime = new Runtime()
        .add("ranged-int-compare-arc", document)
        .init();
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
      const runtime = new Runtime()
        .add("ranged-int-observe-arc", document)
        .init();
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
    it("treats RangedInt bounds as observation constraints, not write constraints", () => {
      const document = parse(`
"arc";

function Main() {
  let score = RangedInt(0, 10);
  score.$set(11);
}
`);
      const runtime = new Runtime()
        .add("ranged-int-bounds-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("ranged-int-bounds-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("completed");
      expect(rootTraversal(brief).cells.score).toBe(11);
      expect(brief.issues).toEqual([]);
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

    it("statically rejects non-cursor assignments to cursor cells", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(1);
}
`),
      ).toThrow(/CELL_VALUE_TYPE/);
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

      const runtime = new Runtime().add("dialog-cursor-arc", document).init();
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

      const second = progressTerminal(
        runtime,
        first,
        { move: "proceed" },
        { cursor: { user: 2, self: 1 }, lastTurns: [] },
      );
      expect("hostCalls" in second).toBe(false);
      expect("instructions" in second).toBe(false);
      expect(rootTraversal(second).phase).toBe("completed");
    });
  });

  describe("cell.static-assignment-type", () => {
    it.each([
      [
        "number literal to Str",
        "let target = Str();",
        "target.$set(1);",
        "CELL_VALUE_TYPE",
      ],
      [
        "string literal to Num",
        "let target = Num();",
        'target.$set("x");',
        "CELL_VALUE_TYPE",
      ],
      [
        "number literal to Bool",
        "let target = Bool();",
        "target.$set(1);",
        "CELL_VALUE_TYPE",
      ],
      [
        "typed cell read",
        "let source = Num(); let target = Str();",
        "target.$set(source);",
        "CELL_VALUE_TYPE",
      ],
      [
        "numeric compound",
        "let target = Str();",
        "target.$set(1 + 2);",
        "CELL_VALUE_TYPE",
      ],
      [
        "boolean compound",
        "let target = Num();",
        "target.$set(true && false);",
        "CELL_VALUE_TYPE",
      ],
      [
        "value template to Artifact",
        'let target = Artifact("target.md");',
        "target.$set(`source.md`);",
        "ARTIFACT_VALUE_TYPE",
      ],
      [
        "string conditional to Num",
        "let target = Num();",
        'target.$set(true ? "left" : "right");',
        "CELL_VALUE_TYPE",
      ],
      [
        "Dialog cursor value to Str",
        "let target = Str();",
        "target.$set(Dialog.cursor);",
        "CELL_VALUE_TYPE",
      ],
      [
        "typed array element read",
        "let source = Array(Bool()); let target = Str();",
        "target.$set(source[0]);",
        "CELL_VALUE_TYPE",
      ],
      [
        "homogeneous boolean array literal",
        "let target = Array(Str());",
        "target.$set([true, false]);",
        "CELL_VALUE_TYPE",
      ],
      [
        "empty array literal to Str",
        "let target = Str();",
        "target.$set([]);",
        "CELL_VALUE_TYPE",
      ],
      [
        "empty array branch to Artifact",
        'let target = Artifact("target.md");',
        'target.$set(true ? [] : Artifact("source.md"));',
        "ARTIFACT_VALUE_TYPE",
      ],
      [
        "heterogeneous array literal",
        "let target = Array(Str());",
        'target.$set(["valid", false]);',
        "CELL_VALUE_TYPE",
      ],
      [
        "null literal",
        "let target = Str();",
        "target.$set(null);",
        "CELL_VALUE_TYPE",
      ],
      [
        "Artifact cell to Str",
        'let source = Artifact("source.md"); let target = Str();',
        "target.$set(source);",
        "CELL_VALUE_TYPE",
      ],
      [
        "Artifact constructor to Str",
        "let target = Str();",
        'target.$set(Artifact("source.md"));',
        "CELL_VALUE_TYPE",
      ],
      [
        "string to Artifact",
        'let target = Artifact("target.md");',
        'target.$set("source.md");',
        "ARTIFACT_VALUE_TYPE",
      ],
      [
        "cursor to Artifact",
        'let source = Dialog.Cursor(); let target = Artifact("target.md");',
        "target.$set(source);",
        "ARTIFACT_VALUE_TYPE",
      ],
      [
        "array to cursor",
        "let source = Array(Str()); let target = Dialog.Cursor();",
        "target.$set(source);",
        "CELL_VALUE_TYPE",
      ],
      [
        "incompatible arrays",
        "let source = Array(Bool()); let target = Array(Str());",
        "target.$set(source);",
        "CELL_VALUE_TYPE",
      ],
    ])(
      "statically rejects a known-incompatible $set source: %s",
      (_case, declarations, write, code) => {
        expect(() =>
          parse(`
"arc";
function Main() {
  ${declarations}
  ${write}
}
`),
        ).toThrow(new RegExp(code));
      },
    );

    it("accepts compatible scalar, exact, and recursively compatible array value families", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let enumSource = Enum(["a"]);
  let stringTarget = Str();
  let numberSource = Num();
  let indexTarget = Num();
  let artifactTarget = Artifact("target.md");
  let cursorSource = Dialog.Cursor();
  let cursorTarget = Dialog.Cursor();
  let arraySource = Array(Enum(["a"]));
  let arrayTarget = Array(Enum(["a", "b"]));
  let booleanArrayTarget = Array(Bool());
  let emptyStringArrayTarget = Array(Str());
  let booleanElementTarget = Bool();
  let conditionalStringTarget = Str();
  stringTarget.$set(enumSource);
  stringTarget.$set(\`value template\`);
  indexTarget.$set(numberSource);
  artifactTarget.$set(Artifact("source.md"));
  cursorTarget.$set(cursorSource);
  arrayTarget.$set(arraySource);
  booleanArrayTarget.$set([true, false]);
  emptyStringArrayTarget.$set([]);
  booleanElementTarget.$set(booleanArrayTarget[0]);
  conditionalStringTarget.$set(true ? "literal" : enumSource);
}
`),
      ).not.toThrow();
    });

    it("rejects a conditional landing when any branch is incompatible", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let target = Num();
  target.$set(true ? 1 : "incompatible");
}
`),
      ).toThrow(/CELL_VALUE_TYPE/);
    });

    it("rejects an invalid typed host result before a conditional landing", () => {
      const document = parse(`
"arc";
import Values from "host:values";
function Main() {
  let target = Num();
  target.$set(false ? 1 : Values.next());
}
`);
      const runtime = new Runtime()
        .add("conditional-dynamic-landing", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("conditional-dynamic-landing", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const retried = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: {
            status: "resolved",
            value: "incompatible",
          },
        },
      });

      expect(rootTraversal(retried).phase).toBe("entered");
      expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
      expect(retried.issues).toContainEqual(
        expect.objectContaining({
          reasonCode: "host-call-result-type",
        }),
      );
    });
  });

  describe("expr.artifact-construction", () => {
    it("artifact.construct validates public IR path shapes", () => {
      const base = parse(`
"arc";
function Main() {
  let artifact = Artifact("initial.md");
  artifact.$set(Artifact("next.md"));
}
`);
      const malformed = [
        { kind: "artifact" },
        { kind: "artifact", path: 42 },
        { kind: "artifact", path: "next.md" },
        { kind: "artifact", path: { kind: "unknown" } },
        { kind: "artifact", path: { kind: "literal", value: 42 } },
        { kind: "artifact", path: { kind: "literal", value: "" } },
        { kind: "artifact", path: { kind: "template-string", parts: {} } },
        {
          kind: "artifact",
          path: {
            kind: "template-string",
            parts: [{ kind: "text", value: 42 }],
          },
        },
        {
          kind: "artifact",
          path: {
            kind: "template-string",
            parts: [{ kind: "ref", name: "user" }],
          },
        },
        {
          kind: "artifact",
          path: {
            kind: "template-string",
            parts: [{ kind: "expression", expression: { kind: "unknown" } }],
          },
        },
      ];

      for (const value of malformed) {
        const document = JSON.parse(JSON.stringify(base)) as typeof base;
        const statement = document.roots[0]!.statements[0]!;
        if (statement.kind !== "set") throw new Error("expected set statement");
        statement.value = value as never;
        expect(validate(document).length).toBeGreaterThan(0);
      }

      const ordinaryTemplate = parse(`
"arc";
function Main() {
  let text = Str();
  text.$set(\`valid\`);
}
`);
      const ordinarySet = ordinaryTemplate.roots[0]!.statements[0]!;
      if (ordinarySet.kind !== "set") throw new Error("expected set statement");
      ordinarySet.value = {
        kind: "template-string",
        parts: {} as never,
      };
      expect(validate(ordinaryTemplate)).toContainEqual(
        expect.objectContaining({ code: "INVALID_EXPRESSION_STRATUM" }),
      );

      expect(validate(base)).toEqual([]);
    });
  });

  describe("cell.is-unset", () => {
    it("reads unset state reactively and treats falsey assigned values as defined", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  let note = Str();
  let count = Num();
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

      const runtime = new Runtime().add("is-unset-arc", document).init();
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
        const runtime = new Runtime().add(name, document).init();
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

    it("rejects arguments and unknown cells while Artifact cells expose isUnset", () => {
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
      ).not.toThrow();
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
          initializer: {
            kind: "artifact",
            path: { kind: "literal", value: "research-log.md" },
          },
          loc: expect.any(Object),
        },
      ]);
    });

    it("artifact.cell uninitialized declaration starts unset and accepts a later Artifact value", () => {
      const document = parse(`
"arc";
function Main() {
  let note = Artifact();
  let initiallyUnset = Bool();
  initiallyUnset.$set(note.isUnset());
  note.$set(Artifact("assigned.md"));
  if (initiallyUnset && !note.isUnset()) {
    $instruct(\`assigned\`);
  }
}
`);
      expect(document.roots[0]?.cells[0]).toEqual({
        name: "note",
        type: "artifact",
        loc: expect.any(Object),
      });

      const runtime = new Runtime()
        .add("unset-artifact-declaration", document)
        .init();
      const brief = actionProgress(
        runtime.enterArc(
          arc("unset-artifact-declaration", "Main"),
          EMPTY_DIALOG,
        ),
      );
      expect(rootTraversal(brief).cells).toMatchObject({
        initiallyUnset: true,
        note: createArtifactValue("assigned.md"),
      });
      expect(brief.instructions.map((item) => item.text)).toEqual(["assigned"]);
    });

    it("artifact.cell validates optional public initializer shapes", () => {
      const document = parse(`
"arc";
function Main() {
  let note = Artifact("note.md");
}
`);
      expect(validate(document)).toEqual([]);

      const malformed = JSON.parse(JSON.stringify(document)) as typeof document;
      const cell = malformed.roots[0]!.cells[0]!;
      if (cell.type !== "artifact") throw new Error("expected Artifact cell");
      cell.initializer = 42 as never;
      expect(validate(malformed)).toContainEqual(
        expect.objectContaining({ code: "INVALID_ARTIFACT_CELL_SPEC" }),
      );

      const legacy = parse(`
"arc";
function Main() {
  let note = Artifact();
}
`);
      Object.assign(legacy.roots[0]!.cells[0]!, { path: "note.md" });
      expect(validate(legacy)).toContainEqual(
        expect.objectContaining({ code: "INVALID_ARTIFACT_CELL_SPEC" }),
      );
    });

    it("rejects artifacts in boolean positions and non-Artifact assignments", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact("research-log.md");
  if (note) {
    $instruct(\`bad\`);  }
}
`),
      ).toThrow(/NON_BOOLEAN_CONDITION/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  let note = Artifact("research-log.md");
  note.$set("bad");
}
`),
      ).toThrow(/ARTIFACT_VALUE_TYPE/);
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
      const instructionRuntime = new Runtime()
        .add("semantic-text-instruction-arc", instructionDocument)
        .init();
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
      const observationRuntime = new Runtime()
        .add("semantic-text-observation-arc", observationDocument)
        .init();
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
      const judgmentRuntime = new Runtime()
        .add("semantic-text-judgment-arc", judgmentDocument)
        .init();
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

    it("artifact.cell.set replaces the initialized value and isUnset observes stored state", () => {
      const runtime = new Runtime()
        .add(
          "artifact-cell-set",
          parse(`
"arc";
function Main(args = { input: Artifact() }) {
  let note = Artifact("initial.md");
  note.$set(args.input);
  if (!note.isUnset()) {
    $instruct(\`Use \${note}\`);
  }
}
`),
        )
        .init();
      const brief = actionProgress(
        runtime.enterArc(arc("artifact-cell-set", "Main"), EMPTY_DIALOG, {
          args: {
            input: { path: "assigned.md" },
          },
        }),
      );

      expect(rootTraversal(brief).cells.note).toEqual({ path: "assigned.md" });
      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Use " },
        { kind: "artifact", path: "assigned.md" },
      ]);
    });

    it("artifact.semantic-expression projects an Artifact-valued conditional", () => {
      const runtime = new Runtime()
        .add(
          "artifact-conditional-semantic",
          parse(`
"arc";
function Main() {
  let useFirst = Bool();
  let first = Artifact("first.md");
  let second = Artifact("second.md");
  useFirst.$set(false);
  $instruct(\`Use \${useFirst ? first : second}\`);
}
`),
        )
        .init();
      const brief = actionProgress(
        runtime.enterArc(
          arc("artifact-conditional-semantic", "Main"),
          EMPTY_DIALOG,
        ),
      );

      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Use " },
        { kind: "artifact", path: "second.md" },
      ]);
    });

    it("artifact.value-template projects local, channel, and conditional values to ordinary strings", () => {
      const runtime = new Runtime()
        .add(
          "artifact-value-template",
          parse(`
"arc";
function Main(args = { input: Artifact() }) {
  let local = Artifact("source/input.md");
  let fallback = Artifact("fallback.md");
  let chooseFallback = Bool();
  let exact = Str();
  let composed = Str();
  let selected = Str();
  let matches = Bool();

  chooseFallback.$set(false);
  exact.$set(\`\${local}\`);
  composed.$set(\`prefix/\${args.input}/suffix\`);
  selected.$set(\`\${chooseFallback ? fallback : args.input}\`);
  matches.$set(
    exact == "source/input.md" &&
      /incoming/.test(composed) &&
      selected == "incoming/data.md"
  );
  if (matches) {
    $instruct(\`projected\`);
  }
}
`),
        )
        .init();

      const brief = actionProgress(
        runtime.enterArc(arc("artifact-value-template", "Main"), EMPTY_DIALOG, {
          args: { input: createArtifactValue("incoming/data.md") },
        }),
      );

      expect(rootTraversal(brief).cells).toMatchObject({
        exact: "source/input.md",
        composed: "prefix/incoming/data.md/suffix",
        selected: "incoming/data.md",
        matches: true,
      });
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "projected",
      ]);
    });

    it("artifact.equality compares logical paths without coercion", () => {
      const runtime = new Runtime()
        .add(
          "artifact-equality",
          parse(`
"arc";
function Main(args = { same: Artifact(), different: Artifact() }) {
  let local = Artifact("same.md");
  let equal = Bool();
  let unequal = Bool();
  let unset = Artifact("unset.md");
  let unsetEqual = Bool();
  let unsetUnequal = Bool();

  unset.$unset();
  equal.$set(local == args.same);
  unequal.$set(local != args.different);
  unsetEqual.$set(unset == local);
  unsetUnequal.$set(unset != local);
}
`),
        )
        .init();

      const brief = actionTerminal(
        runtime.enterArc(arc("artifact-equality", "Main"), EMPTY_DIALOG, {
          args: {
            same: createArtifactValue("same.md"),
            different: createArtifactValue("different.md"),
          },
        }),
      );
      expect(rootTraversal(brief).cells).toMatchObject({
        equal: true,
        unequal: true,
        unsetEqual: false,
        unsetUnequal: true,
      });
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Artifact("same.md");
  let equal = Bool();
  equal.$set(note == "same.md");
}
`),
      ).toThrow(/COMPARISON_VALUE_TYPE/);
    });

    it("artifact.direct-operations reject ordering, arithmetic, regex, and property access", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Artifact("note.md");
  if (note < note) {}
}
`),
      ).toThrow(/INVALID_ARTIFACT_OPERATION/);
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Artifact("note.md");
  if (/note/.test(note)) {}
}
`),
      ).toThrow(/INVALID_ARTIFACT_OPERATION/);
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Artifact("note.md");
  let count = Num();
  count.$set(note + 1);
}
`),
      ).toThrow(/NON_NUMERIC_ARITHMETIC_OPERAND/);
      expect(() =>
        parse(`
"arc";
function Main() {
  let note = Artifact("note.md");
  $instruct(\`\${note.path}\`);
}
`),
      ).toThrow(/Unsupported value expression: MemberExpression/);
    });

    it("artifact.cell.unset survives reconstruction and template interpolation rejects the unset value", () => {
      const source = `
"arc";
function Main() {
  let note = Artifact("initial.md");
  note.$unset();
  if (note.isUnset()) {
    $instruct(\`unset state\`);
  }
  $instruct(\`Use \${note}\`);
}
`;
      const firstRuntime = new Runtime()
        .add("artifact-cell-unset", parse(source))
        .init();
      const first = actionProgress(
        firstRuntime.enterArc(arc("artifact-cell-unset", "Main"), EMPTY_DIALOG),
      );
      expect(first.instructions.map((item) => item.text)).toEqual([
        "unset state",
      ]);
      expect(rootTraversal(first).cells.note).toBeUndefined();

      const secondRuntime = new Runtime()
        .add("artifact-cell-unset", parse(source))
        .init();
      const restored = actionProgress(
        secondRuntime.start(
          JSON.parse(JSON.stringify(first.traversals)) as ArcTraversalSet,
          EMPTY_DIALOG,
        ),
      );
      const terminal = actionTerminal(
        secondRuntime.progress(
          restored,
          {
            move: "proceed",
            instructions: appliedInstructions(restored),
          },
          EMPTY_DIALOG,
        ),
      );

      expect(terminal.outcome).toBe("poisoned");
      expect(terminal.issues[0]).toMatchObject({
        reasonCode: "invalid-template-interpolation",
      });
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
          initializer: {
            kind: "artifact",
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

    it("initializes dynamic Artifact path templates from entry args before the body", () => {
      const document = parse(`
"arc";

function Main(args = { slug: Str() }) {
  let note = Artifact(\`notes/\${args.slug}.md\`);
  $instruct(\`Update \${note}.\`);
}
`);
      const runtime = new Runtime()
        .add("dynamic-artifact-path-arc", document)
        .init();
      const brief = actionProgress(
        runtime.enterArc(
          arc("dynamic-artifact-path-arc", "Main"),
          EMPTY_DIALOG,
          { args: { slug: "pricing" } },
        ),
      );

      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Update " },
        { kind: "artifact", path: "notes/pricing.md" },
        { kind: "text", value: "." },
      ]);
    });

    it("artifact.initializer derives from earlier and bound Artifacts and survives reconstruction", () => {
      const source = `
"arc";
function Main(
  args = { input: Artifact(), replacement: Artifact() },
) {
  let source = Artifact("source/input.md");
  let derived = Artifact(\`root/\${source}\`);
  let fromArg = Artifact(\`copied/\${args.input}\`);
  source.$set(args.replacement);
  $instruct(\`Use \${derived} and \${fromArg}\`);
}
`;
      const firstRuntime = new Runtime()
        .add("artifact-derived-initializers", parse(source))
        .init();
      const first = actionProgress(
        firstRuntime.enterArc(
          arc("artifact-derived-initializers", "Main"),
          EMPTY_DIALOG,
          {
            args: {
              input: createArtifactValue("incoming/data.md"),
              replacement: createArtifactValue("changed.md"),
            },
          },
        ),
      );

      expect(rootTraversal(first).cells).toMatchObject({
        source: createArtifactValue("changed.md"),
        derived: createArtifactValue("root/source/input.md"),
        fromArg: createArtifactValue("copied/incoming/data.md"),
      });
      expect(first.instructions[0]?.text).toEqual([
        { kind: "text", value: "Use " },
        { kind: "artifact", path: "root/source/input.md" },
        { kind: "text", value: " and " },
        { kind: "artifact", path: "copied/incoming/data.md" },
      ]);

      const secondRuntime = new Runtime()
        .add("artifact-derived-initializers", parse(source))
        .init();
      const restored = actionProgress(
        secondRuntime.start(
          JSON.parse(JSON.stringify(first.traversals)) as ArcTraversalSet,
          EMPTY_DIALOG,
        ),
      );
      expect(rootTraversal(restored).cells).toMatchObject({
        source: createArtifactValue("changed.md"),
        derived: createArtifactValue("root/source/input.md"),
        fromArg: createArtifactValue("copied/incoming/data.md"),
      });
    });

    it("artifact.initializer rejects an unset later Artifact interpolation", () => {
      const runtime = new Runtime()
        .add(
          "artifact-forward-initializer",
          parse(`
"arc";
function Main() {
  let derived = Artifact(\`root/\${later}\`);
  let later = Artifact("later.md");
}
`),
        )
        .init();

      const terminal = actionTerminal(
        runtime.enterArc(
          arc("artifact-forward-initializer", "Main"),
          EMPTY_DIALOG,
        ),
      );
      expect(terminal.issues[0]).toMatchObject({
        reasonCode: "invalid-template-interpolation",
      });
    });

    it("artifact.initializer validates the complete path after Artifact projection", () => {
      const runtime = new Runtime()
        .add(
          "artifact-projected-invalid-path",
          parse(`
"arc";
function Main() {
  let source = Artifact("source.md");
  let derived = Artifact(\`../\${source}\`);
}
`),
        )
        .init();

      const terminal = actionTerminal(
        runtime.enterArc(
          arc("artifact-projected-invalid-path", "Main"),
          EMPTY_DIALOG,
        ),
      );
      expect(terminal.issues[0]).toMatchObject({
        reasonCode: "invalid-artifact-path",
        reason: expect.stringContaining('cannot contain "." or ".." segments'),
      });
    });

    it("artifact.initializer evaluates once even when its path dependency changes in the body", () => {
      const runtime = new Runtime()
        .add(
          "stable-artifact-initializer",
          parse(`
"arc";
function Main() {
  let slug = Str();
  let note = Artifact(\`notes/\${slug}.md\`);
  slug.$set("changed");
  $instruct(\`Use \${note}\`);
}
`),
        )
        .init();
      const seeded = runtime.newTraversal(
        arc("stable-artifact-initializer", "Main"),
      );
      seeded.phase = "entered";
      seeded.enterCount = 1;
      seeded.cells.slug = "initial";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(brief).cells.slug).toBe("changed");
      expect(rootTraversal(brief).cells.note).toEqual({
        path: "notes/initial.md",
      });
      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Use " },
        { kind: "artifact", path: "notes/initial.md" },
      ]);
    });

    it("poisons traversal when an initialized Artifact path is invalid", () => {
      const document = parse(`
"arc";

function Main(args = { slug: Str() }) {
  let note = Artifact(\`notes/\${args.slug}.md\`);
  $instruct(\`Update \${note}.\`);
}
`);
      const runtime = new Runtime()
        .add("invalid-dynamic-artifact-path-arc", document)
        .init();
      const brief = actionTerminal(
        runtime.enterArc(
          arc("invalid-dynamic-artifact-path-arc", "Main"),
          EMPTY_DIALOG,
          { args: { slug: "../escape" } },
        ),
      );

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-artifact-path",
          reason: expect.stringContaining(
            'Artifact path cannot contain "." or ".." segments',
          ),
        }),
      ]);
    });

    it("poisons traversal when an empty or absolute Artifact path renders", () => {
      const empty = parse(`
"arc";

function Main(args = { slug: Str() }) {
  let note = Artifact(\`\${args.slug}\`);
  $instruct(\`Update \${note}.\`);
}
`);
      const emptyRuntime = new Runtime()
        .add("empty-artifact-path-arc", empty)
        .init();
      const emptyBrief = actionTerminal(
        emptyRuntime.enterArc(
          arc("empty-artifact-path-arc", "Main"),
          EMPTY_DIALOG,
          { args: { slug: "" } },
        ),
      );
      expect(rootTraversal(emptyBrief).phase).toBe("poisoned");
      expect(emptyBrief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-artifact-path",
        }),
      ]);

      const absolute = parse(`
"arc";

function Main(args = { slug: Str() }) {
  let note = Artifact(\`/\${args.slug}.md\`);
  $instruct(\`Update \${note}.\`);
}
`);
      const absoluteRuntime = new Runtime()
        .add("absolute-artifact-path-arc", absolute)
        .init();
      const absoluteBrief = actionTerminal(
        absoluteRuntime.enterArc(
          arc("absolute-artifact-path-arc", "Main"),
          EMPTY_DIALOG,
          { args: { slug: "report" } },
        ),
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
      const runtime = new Runtime()
        .add("observe-override-arc", document)
        .init();
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
      ["a Num cell", `let x = Num(); x.$set(3);`],
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
        parse(booleanTest(`let x = Num(); x.$set(3);`, "x > 0")),
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
      const runtime = new Runtime()
        .add("host-boolean-position-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("host-boolean-position-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.hostCalls).toHaveLength(1);

      const retried = progressBrief(runtime, first, {
        move: "proceed",
        hostCalls: {
          [first.hostCalls[0]!.id]: { status: "resolved", value: "enabled" },
        },
      });

      expect(rootTraversal(retried).phase).toBe("entered");
      expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
      expect(retried.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-item",
          reasonCode: "host-call-result-type",
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
  let index = Num();
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

    it("reports invalid-template-interpolation for unset ordinary and Artifact values in value templates", () => {
      const cases = [
        {
          name: "ordinary",
          declaration: "let topic = Str();",
          setup: "",
        },
        {
          name: "artifact",
          declaration: 'let topic = Artifact("topic.md");',
          setup: "topic.$unset();",
        },
      ];

      for (const testCase of cases) {
        const runtime = new Runtime()
          .add(
            `value-string-unset-${testCase.name}`,
            parse(`
"arc";
function Main() {
  ${testCase.declaration}
  let summary = Str();
  ${testCase.setup}
  summary.$set(\`topic-\${topic}\`);
}
`),
          )
          .init();
        const terminal = actionTerminal(
          runtime.enterArc(
            arc(`value-string-unset-${testCase.name}`, "Main"),
            EMPTY_DIALOG,
          ),
        );

        expect(rootTraversal(terminal).phase).toBe("poisoned");
        expect(terminal.issues).toEqual([
          expect.objectContaining({
            kind: "poisoned-traversal",
            reasonCode: "invalid-template-interpolation",
          }),
        ]);
      }
    });

    it("rejects a dialog cursor producer in a value template", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let cursor = Dialog.Cursor();
  let text = Str();
  cursor.$set(Dialog.cursor);
  text.$set(\`cursor-\${cursor}\`);
}
`),
      ).toThrow(/INVALID_TEMPLATE_INTERPOLATION/);
    });

    it("reports invalid-template-interpolation for unset semantic-text interpolation", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  $instruct(\`talk about \${topic}\`);
  topic.$set(\`pricing\`);
}
`);

      const runtime = new Runtime()
        .add("semantic-string-unset-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("semantic-string-unset-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime().add("dead-read-set-arc", document).init();
      const seeded = runtime.newTraversal(arc("dead-read-set-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
          element: {
            type: "number",
            observeAs: { kind: "integer", min: 1, max: 5 },
          },
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
  let index = Num();
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
      const runtime = new Runtime().add("array-set-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-set-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime()
        .add("array-element-set-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("array-element-set-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.items).toEqual(["a", "B", "c"]);
    });

    it("uses a dynamic index for an array-element write", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let index = Num();
  items.$set(["a", "b", "c"]);
  index.$set(2);
  items[index].$set("C");
}
`);
      const runtime = new Runtime()
        .add("array-element-dynamic-set-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("array-element-dynamic-set-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
        const runtime = new Runtime()
          .add(`array-element-${_caseName}-arc`, document)
          .init();
        const seeded = runtime.newTraversal(
          arc(`array-element-${_caseName}-arc`, "Main"),
        );
        seeded.phase = "entered";

        const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime()
        .add("array-element-negative-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("array-element-negative-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime()
        .add("array-element-string-index-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("array-element-string-index-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "invalid-array-index",
        }),
      ]);
    });

    it("does not apply array-element observation bounds to direct writes", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([3]);
  scores[0].$set(6);
}
`);
      const runtime = new Runtime()
        .add("array-element-bounds-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("array-element-bounds-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("completed");
      expect(rootTraversal(brief).cells.scores).toEqual([6]);
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
      const runtime = new Runtime().add("array-unset-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-unset-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime().add("array-eq-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-eq-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      const cells = rootTraversal(brief).cells;
      // Only the identical list matches; reordered, shorter, and value-different
      // lists compare unequal — an all-arrays-equal impl would fail these.
      expect(cells.same).toBe(true);
      expect(cells.reordered).toBe(false);
      expect(cells.shorter).toBe(false);
      expect(cells.different).toBe(false);
      // `!=` between two set arrays is the negation, distinguishing values —
      // an impl returning false for every set-array inequality would fail
      // `neqReordered`.
      expect(cells.neqSame).toBe(false);
      expect(cells.neqReordered).toBe(true);
    });

    it("rejects equality between arrays with incompatible element guarantees", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let numbers = Array(Num());
  let strings = Array(Str());
  let same = Bool();
  same.$set(numbers == strings);
}
`),
      ).toThrow(/COMPARISON_VALUE_TYPE/);
    });

    it.each([
      ["string", ["1"]],
      ["object", [{ path: "one" }]],
    ])(
      "rejects a dynamic %s array against a numeric array before equality",
      (caseName, reported) => {
        const document = parse(`
"arc";
import Values from "host:values";
function Main() {
  let numbers = Array(Num());
  let same = Bool();
  numbers.$set([1]);
  same.$set(numbers == Values.nextNumbers());
}
`);
        const source = `array-dynamic-${caseName}`;
        const runtime = new Runtime().add(source, document).init();
        const seeded = runtime.newTraversal(arc(source, "Main"));
        seeded.phase = "entered";

        const first = startRun(runtime, [seeded], EMPTY_DIALOG);
        const retried = progressBrief(runtime, first, {
          move: "proceed",
          hostCalls: {
            [first.hostCalls[0]!.id]: { status: "resolved", value: reported },
          },
        });

        expect(rootTraversal(retried).phase).toBe("entered");
        expect(retried.hostCalls[0]?.id).toBe(first.hostCalls[0]!.id);
        expect(retried.issues).toContainEqual(
          expect.objectContaining({ reasonCode: "host-call-result-type" }),
        );
      },
    );

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
      const runtime = new Runtime().add("array-unset-cmp-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-unset-cmp-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime().add("array-template-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-template-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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

    it("allows a fractional direct write through RangedInt array shorthand", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([1, 2.5]);
}
`);
      const runtime = new Runtime().add("array-frac-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-frac-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("completed");
      expect(rootTraversal(brief).cells.scores).toEqual([1, 2.5]);
    });

    it("allows an out-of-observation-range direct array write", () => {
      const document = parse(`
"arc";
function Main() {
  let scores = Array(RangedInt(1, 5));
  scores.$set([1, 9]);
}
`);
      const runtime = new Runtime().add("array-range-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-range-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("completed");
      expect(rootTraversal(brief).cells.scores).toEqual([1, 9]);
    });
  });

  describe("cell.array-read", () => {
    it("reads an element by bracket index and reads length", () => {
      const document = parse(`
"arc";
function Main() {
  let items = Array(Str());
  let first = Str();
  let count = Num();
  items.$set(["x", "y", "z"]);
  first.$set(items[0]);
  count.$set(items.length);
}
`);
      const runtime = new Runtime().add("array-read-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-read-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
      const runtime = new Runtime().add("array-oob-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-oob-arc", "Main"));
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

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
  let count = Num();
  count.$set(items.length);
}
`);
      const runtime = new Runtime().add("array-unset-arc", document).init();
      const seeded = runtime.newTraversal(arc("array-unset-arc", "Main"));
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

    it("rejects reading length of a non-array cell at parse", () => {
      expect(() =>
        parse(
          `"arc";\nfunction Main() { let note = Str(); let n = Num(); n.$set(note.length); }`,
        ),
      ).toThrow(/LENGTH_NON_ARRAY/);
    });
  });
});
