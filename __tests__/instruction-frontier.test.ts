import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import type {
  ActionBrief,
  ArcTraversalSet,
  Dialog,
} from "../src/types/index.js";
import {
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  progressBrief,
  progressTerminal,
  TestRuntime as Runtime,
  startRun,
} from "./helpers.js";

const contexts = [
  "node",
  "nested branch",
  "labeled block",
  "invoke",
  "map member",
  "owned child",
  "imported arc",
] as const;
type Context = (typeof contexts)[number];

function createRuntime(body: string, context: Context = "node"): Runtime {
  let mainBody = body;
  switch (context) {
    case "nested branch":
      mainBody = `if (true) { if (true) { ${body} } }`;
      break;
    case "labeled block":
      mainBody = `work: { ${body} break work; }`;
      break;
    case "invoke":
      mainBody = `invoke(() => { ${body} });`;
      break;
    case "map member":
      mainBody = `let items = Array(Str()); items.$set(["one"]); items.$map(() => { ${body} });`;
      break;
    case "owned child":
      mainBody = `$enter(Work); function Work() { ${body} }`;
      break;
    case "imported arc":
      mainBody = "$enter(Work);";
      break;
  }
  const runtime = new Runtime().add(
    "instruction-frontier",
    parse(`
"arc";
import Gate from "host:gate";
${context === "imported arc" ? 'import { Work } from "frontier-work";' : ""}
function Main() { ${mainBody} }
`),
  );
  if (context === "imported arc") {
    runtime.add("frontier-work", parse(`"arc"; function Work() { ${body} }`));
  }
  return runtime.init();
}

function start(runtime: Runtime, dialog: Dialog = EMPTY_DIALOG): ActionBrief {
  const traversal = runtime.newTraversal(arc("instruction-frontier", "Main"));
  traversal.phase = "entered";
  return startRun(runtime, [traversal], dialog);
}

function restore(runtime: Runtime, brief: ActionBrief): ActionBrief {
  return startRun(
    runtime,
    JSON.parse(JSON.stringify(brief.traversals)) as ArcTraversalSet,
    EMPTY_DIALOG,
  );
}

function expectOnlyInstruction(brief: ActionBrief): void {
  expect(brief.instructions).toMatchObject([{ text: "write", phase: "apply" }]);
  expect(brief.instructions).toHaveLength(1);
  expect(brief.judgments).toEqual([]);
  expect(brief.observations).toEqual([]);
  expect(brief.hostCalls).toEqual([]);
  expect(brief.issues).toEqual([]);
}

