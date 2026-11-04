import { describe, expect, expectTypeOf, it } from "vitest";

import { parse, type DocumentAnalysis } from "../src/parser/index.js";
import {
  Runtime,
  type ActionBrief,
  type ArrayObservationMeta as RuntimeArrayObservationMeta,
  type ObservedStructValue as RuntimeObservedStructValue,
  type ObservedValue as RuntimeObservedValue,
  type StructObservationField as RuntimeStructObservationField,
  type StructObservationMeta as RuntimeStructObservationMeta,
  type StructValue as RuntimeStructValue,
  type TerminalBrief,
} from "../src/runtime/index.js";
import type {
  ActionInterruption,
  ActionMove,
  ActionStatement,
  ArrayObservationMeta,
  CatchInterruptionStatement,
  CellSpec,
  CellValue,
  Dialog,
  EffectStatement,
  HostCall,
  InterruptionContext,
  NodeState,
  ObservedStructValue,
  ObservedValue,
  RuntimeIssue,
  StructObservationField,
  StructObservationMeta,
  StructValue,
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

  it("struct.type-ownership exports Struct value and observation contracts from arc/types and arc/runtime", () => {
    expectTypeOf<RuntimeArrayObservationMeta>().toEqualTypeOf<ArrayObservationMeta>();
    expectTypeOf<RuntimeStructObservationMeta>().toEqualTypeOf<StructObservationMeta>();
    expectTypeOf<RuntimeStructObservationField>().toEqualTypeOf<StructObservationField>();
    expectTypeOf<RuntimeObservedValue>().toEqualTypeOf<ObservedValue>();
    expectTypeOf<RuntimeObservedStructValue>().toEqualTypeOf<ObservedStructValue>();
    expectTypeOf<RuntimeStructValue>().toEqualTypeOf<StructValue>();
    const record: RuntimeObservedStructValue = { name: "Ada", tags: ["a"] };
    const meta: RuntimeArrayObservationMeta = {
      type: "array",
      element: {
        type: "struct",
        fields: { name: { question: "the name", meta: { type: "string" } } },
      },
    };
    expect(record).toEqual({ name: "Ada", tags: ["a"] });
    expect(meta.element.type).toBe("struct");
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
  const interruption: ActionInterruption = { id: "network" };
  const output = runtime.progress(brief, { move, interruption }, dialog);
  if (output.canProgress || output.outcome !== "interrupted")
    throw new Error("Expected interruption");
  expectTypeOf<
    Extract<TraversalControl, { reason: "interrupted" }>["phase"]
  >().toEqualTypeOf<"catch" | "complete">();
  expectTypeOf<
    Extract<TraversalControl, { reason: "interrupted" }>["interruption"]
  >().toEqualTypeOf<InterruptionContext>();
  expectTypeOf<InterruptionContext["reason"]>().toEqualTypeOf<string>();
  expectTypeOf<ActionInterruption["reason"]>().toEqualTypeOf<
    string | undefined
  >();
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
