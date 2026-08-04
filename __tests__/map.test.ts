/**
 * Behavior tests for the Map and Span area (`map.*` entries in specs/testing.md).
 *
 * `arr.$map(callback, results?)` is a `$` resolved-once action: it reads one
 * pinned input array, runs its callback once per element under member-qualified
 * instance identity, and (when `results` is bound) commits one constructed
 * output array in a single write when it resolves. Each case feeds a
 * deterministic Arc source string, so there is no nondeterminism.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../src/parser/index.js";
import { Runtime } from "../src/runtime/index.js";
import type { ArcTraversalSet } from "../src/types.js";
import {
  appliedHostEffects,
  arc,
  EMPTY_DIALOG,
  ownedChild,
  progressBrief,
  rootTraversal,
  startRun,
  withExperimentalRewalk,
} from "./helpers.js";

function run(source: string, id: string, experimentalRewalk = false) {
  const document = experimentalRewalk
    ? withExperimentalRewalk(parse(source), "Main")
    : parse(source);
  const runtime = new Runtime().add(id, document);
  const seeded = runtime.newTraversal(arc(id, "Main"));
  seeded.phase = "entered";
  return { runtime, brief: startRun(runtime, [seeded], EMPTY_DIALOG) };
}

describe("Map and Span", () => {
  describe("map.value-transform", () => {
    it("commits the callback output array to results in input order", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b", "c"]);
  nums.$map(() => {
    span.result.$set(span.item);
  }, out);
}
`,
        "map-value-transform-arc",
      );

      expect(rootTraversal(brief).cells.out).toEqual(["a", "b", "c"]);
    });

    it("binds span.index and builds one ordered output per member", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(RangedInt(0, 9));
  nums.$set(["a", "b", "c"]);
  nums.$map(() => span.result.$set(span.index), out);
}
`,
        "map-span-index-arc",
      );

      // Each member ran once, in order: an output shorter or longer than the
      // input, or out of order, would fail this exact list.
      expect(rootTraversal(brief).cells.out).toEqual([0, 1, 2]);
    });

    it("accepts a concise expression-bodied callback", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b"]);
  nums.$map(() => span.result.$set(span.item), out);
}
`,
        "map-expr-body-arc",
      );

      expect(rootTraversal(brief).cells.out).toEqual(["a", "b"]);
    });

    it("replaces the receiver in one write when results is the receiver", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let xs = Array(RangedInt(0, 9));
  xs.$set([5, 6]);
  xs.$map(() => span.result.$set(span.index), xs);
}
`,
        "map-same-cell-arc",
      );

      // Evaluation read the pinned old list ([5, 6]); resolve replaced it with
      // the per-index outputs in one write.
      expect(rootTraversal(brief).cells.xs).toEqual([0, 1]);
    });

    it("retains the last reachable span.result write in a member", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b"]);
  nums.$map(() => {
    span.result.$set("first");
    span.result.$set("second");
  }, out);
}
`,
        "map-last-write-arc",
      );

      expect(rootTraversal(brief).cells.out).toEqual(["second", "second"]);
    });

    it("poisons when a member sets no span.result while results is bound", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let seen = Bool();
  nums.$set(["a"]);
  nums.$map(() => {
    seen.$set(true);
  }, out);
}
`,
        "map-missing-result-arc",
      );

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "map-missing-result",
        }),
      ]);
    });

    it("poisons when a kind-compatible member output violates the results element bounds", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(RangedInt(0, 2));
  nums.$set(["a", "b", "c", "d"]);
  nums.$map(() => span.result.$set(span.index), out);
}
`,
        "map-range-fail-arc",
      );

      // span.index is number-kind (passes the static check) but index 3 is out
      // of the results bounds, so the single commit poisons at runtime.
      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "cell-out-of-range",
        }),
      ]);
    });
  });

  describe("map.for-each", () => {
    it("runs members for effects and writes no output array when results is omitted", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let seen = Bool();
  nums.$set(["a", "b"]);
  nums.$map(() => {
    seen.$set(true);
  });
}
`,
        "map-for-each-arc",
      );

      expect(rootTraversal(brief).cells.seen).toBe(true);
    });

    it("runs the callback for every member, once each", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  nums.$set(["a", "b", "c"]);
  nums.$map(() => {
    $instruct(\`member \${span.index}\`);
  });
  $instruct(\`done\`);
}
`,
        "map-for-each-per-member-arc",
      );

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "member 0",
        "member 1",
        "member 2",
        "done",
      ]);
      const done = progressBrief(runtime, brief, { move: "proceed" });

      // The one batch has exactly one callback instruction for each index before
      // the tail, and handback emits none again. A skipped or repeated member
      // changes the host-visible sequence.
      expect(done.instructions).toEqual([]);
    });
  });

  describe("map.empty-input", () => {
    it("resolves with an empty output array over an empty input", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set([]);
  nums.$map(() => {
    span.result.$set(span.item);
  }, out);
}
`,
        "map-empty-input-arc",
      );

      expect(rootTraversal(brief).cells.out).toEqual([]);
    });
  });

  describe("map.continuation", () => {
    it("re-walks the containing graph and re-fires an earlier branch when the results commit changes its read-set", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b"]);
  if (out.isUnset() == false) {
    $instruct(\`filled\`);
  }
  nums.$map(() => span.result.$set(span.item), out);
}
`,
        "map-boundary-rewalk-arc",
        true,
      );

      // The branch sits before the $map and is skipped on the first pass (out is
      // unset). The results commit changes out, which the branch reads, so the
      // $map boundary re-walks the containing graph and the branch fires — it
      // could only fire via that boundary re-walk.
      expect(brief.instructions.map((item) => item.text)).toEqual(["filled"]);
    });

    it("advances without a containing re-walk when the map output changes nothing the graph reads", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b"]);
  nums.$map(() => span.result.$set(span.item), out);
  $instruct(\`done\`);
}
`,
        "map-boundary-advance-arc",
      );

      // Nothing reads out, so the boundary advances rather than re-walking; the
      // trailing instruction is reached exactly once and the walk converges.
      expect(brief.instructions.map((item) => item.text)).toEqual(["done"]);
      expect(rootTraversal(brief).cells.out).toEqual(["a", "b"]);
      expect(rootTraversal(brief).phase).not.toBe("poisoned");
    });

    it("skips a completed map while seeking a later frontier", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  nums.$set(["a"]);
  nums.$map(() => {
    $instruct(\`member ran\`);
  });
  if (judge(\`continue\`)) {
    $instruct(\`done\`);
  }
}
`,
        "map-completion-pin-arc",
      );

      expect(brief.instructions.map((item) => item.text)).toEqual([
        "member ran",
      ]);
      const later = progressBrief(runtime, brief, { move: "proceed" });
      expect(later.instructions).toEqual([]);
      expect(later.judgments).toHaveLength(1);

      const done = progressBrief(runtime, later, {
        move: "proceed",
        judgments: { [later.judgments[0]!.id]: true },
      });

      // Seeking the later judgment must replay the map's completion pin. If the
      // callback reran, "member ran" would reappear instead of the tail.
      expect(done.instructions.map((item) => item.text)).toEqual(["done"]);
    });

    it("re-reads the receiver when a containing re-walk releases the completion pin", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let grow = Bool();
  nums.$set(["a"]);
  nums.$map(() => span.result.$set(span.item), out);
  $observeOrAsk(grow);
  if (grow == true) {
    nums.$set(["a", "b"]);
  }
}
`,
        "map-rewalk-reread-arc",
        true,
      );

      // The first walk maps the one-element receiver before the later
      // observation becomes the open frontier.
      expect(rootTraversal(brief).cells.out).toEqual(["a"]);
      expect(brief.observations).toHaveLength(1);

      const grown = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // The branch grew the receiver, re-walking the graph; the pin releases and
      // the map re-reads nums, producing the longer output.
      expect(rootTraversal(grown).cells.out).toEqual(["a", "b"]);
    });

    it("re-walks a member locally on an in-callback read/write dependency and converges", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let flag = Bool();
  nums.$set(["x", "y"]);
  nums.$map(() => {
    if (flag == true) {
      span.result.$set("X");
    } else {
      span.result.$set("O");
    }
    flag.$set(span.item == "x");
  }, out);
}
`,
        "map-member-local-rewalk-arc",
        true,
      );

      // Member 0 first takes the else branch, then `flag.$set(true)` re-walks the
      // member so the if branch's "X" wins; member 1 settles on "O". Without a
      // member-local re-walk, member 0 would keep the stale "O".
      expect(rootTraversal(brief).cells.out).toEqual(["X", "O"]);
    });

    it("poisons a non-convergent member", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let toggle = Bool();
  nums.$set(["a"]);
  nums.$map(() => {
    toggle.$set(toggle != true);
  });
}
`,
        "map-nonconvergent-arc",
        true,
      );

      expect(rootTraversal(brief).phase).toBe("poisoned");
      expect(brief.issues).toEqual([
        expect.objectContaining({
          kind: "poisoned-traversal",
          reasonCode: "seg-rewalk-limit-exceeded",
        }),
      ]);
    });
  });

  describe("map.enter-callback", () => {
    it("binds span.item into a child arg and span.result from a child return sink", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["a", "b"]);
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`,
        "map-enter-callback-arc",
      );

      expect(rootTraversal(brief).cells.out).toEqual(["a", "b"]);
    });

    it("captures span.index by value into an Index() child argument", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(RangedInt(0, 9));
  nums.$set(["a", "b", "c"]);
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { idx: span.index },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { idx: Index() }, returns = { output: RangedInt(0, 9) }) {
    this.effects = () => {
      returns.output.$set(args.idx);
    };
  }
}
`,
        "map-enter-index-arc",
      );

      // span.index crossed the enter boundary as the child's Index() arg and was
      // returned per member.
      expect(rootTraversal(brief).cells.out).toEqual([0, 1, 2]);
    });

    it("resumes a member through a briefing child and commits its return into span.result", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["x"]);
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    let answer = Str();
    $observeOrAsk(answer);
    this.effects = () => {
      returns.output.$set(answer);
    };
  }
}
`,
        "map-enter-callback-blocks-arc",
      );

      // The member's child briefed on its own observation.
      expect(brief.observations).toHaveLength(1);
      const resumed = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "deep" },
        },
      });

      expect(rootTraversal(resumed).cells.out).toEqual(["deep"]);
    });
  });

  describe("map.member-blocks", () => {
    it("suspends a briefing member and resumes it into the same member on report", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let label = Str();
  nums.$set(["x"]);
  nums.$map(() => {
    $observeOrAsk(label);
    span.result.$set(label);
  }, out);
}
`,
        "map-member-blocks-arc",
      );

      // Member 0 briefed on `label` and the action is still pending.
      expect(brief.observations).toHaveLength(1);
      expect(rootTraversal(brief).cells.out).toBeUndefined();

      const resumed = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "done" },
        },
      });

      expect(rootTraversal(resumed).cells.out).toEqual(["done"]);
    });

    it("resumes each member on its own brief across a multi-element input", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let label = Str();
  nums.$set(["x", "y"]);
  nums.$map(() => {
    $observeOrAsk(label);
    span.result.$set(label);
  }, out);
}
`,
        "map-member-blocks-multi-arc",
      );

      // Member 0 is the open frontier; member 1 has not run yet.
      expect(brief.observations).toHaveLength(1);
      const afterFirst = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });

      // Member 0 terminalized and member 1 is now the open frontier.
      expect(afterFirst.observations).toHaveLength(1);
      const afterSecond = progressBrief(runtime, afterFirst, {
        move: "proceed",
        observations: {
          [afterFirst.observations[0]!.id]: { status: "resolved", value: "b" },
        },
      });

      expect(rootTraversal(afterSecond).cells.out).toEqual(["a", "b"]);
    });

    it("qualifies member brief sites so two members carry distinct brief ids", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let label = Str();
  nums.$set(["x", "y"]);
  nums.$map(() => {
    $observeOrAsk(label);
    span.result.$set(label);
  }, out);
}
`,
        "map-member-brief-ids-arc",
      );

      const firstId = brief.observations[0]!.id;
      const afterFirst = progressBrief(runtime, brief, {
        move: "proceed",
        observations: { [firstId]: { status: "resolved", value: "a" } },
      });
      const secondId = afterFirst.observations[0]!.id;

      // The same authored observation, run in two members, must brief under
      // member-qualified ids — otherwise member 1's report could not be told
      // apart from member 0's.
      expect(secondId).not.toBe(firstId);
    });

    it("keeps a span.result staged before a block through report resume", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let gate = Bool();
  nums.$set(["kept"]);
  nums.$map(() => {
    span.result.$set(span.item);
    $observeOrAsk(gate);
  }, out);
}
`,
        "map-staged-survives-arc",
      );

      expect(brief.observations).toHaveLength(1);
      const done = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // `span.result` was staged before the block; resume terminalizes the
      // member from that staged value rather than losing it.
      expect(rootTraversal(done).cells.out).toEqual(["kept"]);
    });
  });

  describe("map.json-restart", () => {
    it("resumes a blocked member across a JSON round-trip with earlier terminals intact", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let label = Str();
  nums.$set(["p", "q"]);
  nums.$map(() => {
    $observeOrAsk(label);
    span.result.$set(label);
  }, out);
}
`,
        "map-json-restart-arc",
      );

      // Resolve member 0; member 1 becomes the open frontier.
      const afterFirst = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "P" },
        },
      });
      expect(afterFirst.observations).toHaveLength(1);

      // Persist the blocked arena as JSON, revive it, and resume from scratch.
      const revived = JSON.parse(
        JSON.stringify(afterFirst.traversals),
      ) as ArcTraversalSet;
      const revivedBrief = runtime.start(revived, EMPTY_DIALOG);
      expect(revivedBrief.observations).toHaveLength(1);

      const done = progressBrief(runtime, revivedBrief, {
        move: "proceed",
        observations: {
          [revivedBrief.observations[0]!.id]: {
            status: "resolved",
            value: "Q",
          },
        },
      });

      // Member 0's terminal ("P") survived the round-trip and joined member 1.
      expect(rootTraversal(done).cells.out).toEqual(["P", "Q"]);
    });

    it("round-trips span-backed enter links while a member's child is blocked", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["x"]);
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    let answer = Str();
    $observeOrAsk(answer);
    this.effects = () => {
      returns.output.$set(answer);
    };
  }
}
`,
        "map-json-restart-enter-arc",
      );

      expect(brief.observations).toHaveLength(1);

      const revived = JSON.parse(
        JSON.stringify(brief.traversals),
      ) as ArcTraversalSet;
      const revivedBrief = runtime.start(revived, EMPTY_DIALOG);
      expect(revivedBrief.observations).toHaveLength(1);

      const done = progressBrief(runtime, revivedBrief, {
        move: "proceed",
        observations: {
          [revivedBrief.observations[0]!.id]: {
            status: "resolved",
            value: "deep",
          },
        },
      });

      expect(rootTraversal(done).cells.out).toEqual(["deep"]);
    });

    it("preserves a span.result staged before a block across a JSON round-trip", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let gate = Bool();
  nums.$set(["kept"]);
  nums.$map(() => {
    span.result.$set(span.item);
    $observeOrAsk(gate);
  }, out);
}
`,
        "map-json-staged-arc",
      );

      expect(brief.observations).toHaveLength(1);
      const revived = JSON.parse(
        JSON.stringify(brief.traversals),
      ) as ArcTraversalSet;
      const revivedBrief = runtime.start(revived, EMPTY_DIALOG);
      const done = progressBrief(runtime, revivedBrief, {
        move: "proceed",
        observations: {
          [revivedBrief.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });

      // The staged output survived serialization in the arena, not just in
      // memory.
      expect(rootTraversal(done).cells.out).toEqual(["kept"]);
    });
  });

  describe("map.re-entry", () => {
    it("re-reads an args-channel receiver on a forgetful re-entry of the mapping node", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let again = Bool();
  nums.$set(["a"]);
  $enter(Worker, { args: { items: nums } });
  $observeOrAsk(again);
  if (again == true) {
    nums.$set(["a", "b"]);
    $enter(forgetful(Worker), { args: { items: nums } });
  }
  function Worker(args = { items: Array(Str()) }) {
    let out = Array(Str());
    args.items.$map(() => span.result.$set(span.item), out);
  }
}
`,
        "map-forgetful-reentry-arc",
      );

      // First entry mapped the one-element channel.
      expect(
        ownedChild(rootTraversal(brief), "Main.Worker")?.cells.out,
      ).toEqual(["a"]);

      const reentered = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // The forgetful re-entry cleared the frame, so the $map re-read the grown
      // channel rather than reusing the first entry's completion.
      expect(
        ownedChild(rootTraversal(reentered), "Main.Worker")?.cells.out,
      ).toEqual(["a", "b"]);
    });
  });

  describe("map.rejections", () => {
    const mapSource = (callbackAndResults: string) => `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let inner = Array(Str());
  nums.$set(["a"]);
  ${callbackAndResults}
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`;

    it("rejects a nested $map", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { inner.$map(() => span.result.$set(span.item), out); }, out);`,
          ),
        ),
      ).toThrow(/MAP_NESTED/);
    });

    it("rejects a cell declaration in a $map callback", () => {
      expect(() =>
        parse(mapSource(`nums.$map(() => { let local = Bool(); });`)),
      ).toThrow("Cell declarations are only allowed directly in a node body");
    });

    it("rejects a non-newcopy enter target in the callback", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $enter(Op, { args: { input: span.item }, returns: { output: span.result } }); }, out);`,
          ),
        ),
      ).toThrow(/MAP_ENTER_NOT_NEWCOPY/);
    });

    it("rejects a non-newcopy enter target nested inside a callback invoke", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { invoke(() => { $enter(Op, { args: { input: span.item }, returns: { output: span.result } }); }); }, out);`,
          ),
        ),
      ).toThrow(/MAP_ENTER_NOT_NEWCOPY/);
    });

    it("rejects a write to the receiver inside the callback", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { nums.$set(["z"]); span.result.$set(span.item); }, out);`,
          ),
        ),
      ).toThrow(/MAP_RECEIVER_WRITE/);
    });

    it("rejects an element write to the receiver inside the callback", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { nums[span.index].$set(span.item); span.result.$set(span.item); }, out);`,
          ),
        ),
      ).toThrow(/MAP_RECEIVER_WRITE/);
    });

    it("rejects span.result in a forEach $map", () => {
      expect(() =>
        parse(mapSource(`nums.$map(() => { span.result.$set(span.item); });`)),
      ).toThrow(/MAP_SPAN_RESULT_NO_RESULTS/);
    });

    it("rejects span.result bound as an args source", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $enter(newcopy(Op), { args: { input: span.result }, returns: { output: span.result } }); }, out);`,
          ),
        ),
      ).toThrow(/span\.result.*args source/);
    });

    it("rejects span.item bound as a returns sink", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $enter(newcopy(Op), { args: { input: span.item }, returns: { output: span.item } }); }, out);`,
          ),
        ),
      ).toThrow(/span\.item.*returns sink/);
    });

    it("rejects an $unset of the receiver inside the callback", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { nums.$unset(); span.result.$set(span.item); }, out);`,
          ),
        ),
      ).toThrow(/MAP_RECEIVER_WRITE/);
    });

    it("rejects an observation of the receiver inside the callback", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $observe(nums); span.result.$set(span.item); }, out);`,
          ),
        ),
      ).toThrow(/MAP_RECEIVER_WRITE/);
    });

    it("rejects a callback enter that sinks a return into the receiver", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $enter(newcopy(Op), { args: { input: span.item }, returns: { output: nums } }); }, out);`,
          ),
        ),
      ).toThrow(/MAP_RECEIVER_WRITE/);
    });

    it("rejects a forEach callback that binds span.result as a return sink", () => {
      expect(() =>
        parse(
          mapSource(
            `nums.$map(() => { $enter(newcopy(Op), { args: { input: span.item }, returns: { output: span.result } }); });`,
          ),
        ),
      ).toThrow(/MAP_SPAN_RESULT_NO_RESULTS/);
    });

    it("rejects a span.item read outside a $map callback", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let x = Str();
  x.$set(span.item);
}
`,
        ),
      ).toThrow(/SPAN_OUTSIDE_MAP/);
    });

    it("rejects a span.result write outside a $map callback", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  span.result.$set("x");
}
`,
        ),
      ).toThrow(/SPAN_OUTSIDE_MAP/);
    });

    it("rejects a span binding in an $enter outside a $map callback", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  $enter(newcopy(Op), { args: { input: span.item } });
  function Op(args = { input: Str() }) {}
}
`,
        ),
      ).toThrow(/SPAN_OUTSIDE_MAP/);
    });
  });

  describe("map.span-types", () => {
    it("rejects assigning span.item to a cell of an incompatible kind", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(Str());
  let n = RangedInt(0, 9);
  arr.$set(["a"]);
  arr.$map(() => { n.$set(span.item); span.result.$set(span.item); }, out);
}
`,
        ),
      ).toThrow(/SPAN_TYPE/);
    });

    it("checks span.item against a decorated target's element type", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(Str());
  let nums = Array(RangedInt(0, 9));
  arr.$set(["a"]);
  nums.$set([0]);
  arr.$map(() => {
    nums[0].$set(span.item);
    span.result.$set(span.item);
  }, out);
}
`,
        ),
      ).toThrow(/SPAN_TYPE/);
    });

    it("rejects a span.result write whose value kind mismatches the results element", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(RangedInt(0, 5));
  arr.$set(["a"]);
  arr.$map(() => span.result.$set(span.item), out);
}
`,
        ),
      ).toThrow(/SPAN_TYPE/);
    });

    it("rejects a span.result write of a literal of the wrong kind", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(Str());
  arr.$set(["a"]);
  arr.$map(() => span.result.$set(0), out);
}
`,
        ),
      ).toThrow(/SPAN_TYPE/);
    });

    it("rejects binding span.item into a child arg of an incompatible type", () => {
      expect(() =>
        parse(
          `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(Str());
  arr.$set(["a"]);
  arr.$map(
    () => {
      $enter(newcopy(Op), {
        args: { n: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { n: RangedInt(0, 9) }, returns = { output: Str() }) {
    this.effects = () => {
      returns.output.$set("x");
    };
  }
}
`,
        ),
      ).toThrow(/incompatible/i);
    });

    it("accepts a kind-compatible span.index into a RangedInt results", () => {
      const { brief } = run(
        `
"arc";
function Main() {
  let arr = Array(Str());
  let out = Array(RangedInt(0, 9));
  arr.$set(["a", "b"]);
  arr.$map(() => span.result.$set(span.index), out);
}
`,
        "map-span-index-ranged-arc",
      );

      // span.index (Index) is number-kind, so it writes a RangedInt results cell
      // without a static complaint.
      expect(rootTraversal(brief).cells.out).toEqual([0, 1]);
    });
  });

  describe("map.deflection-caught", () => {
    it("clears the arena when a member deflects and the node catch re-reaches a virgin map", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let topic = Bool();
  let caught = Bool();
  nums.$set(["x"]);
  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };
  nums.$map(() => {
    $observeOrAsk(topic);
  });
}
`,
        "map-deflect-caught-arc",
      );

      expect(brief.observations).toHaveLength(1);

      const caughtBrief = progressBrief(runtime, brief, { move: "deflect" });

      // The member deflection crossed the $map and cleared the arena; Main's
      // catch fired and the post-catch re-walk re-reached a virgin map, which
      // re-ran the member and blocked at its observation again.
      expect(rootTraversal(caughtBrief).cells.caught).toBe(true);
      expect(caughtBrief.observations).toHaveLength(1);
    });
  });

  describe("map.deflection-uncaught", () => {
    it("deflects the node with no commit when a member deflection is not caught", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let topic = Str();
  nums.$set(["x"]);
  nums.$map(() => {
    $observeOrAsk(topic);
    span.result.$set(topic);
  }, out);
}
`,
        "map-deflect-uncaught-arc",
      );

      expect(brief.observations).toHaveLength(1);

      const deflected = progressBrief(runtime, brief, { move: "deflect" });

      // No catch: the node deflects and the arc suspends with no output commit.
      expect(rootTraversal(deflected).phase).toBe("suspended");
      expect(rootTraversal(deflected).cells.out).toBeUndefined();
    });
  });

  describe("map.deflection-full-clear", () => {
    it("discards already-terminal members when a later member deflects", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let topic = Str();
  let caught = Bool();
  nums.$set(["x", "y"]);
  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };
  nums.$map(() => {
    $observeOrAsk(topic);
  });
}
`,
        "map-deflect-full-clear-arc",
      );

      // Member 0 blocks; resolving it terminalizes member 0 and member 1 blocks.
      const afterFirst = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(afterFirst.observations).toHaveLength(1);

      // Deflecting member 1 clears the whole arena — member 0's terminal row
      // included — and Main's catch re-reaches a virgin map at member 0.
      const caughtBrief = progressBrief(runtime, afterFirst, {
        move: "deflect",
      });
      expect(rootTraversal(caughtBrief).cells.caught).toBe(true);
      expect(caughtBrief.observations).toHaveLength(1);

      // Resolving the re-run member 0 makes member 1 run again: a preserved
      // terminal would have jumped straight to member 1 and completed here.
      const afterReRun = progressBrief(runtime, caughtBrief, {
        move: "proceed",
        observations: {
          [caughtBrief.observations[0]!.id]: { status: "resolved", value: "a" },
        },
      });
      expect(afterReRun.observations).toHaveLength(1);
    });

    it("re-reads a receiver the catch replaced when the map restarts", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Bool());
  let topic = Bool();
  nums.$set(["x"]);
  this.catchDeflection = () => {
    nums.$set(["y", "z"]);
    return true;
  };
  nums.$map(() => {
    $observeOrAsk(topic);
    span.result.$set(topic);
  }, out);
}
`,
        "map-deflect-receiver-mutate-arc",
      );

      // Deflect member 0; the catch replaces the receiver and restarts the map.
      const caught = progressBrief(runtime, brief, { move: "deflect" });
      expect(caught.observations).toHaveLength(1);
      const m0 = progressBrief(runtime, caught, {
        move: "proceed",
        observations: {
          [caught.observations[0]!.id]: { status: "resolved", value: true },
        },
      });
      expect(m0.observations).toHaveLength(1);
      const m1 = progressBrief(runtime, m0, {
        move: "proceed",
        observations: {
          [m0.observations[0]!.id]: { status: "resolved", value: true },
        },
      });

      // Two outputs prove the restart used the replaced two-element list, not a
      // stale one-element pin from the first attempt.
      expect(rootTraversal(m1).cells.out).toEqual([true, true]);
    });

    it("keeps earlier members' cell writes applied after the arena is abandoned", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let topic = Str();
  let witness = Str();
  nums.$set(["x", "y"]);
  nums.$map(() => {
    $observeOrAsk(topic);
    witness.$set(topic);
    span.result.$set(topic);
  }, out);
}
`,
        "map-deflect-effects-persist-arc",
      );

      // Member 0 writes witness and terminalizes; member 1 deflects uncaught.
      const afterFirst = progressBrief(runtime, brief, {
        move: "proceed",
        observations: {
          [brief.observations[0]!.id]: { status: "resolved", value: "kept" },
        },
      });
      const deflected = progressBrief(runtime, afterFirst, { move: "deflect" });

      // Abandoning the arena clears its bookkeeping, not member 0's cell write.
      expect(rootTraversal(deflected).cells.witness).toBe("kept");
      expect(rootTraversal(deflected).cells.out).toBeUndefined();
    });

    it("keeps an earlier member's applied host effect after the arena is abandoned", () => {
      const { runtime, brief } = run(
        `
"arc";
import Memoir from "host:memoir";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let gate = Bool();
  nums.$set(["x", "y"]);
  nums.$map(
    () => {
      if (span.index == 1) {
        $observeOrAsk(gate);
      } else {
        $enter(newcopy(Op), {
          args: { input: span.item },
          returns: { output: span.result },
        });
      }
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    this.effects = () => {
      Memoir.facts.$apply(\`applied\`);
      returns.output.$set(args.input);
    };
  }
}
`,
        "map-deflect-host-effect-arc",
      );

      // Member 0 enters Op, whose effects emit the host effect.
      expect(brief.hostEffects.map((effect) => effect.arguments[0])).toEqual([
        "applied",
      ]);

      // Apply it: member 0's child covers and member 1 reaches its observation.
      const member1 = progressBrief(runtime, brief, {
        move: "proceed",
        hostEffects: appliedHostEffects(brief),
      });
      expect(member1.observations).toHaveLength(1);

      // Deflect member 1 (which entered nothing): the arena is abandoned, but
      // member 0's applied host effect is neither re-emitted nor rolled back.
      const deflected = progressBrief(runtime, member1, { move: "deflect" });
      expect(deflected.hostEffects).toEqual([]);
    });

    it("aborts the map when a deflection escapes an entered child", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let caught = Bool();
  nums.$set(["x"]);
  this.catchDeflection = () => {
    caught.$set(true);
    return true;
  };
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    let topic = Bool();
    $observeOrAsk(topic);
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`,
        "map-deflect-child-arc",
      );

      expect(brief.observations).toHaveLength(1);
      const caughtBrief = progressBrief(runtime, brief, { move: "deflect" });

      // Op does not catch: the deflection crosses the enter, the member, and the
      // $map, clears the arena, and Main's catch fires.
      expect(rootTraversal(caughtBrief).cells.caught).toBe(true);
    });

    it("canonicalizes the deflection through the callback so escaped matches the authored target", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  let matched = Bool();
  nums.$set(["x"]);
  this.catchDeflection = () => {
    if (this.deflection.escaped(Op)) {
      matched.$set(true);
    }
    return true;
  };
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    let topic = Bool();
    $observeOrAsk(topic);
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`,
        "map-deflect-escaped-arc",
      );

      expect(brief.observations).toHaveLength(1);
      const caughtBrief = progressBrief(runtime, brief, { move: "deflect" });

      // `from` canonicalizes through the callback's newcopy(Op) to the authored
      // target, so escaped(Op) matches in the node's catch.
      expect(rootTraversal(caughtBrief).cells.matched).toBe(true);
    });

    it("keeps the member running when the entered child catches its own deflection", () => {
      const { runtime, brief } = run(
        `
"arc";
function Main() {
  let nums = Array(Str());
  let out = Array(Str());
  nums.$set(["x"]);
  nums.$map(
    () => {
      $enter(newcopy(Op), {
        args: { input: span.item },
        returns: { output: span.result },
      });
    },
    out,
  );
  function Op(args = { input: Str() }, returns = { output: Str() }) {
    let topic = Bool();
    this.catchDeflection = () => {
      return true;
    };
    $observeOrAsk(topic);
    this.effects = () => {
      returns.output.$set(args.input);
    };
  }
}
`,
        "map-deflect-child-caught-arc",
      );

      expect(brief.observations).toHaveLength(1);
      const afterDeflect = progressBrief(runtime, brief, { move: "deflect" });

      // Op catches its own deflection, re-walks, and re-blocks on its
      // observation; the member stays open and the $map has not aborted.
      expect(afterDeflect.observations).toHaveLength(1);
      expect(rootTraversal(afterDeflect).cells.out).toBeUndefined();

      // Resolving that observation lets Op cover; its return reaches span.result
      // and the $map completes, so the recovered member still contributes.
      const resolved = progressBrief(runtime, afterDeflect, {
        move: "proceed",
        observations: {
          [afterDeflect.observations[0]!.id]: {
            status: "resolved",
            value: true,
          },
        },
      });
      expect(rootTraversal(resolved).cells.out).toEqual(["x"]);
    });
  });
});
