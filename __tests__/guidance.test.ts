import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import type {
  ActionBrief,
  ArcTraversalSet,
  Dialog,
  SemanticText,
} from "../src/types/index.js";
import {
  actionProgress,
  actionTerminal,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  node,
  progressBrief,
  progressTerminal,
  rootTraversal,
  TestRuntime as Runtime,
  startRun,
  startTrigger,
} from "./helpers.js";

const SOURCE = "standing-guidance";

function runtimeFor(source: string): Runtime {
  return new Runtime().add(SOURCE, parse(source)).init();
}

function enter(runtime: Runtime, dialog = EMPTY_DIALOG): ActionBrief {
  return actionProgress(runtime.enterArc(arc(SOURCE, "Main"), dialog));
}

function dialog(message: string, turn = 1): Dialog {
  return {
    cursor: { user: turn, self: 0 },
    lastTurns: [{ role: "user", message }],
  };
}

function pendingCall(traversals: ArcTraversalSet) {
  for (const state of Object.values(traversals[0]!.frame.actionStates)) {
    if (state?.kind === "host-call" && state.status === "pending") {
      return state.call;
    }
  }
  throw new Error("Expected a captured pending host call");
}

const WORK = [
  { name: "judgment", body: 'if (judge("ready?")) {}', channel: "judgments" },
  { name: "observation", body: "$observe(ready);", channel: "observations" },
  {
    name: "observation group",
    body: "$observe({ ready, other });",
    channel: "observations",
  },
  {
    name: "instruction",
    body: '$instruct("Proceed.");',
    channel: "instructions",
  },
  {
    name: "expression host call",
    body: "ready.$set(Api.number(7) > 3);",
    channel: "hostCalls",
  },
  {
    name: "action host call",
    body: 'Api.$record("Proceed.");',
    channel: "hostCalls",
  },
] as const;

function workSource(body: string, guidance?: string): string {
  return `
"arc";
import Api from "host:api";
import Audience from "host:audience";
function Main() {
  ${guidance === undefined ? "" : `this.guidance = ${guidance};`}
  let tone = Str();
  let ready = Bool({ observing: "ready?" });
  let other = Bool({ observing: "other?" });
  let document = Artifact("notes.md");
  tone.$set("calm");
  ${body}
}
`;
}

