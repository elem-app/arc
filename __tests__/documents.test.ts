/**
 * Behavior tests for the Documents area (`doc.*` entries in specs/testing.md).
 *
 * Ported from `parser.test.ts`. Every case feeds a deterministic Arc source
 * string, so there is no nondeterminism and no flakiness mitigation is needed.
 */
import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";

describe("documents", () => {
  describe("doc.directive", () => {
    it("requires the Arc directive", () => {
      expect(() =>
        parse(`
"arc v2";

function Main() {}
`),
      ).toThrow(/Expected "arc" directive/);
    });
  });

  describe("doc.multi-arcs", () => {
    it("parses multiple arcs in one document", () => {
      const source = `
"arc";

function First() {
  $instruct(\`one\`);}

function Second() {
  this.displayName = "Second Root";
  $instruct(\`two\`);}
`;

      const document = parse(source);

      expect(document.roots.map((root) => root.identifier)).toEqual([
        "First",
        "Second",
      ]);
      expect(document.roots[1]?.displayName).toBe("Second Root");
    });

    it("rejects a document-level cell declaration instead of discarding it", () => {
      expect(() =>
        parse(`
"arc";

let ready = Bool();

function Main() {}
`),
      ).toThrow(
        "Document-level cell declarations are not allowed; declare cells directly in a root node body",
      );
    });

    it("rejects other statements at document level", () => {
      expect(() =>
        parse(`
"arc";

$instruct(\`outside a node\`);

function Main() {}
`),
      ).toThrow(
        "Only imports and root node declarations are allowed at document level",
      );
    });
  });

  describe("doc.arc-imports", () => {
    it("parses aliased named imports and set() from cell references", () => {
      const document = parse(`
"arc";
import { AnotherArc as IntroArc } from "another-arc";

function Main() {
  let ready = Bool();
  let copy = Bool();
  copy.$set(ready);
  $enter(IntroArc);
}
`);

      expect(document.imports).toEqual([
        expect.objectContaining({
          source: "another-arc",
          importedName: "AnotherArc",
          localName: "IntroArc",
        }),
      ]);
      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "set",
        target: ["copy"],
        value: { kind: "cell", name: "ready" },
      });
      expect(document.roots[0]?.statements[1]).toMatchObject({
        kind: "enter-node",
        target: { identifier: "IntroArc", imported: true, mode: "canonical" },
      });
    });

    it("rejects default imports", () => {
      const source = `
"arc";
import Advanced from "advanced";
function Bad() {
  $instruct(\`hi\`);}
`;

      expect(() => parse(source)).toThrow(/does not support default imports/);
    });

    it("uses direct root node declarations and rejects export syntax", () => {
      const document = parse(`
"arc";
function Helper() {
  $instruct(\`helper\`);}
`);

      expect(document.roots.map((root) => root.identifier)).toEqual(["Helper"]);

      expect(() =>
        parse(`
"arc";
export { Helper };
function Helper() {
  $instruct(\`helper\`);}
`),
      ).toThrow(/Export syntax is not supported/);
    });
  });

  describe("doc.host-imports", () => {
    it("rejects host import aliases that collide with Arc built-in roots and namespaces", () => {
      const reserved = [
        "$enter",
        "$enterLoop",
        "$instruct",
        "$instructLoop",
        "$observe",
        "$observeOrAsk",
        "Array",
        "Artifact",
        "Bool",
        "Dialog",
        "Enum",
        "Index",
        "Num",
        "RangedInt",
        "State",
        "Str",
        "args",
        "forgetful",
        "invoke",
        "judge",
        "newcopy",
        "returns",
        "self",
        "span",
        "user",
      ];
      for (const alias of reserved) {
        expect(() =>
          parse(`
"arc";
import ${alias} from "host:test";
function Main() {}
`),
        ).toThrow(
          new RegExp(
            `Host module alias .*${alias.replace("$", "\\$")}.*reserved`,
          ),
        );
      }

      expect(() =>
        parse(`
"arc";
import Files from "host:files";
function Main() {
  let path = Str();
  path.$set(Files.path());
  this.effects = () => Files.$save(path);
}
`),
      ).not.toThrow();

      const publicDocument = parse(`
"arc";
import Files from "host:files";
function Main() {
  let path = Str();
  path.$set(Files.path());
}
`);
      publicDocument.hostModules[0]!.localName = "Artifact";
      const set = publicDocument.roots[0]!.statements[0]!;
      if (set.kind !== "set") throw new Error("expected set statement");
      set.value = { kind: "template-string", parts: {} } as never;
      expect(validate(publicDocument)).toEqual([
        expect.objectContaining({ code: "RESERVED_HOST_MODULE_ALIAS" }),
      ]);
    });

    it("requires host module imports to be default imports", () => {
      expect(() =>
        parse(`
"arc";
import { Memoir } from "host:memoir";
function Bad() {
  this.effects = () => {
    Memoir.facts.$apply(\`effect\`);
  };
}
`),
      ).toThrow(/host module imports must use a default import/);
    });

    it("requires standalone host calls to be declared by host module import", () => {
      expect(() =>
        parse(`
"arc";
function Bad() {
  this.effects = () => {
    Memoir.facts.$apply(\`effect\`);
  };
}
`),
      ).toThrow(/declared host module/);
    });
  });

  describe("doc.comments", () => {
    it("ignores line and block comments across Arc source", () => {
      const document = parse(`
// leading line comment
/* leading block comment */
"arc";

// root comment
function Main() {
  let ready = Bool(); // trailing comment

  /* action comment */ $enter(Child, {
    // option comment
    args: { ready },
  });

  function Child(args = { ready: Bool() }) {
    this.effects = () => {
      // branch comment
      if (args.ready == true) {
        ready.$set(true);
      }
    };
  }
}
`);

      expect(document.roots[0]?.identifier).toBe("Main");
      expect(document.roots[0]?.statements[0]).toMatchObject({
        kind: "enter-node",
        args: { ready: { kind: "cell", cell: "ready" } },
      });
    });
  });
});
