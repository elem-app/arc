import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import type {
  ActionBrief,
  ArcTraversalSet,
  TerminalBrief,
} from "../src/types/index.js";
import {
  actionProgress,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  groupObservation,
  ownedChild,
  progressBrief,
  progressTerminal,
  rootTraversal,
  TestRuntime as Runtime,
  settleTransitions,
  startRun,
  startTrigger,
  traversalByRef,
} from "./helpers.js";

const CONTEXTS = [
  "action",
  "trigger",
  "guard",
  "effects",
  "instruction resolveWhen",
  "instruction deflectWhen",
  "enterLoop resolveWhen",
  "catchDeflection",
  "catchInterruption",
  "invoke",
  "map",
  "owned child",
  "imported arc",
] as const;
type Context = (typeof CONTEXTS)[number];
type Mode = "observe" | "observeOrAsk";
const HOOKS_WITHOUT_ASK = new Set<Context>([
  "trigger",
  "guard",
  "effects",
  "instruction resolveWhen",
  "instruction deflectWhen",
  "enterLoop resolveWhen",
]);
const DECLARATIONS = "let name = Str(); let age = Num(); let receipt = Str();";
const SOURCE = "group-context";
const IMPORT = "group-library";

function contextSource(context: Context, mode: Mode) {
  const group = `$${mode}({ name, age }); receipt.$set(\`\${name}:\${age}\`);`;
  let body: string;
  switch (context) {
    case "trigger":
      body = `this.trigger = () => { ${group} return name == "Ada" && age == 37; };`;
      break;
    case "guard":
      body = `this.guard = () => { ${group} };`;
      break;
    case "effects":
      body = `this.effects = () => { ${group} };`;
      break;
    case "instruction resolveWhen":
      body = `$instructLoop("apply", { resolveWhen: () => { ${group} return name == "Ada" && age == 37; } });`;
      break;
    case "instruction deflectWhen":
      body = `$instruct("apply", { deflectWhen: () => { ${group} return name != "Ada" || age != 37; } });`;
      break;
    case "enterLoop resolveWhen":
      body = `$enterLoop(Child, { resolveWhen: () => { ${group} return name == "Ada" && age == 37; } }); function Child() {}`;
      break;
    case "catchDeflection":
      body = `let waiting = Bool(); this.catchDeflection = () => { ${group} return false; }; $observeOrAsk(waiting);`;
      break;
    case "catchInterruption":
      body = `this.${context} = () => { ${group} return true; }; $instruct("finish");`;
      break;
    case "invoke":
      body = `invoke(() => { ${group} });`;
      break;
    case "map":
      body = `let items = Array(Str()); items.$set(["member"]); items.$map(() => { ${group} });`;
      break;
    default:
      body = group;
  }
  const subject = `${DECLARATIONS} ${body}`;
  if (context === "owned child" || context === "guard")
    return {
      main: `"arc"; function Main() { $enter(Child); function Child() { ${subject} } }`,
    };
  if (context === "imported arc")
    return {
      main: `"arc"; import { Work } from "${IMPORT}"; function Main() { $enter(Work); }`,
      library: `"arc"; function Work() { ${subject} }`,
    };
  return { main: `"arc"; function Main() { ${subject} }` };
}

function runtimeFor(source: ReturnType<typeof contextSource>) {
  const runtime = new Runtime().add(SOURCE, parse(source.main));
  if (source.library) runtime.add(IMPORT, parse(source.library));
  return runtime.init();
}

function enter(runtime: Runtime) {
  return settleTransitions(
    runtime,
    runtime.enterArc(arc(SOURCE, "Main"), EMPTY_DIALOG),
    EMPTY_DIALOG,
  );
}