describe("standing guidance", () => {
  it.each(WORK)(
    "cfg.guidance renders source-node context on $name work",
    ({ body, channel }) => {
      const runtime = runtimeFor(
        workSource(
          body,
          "`Be ${tone} for ${user} using ${document} and ${Audience.group.reviewer}.`",
        ),
      );
      const brief = enter(runtime);
      expect(brief[channel]).toHaveLength(1);
      expect(brief[channel][0]).toMatchObject({
        sourceRef: node(SOURCE, "Main"),
        guidance: [
          { kind: "text", value: "Be calm for " },
          { kind: "entity", name: "user" },
          { kind: "text", value: " using " },
          { kind: "artifact", path: "notes.md" },
          { kind: "text", value: " and " },
          { kind: "hostVar", module: "audience", path: ["group", "reviewer"] },
          { kind: "text", value: "." },
        ],
      });
      const observation = brief.observations[0];
      if (observation?.kind === "observation-group") {
        expect(observation.fields).toHaveLength(2);
        expect(
          observation.fields.every((field) => !("guidance" in field)),
        ).toBe(true);
      }
    },
  );

  it.each(WORK)(
    "cfg.guidance distinguishes absent and empty guidance on $name work",
    ({ body, channel }) => {
      expect(
        enter(runtimeFor(workSource(body)))[channel][0]?.guidance,
      ).toBeUndefined();
      expect(
        enter(runtimeFor(workSource(body, '""')))[channel][0]?.guidance,
      ).toBe("");
    },
  );

  it("cfg.guidance renders lazily and reports unset interpolations at work emission", () => {
    const source = (body: string) => `
"arc";
function Main() {
  this.guidance = \`Use \${tone}.\`;
  let tone = Str();
  ${body}
}
`;
    const unused = runtimeFor(source(""));
    expect(
      actionTerminal(unused.enterArc(arc(SOURCE, "Main"), EMPTY_DIALOG))
        .outcome,
    ).toBe("covered");

    const emitting = runtimeFor(source('$instruct("Proceed.");'));
    const failed = actionTerminal(
      emitting.enterArc(arc(SOURCE, "Main"), EMPTY_DIALOG),
    );
    expect(failed.outcome).toBe("poisoned");
    expect(failed.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "invalid-template-interpolation" }),
    );
  });

  it("cfg.guidance renders new work from updated cells while retaining pending instruction inputs", () => {
    const runtime = runtimeFor(`
"arc";
function Main() {
  this.guidance = \`Use a \${tone} tone for \${Dialog.lastUserMessage}.\`;
  let tone = Str();
  tone.$set("calm");
  $instruct("First.");
  tone.$set("firm");
  $instruct("Second.");
}
`);
    const first = enter(runtime, dialog("first"));
    expect(first.instructions[0]?.guidance).toBe("Use a calm tone for first.");
    const retry = progressBrief(
      runtime,
      first,
      { move: "proceed" },
      dialog("retry", 2),
    );
    expect(retry.instructions).toEqual(first.instructions);
    const second = progressBrief(
      runtime,
      retry,
      { move: "proceed", instructions: appliedInstructions(retry) },
      dialog("second", 3),
    );
    expect(second.instructions[0]).toMatchObject({
      text: "Second.",
      guidance: "Use a firm tone for second.",
    });
  });

  it("cfg.guidance preserves expression pin order across judgment and host-call suspension", () => {
    const source = `
"arc";
import Api from "host:api";
function Main() {
  this.guidance = \`Consider \${Dialog.lastUserMessage}.\`;
  if (judge("Ready?") && Api.number(7) > 3) {
    $instruct("Accepted.");
  }
}
`;
    const runtime = runtimeFor(source);
    const first = enter(runtime, dialog("first"));
    expect(first.judgments[0]?.guidance).toBe("Consider first.");
    const calling = progressBrief(
      runtime,
      first,
      { move: "proceed", judgments: { [first.judgments[0]!.id]: true } },
      dialog("second", 2),
    );
    expect(calling.judgments).toEqual([]);
    expect(calling.hostCalls[0]).toMatchObject({
      arguments: [7],
      guidance: "Consider second.",
    });
    const restarted = runtimeFor(source);
    const resumed = startRun(
      restarted,
      JSON.parse(JSON.stringify(calling.traversals)) as ArcTraversalSet,
      dialog("third", 3),
    );
    expect(resumed.hostCalls).toEqual(calling.hostCalls);
    const accepted = progressBrief(
      restarted,
      resumed,
      {
        move: "proceed",
        hostCalls: {
          [resumed.hostCalls[0]!.id]: { status: "resolved", value: 7 },
        },
      },
      dialog("fourth", 4),
    );
    expect(accepted.hostCalls).toEqual([]);
    expect(accepted.judgments).toEqual([]);
    expect(accepted.instructions[0]).toMatchObject({
      text: "Accepted.",
      guidance: "Consider fourth.",
    });
  });

  it("cfg.guidance uses each emitting node's own declaration across child entry", () => {
    const runtime = runtimeFor(`
"arc";
function Main() {
  this.guidance = "Parent guidance.";
  $enter(Child);
  $enter(Unguided);
  $instruct("Parent.");
  function Child() {
    this.guidance = "Child guidance.";
    $instruct("Child.");
  }
  function Unguided() {
    $instruct("Unguided.");
  }
}
`);
    const initial = actionProgress(
      runtime.enterArc(arc(SOURCE, "Main"), EMPTY_DIALOG),
    );
    const child = startRun(runtime, initial.traversals, EMPTY_DIALOG);
    expect(child.instructions[0]).toMatchObject({
      sourceRef: node(SOURCE, "Main.Child"),
      guidance: "Child guidance.",
    });
    const unguided = progressBrief(runtime, child, {
      move: "proceed",
      instructions: appliedInstructions(child),
    });
    expect(unguided.instructions[0]?.sourceRef).toBe(
      node(SOURCE, "Main.Unguided"),
    );
    expect(unguided.instructions[0]?.guidance).toBeUndefined();
    const parent = progressBrief(runtime, unguided, {
      move: "proceed",
      instructions: appliedInstructions(unguided),
    });
    expect(parent.instructions[0]).toMatchObject({
      sourceRef: node(SOURCE, "Main"),
      guidance: "Parent guidance.",
    });
  });

  it.each([
    { name: "judgment", body: 'return judge("Ready?");', channel: "judgments" },
    {
      name: "observation",
      body: "$observe(ready); return ready;",
      channel: "observations",
    },
    {
      name: "observation group",
      body: "$observe({ ready, other }); return ready && other;",
      channel: "observations",
    },
    {
      name: "host call",
      body: "return Api.number(7) > 3;",
      channel: "hostCalls",
    },
  ] as const)(
    "cfg.guidance skips rendering on trigger $name work and retries",
    ({ body, channel }) => {
      const runtime = runtimeFor(`
"arc";
import Api from "host:api";
function Main() {
  this.guidance = \`Use \${tone} with \${policy}.\`;
  this.trigger = () => { ${body} };
  let tone = Str();
  let policy = Artifact("policy.md");
  let ready = Bool();
  let other = Bool();
  tone.$set("calm");
  $instruct("Work.");
}
`);
      const first = startTrigger(runtime, EMPTY_DIALOG);
      expect(first.issues).toEqual([]);
      expect(first[channel]).toHaveLength(1);
      expect(first[channel][0]?.guidance).toBeUndefined();
      const retry = runtime.progressTrigger(first, {}, dialog("retry"));
      expect(retry.issues).toEqual([]);
      expect(retry[channel]).toEqual(first[channel]);
      expect(enter(runtime).instructions[0]?.guidance).toEqual([
        { kind: "text", value: "Use calm with " },
        { kind: "artifact", path: "policy.md" },
        { kind: "text", value: "." },
      ]);
    },
  );

  it("cfg.guidance accompanies guard instruction-postcheck and effects work after triggering", () => {
    const runtime = runtimeFor(`
"arc";
import Api from "host:api";
function Main() {
  this.guidance = "Root precision.";
  this.trigger = () => judge("Activate?");
  $enter(Work);
  function Work() {
    this.guidance = "Stay precise.";
    this.guard = () => {
      if (!judge("Enter?")) return State.SKIPPED;
    };
    this.effects = () => { Api.$record("Finished."); };
    $instructLoop("Work.", { resolveWhen: () => judge("Done?") });
  }
}
`);
    const trigger = startTrigger(runtime, EMPTY_DIALOG);
    expect(trigger.judgments[0]?.guidance).toBeUndefined();
    const matched = runtime.progressTrigger(
      trigger,
      { judgments: { [trigger.judgments[0]!.id]: true } },
      EMPTY_DIALOG,
    );
    expect(matched.matched).toBe(arc(SOURCE, "Main"));
    const guard = startRun(runtime, matched.traversals, EMPTY_DIALOG);
    expect(guard.judgments[0]?.guidance).toBe("Stay precise.");
    const work = progressBrief(runtime, guard, {
      move: "proceed",
      judgments: { [guard.judgments[0]!.id]: true },
    });
    expect(work.instructions[0]?.guidance).toBe("Stay precise.");
    expect(work.judgments[0]?.guidance).toBe("Stay precise.");
    const postcheck = progressBrief(runtime, work, {
      move: "proceed",
      instructions: appliedInstructions(work),
    });
    expect(postcheck.instructions[0]).toMatchObject({
      phase: "postcheck",
      guidance: "Stay precise.",
    });
    expect(postcheck.judgments[0]?.guidance).toBe("Stay precise.");
    const effects = progressBrief(runtime, postcheck, {
      move: "proceed",
      judgments: { [postcheck.judgments[0]!.id]: true },
    });
    expect(effects.hostCalls[0]?.guidance).toBe("Stay precise.");
    expect(
      progressTerminal(runtime, effects, {
        move: "proceed",
        hostCalls: { [effects.hostCalls[0]!.id]: { status: "resolved" } },
      }).outcome,
    ).toBe("covered");
  });

  it.each(["action", "effects"] as const)(
    "cfg.guidance captures %s host-call guidance through retries and JSON restoration",
    (site) => {
      const call = "Api.$record(`Remember ${Dialog.lastUserMessage}.`);";
      const source = `
"arc";
import Api from "host:api";
function Main() {
  this.guidance = \`Consider \${Dialog.lastUserMessage}.\`;
  ${site === "effects" ? `this.effects = () => { ${call} };` : call}
}
`;
      const runtime = runtimeFor(source);
      const first = enter(runtime, dialog("original"));
      expect(first.hostCalls[0]).toMatchObject({
        arguments: ["Remember original."],
        guidance: "Consider original.",
      });
      const retry = progressBrief(
        runtime,
        first,
        { move: "proceed" },
        dialog("retry", 2),
      );
      expect(retry.hostCalls).toEqual(first.hostCalls);
      const restored = JSON.parse(
        JSON.stringify(retry.traversals),
      ) as ArcTraversalSet;
      const restarted = runtimeFor(source);
      const resumed = startRun(restarted, restored, dialog("restart", 3));
      expect(resumed.hostCalls).toEqual(first.hostCalls);
      expect(
        progressTerminal(restarted, resumed, {
          move: "proceed",
          hostCalls: { [resumed.hostCalls[0]!.id]: { status: "resolved" } },
        }).outcome,
      ).toBe("covered");
    },
  );

  it.each(WORK)(
    "cfg.guidance isolates semantic references in $name brief snapshots",
    ({ body, channel }) => {
      const runtime = runtimeFor(
        workSource(body, "`${Audience.group.reviewer}`"),
      );
      const first = enter(runtime);
      const guidance = first[channel][0]!.guidance;
      if (!Array.isArray(guidance) || guidance[0]?.kind !== "hostVar") {
        throw new Error("Expected a host-variable semantic reference");
      }
      guidance[0].path[0] = "mutated";
      const retry = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { unknown: true },
      });
      expect(retry.issues).toContainEqual(
        expect.objectContaining({ kind: "invalid-report" }),
      );
      expect(retry[channel][0]?.guidance).toEqual([
        { kind: "hostVar", module: "audience", path: ["group", "reviewer"] },
      ]);
      if (body.startsWith("Api.$")) {
        expect(pendingCall(retry.traversals).guidance).toEqual(
          retry[channel][0]?.guidance,
        );
      }
    },
  );

  it.each([
    ["non-text scalar", 12],
    ["null", null],
    ["invalid entity", [{ kind: "entity", name: "other" }]],
    ["invalid artifact path", [{ kind: "artifact", path: "../outside.md" }]],
    [
      "empty host variable path",
      [{ kind: "hostVar", module: "audience", path: [] }],
    ],
    ["extra part property", [{ kind: "text", value: "text", extra: true }]],
  ])("cfg.guidance rejects restored %s guidance", (_label, corrupted) => {
    const source = workSource('Api.$record("Proceed.");', '"Stay precise."');
    const first = enter(runtimeFor(source));
    const restored = JSON.parse(
      JSON.stringify(first.traversals),
    ) as ArcTraversalSet;
    pendingCall(restored).guidance = corrupted as SemanticText;
    expect(() => startRun(runtimeFor(source), restored, EMPTY_DIALOG)).toThrow(
      /Invalid persisted traversal state.*guidance/i,
    );
    expect(rootTraversal(first).phase).toBe("entered");
  });
});
