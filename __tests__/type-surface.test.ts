import { describe, expect, expectTypeOf, it } from "vitest";

import { parse, type DocumentAnalysis } from "../src/parser/index.js";
import {
  Runtime,
  type ActionBrief,
  type TerminalBrief,
} from "../src/runtime/index.js";
import type {
  ActionMove,
  ActionStatement,
  CatchInterruptionStatement,
  CellSpec,
  CellValue,
  Dialog,
  EffectStatement,
  HostCall,
  NodeState,
  RuntimeIssue,
  TraversalControl,
  ValueExpression,
} from "../src/types/index.js";

describe("public type surface", () => {
  it("exposes public domain types through their intended entry points", () => {
    const document = parse(`"arc"; function Main() {}`);
    const analysis: DocumentAnalysis = {
      issues: [],
      lintIssues: [],
      rewalkPlan: { bySeg: new Map() },
    };
    const spec: CellSpec = { type: "number" };
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    };
    const hostCall = undefined as HostCall | undefined;
    const hostCallValue = hostCall as ValueExpression | undefined;
    const hostCallAction = hostCall as ActionStatement | undefined;
    const hostCallEffect = hostCall as EffectStatement | undefined;
    const brief = undefined as ActionBrief | undefined;
    const issue = undefined as RuntimeIssue | undefined;

    expect(document.roots[0]!.identifier).toBe("Main");
    expect(analysis.issues).toEqual([]);
    expect(spec.type).toBe("number");
    expect(dialog.cursor).toEqual({ user: 0, self: 0 });
    expect(hostCall).toBeUndefined();
    expect(hostCallValue).toBeUndefined();
    expect(hostCallAction).toBeUndefined();
    expect(hostCallEffect).toBeUndefined();
    expect(brief).toBeUndefined();
    expect(issue).toBeUndefined();
    expect(new Runtime()).toBeInstanceOf(Runtime);
  });
});

it("interruption.types exports hook state move and retained-root output contracts", () => {
  const document = parse(
    '"arc"; function Main() { this.catchInterruption = () => false; $instruct(`work`); }',
  );
  const hook: CatchInterruptionStatement[] | undefined =
    document.roots[0]!.catchInterruption;
  const state: NodeState = "interrupted";
  const move: ActionMove = "interrupt";
  const runtime = new Runtime().add("interrupt", document).init();
  const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
  const brief = runtime.enterArc("arc:interrupt:Main", dialog);
  if (!brief.canProgress) throw new Error("Expected work");
  const output = runtime.progress(brief, { move }, dialog);
  if (output.canProgress || output.outcome !== "interrupted")
    throw new Error("Expected interruption");
  expectTypeOf<
    Extract<TraversalControl, { reason: "interrupted" }>["phase"]
  >().toEqualTypeOf<"catch" | "complete">();
  const retained: TerminalBrief = output;
  expectTypeOf(output).toMatchTypeOf<TerminalBrief>();
  expectTypeOf(output.returns).toEqualTypeOf<undefined>();
  expectTypeOf<
    Extract<TerminalBrief, { outcome: "covered" }>["returns"]
  >().toEqualTypeOf<Record<string, CellValue> | undefined>();
  expectTypeOf<
    Exclude<TerminalBrief, { outcome: "covered" }>["returns"]
  >().toEqualTypeOf<undefined>();
  expect(retained.traversals[0]?.state).toBe(state);
  expect(hook).toHaveLength(1);
});
