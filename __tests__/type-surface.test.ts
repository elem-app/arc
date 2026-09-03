import { describe, expect, it } from "vitest";

import { parse, type DocumentAnalysis } from "../src/parser/index.js";
import { Runtime, type ActionBrief } from "../src/runtime/index.js";
import type {
  CellSpec,
  Dialog,
  HostCallExpression,
  RuntimeIssue,
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
    const hostCall = undefined as HostCallExpression | undefined;
    const brief = undefined as ActionBrief | undefined;
    const issue = undefined as RuntimeIssue | undefined;

    expect(document.roots[0]!.identifier).toBe("Main");
    expect(analysis.issues).toEqual([]);
    expect(spec.type).toBe("number");
    expect(dialog.cursor).toEqual({ user: 0, self: 0 });
    expect(hostCall).toBeUndefined();
    expect(brief).toBeUndefined();
    expect(issue).toBeUndefined();
    expect(new Runtime()).toBeInstanceOf(Runtime);
  });
});
