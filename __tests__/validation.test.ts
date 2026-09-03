import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import {
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import type {
  Document,
  ElementId,
  Node,
  WriteDiffMode,
} from "../src/types/index.js";
import { EMPTY_DIALOG, startRun } from "./helpers.js";

function cloneDocument(document: Document): Document {
  return cloneValue(document);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function root(document: Document) {
  const entry = document.roots[0];
  if (!entry) throw new Error("Expected root");
  return entry;
}

function codes(document: Document): string[] {
  return validate(document).map((issue) => issue.code);
}

describe("validation", () => {
  describe("doc.validation", () => {
    it("validates finalization-only expressions in public Document IR", () => {
      const document = parse(`
"arc";

function Main() {
  let matched = Bool();

  function Child() {}

  this.catchDeflection = () => this.deflection.escaped(Child);
  this.effects = () => {
    if (this.pendingState == State.DEFLECTED) {
      matched.$set(this.deflection.escaped(Child));
    }
  };
}
`);

      expect(validate(document)).toEqual([]);

      const pendingOutsideEffects = cloneDocument(document);
      root(pendingOutsideEffects).catchDeflection = [
        {
          id: "catch/0" as ElementId,
          kind: "return",
          value: { kind: "pendingState" },
        },
      ];
      expect(codes(pendingOutsideEffects)).toContain(
        "PENDING_STATE_OUTSIDE_EFFECTS",
      );

      const escapedOutsideFinalization = cloneDocument(document);
      root(escapedOutsideFinalization).statements = [
        {
          id: "body/0" as ElementId,
          kind: "if",
          test: {
            kind: "deflectionEscaped",
            target: {
              identifier: "Child",
              imported: false,
              mode: "canonical",
            },
          },
          consequent: [],
        },
      ];
      expect(codes(escapedOutsideFinalization)).toContain(
        "DEFLECTION_ESCAPED_OUTSIDE_FINALIZATION",
      );

      const nonCanonicalEscaped = cloneDocument(document);
      root(nonCanonicalEscaped).effects = [
        {
          id: "effects/0" as ElementId,
          kind: "if",
          test: {
            kind: "deflectionEscaped",
            target: {
              identifier: "Child",
              imported: false,
              mode: "newcopy",
            },
          },
          consequent: [],
        },
      ];
      expect(codes(nonCanonicalEscaped)).toContain("INVALID_DEFLECTION_TARGET");
    });

    it("validates hand-crafted enter target binding invariants", () => {
      const document = parse(`
"arc";

function Main() {
  function Child() {}
}
`);

      const selfEntry = cloneDocument(document);
      root(selfEntry).statements = [
        {
          id: "body/0" as ElementId,
          kind: "enter-node",
          target: { identifier: "Main", imported: false, mode: "canonical" },
        },
      ];
      expect(codes(selfEntry)).toContain("SELF_ENTRY");

      const importMismatch = cloneDocument(document);
      root(importMismatch).statements = [
        {
          id: "body/0" as ElementId,
          kind: "enter-node",
          target: { identifier: "Child", imported: true, mode: "canonical" },
        },
      ];
      expect(codes(importMismatch)).toContain("TARGET_IMPORT_MISMATCH");
    });

    it("validates duplicate public IR bindings and node import visibility", () => {
      const document = parse(`
"arc";

import { Other } from "./other.arc";

function Main() {
  function Child() {}
}
`);
      const invalid = cloneDocument(document);
      const importBinding = invalid.imports[0];
      const child = root(invalid).children[0];
      if (!importBinding || !child) {
        throw new Error("Expected import and child");
      }

      invalid.imports.push({ ...importBinding });
      invalid.roots.push(cloneValue(root(document)));
      root(invalid).children.push(cloneValue(child));
      root(invalid).imports.push("MissingImport");

      expect(codes(invalid)).toEqual(
        expect.arrayContaining([
          "DUPLICATE_IMPORT",
          "DUPLICATE_ARC",
          "DUPLICATE_NODE",
          "UNKNOWN_IMPORT",
        ]),
      );
    });

    it("propagates expression parser context through regex targets", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let seen = Bool();

  function Child() {}

  this.catchDeflection = () => this.deflection.escaped(Child);
  this.effects = () => {
    seen.$set(/deflected/.test(this.pendingState));
  };
}
`),
      ).not.toThrow();
    });

    it("validates node writeDiffMode in public Document IR", () => {
      const document = parse(`
"arc";

function Main() {
  function Child() {}
}
`);

      expect(validate(document)).toEqual([]);

      const misspelled = cloneDocument(document);
      root(misspelled).writeDiffMode = "rewalks" as WriteDiffMode;
      expect(codes(misspelled)).toContain("INVALID_WRITE_DIFF_MODE");

      const missing = cloneDocument(document);
      delete (root(missing) as Partial<Node>).writeDiffMode;
      expect(codes(missing)).toContain("INVALID_WRITE_DIFF_MODE");

      // Children are validated too, not just roots.
      const child = cloneDocument(document);
      const target = root(child).children[0];
      if (!target) throw new Error("Expected child");
      target.writeDiffMode = undefined as unknown as WriteDiffMode;
      expect(codes(child)).toContain("INVALID_WRITE_DIFF_MODE");

      // The experimental override stays valid: this guards the shape, not the mode.
      const experimental = cloneDocument(document);
      root(experimental).writeDiffMode = "rewalk";
      expect(validate(experimental)).toEqual([]);
    });
  });

  describe("proto.registration", () => {
    it("rejects invalid public documents atomically", () => {
      const valid = parse(`
"arc";

function Main() {
  function Child() {}
}
`);
      const invalid = cloneDocument(valid);
      root(invalid).statements = [
        {
          id: "body/0" as ElementId,
          kind: "enter-node",
          target: { identifier: "Main", imported: false, mode: "canonical" },
        },
        {
          id: "body/1" as ElementId,
          kind: "set",
          target: ["missing"],
          value: { kind: "literal", value: true },
        },
      ];

      const runtime = new Runtime();

      let thrown: unknown;
      try {
        runtime.add("invalid-doc-arc", invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RuntimeRegistrationError);
      const registration = thrown as RuntimeRegistrationError;
      expect(registration.operation).toBe("add");
      expect(registration.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "document",
            source: "invalid-doc-arc",
            code: "SELF_ENTRY",
          }),
          expect.objectContaining({
            phase: "document",
            source: "invalid-doc-arc",
            code: "UNKNOWN_CELL",
          }),
        ]),
      );
      expect(registration.message).toMatch(/SELF_ENTRY/);
      expect(registration.message).toMatch(/UNKNOWN_CELL/);
      expect(runtime.has(toArcRef("invalid-doc-arc", "Main"))).toBe(false);

      runtime.add("invalid-doc-arc", valid);

      expect(runtime.has(toArcRef("invalid-doc-arc", "Main"))).toBe(true);
    });

    it("snapshots documents at registration", () => {
      const document = parse(`
"arc";

function Main() {
  $instruct(\`original\`);
}
`);
      const runtime = new Runtime().add("snapshot-doc-arc", document).init();
      const statement = root(document).statements[0];
      if (!statement || statement.kind !== "instruction") {
        throw new Error("Expected instruction");
      }
      statement.template = { kind: "literal", value: "mutated" };

      const traversal = runtime.newTraversal(
        toArcRef("snapshot-doc-arc", "Main"),
      );
      traversal.phase = "entered";
      const brief = startRun(runtime, [traversal], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual(["original"]);
    });
  });
});
