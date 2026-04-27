import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import type { EnterNodeAction } from "../src/types.js";

const ARC_SOURCE = `
"use arc v2";

import { Advanced } from "advanced";
import Memoir from "host:memoir";

function HeavyMetal() {
  this.displayName = "Heavy Metal";
  this.description = "Share heavy metal taste";
  this.resumable = false;

  const interest = new Enum(["cold", "warm", "hot"], {
    observing: \`how interested is \${user} in metal\`,
  });

  this.trigger = () => {
    if (judge(\`\${user} asks about music\`)) {
      return true;
    }
    return false;
  };

  this.effects = () => {
    observe(interest);
    if (interest >= "warm") {
      Memoir.facts.apply(\`\${user} is open to metal\`);
    }
  };

  enter(Surface);
  if (interest >= "warm") {
    enter(Advanced);
  }

  function Surface() {
    const subgenre = new Enum(["unknown", "thrash", "doom"], {
      observing: \`what subgenre does \${user} like\`,
    });
    observeOrAsk(subgenre);
    \`Talk about \${subgenre}.\`;
  }
}
`;

describe("parse", () => {
  it("ignores line and block comments across Arc source", () => {
    const document = parse(`
// leading line comment
/* leading block comment */
"use arc v2";

// root comment
function Main() {
  const ready = new Boolean(); // trailing comment

  /* action comment */ enter(Child, {
    // option comment
    args: { ready },
  });

  function Child({ args }) {
    this.effects = () => {
      // branch comment
      if (args.ready === true) {
        ready.set(true);
      }
    };
  }
}
`);

    expect(document.version).toBe("v2");
    expect(document.roots[0]?.identifier).toBe("Main");
    expect(document.roots[0]?.statements[0]).toMatchObject({
      kind: "enter-node",
      args: { ready: "ready" },
    });
  });

  it("ignores comments around returns channel writes in effects", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const verdict = new Boolean();
  enter(Child, { returns: { verdict } });

  function Child({ returns }) {
    this.effects = () => {
      /* before write */
      returns.verdict.set(true); // after write
    };
  }
}
`);

    const child = document.roots[0]?.children.find(
      (entry) => entry.identifier === "Child",
    );
    expect(child?.effects?.[0]).toMatchObject({
      kind: "set-return",
      key: "verdict",
    });
  });

  it("parses Arc into the new root/node IR", () => {
    const document = parse(ARC_SOURCE);

    expect(document.version).toBe("v2");
    expect(document.roots).toHaveLength(1);
    expect(document.roots[0]?.identifier).toBe("HeavyMetal");
    expect(document.roots[0]?.displayName).toBe("Heavy Metal");
    expect(document.roots[0]?.resumable).toBe(false);
    expect(document.imports[0]?.importedName).toBe("Advanced");
    expect(document.imports[0]?.localName).toBe("Advanced");
    expect(document.hostModules[0]).toMatchObject({
      module: "memoir",
      importedName: "default",
      localName: "Memoir",
      source: "host:memoir",
    });

    const root = document.roots[0]!;
    expect(root.variables).toHaveLength(1);
    expect(root.trigger).toHaveLength(2);
    expect(root.effects).toHaveLength(2);
    expect(root.effects?.[1]).toMatchObject({
      kind: "if",
      consequent: [
        {
          kind: "host-call",
          module: "memoir",
          target: ["facts"],
          operation: "apply",
        },
      ],
    });
    expect(root.statements[0]).toMatchObject({
      kind: "enter-node",
      target: { identifier: "Surface", fresh: false },
    });

    const surface = root.children.find(
      (child) => child.identifier === "Surface",
    );
    expect(surface).toBeDefined();
    expect(surface?.variables[0]?.name).toBe("subgenre");
    expect(surface?.statements[0]).toMatchObject({
      kind: "observeOrAsk",
      variable: "subgenre",
    });
    expect(surface?.statements[1]).toMatchObject({
      kind: "instruction",
      mode: "once",
    });
  });

  it("parses instructLoop and instruct with authored resolution rules", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to leave this topic\`;

  instructLoop(\`Carry this topic.\`, {
    resolveWhen: () => {
      observe(ready);
      return ready;
    },
  });

  instruct(\`Mention this once.\`, {
    deflectWhen: \`\${user} is bored\`,
  });

  const ready = new Boolean();
}
`);

    const root = document.roots[0]!;
    expect(root.deflectWhen).toBeDefined();
    expect(root.statements[0]).toMatchObject({
      kind: "instruction",
      mode: "persistent",
    });
    expect(
      (
        root.statements[0] as Extract<
          (typeof root.statements)[number],
          { kind: "instruction" }
        >
      ).resolveWhen,
    ).toBeDefined();
    expect(root.statements[1]).toMatchObject({
      kind: "instruction",
      mode: "once",
    });
    expect(
      (
        root.statements[1] as Extract<
          (typeof root.statements)[number],
          { kind: "instruction" }
        >
      ).deflectWhen,
    ).toBeDefined();
  });

  it("inherits the nearest node-level deflectWhen into instructions by default", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  enter(Child);

  function Child() {
    instructLoop(\`Stay on topic.\`, {
      resolveWhen: \`\${self} stayed on topic\`,
    });
  }
}
`);

    const child = document.roots[0]?.children.find(
      (entry) => entry.identifier === "Child",
    );
    const instruction = child?.statements[0];

    expect(instruction).toMatchObject({
      kind: "instruction",
      mode: "persistent",
    });
    expect(
      (instruction as Extract<typeof instruction, { kind: "instruction" }>)
        ?.deflectWhen,
    ).toBeDefined();
  });

  it("lets local deflectWhen override the inherited node default", () => {
    const document = parse(`
"use arc v2";

function Main() {
  this.deflectWhen = \`\${user} wants to stop\`;
  instructLoop(\`Stay on topic.\`, {
    resolveWhen: \`\${self} stayed on topic\`,
    deflectWhen: \`\${user} hates astronomy\`,
  });
}
`);

    const instruction = document.roots[0]?.statements[0];
    expect(instruction).toMatchObject({
      kind: "instruction",
      mode: "persistent",
    });
    const deflectWhen = (
      instruction as Extract<typeof instruction, { kind: "instruction" }>
    )?.deflectWhen;
    expect(deflectWhen).toHaveLength(1);
  });

  it("requires resolveWhen for instructLoop()", () => {
    expect(() =>
      parse(`
"use arc v2";

function Main() {
  instructLoop(\`Carry this topic.\`);
}
`),
    ).toThrow(/instructLoop\(\) requires resolveWhen/);
  });

  it("rejects resolveWhen for instruct()", () => {
    expect(() =>
      parse(`
"use arc v2";

function Main() {
  instruct(\`Carry this topic.\`, {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`),
    ).toThrow(/instruct\(\) does not support resolveWhen/);
  });

  it("requires template literals for semantic text positions", () => {
    expect(() =>
      parse(`
"use arc v2";

function Main() {
  instructLoop("Carry this topic.", {
    resolveWhen: \`\${self} covered the topic enough\`,
  });
}
`),
    ).toThrow(/Semantic text must be a template literal/);

    expect(() =>
      parse(`
"use arc v2";

function Main() {
  instructLoop(\`Carry this topic.\`, {
    resolveWhen: "\${self} covered the topic enough",
  });
}
`),
    ).toThrow(/Semantic text must be a template literal/);

    expect(() =>
      parse(`
"use arc v2";

function Main() {
  this.deflectWhen = "\${user} wants to stop";
  instruct(\`Mention this once.\`);
}
`),
    ).toThrow(/Semantic text must be a template literal/);

    expect(() =>
      parse(`
"use arc v2";

function Main() {
  const topic = new Boolean();
  observe(topic, "what topic is \${user} discussing");
}
`),
    ).toThrow(/Semantic text must be a template literal/);
  });

  it("treats host effect string literals as plain value arguments", () => {
    const document = parse(`
"use arc v2";

import Memoir from "host:memoir";

function Main() {
  this.effects = () => {
    Memoir.facts.apply("effect");
  };
}
`);

    expect(document.roots[0]?.effects?.[0]).toMatchObject({
      kind: "host-call",
      arguments: [
        {
          kind: "value",
          value: { kind: "literal", value: "effect" },
        },
      ],
    });
  });

  it("parses multiple arcs in one document", () => {
    const source = `
"use arc v2";

function First() {
  \`one\`;
}

function Second() {
  this.displayName = "Second Root";
  \`two\`;
}
`;

    const document = parse(source);

    expect(document.roots.map((root) => root.identifier)).toEqual([
      "First",
      "Second",
    ]);
    expect(document.roots[1]?.displayName).toBe("Second Root");
  });

  it("parses labeled blocks and labeled break statements in action graphs", () => {
    const document = parse(`
"use arc v2";
function Main() {
  branch: {
    \`one\`;
    break branch;
    \`two\`;
  }
}
`);

    expect(document.roots[0]?.statements[0]).toMatchObject({
      kind: "label",
      label: "branch",
      body: [
        { kind: "instruction" },
        { kind: "break", label: "branch" },
        { kind: "instruction" },
      ],
    });
  });

  it("rejects labels that do not target blocks", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  branch: if (true) {
    \`nope\`;
  }
}
`),
    ).toThrow(/labels must target a block statement/);
  });

  it("parses labeled blocks and labeled break statements in effects", () => {
    const document = parse(`
"use arc v2";
function Main() {
  this.effects = () => {
    branch: {
      break branch;
    }
  };
}
`);

    expect(document.roots[0]?.effects?.[0]).toMatchObject({
      kind: "label",
      label: "branch",
      body: [{ kind: "break", label: "branch" }],
    });
  });

  it("parses catchDeflection with deflection.from(), labels, and set()", () => {
    const document = parse(`
"use arc v2";
function Main() {
  const wantsPricing = new Boolean();

  this.catchDeflection = () => {
    branch: {
      if (deflection.from(ProductIntro)) {
        wantsPricing.set(true);
        break branch;
      }
    }
    return wantsPricing === true;
  };

  enter(ProductIntro);

  function ProductIntro() {}
}
`);

    expect(document.roots[0]?.catchDeflection).toMatchObject([
      { kind: "label", label: "branch" },
      { kind: "return" },
    ]);
  });

  it("rejects non-bare deflection.from() targets", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  this.catchDeflection = () => {
    return deflection.from(fresh(ProductIntro));
  };

  function ProductIntro() {}
}
`),
    ).toThrow(/deflection\.from\(\) v1 only accepts a bare target/);
  });

  it("rejects conditional IML in instruction literals", () => {
    const source = `
