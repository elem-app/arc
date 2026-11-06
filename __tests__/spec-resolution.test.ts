import { describe, expect, it } from "vitest";

import {
  arithmeticRule,
  artifactPathRule,
  booleanRule,
  comparisonRule,
  interpolationRule,
  numIsFiniteRule,
  resolveProducer,
  stringOperandRule,
  type ProducerContext,
} from "../src/spec/resolution.js";
import type { ElementId, ValueExpression } from "../src/types/ir.js";
import { createArtifactValue } from "../src/types/value.js";

const literal = (value: string | number | boolean | null): ValueExpression => ({
  kind: "literal",
  value,
});

const dynamic = (operation = "value"): ValueExpression => ({
  id: `test:${operation}` as ElementId,
  kind: "host-call",
  module: "test",
  target: [],
  operation,
  arguments: [],
});

const context: ProducerContext = {
  cells: [
    { name: "choice", type: "enum", values: ["first", "second"] },
    { name: "otherChoice", type: "enum", values: ["first", "third"] },
    { name: "text", type: "string" },
    { name: "numbers", type: "array", element: { type: "number" } },
    { name: "strings", type: "array", element: { type: "string" } },
    { name: "artifacts", type: "array", element: { type: "artifact" } },
  ],
};

describe("shared operation rules", () => {
  it("pairs arithmetic producer checks, concrete admission, and result evidence", () => {
    expect(arithmeticRule.checkProducer(literal(1), context).kind).toBe(
      "compatible",
    );
    expect(arithmeticRule.checkProducer(literal("one"), context).kind).toBe(
      "incompatible",
    );
    expect(arithmeticRule.checkProducer(dynamic(), context).kind).toBe(
      "unknown",
    );
    expect(arithmeticRule.admitValue(Number.NaN).admitted).toBe(true);
    expect(arithmeticRule.admitValue("one").admitted).toBe(false);
    expect(
      resolveProducer(
        {
          kind: "arithmetic",
          op: "/",
          left: literal(0),
          right: literal(0),
        },
        context,
      ),
    ).toEqual({ kind: "fact", fact: arithmeticRule.result });
  });

  it("lets Num.isFinite inspect every numeric carrier and owns its Bool result", () => {
    expect(numIsFiniteRule.checkProducer(literal(1), context).kind).toBe(
      "compatible",
    );
    expect(numIsFiniteRule.admitValue(Number.POSITIVE_INFINITY).admitted).toBe(
      true,
    );
    expect(numIsFiniteRule.admitValue({}).admitted).toBe(false);
    expect(
      resolveProducer({ kind: "numIsFinite", argument: literal(1) }, context),
    ).toEqual({ kind: "fact", fact: numIsFiniteRule.result });
  });

  it("pairs boolean and string operand checks with strict carrier admission", () => {
    expect(booleanRule.checkProducer(literal(true), context).kind).toBe(
      "compatible",
    );
    expect(booleanRule.checkProducer(dynamic(), context).kind).toBe("unknown");
    expect(booleanRule.admitValue("true").admitted).toBe(false);
    expect(stringOperandRule.checkProducer(literal("text"), context).kind).toBe(
      "compatible",
    );
    expect(stringOperandRule.checkProducer(literal(false), context).kind).toBe(
      "incompatible",
    );
    expect(stringOperandRule.admitValue("text").admitted).toBe(true);
  });

  it("selects and enforces one unambiguous Enum comparison domain", () => {
    const choice: ValueExpression = { kind: "cell", name: "choice" };
    expect(
      comparisonRule.checkProducers("<=", choice, literal("second"), context)
        .judgment.kind,
    ).toBe("compatible");
    expect(
      comparisonRule.checkProducers("<=", choice, literal("outside"), context)
        .judgment.kind,
    ).toBe("incompatible");
    expect(
      comparisonRule.checkProducers("<=", choice, dynamic(), context).judgment
        .kind,
    ).toBe("unknown");
    expect(
      comparisonRule.checkProducers(
        "<=",
        choice,
        { kind: "cell", name: "text" },
        context,
      ).judgment.kind,
    ).toBe("incompatible");
    expect(
      comparisonRule.checkProducers(
        "<=",
        choice,
        { kind: "cell", name: "otherChoice" },
        context,
      ).judgment.kind,
    ).toBe("incompatible");

    const dynamicDecision = comparisonRule.checkProducers(
      "<=",
      choice,
      dynamic(),
      context,
    );
    expect(
      comparisonRule.admitValues("<=", dynamicDecision, "first", "outside")
        .admitted,
    ).toBe(false);
    expect(
      resolveProducer(
        {
          kind: "comparison",
          op: "==",
          left: literal(1),
          right: literal(1),
        },
        context,
      ),
    ).toEqual({ kind: "fact", fact: comparisonRule.result });
  });

  it("uses ordinary string semantics for Enum equality", () => {
    const choice: ValueExpression = { kind: "cell", name: "choice" };
    const otherChoice: ValueExpression = {
      kind: "cell",
      name: "otherChoice",
    };

    expect(
      comparisonRule.checkProducers("==", choice, literal("outside"), context),
    ).toMatchObject({ judgment: { kind: "compatible" }, mode: "string" });
    expect(
      comparisonRule.checkProducers("!=", choice, otherChoice, context),
    ).toMatchObject({ judgment: { kind: "compatible" }, mode: "string" });
  });

  it("preserves and strictly admits the shared array element family", () => {
    const numbers: ValueExpression = { kind: "cell", name: "numbers" };
    const strings: ValueExpression = { kind: "cell", name: "strings" };

    expect(
      comparisonRule.checkProducers("==", numbers, strings, context),
    ).toMatchObject({ judgment: { kind: "incompatible" }, mode: "array" });

    const dynamicDecision = comparisonRule.checkProducers(
      "==",
      numbers,
      dynamic(),
      context,
    );
    expect(dynamicDecision).toMatchObject({
      judgment: { kind: "unknown" },
      mode: "array",
      arrayElementFamily: "number",
    });
    expect(
      comparisonRule.admitValues("==", dynamicDecision, [1], [2]).admitted,
    ).toBe(true);
    expect(
      comparisonRule.admitValues("==", dynamicDecision, [1], ["1"]).admitted,
    ).toBe(false);
    expect(
      comparisonRule.admitValues("==", dynamicDecision, [1], [{ path: "x" }])
        .admitted,
    ).toBe(false);
  });

  it("selects Artifact authority for array equality without inferring it from object shape", () => {
    const artifacts: ValueExpression = { kind: "cell", name: "artifacts" };
    const decision = comparisonRule.checkProducers(
      "==",
      artifacts,
      dynamic(),
      context,
    );
    expect(decision).toMatchObject({
      judgment: { kind: "unknown" },
      mode: "array",
      arrayElementFamily: "artifact",
    });
    expect(
      comparisonRule.admitValues(
        "==",
        decision,
        [createArtifactValue("one.md")],
        [createArtifactValue("one.md")],
      ).admitted,
    ).toBe(true);
    expect(
      comparisonRule.admitValues(
        "==",
        decision,
        [{ path: "one.md" }],
        [{ path: "/invalid.md" }],
      ).admitted,
    ).toBe(false);

    const shapeOnly = comparisonRule.checkProducers(
      "==",
      dynamic("leftArtifacts"),
      dynamic("rightArtifacts"),
      context,
    );
    expect(
      comparisonRule.admitValues(
        "==",
        shapeOnly,
        [{ path: "one.md" }],
        [{ path: "one.md" }],
      ).admitted,
    ).toBe(false);
  });

  it("pairs Artifact path and interpolation projections with producer evidence", () => {
    expect(
      artifactPathRule.checkProducer(literal("result.md"), context).kind,
    ).toBe("compatible");
    expect(artifactPathRule.checkProducer(literal(1), context).kind).toBe(
      "incompatible",
    );
    expect(artifactPathRule.admitValue("../outside").admitted).toBe(false);

    const artifact: ValueExpression = {
      kind: "artifact",
      path: literal("result.md"),
    };
    const artifactEvidence = resolveProducer(artifact, context);
    expect(artifactEvidence).toEqual({
      kind: "fact",
      fact: artifactPathRule.result,
    });
    expect(interpolationRule.checkProducer(artifact, context).kind).toBe(
      "compatible",
    );
    expect(
      interpolationRule.projectValue(
        artifactEvidence,
        createArtifactValue("result.md"),
      ),
    ).toEqual({ admitted: true, value: "result.md" });
    expect(
      interpolationRule.projectValue(
        resolveProducer(
          { kind: "arrayLiteral", elements: [literal(1)] },
          context,
        ),
        [Number.POSITIVE_INFINITY],
      ).admitted,
    ).toBe(false);
    expect(
      resolveProducer({ kind: "template-string", parts: [] }, context),
    ).toEqual({ kind: "fact", fact: interpolationRule.result });
  });

  it("rejects whole Artifact-array interpolation and preserves indexed Artifact projection", () => {
    const whole: ValueExpression = { kind: "cell", name: "artifacts" };
    const indexed: ValueExpression = {
      kind: "arrayElementRead",
      array: { kind: "cell", name: "artifacts" },
      index: { kind: "literal", value: 0 },
    };

    expect(interpolationRule.checkProducer(whole, context).kind).toBe(
      "incompatible",
    );
    expect(interpolationRule.checkProducer(indexed, context).kind).toBe(
      "compatible",
    );
    expect(
      interpolationRule.projectValue(
        resolveProducer(indexed, context),
        createArtifactValue("one.md"),
      ),
    ).toEqual({ admitted: true, value: "one.md" });
  });
});

