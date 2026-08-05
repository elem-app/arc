/**
 * Behavior tests for the Execution Engine area (`seg.*` and `defl.*` entries
 * in specs/testing.md).
 *
 * Ported from `runtime.test.ts` per the coverage manifest. Every case feeds a
 * deterministic Arc source string and injects semantic results through
 * reports, so there is no nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { resumePath } from "../src/runtime/execute.js";
import { Runtime } from "../src/runtime/index.js";
import type { SegFrame } from "../src/runtime/seg.js";
import type { ElementId, Statement } from "../src/types.js";
import {
  appliedHostEffects,
  appliedInstructions,
  arc,
  EMPTY_DIALOG,
  METAL_SOURCE,
  node,
  ownedChild,
  progressBrief,
  renderSemanticTextForTest,
  rootTraversal,
  startRun,
  startTrigger,
  traversalByRef,
  withExperimentalRewalk,
} from "./helpers.js";

describe("execution engine", () => {
  describe("seg.write-diff", () => {
    it("$observe() that reports no value advances past it", () => {
      const document = parse(`
"arc";

function Main() {
  let interest = Enum(["cold", "warm"]);
  interest.observing = \`how interested is \${user}\`;
  $observe(interest);
  $instruct(\`after\`);
}
`);
      const runtime = new Runtime().add("n2-arc", document);
      const seeded = runtime.newTraversal(arc("n2-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.observations).toHaveLength(1);

      const next = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "unknown" },
        },
      });

      expect(next.instructions.map((item) => item.text)).toEqual(["after"]);
      expect(rootTraversal(next).cells.interest).toBeUndefined();
    });

    it("a return commit equal to the existing value advances the caller", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();
  verdict.$set(true);
  $enter(Child, {
    returns: { verdict },
  });
  $instruct(\`tail\`);

  function Child(returns = { verdict: Bool() }) {
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("n3-arc", document);
      const seeded = runtime.newTraversal(arc("n3-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(rootTraversal(brief).cells.verdict).toBe(true);
    });

    it("a descendant write cancelled back leaves the caller un-re-walked", () => {
      const document = parse(`
"arc";

function Main() {
  let choice = Enum(["a", "b"]);
  choice.$set("a");

  if (choice == "b") {
    $instruct(\`main saw b\`);
  }

  $enter(Child, {
    returns: { choice },
  });
  $instruct(\`main tail\`);

  function Child(returns = { choice: Enum(["a", "b"]) }) {
    this.effects = () => {
      returns.choice.$set("b");
      returns.choice.$set("a");
    };
  }
}
`);
      const runtime = new Runtime().add("n4-arc", document);
      const seeded = runtime.newTraversal(arc("n4-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "main tail",
      ]);
      expect(rootTraversal(brief).cells.choice).toBe("a");
    });

    it("re-setting a Dialog cursor to a structurally equal value advances", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);
  startedAt.$set(Dialog.cursor);

  if (Dialog.cursor.totalTurnsSince(startedAt) >= 0) {
    $instruct(\`since start\`);
  }
}
`);
      const runtime = new Runtime().add("n6-arc", document);
      const seeded = runtime.newTraversal(arc("n6-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 1, self: 2 },
        lastTurns: [],
      });

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "since start",
      ]);
      expect(rootTraversal(brief).cells.startedAt).toEqual({
        user: 1,
        self: 2,
      });
    });

    it("an instruction with a side-effect-free resolveWhen advances on resolve", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();

  if (x == true) {
    $instruct(\`gated\`);
  }

  $instructLoop(\`work\`, {
    resolveWhen: \`is the work done\`,
  });
  $instruct(\`tail\`);
}
`);
      const runtime = new Runtime().add("n7a-arc", document);
      const seeded = runtime.newTraversal(arc("n7a-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.instructions.map((item) => item.text)).toEqual(["work"]);
      expect(brief.judgments).toHaveLength(1);

      const resolved = progressBrief(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      });

      // `x` never changed, so resolving `work` advances: `tail` surfaces and the
      // earlier `gated` branch does not.
      expect(resolved.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(rootTraversal(resolved).cells.x).toBeUndefined();
    });

    it("an instruction whose resolveWhen sets an outer cell re-walks the SEG", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();

  if (x == true) {
    $instruct(\`gated\`);
  }

  $instructLoop(\`work\`, {
    resolveWhen: () => {
      x.$set(true);
      return judge(\`is the work done\`);
    },
  });
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("n7b-arc", document);
      const seeded = runtime.newTraversal(arc("n7b-arc", "Main"));
      seeded.phase = "entered";

      // While `work` is pending its earlier `gated` branch stays isolated.
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.instructions.map((item) => item.text)).toEqual(["work"]);

      // The resolveWhen set `x` true; that net-changes the SEG read-set, so on the
      // next pass the earlier `gated` branch re-evaluates and reaches — unlike the
      // side-effect-free resolveWhen case, which leaves `gated` unreached.
      const resolved = progressBrief(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      });
      expect(resolved.instructions.map((item) => item.text)).toEqual(["gated"]);
      expect(rootTraversal(resolved).cells.x).toBe(true);
    });

    it("a set-return read in the same effects SEG re-walks so a gated host-call fires", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  let verdict = Bool();
  $enter(Child, {
    returns: { verdict },
  });

  function Child(returns = { verdict: Bool() }) {
    this.effects = () => {
      if (returns.verdict == true) {
        Memoir.facts.$apply(\`verdict recorded\`);
      }
      returns.verdict.$set(true);
    };
  }
}
`);
      withExperimentalRewalk(document, "Main.Child");
      const runtime = new Runtime().add("n11-arc", document);
      const seeded = runtime.newTraversal(arc("n11-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.hostEffects).toHaveLength(1);
      expect(brief.hostEffects[0]!.operation).toBe("apply");
      expect(rootTraversal(brief).phase).toBe("entered");
      expect(rootTraversal(brief).cells.verdict).toBeUndefined();

      // Reporting the effect resolves the child, which commits the staged
      // `returns.verdict` write back to the caller.
      const confirmed = progressBrief(runtime, brief, {
        move: "proceed",
        hostEffects: appliedHostEffects(brief),
      });

      expect(rootTraversal(confirmed).cells.verdict).toBe(true);
      expect(rootTraversal(confirmed).phase).toBe("completed");
    });

    it("a child gating on args.* re-walks when a descendant mutates the caller-backed cell", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  $enter(Child, {
    args: { ready },
  });

  function Child(args = { ready: Bool() }) {
    if (args.ready == true) {
      $instruct(\`child ready\`);
    }
    $enter(Grandchild);
    $instruct(\`child tail\`);

    function Grandchild() {
      this.effects = () => {
        ready.$set(true);
      };
    }
  }
}
`);
      withExperimentalRewalk(document, "Main.Child");
      const runtime = new Runtime().add("n12-arc", document);
      const seeded = runtime.newTraversal(arc("n12-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      // The grandchild writes the caller-backed `ready`; `args.ready` is in the
      // child's read-set, so the $enter(Grandchild) snapshot catches the change and
      // the child re-walks, reaching the gated `child ready`.
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "child ready",
      ]);
      const tail = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      expect(tail.instructions.map((item) => item.text)).toEqual([
        "child tail",
      ]);
    });

    it("only the suspended enter resolves when two sites target the same child", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $enter(Child);
  $instruct(\`tail\`);

  function Child() {
    let t = Enum(["unknown", "metal"]);
    t.observing = \`what topic\`;
    $observeOrAsk(t);
  }
}
`);
      const runtime = new Runtime().add("n15-arc", document);
      const seeded = runtime.newTraversal(arc("n15-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.observations).toHaveLength(1);
      expect(first.active).toEqual(node("n15-arc", "Main.Child"));

      // Resolving the one entered child covers it; the second plain enter sees it
      // already covered, so `tail` surfaces with no second observation.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "metal" },
        },
      });
      expect(second.observations).toHaveLength(0);
      expect(second.instructions.map((item) => item.text)).toEqual(["tail"]);
      expect(ownedChild(rootTraversal(second), "Main.Child")?.enterCount).toBe(
        1,
      );
    });

    it("re-walks from the top after $enter() resolves normally", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();

  if (verdict == true) {
    $instruct(\`before\`);  }

  $enter(Child, {
    returns: { verdict },
  });

  if (verdict == true) {
    $instruct(\`after\`);  }

  function Child(returns = { verdict: Bool() }) {
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("enter-rewalk-arc", document);
      const seeded = runtime.newTraversal(arc("enter-rewalk-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["before"]);
      expect(rootTraversal(brief).cells.verdict).toBe(true);
      const after = progressBrief(runtime, brief, {
        move: "proceed",
        instructions: appliedInstructions(brief),
      });
      expect(after.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("resumes after a blocking enter whose returns change the caller", () => {
      const document = parse(`
"arc";

function Main() {
  let verdict = Bool();

  if (verdict == true) {
    $instruct(\`before\`);
  }

  $enter(Child, {
    returns: { verdict },
  });

  if (verdict == true) {
    $instruct(\`after\`);
  }

  function Child(returns = { verdict: Bool() }) {
    let topic = Str();
    topic.observing = \`what topic\`;
    $observe(topic);
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
`);
      const runtime = new Runtime().add("enter-advance-arc", document);
      const seeded = runtime.newTraversal(arc("enter-advance-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("enter-advance-arc", "Main.Child"));
      expect(first.observations).toHaveLength(1);

      const advanced = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: {
            status: "resolved",
            value: "metal",
          },
        },
      });

      expect(advanced.instructions.map((item) => item.text)).toEqual(["after"]);
      expect(rootTraversal(advanced).cells.verdict).toBe(true);
    });
  });

  describe("seg.resume", () => {
    it("an instruction resolves owner-first when its resolveWhen gates an earlier blocking enter", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $enter(Child);
  }

  $instructLoop(\`X\`, {
    resolveWhen: () => {
      ready.$set(true);
      return judge(\`is X done\`);
    },
  });
  $instruct(\`done\`);

  function Child() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("bug-a-arc", document);
      const seeded = runtime.newTraversal(arc("bug-a-arc", "Main"));
      seeded.phase = "entered";

      // `ready` is unset, so the earlier $enter(Child) is skipped; `X` emits and its
      // resolveWhen sets `ready=true` while blocking on the judge.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(first.judgments).toHaveLength(1);

      // Reporting the judge resolves `X` owner-first; only then does the body
      // re-walk, entering the now-gated Child, which blocks on its observation.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.active).toEqual(node("bug-a-arc", "Main.Child"));
      expect(second.observations).toHaveLength(1);

      // Covering Child resolves the enter; `X` stayed resolved (not re-asked from
      // scratch), so the body completes at `done` rather than re-emitting `X`.
      const third = progressBrief(runtime, second, {
        move: "proceed",
        observations: {
          [second.observations[0]!.id]: { status: "resolved", value: "metal" },
        },
      });
      expect(third.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("while an instruction resolveWhen stays unresolved, its gated enter stays isolated", () => {
      // The negative half of the owner-first discriminator: when the owner hook does NOT
      // resolve, the instruction owns the frontier and the earlier branch its hook
      // enabled must stay dormant. An implementation that re-walks the body after
      // resuming owner-first (instead of blocking on the still-pending owner) would
      // leak into $enter(Child) here — so this fails it, while the positive case
      // fails a "never resolve owner-first" implementation.
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $enter(Child);
  }

  $instructLoop(\`X\`, {
    resolveWhen: () => {
      ready.$set(true);
      return judge(\`is X done\`);
    },
  });
  $instruct(\`done\`);

  function Child() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("bug-a-neg-arc", document);
      const seeded = runtime.newTraversal(arc("bug-a-neg-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(first.judgments).toHaveLength(1);

      // Proceed without reporting the judge: `X` stays pending on its hook. The
      // hook's `ready=true` write is committed, but the gated $enter(Child) does NOT
      // fire — the pending instruction keeps the frontier and the body stays put.
      const second = progressBrief(runtime, first, { move: "proceed" });
      expect(second.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(second.judgments).toHaveLength(1);
      expect(second.observations).toEqual([]);
      expect(second.active).toEqual(node("bug-a-neg-arc", "Main"));
      expect(rootTraversal(second).cells.ready).toBe(true);
    });

    describe("resumePath", () => {
      // A hand-built body covering every nesting shape. resumePath is purely
      // lexical, so the `if` conditions are irrelevant — it descends both branches
      // regardless. Action ids are located by instruction text so the assertions
      // never hard-code parser-assigned numbers.
      const document = parse(`
"arc";

function Main() {
  $instruct(\`top0\`);
  if (true) {
    $instruct(\`cons\`);
  } else {
    $instruct(\`alt\`);
  }
  fork: {
    $instruct(\`labeled\`);
    if (true) {
      $instruct(\`labelThenIf\`);
    }
  }
  if (true) {
    dlabel: {
      if (true) {
        $instruct(\`deep\`);
      }
    }
  }
  $instruct(\`last\`);
}
`);
      const body = document.roots[0]!.statements;

      function asIf(statement: Statement): Extract<Statement, { kind: "if" }> {
        if (statement.kind !== "if")
          throw new Error("Expected an if statement");
        return statement;
      }
      function asLabel(
        statement: Statement,
      ): Extract<Statement, { kind: "label" }> {
        if (statement.kind !== "label")
          throw new Error("Expected a label statement");
        return statement;
      }

      const consAltIf = asIf(body[1]!);
      const consequent = consAltIf.consequent;
      const alternate = consAltIf.alternate!;
      const forkLabel = asLabel(body[2]!);
      const forkBody = forkLabel.body;
      const labelThenIf = asIf(forkBody[1]!);
      const labelThenIfCons = labelThenIf.consequent;
      const deepOuterIf = asIf(body[3]!);
      const dlabel = asLabel(deepOuterIf.consequent[0]!);
      const dlabelBody = dlabel.body;
      const deepInnerIf = asIf(dlabelBody[0]!);
      const deepInnerCons = deepInnerIf.consequent;

      function instructionText(statement: Statement): string | undefined {
        if (statement.kind !== "instruction") return undefined;
        const template = statement.template;
        if (template.kind === "literal") return template.value;
        const part = template.parts[0];
        return part && part.kind === "text" ? part.value : undefined;
      }

      function findInstructionId(
        statements: readonly Statement[],
        text: string,
      ): ElementId {
        for (const statement of statements) {
          if (statement.kind === "if") {
            const found =
              tryFindInstructionId(statement.consequent, text) ??
              tryFindInstructionId(statement.alternate ?? [], text);
            if (found !== undefined) return found;
          } else if (statement.kind === "label") {
            const found = tryFindInstructionId(statement.body, text);
            if (found !== undefined) return found;
          } else if (
            statement.kind === "instruction" &&
            instructionText(statement) === text
          ) {
            return statement.id;
          }
        }
        throw new Error(`Instruction not found: ${text}`);
      }
      function tryFindInstructionId(
        statements: readonly Statement[],
        text: string,
      ): ElementId | undefined {
        try {
          return findInstructionId(statements, text);
        } catch {
          return undefined;
        }
      }

      function expectFrame(
        frame: SegFrame<Statement>,
        statements: readonly Statement[],
        index: number,
        label: string | undefined,
      ): void {
        expect(frame.statements).toBe(statements);
        expect(frame.index).toBe(index);
        expect(frame.label).toBe(label);
      }

      it("addresses a top-level target, both at and after", () => {
        const id = findInstructionId(body, "top0");
        const at = resumePath(body, id, "at")!;
        expect(at).toHaveLength(1);
        expectFrame(at[0]!, body, 0, undefined);

        const after = resumePath(body, id, "after")!;
        expect(after).toHaveLength(1);
        expectFrame(after[0]!, body, 1, undefined);
      });

      it("descends into an if consequent", () => {
        const id = findInstructionId(body, "cons");
        const path = resumePath(body, id, "at")!;
        expect(path).toHaveLength(2);
        expectFrame(path[0]!, body, 1, undefined);
        expectFrame(path[1]!, consequent, 0, undefined);
      });

      it("descends into an if alternate", () => {
        const id = findInstructionId(body, "alt");
        const path = resumePath(body, id, "at")!;
        expect(path).toHaveLength(2);
        // The parent frame still points at the `if`; only the alternate branch is
        // entered, so a consequent-only descent would never find the target.
        expectFrame(path[0]!, body, 1, undefined);
        expectFrame(path[1]!, alternate, 0, undefined);
      });

      it("carries the label name on the label-body frame, not the parent", () => {
        const id = findInstructionId(body, "labeled");
        const path = resumePath(body, id, "at")!;
        expect(path).toHaveLength(2);
        // Parent frame points at the `label` statement and carries no label.
        expectFrame(path[0]!, body, 2, undefined);
        // The body frame is the one tagged with the label name.
        expectFrame(path[1]!, forkBody, 0, "fork");
      });

      it("produces two child frames for a label body that nests an if", () => {
        const id = findInstructionId(body, "labelThenIf");
        const path = resumePath(body, id, "at")!;
        expect(path).toHaveLength(3);
        expectFrame(path[0]!, body, 2, undefined);
        // Only the label-body frame carries the label; the if-branch frame does not.
        expectFrame(path[1]!, forkBody, 1, "fork");
        expectFrame(path[2]!, labelThenIfCons, 0, undefined);
      });

      it("reconstructs deep nesting (if -> label -> if)", () => {
        const id = findInstructionId(body, "deep");
        const path = resumePath(body, id, "at")!;
        expect(path).toHaveLength(4);
        expectFrame(path[0]!, body, 3, undefined);
        expectFrame(path[1]!, deepOuterIf.consequent, 0, undefined);
        expectFrame(path[2]!, dlabelBody, 0, "dlabel");
        expectFrame(path[3]!, deepInnerCons, 0, undefined);
      });

      it("leaves the deepest index at branch length for after-at-end", () => {
        const id = findInstructionId(body, "cons");
        const path = resumePath(body, id, "after")!;
        expect(path).toHaveLength(2);
        expectFrame(path[0]!, body, 1, undefined);
        // `cons` is the only statement in the consequent, so "after" lands at the
        // branch length; the walk's normal pop chain bumps the parent past the if.
        expect(path[1]!.index).toBe(consequent.length);
        expectFrame(path[1]!, consequent, consequent.length, undefined);
      });

      it("returns undefined for an absent target", () => {
        const absent = "body/9999" as ElementId;
        expect(resumePath(body, absent, "at")).toBeUndefined();
        expect(resumePath(body, absent, "after")).toBeUndefined();
      });
    });

    it("a nested instruction owner resolves owner-first, then the gated nested enter fires", () => {
      // The owner-first case with instructLoop nested in an `if`: positional resume
      // must reach the nested owner first and re-evaluate its hook before the
      // body re-walks the earlier enter the hook enabled.
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $enter(Child);
  }

  if (true) {
    $instructLoop(\`X\`, {
      resolveWhen: () => {
        ready.$set(true);
        return judge(\`is X done\`);
      },
    });
    $instruct(\`done\`);
  }

  function Child() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("nested-bug-a-arc", document);
      const seeded = runtime.newTraversal(arc("nested-bug-a-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(first.judgments).toHaveLength(1);

      // Reporting the judge resolves the nested `X` owner-first; only then does
      // the body re-walk (ready changed), entering the now-gated nested Child.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.active).toEqual(node("nested-bug-a-arc", "Main.Child"));
      expect(second.observations).toHaveLength(1);

      const third = progressBrief(runtime, second, {
        move: "proceed",
        observations: {
          [second.observations[0]!.id]: { status: "resolved", value: "metal" },
        },
      });
      expect(third.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("while a nested instruction owner stays unresolved, its gated enter stays isolated", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $enter(Child);
  }

  if (true) {
    $instructLoop(\`X\`, {
      resolveWhen: () => {
        ready.$set(true);
        return judge(\`is X done\`);
      },
    });
    $instruct(\`done\`);
  }

  function Child() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("nested-bug-a-neg-arc", document);
      const seeded = runtime.newTraversal(arc("nested-bug-a-neg-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["X"]);

      // Proceed without reporting the judge: the nested `X` stays pending on its
      // hook and keeps the frontier; the gated $enter(Child) does NOT fire.
      const second = progressBrief(runtime, first, { move: "proceed" });
      expect(second.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(second.observations).toEqual([]);
      expect(second.active).toEqual(node("nested-bug-a-neg-arc", "Main"));
      expect(rootTraversal(second).cells.ready).toBe(true);
    });

    it("an owner in an else branch resolves owner-first via the alternate path", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $enter(Child);
  }

  if (false) {
  } else {
    $instructLoop(\`X\`, {
      resolveWhen: () => {
        ready.$set(true);
        return judge(\`is X done\`);
      },
    });
    $instruct(\`done\`);
  }

  function Child() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic\`;
    $observeOrAsk(topic);
  }
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("alt-owner-arc", document);
      const seeded = runtime.newTraversal(arc("alt-owner-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["X"]);
      expect(first.judgments).toHaveLength(1);

      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.active).toEqual(node("alt-owner-arc", "Main.Child"));
      expect(second.observations).toHaveLength(1);
    });

    it("a nested enter's resolution under an advanced dialog does not re-walk the caller", () => {
      // Dialog is not traversal-visible state: the child's resolution writes
      // nothing the caller's read-set brackets, so the enter advances even
      // though the dialog progressed while the child was blocked. The
      // cursor-gated branch stays bound to the walk's pinned cursor read and
      // rebinds only on a rewalk from a real state change.
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  if (true) {
    if (Dialog.cursor.totalTurnsSince(startedAt) >= 1) {
      $instruct(\`noticed\`);
    }
    $enter(Child);
  }

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("nested-point5-arc", document);
      const seeded = runtime.newTraversal(arc("nested-point5-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.active).toEqual(node("nested-point5-arc", "Main.Child"));

      // The dialog advances, but dialog advancement alone is not a state
      // change: the enter's read-set diff sees nothing moved, the caller
      // advances past it, and the gated branch never re-fires — Main
      // completes without "noticed".
      const second = progressBrief(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "a" },
          },
        },
        { cursor: { user: 1, self: 1 }, lastTurns: [] },
      );
      expect(second.instructions).toEqual([]);
      expect(rootTraversal(second).phase).toBe("completed");
    });

    it("a clean nested enter advance reaches only the caller's own tail", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  if (true) {
    if (Dialog.cursor.totalTurnsSince(startedAt) >= 1) {
      $instruct(\`noticed\`);
    }
    $enter(Child);
    $instruct(\`main tail\`);
  }

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("nested-point5-clean-arc", document);
      const seeded = runtime.newTraversal(
        arc("nested-point5-clean-arc", "Main"),
      );
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.active).toEqual(
        node("nested-point5-clean-arc", "Main.Child"),
      );

      // Clean: no dialog advance, so the nested enter advances past — only the
      // caller's own "main tail" surfaces, never the earlier gated branch. This
      // is a correctness guard for the nested "after" parent-bump (a full re-walk
      // would be observationally identical here).
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "main tail",
      ]);
    });

    it("a nested enter in an else branch advances to the top-level tail", () => {
      const document = parse(`
"arc";

function Main() {
  if (false) {
  } else {
    $enter(Child);
  }
  $instruct(\`tail\`);

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("alt-enter-arc", document);
      const seeded = runtime.newTraversal(arc("alt-enter-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("alt-enter-arc", "Main.Child"));

      // The enter is the last statement of the else branch; "after" reconstruction
      // through the alternate path then pops to the top-level tail.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual(["tail"]);
    });

    it("an enter at the end of an if branch resumes to the outer tail exactly once", () => {
      const document = parse(`
"arc";

function Main() {
  if (true) {
    $enter(Child);
  }
  $instruct(\`outer tail\`);

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("after-at-end-arc", document);
      const seeded = runtime.newTraversal(arc("after-at-end-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("after-at-end-arc", "Main.Child"));

      // "after" lands at the branch length; the pop chain bumps the parent past
      // the if exactly once — no simulated pop would double-bump past the tail.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "outer tail",
      ]);
    });

    it("a nested enterLoop with a blocking resolveWhen re-reaches positionally across false then true", () => {
      const document = parse(`
"arc";

function Main() {
  if (true) {
    $enterLoop(Child, {
      resolveWhen: () => {
        return judge(\`is the loop done\`);
      },
    });
    $instruct(\`loop tail\`);
  }

  // Forgetful on entry so each loop iteration re-asks (and re-blocks) rather than
  // re-covering an already-resolved observation, which would never re-reach the
  // hook.
  function Child() {
    this.forgetfulEntry = true;
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("nested-enterloop-arc", document);
      const seeded = runtime.newTraversal(arc("nested-enterloop-arc", "Main"));
      seeded.phase = "entered";

      // Iteration 1: Child blocks on its observation.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("nested-enterloop-arc", "Main.Child"));
      expect(first.observations).toHaveLength(1);

      // Child covers → the nested enterLoop is re-reached positionally → its
      // resolveWhen blocks on the judge (the enterLoop hook frame is recorded).
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.judgments).toHaveLength(1);

      // Judge false → owner-first resume re-reaches the nested loop and re-enters
      // the target → Child blocks again.
      const third = progressBrief(runtime, second, {
        move: "proceed",
        judgments: { [second.judgments[0]!.id]: false },
      });
      expect(third.active).toEqual(node("nested-enterloop-arc", "Main.Child"));
      expect(third.observations).toHaveLength(1);

      // Child covers again → resolveWhen blocks on the judge again.
      const fourth = progressBrief(runtime, third, {
        move: "proceed",
        observations: {
          [third.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(fourth.judgments).toHaveLength(1);

      // Judge true → the loop resolves and the body advances to its tail.
      const fifth = progressBrief(runtime, fourth, {
        move: "proceed",
        judgments: { [fourth.judgments[0]!.id]: true },
      });
      expect(fifth.instructions.map((item) => item.text)).toEqual([
        "loop tail",
      ]);
    });

    it("resumes the deepest blocked SEG and bubbles up one ancestor at a time", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  $enter(A);
  $instruct(\`main tail\`);
  function A() {
    $enter(B);
    $instruct(\`a tail\`);
    function B() {
      $enter(Child);
      $instruct(\`b tail\`);
      function Child() {
        $observeOrAsk(ready);      }
    }
  }
}
`);
      const runtime = new Runtime().add("deep-nesting-arc", document);
      const seeded = runtime.newTraversal(arc("deep-nesting-arc", "Main"));
      seeded.phase = "entered";

      // The walk descends Main -> A -> B -> Child and blocks at Child's observe.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("deep-nesting-arc", "Main.A.B.Child"));
      expect(first.observations).toHaveLength(1);

      // Resolving the observe covers Child and bubbles up exactly one level: B's
      // own tail surfaces only now that Child resolved, and the frontier is B.
      const atB = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      expect(atB.instructions.map((item) => item.text)).toEqual(["b tail"]);
      expect(atB.active).toEqual(node("deep-nesting-arc", "Main.A.B"));

      // Each subsequent step covers the current node and returns control to the
      // next ancestor, surfacing its tail only as control reaches it.
      const atA = progressBrief(runtime, atB, {
        move: "proceed",
        instructions: appliedInstructions(atB),
      });
      expect(atA.instructions.map((item) => item.text)).toEqual(["a tail"]);
      expect(atA.active).toEqual(node("deep-nesting-arc", "Main.A"));

      const atMain = progressBrief(runtime, atA, {
        move: "proceed",
        instructions: appliedInstructions(atA),
      });
      expect(atMain.instructions.map((item) => item.text)).toEqual([
        "main tail",
      ]);
      expect(atMain.active).toEqual(node("deep-nesting-arc", "Main"));
    });
  });

  describe("seg.isolation", () => {
    it("a blocked child's caller mutation surfaces only when the enter resolves", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $instruct(\`before\`);
  }

  $enter(Child, {
    returns: { ready },
  });
  $instruct(\`after\`);

  function Child(returns = { ready: Bool() }) {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    $observeOrAsk(topic);

    this.effects = () => {
      returns.ready.$set(true);
    };
  }
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("n10-arc", document);
      const seeded = runtime.newTraversal(arc("n10-arc", "Main"));
      seeded.phase = "entered";

      // The child stages `ready=true` then blocks; `before` does not surface yet.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("n10-arc", "Main.Child"));
      expect(first.observations).toHaveLength(1);
      expect(rootTraversal(first).cells.ready).toBeUndefined();

      // Resolving the child commits `ready=true`; the enter resolves and the
      // caller re-walks, so the gated `before` surfaces first.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "metal" },
        },
      });

      expect(rootTraversal(second).cells.ready).toBe(true);
      expect(second.instructions.map((item) => item.text)).toEqual(["before"]);
      const after = progressBrief(runtime, second, {
        move: "proceed",
        instructions: appliedInstructions(second),
      });
      expect(after.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("a pending instruction isolates its hook mutation until it resolves", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();

  if (x == true) {
    $instruct(\`B\`);
  }

  $instructLoop(\`A\`, {
    resolveWhen: () => {
      x.$set(true);
      return judge(\`is A done\`);
    },
  });
}
`);
      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("n16-arc", document);
      const seeded = runtime.newTraversal(arc("n16-arc", "Main"));
      seeded.phase = "entered";

      // While `A` is pending, its resolveWhen set `x` true, but `B` (an earlier
      // branch) stays isolated and does not surface.
      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.instructions.map((item) => item.text)).toEqual(["A"]);

      // Resolve-before-rewalk: `A` resolves first (so it is skipped on the
      // re-walk), and only then does the enclosing body SEG re-walk under the
      // hook-mutated `x`, letting the earlier `B` branch reach. `B` alone — not
      // `[A, B]` — proves `A` resolved before the SEG re-walked.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        judgments: { [first.judgments[0]!.id]: true },
      });
      expect(second.instructions.map((item) => item.text)).toEqual(["B"]);
      expect(rootTraversal(second).cells.x).toBe(true);
    });

    it("keeps child internal resolution insulated from the caller $enter()", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Child);
  $instruct(\`after\`);
  function Child() {
    let ready = Bool({
      observing: \`is \${user} ready\`,
    });
    $observeOrAsk(ready);
    $instruct(\`child done\`);  }
}
`);
      const runtime = new Runtime().add("enter-insulation-arc", document);
      const seeded = runtime.newTraversal(arc("enter-insulation-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("enter-insulation-arc", "Main.Child"));
      expect(first.observations).toHaveLength(1);

      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });

      expect(second.instructions.map((item) => item.text)).toEqual([
        "child done",
      ]);
      expect(second.active).toEqual(node("enter-insulation-arc", "Main.Child"));

      const third = progressBrief(runtime, second, {
        move: "proceed",
        instructions: appliedInstructions(second),
      });
      expect(third.instructions.map((item) => item.text)).toEqual(["after"]);
      expect(third.active).toEqual(node("enter-insulation-arc", "Main"));
    });

    it("re-walks the caller SEG only after $enter() resolves, even when the child captures caller cells", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();

  if (ready == true) {
    $instruct(\`before\`);  }

  $enter(Child);
  $instruct(\`after\`);
  function Child() {
    $observeOrAsk(ready);
    $instruct(\`child done\`);  }
}
`);
      withExperimentalRewalk(document, "Main", "Main.Child");
      const runtime = new Runtime().add("enter-capture-seg-arc", document);
      const seeded = runtime.newTraversal(arc("enter-capture-seg-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(first.active).toEqual(node("enter-capture-seg-arc", "Main.Child"));
      expect(first.observations).toHaveLength(1);

      // Resolving the child's observe writes the caller cell `ready`, but the
      // caller branch gated on it does NOT surface yet. Under strict
      // single-active-SEG resume the caller re-walks only after the child (the
      // enter) resolves, so only the child's own instruction is briefed here.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });

      expect(rootTraversal(second).cells.ready).toBe(true);
      expect(second.instructions.map((item) => item.text)).toEqual([
        "child done",
      ]);
      expect(second.active).toEqual(
        node("enter-capture-seg-arc", "Main.Child"),
      );

      // Proceeding resolves the child's instruction → the child covers → the enter
      // resolves atomically → the caller re-walks with the enter already resolved
      // (and skipped). `before` (gated on `ready`) surfaces first.
      const third = progressBrief(runtime, second, {
        move: "proceed",
        instructions: appliedInstructions(second),
      });
      expect(third.instructions.map((item) => item.text)).toEqual(["before"]);
      expect(third.active).toEqual(node("enter-capture-seg-arc", "Main"));
      const fourth = progressBrief(runtime, third, {
        move: "proceed",
        instructions: appliedInstructions(third),
      });
      expect(fourth.instructions.map((item) => item.text)).toEqual(["after"]);
    });
  });

  describe("seg.dialog-gating", () => {
    it("a dialog-gated ancestor branch above a blocked child stays bound when only the dialog advances", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  if (Dialog.cursor.totalTurnsSince(startedAt) >= 1) {
    $instruct(\`ancestor noticed a new turn\`);
  }

  $enter(Child);

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("point5-arc", document);
      const seeded = runtime.newTraversal(arc("point5-arc", "Main"));
      seeded.phase = "entered";

      // Start at cursor {0,0}: the ancestor branch is false (0 >= 1), Child blocks.
      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.active).toEqual(node("point5-arc", "Main.Child"));
      expect(first.instructions).toEqual([]);

      // Resolve the child's observation under a later dialog cursor {1,1}:
      // Child covers and control bubbles up to Main. Dialog is not
      // traversal-visible state, so the advance alone re-walks nothing — the
      // ancestor branch keeps the walk's pinned cursor read and Main completes
      // without the ancestor instruction. Per-turn reactivity belongs to
      // trigger consultations, not to suspended body walks.
      const second = progressBrief(
        runtime,
        first,
        {
          move: "proceed",
          observations: {
            [first.observations[0]!.id]: { status: "resolved", value: "a" },
          },
        },
        { cursor: { user: 1, self: 1 }, lastTurns: [] },
      );
      expect(second.instructions).toEqual([]);
      expect(rootTraversal(second).phase).toBe("completed");
    });

    it("a clean bubble-up reaches only the caller's own tail when nothing changed", () => {
      const document = parse(`
"arc";

function Main() {
  let startedAt = Dialog.Cursor();
  startedAt.$set(Dialog.cursor);

  if (Dialog.cursor.totalTurnsSince(startedAt) >= 1) {
    $instruct(\`ancestor noticed a new turn\`);
  }

  $enter(Child);
  $instruct(\`main tail\`);

  function Child() {
    let topic = Enum(["a", "b"]);
    topic.observing = \`pick a topic\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("point5-clean-arc", document);
      const seeded = runtime.newTraversal(arc("point5-clean-arc", "Main"));
      seeded.phase = "entered";

      const first = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(first.active).toEqual(node("point5-clean-arc", "Main.Child"));

      // Resolve the child without advancing the dialog: the ancestor branch stays
      // false, so the bubble-up advances the caller to its own tail and nothing
      // else — the clean diff and a full re-walk are observationally identical.
      const second = progressBrief(runtime, first, {
        move: "proceed",
        observations: {
          [first.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(second.instructions.map((item) => item.text)).toEqual([
        "main tail",
      ]);
    });
  });

  describe("seg.fixpoint", () => {
    it("a converging effects chain settles instead of looping", () => {
      const document = parse(`
"arc";

function Main() {
  let stage = Enum(["start", "mid", "end"]);
  stage.$set("start");

  this.effects = () => {
    if (stage == "start") {
      stage.$set("mid");
    }
    if (stage == "mid") {
      stage.$set("end");
    }
  };
}
`);
      const runtime = new Runtime().add("n9-arc", document);
      const seeded = runtime.newTraversal(arc("n9-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(rootTraversal(brief).cells.stage).toBe("end");
      expect(rootTraversal(brief).phase).toBe("completed");
    });
  });

  describe("defl.propagation", () => {
    it("marks the active node deflected when the report deflects", () => {
      const document = parse(METAL_SOURCE);
      const runtime = new Runtime().add("metal-arc", document);
      const triggerBrief = startTrigger(runtime, {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "user", message: "what music are you into?" }],
      });
      const triggerOutcome = runtime.progressTrigger(
        triggerBrief,
        {
          preferredMatch: arc("metal-arc", "Metal"),
          judgments: {
            [triggerBrief.judgments[0]!.id]: true,
          },
        },
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [{ role: "user", message: "what music are you into?" }],
        },
      );

      const brief = startRun(runtime, triggerOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const nextBrief = progressBrief(runtime, brief, { move: "deflect" });

      expect(nextBrief.active).toEqual(node("metal-arc", "Metal.Surface"));
      expect(nextBrief.canProgress).toBe(false);
      expect(ownedChild(rootTraversal(nextBrief), "Metal.Surface")?.state).toBe(
        "deflected",
      );
      expect(rootTraversal(nextBrief).phase).toBe("suspended");
    });

    it("propagates uncaught imported child deflection to the importing root", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  $enter(Intro);
}
`);
      const intro = parse(`
"arc";

function Intro() {
  let topic = Enum(["unknown", "product"]);
  topic.observing = \`what product topic does \${user} want\`;
  $observeOrAsk(topic);
}
`);
      const runtime = new Runtime()
        .add("main-import-deflect-arc", main)
        .add("intro-arc", intro);
      const seeded = runtime.newTraversal(
        arc("main-import-deflect-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      const deflected = progressBrief(runtime, brief, { move: "deflect" });

      expect(traversalByRef(deflected, arc("intro-arc", "Intro"))?.state).toBe(
        "deflected",
      );
      expect(rootTraversal(deflected).state).toBe("deflected");
      expect(rootTraversal(deflected).phase).toBe("suspended");
    });

    it("lets a parent catch child deflection, set a routing flag, and rewalk itself", () => {
      const document = parse(`
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
    let priceTopic = Enum(["unknown", "pricing"]);
    priceTopic.observing = \`what pricing detail does \${user} want\`;
    $observeOrAsk(priceTopic);
  }
}
`);

      withExperimentalRewalk(document, "Main");
      const runtime = new Runtime().add("catch-deflection-arc", document);
      const seeded = runtime.newTraversal(arc("catch-deflection-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      expect(brief.active).toEqual(
        node("catch-deflection-arc", "Main.ProductIntro"),
      );

      const catching = progressBrief(runtime, brief, { move: "deflect" });
      expect(catching.active).toEqual(node("catch-deflection-arc", "Main"));
      expect(
        catching.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user wants pricing"]);
      expect(
        ownedChild(rootTraversal(catching), "Main.ProductIntro")?.state,
      ).toBe("deflected");

      const routed = progressBrief(runtime, catching, {
        move: "proceed",
        judgments: { [catching.judgments[0]!.id]: true },
      });

      // The catch's `$set(true)` dials the hook consultation back, releasing
      // the judge pin: the judgment re-poses under the freshly derived route
      // before the catch can resolve.
      expect(rootTraversal(routed).cells.wantsPricing).toBe(true);
      expect(routed.active).toEqual(node("catch-deflection-arc", "Main"));
      expect(
        routed.judgments.map((item) =>
          renderSemanticTextForTest(item.question),
        ),
      ).toEqual(["user wants pricing"]);

      const reconfirmed = progressBrief(runtime, routed, {
        move: "proceed",
        judgments: { [routed.judgments[0]!.id]: true },
      });

      expect(rootTraversal(reconfirmed).cells.wantsPricing).toBe(true);
      expect(reconfirmed.active).toEqual(
        node("catch-deflection-arc", "Main.Pricing"),
      );
      expect(reconfirmed.observations).toHaveLength(1);

      const resumed = progressBrief(runtime, reconfirmed, {
        move: "proceed",
        observations: {
          [reconfirmed.observations[0]!.id]: {
            status: "resolved",
            value: "pricing",
          },
        },
      });

      expect(rootTraversal(resumed).cells.wantsPricing).toBe(false);
      expect(resumed.active).toEqual(
        node("catch-deflection-arc", "Main.ProductIntro"),
      );
      expect(resumed.observations).toHaveLength(1);
    });

    it("catches an imported child deflection and rewalks the importing node", () => {
      const main = parse(`
"arc";
import { Intro } from "intro-arc";

function Main() {
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    if (this.deflection.escaped(Intro)) {
      wantsPricing.$set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
    wantsPricing.$set(false);
  }

  $enter(Intro);

  function Pricing() {
    let priceTopic = Enum(["unknown", "pricing"]);
    priceTopic.observing = \`what pricing detail does \${user} want\`;
    $observeOrAsk(priceTopic);
  }
}
`);
      const intro = parse(`
"arc";

function Intro() {
  let topic = Enum(["unknown", "product"]);
  topic.observing = \`what product topic does \${user} want\`;
  $observeOrAsk(topic);
}
`);
      const runtime = new Runtime()
        .add("main-import-catch-arc", main)
        .add("intro-arc", intro);
      const seeded = runtime.newTraversal(arc("main-import-catch-arc", "Main"));
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
      expect(brief.active).toEqual(node("intro-arc", "Intro"));

      const routed = progressBrief(runtime, brief, { move: "deflect" });

      expect(rootTraversal(routed).state).toBeUndefined();
      expect(traversalByRef(routed, arc("intro-arc", "Intro"))?.state).toBe(
        "deflected",
      );
      expect(rootTraversal(routed).cells.wantsPricing).toBe(true);
      expect(routed.active).toEqual(
        node("main-import-catch-arc", "Main.Pricing"),
      );
    });
  });

  describe("defl.restart", () => {
    it("retries deflected children but auto-skips covered children on trigger restart", () => {
      const retryDocument = parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.forgetfulEntry = true;

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;
    $observeOrAsk(topic);
    $instruct(\`after \${topic}\`);  }
}
`);
      const runtime = new Runtime().add("retry-arc", retryDocument);
      const firstOutcome = runtime.progressTrigger(
        startTrigger(runtime, EMPTY_DIALOG),
        {
          preferredMatch: arc("retry-arc", "Main"),
        },
        EMPTY_DIALOG,
      );
      const firstBrief = startRun(runtime, firstOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

      expect(ownedChild(deflected.traversals[0]!, "Main.Intro")?.state).toBe(
        "deflected",
      );

      const restartedOutcome = runtime.progressTrigger(
        startTrigger(runtime, EMPTY_DIALOG, deflected.traversals),
        { preferredMatch: arc("retry-arc", "Main") },
        EMPTY_DIALOG,
      );
      const restartedBrief = startRun(runtime, restartedOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });

      expect(restartedBrief.active).toEqual(node("retry-arc", "Main.Intro"));
      expect(restartedBrief.observations).toHaveLength(1);

      const coveredDocument = parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.forgetfulEntry = true;

  $enter(Intro);
  $instruct(\`after\`);
  function Intro() {
    $instruct(\`intro\`);  }
}
`);
      const coveredRuntime = new Runtime().add("covered-arc", coveredDocument);
      const coveredOutcome = coveredRuntime.progressTrigger(
        startTrigger(coveredRuntime, EMPTY_DIALOG),
        {
          preferredMatch: arc("covered-arc", "Main"),
        },
        EMPTY_DIALOG,
      );
      const firstCoveredBrief = startRun(
        coveredRuntime,
        coveredOutcome.traversals,
        {
          cursor: { user: 0, self: 0 },
          lastTurns: [],
        },
      );

      expect(firstCoveredBrief.instructions.map((item) => item.text)).toEqual([
        "intro",
      ]);

      const secondCoveredBrief = progressBrief(
        coveredRuntime,
        firstCoveredBrief,
        {
          move: "proceed",
          instructions: appliedInstructions(firstCoveredBrief),
        },
      );

      expect(secondCoveredBrief.instructions.map((item) => item.text)).toEqual([
        "after",
      ]);

      const completedCoveredBrief = progressBrief(
        coveredRuntime,
        secondCoveredBrief,
        {
          move: "proceed",
          instructions: appliedInstructions(secondCoveredBrief),
        },
      );

      const restartedCoveredOutcome = coveredRuntime.progressTrigger(
        startTrigger(
          coveredRuntime,
          EMPTY_DIALOG,
          completedCoveredBrief.traversals,
        ),
        { preferredMatch: arc("covered-arc", "Main") },
        EMPTY_DIALOG,
      );
      const restartedCoveredBrief = startRun(
        coveredRuntime,
        restartedCoveredOutcome.traversals,
        { cursor: { user: 0, self: 0 }, lastTurns: [] },
      );

      expect(
        restartedCoveredBrief.instructions.map((item) => item.text),
      ).toEqual(["after"]);
    });

    it("re-enters a suspended arc with incremented enterCount after trigger restart", () => {
      const document = parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;
    $observeOrAsk(topic);
  }
}
`);
      const runtime = new Runtime().add("suspend-reenter-arc", document);
      const firstOutcome = runtime.progressTrigger(
        startTrigger(runtime, EMPTY_DIALOG),
        { preferredMatch: arc("suspend-reenter-arc", "Main") },
        EMPTY_DIALOG,
      );
      const firstBrief = startRun(runtime, firstOutcome.traversals, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const deflected = progressBrief(runtime, firstBrief, { move: "deflect" });

      const suspendedRoot = rootTraversal(deflected);
      expect(suspendedRoot.phase).toBe("suspended");
      expect(suspendedRoot.enterCount).toBe(1);

      const restarted = runtime.progressTrigger(
        startTrigger(runtime, EMPTY_DIALOG, deflected.traversals, {
          arcRefs: [arc("suspend-reenter-arc", "Main")],
        }),
        { preferredMatch: arc("suspend-reenter-arc", "Main") },
        EMPTY_DIALOG,
      );
      const restartedRoot = restarted.traversals.find(
        (item) => item.ref === arc("suspend-reenter-arc", "Main"),
      );
      expect(restartedRoot).toMatchObject({
        phase: "entered",
        enterCount: 2,
        state: undefined,
      });
    });
  });

  describe("defl.effects-order", () => {
    it("runs child deflection effects before blocked ancestor effects", () => {
      const document = parse(`
"arc";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.$apply(\`parent effect\`);
  };

  $enter(Intro);

  function Intro() {
    let topic = Enum(["unknown", "metal"]);
    topic.observing = \`what topic does \${user} want\`;

    this.effects = () => {
      Memoir.facts.$apply(\`child effect\`);
    };

    $observeOrAsk(topic);
  }
}
`);

      const runtime = new Runtime().add("deflect-parent-effects-arc", document);
      const seeded = runtime.newTraversal(
        arc("deflect-parent-effects-arc", "Main"),
      );
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const childBrief = progressBrief(runtime, brief, { move: "deflect" });

      expect(childBrief.hostEffects).toEqual([
        {
          id: expect.any(String),
          sourceRef: node("deflect-parent-effects-arc", "Main.Intro"),
          module: "memoir",
          target: ["facts"],
          operation: "apply",
          arguments: ["child effect"],
        },
      ]);
      expect(rootTraversal(childBrief).phase).toBe("entered");
      expect(ownedChild(rootTraversal(childBrief), "Main.Intro")).toMatchObject(
        {
          state: undefined,
          finalizing: { reason: "deflected", phase: "effects" },
        },
      );

      const parentBrief = progressBrief(runtime, childBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(childBrief),
      });

      expect(parentBrief.hostEffects).toEqual([
        {
          id: expect.any(String),
          sourceRef: node("deflect-parent-effects-arc", "Main"),
          module: "memoir",
          target: ["facts"],
          operation: "apply",
          arguments: ["parent effect"],
        },
      ]);
      expect(ownedChild(rootTraversal(parentBrief), "Main.Intro")?.state).toBe(
        "deflected",
      );
      expect(rootTraversal(parentBrief)).toMatchObject({
        phase: "entered",
        state: undefined,
        finalizing: { reason: "deflected", phase: "effects" },
      });

      const suspended = progressBrief(runtime, parentBrief, {
        move: "proceed",
        hostEffects: appliedHostEffects(parentBrief),
      });

      expect(suspended.hostEffects).toEqual([]);
      expect(rootTraversal(suspended).phase).toBe("suspended");
      expect(rootTraversal(suspended).state).toBe("deflected");
    });
  });
});
