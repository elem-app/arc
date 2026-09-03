import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import { cellValuesEqual } from "../src/runtime/state.js";
import type { ArtifactValue, PayloadValue } from "../src/types/index.js";
import { classifyArtifactPath, isArtifactValue } from "../src/types/value.js";
import {
  clonePayloadValue,
  createArtifactValue,
  mergeAndClonePayload,
} from "../src/value-utils.js";

describe("Artifact values", () => {
  it("artifact.value.factory creates a JSON-stable value without factory provenance", () => {
    const created = createArtifactValue("incoming/source.md");
    const restored = JSON.parse(JSON.stringify(created)) as unknown;
    const forged = { path: "incoming/forged.md" };
    const nullPrototype = Object.assign(Object.create(null), {
      path: "incoming/null-prototype.md",
    });

    expect(created).toEqual({ path: "incoming/source.md" });
    expect(isArtifactValue(created)).toBe(true);
    expect(isArtifactValue(restored)).toBe(true);
    expect(isArtifactValue(forged)).toBe(true);
    expect(isArtifactValue(nullPrototype)).toBe(true);
    expect(
      cellValuesEqual(created, createArtifactValue("incoming/source.md")),
    ).toBe(true);
    expect(
      cellValuesEqual(created, createArtifactValue("incoming/other.md")),
    ).toBe(false);
  });

  it("artifact.value.guard rejects every malformed Artifact shape without throwing", () => {
    const accessor = Object.defineProperties(
      {},
      {
        path: { enumerable: true, get: () => "accessor.md" },
      },
    );
    const symbol = Symbol("extra");
    const nonEnumerable = Object.defineProperties(
      {},
      {
        path: { enumerable: false, value: "hidden.md" },
      },
    );
    const malformed: unknown[] = [
      null,
      [],
      new (class ArtifactLike {
        path = "class.md";
      })(),
      {},
      { path: "ok.md", extra: true },
      { path: "ok.md", [symbol]: true },
      { path: 1 },
      { path: "/absolute.md" },
      accessor,
      nonEnumerable,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("trap");
          },
        },
      ),
    ];

    for (const value of malformed) {
      expect(() => isArtifactValue(value)).not.toThrow();
      expect(isArtifactValue(value)).toBe(false);
    }
  });

  it("artifact.path.classifier reports stable categories and the factory uses a coded error", () => {
    const invalidCases = [
      [undefined, "non-string"],
      ["", "empty"],
      ["/root.md", "absolute"],
      ["a/./b", "dot-segment"],
      ["a/../b", "dot-segment"],
    ] as const;

    for (const [path, issue] of invalidCases) {
      expect(classifyArtifactPath(path)).toBe(issue);
      expect(isArtifactValue({ path })).toBe(false);
      try {
        createArtifactValue(path as string);
        throw new Error("expected createArtifactValue to reject");
      } catch (error) {
        expect(error).toMatchObject({ reasonCode: "invalid-artifact-path" });
      }
      if (typeof path === "string") {
        expect(() =>
          parse(
            `"arc"; function Main() { let item = Artifact(${JSON.stringify(path)}); }`,
          ),
        ).toThrow(/Artifact item path/);
      }
    }

    expect(classifyArtifactPath("valid/path.md")).toBeUndefined();
    expect(isArtifactValue(createArtifactValue("valid/path.md"))).toBe(true);
    expect(() =>
      parse(`"arc"; function Main() { let item = Artifact("valid/path.md"); }`),
    ).not.toThrow();
  });

  it("artifact.payload clones Artifact values and structural semantic parts as ordinary structs", () => {
    const artifact = createArtifactValue("nested/value.md");
    const input: PayloadValue = {
      nested: [artifact],
      semanticPart: { kind: "artifact", path: "semantic.md" },
    };
    const cloned = clonePayloadValue(input) as {
      nested: ArtifactValue[];
      semanticPart: { kind: string; path: string };
    };

    (artifact as { path: string }).path = "mutated.md";
    expect(cloned.nested[0]).toEqual(createArtifactValue("nested/value.md"));
    expect(cloned.semanticPart).toEqual({
      kind: "artifact",
      path: "semantic.md",
    });
    expect(isArtifactValue(cloned.nested[0])).toBe(true);
    expect(isArtifactValue(cloned.semanticPart)).toBe(false);
  });

  it("artifact.payload admits dollar-prefixed struct keys and rejects non-durable shapes", () => {
    const sparse = new Array(1);
    const accessorArray = Object.defineProperty([], "0", {
      enumerable: true,
      get: () => "value",
    });
    Object.defineProperty(accessorArray, "length", { value: 1 });
    const extraArray = Object.assign(["value"], { extra: true });
    class PayloadArray extends Array<string> {}
    for (const value of [
      null,
      { nested: undefined },
      [undefined],
      sparse,
      new PayloadArray("value"),
      accessorArray,
      extraArray,
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("trap");
          },
        },
      ),
    ]) {
      expect(() => clonePayloadValue(value as unknown as PayloadValue)).toThrow(
        /Invalid payload value/,
      );
    }

    expect(clonePayloadValue({ $private: true })).toEqual({ $private: true });
    expect(
      parse(`
"arc";
function Main() {
  this.hostParams = { $arcNominalType: "ordinary" };
}
`).roots[0]?.hostParams,
    ).toEqual({ $arcNominalType: "ordinary" });

    const document = parse(`"arc"; function Main() {}`);
    document.roots[0]!.hostParams = {
      nested: undefined,
    } as unknown as PayloadValue;
    expect(validate(document)).toContainEqual(
      expect.objectContaining({ code: "INVALID_PAYLOAD_VALUE" }),
    );
  });

  it("artifact.payload rejects malformed values before Runtime.add cloning", () => {
    const symbol = Symbol("extra");
    const malformed = [
      { path: "valid.md", [symbol]: true },
      Object.defineProperty({ path: "valid.md" }, "extra", { value: true }),
      Object.defineProperties(
        {},
        {
          path: { enumerable: true, get: () => "valid.md" },
        },
      ),
      Object.defineProperty({}, "$private", { value: true }),
    ];

    for (const [index, value] of malformed.entries()) {
      const document = parse(`"arc"; function Main() {}`);
      document.roots[0]!.hostParams = value as unknown as PayloadValue;
      expect(() =>
        new Runtime().add(`malformed-${index}`, document).init(),
      ).toThrow(/INVALID_PAYLOAD_VALUE/);
    }
  });

  it("artifact.payload merge treats an Artifact shape as an ordinary struct", () => {
    const artifact = createArtifactValue("chosen.md");
    expect(mergeAndClonePayload({ keep: true }, artifact)).toEqual({
      keep: true,
      path: "chosen.md",
    });
    expect(mergeAndClonePayload(artifact, { replace: true })).toEqual({
      path: "chosen.md",
      replace: true,
    });
    expect(mergeAndClonePayload(artifact, undefined)).toEqual(artifact);
  });

  it("artifact.payload merge validates both operands before classifying structs", () => {
    const malformed = { nested: undefined } as unknown as PayloadValue;

    expect(() => mergeAndClonePayload(malformed, { ordinary: true })).toThrow(
      /Invalid payload value/,
    );
    expect(() => mergeAndClonePayload({ ordinary: true }, malformed)).toThrow(
      /Invalid payload value/,
    );
    expect(() => mergeAndClonePayload(malformed, "replacement")).toThrow(
      /Invalid payload value/,
    );
  });
});
