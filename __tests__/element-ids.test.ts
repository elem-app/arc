/**
 * Element-id system: structural, SEG-scoped ids stamped from document shape.
 *
 * Covers id stability across SEG scopes and if-branches, stamper canonicality
 * (idempotence, verify-without-mutate, hand-built IR through `Runtime.add`),
 * inherited-deflectWhen owner qualification, and anonymous-copy refs
 * embedding `/`-bearing element ids.
 */
import { describe, expect, it } from "vitest";

import { parse, stampElementIds, validate } from "../src/parser/index.js";
import { Runtime, toNodeRefParts } from "../src/runtime/index.js";
import type { Document, ElementId, Statement } from "../src/types.js";
import {
  EMPTY_DIALOG,
  arc,
  ephemeralChild,
  progressBrief,
  rootTraversal,
  startRun,
} from "./helpers.js";

function bodyIds(document: Document): (ElementId | undefined)[] {
  const ids: (ElementId | undefined)[] = [];
  const visit = (statement: Statement): void => {
    ids.push(statement.id);
    if (statement.kind === "if") {
      statement.consequent.forEach(visit);
      statement.alternate?.forEach(visit);
    }
    if (statement.kind === "label") statement.body.forEach(visit);
    if (statement.kind === "invoke") statement.body.forEach(visit);
  };
  document.roots[0]!.statements.forEach(visit);
  return ids;
}

function stripIds(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripIds);
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string" && "id" in record) record.id = "";
    for (const entry of Object.values(record)) stripIds(entry);
  }
}

describe("Element ids", () => {
  describe("elemid.stability", () => {
    it("editing one SEG leaves every other SEG's ids unchanged", () => {
      const base = parse(`
"arc";

function Main() {
  let ready = Bool();
  $observe(ready);
  if (ready == true) {
    $instruct(\`go\`);
  }
}
`);
      const withEffects = parse(`
"arc";

function Main() {
  let ready = Bool();
  this.effects = () => {
    ready.$set(false);
  };
  $observe(ready);
  if (ready == true) {
    $instruct(\`go\`);
  }
}
`);
      expect(bodyIds(withEffects)).toEqual(bodyIds(base));
      expect(bodyIds(base)).toEqual(["body/0", "body/1", "body/1c/0"]);
    });

    it("editing one if-branch leaves the other branch's ids unchanged", () => {
      const alternateIds = (document: Document): (ElementId | undefined)[] => {
        const branch = document.roots[0]!.statements[1];
        if (branch?.kind !== "if") throw new Error("expected if");
        return branch.alternate?.map((statement) => statement.id) ?? [];
      };
      const base = parse(`
"arc";

function Main() {
  let ready = Bool();
  $observe(ready);
  if (ready == true) {
    $instruct(\`go\`);
  } else {
    $instruct(\`hold\`);
    $instruct(\`wait\`);
  }
}
`);
      const grownConsequent = parse(`
"arc";

function Main() {
  let ready = Bool();
  $observe(ready);
  if (ready == true) {
    $instruct(\`first\`);
    $instruct(\`go\`);
  } else {
    $instruct(\`hold\`);
    $instruct(\`wait\`);
  }
}
`);
      expect(alternateIds(grownConsequent)).toEqual(alternateIds(base));
      expect(alternateIds(base)).toEqual(["body/1a/0", "body/1a/1"]);
    });
  });

  describe("elemid.stamper", () => {
    it("stamping is idempotent", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  this.deflectWhen = \`\${user} wants to stop\`;
  $observe(ready);
  if (judge(\`ready to go\`)) {
    $instruct(\`go\`);
  }
}
`);
      const before = JSON.parse(JSON.stringify(document)) as Document;
      for (const root of document.roots) stampElementIds(root);
      expect(document).toEqual(before);
    });

    it("validate reports non-canonical ids without mutating its input", () => {
      const document = JSON.parse(
        JSON.stringify(
          parse(`
"arc";

function Main() {
  let ready = Bool();
  $observe(ready);
}
`),
        ),
      ) as Document;
      stripIds(document);

      const issues = validate(document);
      expect(issues.map((issue) => issue.code)).toContain("ELEMENT_ID");
      // Verification never repairs: the input keeps its unstamped ids.
      expect(document.roots[0]!.statements[0]!.id).toBe("");
    });

    it("Runtime.add stamps its clone, registering unstamped hand-built IR with owner-qualified inherited-hook briefs", () => {
      const document = JSON.parse(
        JSON.stringify(
          parse(`
"arc";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  $instruct(\`one\`);
  $instruct(\`two\`);
}
`),
        ),
      ) as Document;
      // The JSON round-trip severed the shared inherited-hook aliasing;
      // stripping ids leaves each instruction a private unstamped copy.
      stripIds(document);

      const runtime = new Runtime().add("elemid-handbuilt-arc", document);
      const seeded = runtime.newTraversal(arc("elemid-handbuilt-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      // The caller's document was not stamped.
      expect(document.roots[0]!.statements[0]!.id).toBe("");
      // Inherited copies stamped under the static `deflectWhen/` scope, and
      // brief identity qualified per owning instruction.
      expect(brief.judgments.map((item) => item.id)).toEqual([
        "judge:[arc:elemid-handbuilt-arc:Main]:[node:elemid-handbuilt-arc:Main]:body/0/deflectWhen/0~0",
        "judge:[arc:elemid-handbuilt-arc:Main]:[node:elemid-handbuilt-arc:Main]:body/1/deflectWhen/0~0",
      ]);
    });
  });

  describe("elemid.copy-ref", () => {
    it("anonymous-copy refs round-trip element ids nested under if and invoke", () => {
      const document = parse(`
"arc";

function Main() {
  let go = Bool();
  invoke(() => {
    if (go != false) {
      $enter(newcopy(Child));
    }
  });

  function Child() {
    $instruct(\`inside copy\`);
  }
}
`);
      expect(document.roots[0]!.newcopyAliases).toEqual([
        {
          identifier: "Child#body/0/0c/0",
          target: "Child",
          imported: false,
        },
      ]);

      const runtime = new Runtime().add("elemid-copy-arc", document);
      const seeded = runtime.newTraversal(arc("elemid-copy-arc", "Main"));
      seeded.phase = "entered";
      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "inside copy",
      ]);
      const child = ephemeralChild(
        rootTraversal(brief),
        "Main.Child#body/0/0c/0",
      );
      expect(child).toBeDefined();
      // The `/`-bearing segment survives the ref encoding round-trip.
      expect(toNodeRefParts(child!.ref).path).toEqual([
        "Main",
        "Child#body/0/0c/0",
      ]);

      const done = progressBrief(runtime, brief, { move: "proceed" });
      expect(rootTraversal(done).state).toBe("covered");
    });

    it("validate() reports a corrupted derived newcopy alias", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(newcopy(Child));

  function Child() {
    $instruct(\`inside copy\`);
  }
}
`);
      // Freshly parsed aliases are canonical, so validation flags no id issue.
      expect(
        validate(document).some((issue) => issue.code === "ELEMENT_ID"),
      ).toBe(false);

      // Corrupt the derived alias id. `validate` verifies statement/expression
      // ids and must verify the stamper's derived aliases too, rather than
      // leaving the gap for `Runtime.add`'s private restamp to paper over.
      document.roots[0]!.newcopyAliases[0]!.identifier = "Child#body/wrong";
      expect(
        validate(document).some((issue) => issue.code === "ELEMENT_ID"),
      ).toBe(true);
    });
  });
});
