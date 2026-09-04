/**
 * Behavior tests for the Expressions and Dialog area (`expr.*`, `dialog.*`,
 * and `cursor.*` entries in specs/testing.md).
 *
 * Ported from `parser.test.ts` and `runtime.test.ts` per the coverage
 * manifest. Every case feeds a deterministic Arc source string and injects
 * semantic results through reports, so there is no nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { analyzeDocument, parse, validate } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type {
  ArcTraversalSet,
  Dialog,
  ElementId,
  HostCall,
  SourceRange,
} from "../src/types/index.js";
import { nodeSegKey } from "../src/types/index.js";
import {
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  rootTraversal,
  startRun,
  startTerminal,
} from "./helpers.js";

describe("expressions and dialog", () => {
  describe("expr.value-positions", () => {
    it("parses local value expressions across expression-bearing positions", () => {
      const document = parse(`
"arc";

import Score from "host:scorer";
import Memoir from "host:memoir";

function Main() {
  let roll = Num();
  let score = Num();

  this.trigger = () => {
    if (roll > 10 ? true : false) {
      return roll > 10 ? true : false;
    }
    return false;
  };

  roll.$set(12);
  score.$set(Score.score(roll > 10 ? "boost" : "plain"));

  if (roll > 10 ? true : false) {
    $instruct(\`Mode: \${roll > 10 ? "boost" : "plain"}\`);  }

  this.effects = () => {
    if (roll > 10 ? true : false) {
      Memoir.facts.$apply({
        label: roll > 10 ? "boost" : "plain",
      });
    }
  };
}
`);

      const root = document.roots[0]!;
      expect(root.trigger?.[0]).toMatchObject({
        kind: "if",
        test: { kind: "conditional" },
        consequent: [{ kind: "return", value: { kind: "conditional" } }],
      });
      expect(root.statements[1]).toMatchObject({
        kind: "set",
        value: {
          kind: "host-call",
          arguments: [{ kind: "value", value: { kind: "conditional" } }],
        },
      });
      const actionBranch = root.statements[2];
      expect(actionBranch).toMatchObject({
        kind: "if",
        test: { kind: "conditional" },
      });
      if (
        actionBranch?.kind !== "if" ||
        actionBranch.consequent[0]?.kind !== "instruction"
      ) {
        throw new Error("expected instruction inside action branch");
      }
      const template = actionBranch.consequent[0].template;
      if (template.kind !== "template-string") {
        throw new Error("expected template string instruction");
      }
      expect(template.parts).toEqual([
        { kind: "text", value: "Mode: " },
        {
          kind: "expression",
          expression: expect.objectContaining({ kind: "conditional" }),
        },
      ]);
      expect(root.effects?.[0]).toMatchObject({
        kind: "if",
        test: { kind: "conditional" },
        consequent: [
          {
            kind: "host-call",
            arguments: [
              {
                kind: "object",
                value: {
                  label: { kind: "value", value: { kind: "conditional" } },
                },
              },
            ],
          },
        ],
      });
    });

    it("differential read-coverage: the static plan covers reads nested under every expression kind", () => {
      // Child buries unique reads under logical/binary, unary, conditional,
      // regexTest, and Artifact-construction subtrees. This fails the moment the
      // collector stops descending into any one of them. A dropped read is a
      // correctness bug (the enclosing SEG would under-rewalk), not a perf miss.
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  let topic = Enum(["unknown", "metal"]);
  let level = Num();

  $enter(Child, {
    args: { ready },
    returns: { topic },
  });

  function Child(args = { ready: Bool() }, returns = { topic: Enum(["unknown", "metal"]) }) {
    let flag = Bool();
    let pick = Bool();
    let lhs = Bool();
    let rhs = Bool();
    let label = Str();
    let artifactPath = Str();
    let artifact = Artifact("initial.md");

    if (args.ready == true && returns.topic == "metal") {
      $instruct(\`logical over channels\`);
    }
    if (!flag) {
      $instruct(\`unary\`);
    }
    if (pick == true ? lhs == true : rhs == true) {
      $instruct(\`conditional\`);
    }
    if (/metal/i.test(label)) {
      $instruct(\`regexTest\`);
    }
    artifact.$set(Artifact(\`docs/\${artifactPath}.md\`));
    if (level >= 5 || Sibling.state == State.COVERED) {
      $instruct(\`binary and node-state\`);
    }
  }

  function Sibling() {
    $instruct(\`sibling\`);
  }
}
`);
      const plan = analyzeDocument(document).rewalkPlan;
      const childNode = document.roots[0]!.children.find(
        (child) => child.identifier === "Child",
      )!;
      const readSet = plan.bySeg.get(childNode)!.get(nodeSegKey("body"))!;

      // unary `flag`; conditional `pick`/`lhs`/`rhs`; regexTest `label`;
      // Artifact path `artifactPath`; binary `level` — every nested read must
      // surface, and the length bound rejects either a dropped or spurious read.
      expect(readSet.cells).toEqual(
        expect.arrayContaining([
          "flag",
          "pick",
          "lhs",
          "rhs",
          "label",
          "artifactPath",
          "level",
        ]),
      );
      expect(readSet.cells).toHaveLength(7);
      expect(readSet.nodeIdentifiers).toContain("Sibling");
      expect(readSet.channels).toContainEqual({
        namespace: "args",
        key: "ready",
      });
      expect(readSet.channels).toContainEqual({
        namespace: "returns",
        key: "topic",
      });
      expect(readSet.channels).toHaveLength(2);
    });

    it("artifact.construct reports the nested briefable expression location", () => {
      const document = parse(`
"arc";
import Store from "host:store";
function Main() {
  let accepted = Bool();
  accepted.$set(Store.accept(Artifact("literal.md")));
}
`);
      const statement = document.roots[0]!.statements[0]!;
      if (statement.kind !== "set" || statement.value.kind !== "host-call") {
        throw new Error("expected host-call set value");
      }
      const argument = statement.value.arguments[0];
      if (argument?.kind !== "value" || argument.value.kind !== "artifact") {
        throw new Error("expected Artifact host argument");
      }
      const nestedLoc: SourceRange = {
        start: { line: 50, column: 7 },
        end: { line: 50, column: 19 },
      };
      const nested: HostCall = {
        id: statement.value.id.replace(/~0$/, "~1") as ElementId,
        kind: "host-call",
        module: "store",
        target: [],
        operation: "path",
        arguments: [],
        loc: nestedLoc,
      };
      argument.value.path = {
        kind: "template-string",
        parts: [{ kind: "expression", expression: nested }],
      };

      expect(validate(document)).toContainEqual(
        expect.objectContaining({ code: "HOST_CALL_ARGUMENT", loc: nestedLoc }),
      );
    });

    it("artifact.construct preserves bare-boolean linting inside path templates", () => {
      const lintCodes = (pathExpression: string) =>
        analyzeDocument(
          parse(`
"arc";
function Main() {
  let ready = Bool();
  let artifact = Artifact("initial.md");
  artifact.$set(Artifact(\`${pathExpression}\`));
}
`),
        ).lintIssues.map((issue) => issue.code);

      expect(lintCodes('${ready ? "yes" : "no"}.md')).toContain(
        "bare-cell-boolean",
      );
      expect(lintCodes("${ready}.md")).not.toContain("bare-cell-boolean");
    });
  });

  describe("expr.regex", () => {
    // Also proves dialog.last-user-message: the regex evaluates against the
    // most recent user turn of the supplied dialog.
    it("evaluates regexTest expressions at runtime", () => {
      const document = parse(`
"arc";

function Main() {
  if (/metal/i.test(Dialog.lastUserMessage)) {
    $instruct(\`matched\`);  }
  if (/jazz/.test(Dialog.lastUserMessage)) {
    $instruct(\`no match\`);  }
}
`);
      const runtime = new Runtime().add("regex-arc", document).init();
      const seeded = runtime.newTraversal(arc("regex-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "I love Metal" }],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual(["matched"]);
    });
  });

  describe("dialog.participants", () => {
    it("lowers Dialog participant accessors and shorthands to the same semantic references", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`Address \${Dialog.user} like \${user}; respond as \${Dialog.self} like \${self}.\`);
}
`);
      const runtime = new Runtime()
        .add("dialog-participants-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("dialog-participants-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions[0]?.text).toEqual([
        { kind: "text", value: "Address " },
        { kind: "entity", name: "user" },
        { kind: "text", value: " like " },
        { kind: "entity", name: "user" },
        { kind: "text", value: "; respond as " },
        { kind: "entity", name: "self" },
        { kind: "text", value: " like " },
        { kind: "entity", name: "self" },
        { kind: "text", value: "." },
      ]);
    });
  });

  describe("expr.template-value", () => {
    it("parses template literals in value positions as value strings", () => {
      const document = parse(`
"arc";

function Main() {
  let note = Str();
  note.$set(\`haha\`);
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        target: ["note"],
        value: {
          kind: "template-string",
          parts: [{ kind: "text", value: "haha" }],
        },
      });
    });

    it("rejects semantic-only template interpolations in value positions", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let note = Str();
  note.$set(\`\${user}\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);

      expect(() =>
        parse(`
"arc";

function Main() {
  let note = Str();
  note.$set(\`\${Dialog.user}\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);

      expect(() =>
        parse(`
"arc";

function Main() {
  let note = Str();
  note.$set(\`\${Dialog.self}\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);

      expect(() =>
        parse(`
"arc";

function Main() {
  let note = Str();
  note.$set(\`\${self}\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);

      expect(() =>
        parse(`
"arc";

import Audience from "host:audience";

function Main() {
  let note = Str();
  note.$set(\`\${Audience.reviewer}\`);
}
`),
      ).toThrow(/semantic-only interpolation in value position/);
    });

    it("renders value-position template literals for set() values", () => {
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  let note = Str();
  let summary = Str();

  topic.$set("pricing");
  note.$set(\`haha\`);
  summary.$set(\`topic-\${topic}\`);
}
`);

      const runtime = new Runtime()
        .add("value-string-set-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("value-string-set-arc", "Main"));
      seeded.phase = "entered";

      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("completed");
      expect(rootTraversal(brief).cells.note).toBe("haha");
      expect(rootTraversal(brief).cells.summary).toBe("topic-pricing");
    });
  });

  describe("dialog.last-turns", () => {
    it("accepts Dialog snapshot globals in authored expressions", () => {
      const document = parse(`
"arc";
function Main() {
  if (/music/i.test(Dialog.lastUserMessage)) {
    $instruct(\`hi\`);  }
  if (/self/.test(Dialog.lastTurns(2))) {
    $instruct(\`there\`);  }
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
}
`);

      const first = document.roots[0]?.statements[0];
      const second = document.roots[0]?.statements[1];

      expect(first).toMatchObject({
        kind: "if",
        test: {
          kind: "regexTest",
          target: { kind: "scope", name: "lastUserMessage" },
        },
      });
      expect(second).toMatchObject({
        kind: "if",
        test: {
          kind: "regexTest",
          target: { kind: "scope", name: "lastTurns", count: 2 },
        },
      });
      expect(document.roots[0]?.cells[0]).toMatchObject({
        name: "startedAt",
        type: "dialogCursor",
      });
      expect(document.roots[0]?.statements[2]).toMatchObject({
        kind: "set",
        target: ["startedAt"],
        value: { kind: "dialogCursor" },
      });
    });
  });

  describe("dialog.replan", () => {
    it("replans against the latest dialog passed to progress", () => {
      // Dialog reads are pinned per walk, so the replan surfaces through a
      // rewalk from a real state change (the observation write): the fresh
      // walk evaluates its dialog reads against the dialog supplied with the
      // progress call, not the dialog the brief was built under.
      const document = parse(`
"arc";

function Main() {
  let topic = Str();
  topic.observing = \`what topic\`;

  $observe(topic);
  if (/later/i.test(Dialog.lastUserMessage)) {
    $instruct(\`second\`);  }
}
`);
      const runtime = new Runtime().add("dialog-arc", document).init();
      const seeded = runtime.newTraversal(arc("dialog-arc", "Main"));
      seeded.phase = "entered";

      const firstDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "hello" }],
      };
      const secondDialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "later now" }],
      };

      const brief = startRun(runtime, [seeded], firstDialog);
      expect(brief.observations).toHaveLength(1);

      const nextBrief = progressBrief(
        runtime,
        brief,
        {
          move: "proceed",
          observations: {
            [brief.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        secondDialog,
      );

      expect(nextBrief.instructions.map((item) => item.text)).toEqual([
        "second",
      ]);
    });
  });

  describe("cursor.snapshot", () => {
    it("rejects unknown Dialog cell types and arbitrary Dialog calls", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let cursor = Dialog.Handle();
}
`),
      ).toThrow(/Unsupported Dialog cell type: Handle/);

      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.someHostCall());
}
`),
      ).toThrow(/Unsupported value expression: CallExpression/);
    });
  });

  describe("cursor.diffs", () => {
    it("accepts cursor turn-difference methods as local expressions", () => {
      const document = parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  let endedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  if (Dialog.cursor.userTurnsSince(startedAt) >= 10) {
    $instruct(\`pivot\`);  }
  if (Dialog.cursor.selfTurnsSince(startedAt) >= 1) {
    $instruct(\`wait\`);  }
  if (endedAt.totalTurnsSince(startedAt) >= 11) {
    $instruct(\`done\`);  }
}
`);

      const first = document.roots[0]?.statements[0];
      const second = document.roots[0]?.statements[1];
      const third = document.roots[0]?.statements[2];
      const fourth = document.roots[0]?.statements[3];

      expect(first).toMatchObject({
        kind: "set",
        value: { kind: "dialogCursor" },
      });
      expect(second).toMatchObject({
        kind: "if",
        test: {
          kind: "comparison",
          left: {
            kind: "dialogTurnsSince",
            metric: "user",
            receiver: { kind: "dialogCursor" },
            baseline: { kind: "cell", name: "startedAt" },
          },
        },
      });
      expect(third).toMatchObject({
        kind: "if",
        test: {
          kind: "comparison",
          left: {
            kind: "dialogTurnsSince",
            metric: "self",
            receiver: { kind: "dialogCursor" },
          },
        },
      });
      expect(fourth).toMatchObject({
        kind: "if",
        test: {
          kind: "comparison",
          left: {
            kind: "dialogTurnsSince",
            metric: "total",
            receiver: { kind: "cell", name: "endedAt" },
            baseline: { kind: "cell", name: "startedAt" },
          },
        },
      });
    });

    it("rejects the removed static Dialog.*TurnsSince form", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
  if (Dialog.userTurnsSince(startedAt) >= 1) {
    $instruct(\`pivot\`);  }
}
`),
      ).toThrow(/was replaced by cursor methods/);
    });

    it("rejects cursor turn-difference calls with the wrong argument count", () => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
  if (Dialog.cursor.totalTurnsSince() >= 1) {
    $instruct(\`pivot\`);  }
}
`),
      ).toThrow(/accepts exactly one cursor/);

      expect(() =>
        parse(`
"arc";
function Main() {
  let startedAt = Dialog.Cursor();
  let endedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
  endedAt.$set(Dialog.cursor);
  if (Dialog.cursor.totalTurnsSince(startedAt, endedAt) >= 1) {
    $instruct(\`pivot\`);  }
}
`),
      ).toThrow(/accepts exactly one cursor/);
    });

    it("computes a signed difference between two stored cursors", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  let endedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  $instruct(\`first\`);
  endedAt.$set(Dialog.cursor);

  if (startedAt.userTurnsSince(endedAt) < 0) {
    $instruct(\`negative confirmed\`);
  }
}
`);

      const runtime = new Runtime().add("dialog-signed-arc", document).init();
      const seeded = runtime.newTraversal(arc("dialog-signed-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.instructions.map((item) => item.text)).toEqual(["first"]);

      // The live cursor advances before the report; endedAt snapshots the later
      // coordinate (2,0), so startedAt - endedAt is a negative signed difference
      // and the gated branch emits.
      const second = progressBrief(
        runtime,
        first,
        {
          move: "proceed",
          instructions: appliedInstructions(first),
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [] },
      );
      expect(rootTraversal(second).cells.endedAt).toEqual({
        user: 2,
        self: 0,
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "negative confirmed",
      ]);
    });
  });

  describe("cursor.validity", () => {
    it("poisons traversal when the live Dialog.cursor moves backwards from a baseline", () => {
      const document = parse(`
"arc";

function Main() {
  let baseline = Dialog.Cursor();
  let topic = Str();
  topic.observing = \`what topic\`;
  baseline.$set(Dialog.cursor);

  $observe(topic);
  if (Dialog.cursor.totalTurnsSince(baseline) > 0) {
    $instruct(\`second\`);
  }
}
`);

      const runtime = new Runtime()
        .add("dialog-backwards-arc", document)
        .init();
      const seeded = runtime.newTraversal(arc("dialog-backwards-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 3, self: 0 },
        lastTurns: [],
      });
      expect(first.observations).toHaveLength(1);

      // The host supplies a cursor smaller than the snapshotted baseline; the
      // observation write rewalks the body, and the fresh live receiver must
      // reject the backwards movement rather than count negatively.
      const second = progressTerminal(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 1, self: 0 }, lastTurns: [] },
      );
      expect(rootTraversal(second).phase).toBe("poisoned");
      expect(second.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cursor-moved-backwards",
          reason: expect.stringContaining("moved backwards"),
        }),
      ]);
    });

    it("poisons traversal when a stored cursor is ahead of the live Dialog.cursor baseline", () => {
      const document = parse(`
"arc";

function Main() {
  let snapshot = Dialog.Cursor();
  let topic = Str();
  topic.observing = \`what topic\`;
  snapshot.$set(Dialog.cursor);

  $observe(topic);
  if (snapshot.totalTurnsSince(Dialog.cursor) < 0) {
    $instruct(\`second\`);
  }
}
`);

      const runtime = new Runtime()
        .add("dialog-baseline-backwards-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("dialog-baseline-backwards-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 3, self: 0 },
        lastTurns: [],
      });
      expect(first.observations).toHaveLength(1);

      // The frozen snapshot {3,0} ends up ahead of the smaller live cursor {1,0},
      // so `snapshot - Dialog.cursor` is positive — the observation write rewalks
      // the body, and the fresh live baseline moved backwards and must reject
      // rather than return a positive count.
      const second = progressTerminal(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 1, self: 0 }, lastTurns: [] },
      );
      expect(rootTraversal(second).phase).toBe("poisoned");
      expect(second.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cursor-moved-backwards",
          reason: expect.stringContaining("moved backwards"),
        }),
      ]);
    });

    it("poisons traversal for invalid current cursor shapes", () => {
      const invalidCurrent = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
}
`);
      const invalidCursors = [
        { user: -1, self: 0 },
        { user: 1.5, self: 0 },
        { user: Number.MAX_SAFE_INTEGER + 1, self: 0 },
        { user: 1 },
        "cursor",
      ];

      invalidCursors.forEach((cursor, index) => {
        const runtime = new Runtime()
          .add(`dialog-invalid-cursor-arc-${index}`, invalidCurrent)
          .init();
        const seeded = runtime.newTraversal(
          arc(`dialog-invalid-cursor-arc-${index}`, "Main"),
        );
        seeded.phase = "entered";
        const invalid = startTerminal(runtime, [seeded], {
          cursor,
          lastTurns: [],
        } as unknown as Dialog);
        expect(rootTraversal(invalid).phase).toBe("poisoned");
        expect(invalid.issues).toEqual([
          expect.objectContaining({
            kind: "poisoned-traversal",
            reasonCode: "invalid-dialog-cursor",
            reason: expect.stringContaining("must be a valid Dialog cursor"),
          }),
        ]);
      });
    });

    it("poisons traversal when cursor.*TurnsSince receives a non-cursor", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Num();
  startedAt.$set(1);
  if (Dialog.cursor.totalTurnsSince(startedAt) > 0) {
    $instruct(\`pivot\`);  }
}
`);

      const runtime = new Runtime()
        .add("dialog-non-cursor-since-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("dialog-non-cursor-since-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reason: expect.stringContaining("must be a valid Dialog cursor"),
        }),
      ]);
    });

    it("poisons traversal when cursor.*TurnsSince has a non-cursor receiver", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Num();
  startedAt.$set(1);
  if (startedAt.totalTurnsSince(Dialog.cursor) > 0) {
    $instruct(\`pivot\`);  }
}
`);

      const runtime = new Runtime()
        .add("dialog-non-cursor-receiver-arc", document)
        .init();
      const seeded = runtime.newTraversal(
        arc("dialog-non-cursor-receiver-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startTerminal(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reason: expect.stringContaining("must be a valid Dialog cursor"),
        }),
      ]);
    });
  });

  describe("cursor.views", () => {
    const REVIEWER_DIALOG: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
      view: "reviewer",
    };

    // The cursor comparison sits behind an observation: dialog reads are
    // pinned per walk, so the comparison re-fires through the observation
    // write's rewalk (a real state change), not through dialog advancement.
    function markedRuntime(name: string) {
      const document = parse(`
"arc";

function Main() {
  let mark = Dialog.Cursor();
  let topic = Str();
  topic.observing = \`what topic\`;
  mark.$set(Dialog.cursor);

  $observe(topic);
  $instruct(\`work\`);
  if (Dialog.cursor.userTurnsSince(mark) >= 1) {
    $instruct(\`enough\`);  }
}
`);
      const runtime = new Runtime().add(name, document).init();
      const seeded = runtime.newTraversal(arc(name, "Main"));
      seeded.phase = "entered";
      return { runtime, seeded };
    }

    it("stamps stored cursors with the supplied dialog's view and round-trips it", () => {
      const { runtime, seeded } = markedRuntime("cursor-stamp-arc");
      const brief = startRun(runtime, [seeded], REVIEWER_DIALOG);
      expect(brief.observations).toHaveLength(1);
      expect(rootTraversal(brief).cells.mark).toEqual({
        user: 0,
        self: 0,
        view: "reviewer",
      });

      const revived = JSON.parse(
        JSON.stringify(brief.traversals),
      ) as ArcTraversalSet;
      const root = revived.find(
        (traversal) => traversal.enteredBy === undefined,
      );
      expect(root?.cells.mark).toEqual({
        user: 0,
        self: 0,
        view: "reviewer",
      });
    });

    it("keeps same-view TurnsSince semantics", () => {
      const { runtime, seeded } = markedRuntime("cursor-same-view-arc");
      const first = startRun(runtime, [seeded], REVIEWER_DIALOG);

      const after = progressBrief(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [], view: "reviewer" },
      );
      expect(after.issues).toEqual([]);
      expect(after.instructions.map((item) => item.text)).toEqual(["work"]);
      const enough = progressBrief(
        runtime,
        after,
        {
          move: "proceed",
          instructions: appliedInstructions(after),
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [], view: "reviewer" },
      );
      expect(enough.instructions.map((item) => item.text)).toEqual(["enough"]);
    });

    it("treats unstamped cursors and unstamped dialogs as the default view", () => {
      const { runtime, seeded } = markedRuntime("cursor-default-view-arc");
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(rootTraversal(first).cells.mark).toEqual({ user: 0, self: 0 });

      const after = progressBrief(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [] },
      );
      expect(after.issues).toEqual([]);
      expect(after.instructions.map((item) => item.text)).toEqual(["work"]);
      const enough = progressBrief(
        runtime,
        after,
        {
          move: "proceed",
          instructions: appliedInstructions(after),
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [] },
      );
      expect(enough.instructions.map((item) => item.text)).toEqual(["enough"]);
    });

    it("poisons a cross-view comparison with a reason naming both views", () => {
      const { runtime, seeded } = markedRuntime("cursor-cross-view-arc");
      const first = startRun(runtime, [seeded], REVIEWER_DIALOG);

      // The stored mark carries view "reviewer"; after the observation resolves,
      // the following comparison reads the live default-view cursor and poisons
      // the run as an authored runtime error.
      const poisoned = progressTerminal(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 2, self: 0 }, lastTurns: [] },
      );
      expect(poisoned.issues).toHaveLength(1);
      expect(poisoned.issues[0]).toMatchObject({
        kind: "poisoned-traversal",
        reasonCode: "cross-view-comparison",
      });
      expect(poisoned.issues[0]?.reason).toContain(
        "the receiver was read under the default view",
      );
      expect(poisoned.issues[0]?.reason).toContain(
        'the baseline under view "reviewer"',
      );
      expect("instructions" in poisoned).toBe(false);
      expect("judgments" in poisoned).toBe(false);
      expect("allowedMoves" in poisoned).toBe(false);
      expect(poisoned.canProgress).toBe(false);
      expect(rootTraversal(poisoned).phase).toBe("poisoned");
    });

    it("still rejects a live cursor that moved backwards within one view", () => {
      const { runtime, seeded } = markedRuntime("cursor-backwards-arc");
      const first = startRun(runtime, [seeded], {
        cursor: { user: 3, self: 0 },
        lastTurns: [],
        view: "reviewer",
      });

      const poisoned = progressTerminal(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "x" },
          },
        },
        { cursor: { user: 1, self: 0 }, lastTurns: [], view: "reviewer" },
      );
      expect(rootTraversal(poisoned).phase).toBe("poisoned");
      expect(poisoned.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cursor-moved-backwards",
        }),
      ]);
    });
  });
});