"use arc v2";
function Bad() {
  enter(Step);
  function Step() {
    \`
      :::when \${true}
      bad
      :::
    \`;
  }
}
`;

    expect(() => parse(source)).toThrow(
      /does not support :::when\/:::else conditional IML/,
    );
  });

  it("allows non-conditional directives to remain in the instruction template", () => {
    const source = `
"use arc v2";
function Directive() {
  enter(Step);
  function Step() {
    \`
      :::replace
      Bring in a stronger phrasing.
      :::
    \`;
  }
}
`;

    const document = parse(source);
    const step = document.roots[0]?.children.find(
      (child) => child.identifier === "Step",
    );
    const instruction = step?.statements[0];

    expect(instruction).toMatchObject({ kind: "instruction" });
    expect(JSON.stringify(instruction)).toContain(":::replace");
  });

  it("rejects unknown variable references", () => {
    const source = `
"use arc v2";
function Bad() {
  if (missing === true) {
    enter(Step);
  }
  function Step() {
    \`hi\`;
  }
}
`;

    expect(() => parse(source)).toThrow(/UNKNOWN_VARIABLE/);
  });

  it("uses this.resumable for node frame persistence", () => {
    const document = parse(`
"use arc v2";
function Good() {
  this.resumable = false;
}
`);

    expect(document.roots[0]?.resumable).toBe(false);
  });

  it("requires trigger, guard, and effects callbacks to be arrow functions", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.trigger = function () {
    return true;
  };
}
`),
    ).toThrow(/this\.trigger must be an arrow function/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.guard = function () {
    return true;
  };
}
`),
    ).toThrow(/this\.guard must be an arrow function/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.effects = function () {
    Memoir.facts.apply(\`effect\`);
  };
}
`),
    ).toThrow(/this\.effects must be an arrow function/);
  });

  it("rejects this.observing and accepts variable.set()", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.observing = \`nope\`;
}
`),
    ).toThrow(/this\.observing is not supported/);

    const document = parse(`
"use arc v2";
function Good() {
  const ready = new Boolean();
  ready.set(true);
}
`);

    expect(document.roots[0]?.statements[0]).toMatchObject({
      kind: "set",
      variable: "ready",
      value: { kind: "literal", value: true },
    });
  });

  it("accepts observing config in variable constructors", () => {
    const document = parse(`
"use arc v2";
function Main() {
  const ready = new Boolean({
    observing: \`is \${user} ready\`,
  });
  const interest = new Enum(["cold", "warm"], {
    observing: \`how interested is \${user}\`,
  });
  const skill = new RangedInt(1, 10, {
    observing: \`how skilled is \${user}\`,
  });
}
`);

    expect(document.roots[0]?.variables.map((item) => item.name)).toEqual([
      "ready",
      "interest",
      "skill",
    ]);
    expect(document.roots[0]?.variables.map((item) => item.observing)).toEqual([
      expect.objectContaining({ kind: "semantic-string" }),
      expect.objectContaining({ kind: "semantic-string" }),
      expect.objectContaining({ kind: "semantic-string" }),
    ]);
  });

  it("rejects invalid variable constructor configs", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean(\`is \${user} ready\`);
}
`),
    ).toThrow(/Boolean variable ready config must be an object literal/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean({
    observed: \`is \${user} ready\`,
  });
}
`),
    ).toThrow(/unsupported config key: observed/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean({
    observing: "is user ready",
  });
}
`),
    ).toThrow(/observing config must be a template literal/);
  });

  it("parses aliased named imports and set() from variable references", () => {
    const document = parse(`
"use arc v2";
import { AnotherArc as IntroArc } from "another-arc";

function Main() {
  const ready = new Boolean();
  const copy = new Boolean();
  copy.set(ready);
  enter(IntroArc);
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
      variable: "copy",
      value: { kind: "variable", name: "ready" },
    });
    expect(document.roots[0]?.statements[1]).toMatchObject({
      kind: "enter-node",
      target: { identifier: "IntroArc", imported: true, fresh: false },
    });
  });

  it("parses enter() args/returns channel wiring with same-name bindings", () => {
    const document = parse(`
"use arc v2";
function Main() {
  const ready = new Boolean();
  const verdict = new Boolean();

  enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child({ args, returns }) {
    this.effects = () => {
      if (args.ready === true) {
        returns.verdict.set(true);
      }
    };
  }
}
`);

    expect(document.roots[0]?.statements[0]).toMatchObject({
      kind: "enter-node",
      target: { identifier: "Child", fresh: false },
      args: { ready: "ready" },
      returns: { verdict: "verdict" },
    });
    const child = document.roots[0]?.children.find(
      (entry) => entry.identifier === "Child",
    );
    expect(child?.effects?.[0]).toMatchObject({ kind: "if" });
    if (child?.effects?.[0]?.kind !== "if") {
      throw new Error("expected child effects if statement");
    }
    expect(child.effects[0].test).toMatchObject({
      kind: "binary",
      left: { kind: "channel", namespace: "args", key: "ready" },
      right: { kind: "literal", value: true },
    });
    expect(child.effects[0].consequent[0]).toMatchObject({
      kind: "set-return",
      key: "verdict",
    });
  });

  it("parses fresh targets and synthesizes node aliases for pseudo-children", () => {
    const document = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  enter(fresh(Child));
  enterLoop(fresh(Intro), {
    resolveWhen: () => {
      return true;
    },
  });

  function Child() {
    \`child\`;
  }
}
`);

    const root = document.roots[0]!;
    expect(root.statements[0]).toMatchObject({
      kind: "enter-node",
      target: { identifier: "Child", imported: false, fresh: true },
    });
    expect(root.statements[1]).toMatchObject({
      kind: "enter-loop",
      target: { identifier: "Intro", imported: true, fresh: true },
    });
    expect(root.freshAliases).toEqual([
      { identifier: "Child#0", target: "Child", imported: false },
      { identifier: "Intro#1", target: "Intro", imported: true },
    ]);
  });

  it("parses reopen targets without synthesizing fresh aliases", () => {
    const document = parse(`
"use arc v2";
import { Intro } from "intro-arc";

function Main() {
  enter(reopen(Child));
  enterLoop(reopen(Intro), {
    resolveWhen: () => {
      return true;
    },
  });

  function Child() {
    \`child\`;
  }
}
`);

    const root = document.roots[0]!;
    expect(root.statements[0]).toMatchObject({
      kind: "enter-node",
      target: {
        identifier: "Child",
        imported: false,
        fresh: false,
        reopen: true,
      },
    });
    expect(root.statements[1]).toMatchObject({
      kind: "enter-loop",
      target: {
        identifier: "Intro",
        imported: true,
        fresh: false,
        reopen: true,
      },
    });
    expect(root.freshAliases).toEqual([]);
  });

  it("rejects enter() renamed channel bindings", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  const ready = new Boolean();
  enter(Child, {
    args: { inputReady: ready },
  });
  function Child() {}
}
`),
    ).toThrow(/same-name binding/);
  });

  it("rejects enter() renamed returns channel bindings", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  const verdict = new Boolean();
  enter(Child, {
    returns: { outputVerdict: verdict },
  });
  function Child() {}
}
`),
    ).toThrow(/same-name binding/);
  });

  it("surfaces enter() renamed channel bindings as a structured validation issue", () => {
    const document = parse(`
"use arc v2";
function Main() {
  const ready = new Boolean();
  enter(Child, { args: { ready } });
  function Child() {}
}
`);
    const enterAction = document.roots[0]?.statements[0] as EnterNodeAction;
    enterAction.args = { ready: "renamedReady" };

    const issues = validate(document);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "ENTER_CHANNEL_RENAME",
        message:
          "enter().args.ready must use same-name binding (renaming is not supported)",
        loc: enterAction.loc,
      }),
    );
  });

  it("rejects enter() channel bindings that reference unknown caller variables", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  const ready = new Boolean();
  enter(Child, {
    args: { ready },
    returns: { verdict },
  });
  function Child() {}
}
`),
    ).toThrow(/unknown caller variable: verdict/);
  });

  it("rejects returns.*.set(...) outside this.effects", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  const verdict = new Boolean();
  enter(Child, { returns: { verdict } });
  function Child() {
    returns.verdict.set(true);
  }
}
`),
    ).toThrow(/only allowed inside this\.effects/);
  });

  it("rejects returns.*.set(...) outside this.effects even inside action control flow", () => {
    expect(() =>
      parse(`
"use arc v2";
function Main() {
  const verdict = new Boolean();
  enter(Child, { returns: { verdict } });
  function Child() {
    if (true) {
      returns.verdict.set(true);
    }
  }
}
`),
    ).toThrow(/only allowed inside this\.effects/);
  });

  it("assigns stable numeric ids to every action in source order", () => {
    const document = parse(`
"use arc v2";

function Main() {
  const ready = new Boolean();

  this.trigger = () => {
    observe(ready);
    if (judge(\`is \${user} ready\`)) {
      return true;
    }
  };

  this.effects = () => {
    observe(ready);
    if (ready === true) {
      ready.set(false);
    }
  };

  \`a\`;
  if (ready === true) {
    observe(ready);
    \`b\`;
  } else {
    if (judge(\`fallback\`)) {
      \`fallback\`;
    }
  }
  enter(Child);

  function Child() {
    ready.set(true);
    \`c\`;
  }
}
`);

    const root = document.roots[0]!;
    expect(
      root.trigger?.map((statement) =>
        "id" in statement ? statement.id : null,
      ),
    ).toEqual([0, null]);
    if (!root.trigger?.[1] || root.trigger[1].kind !== "if") {
      throw new Error("expected trigger if");
    }
    expect(root.trigger[1].test).toMatchObject({ kind: "judge", id: 1 });
    expect(root.effects?.[0]).toMatchObject({ kind: "observe", id: 2 });
    expect(root.effects?.[1]).toMatchObject({ kind: "if" });
    const effectBranch =
      root.effects?.[1] && root.effects[1].kind === "if"
        ? root.effects[1].consequent[0]
        : undefined;
    expect(effectBranch).toMatchObject({ kind: "set", id: 3 });
    expect(root.statements[0]).toMatchObject({ kind: "instruction", id: 4 });
    const branch = root.statements[1];
    expect(branch).toMatchObject({ kind: "if" });
    if (!branch || branch.kind !== "if") throw new Error("expected if");
    expect(branch.consequent[0]).toMatchObject({ kind: "observe", id: 5 });
    expect(branch.consequent[1]).toMatchObject({ kind: "instruction", id: 6 });
    expect(branch.alternate?.[0]).toMatchObject({ kind: "if" });
    if (!branch.alternate?.[0] || branch.alternate[0].kind !== "if") {
      throw new Error("expected alternate if");
    }
    expect(branch.alternate[0].test).toMatchObject({ kind: "judge", id: 7 });
    expect(branch.alternate[0].consequent[0]).toMatchObject({
      kind: "instruction",
      id: 8,
    });
    expect(root.statements[2]).toMatchObject({ kind: "enter-node", id: 9 });

    const child = root.children.find((entry) => entry.identifier === "Child");
    expect(child?.statements[0]).toMatchObject({ kind: "set", id: 0 });
    expect(child?.statements[1]).toMatchObject({ kind: "instruction", id: 1 });
  });

  it("accepts judge() inside set() value expressions", () => {
    const document = parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean();
  ready.set(judge(\`is \${user} ready\`));
}
`);

    expect(document.roots[0]?.statements[0]).toMatchObject({
      kind: "set",
      value: { kind: "judge" },
    });
  });

  it("parses host call expressions in set() and condition positions", () => {
    const document = parse(`
"use arc v2";

import Dice from "host:rng";

function Main() {
  const lucky = new Boolean();
  lucky.set(Dice.roll(20));

  if (Dice.roll(6)) {
    \`critical hit\`;
  }
}
`);

    const root = document.roots[0]!;
    expect(root.statements[0]).toMatchObject({
      kind: "set",
      value: {
        kind: "host-call",
        module: "rng",
        operation: "roll",
      },
    });
    expect(root.statements[1]).toMatchObject({
      kind: "if",
      test: {
        kind: "host-call",
        module: "rng",
        operation: "roll",
      },
    });
  });

  it("rejects invalid set() arity", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean();
  ready.set();
}
`),
    ).toThrow(/requires a value/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean();
  ready.set(true, false);
}
`),
    ).toThrow(/takes exactly one value/);
  });

  it("rejects unsupported statements and expressions in node action graphs", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  while (true) {
    \`nope\`;
  }
}
`),
    ).toThrow(/Unsupported Arc statement: WhileStatement/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  nope();
}
`),
    ).toThrow(/Unsupported Arc expression statement/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const local = 1;
}
`),
    ).toThrow(/Unsupported Arc statement: VariableDeclaration/);
  });

  it("rejects unsupported statements inside trigger, guard, and effects", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.trigger = () => {
    const local = 1;
    return true;
  };
}
`),
    ).toThrow(/Unsupported this\.trigger statement: VariableDeclaration/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.guard = () => {
    noop();
    return State.SKIPPED;
  };
}
`),
    ).toThrow(/Unsupported this\.guard call/);

    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.effects = () => {
    while (true) {
      observe(missing);
    }
  };
}
`),
    ).toThrow(/Unsupported this\.effects statement: WhileStatement/);
  });

  it("rejects observeOrAsk inside effects", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  const ready = new Boolean();
  this.effects = () => {
    observeOrAsk(ready);
  };
}
`),
    ).toThrow(/observeOrAsk\(\) is forbidden inside this\.effects/);
  });

  it("requires host effects to be declared by host module import", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  this.effects = () => {
    Memoir.facts.apply(\`effect\`);
  };
}
`),
    ).toThrow(/declared host effect/);
  });

  it("requires host module imports to be default imports", () => {
    expect(() =>
      parse(`
"use arc v2";
import { Memoir } from "host:memoir";
function Bad() {
  this.effects = () => {
    Memoir.facts.apply(\`effect\`);
  };
}
`),
    ).toThrow(/host module imports must use a default import/);
  });

  it("rejects unknown node references in state expressions", () => {
    expect(() =>
      parse(`
"use arc v2";
function Bad() {
  if (Missing.state === State.COVERED) {
    \`nope\`;
  }
}
`),
    ).toThrow(/UNDEFINED_NODE/);
  });

  it("rejects default imports", () => {
    const source = `
"use arc v2";
import Advanced from "advanced";
function Bad() {
  \`hi\`;
}
`;

    expect(() => parse(source)).toThrow(/does not support default imports/);
  });

  it("uses plain top-level function declarations for arcs and rejects export syntax", () => {
    const document = parse(`
"use arc v2";
function Helper() {
  \`helper\`;
}
`);

    expect(document.roots.map((root) => root.identifier)).toEqual(["Helper"]);

    expect(() =>
      parse(`
"use arc v2";
export { Helper };
function Helper() {
  \`helper\`;
}
`),
    ).toThrow(/Export syntax is not supported/);
  });

  it("accepts Dialog globals in authored expressions", () => {
    const document = parse(`
"use arc v2";
function Main() {
  if (/music/i.test(Dialog.lastUserMessage)) {
    \`hi\`;
  }
  if (Dialog.lastTurns(2)) {
    \`there\`;
  }
}
`);

    const first = document.roots[0]?.statements[0];
    const second = document.roots[0]?.statements[1];

    expect(first).toMatchObject({
      kind: "if",
      test: {
        kind: "regexTest",
        target: { kind: "scope", name: "lastUserMessage" },
      },
    });
    expect(second).toMatchObject({
      kind: "if",
      test: { kind: "scope", name: "lastTurns", count: 2 },
    });
  });
});