describe("grouped observation contexts", () => {
  it.each(
    CONTEXTS.flatMap((context) =>
      (["observe", "observeOrAsk"] as const)
        .filter((mode) => mode === "observe" || !HOOKS_WITHOUT_ASK.has(context))
        .map((mode) => ({ context, mode })),
    ),
  )(
    "act.observe-group resolves $mode in $context through its consuming continuation",
    ({ context, mode }) => {
      const runtime = runtimeFor(contextSource(context, mode));
      let result: ActionBrief | TerminalBrief;
      if (context === "trigger") {
        const pending = startTrigger(runtime, EMPTY_DIALOG);
        expect(pending.matched).toBeUndefined();
        expect(pending.observations).toHaveLength(1);
        const group = groupObservation(pending.observations[0]);
        const matched = runtime.progressTrigger(
          pending,
          {
            observations: {
              [group.id]: {
                fields: {
                  name: { status: "resolved", value: "Ada" },
                  age: { status: "resolved", value: 37 },
                },
              },
            },
          },
          EMPTY_DIALOG,
        );
        expect(matched.issues).toEqual([]);
        expect(matched.matched).toBe(arc(SOURCE, "Main"));
        expect(matched.observations).toEqual([]);
        result = settleTransitions(
          runtime,
          runtime.start(matched.traversals, EMPTY_DIALOG),
          EMPTY_DIALOG,
        );
      } else {
        let pending = actionProgress(enter(runtime));
        if (context === "catchDeflection" || context === "catchInterruption") {
          if (context === "catchDeflection") {
            expect(pending.observations[0]).toMatchObject({ cell: "waiting" });
            expect(pending.allowedMoves).toContain("deflect");
          } else
            expect(pending.instructions.map((item) => item.text)).toEqual([
              "finish",
            ]);
          pending = progressBrief(
            runtime,
            pending,
            context === "catchDeflection"
              ? { move: "deflect" }
              : {
                  move: "interrupt",
                  interruption: { id: "group-catch", reason: "collect fields" },
                },
          );
        }
        expect(pending.observations).toHaveLength(1);
        const group = groupObservation(pending.observations[0]);
        expect(group.mode).toBe(mode);
        expect(group.fields.map((field) => field.cell)).toEqual([
          "name",
          "age",
        ]);
        result = settleTransitions(
          runtime,
          runtime.progress(
            pending,
            {
              move: "proceed",
              instructions: appliedInstructions(pending),
              observations: {
                [group.id]: {
                  fields: {
                    name: { status: "resolved", value: "Ada" },
                    age: { status: "resolved", value: 37 },
                  },
                },
              },
            },
            EMPTY_DIALOG,
          ),
          EMPTY_DIALOG,
        );
      }
      if (result.canProgress) {
        expect(result.observations).toEqual([]);
        expect(result.instructions.map((item) => item.text)).toEqual([
          "finish",
        ]);
        result = progressTerminal(runtime, result, {
          move: "proceed",
          instructions: appliedInstructions(result),
        });
      }
      expect(result.issues).toEqual([]);
      expect(result).toMatchObject({
        canProgress: false,
        outcome: context === "catchDeflection" ? "deflected" : "covered",
      });
      const subject =
        context === "owned child" || context === "guard"
          ? ownedChild(rootTraversal(result), "Main.Child")
          : context === "imported arc"
            ? traversalByRef(result, arc(IMPORT, "Work"))
            : rootTraversal(result);
      expect(subject?.cells).toMatchObject({
        name: "Ada",
        age: 37,
        receipt: "Ada:37",
      });
    },
  );

  it.each([
    ["trigger", "Unsupported this.trigger call"],
    ["guard", "Unsupported this.guard call"],
    ["effects", "observeOrAsk() is forbidden inside this.effects"],
    ["instruction resolveWhen", "Unsupported $instructLoop().resolveWhen call"],
    ["instruction deflectWhen", "Unsupported $instruct().deflectWhen call"],
    ["enterLoop resolveWhen", "Unsupported $enterLoop().resolveWhen call"],
  ] as const)(
    "act.observe-group rejects observeOrAsk in %s",
    (context, message) => {
      expect(() => parse(contextSource(context, "observeOrAsk").main)).toThrow(
        message,
      );
    },
  );

  it.each(["observe", "observeOrAsk"] as const)(
    "act.observe-group restores pending and committed %s state on fresh runtimes",
    (mode) => {
      const source = {
        main: `"arc"; function Main() {
      ${DECLARATIONS}
      name.$set("held"); age.$set(5);
      $${mode}({ name, age });
      $instruct(\`Observed \${name}:\${age}\`);
    }`,
      };
      const runtime = runtimeFor(source);
      const initial = actionProgress(enter(runtime));
      const group = groupObservation(initial.observations[0]);
      const waiting = progressBrief(runtime, initial, {
        move: "proceed",
        observations: {
          [group.id]: {
            fields: {
              name: { status: "resolved", value: "Ada" },
              age:
                mode === "observeOrAsk"
                  ? { status: "needs-user" }
                  : { status: "resolved", value: "invalid" },
            },
          },
        },
      });
      expect(rootTraversal(waiting).cells).toMatchObject({
        name: "held",
        age: 5,
      });
      expect(groupObservation(waiting.observations[0]).id).toBe(group.id);
      expect(waiting.instructions).toEqual([]);
      if (mode === "observe")
        expect(waiting.issues).toContainEqual(
          expect.objectContaining({ kind: "invalid-item" }),
        );
      const restarted = runtimeFor(source);
      const pending = startRun(
        restarted,
        JSON.parse(JSON.stringify(waiting.traversals)) as ArcTraversalSet,
        EMPTY_DIALOG,
      );
      expect(pending.observations).toEqual(waiting.observations);
      expect(rootTraversal(pending).cells).toMatchObject({
        name: "held",
        age: 5,
      });
      const committed = progressBrief(restarted, pending, {
        move: "proceed",
        observations: {
          [group.id]: {
            fields: {
              name: { status: "resolved", value: "Ada" },
              age: { status: "resolved", value: 37 },
            },
          },
        },
      });
      expect(committed.observations).toEqual([]);
      expect(committed.instructions.map((item) => item.text)).toEqual([
        "Observed Ada:37",
      ]);
      const afterCommit = runtimeFor(source);
      const restored = startRun(
        afterCommit,
        JSON.parse(JSON.stringify(committed.traversals)) as ArcTraversalSet,
        EMPTY_DIALOG,
      );
      expect(restored.observations).toEqual([]);
      expect(restored.instructions).toEqual(committed.instructions);
      expect(rootTraversal(restored).cells).toMatchObject({
        name: "Ada",
        age: 37,
      });
      const done = progressTerminal(afterCommit, restored, {
        move: "proceed",
        instructions: appliedInstructions(restored),
      });
      expect(done).toMatchObject({ outcome: "covered", issues: [] });
      expect(rootTraversal(done).cells).toMatchObject({ name: "Ada", age: 37 });
    },
  );
});
