import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import {
  admitValue,
  judgeOneTimeLanding,
  reduceAlternativeJudgments,
  reusableSpecCompatible,
  type CoherenceJudgment,
} from "../src/spec/resolution.js";
import { validateSpec } from "../src/spec/validation.js";
import { fieldDeclarationAt } from "../src/types/ir.js";
import { fieldSpecAt, type StructSpec } from "../src/types/spec.js";
import { createArtifactValue } from "../src/types/value.js";

const kind = (judgment: CoherenceJudgment) => judgment.kind;

describe("spec judgments", () => {
  it("validates semantic invariants outside the TypeScript representation", () => {
    expect(validateSpec({ type: "enum", values: [] })?.code).toBe("empty-enum");
    expect(validateSpec({ type: "enum", values: ["a", "a"] })?.code).toBe(
      "duplicate-enum-value",
    );
    expect(validateSpec({ type: "enum", values: ["a", "b"] })).toBe(undefined);
    expect(validateSpec({ type: "array", element: { type: "artifact" } })).toBe(
      undefined,
    );
    expect(
      validateSpec({
        type: "array",
        element: { type: "array", element: { type: "artifact" } },
      })?.code,
    ).toBe("invalid-spec-shape");
  });

  it("admits concrete values under the full landing constraint", () => {
    expect(admitValue({ type: "number" }, Number.NaN).admitted).toBe(false);
    expect(admitValue({ type: "index" }, -1).admitted).toBe(false);
    expect(admitValue({ type: "index" }, 1).admitted).toBe(true);
    expect(admitValue({ type: "enum", values: ["a"] }, "b").admitted).toBe(
      false,
    );
    expect(
      admitValue({ type: "array", element: { type: "number" } }, [
        1,
        Number.POSITIVE_INFINITY,
      ]).admitted,
    ).toBe(false);
    expect(
      admitValue({ type: "artifact" }, createArtifactValue("result.md"))
        .admitted,
    ).toBe(true);
    expect(
      admitValue(
        { type: "artifact" },
        { path: "result.md", extra: "not-an-artifact-carrier" },
      ).admitted,
    ).toBe(false);
    expect(
      admitValue({ type: "dialogCursor" }, { user: 1, self: 2 }).admitted,
    ).toBe(true);
    expect(
      admitValue({ type: "dialogCursor" }, { user: -1, self: 2 }).admitted,
    ).toBe(false);

    const artifactArray = {
      type: "array",
      element: { type: "artifact" },
    } as const;
    const customPrototype = Object.create({ inherited: true }) as {
      path: string;
    };
    customPrototype.path = "one.md";
    const accessor = {} as { path: string };
    Object.defineProperty(accessor, "path", {
      enumerable: true,
      get: () => "one.md",
    });
    expect(
      admitValue(artifactArray, [
        createArtifactValue("one.md"),
        createArtifactValue("two.md"),
      ]).admitted,
    ).toBe(true);
    expect(admitValue(artifactArray, []).admitted).toBe(true);
    expect(admitValue(artifactArray, ["one.md"]).admitted).toBe(false);
    expect(
      admitValue(artifactArray, [{ path: "one.md", extra: true }]),
    ).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[0]" },
    });
    expect(
      admitValue(artifactArray, [createArtifactValue("one.md"), "two.md"]),
    ).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[1]" },
    });
    expect(
      admitValue(artifactArray, [[createArtifactValue("one.md")]]),
    ).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[0]" },
    });
    expect(admitValue(artifactArray, [customPrototype])).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[0]" },
    });
    expect(admitValue(artifactArray, [accessor])).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[0]" },
    });
    expect(admitValue(artifactArray, [{ path: "/absolute.md" }])).toMatchObject(
      {
        admitted: false,
        violation: { code: "invalid-artifact", path: "$[0]" },
      },
    );
  });

  it("distinguishes an unset value from null during concrete admission", () => {
    expect(admitValue({ type: "string" }, undefined)).toMatchObject({
      admitted: false,
      violation: { code: "unset", path: "$" },
    });
    expect(admitValue({ type: "string" }, null)).toMatchObject({
      admitted: false,
      violation: { code: "invalid-string", path: "$" },
    });
    expect(
      admitValue({ type: "array", element: { type: "artifact" } }, [undefined]),
    ).toMatchObject({
      admitted: false,
      violation: { code: "unset", path: "$[0]" },
    });
    expect(
      admitValue({ type: "array", element: { type: "artifact" } }, [null]),
    ).toMatchObject({
      admitted: false,
      violation: { code: "invalid-artifact", path: "$[0]" },
    });
  });

  it("judges site guarantees directionally", () => {
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "index" } },
          { type: "number" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          {
            kind: "array",
            elements: [
              { kind: "provenance", provenance: "artifact" },
              { kind: "provenance", provenance: "artifact" },
            ],
          },
          { type: "array", element: { type: "artifact" } },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          {
            kind: "array",
            elements: [
              { kind: "provenance", provenance: "artifact" },
              { kind: "literal", value: "wrong" },
            ],
          },
          { type: "array", element: { type: "artifact" } },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "number" } },
          { type: "index" },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "enum", values: ["a"] } },
          { type: "string" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "string" } },
          { type: "enum", values: ["a"] },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "enum", values: ["a", "b"] } },
          { type: "enum", values: ["b", "c"] },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "enum", values: ["a"] } },
          { type: "enum", values: ["b"] },
        ),
      ),
    ).toBe("incompatible");
  });

  it("judges exact literals, carrier facts, and intrinsic provenance", () => {
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "literal", value: "a" },
          { type: "enum", values: ["a"] },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "literal", value: "b" },
          { type: "enum", values: ["a"] },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "number" },
          { type: "number" },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "provenance", provenance: "artifact" },
          { type: "artifact" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "provenance", provenance: "artifact" },
          { type: "string" },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "boolean" },
          { type: "boolean" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "boolean" },
          { type: "string" },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "string" },
          { type: "string" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "string" },
          { type: "enum", values: ["a"] },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "number" },
          { type: "index" },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "carrier", carrier: "number" },
          { type: "boolean" },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "provenance", provenance: "index" },
          { type: "number" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "provenance", provenance: "dialog-cursor" },
          { type: "dialogCursor" },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "provenance", provenance: "dialog-cursor" },
          { type: "artifact" },
        ),
      ),
    ).toBe("incompatible");
    expect(kind(judgeOneTimeLanding(undefined, { type: "boolean" }))).toBe(
      "unknown",
    );
  });

  it("judges arrays recursively and empty arrays contextually", () => {
    expect(
      kind(
        judgeOneTimeLanding(
          {
            kind: "array",
            elements: [
              { kind: "literal", value: 1 },
              { kind: "literal", value: 2 },
            ],
          },
          { type: "array", element: { type: "number" } },
        ),
      ),
    ).toBe("compatible");
    expect(
      kind(
        judgeOneTimeLanding(
          {
            kind: "array",
            elements: [
              { kind: "literal", value: 1 },
              { kind: "literal", value: "wrong" },
            ],
          },
          { type: "array", element: { type: "number" } },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          {
            kind: "array",
            elements: [{ kind: "literal", value: 1 }],
          },
          { type: "string" },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(judgeOneTimeLanding({ kind: "empty-array" }, { type: "string" })),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "empty-array" },
          { type: "array", element: { type: "enum", values: ["a"] } },
        ),
      ),
    ).toBe("compatible");
  });

  it("reduces reachable conditional alternatives deterministically", () => {
    expect(
      kind(
        reduceAlternativeJudgments([
          { kind: "compatible" },
          { kind: "incompatible" },
        ]),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        reduceAlternativeJudgments([
          { kind: "compatible" },
          { kind: "unknown" },
        ]),
      ),
    ).toBe("unknown");
    expect(
      kind(
        reduceAlternativeJudgments([
          { kind: "compatible" },
          { kind: "compatible" },
        ]),
      ),
    ).toBe("compatible");
  });

  it("requires reusable providers to guarantee every receiver landing", () => {
    expect(reusableSpecCompatible({ type: "index" }, { type: "number" })).toBe(
      true,
    );
    expect(reusableSpecCompatible({ type: "number" }, { type: "index" })).toBe(
      false,
    );
    expect(
      reusableSpecCompatible(
        { type: "enum", values: ["a"] },
        { type: "enum", values: ["a", "b"] },
      ),
    ).toBe(true);
    expect(
      reusableSpecCompatible(
        { type: "string" },
        { type: "enum", values: ["a"] },
      ),
    ).toBe(false);
    expect(
      reusableSpecCompatible(
        { type: "enum", values: ["a"] },
        { type: "string" },
      ),
    ).toBe(true);
    expect(
      reusableSpecCompatible(
        { type: "array", element: { type: "enum", values: ["a"] } },
        { type: "array", element: { type: "string" } },
      ),
    ).toBe(true);
    expect(
      reusableSpecCompatible(
        { type: "array", element: { type: "string" } },
        { type: "array", element: { type: "enum", values: ["a"] } },
      ),
    ).toBe(false);
    expect(
      reusableSpecCompatible({ type: "artifact" }, { type: "artifact" }),
    ).toBe(true);
    expect(
      reusableSpecCompatible({ type: "artifact" }, { type: "dialogCursor" }),
    ).toBe(false);
    expect(
      reusableSpecCompatible(
        { type: "array", element: { type: "artifact" } },
        { type: "array", element: { type: "artifact" } },
      ),
    ).toBe(true);
    expect(
      reusableSpecCompatible(
        { type: "array", element: { type: "artifact" } },
        { type: "array", element: { type: "string" } },
      ),
    ).toBe(false);
    expect(
      reusableSpecCompatible(
        { type: "array", element: { type: "string" } },
        { type: "array", element: { type: "artifact" } },
      ),
    ).toBe(false);
  });

  it("struct.field-path resolves a nested field with the receiver's field family", () => {
    const spec: StructSpec = {
      type: "struct",
      fields: {
        inner: { type: "struct", fields: { x: { type: "string" } } },
      },
    };
    const leaf = fieldSpecAt(spec, ["inner", "x"]);
    expect(leaf).toEqual({ type: "string" });
    // The result is any field guarantee, so Struct members need narrowing.
    // @ts-expect-error -- `fields` exists only on the Struct member.
    expect(leaf?.fields).toBeUndefined();
    expect(fieldSpecAt(spec, ["inner", "missing"])).toBeUndefined();
    expect(fieldSpecAt(spec, ["inner", "x", "deeper"])).toBeUndefined();

    const cell = parse(`
"arc";
function Main() {
  let s = Struct({ inner: Struct({ x: Str({ observing: \`the x\` }) }) });
}
`).roots[0]!.cells[0]!;
    if (cell.type !== "struct") throw new Error("expected a Struct cell");
    expect(fieldDeclarationAt(cell, ["inner", "x"])).toMatchObject({
      type: "string",
      observing: expect.anything(),
    });
  });
});

