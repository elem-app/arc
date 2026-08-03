/**
 * Behavior tests for the Node Structure and Config area (`node.*` and `cfg.*`
 * entries in specs/testing.md).
 *
 * Ported from `parser.test.ts` and `runtime.test.ts`. All semantic results
 * (judge/observe/host calls) are injected through reports, so execution is
 * fully deterministic — there is no nondeterminism and no flakiness
 * mitigation is needed.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type { ArcTraversalSet } from "../src/types.js";
import {
  EMPTY_DIALOG,
  arc,
  node,
  ownedChild,
  progressBrief,
  rootTraversal,
  singleObservations,
  startRun,
} from "./helpers.js";

const ARC_SOURCE = `
"arc";

import { Advanced } from "advanced";
import Memoir from "host:memoir";

function HeavyMetal() {
  this.displayName = "Heavy Metal";
  this.description = "Share heavy metal taste";
  this.forgetfulEntry = true;

  let interest = Enum(["cold", "warm", "hot"], {
    observing: \`how interested is \${user} in metal\`,
  });

  this.trigger = () => {
    if (judge(\`\${user} asks about music\`)) {
      return true;
    }
    return false;
  };

  this.effects = () => {
    $observe(interest);
    if (interest >= "warm") {
      Memoir.facts.$apply(\`\${user} is open to metal\`);
    }
  };

  $enter(Surface);
  if (interest >= "warm") {
    $enter(Advanced);
  }

  function Surface() {
    let subgenre = Enum(["unknown", "thrash", "doom"], {
      observing: \`what subgenre does \${user} like\`,
    });
    $observeOrAsk(subgenre);
    $instruct(\`Talk about \${subgenre}.\`);  }
}
`;

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

describe("node structure and config", () => {
  describe("node.sections", () => {
    it("parses Arc into the new root/node IR", () => {
      const document = parse(ARC_SOURCE);

      expect(document.roots).toHaveLength(1);
      expect(document.roots[0]?.identifier).toBe("HeavyMetal");
      expect(document.roots[0]?.displayName).toBe("Heavy Metal");
      expect(document.roots[0]?.forgetfulEntry).toBe(true);
      expect(document.imports[0]?.importedName).toBe("Advanced");
      expect(document.imports[0]?.localName).toBe("Advanced");
      expect(document.hostModules[0]).toMatchObject({
        module: "memoir",
        importedName: "default",
        localName: "Memoir",
        source: "host:memoir",
      });

      const root = document.roots[0]!;
      expect(root.cells).toHaveLength(1);
      expect(root.trigger).toHaveLength(2);
      expect(root.effects).toHaveLength(2);
      expect(root.effects?.[1]).toMatchObject({
        kind: "if",
        consequent: [
          {
            kind: "host-call",
            module: "memoir",
            target: ["facts"],
            operation: "apply",
          },
        ],
      });
      expect(root.statements[0]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "Surface", mode: "canonical" },
      });

      const surface = root.children.find(
        (child) => child.identifier === "Surface",
      );
      expect(surface).toBeDefined();
      expect(surface?.cells[0]?.name).toBe("subgenre");
      expect(surface?.statements[0]).toMatchObject({
        kind: "observeOrAsk",
        target: ["subgenre"],
      });
      expect(surface?.statements[1]).toMatchObject({
        kind: "instruction",
        mode: "once",
      });
    });

    it("assigns structural element ids scoped by SEG", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  this.trigger = () => {
    $observe(ready);
    if (judge(\`is \${user} ready\`)) {
      return true;
    }
  };

  this.effects = () => {
    $observe(ready);
    if (ready == true) {
      ready.$set(false);
    }
  };

  $instruct(\`a\`);  if (ready == true) {
    $observe(ready);
    $instruct(\`b\`);  } else {
    if (judge(\`fallback\`)) {
      $instruct(\`fallback\`);    }
  }
  $enter(Child);

  function Child() {
    ready.$set(true);
    $instruct(\`c\`);  }
}
`);

      const root = document.roots[0]!;
      expect(
        root.trigger?.map((statement) =>
          "id" in statement ? statement.id : null,
        ),
      ).toEqual(["trigger/0", "trigger/1"]);
      if (!root.trigger?.[1] || root.trigger[1].kind !== "if") {
        throw new Error("expected trigger if");
      }
      expect(root.trigger[1].test).toMatchObject({
        kind: "judge",
        id: "trigger/1~0",
      });
      expect(root.effects?.[0]).toMatchObject({
        kind: "observe",
        id: "effects/0",
      });
      expect(root.effects?.[1]).toMatchObject({ kind: "if", id: "effects/1" });
      const effectBranch =
        root.effects?.[1] && root.effects[1].kind === "if"
          ? root.effects[1].consequent[0]
          : undefined;
      expect(effectBranch).toMatchObject({ kind: "set", id: "effects/1c/0" });
      expect(root.statements[0]).toMatchObject({
        kind: "instruction",
        id: "body/0",
      });
      const branch = root.statements[1];
      expect(branch).toMatchObject({ kind: "if", id: "body/1" });
      if (!branch || branch.kind !== "if") throw new Error("expected if");
      expect(branch.consequent[0]).toMatchObject({
        kind: "observe",
        id: "body/1c/0",
      });
      expect(branch.consequent[1]).toMatchObject({
        kind: "instruction",
        id: "body/1c/1",
      });
      expect(branch.alternate?.[0]).toMatchObject({ kind: "if" });
      if (!branch.alternate?.[0] || branch.alternate[0].kind !== "if") {
        throw new Error("expected alternate if");
      }
      expect(branch.alternate[0].test).toMatchObject({
        kind: "judge",
        id: "body/1a/0~0",
      });
      expect(branch.alternate[0].consequent[0]).toMatchObject({
        kind: "instruction",
        id: "body/1a/0c/0",
      });
      expect(root.statements[2]).toMatchObject({
        kind: "enter-node",
        id: "body/2",
      });

      // Ids are node-relative: the child has its own `body/` scope.
      const child = root.children.find((entry) => entry.identifier === "Child");
      expect(child?.statements[0]).toMatchObject({ kind: "set", id: "body/0" });
      expect(child?.statements[1]).toMatchObject({
        kind: "instruction",
        id: "body/1",
      });
    });
  });

  describe("node.identity", () => {
    it("resolves references by structural identifier regardless of displayName", () => {
      const document = parse(`
"arc";

function First() {
  this.displayName = "Second";
  $enter(Second);

  function Second() {
    this.displayName = "First";
    $instruct(\`work\`);
  }
}
`);

      expect(document.roots[0]?.identifier).toBe("First");
      expect(document.roots[0]?.displayName).toBe("Second");
      expect(document.roots[0]?.children[0]?.identifier).toBe("Second");
      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "Second" },
      });
    });
  });

  describe("cfg.display-metadata", () => {
    it("rejects non-literal displayName and description", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  this.displayName = 42;
}
`),
      ).toThrow(/displayName must be a string literal/);

      expect(() =>
        parse(`
"arc";

function Main() {
  this.description = ["nope"];
}
`),
      ).toThrow(/description must be a string literal/);
    });
  });

  describe("cfg.guidance", () => {
    it("parses this.guidance and this.description into node metadata", () => {
      const document = parse(`
"arc";

function Main() {
  this.description = "Guided main arc";
  this.guidance = "Keep it casual.";
  $instruct(\`hello\`);
}
`);
      expect(document.roots[0]?.description).toBe("Guided main arc");
      expect(document.roots[0]?.guidance).toMatchObject({
        value: "Keep it casual.",
      });
    });
  });

  describe("cfg.forgetful-entry", () => {
    it("uses this.forgetfulEntry for node frame cleanup", () => {
      const document = parse(`
"arc";
function Good() {
  this.forgetfulEntry = true;
}
`);

      expect(document.roots[0]?.forgetfulEntry).toBe(true);
    });

    it("defaults forgetfulEntry to false and accepts an explicit false", () => {
      const defaultDocument = parse(`
"arc";
function DefaultFrame() {}
`);
      const explicitDocument = parse(`
"arc";
function RetainedFrame() {
  this.forgetfulEntry = false;
}
`);

      expect(defaultDocument.roots[0]?.forgetfulEntry).toBe(false);
      expect(explicitDocument.roots[0]?.forgetfulEntry).toBe(false);
    });

    it("keeps resolved action state for the lifetime of one entry regardless of forgetfulEntry", () => {
      // this.forgetfulEntry governs re-entry behavior only: the frame is
      // entry-scoped state, reset when a new entry begins (see the deflect
      // re-entry test below) and never within an entry.
      const retainedFrameDocument = parse(`
"arc";

function Main() {
  let topic = Enum(["unknown", "metal"]);
  topic.observing = \`what topic does \${user} want\`;

  $instruct(\`intro\`);  $observeOrAsk(topic);
  $instruct(\`after \${topic}\`);}
`);
      const retainedFrameRuntime = new Runtime().add(
        "retained-frame-arc",
        retainedFrameDocument,
      );
      const retainedFrameSeeded = retainedFrameRuntime.newTraversal(
        arc("retained-frame-arc", "Main"),
      );
      retainedFrameSeeded.phase = "entered";
      const retainedFrameInitial = startRun(
        retainedFrameRuntime,
        [retainedFrameSeeded],
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "hi" }],
        },
      );
      const retainedFrameAsk = progressBrief(
        retainedFrameRuntime,
        retainedFrameInitial,
        {
          move: "proceed",
        },
      );
      const retainedFrameResumed = startRun(
        retainedFrameRuntime,
        runtimeAfterAsk(retainedFrameRuntime, retainedFrameAsk),
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "later" }],
        },
      );

      expect(
        retainedFrameInitial.instructions.map((item) => item.text),
      ).toEqual(["intro"]);
      expect(retainedFrameResumed.instructions).toEqual([]);

      const forgetfulEntryDocument = parse(`
"arc";

function Main() {
  this.forgetfulEntry = true;
  let topic = Enum(["unknown", "metal"]);
  topic.observing = \`what topic does \${user} want\`;

  $instruct(\`intro\`);  $observeOrAsk(topic);
  $instruct(\`after \${topic}\`);}
`);
      const forgetfulEntryRuntime = new Runtime().add(
        "forgetful-entry-arc",
        forgetfulEntryDocument,
      );
      const forgetfulEntrySeeded = forgetfulEntryRuntime.newTraversal(
        arc("forgetful-entry-arc", "Main"),
      );
      forgetfulEntrySeeded.phase = "entered";
      const forgetfulEntryInitial = startRun(
        forgetfulEntryRuntime,
        [forgetfulEntrySeeded],
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "hi" }],
        },
      );
      const forgetfulEntryAsk = progressBrief(
        forgetfulEntryRuntime,
        forgetfulEntryInitial,
        {
          move: "proceed",
        },
      );
      const forgetfulEntryResumed = startRun(
        forgetfulEntryRuntime,
        forgetfulEntryAsk.traversals,
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "later" }],
        },
      );

      expect(forgetfulEntryResumed.instructions).toEqual([]);
    });

    it("preserves cells across a forgetful entry while the frame resets", () => {
      const document = parse(`
"arc";

function Main() {
  this.catchDeflection = () => true;
  $enter(Child);

  function Child() {
    this.forgetfulEntry = true;
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    let ready = Bool();
    ready.observing = \`is \${user} ready\`;
    $observe(topic);
    $observeOrAsk(ready);
  }
}
`);
      const runtime = new Runtime().add("forgetful-entry-keep-arc", document);
      const seeded = runtime.newTraversal(
        arc("forgetful-entry-keep-arc", "Main"),
      );
      seeded.phase = "entered";

      const observing = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(singleObservations(observing).map((item) => item.cell)).toEqual([
        "topic",
      ]);
      const asking = progressBrief(runtime, observing, {
        move: "proceed",
        observations: {
          [observing.observations[0]!.id]: {
            status: "resolved",
            value: "metal",
          },
        },
      });
      expect(singleObservations(asking).map((item) => item.cell)).toEqual([
        "ready",
      ]);
      expect(asking.allowedMoves).toContain("deflect");

      // Deflect the child; Main catches and its rewalk re-enters. The
      // forgetful re-entry drops the child's resolution frame — the observe
      // replays — while the observed value survives the reset.
      const reentered = progressBrief(runtime, asking, { move: "deflect" });
      const child = ownedChild(rootTraversal(reentered), "Main.Child");
      expect(child?.enterCount).toBe(2);
      expect(child?.cells.topic).toBe("metal");
      expect(singleObservations(reentered).map((item) => item.cell)).toEqual([
        "topic",
      ]);
      expect(singleObservations(reentered)[0]!.currentValue).toBe("metal");
    });
  });

  describe("node.write-diff-mode", () => {
    it("sets every parsed node to advance", () => {
      const document = parse(`
"arc";

function Main() {
  function Child() {}
}
`);

      expect(document.roots[0]?.writeDiffMode).toBe("advance");
      expect(document.roots[0]?.children[0]?.writeDiffMode).toBe("advance");
    });
  });

  describe("cfg.host-params", () => {
    it("parses instruction host params metadata for instruct and instructLoop", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`Welcome the user.\`, {
    hostParams: {
      consumer: {
        id: "greeter",
        mode: "foreground",
        tools: ["profile"],
      },
    },
  });

  $instructLoop(\`Track updates.\`, {
    hostParams: {
      consumer: {
        id: "researcher",
        mode: "background",
      },
    },
    resolveWhen: \`\${self} is done tracking updates\`,
  });
}
`);

      const [first, second] = document.roots[0]!.statements;
      expect(first).toMatchObject({
        kind: "instruction",
        mode: "once",
        hostParams: {
          consumer: {
            id: "greeter",
            mode: "foreground",
            tools: ["profile"],
          },
        },
      });
      expect(second).toMatchObject({
        kind: "instruction",
        mode: "persistent",
        hostParams: {
          consumer: {
            id: "researcher",
            mode: "background",
          },
        },
      });
    });

    it("parses arbitrary literal instruction host params metadata", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`String params.\`, {
    hostParams: "greeter",
  });

  $instruct(\`Array params.\`, {
    hostParams: ["greeter", null, true, 3],
  });
}
`);

      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "instruction",
        hostParams: "greeter",
      });
      expect(document.roots[0]?.statements[1]).toMatchObject({
        kind: "instruction",
        hostParams: ["greeter", null, true, 3],
      });
    });

    it("parses node host params metadata", () => {
      const document = parse(`
"arc";

function Main() {
  let status = Bool();
  this.hostParams = {
    consumer: {
      id: "reviewer",
      mode: "foreground",
    },
    priority: 2,
  };

  $observe(status);
}
`);

      expect(document.roots[0]).toMatchObject({
        hostParams: {
          consumer: {
            id: "reviewer",
            mode: "foreground",
          },
          priority: 2,
        },
      });
    });

    it("rejects unsupported instruction host params object forms", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $instruct(\`Welcome the user.\`, {
    hostParams: {
      ...extra,
    },
  });
}
`),
      ).toThrow(/instruct\(\)\.hostParams objects do not support spread/);

      expect(() =>
        parse(`
"arc";

function Main() {
  $instruct(\`Welcome the user.\`, {
    hostParams: {
      [consumer]: "greeter",
    },
  });
}
`),
      ).toThrow(
        /instruct\(\)\.hostParams objects do not support computed keys/,
      );
    });

    it("rejects semantic or dynamic instruction host params metadata", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $instruct(\`Welcome the user.\`, {
    hostParams: {
      consumer: {
        id: \`greeter-\${user}\`,
      },
    },
  });
}
`),
      ).toThrow(
        /instruct\(\)\.hostParams only supports literal metadata values/,
      );

      expect(() =>
        parse(`
"arc";

function Main() {
  $instruct(\`Welcome the user.\`, {
    hostParams: {
      consumer: {
        id: user,
      },
    },
  });
}
`),
      ).toThrow(
        /instruct\(\)\.hostParams only supports literal metadata values/,
      );
    });

    it("rejects semantic or dynamic node host params metadata", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  this.hostParams = {
    consumer: {
      id: \`reviewer-\${user}\`,
    },
  };
}
`),
      ).toThrow(/this\.hostParams only supports literal metadata values/);
    });

    it("carries literal instruction host params metadata into instruction briefs", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`Welcome \${user}.\`, {
    hostParams: {
      consumer: {
        id: "greeter",
        mode: "foreground",
        tools: ["profile"],
      },
    },
  });
  $instruct(\`No params.\`);
}
`);
      const runtime = new Runtime().add(
        "instruction-host-params-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("instruction-host-params-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        [
          { kind: "text", value: "Welcome " },
          { kind: "entity", name: "user" },
          { kind: "text", value: "." },
        ],
      ]);
      expect(brief.instructions[0]?.hostParams).toEqual({
        consumer: {
          id: "greeter",
          mode: "foreground",
          tools: ["profile"],
        },
      });

      const next = progressBrief(runtime, brief, { move: "proceed" });
      expect(next.instructions.map((item) => item.text)).toEqual([
        "No params.",
      ]);
      expect(next.instructions[0]?.hostParams).toBeUndefined();
    });

    it("carries node host params into semantic briefs", () => {
      const observationDocument = parse(`
"arc";

function Main() {
  let ready = Bool();
  this.hostParams = { consumer: { id: "observer" } };
  $observe(ready);
}
`);
      const observationRuntime = new Runtime().add(
        "semantic-observation-arc",
        observationDocument,
      );
      const observationTraversal = observationRuntime.newTraversal(
        arc("semantic-observation-arc", "Main"),
      );
      observationTraversal.phase = "entered";
      const observationBrief = startRun(
        observationRuntime,
        [observationTraversal],
        EMPTY_DIALOG,
      );
      expect(observationBrief.observations[0]?.hostParams).toEqual({
        consumer: { id: "observer" },
      });

      const judgmentDocument = parse(`
"arc";

function Main() {
  this.hostParams = { consumer: { id: "judge" } };
  if (judge(\`\${user} is ready\`)) {
    $instruct(\`Proceed.\`);  }
}
`);
      const judgmentRuntime = new Runtime().add(
        "semantic-judgment-arc",
        judgmentDocument,
      );
      const judgmentTraversal = judgmentRuntime.newTraversal(
        arc("semantic-judgment-arc", "Main"),
      );
      judgmentTraversal.phase = "entered";
      const judgmentBrief = startRun(
        judgmentRuntime,
        [judgmentTraversal],
        EMPTY_DIALOG,
      );
      expect(judgmentBrief.judgments[0]?.hostParams).toEqual({
        consumer: { id: "judge" },
      });

      const hostCallDocument = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  this.hostParams = { consumer: { id: "tool-runner" } };
  lucky.$set(Dice.roll(20) > 10);
}
`);
      const hostCallRuntime = new Runtime().add(
        "semantic-hostcall-arc",
        hostCallDocument,
      );
      const hostCallTraversal = hostCallRuntime.newTraversal(
        arc("semantic-hostcall-arc", "Main"),
      );
      hostCallTraversal.phase = "entered";
      const hostCallBrief = startRun(
        hostCallRuntime,
        [hostCallTraversal],
        EMPTY_DIALOG,
      );
      expect(hostCallBrief.hostCalls[0]?.hostParams).toEqual({
        consumer: { id: "tool-runner" },
      });

      const instructionDocument = parse(`
"arc";

function Main() {
  this.hostParams = { consumer: { id: "guide" } };
  $instruct(\`Proceed.\`);
}
`);
      const instructionRuntime = new Runtime().add(
        "semantic-instruction-arc",
        instructionDocument,
      );
      const instructionTraversal = instructionRuntime.newTraversal(
        arc("semantic-instruction-arc", "Main"),
      );
      instructionTraversal.phase = "entered";
      const instructionBrief = startRun(
        instructionRuntime,
        [instructionTraversal],
        EMPTY_DIALOG,
      );
      expect(instructionBrief.instructions[0]?.hostParams).toEqual({
        consumer: { id: "guide" },
      });
    });

    it("merges object instruction host params over node host params", () => {
      const document = parse(`
"arc";

function Main() {
  this.hostParams = {
    consumer: { id: "node" },
    priority: 1,
  };
  $instruct(\`Proceed.\`, {
    hostParams: {
      consumer: { id: "instruction" },
      tone: "brief",
    },
  });
}
`);
      const runtime = new Runtime().add(
        "instruction-merged-params-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("instruction-merged-params-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions[0]?.hostParams).toEqual({
        consumer: { id: "instruction" },
        priority: 1,
        tone: "brief",
      });
    });

    it("uses merged instruction host params for resolution host calls", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  this.hostParams = {
    consumer: { id: "node" },
    priority: 1,
  };
  $instructLoop(\`Proceed.\`, {
    hostParams: {
      consumer: { id: "instruction" },
      tone: "brief",
    },
    resolveWhen: () => {
      if (Dice.roll(20) > 10) {
        return judge(\`\${self} is finished\`);
      }
      return false;
    },
  });
}
`);
      const runtime = new Runtime().add(
        "instruction-resolution-params-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("instruction-resolution-params-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const expectedParams = {
        consumer: { id: "instruction" },
        priority: 1,
        tone: "brief",
      };
      expect(brief.hostCalls[0]?.hostParams).toEqual(expectedParams);
    });

    it("uses merged instruction host params for resolution judgments", () => {
      const document = parse(`
"arc";

function Main() {
  this.hostParams = {
    consumer: { id: "node" },
    priority: 1,
  };
  $instructLoop(\`Proceed.\`, {
    hostParams: {
      consumer: { id: "instruction" },
      tone: "brief",
    },
    resolveWhen: \`\${self} is finished\`,
  });
}
`);
      const runtime = new Runtime().add(
        "instruction-resolution-judgment-params-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("instruction-resolution-judgment-params-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.judgments[0]?.hostParams).toEqual({
        consumer: { id: "instruction" },
        priority: 1,
        tone: "brief",
      });
    });

    it("carries null transition host params for a child that declares none", () => {
      const document = parse(`
"arc";

function Main() {
  this.hostParams = { consumer: { id: "writer" } };
  $enter(Child);

  function Child() {
    $instruct(\`child work\`);
  }
}
`);
      const runtime = new Runtime().add("transition-no-inherit-arc", document);
      const seeded = runtime.newTraversal(
        arc("transition-no-inherit-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = runtime.start([seeded], EMPTY_DIALOG);

      // The effective consumer does not inherit: the position's params are the
      // child's own (none), not the parent's.
      expect(brief.transition?.position).toBe(
        node("transition-no-inherit-arc", "Main.Child"),
      );
      expect(brief.transition?.hostParams).toBeNull();
    });
  });

  describe("cfg.duplicate-assignment", () => {
    it.each([
      [
        "displayName",
        'this.displayName = "First";\n  this.displayName = "Second";',
      ],
      [
        "description",
        'this.description = "First";\n  this.description = "Second";',
      ],
      ["guidance", "this.guidance = `first`;\n  this.guidance = `second`;"],
      [
        "hostParams",
        'this.hostParams = { consumer: { id: "first" } };\n  this.hostParams = { consumer: { id: "second" } };',
      ],
      [
        "forgetfulEntry",
        "this.forgetfulEntry = true;\n  this.forgetfulEntry = false;",
      ],
      ["trigger", "this.trigger = () => true;\n  this.trigger = () => false;"],
      [
        "deflectWhen",
        "this.deflectWhen = `first`;\n  this.deflectWhen = `second`;",
      ],
      [
        "catchDeflection",
        "this.catchDeflection = () => true;\n  this.catchDeflection = () => false;",
      ],
      [
        "guard",
        "this.guard = () => State.COVERED;\n  this.guard = () => State.SKIPPED;",
      ],
      [
        "effects",
        "this.effects = () => ready.$set(true);\n  this.effects = () => ready.$set(false);",
      ],
    ])("rejects duplicate this.%s assignments", (property, assignments) => {
      expect(() =>
        parse(`
"arc";
function Main() {
  let ready = Bool();
  ${assignments}
}
`),
      ).toThrow(`Duplicate node config assignment: this.${property}`);
    });
  });

  describe("cfg.hook-shapes", () => {
    it("requires trigger, guard, and effects callbacks to be arrow functions", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  this.trigger = function () {
    return true;
  };
}
`),
      ).toThrow(/this\.trigger must be an arrow function/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  this.guard = function () {
    return true;
  };
}
`),
      ).toThrow(/this\.guard must be an arrow function/);

      expect(() =>
        parse(`
"arc";
function Bad() {
  this.effects = function () {
    Memoir.facts.$apply(\`effect\`);
  };
}
`),
      ).toThrow(/this\.effects must be an arrow function/);
    });

    it("accepts a concise-body this.trigger and desugars it to a return", () => {
      const document = parse(`
"arc";

function Main() {
  this.trigger = () => judge(\`ready\`);
}
`);
      expect(document.roots[0]?.trigger).toMatchObject([
        { kind: "return", value: { kind: "judge" } },
      ]);
    });

    it("produces the same IR for a concise and an explicit-return hook body", () => {
      const concise = parse(`
"arc";

function Main() {
  this.deflectWhen = () => judge(\`leave\`);
  $instruct(\`i\`);
}
`);
      const block = parse(`
"arc";

function Main() {
  this.deflectWhen = () => {
    return judge(\`leave\`);
  };
  $instruct(\`i\`);
}
`);
      // Identical modulo source positions, which legitimately differ.
      const stripLoc = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value, (key, v) => (key === "loc" ? undefined : v)),
        );
      expect(stripLoc(concise.roots[0]?.deflectWhen)).toEqual(
        stripLoc(block.roots[0]?.deflectWhen),
      );
    });

    it("accepts a concise resolveWhen in enterLoop options", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  $enterLoop(Child, { resolveWhen: () => ready == true });
  function Child() {}
}
`);
      const enterLoop = document.roots[0]?.statements[0];
      expect(enterLoop).toMatchObject({
        kind: "enter-loop",
        resolveWhen: [{ kind: "return", value: { kind: "binary" } }],
      });
    });

    it("accepts a concise deflectWhen in instruct options", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`i\`, { deflectWhen: () => judge(\`bored\`) });
}
`);
      const instruction = document.roots[0]?.statements[0];
      expect(instruction).toMatchObject({
        kind: "instruction",
        deflectWhen: [{ kind: "return", value: { kind: "judge" } }],
      });
    });

    it("accepts a concise this.guard returning a State", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  function Child() {
    this.guard = () => State.SKIPPED;
    $instruct(\`i\`);
  }
}
`);
      const child = document.roots[0]?.children.find(
        (entry) => entry.identifier === "Child",
      );
      expect(child?.guard?.[0]).toMatchObject({ kind: "return" });
    });

    it("accepts a concise this.catchDeflection", () => {
      const document = parse(`
"arc";

function Main() {
  this.catchDeflection = () => true;
  $instruct(\`i\`);
}
`);
      expect(document.roots[0]?.catchDeflection).toMatchObject([
        { kind: "return", value: { kind: "literal", value: true } },
      ]);
    });

    it("accepts a concise this.effects as a single effect statement", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  this.effects = () => x.$set(true);
}
`);
      expect(document.roots[0]?.effects).toMatchObject([
        { kind: "set", target: ["x"] },
      ]);
    });

    it("accepts this.pendingState throughout an effects expression", () => {
      const document = parse(`
"arc";

function Main() {
  let outcome = Enum(["unknown", "covered", "deflected"]);
  this.effects = () => {
    if (this.pendingState == State.DEFLECTED) {
      outcome.$set(this.pendingState);
    }
  };
}
`);

      expect(document.roots[0]?.effects).toMatchObject([
        {
          kind: "if",
          test: {
            kind: "binary",
            left: { kind: "pendingState" },
            right: { kind: "literal", value: "deflected" },
          },
          consequent: [
            {
              kind: "set",
              value: { kind: "pendingState" },
            },
          ],
        },
      ]);
    });

    it("accepts this.deflection.escaped() throughout effects expressions", () => {
      const document = parse(`
"arc";

function Main() {
  let matched = Bool();

  this.effects = () => {
    if (this.deflection.escaped(Child)) {
      matched.$set(this.deflection.escaped(Child));
    }
  };

  function Child() {}
}
`);

      expect(document.roots[0]?.effects).toMatchObject([
        {
          kind: "if",
          test: {
            kind: "deflectionEscaped",
            target: { identifier: "Child" },
          },
          consequent: [
            {
              kind: "set",
              value: {
                kind: "deflectionEscaped",
                target: { identifier: "Child" },
              },
            },
          ],
        },
      ]);
    });

    it.each([
      [
        "the action graph",
        `if (this.pendingState == State.COVERED) { $instruct(\`x\`); }`,
      ],
      [
        "this.trigger",
        `this.trigger = () => this.pendingState == State.COVERED;`,
      ],
      [
        "this.guard",
        `this.guard = () => { if (this.pendingState == State.COVERED) return State.COVERED; };`,
      ],
      [
        "this.catchDeflection",
        `this.catchDeflection = () => this.pendingState == State.DEFLECTED;`,
      ],
      [
        "an instruction resolution hook",
        `$instructLoop(\`x\`, { resolveWhen: () => this.pendingState == State.COVERED });`,
      ],
    ])("rejects this.pendingState inside %s", (_label, statement) => {
      expect(() =>
        parse(`
"arc";

function Main() {
  ${statement}
}
`),
      ).toThrow(/this\.pendingState is only available inside this\.effects/);
    });
  });
});
