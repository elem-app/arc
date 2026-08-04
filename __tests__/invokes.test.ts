/**
 * Behavior tests for the Invokes area (`invoke.*` entries in specs/testing.md).
 *
 * `invoke(() => { ... })` is a first-class statement with an attached body SEG
 * run inline in the enclosing node: never memoized, its completion pinned per
 * walk, a fresh reach a fresh invocation. Every case feeds a deterministic Arc
 * source string and injects semantic results through reports, so there is no
 * nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { analyzeDocument, parse, validate } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type { InvokeAction } from "../src/types.js";
import { invokeSegKey, nodeSegKey } from "../src/types.js";
import {
  arc,
  EMPTY_DIALOG,
  node,
  progressBrief,
  rootTraversal,
  startRun,
  withExperimentalRewalk,
} from "./helpers.js";

function startInvoke(source: string, id: string, experimentalRewalk = false) {
  const document = experimentalRewalk
    ? withExperimentalRewalk(parse(source), "Main")
    : parse(source);
  const runtime = new Runtime().add(id, document);
  const seeded = runtime.newTraversal(arc(id, "Main"));
  seeded.phase = "entered";
  const brief = startRun(runtime, [seeded], EMPTY_DIALOG);
  return { runtime, brief };
}

describe("Invokes", () => {
  describe("invoke.rerun", () => {
    it("re-runs a completed invoke only after a later sibling resolves with a changed read-set", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let v = RangedInt(0, 100);
  let hit = Bool();
  v.$set(2);
  invoke(() => {
    hit.$set(v >= 5);
  });
  $observeOrAsk(v);
  if (hit == true) {
    $instruct(\`hit\`);
  } else {
    $instruct(\`miss\`);
  }
}
`,
        "invoke-rerun-arc",
        true,
      );

      // The invoke ran on the first walk: hit = (2 >= 5) = false. It stays
      // false while the sibling `$observeOrAsk(v)` is the open frontier (the
      // pinned completion skips it on the seek toward the sibling).
      expect(rootTraversal(brief).cells.hit).toBe(false);
      expect(brief.observations).toHaveLength(1);

      const bumped = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: 8 },
        },
      });

      // The sibling resolves with a changed read-set (v: 2 -> 8), so the body
      // re-walks — releasing the completion pin — and the invoke re-runs:
      // hit = (8 >= 5) = true. A permanently memoized invoke would leave hit
      // false.
      expect(rootTraversal(bumped).cells.hit).toBe(true);
      expect(bumped.instructions.map((item) => item.text)).toEqual(["hit"]);
    });

    it("a doubly-nested invoke constant write wins over a settled sibling set, in either order", () => {
      // Invoke before the settled `set(false)`: x resolves to true even though
      // `set(false)` is the textually last write. A settled `set` leaf is
      // skipped on re-walk; an invoke is never memoized and re-runs on every
      // re-walk. Main reads x in the `if`, so `set(false)` changes x and
      // re-walks Main's SEG from the root: the invoke re-runs and re-asserts
      // `x.$set(true)` while the settled `set(false)` is skipped. The write is
      // constant, so it reaches a fixpoint at x = true and the SEG converges.
      const invokeBeforeSet = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();

  invoke(() => {
    invoke(() => x.$set(true));
  });

  x.$set(false);

  if (x == true) {
    $instruct(\`x on\`);
  } else {
    $instruct(\`x off\`);
  }
}
`,
        "invoke-before-set-arc",
        true,
      ).brief;

      expect(rootTraversal(invokeBeforeSet).phase).toBe("entered");
      expect(rootTraversal(invokeBeforeSet).cells.x).toBe(true);
      expect(invokeBeforeSet.instructions.map((item) => item.text)).toEqual([
        "x on",
      ]);

      // Invoke after `set(false)`: same fixpoint, x = true, regardless of order.
      const invokeAfterSet = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();
  x.$set(false);

  invoke(() => {
    invoke(() => x.$set(true));
  });

  if (x == true) {
    $instruct(\`x on\`);
  } else {
    $instruct(\`x off\`);
  }
}
`,
        "invoke-after-set-arc",
        true,
      ).brief;

      expect(rootTraversal(invokeAfterSet).phase).toBe("entered");
      expect(rootTraversal(invokeAfterSet).cells.x).toBe(true);
      expect(invokeAfterSet.instructions.map((item) => item.text)).toEqual([
        "x on",
      ]);
    });

    it("lints unguarded invokes without rejecting valid source", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  invoke(() => $instruct(\`always\`));
  if (ready == true) {
    invoke(() => $instruct(\`guarded\`));
  }
}
`);
      expect(validate(document)).toEqual([]);

      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "unguarded-invoke",
      );
      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "unguarded-invoke",
          severity: "warning",
        }),
      ]);
    });

    it("does not warn on an unguarded invoke whose every effect is guarded", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  invoke(() => {
    if (ready == true) {
      $instruct(\`guarded\`);
    }
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "unguarded-invoke",
      );

      expect(lintIssues).toEqual([]);
    });
  });

  describe("invoke.continuation", () => {
    it("advances past an invoke whose write nothing reads", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(true);
  });
  $instruct(\`done\`);
}
`,
        "invoke-d3-arc",
      );

      expect(brief.instructions.map((item) => item.text)).toEqual(["done"]);
      expect(rootTraversal(brief).cells.x).toBe(true);
      expect(rootTraversal(brief).phase).not.toBe("poisoned");
    });

    it("a body write re-walks the enclosing SEG and re-fires an earlier branch", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let ready = Bool();
  if (ready == true) {
    $instruct(\`ready now\`);
  }
  invoke(() => {
    ready.$set(true);
  });
}
`,
        "invoke-d2-arc",
        true,
      );

      // The earlier branch is skipped on the first pass (ready unset); the
      // body write changes the read-set, so the enclosing SEG re-walks and the
      // branch — which sits *before* the invoke — now fires. It could only
      // fire via a re-walk.
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "ready now",
      ]);
      expect(rootTraversal(brief).cells.ready).toBe(true);
    });

    it("keeps an earlier branch decision while exposing an invoke write to later code", () => {
      const document = parse(`
"arc";

function Main() {
  let ready = Bool();
  if (ready == true) {
    $instruct(\`before write\`);
  }
  invoke(() => {
    ready.$set(true);
  });
  if (ready == true) {
    $instruct(\`after write\`);
  }
}
`);
      const runtime = new Runtime().add("invoke-write-advance-arc", document);
      const seeded = runtime.newTraversal(
        arc("invoke-write-advance-arc", "Main"),
      );
      seeded.phase = "entered";

      const brief = startRun(runtime, [seeded], EMPTY_DIALOG);

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "after write",
      ]);
      expect(rootTraversal(brief).cells.ready).toBe(true);
    });

    it("a genuine rewalk re-reaches the invoke as a fresh invocation", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let verdict = Bool();
  let mirror = Bool();
  invoke(() => {
    mirror.$set(verdict == true);
  });
  $enter(Child, { returns: { verdict } });
  if (mirror == true) {
    $instruct(\`mirrored\`);
  } else {
    $instruct(\`not yet\`);
  }

  function Child(returns = { verdict: Bool() }) {
    let topic = Bool();
    this.effects = () => {
      returns.verdict.$set(true);
    };
    $observeOrAsk(topic);
  }
}
`,
        "invoke-d1-arc",
        true,
      );

      // First walk: mirror = (undefined === true) = false, then $enter(Child) blocks.
      expect(brief.active).toEqual(node("invoke-d1-arc", "Main.Child"));
      expect(rootTraversal(brief).cells.mirror).toBe(false);

      const resolved = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // Child returns verdict=true; the caller read-set changed, so the body
      // re-walks and the invoke runs a fresh invocation whose cleared `$` slot
      // recomputes mirror (false -> true).
      expect(rootTraversal(resolved).cells.verdict).toBe(true);
      expect(rootTraversal(resolved).cells.mirror).toBe(true);
      expect(resolved.instructions.map((item) => item.text)).toEqual([
        "mirrored",
      ]);
    });
  });

  describe("invoke.convergence", () => {
    it("poisons a non-convergent invoke body instead of hanging", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let flag = Bool();
  invoke(() => {
    flag.$set(flag != true);
  });
  if (flag == true) {
    $instruct(\`on\`);
  } else {
    $instruct(\`off\`);
  }
}
`,
        "invoke-poison-arc",
        true,
      );

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "seg-rewalk-limit-exceeded",
          reason: expect.stringContaining("SEG re-walk did not converge"),
        }),
      ]);
    });

    it("does not poison an idempotent convergent invoke body", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(true);
  });
  if (x == true) {
    $instruct(\`stable\`);
  }
}
`,
        "invoke-convergent-arc",
      );

      expect(rootTraversal(brief).phase).not.toBe("poisoned");
      expect(brief.instructions.map((item) => item.text)).toEqual(["stable"]);
    });

    it("poisons when a nested invoke write inverts its own read", () => {
      // The nested invoke re-runs every re-walk, and its write reads x and
      // inverts it, so the value flips each pass and keeps re-walking until
      // the SEG re-walk limit poisons the traversal.
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();
  x.$set(false);

  invoke(() => {
    invoke(() => x.$set(x != true));
  });

  if (x == true) {
    $instruct(\`x on\`);
  } else {
    $instruct(\`x off\`);
  }
}
`,
        "invoke-nested-oscillate-arc",
        true,
      );

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "seg-rewalk-limit-exceeded",
          reason: expect.stringContaining("SEG re-walk did not converge"),
        }),
      ]);
    });

    it("lints unconditional set() calls inside invokes", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(true);
    if (x == true) {
      x.$set(false);
    }
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-unconditional-set"),
      ).toEqual([
        expect.objectContaining({
          code: "invoke-unconditional-set",
          severity: "notice",
        }),
      ]);
    });

    it("lints unguarded self-mutating set() calls inside invokes as errors", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(x != true);
    if (x == true) {
      x.$set(x != true);
    }
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-self-mutating-set"),
      ).toEqual([
        expect.objectContaining({
          code: "invoke-self-mutating-set",
          severity: "error",
        }),
      ]);
    });

    it("treats convergent self-referencing invoke writes as unconditional, not errors", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  let ready = Bool();
  invoke(() => {
    x.$set(x == true && ready == true);
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-self-mutating-set"),
      ).toEqual([]);
      expect(
        lintIssues.filter((issue) => issue.code === "invoke-unconditional-set"),
      ).toEqual([
        expect.objectContaining({
          code: "invoke-unconditional-set",
          severity: "notice",
        }),
      ]);
    });

    it("flags a guarded self-toggle whose convergence depends on another cell", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  let cond = Bool();
  invoke(() => {
    x.$set(x != true && cond == true);
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-self-mutating-set"),
      ).toEqual([
        expect.objectContaining({
          code: "invoke-self-mutating-set",
          severity: "error",
        }),
      ]);
    });

    it("flags non-boolean self-derived invoke writes that cannot settle", () => {
      const document = parse(`
"arc";

function Main() {
  let log = Str();
  let phase = Enum(["a", "b"]);
  invoke(() => {
    log.$set(\`\${log} step\`);
    phase.$set(phase == "a" ? "b" : "a");
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "invoke-self-mutating-set",
      );

      expect(lintIssues).toHaveLength(2);
      expect(lintIssues.every((issue) => issue.severity === "error")).toBe(
        true,
      );
    });

    it("spares an identity self-write on a non-boolean cell", () => {
      const document = parse(`
"arc";

function Main() {
  let phase = Enum(["a", "b"]);
  invoke(() => {
    phase.$set(phase);
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-self-mutating-set"),
      ).toEqual([]);
    });

    it("flags a negated-self invoke write authored with `!` as non-convergent", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(!x);
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "invoke-self-mutating-set"),
      ).toEqual([
        expect.objectContaining({
          code: "invoke-self-mutating-set",
          severity: "error",
        }),
      ]);
    });

    it("lints Bool cells set to both true and false in the same arc", () => {
      const document = parse(`
"arc";

function Main() {
  let wantsPricing = Bool();
  let wasEverDismissive = Bool();

  this.catchDeflection = () => {
    wantsPricing.$set(true);
    wasEverDismissive.$set(true);
    return true;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
    wantsPricing.$set(false);
  }

  function Pricing() {}
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "boolean-toggle-set",
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "boolean-toggle-set",
          severity: "notice",
        }),
      ]);
    });

    it("does not treat same-named Bool cells in sibling scopes as a toggle", () => {
      const document = parse(`
"arc";

function Main() {
  $enter(Opened);
  $enter(Closed);

  function Opened() {
    let flag = Bool();
    flag.$set(true);
  }

  function Closed() {
    let flag = Bool();
    flag.$set(false);
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "boolean-toggle-set",
      );

      expect(lintIssues).toEqual([]);
    });
  });

  describe("invoke.blocked-resume", () => {
    it("a report resumes the same blocked invocation without replaying earlier body leaves", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let a = Bool();
  let y = Bool();
  invoke(() => {
    a.$set(true);
    $observeOrAsk(y);
  });
  $instruct(\`after\`);
}
`,
        "invoke-d4-arc",
      );

      expect(brief.observations).toHaveLength(1);
      expect(rootTraversal(brief).cells.a).toBe(true);

      const resumed = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // The report resumes the suspended invocation at its blocked
      // `$observeOrAsk(y)`; the earlier `a.set` is not replayed and `y` is
      // not re-asked.
      expect(resumed.observations).toHaveLength(0);
      expect(resumed.instructions.map((item) => item.text)).toEqual(["after"]);
      expect(rootTraversal(resumed).cells.a).toBe(true);
      expect(rootTraversal(resumed).cells.y).toBe(true);
    });

    it("a later sibling's report resumes at the sibling without re-running the invoke", () => {
      // The later sibling is a `judge` blocker, whose resolution does not move
      // a value and so does not force a re-walk. The pinned completion keeps
      // the invoke skipped on the sibling's report seek, so `confirm` is not
      // re-asked.
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let draft = Bool();
  let confirm = Bool();
  invoke(() => {
    draft.$set(true);
    $observeOrAsk(confirm);
  });
  if (judge(\`should we proceed\`)) {
    $instruct(\`done\`);
  } else {
    $instruct(\`stopped\`);
  }
}
`,
        "invoke-d5-arc",
      );

      // First the invoke blocks asking `confirm`.
      expect(brief.observations).toHaveLength(1);

      const afterConfirm = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      // The invocation completed; the walk advanced to the later `judge` sibling.
      expect(afterConfirm.observations).toHaveLength(0);
      expect(afterConfirm.judgments).toHaveLength(1);
      expect(rootTraversal(afterConfirm).cells.confirm).toBe(true);

      const afterJudge = progressBrief(runtime, afterConfirm, {
        move: "proceed",
        judgments: { [afterConfirm.judgments[0]!.id]: true },
      });

      // The judge resolved at the sibling: the completed invoke is not re-run
      // and `confirm` is not re-asked.
      expect(afterJudge.observations).toHaveLength(0);
      expect(afterJudge.instructions.map((item) => item.text)).toEqual([
        "done",
      ]);
      expect(rootTraversal(afterJudge).cells.confirm).toBe(true);
    });

    it("resolves an expression-position blocker after the invoke and skips the invoke on that seek", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    x.$set(true);
  });
  if (judge(\`is it ready\`)) {
    $instruct(\`yes\`);
  } else {
    $instruct(\`no\`);
  }
}
`,
        "invoke-judge-arc",
      );

      expect(brief.judgments).toHaveLength(1);
      expect(rootTraversal(brief).cells.x).toBe(true);

      const resolved = progressBrief(runtime, brief, {
        move: "proceed",
        judgments: { [brief.judgments[0]!.id]: true },
      });

      expect(resolved.instructions.map((item) => item.text)).toEqual(["yes"]);
      expect(rootTraversal(resolved).cells.x).toBe(true);
    });
  });

  describe("invoke.dialect", () => {
    it("parses a block-bodied invoke into a first-class statement with body ids scoped under it", () => {
      const document = parse(`
"arc";

function Main() {
  let draft = Str();
  let confirm = Bool();
  invoke(() => {
    draft.$set(\`hi\`);
    $observeOrAsk(confirm);
  });
  $instruct(\`done\`);
}
`);
      const root = document.roots[0]!;
      const stmt = root.statements[0] as InvokeAction;
      expect(stmt).toMatchObject({
        kind: "invoke",
        body: [
          { kind: "set", target: ["draft"] },
          { kind: "observeOrAsk", target: ["confirm"] },
        ],
      });
      expect(stmt.id).toBe("body/0");
      // No anonymous child node exists: the body is attached to the statement.
      expect(root.children).toEqual([]);
      // Body ids live under the invoke's own scope; later siblings are
      // unaffected by edits inside the body.
      const bodyIds = stmt.body.map((entry) =>
        entry.kind === "set" || entry.kind === "observeOrAsk"
          ? entry.id
          : undefined,
      );
      expect(bodyIds).toEqual(["body/0/0", "body/0/1"]);
      const instruct = root.statements[1]!;
      if (instruct.kind !== "instruction") throw new Error("expected instruct");
      expect(instruct.id).toBe("body/1");
    });

    it("parses an expression-bodied invoke by wrapping the single statement", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  invoke(() => x.$set(true));
}
`);
      const root = document.roots[0]!;
      expect(root.statements[0]).toMatchObject({
        kind: "invoke",
        body: [{ kind: "set", target: ["x"] }],
      });
      expect(root.children).toEqual([]);
    });

    it("supports if branches, labels, and breaks scoped inside the body", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  let y = Bool();
  invoke(() => {
    block: {
      if (x == true) {
        y.$set(true);
        break block;
      }
      y.$set(false);
    }
  });
}
`);
      const stmt = document.roots[0]!.statements[0] as InvokeAction;
      expect(stmt.body[0]).toMatchObject({
        kind: "label",
        label: "block",
      });
    });

    it("admits enter, enterLoop, and instruct in the body", () => {
      const document = parse(`
"arc";

function Main() {
  let done = Bool();
  invoke(() => {
    $enter(Child);
    $enterLoop(Child, { resolveWhen: () => { return done == true; } });
    $instruct(\`hello\`);
  });
  function Child() {}
}
`);
      expect(validate(document)).toEqual([]);
      const stmt = document.roots[0]!.statements[0] as InvokeAction;
      expect(stmt.body.map((s) => s.kind)).toEqual([
        "enter-node",
        "enter-loop",
        "instruction",
      ]);
    });

    it("parses a nested invoke as an in-body statement", () => {
      const document = parse(`
"arc";

function Main() {
  let x = Bool();
  invoke(() => {
    invoke(() => {
      x.$set(true);
    });
  });
}
`);
      const outer = document.roots[0]!.statements[0] as InvokeAction;
      const inner = outer.body[0] as InvokeAction;
      expect(inner.kind).toBe("invoke");
      expect(inner.body).toMatchObject([{ kind: "set", target: ["x"] }]);
      expect(document.roots[0]!.children).toEqual([]);
    });

    it("lets a nested invoke enter an enclosing node target", () => {
      const document = parse(`
"arc";

function Main() {
  invoke(() => {
    invoke(() => {
      $enter(Child);
    });
  });
  function Child() {}
}
`);
      const issues = validate(document);
      expect(issues.filter((issue) => issue.code === "UNDEFINED_NODE")).toEqual(
        [],
      );
      expect(issues).toEqual([]);
    });

    it("lints canonical enterLoop targets whose nodes retain their frames", () => {
      const document = parse(`
"arc";

function Main() {
  $enterLoop(RetainedFrame, { resolveWhen: () => true });
  $enterLoop(newcopy(RetainedFrame), { resolveWhen: () => true });
  $enterLoop(forgetful(RetainedFrame), { resolveWhen: () => true });
  $enterLoop(ForgetfulEntry, { resolveWhen: () => true });

  function RetainedFrame() {}

  function ForgetfulEntry() {
    this.forgetfulEntry = true;
  }
}
`);
      const lintIssues = analyzeDocument(document).lintIssues.filter(
        (issue) => issue.code === "canonical-enter-loop-retained-frame",
      );

      expect(lintIssues).toEqual([
        expect.objectContaining({
          code: "canonical-enter-loop-retained-frame",
          severity: "warning",
        }),
      ]);
    });

    it("lints nested invokes without double-reporting the unguarded reach", () => {
      const document = parse(`
"arc";

function Main() {
  invoke(() => {
    invoke(() => $instruct(\`nested\`));
  });
}
`);
      const lintIssues = analyzeDocument(document).lintIssues;

      expect(
        lintIssues.filter((issue) => issue.code === "nested-invoke"),
      ).toEqual([
        expect.objectContaining({
          code: "nested-invoke",
          severity: "warning",
        }),
      ]);
      // The inner invoke is reported only as nested; the outer accounts for
      // the one unguarded-reach warning.
      expect(
        lintIssues.filter((issue) => issue.code === "unguarded-invoke"),
      ).toHaveLength(1);
    });

    it("evaluates if/else branches inside the invoke body", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let cond = Bool();
  let out = Bool();
  cond.$set(true);
  invoke(() => {
    if (cond == true) {
      out.$set(true);
    } else {
      out.$set(false);
    }
  });
  if (out == true) {
    $instruct(\`on\`);
  } else {
    $instruct(\`off\`);
  }
}
`,
        "invoke-if-arc",
      );

      expect(rootTraversal(brief).cells.out).toBe(true);
      expect(brief.instructions.map((item) => item.text)).toEqual(["on"]);
    });

    it("admits $enter(Child) in the body, resuming through the child", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  invoke(() => {
    $enter(Child);
  });
  $instruct(\`after\`);

  function Child() {
    let topic = Bool();
    $observeOrAsk(topic);
  }
}
`,
        "invoke-enter-arc",
      );

      // The body's $enter(Child) blocks at Child's observeOrAsk inside the
      // invocation.
      expect(brief.observations).toHaveLength(1);
      expect(brief.active).toEqual(node("invoke-enter-arc", "Main.Child"));

      const resumed = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // Child covers, the invocation completes, and the sibling instruct fires.
      expect(resumed.instructions.map((item) => item.text)).toEqual(["after"]);
    });

    it("admits enterLoop in the body", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let seen = Bool();
  invoke(() => {
    $enterLoop(Child, { resolveWhen: () => { return true; } });
  });
  $instruct(\`done\`);

  function Child() {
    seen.$set(true);
  }
}
`,
        "invoke-enterloop-arc",
      );

      // Child runs once (writing the parent's `seen`), resolveWhen is true so
      // the loop resolves, and the sibling instruct fires.
      expect(rootTraversal(brief).cells.seen).toBe(true);
      expect(brief.instructions.map((item) => item.text)).toEqual(["done"]);
    });
  });

  describe("invoke.rejections", () => {
    it.each([
      ["a plain IIFE", "(() => {})()", /use invoke/],
      ["an IIFE with call arguments", "(() => {})(1)", /use invoke/],
      ["an IIFE with parameters", "((a) => {})()", /use invoke/],
      ["a function-expression IIFE", "(function () {})()", /use invoke/],
    ])(
      "rejects %s as a parse error pointing at invoke",
      (_label, body, pattern) => {
        expect(() =>
          parse(`
"arc";

function Main() {
  ${body};
}
`),
        ).toThrow(pattern);
      },
    );

    it.each([
      ["no argument", "invoke()", /exactly one zero-arg arrow function/],
      [
        "extra arguments",
        "invoke(() => {}, 1)",
        /exactly one zero-arg arrow function/,
      ],
      [
        "a function expression",
        "invoke(function () {})",
        /must use a zero-arg arrow function/,
      ],
      ["parameters", "invoke((a) => {})", /cannot declare parameters/],
    ])("rejects invoke with %s", (_label, body, pattern) => {
      expect(() =>
        parse(`
"arc";

function Main() {
  ${body};
}
`),
      ).toThrow(pattern);
    });

    it.each([
      [
        "return",
        "invoke(() => { return; })",
        /`return` is not allowed in an Arc action graph/,
      ],
      [
        "cell declaration",
        "invoke(() => { let k = Bool(); })",
        /Cell declarations are only allowed directly in a node body/,
      ],
      [
        "this.guidance assignment",
        "invoke(() => { this.guidance = `x`; })",
        /Unsupported Arc assignment/,
      ],
      [
        "this.effects assignment",
        "invoke(() => { this.effects = () => {}; })",
        /Unsupported Arc assignment/,
      ],
      [
        "child node declaration",
        "invoke(() => { function Inner() {} })",
        /Child node declarations are only allowed directly in a node body/,
      ],
    ])("rejects %s in the body", (_label, body, pattern) => {
      expect(() =>
        parse(`
"arc";

function Main() {
  ${body};
}
`),
      ).toThrow(pattern);
    });

    it("rejects invoke as a cell name", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  let invoke = Bool();
}
`),
      ).toThrow(/reserved name and cannot name a cell/);
    });

    it("rejects invoke as a node name", () => {
      expect(() =>
        parse(`
"arc";

function Main() {
  $enter(invoke);

  function invoke() {}
}
`),
      ).toThrow(/reserved name and cannot name a node/);
    });
  });

  describe("invoke.scope", () => {
    it("records body reads in the invoke's local read-set and the enclosing node's", () => {
      const document = parse(`
"arc";

function Main() {
  let flag = Bool();
  let out = Bool();
  invoke(() => {
    if (flag == true) {
      out.$set(true);
    }
  });
}
`);
      const analysis = analyzeDocument(document);
      expect(analysis.issues).toEqual([]);
      const root = document.roots[0]!;
      const stmt = root.statements[0] as InvokeAction;
      const nodeSegs = analysis.rewalkPlan.bySeg.get(root);
      const rootReadSet = nodeSegs?.get(nodeSegKey("body"));
      const invokeReadSet = nodeSegs?.get(invokeSegKey(stmt.id));
      // The body re-runs whenever the enclosing SEG re-walks, so its reads are
      // live for the node — the node's set includes them — while the invoke's
      // own local set scopes brackets taken inside the body.
      expect(rootReadSet?.cells).toContain("flag");
      expect(invokeReadSet?.cells).toContain("flag");
    });

    it("lets a body write to a parent cell show in the parent after the invocation completes", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let shared = Bool();
  invoke(() => {
    shared.$set(true);
  });
  if (shared == true) {
    $instruct(\`shared on\`);
  } else {
    $instruct(\`shared off\`);
  }
}
`,
        "invoke-shared-write-arc",
      );

      expect(rootTraversal(brief).cells.shared).toBe(true);
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "shared on",
      ]);
    });

    it("lets a nested invoke write a parent cell", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let deep = Bool();
  invoke(() => {
    invoke(() => {
      deep.$set(true);
    });
  });
  if (deep == true) {
    $instruct(\`deep on\`);
  } else {
    $instruct(\`deep off\`);
  }
}
`,
        "invoke-nested-write-arc",
      );

      expect(rootTraversal(brief).cells.deep).toBe(true);
      expect(brief.instructions.map((item) => item.text)).toEqual(["deep on"]);
    });
  });

  describe("invoke.deflection", () => {
    it("runs a fresh invocation after a deflection through the body is caught", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let draft = Bool();
  let confirm = Bool();
  let caught = Bool();

  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };

  invoke(() => {
    draft.$set(caught == true);
    $observeOrAsk(confirm);
  });
  $instruct(\`done\`);
}
`,
        "invoke-deflect-arc",
      );

      // First run: caught is unset, so draft = (undefined === true) = false.
      expect(brief.observations).toHaveLength(1);
      expect(rootTraversal(brief).cells.draft).toBe(false);
      expect(brief.active).toEqual(node("invoke-deflect-arc", "Main"));

      const caughtBrief = progressBrief(runtime, brief, { move: "deflect" });

      // The frontier blocked inside the invoke body, so the deflect abandons
      // the open invocation and routes to Main's own catch, which sets
      // `caught` and catches. The post-catch re-walk runs a fresh invocation:
      // caught is now true, so draft recomputes to true. A resumed (reused)
      // invocation would have skipped the `draft.set` and left draft false.
      expect(rootTraversal(caughtBrief).cells.caught).toBe(true);
      expect(rootTraversal(caughtBrief).cells.draft).toBe(true);
      expect(caughtBrief.observations).toHaveLength(1);
    });

    it("a child that catches its own deflection leaves the invocation open", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let settled = Bool();
  invoke(() => {
    $enter(Child);
    $observeOrAsk(settled);
  });
  $instruct(\`after\`);

  function Child() {
    let topic = Bool();
    this.catchDeflection = () => {
      return true;
    };
    $observeOrAsk(topic);
  }
}
`,
        "invoke-child-catch-arc",
      );

      // The invocation blocks inside Child.
      expect(brief.active).toEqual(
        node("invoke-child-catch-arc", "Main.Child"),
      );

      const deflected = progressBrief(runtime, brief, { move: "deflect" });

      // Child catches its own deflection and re-walks itself: the invocation
      // stays open, still blocked inside Child — the invoke's body never
      // restarted.
      expect(deflected.active).toEqual(
        node("invoke-child-catch-arc", "Main.Child"),
      );
      expect(deflected.observations).toHaveLength(1);
      expect(deflected.observations[0]).toMatchObject({ cell: "topic" });
    });

    it("an uncaught child deflection abandons the invocation as it crosses into the body", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let attempts = RangedInt(0, 9);
  let caught = Bool();

  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };

  invoke(() => {
    $enter(Child);
  });
  $instruct(\`after\`);

  function Child() {
    let topic = Bool();
    $observeOrAsk(topic);
  }
}
`,
        "invoke-child-uncaught-arc",
      );

      expect(brief.active).toEqual(
        node("invoke-child-uncaught-arc", "Main.Child"),
      );

      const caughtBrief = progressBrief(runtime, brief, { move: "deflect" });

      // Child does not catch: the deflection crosses the enter into the body,
      // abandons the invocation, and Main's catch fires. The post-catch
      // re-walk runs a fresh invocation, which re-enters Child (its deflected
      // state resets on re-entry) and blocks at its observation again.
      expect(rootTraversal(caughtBrief).cells.caught).toBe(true);
      expect(caughtBrief.active).toEqual(
        node("invoke-child-uncaught-arc", "Main.Child"),
      );
      expect(caughtBrief.observations).toHaveLength(1);
    });
  });

  describe("invoke.refs", () => {
    it("surfaces the enclosing node ref as the sourceRef of an in-body instruct", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  invoke(() => {
    $instruct(\`inside\`);
  });
}
`,
        "invoke-instruct-arc",
      );

      expect(brief.instructions.map((item) => item.text)).toEqual(["inside"]);
      expect(brief.instructions[0]).toMatchObject({
        sourceRef: node("invoke-instruct-arc", "Main"),
      });
    });

    it("surfaces the enclosing node ref as active/sourceRef for an in-body observe", () => {
      const { brief } = startInvoke(
        `
"arc";

function Main() {
  let topic = Bool();
  invoke(() => {
    $observeOrAsk(topic);
  });
}
`,
        "invoke-observe-ref-arc",
      );

      const mainRef = node("invoke-observe-ref-arc", "Main");
      expect(brief.active).toEqual(mainRef);
      expect(brief.observations[0]).toMatchObject({ sourceRef: mainRef });
    });

    it("inherits the enclosing node deflectWhen for an in-body instruct, including nested", () => {
      const { runtime, brief } = startInvoke(
        `
"arc";

function Main() {
  let caught = Bool();

  this.deflectWhen = () => { return true; };

  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };

  invoke(() => {
    invoke(() => {
      $instruct(\`will deflect\`);
    });
  });
  $instruct(\`after catch\`);
}
`,
        "invoke-deflect-inherit-arc",
      );

      // The nested in-body instruct emits first; it inherits the enclosing
      // node's default deflection as a postcheck hook.
      expect(brief.instructions.map((item) => item.text)).toEqual([
        "will deflect",
      ]);

      const resumed = progressBrief(runtime, brief, { move: "proceed" });

      // On handback the inherited deflectWhen evaluates true, so the instruct
      // deflects the node from inside the body; Main's catch sets `caught`.
      expect(rootTraversal(resumed).cells.caught).toBe(true);
    });
  });

  describe("invoke.transitions", () => {
    it("never latches transitions for invoke runs", () => {
      const document = parse(`
"arc";

function Main() {
  let n = Bool();
  invoke(() => {
    n.$set(true);
  });
  $instruct(\`work\`);}
`);
      const runtime = new Runtime().add("transition-invoke-arc", document);
      const seeded = runtime.newTraversal(arc("transition-invoke-arc", "Main"));
      seeded.phase = "entered";

      const brief = runtime.start([seeded], EMPTY_DIALOG);
      expect(brief.transition).toBeUndefined();
      expect(brief.instructions.map((item) => item.text)).toEqual(["work"]);
    });
  });
});