describe("Union admission and compatibility", () => {
  const preference = {
    type: "union" as const,
    members: [
      { type: "number" as const },
      { type: "enum" as const, values: ["none"] },
    ],
  };

  it("union.spec reports the violation of the only member with the value's carrier type", () => {
    const violationCode = (value: unknown) => {
      const admission = admitValue(preference, value);
      return admission.admitted ? undefined : admission.violation.code;
    };
    expect(violationCode(Infinity)).toBe("non-finite-number");
    expect(violationCode("outside")).toBe("invalid-enum");
    expect(violationCode(true)).toBe("invalid-union");
  });

  it("union.spec admits one member while preserving finite dense and complete-container requirements", () => {
    expect(admitValue(preference, 9).admitted).toBe(true);
    expect(admitValue(preference, "none").admitted).toBe(true);
    for (const value of [
      true,
      null,
      undefined,
      Infinity,
      NaN,
      "outside",
      {},
      [],
    ])
      expect(admitValue(preference, value).admitted).toBe(false);
    const array = { type: "array" as const, element: preference };
    expect(admitValue(array, [9, "none"]).admitted).toBe(true);
    expect(admitValue(array, [9, , "none"]).admitted).toBe(false);
    const struct = { type: "struct" as const, fields: { hour: preference } };
    expect(admitValue(struct, { hour: "none" }).admitted).toBe(true);
    expect(admitValue(struct, {}).admitted).toBe(false);
    expect(admitValue(struct, { hour: 9, extra: false }).admitted).toBe(false);
  });

  it("union.spec distinguishes value-dependent landing from complete directional binding coverage", () => {
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: preference },
          { type: "number" },
        ),
      ),
    ).toBe("unknown");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: preference },
          { type: "boolean" },
        ),
      ),
    ).toBe("incompatible");
    expect(
      kind(
        judgeOneTimeLanding(
          { kind: "site", spec: { type: "number" } },
          preference,
        ),
      ),
    ).toBe("compatible");
    expect(reusableSpecCompatible(preference, { type: "number" })).toBe(false);
    expect(reusableSpecCompatible({ type: "number" }, preference)).toBe(true);
    const split = {
      type: "union" as const,
      members: [
        { type: "enum" as const, values: ["a"] },
        { type: "enum" as const, values: ["b"] },
      ],
    };
    expect(
      reusableSpecCompatible({ type: "enum", values: ["a", "b"] }, split),
    ).toBe(true);
    expect(reusableSpecCompatible({ type: "string" }, split)).toBe(false);
    const wrap = (element: typeof preference | { type: "number" }) => ({
      type: "struct" as const,
      fields: { hours: { type: "array" as const, element } },
    });
    expect(
      reusableSpecCompatible(wrap({ type: "number" }), wrap(preference)),
    ).toBe(true);
    expect(
      reusableSpecCompatible(wrap(preference), wrap({ type: "number" })),
    ).toBe(false);
    expect(
      kind(
        reduceAlternativeJudgments([
          { kind: "unknown" },
          { kind: "incompatible" },
        ]),
      ),
    ).toBe("incompatible");
  });
});
