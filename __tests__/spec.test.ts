import { describe, expect, it } from "vitest";

import {
  admitValue,
  judgeOneTimeLanding,
  reduceAlternativeJudgments,
  reusableSpecCompatible,
  type CoherenceJudgment,
} from "../src/spec/resolution.js";
import { validateSpec } from "../src/spec/validation.js";
import { createArtifactValue } from "../src/value-utils.js";

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
});