describe("instruction frontier", () => {
  it.each(contexts)(
    "act.instruct suspends later judgments in %s until application",
    (context) => {
      const body = `
  $instruct("write");
  if (judge("later")) { $instruct("accepted"); }
`;
      const runtime = createRuntime(body, context);
      const first = start(runtime);
      expectOnlyInstruction(first);

      const retry = progressBrief(runtime, first, { move: "proceed" });
      expectOnlyInstruction(retry);
      expect(retry.instructions).toEqual(first.instructions);

      const fresh = createRuntime(body, context);
      const restored = restore(fresh, retry);
      expectOnlyInstruction(restored);
      expect(restored.instructions).toEqual(first.instructions);

      const judging = progressBrief(fresh, restored, {
        move: "proceed",
        instructions: appliedInstructions(restored),
      });
      expect(judging.instructions).toEqual([]);
      expect(judging.judgments.map((item) => item.question)).toEqual(["later"]);
      expect(judging.issues).toEqual([]);

      const completed = progressTerminal(fresh, judging, {
        move: "proceed",
        judgments: { [judging.judgments[0]!.id]: false },
      });
      expect(completed.outcome).toBe("covered");
    },
  );

  it("act.instruct delays a later condition host call until application", () => {
    const runtime = createRuntime(`
  $instruct("write");
  if (Gate.ready()) { $instruct("accepted"); }
`);
    const first = start(runtime);
    expectOnlyInstruction(first);

    const calling = progressBrief(runtime, first, {
      move: "proceed",
      instructions: appliedInstructions(first),
    });
    expect(calling.instructions).toEqual([]);
    expect(calling.hostCalls).toHaveLength(1);
    expect(calling.hostCalls[0]!.operation).toBe("ready");
    const completed = progressTerminal(runtime, calling, {
      move: "proceed",
      hostCalls: {
        [calling.hostCalls[0]!.id]: { status: "resolved", value: false },
      },
    });
    expect(completed.outcome).toBe("covered");
  });

  it("act.instruct binds a later dialog condition after application", () => {
    const runtime = createRuntime(`
  $instruct("write");
  if (/after/.test(Dialog.lastUserMessage)) {
    $instruct("new dialog");
  } else {
    $instruct("old dialog");
  }
`);
    const before: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "before" }],
    };
    const after: Dialog = {
      cursor: { user: 2, self: 0 },
      lastTurns: [{ role: "user", message: "after" }],
    };
    const first = start(runtime, before);
    expectOnlyInstruction(first);
    const retry = progressBrief(runtime, first, { move: "proceed" }, before);
    expectOnlyInstruction(retry);
    const next = progressBrief(
      runtime,
      retry,
      { move: "proceed", instructions: appliedInstructions(retry) },
      after,
    );
    expect(next.instructions.map((item) => item.text)).toEqual(["new dialog"]);
    expect(
      progressTerminal(
        runtime,
        next,
        { move: "proceed", instructions: appliedInstructions(next) },
        after,
      ).outcome,
    ).toBe("covered");
  });

  it("act.instruct reaches a later expression failure only after application", () => {
    const runtime = createRuntime(`
  let n = Num();
  $instruct("write");
  if (n + 1 > 0) { $instruct("unreachable"); }
`);
    const first = start(runtime);
    expectOnlyInstruction(first);
    const retry = progressBrief(runtime, first, { move: "proceed" });
    expectOnlyInstruction(retry);
    const failed = progressTerminal(runtime, retry, {
      move: "proceed",
      instructions: appliedInstructions(retry),
    });
    expect(failed.outcome).toBe("poisoned");
    expect(failed.issues).toMatchObject([
      { kind: "poisoned-traversal", reasonCode: "unset-value" },
    ]);
  });

  it.each([
    {
      mode: "once",
      instruction:
        '$instruct("write", { deflectWhen: () => judge("own check") });',
      answer: false,
    },
    {
      mode: "loop",
      instruction:
        '$instructLoop("write", { resolveWhen: () => judge("own check") });',
      answer: true,
    },
  ])(
    "act.instruct exposes only its own checks while $mode is unresolved",
    ({ instruction, answer }) => {
      const body = `${instruction} if (judge("later")) { $instruct("accepted"); }`;
      const runtime = createRuntime(body);
      const first = start(runtime);
      expect(first.instructions[0]!.phase).toBe("apply");
      expect(first.judgments.map((item) => item.question)).toEqual([
        "own check",
      ]);
      expect(first.instructions[0]!.postcheck!.judgmentIds).toEqual([
        first.judgments[0]!.id,
      ]);

      const postcheck = progressBrief(runtime, first, {
        move: "proceed",
        instructions: appliedInstructions(first),
      });
      expect(postcheck.instructions[0]!.phase).toBe("postcheck");
      expect(postcheck.judgments.map((item) => item.question)).toEqual([
        "own check",
      ]);

      const fresh = createRuntime(body);
      const restored = restore(fresh, postcheck);
      expect(restored.instructions).toEqual(postcheck.instructions);
      expect(restored.judgments).toEqual(postcheck.judgments);
      const judging = progressBrief(fresh, restored, {
        move: "proceed",
        judgments: { [restored.judgments[0]!.id]: answer },
      });
      expect(judging.instructions).toEqual([]);
      expect(judging.judgments.map((item) => item.question)).toEqual(["later"]);
      expect(
        progressTerminal(fresh, judging, {
          move: "proceed",
          judgments: { [judging.judgments[0]!.id]: false },
        }).outcome,
      ).toBe("covered");
    },
  );

  it("act.instruct keeps later conditions suspended when its check settles before application", () => {
    const runtime = createRuntime(`
  $instruct("write", { deflectWhen: () => judge("own check") });
  if (judge("later")) { $instruct("accepted"); }
`);
    const first = start(runtime);
    expect(first.judgments.map((item) => item.question)).toEqual(["own check"]);
    const waiting = progressBrief(runtime, first, {
      move: "proceed",
      judgments: { [first.judgments[0]!.id]: false },
    });
    expectOnlyInstruction(waiting);
    const judging = progressBrief(runtime, waiting, {
      move: "proceed",
      instructions: appliedInstructions(waiting),
    });
    expect(judging.instructions).toEqual([]);
    expect(judging.judgments.map((item) => item.question)).toEqual(["later"]);
    expect(
      progressTerminal(runtime, judging, {
        move: "proceed",
        judgments: { [judging.judgments[0]!.id]: false },
      }).outcome,
    ).toBe("covered");
  });

  it("act.instruct-loop keeps later conditions suspended across a false lap", () => {
    const body = `
  $instructLoop("write", { resolveWhen: () => judge("own check") });
  if (judge("later")) { $instruct("accepted"); }
`;
    const runtime = createRuntime(body);
    const first = start(runtime);
    expect(first.judgments.map((item) => item.question)).toEqual(["own check"]);
    const again = progressBrief(runtime, first, {
      move: "proceed",
      instructions: appliedInstructions(first),
      judgments: { [first.judgments[0]!.id]: false },
    });
    expect(again.instructions[0]!.phase).toBe("apply");
    expect(again.judgments.map((item) => item.question)).toEqual(["own check"]);
    const fresh = createRuntime(body);
    const restored = restore(fresh, again);
    expect(restored.instructions).toEqual(again.instructions);
    expect(restored.judgments).toEqual(again.judgments);

    // Loop resolution is independent of application: a true check can finish
    // this lap without another application report.
    const judging = progressBrief(fresh, restored, {
      move: "proceed",
      judgments: { [restored.judgments[0]!.id]: true },
    });
    expect(judging.instructions).toEqual([]);
    expect(judging.judgments.map((item) => item.question)).toEqual(["later"]);
    expect(
      progressTerminal(fresh, judging, {
        move: "proceed",
        judgments: { [judging.judgments[0]!.id]: false },
      }).outcome,
    ).toBe("covered");
  });
});
