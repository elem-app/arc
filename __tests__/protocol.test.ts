/**
 * Behavior tests for the Protocol area (`proto.*` entries in specs/testing.md).
 *
 * Ported from `runtime.test.ts`. All semantic results (judge/observe/host
 * calls) are injected through reports, so execution is fully deterministic —
 * there is no nondeterminism and no flakiness mitigation is needed.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import {
  validateActionReport,
  validateTriggerReport,
} from "../src/runtime/briefs.js";
import { Runtime } from "../src/runtime/index.js";
import { mergeAndClonePayload } from "../src/runtime/payload.js";
import {
  runtimeError,
  runtimeErrorReasonCode,
} from "../src/runtime/report-validation.js";
import { cloneHostCallBrief, cloneHostEffect } from "../src/runtime/state.js";
import type {
  ActionReport,
  ArcTraversalSet,
  Dialog,
  HostCallBrief,
  HostEffectBrief,
  PayloadValue,
} from "../src/types.js";
import {
  EMPTY_DIALOG,
  METAL_SOURCE,
  appliedHostEffects,
  arc,
  node,
  payloadArray,
  payloadObject,
  progressBrief,
  renderSemanticTextForTest,
  rootTraversal,
  singleObservations,
  startRun,
  startTrigger,
  withExperimentalRewalk,
} from "./helpers.js";

describe("protocol", () => {
  describe("proto.registration", () => {
    it("throws on duplicate registration and unknown traversal arcs", () => {
      const document = parse(`
"arc";

function Main() {}
`);
      const runtime = new Runtime().add("registration-arc", document);

      expect(() => runtime.add("registration-arc", document)).toThrow(
        /already registered/,
      );
      expect(() =>
        runtime.newTraversal(arc("registration-arc", "Missing")),
      ).toThrow(/Unknown arc/);
    });

    it("registers multiple roots from one document by declaration identifier", () => {
      const document = parse(`
"arc";

function First() {
  $instruct(\`one\`);}

function Second() {
  $instruct(\`two\`);}
`);
      const runtime = new Runtime().add("main-arc", document);

      expect(runtime.has(arc("main-arc", "First"))).toBe(true);
      expect(runtime.has(arc("main-arc", "Second"))).toBe(true);
    });

    it("creates dormant root traversals with enterCount 0 until first entry", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`hello\`);}
`);
      const runtime = new Runtime().add("dormant-enter-count-arc", document);
      const traversal = runtime.newTraversal(
        arc("dormant-enter-count-arc", "Main"),
      );

      expect(traversal.phase).toBe("dormant");
      expect(traversal.enterCount).toBe(0);

      traversal.phase = "entered";
      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(rootTraversal(brief).enterCount).toBe(0);
      expect(brief.instructions.map((item) => item.text)).toEqual(["hello"]);
    });
  });

  describe("proto.trigger-scope", () => {
    it("scopes trigger calculation to the requested Arc refs", () => {
      const runtime = new Runtime().add(
        "scoped",
        parse(`
"arc";

function First() {
  this.trigger = () => judge(\`first matches\`);
}

function Second() {
  this.trigger = () => judge(\`second matches\`);
}
`),
      );

      const brief = startTrigger(runtime, EMPTY_DIALOG, [], {
        arcRefs: [arc("scoped", "Second")],
      });

      expect(brief.judgments).toHaveLength(1);
      expect(brief.judgments[0]?.sourceRef).toBe(node("scoped", "Second"));
      expect(brief.deps).toEqual([arc("scoped", "Second")]);
      expect(() =>
        startTrigger(runtime, EMPTY_DIALOG, [], {
          arcRefs: [arc("scoped", "Missing")],
        }),
      ).toThrow("Unknown arc");
    });

    it("retains the requested trigger scope across progressTrigger rounds", () => {
      const document = parse(`
"arc";

function Scoped() {
  let topic = Enum(["unknown", "metal"]);
  topic.observing = \`what topic\`;

  this.trigger = () => {
    $observe(topic);
    if (topic == "metal") {
      return true;
    }
    return false;
  };
}

function Outside() {
  this.trigger = () => {
    if (judge(\`always\`)) {
      return true;
    }
    return false;
  };
}
`);
      const runtime = new Runtime().add("trigger-scope-arc", document);
      const scopedRef = arc("trigger-scope-arc", "Scoped");
      const outsideNode = node("trigger-scope-arc", "Outside");

      const brief = startTrigger(runtime, EMPTY_DIALOG, undefined, {
        arcRefs: [scopedRef],
      });
      expect(brief.observations).toHaveLength(1);
      expect(brief.judgments).toEqual([]);

      const next = runtime.progressTrigger(
        brief,
        {
          observations: {
            [brief.observations[0]!.id]: { status: "resolved", value: "metal" },
          },
        },
        EMPTY_DIALOG,
      );

      expect(next.matched).toEqual(scopedRef);
      expect(
        next.judgments.every((item) => item.sourceRef !== outsideNode),
      ).toBe(true);
    });
  });

  describe("proto.start", () => {
    it("rejects starting the action stage without an entered root", () => {
      const document = parse(`
"arc";

function Main() {}
`);
      const runtime = new Runtime().add("start-phase-arc", document);
      const dormant = runtime.newTraversal(arc("start-phase-arc", "Main"));

      expect(() => runtime.start([dormant], EMPTY_DIALOG)).toThrow(
        /must be "entered"/,
      );
    });

    it("keeps other dormant roots dormant while the entered root runs", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`main work\`);
}

function Other() {
  $instruct(\`other work\`);
}
`);
      const runtime = new Runtime().add("co-root-arc", document);
      const entered = runtime.newTraversal(arc("co-root-arc", "Main"));
      entered.phase = "entered";
      const dormant = runtime.newTraversal(arc("co-root-arc", "Other"));

      const brief = startRun(runtime, [entered, dormant], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "main work",
      ]);
      expect(
        brief.traversals.find(
          (traversal) => traversal.ref === arc("co-root-arc", "Other"),
        )?.phase,
      ).toBe("dormant");
    });
  });

  describe("proto.brief-identity", () => {
    it("merges payloads with undefined override treated as absent", () => {
      const base: PayloadValue = { consumer: { id: "node" } };
      const merged = mergeAndClonePayload(base, undefined);

      payloadObject(payloadObject(merged).consumer).id = "changed";

      expect(base).toEqual({ consumer: { id: "node" } });
    });

    it("deep-clones nested payloads in host effects and host-call briefs", () => {
      const effectPayload: PayloadValue = { nested: { list: ["a"] } };
      const effect: HostEffectBrief = {
        id: "host-effect:test",
        sourceRef: node("clone-arc", "Main"),
        module: "memoir",
        target: ["facts"],
        operation: "apply",
        arguments: [effectPayload],
      };
      const clonedEffect = cloneHostEffect(effect);

      payloadArray(
        payloadObject(payloadObject(clonedEffect.arguments[0]!).nested).list,
      ).push("b");

      expect(effect.arguments[0]).toEqual({ nested: { list: ["a"] } });

      const callPayload: PayloadValue = { nested: { list: ["x"] } };
      const call: HostCallBrief = {
        id: "host-call:test",
        sourceRef: node("clone-arc", "Main"),
        module: "tools",
        target: ["lookup"],
        operation: "read",
        arguments: [callPayload],
        hostParams: { consumer: { id: "tools" } },
      };
      const clonedCall = cloneHostCallBrief(call);

      payloadArray(
        payloadObject(payloadObject(clonedCall.arguments[0]!).nested).list,
      ).push("y");
      payloadObject(payloadObject(clonedCall.hostParams).consumer).id =
        "changed";

      expect(call.arguments[0]).toEqual({ nested: { list: ["x"] } });
      expect(call.hostParams).toEqual({ consumer: { id: "tools" } });
    });

    it("deep-clones accepted host-call report payloads", () => {
      const hostCall: HostCallBrief = {
        id: "host-call:clone",
        sourceRef: node("clone-arc", "Main"),
        module: "tools",
        target: ["lookup"],
        operation: "read",
        arguments: [],
        hostParams: undefined,
      };
      const actionPayload: PayloadValue = { nested: { list: ["a"] } };
      const actionValidation = validateActionReport(
        {
          active: node("clone-arc", "Main"),
          canProgress: true,
          issues: [],
          judgments: [],
          observations: [],
          hostCalls: [hostCall],
          hostEffects: [],
          instructions: [],
          allowedMoves: ["poison", "proceed"],
        },
        {
          move: "proceed",
          hostCalls: { [hostCall.id]: actionPayload },
        },
      );

      payloadArray(
        payloadObject(
          payloadObject(actionValidation.accepted.hostCalls![hostCall.id]!)
            .nested,
        ).list,
      ).push("b");

      expect(actionPayload).toEqual({ nested: { list: ["a"] } });

      const triggerPayload: PayloadValue = { nested: { list: ["x"] } };
      const triggerValidation = validateTriggerReport(
        {
          matched: undefined,
          issues: [],
          judgments: [],
          observations: [],
          hostCalls: [hostCall],
          matchableArcs: [],
        },
        {
          hostCalls: { [hostCall.id]: triggerPayload },
        },
      );

      payloadArray(
        payloadObject(
          payloadObject(triggerValidation.accepted.hostCalls![hostCall.id]!)
            .nested,
        ).list,
      ).push("y");

      expect(triggerPayload).toEqual({ nested: { list: ["x"] } });
    });

    it("keeps private action continuation state isolated from returned briefs", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`first\`);
  $enter(Second);

  function Second() {
    $instruct(\`second\`);  }
}
`);
      const runtime = new Runtime().add("action-clone-arc", document);
      const seeded = runtime.newTraversal(arc("action-clone-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      brief.traversals[0]!.phase = "poisoned";
      brief.instructions[0]!.text = "mutated";

      const next = progressBrief(runtime, brief, { move: "proceed" });

      expect(next.instructions.map((item) => item.text)).toEqual(["second"]);
      expect(rootTraversal(next).phase).toBe("entered");
    });

    it("keeps private trigger continuation state isolated from returned briefs", () => {
      const document = parse(`
"arc";

function Main() {
  this.hostParams = { consumer: { id: "trigger" } };
  this.trigger = () => {
    return judge(\`\${user} is ready\`);
  };
  $instruct(\`started\`);}
`);
      const runtime = new Runtime().add("trigger-clone-arc", document);
      const seeded = runtime.newTraversal(arc("trigger-clone-arc", "Main"));
      const brief = startTrigger(
        runtime,
        { cursor: { user: 0, self: 0 }, lastTurns: [] },
        [seeded],
      );

      expect(brief.judgments).toHaveLength(1);
      brief.traversals[0]!.phase = "poisoned";
      brief.judgments[0]!.question = "mutated";
      payloadObject(payloadObject(brief.judgments[0]!.hostParams).consumer).id =
        "mutated";

      const next = runtime.progressTrigger(
        brief,
        { judgments: { [brief.judgments[0]!.id]: true } },
        EMPTY_DIALOG,
      );

      expect(next.matched).toBe(arc("trigger-clone-arc", "Main"));
      expect(next.traversals[0]?.phase).toBe("entered");
    });

    it("rejects cloned brief objects as caller misuse", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;
  $observeOrAsk(ready);

  this.trigger = () => {
    if (judge(\`greets\`)) {
      return true;
    }
    return false;
  };
}
`);
      const runtime = new Runtime().add("brief-identity-arc", document);

      const triggerBrief = startTrigger(runtime, EMPTY_DIALOG);
      const triggerClone = JSON.parse(JSON.stringify(triggerBrief));
      expect(() =>
        runtime.progressTrigger(triggerClone, {}, EMPTY_DIALOG),
      ).toThrow(/Unknown trigger brief/);

      const seeded = runtime.newTraversal(arc("brief-identity-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const clone = JSON.parse(JSON.stringify(brief));
      expect(() =>
        runtime.progress(clone, { move: "proceed" }, EMPTY_DIALOG),
      ).toThrow(/Unknown action brief/);
    });
  });

  describe("proto.moves", () => {
    it("rejects deflect move while an instruction brief is pending", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`hello\`);}
`);
      const runtime = new Runtime().add("instruction-move-arc", document);
      const seeded = runtime.newTraversal(arc("instruction-move-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);
      const nextBrief = progressBrief(runtime, brief, { move: "deflect" });
      expect(nextBrief.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-report",
          reasonCode: "illegal-move",
        }),
      ]);
    });

    it("rejects deflect move while a host effect is unreported", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let seen = Bool();
  seen.$set(true);
  this.effects = () => {
    Memoir.facts.$apply(\`the user was here\`);
  };
}
`);
      const runtime = new Runtime().add("effect-move-arc", document);
      const seeded = runtime.newTraversal(arc("effect-move-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      // An emitted host effect suppresses deflect the same way an instruction does.
      expect(brief.hostEffects).toHaveLength(1);
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);

      const nextBrief = progressBrief(runtime, brief, { move: "deflect" });
      expect(nextBrief.issues).toEqual([
        expect.objectContaining({
          kind: "invalid-report",
          reasonCode: "illegal-move",
        }),
      ]);
    });
  });

  describe("proto.report-validation", () => {
    it("returns invalid-report issues for invalid action reports", () => {
      const document = parse(METAL_SOURCE);
      const runtime = new Runtime().add("metal-arc", document);
      const triggerBrief = startTrigger(runtime, {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "music" }],
      });
      const triggerOutcome = runtime.progressTrigger(
        triggerBrief,
        {
          preferredMatch: arc("metal-arc", "Metal"),
          judgments: { [triggerBrief.judgments[0]!.id]: true },
        },
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "music" }],
        },
      );
      const brief = startRun(runtime, triggerOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(() =>
        progressBrief(runtime, brief, { move: "deflect" as "proceed" }),
      ).not.toThrow();

      const brief2 = startRun(runtime, triggerOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
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

      const brief3 = startRun(runtime, triggerOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
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
"arc";

import Dice from "host:rng";

function Main() {
  let lucky = Bool();
  lucky.$set(Dice.roll(20));
  $instruct(\`after\`);}
`);
      const runtime = new Runtime().add("action-host-id-arc", document);
      const seeded = runtime.newTraversal(arc("action-host-id-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
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
      const document = parse(METAL_SOURCE);
      const runtime = new Runtime().add("metal-arc", document);
      const triggerBrief = startTrigger(runtime, {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "music" }],
      });

      const unknownArc = runtime.progressTrigger(
        triggerBrief,
        {
          preferredMatch: arc("nonexistent", "Nope"),
        },
        {
          cursor: { user: 0, self: 0 },
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
          cursor: { user: 0, self: 0 },
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
  });

  describe("proto.batching", () => {
    it("does not batch instructions with different host params", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`First.\`, {
    hostParams: { consumer: { id: "first" } },
  });
  $instruct(\`Second.\`, {
    hostParams: { consumer: { id: "second", mode: "background" } },
  });
}
`);
      const runtime = new Runtime().add(
        "batched-instruction-host-params-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("batched-instruction-host-params-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions).toMatchObject([
        { text: "First.", hostParams: { consumer: { id: "first" } } },
      ]);

      const next = progressBrief(runtime, brief, { move: "proceed" });
      expect(next.instructions).toMatchObject([
        {
          text: "Second.",
          hostParams: { consumer: { id: "second", mode: "background" } },
        },
      ]);
    });

    it("does not batch instructions with different modes or deflection hooks", () => {
      const modeDocument = parse(`
"arc";

function Main() {
  $instruct(\`once text\`);
  $instructLoop(\`sticky text\`, {
    resolveWhen: \`sticky done\`,
  });
}
`);
      const modeRuntime = new Runtime().add("batch-mode-arc", modeDocument);
      const modeSeeded = modeRuntime.newTraversal(
        arc("batch-mode-arc", "Main"),
      );
      modeSeeded.phase = "entered";
      const modeBrief = startRun(modeRuntime, [modeSeeded], EMPTY_DIALOG);
      expect(modeBrief.instructions.map((item) => item.text)).toEqual([
        "once text",
      ]);

      const hookDocument = parse(`
"arc";

function Main() {
  $instruct(\`guarded text\`, {
    deflectWhen: \`\${user} bails\`,
  });
  $instruct(\`plain text\`);
}
`);
      const hookRuntime = new Runtime().add("batch-hook-arc", hookDocument);
      const hookSeeded = hookRuntime.newTraversal(
        arc("batch-hook-arc", "Main"),
      );
      hookSeeded.phase = "entered";
      const hookBrief = startRun(hookRuntime, [hookSeeded], EMPTY_DIALOG);
      expect(hookBrief.instructions.map((item) => item.text)).toEqual([
        "guarded text",
      ]);
    });

    it("does not batch instruction frontiers across enter boundaries", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(ProductIntro) && judge(\`\${user} wants pricing\`)) {
      wantsPricing.$set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
    wantsPricing.$set(false);
  }

  $enter(ProductIntro);

  function ProductIntro() {
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

      const runtime = new Runtime().add(
        "enter-instruction-boundary-arc",
        document,
      );
      const seeded = runtime.newTraversal(
        arc("enter-instruction-boundary-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const catching = progressBrief(runtime, brief, { move: "deflect" });
      // The catch's `$set(true)` dials the hook consultation back, releasing
      // the judge pin: the judgment re-poses once before the catch resolves.
      const reconfirming = progressBrief(runtime, catching, {
        move: "proceed",
        judgments: { [catching.judgments[0]!.id]: true },
      });
      expect(reconfirming.judgments).toHaveLength(1);
      const routed = progressBrief(runtime, reconfirming, {
        move: "proceed",
        judgments: { [reconfirming.judgments[0]!.id]: true },
      });

      expect(routed.active).toEqual(
        node("enter-instruction-boundary-arc", "Main.Pricing"),
      );
      expect(routed.instructions.map((item) => item.text)).toEqual(["pricing"]);
      expect(rootTraversal(routed).cells.wantsPricing).toBe(true);

      const resumed = progressBrief(runtime, routed, { move: "proceed" });

      expect(rootTraversal(resumed).cells.wantsPricing).toBe(false);
      expect(resumed.active).toEqual(
        node("enter-instruction-boundary-arc", "Main.ProductIntro"),
      );
    });

    it("batches within each node body but ends the batch when returning to the caller", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $instruct(\`parent one\`);
  $instruct(\`parent two\`);

  function Child() {
    $instruct(\`child one\`);
    $instruct(\`child two\`);
  }
}
`);
      const runtime = new Runtime().add("return-batch-boundary-arc", document);
      const seeded = runtime.newTraversal(
        arc("return-batch-boundary-arc", "Main"),
      );
      seeded.phase = "entered";

      const childBrief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(childBrief.active).toEqual(
        node("return-batch-boundary-arc", "Main.Child"),
      );
      expect(childBrief.instructions.map((item) => item.text)).toEqual([
        "child one",
        "child two",
      ]);

      const parentBrief = progressBrief(runtime, childBrief, {
        move: "proceed",
      });
      expect(parentBrief.active).toEqual(
        node("return-batch-boundary-arc", "Main"),
      );
      expect(parentBrief.instructions.map((item) => item.text)).toEqual([
        "parent one",
        "parent two",
      ]);
    });

    it("ends an instruction batch before beginning effects", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  $instruct(\`body instruction\`);

  this.effects = () => {
    Memoir.facts.$apply(\`effect after body\`);
  };
}
`);
      const runtime = new Runtime().add("effects-batch-boundary-arc", document);
      const seeded = runtime.newTraversal(
        arc("effects-batch-boundary-arc", "Main"),
      );
      seeded.phase = "entered";

      const instructionBrief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(instructionBrief.instructions.map((item) => item.text)).toEqual([
        "body instruction",
      ]);
      expect(instructionBrief.hostEffects).toEqual([]);

      const effectsBrief = progressBrief(runtime, instructionBrief, {
        move: "proceed",
      });
      expect(effectsBrief.instructions).toEqual([]);
      expect(effectsBrief.hostEffects).toMatchObject([
        {
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ]);
    });
  });

  describe("proto.brief-fields", () => {
    it("preserves semantic text parts in host-call briefs and host effects", () => {
      const hostCallDocument = parse(`
"arc";

import Reader from "host:reader";

function Main() {
  let note = Artifact("research-log.md");
  let ready = Bool();
  ready.$set(Reader.check(\`Read \${note} for \${user}\`) == true);
}
`);
      const hostCallRuntime = new Runtime().add(
        "semantic-text-hostcall-arc",
        hostCallDocument,
      );
      const hostCallTraversal = hostCallRuntime.newTraversal(
        arc("semantic-text-hostcall-arc", "Main"),
      );
      hostCallTraversal.phase = "entered";
      const hostCallBrief = startRun(
        hostCallRuntime,
        [hostCallTraversal],
        EMPTY_DIALOG,
      );
      expect(hostCallBrief.hostCalls[0]?.arguments[0]).toEqual([
        { kind: "text", value: "Read " },
        { kind: "artifact", path: "research-log.md" },
        { kind: "text", value: " for " },
        { kind: "entity", name: "user" },
      ]);

      const effectDocument = parse(`
"arc";

import Writer from "host:writer";

function Main() {
  let note = Artifact("research-log.md");
  this.effects = () => {
    Writer.$save(\`Update \${note} for \${self}\`);
  };
}
`);
      const effectRuntime = new Runtime().add(
        "semantic-text-effect-arc",
        effectDocument,
      );
      const effectTraversal = effectRuntime.newTraversal(
        arc("semantic-text-effect-arc", "Main"),
      );
      effectTraversal.phase = "entered";
      const effectBrief = startRun(
        effectRuntime,
        [effectTraversal],
        EMPTY_DIALOG,
      );
      expect(effectBrief.hostEffects[0]?.arguments[0]).toEqual([
        { kind: "text", value: "Update " },
        { kind: "artifact", path: "research-log.md" },
        { kind: "text", value: " for " },
        { kind: "entity", name: "self" },
      ]);
    });

    it("preserves host-variable mentions in instruction text parts", () => {
      const document = parse(`
"arc";

import Audience from "host:audience";

function Main() {
  $instruct(\`Ask \${Audience.supervisor} to approve.\`);
}
`);
      const runtime = new Runtime().add("host-var-brief-arc", document);
      const seeded = runtime.newTraversal(arc("host-var-brief-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions).toHaveLength(1);
      expect(brief.instructions[0]!.text).toEqual([
        { kind: "text", value: "Ask " },
        { kind: "hostVar", module: "audience", path: ["supervisor"] },
        { kind: "text", value: " to approve." },
      ]);
    });

    it("carries boolean observation meta", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool({
    observing: \`is \${user} ready\`,
  });
  $observe(ready);
}
`);
      const runtime = new Runtime().add("bool-meta-arc", document);
      const seeded = runtime.newTraversal(arc("bool-meta-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(singleObservations(brief)[0]!.meta).toEqual({ type: "boolean" });
    });

    it("captures only currently reachable postchecks and postpones deeper checks", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${self} ready\`;
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: () => {
      $observe(ready);
      if (ready == true) {
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

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
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
      // The instruction is still on the brief in postcheck phase, so it keeps
      // suppressing deflect even though the pending work is a judgment.
      expect(afterReady.allowedMoves).toEqual(["poison", "proceed"]);
      expect(
        afterReady.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["self covered the topic enough"]);
    });

    it("includes host-call resolution probes in instruction postcheck ids", () => {
      const document = parse(`
"arc";

import Dice from "host:rng";

function Main() {
  $instructLoop(\`Carry the topic.\`, {
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

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
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

    it("keeps proceed legal when a persistent instruction repeats after unresolved postcheck", () => {
      const document = parse(`
"arc";

function Main() {
  $instructLoop(\`Carry the topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
  $instruct(\`after\`);}
`);
      const runtime = new Runtime().add("persistent-arc", document);
      const seeded = runtime.newTraversal(arc("persistent-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "Carry the topic.",
      ]);
      expect(brief.instructions[0]?.phase).toBe("apply");
      expect(
        brief.judgments.map((item) => renderSemanticTextForTest(item.question)),
      ).toEqual(["self covered the topic enough"]);
      expect(brief.instructions[0]?.postcheck).toEqual({
        judgmentIds: [brief.judgments[0]!.id],
        observationIds: [],
        hostCallIds: [],
      });
      expect(brief.allowedMoves).toEqual(["poison", "proceed"]);

      const afterHandback = progressBrief(runtime, brief, { move: "proceed" });
      expect(afterHandback.instructions).toMatchObject([
        {
          text: "Carry the topic.",
          phase: "postcheck",
        },
      ]);
      expect(
        afterHandback.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["self covered the topic enough"]);

      const afterFalse = progressBrief(runtime, afterHandback, {
        move: "proceed",
        judgments: { [afterHandback.judgments[0]!.id]: false },
      });
      expect(afterFalse.issues).toEqual([]);
      expect(afterFalse.allowedMoves).toEqual(["poison", "proceed"]);
      expect(afterFalse.instructions).toMatchObject([
        {
          text: "Carry the topic.",
          phase: "apply",
        },
      ]);

      const resolutionBrief = progressBrief(runtime, afterFalse, {
        move: "proceed",
      });
      expect(resolutionBrief.issues).toEqual([]);
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
      expect(afterTrue.instructions.map((item) => item.text)).toEqual([
        "after",
      ]);
    });

    it("parses host-module member references in template literals as hostVar parts", () => {
      const document = parse(`
"arc";

import A from "host:audience";

function Main() {
  this.hostParams = { consumer: { id: "writer" } };
  $instruct(\`Ask \${A.supervisor} for approval\`);
}
`);

      const root = document.roots[0]!;
      const instruction = root.statements[0];
      expect(instruction).toMatchObject({
        kind: "instruction",
        template: {
          parts: [
            { kind: "text", value: "Ask " },
            { kind: "hostVar", module: "audience", path: ["supervisor"] },
            { kind: "text", value: " for approval" },
          ],
        },
      });
    });

    it("parses nested host-module member references in template literals as hostVar parts", () => {
      const document = parse(`
"arc";

import A from "host:audience";

function Main() {
  this.hostParams = { consumer: { id: "writer" } };
  $instruct(\`Ask \${A.group.supervisor} for approval\`);
}
`);

      const root = document.roots[0]!;
      const instruction = root.statements[0];
      expect(instruction).toMatchObject({
        kind: "instruction",
        template: {
          parts: [
            { kind: "text", value: "Ask " },
            {
              kind: "hostVar",
              module: "audience",
              path: ["group", "supervisor"],
            },
            { kind: "text", value: " for approval" },
          ],
        },
      });
    });

    it("parses static bracket host-module member references in template literals", () => {
      const document = parse(`
"arc";

import A from "host:audience";

function Main() {
  $instruct(\`Ask \${A["group"].reviewers['lead-reviewer']} for approval\`);
}
`);

      const root = document.roots[0]!;
      const instruction = root.statements[0];
      expect(instruction).toMatchObject({
        kind: "instruction",
        template: {
          parts: [
            { kind: "text", value: "Ask " },
            {
              kind: "hostVar",
              module: "audience",
              path: ["group", "reviewers", "lead-reviewer"],
            },
            { kind: "text", value: " for approval" },
          ],
        },
      });
    });

    it("rejects dynamic computed host-module member access in template literals", () => {
      expect(() =>
        parse(`
"arc";

import A from "host:audience";

function Main() {
  let role = Str();
  $instruct(\`Ask \${A[role]} for approval\`);
}
`),
      ).toThrow(/Computed member access is not supported in Arc/);
    });

    it("rejects bare host-module member references outside template literals", () => {
      expect(() =>
        parse(`
"arc";

import A from "host:audience";

function Main() {
  let flag = Bool();
  flag.$set(A.supervisor);
}
`),
      ).toThrow(/Unsupported value expression/);
    });
  });

  describe("proto.poison", () => {
    it("preserves a runtime cause code and defaults uncategorized errors", () => {
      expect(
        runtimeErrorReasonCode(
          runtimeError("cross-view-comparison", "views differ"),
        ),
      ).toBe("cross-view-comparison");
      expect(runtimeErrorReasonCode(new Error("unexpected"))).toBe(
        "other-runtime-error",
      );
    });

    it("accepts poison move as a terminal host contract failure", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`hello\`);}
`);
      const runtime = new Runtime().add("host-poison-arc", document);
      const seeded = runtime.newTraversal(arc("host-poison-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const poisoned = progressBrief(runtime, brief, {
        move: "poison",
        poisonReason: {
          reasonCode: "missing-required-host-params",
          reason: "Instruction hostParams.consumer is required.",
        },
        judgments: { "not-a-real-id": true },
      });

      expect(rootTraversal(poisoned).phase).toBe("poisoned");
      expect(poisoned.canProgress).toBe(false);
      expect(poisoned.instructions).toEqual([]);
      expect(poisoned.allowedMoves).toEqual([]);
      expect(poisoned.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "missing-required-host-params",
          reason: "Instruction hostParams.consumer is required.",
        }),
      ]);
    });

    it("defaults a host poison without a reason to host-poisoned", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  ready.observing = \`is \${user} ready\`;
  $observeOrAsk(ready);
}
`);
      const runtime = new Runtime().add("poison-default-arc", document);
      const seeded = runtime.newTraversal(arc("poison-default-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      const poisoned = runtime.progress(
        brief,
        { move: "poison" },
        EMPTY_DIALOG,
      );

      expect(rootTraversal(poisoned).phase).toBe("poisoned");
      expect(poisoned.canProgress).toBe(false);
      expect(poisoned.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "host-poisoned",
        }),
      ]);
    });

    it("contains a poisoned trigger candidate while other arcs keep probing", () => {
      const document = parse(`
"arc";

function Bad() {
  let topic = Str();
  let source = Str();

  this.trigger = () => {
    topic.$set(source);
    return false;
  };
}

function Good() {
  this.trigger = () => {
    if (judge(\`\${user} greets\`)) {
      return true;
    }
    return false;
  };
}
`);
      const runtime = new Runtime().add("trigger-poison-arc", document);
      const dialog: Dialog = {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "hello" }],
      };

      // Bad's trigger writes from an unset cell and poisons at probe time;
      // Good's probe carries on in the same round.
      const brief = startTrigger(runtime, dialog);
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          arc: arc("trigger-poison-arc", "Bad"),
          reasonCode: "invalid-cell-assignment",
        }),
      ]);
      expect(
        brief.traversals.find(
          (traversal) => traversal.ref === arc("trigger-poison-arc", "Bad"),
        )?.phase,
      ).toBe("poisoned");
      expect(brief.judgments).toHaveLength(1);
      expect(brief.judgments[0]!.sourceRef).toEqual(
        node("trigger-poison-arc", "Good"),
      );

      const matched = runtime.progressTrigger(
        brief,
        { judgments: { [brief.judgments[0]!.id]: true } },
        dialog,
      );
      expect(matched.matched).toEqual(arc("trigger-poison-arc", "Good"));

      // The poisoned candidate is barred from later trigger rounds.
      const rematch = startTrigger(runtime, dialog, matched.traversals);
      expect(rematch.issues).toEqual([]);
      expect(
        rematch.judgments.every(
          (item) => item.sourceRef !== node("trigger-poison-arc", "Bad"),
        ),
      ).toBe(true);
    });
  });

  describe("proto.idempotence", () => {
    it("resumes idempotently: the same brief and report twice yield the same brief", () => {
      const document = withExperimentalRewalk(
        parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $instruct(\`ready now\`);  }

  $observeOrAsk(ready);

  if (ready == true) {
    $instruct(\`confirmed\`);  }
}
`),
        "Main",
      );
      const runtime = new Runtime().add("idempotent-resume-arc", document);
      const seeded = runtime.newTraversal(arc("idempotent-resume-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      const report: ActionReport = {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: true },
        },
      };

      // Progressing the same stored brief twice with the same report must produce
      // the same next brief: resume reads only persisted traversal state.
      const once = progressBrief(runtime, first, report);
      const twice = progressBrief(runtime, first, report);

      expect(once.instructions.map((item) => item.text)).toEqual([
        "ready now",
        "confirmed",
      ]);
      expect(twice.instructions.map((item) => item.text)).toEqual(
        once.instructions.map((item) => item.text),
      );
      expect(twice.active).toEqual(once.active);
      expect(rootTraversal(twice).cells.ready).toBe(
        rootTraversal(once).cells.ready,
      );
    });
  });

  describe("proto.persistence", () => {
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
      const runtime = new Runtime().add("transition-entry-arc", document);
      const seeded = runtime.newTraversal(arc("transition-entry-arc", "Main"));
      seeded.phase = "entered";
      return { runtime, seeded };
    }

    it("resumes an ordinary blocked frontier from JSON state on a fresh runtime", () => {
      const source = `
"arc";

function Main() {
  $enter(Child);
  $instruct(\`done\`);

  function Child() {
    let ready = Bool();
    ready.observing = \`is \${user} ready\`;
    $observeOrAsk(ready);
    $instruct(\`child after\`);
  }
}
`;
      const first = new Runtime().add("json-resume-arc", parse(source));
      const seeded = first.newTraversal(arc("json-resume-arc", "Main"));
      seeded.phase = "entered";
      const blocked = startRun(first, [seeded], EMPTY_DIALOG);
      expect(blocked.active).toEqual(node("json-resume-arc", "Main.Child"));
      expect(blocked.observations).toHaveLength(1);

      const restored = JSON.parse(JSON.stringify(blocked.traversals));
      const second = new Runtime().add("json-resume-arc", parse(source));
      const resumed = startRun(second, restored, EMPTY_DIALOG);

      expect(resumed.active).toEqual(node("json-resume-arc", "Main.Child"));
      expect(resumed.observations.map((item) => item.id)).toEqual([
        blocked.observations[0]!.id,
      ]);

      const answered = progressBrief(second, resumed, {
        move: "proceed",
        observations: {
          [resumed.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      expect(answered.instructions.map((item) => item.text)).toEqual([
        "child after",
      ]);
      const finished = progressBrief(second, answered, { move: "proceed" });
      expect(finished.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("round-trips a stored array cell value through JSON on a fresh runtime", () => {
      const source = `
"arc";

function Main() {
  let items = Array(Str());
  let echoed = Str();
  items.$set(["alpha", "beta"]);
  $enter(Child);
  function Child() {
    let ready = Bool();
    ready.observing = \`is \${user} ready\`;
    $observeOrAsk(ready);
  }
}
`;
      const first = new Runtime().add("array-persist-arc", parse(source));
      const seeded = first.newTraversal(arc("array-persist-arc", "Main"));
      seeded.phase = "entered";
      const blocked = startRun(first, [seeded], EMPTY_DIALOG);

      const restored = JSON.parse(JSON.stringify(blocked.traversals));
      expect(
        rootTraversal({ ...blocked, traversals: restored }).cells.items,
      ).toEqual(["alpha", "beta"]);

      const second = new Runtime().add("array-persist-arc", parse(source));
      const resumed = startRun(second, restored, EMPTY_DIALOG);
      expect(rootTraversal(resumed).cells.items).toEqual(["alpha", "beta"]);
    });

    it.each([
      ["covered", "completed"],
      ["deflected", "suspended"],
    ] as const)(
      "a fresh runtime resumes effects with pending %s state after a JSON roundtrip",
      (pendingState, finalPhase) => {
        const source = `
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
`;
        const first = new Runtime().add(
          "effects-json-resume-arc",
          parse(source),
        );
        const seeded = first.newTraversal(
          arc("effects-json-resume-arc", "Main"),
        );
        seeded.phase = "entered";
        const work = startRun(first, [seeded], EMPTY_DIALOG);
        const effects =
          pendingState === "deflected"
            ? progressBrief(first, work, { move: "deflect" })
            : progressBrief(first, work, {
                move: "proceed",
                observations: {
                  [work.observations[0]!.id]: {
                    status: "resolved",
                    value: true,
                  },
                },
              });

        expect(rootTraversal(effects)).toMatchObject({
          phase: "entered",
          state: undefined,
          finalizing: { reason: pendingState, phase: "effects" },
        });
        expect(effects.hostEffects).toHaveLength(1);

        const restored = JSON.parse(JSON.stringify(effects.traversals));
        const second = new Runtime().add(
          "effects-json-resume-arc",
          parse(source),
        );
        const resumed = startRun(second, restored, EMPTY_DIALOG);

        expect(resumed.hostEffects).toEqual(effects.hostEffects);
        expect(rootTraversal(resumed)).toMatchObject({
          phase: "entered",
          state: undefined,
          finalizing: { reason: pendingState, phase: "effects" },
        });

        const finished = progressBrief(second, resumed, {
          move: "proceed",
          hostEffects: appliedHostEffects(resumed),
        });

        expect(rootTraversal(finished)).toMatchObject({
          phase: finalPhase,
          state: pendingState,
          finalizing: undefined,
        });
      },
    );

    it("a fresh runtime resumes deflected effects with the same pending deflection", () => {
      const source = `
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
    let ready = Bool();
    ready.observing = \`is \${user} ready\`;
    $observeOrAsk(ready);
  }
}
`;
      const first = new Runtime().add(
        "pending-deflection-json-resume-arc",
        parse(source),
      );
      const seeded = first.newTraversal(
        arc("pending-deflection-json-resume-arc", "Main"),
      );
      seeded.phase = "entered";
      const work = startRun(first, [seeded], EMPTY_DIALOG);
      const effects = progressBrief(first, work, { move: "deflect" });

      expect(rootTraversal(effects).finalizing).toEqual({
        reason: "deflected",
        phase: "effects",
        deflection: {
          origin: node("pending-deflection-json-resume-arc", "Main.Intro"),
          from: node("pending-deflection-json-resume-arc", "Main.Intro"),
        },
      });
      expect(
        renderSemanticTextForTest(effects.hostEffects[0]!.arguments[0]!),
      ).toBe("intro deflected");

      const restored = JSON.parse(JSON.stringify(effects.traversals));
      const second = new Runtime().add(
        "pending-deflection-json-resume-arc",
        parse(source),
      );
      const resumed = startRun(second, restored, EMPTY_DIALOG);

      expect(resumed.hostEffects).toEqual(effects.hostEffects);
      expect(rootTraversal(resumed).finalizing).toEqual(
        rootTraversal(effects).finalizing,
      );

      const finished = progressBrief(second, resumed, {
        move: "proceed",
        hostEffects: appliedHostEffects(resumed),
      });
      expect(rootTraversal(finished)).toMatchObject({
        phase: "suspended",
        state: "deflected",
        finalizing: undefined,
      });
    });

    it("a fresh runtime resumes an instruction blocked in its resolveWhen hook", () => {
      const document = parse(`
"arc";

function Main() {
  $instructLoop(\`A\`, {
    resolveWhen: \`is A done\`,
  });
  $instruct(\`B\`);
}
`);
      const first = new Runtime().add("n17-arc", document);
      const seeded = first.newTraversal(arc("n17-arc", "Main"));
      seeded.phase = "entered";
      const firstBrief = startRun(first, [seeded], EMPTY_DIALOG);
      expect(firstBrief.instructions.map((item) => item.text)).toEqual(["A"]);
      expect(firstBrief.judgments).toHaveLength(1);

      // A brand-new runtime reconstructs the pending instruction and its attached
      // resolveWhen postcheck purely from the persisted traversal set.
      const resumed = new Runtime().add("n17-arc", document);
      const resumedBrief = startRun(
        resumed,
        firstBrief.traversals,
        EMPTY_DIALOG,
      );
      expect(resumedBrief.instructions.map((item) => item.text)).toEqual(["A"]);
      expect(resumedBrief.judgments).toHaveLength(1);
      expect(resumedBrief.instructions[0]!.postcheck?.judgmentIds).toEqual([
        resumedBrief.judgments[0]!.id,
      ]);
    });

    it("re-yields the same transition after a JSON round-trip on a fresh runtime", () => {
      const { runtime, seeded } = guardedChildRuntime();
      const brief = runtime.start([seeded], EMPTY_DIALOG);
      expect(brief.transition).toBeDefined();

      const revived = JSON.parse(
        JSON.stringify(brief.traversals),
      ) as ArcTraversalSet;
      const freshRuntime = new Runtime().add(
        "transition-entry-arc",
        parse(`
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
`),
      );
      const reyielded = freshRuntime.start(revived, EMPTY_DIALOG);
      expect(reyielded.transition).toEqual(brief.transition);

      const work = freshRuntime.progress(
        reyielded,
        { move: "proceed" },
        GO_DIALOG,
      );
      expect(work.instructions.map((item) => item.text)).toEqual([
        "child work",
      ]);
    });
  });
});