describe("Union comparison rules", () => {
  const unionContext: ProducerContext = {
    cells: [
      {
        name: "hour",
        type: "union",
        members: [
          { type: "number" },
          { type: "enum", values: ["no_preference"] },
        ],
      },
      { name: "text", type: "string" },
      {
        name: "left",
        type: "union",
        members: [{ type: "number" }, { type: "boolean" }],
      },
      {
        name: "right",
        type: "union",
        members: [{ type: "string" }, { type: "boolean" }],
      },
      {
        name: "ordered",
        type: "union",
        members: [
          { type: "enum", values: ["low", "high"] },
          { type: "enum", values: ["high", "low"] },
        ],
      },
      {
        name: "reverse",
        type: "union",
        members: [
          { type: "enum", values: ["high", "low"] },
          { type: "number" },
        ],
      },
      {
        name: "shadowed",
        type: "union",
        members: [
          { type: "string" },
          { type: "enum", values: ["low", "high"] },
        ],
      },
    ],
  };
  const cell = (name: string): ValueExpression => ({ kind: "cell", name });

  it("union.comparison requires one declaration to cover both incompatible alternatives", () => {
    const member = comparisonRule.checkProducers(
      "!=",
      cell("hour"),
      literal("no_preference"),
      unionContext,
    );
    expect(member.judgment.kind).toBe("compatible");
    expect(
      comparisonRule.admitValues("!=", member, 9, "no_preference").admitted,
    ).toBe(true);
    const broad = comparisonRule.checkProducers(
      "!=",
      cell("hour"),
      cell("text"),
      unionContext,
    );
    expect(broad.judgment.kind).toBe("unknown");
    expect(
      comparisonRule.admitValues("!=", broad, 9, "no_preference").admitted,
    ).toBe(false);
    const unrelated = comparisonRule.checkProducers(
      "==",
      cell("left"),
      cell("right"),
      unionContext,
    );
    expect(unrelated.judgment.kind).toBe("unknown");
    expect(
      comparisonRule.admitValues("==", unrelated, 9, "text").admitted,
    ).toBe(false);
    expect(comparisonRule.admitValues("==", unrelated, 9, true).admitted).toBe(
      true,
    );
    expect(
      comparisonRule.checkProducers("!=", literal(1), literal(""), unionContext)
        .judgment.kind,
    ).toBe("incompatible");
  });

  it("union.comparison selects the first admitting Enum and excludes shadowed ordering authority", () => {
    const ordered = comparisonRule.checkProducers(
      "<",
      cell("ordered"),
      literal("high"),
      unionContext,
    );
    expect(ordered.judgment.kind).toBe("compatible");
    expect(
      comparisonRule.admitValues("<", ordered, "low", "high"),
    ).toMatchObject({
      admitted: true,
      value: { decision: { mode: "enum", enumValues: ["low", "high"] } },
    });
    const conflict = comparisonRule.checkProducers(
      "<",
      cell("ordered"),
      cell("reverse"),
      unionContext,
    );
    expect(conflict.judgment.kind).toBe("incompatible");
    expect(
      comparisonRule.admitValues("<", conflict, "low", "high").admitted,
    ).toBe(false);
    const shadowed = comparisonRule.checkProducers(
      "<",
      cell("shadowed"),
      cell("ordered"),
      unionContext,
    );
    expect(shadowed.judgment.kind).toBe("incompatible");
  });

  it("union.comparison rejects malformed concrete values before applying equality relaxation", () => {
    const selected = comparisonRule.checkProducers(
      "==",
      cell("hour"),
      literal("no_preference"),
      unionContext,
    );
    for (const value of [null, true, "outside", {}, [], undefined]) {
      expect(
        comparisonRule.admitValues("==", selected, value, "no_preference")
          .admitted,
      ).toBe(false);
    }
    expect(
      comparisonRule.admitValues("==", selected, Infinity, "no_preference"),
    ).toMatchObject({
      admitted: false,
      violation: { code: "non-finite-number" },
    });
  });

  it("union.comparison retains strict conditional evidence and refuses ambiguous Enum interpretation", () => {
    const conditional: ValueExpression = {
      kind: "conditional",
      test: literal(true),
      consequent: cell("ordered"),
      alternate: cell("reverse"),
    };
    const selected = comparisonRule.checkProducers(
      "<",
      conditional,
      literal("high"),
      unionContext,
    );
    expect(selected.judgment.kind).toBe("unknown");
    expect(
      comparisonRule.admitValues("<", selected, "low", "high"),
    ).toMatchObject({
      admitted: false,
      violation: { code: "invalid-comparison-operands" },
    });
    const invalid: ValueExpression = {
      kind: "conditional",
      test: literal(true),
      consequent: cell("hour"),
      alternate: literal(false),
    };
    expect(arithmeticRule.checkProducer(invalid, unionContext).kind).toBe(
      "incompatible",
    );
    expect(arithmeticRule.checkProducer(cell("hour"), unionContext).kind).toBe(
      "unknown",
    );
  });
});
