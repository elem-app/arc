import { describe, expect, it } from "vitest";

import { parse, validate } from "../src/parser/index.js";
import {
  Runtime,
  RuntimeRegistrationError,
  toArcRef,
} from "../src/runtime/index.js";
import {
  getChannelSpec,
  type Document,
  type NodeSignature,
} from "../src/types/index.js";
import { TEST_HOST_MODULES } from "./helpers.js";

/** Both supplied and deserialized Documents must fail before collection. */
function expectRejectedDocument(document: Document, code: string): void {
  for (const candidate of [document, JSON.parse(JSON.stringify(document))]) {
    expect(validate(candidate)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    const runtime = new Runtime({ hostModules: TEST_HOST_MODULES });
    expect(() => runtime.add("channels", candidate)).toThrow(
      RuntimeRegistrationError,
    );
    expect(() => runtime.add("channels", candidate)).toThrow(code);
    for (const root of document.roots) {
      expect(runtime.has(toArcRef("channels", root.identifier))).toBe(false);
    }
    expect(() =>
      runtime.add("channels", parse('"arc"; function Valid() {}')).init(),
    ).not.toThrow();
  }
}

const uses = [
  { name: "scalar reads", spec: "Bool()", body: "if (CHANNEL == true) {}" },
  { name: "unset checks", spec: "Bool()", body: "if (CHANNEL.isUnset()) {}" },
  {
    name: "array elements",
    spec: "Array(Num())",
    body: "let n = Num(); n.$set(CHANNEL[0]);",
  },
  {
    name: "array lengths",
    spec: "Array(Num())",
    body: "let n = Num(); n.$set(CHANNEL.length);",
  },
  {
    name: "struct fields",
    spec: "Struct({ value: Num() })",
    body: "let n = Num(); n.$set(CHANNEL.value);",
  },
  {
    name: "struct array elements",
    spec: "Array(Struct({ value: Num() }))",
    body: "let n = Num(); n.$set(CHANNEL[0].value);",
  },
  {
    name: "struct array fields",
    spec: "Struct({ items: Array(Num()) })",
    body: "let n = Num(); n.$set(CHANNEL.items[0]);",
  },
  { name: "templates", spec: "Bool()", body: "$instruct(`value ${CHANNEL}`);" },
  {
    name: "observation questions",
    spec: "Bool()",
    body: "let answer = Bool({ observing: `value ${CHANNEL}` });",
  },
  {
    name: "initializers",
    spec: "Str()",
    body: "let file = Artifact(CHANNEL);",
  },
  {
    name: "guidance",
    spec: "Bool()",
    body: "this.guidance = `value ${CHANNEL}`;",
  },
  {
    name: "host arguments",
    spec: "Num()",
    body: "let n = Num(); n.$set(Api.number(CHANNEL));",
  },
  {
    name: "triggers",
    spec: "Bool()",
    body: "this.trigger = () => CHANNEL == true;",
  },
  {
    name: "guards",
    spec: "Bool()",
    body: "this.guard = () => { if (CHANNEL == true) return State.SKIPPED; };",
  },
  {
    name: "effects",
    spec: "Bool()",
    body: "this.effects = () => { if (CHANNEL == true) {} };",
  },
  {
    name: "node deflection checks",
    spec: "Bool()",
    body: "this.deflectWhen = () => CHANNEL == true;",
  },
  {
    name: "deflection catches",
    spec: "Bool()",
    body: "this.catchDeflection = () => CHANNEL == true;",
  },
  {
    name: "interruption catches",
    spec: "Bool()",
    body: "this.catchInterruption = () => CHANNEL == true;",
  },
  {
    name: "instruction resolution",
    spec: "Bool()",
    body: "$instructLoop(`work`, { resolveWhen: () => CHANNEL == true });",
  },
  {
    name: "instruction deflection",
    spec: "Bool()",
    body: "$instruct(`work`, { deflectWhen: () => CHANNEL == true });",
  },
  {
    name: "entry loop resolution",
    spec: "Bool()",
    body: "$enterLoop(Child, { resolveWhen: () => CHANNEL == true }); function Child() {}",
  },
  {
    name: "invoke bodies",
    spec: "Bool()",
    body: "invoke(() => { if (CHANNEL == true) {} });",
  },
  {
    name: "map callbacks",
    spec: "Bool()",
    body: "let items = Array(Num()); items.$map(() => { if (CHANNEL == true) {} });",
  },
  {
    name: "map receivers",
    spec: "Array(Num())",
    body: "CHANNEL.$map(() => {});",
  },
  {
    name: "unreachable branches",
    spec: "Bool()",
    body: "if (false) { if (CHANNEL == true) {} }",
  },
];

describe("explicit channel declarations", () => {
  it("compose.signature resolves own declarations within the requested namespace", () => {
    const signature: NodeSignature = {
      args: { value: { type: "string" } },
      returns: { value: { type: "boolean" } },
    };
    expect(getChannelSpec(signature, "args", "value")).toEqual({
      type: "string",
    });
    expect(getChannelSpec(signature, "returns", "value")).toEqual({
      type: "boolean",
    });
    for (const namespace of ["args", "returns"] as const) {
      expect(getChannelSpec(undefined, namespace, "value")).toBeUndefined();
      expect(
        getChannelSpec({ args: {}, returns: {} }, namespace, "value"),
      ).toBeUndefined();
      expect(getChannelSpec(signature, namespace, "missing")).toBeUndefined();
      for (const key of ["constructor", "toString", "__proto__"]) {
        expect(getChannelSpec(signature, namespace, key)).toBeUndefined();
      }
    }

    const ownKeys: NodeSignature = {
      args: Object.fromEntries([["constructor", { type: "number" }]]),
      returns: Object.assign(Object.create(null), {
        result: { type: "string" },
      }),
    };
    expect(getChannelSpec(ownKeys, "args", "constructor")).toEqual({
      type: "number",
    });
    expect(getChannelSpec(ownKeys, "returns", "result")).toEqual({
      type: "string",
    });
    expect(getChannelSpec(ownKeys, "returns", "constructor")).toBeUndefined();
    expect(getChannelSpec(ownKeys, "args", "result")).toBeUndefined();
  });

  it.each(
    ["args", "returns"].flatMap((namespace) =>
      uses.map((use) => ({ ...use, namespace })),
    ),
  )(
    "compose.signature requires declared $namespace for $name",
    ({ namespace, spec, body }) => {
      const source = (parameters: string) => `
"arc";
import Api from "host:api";
function Other() {}
function Main(${parameters}) { ${body.replaceAll("CHANNEL", `${namespace}.value`)} }
`;
      const document = parse(source(`${namespace} = { value: ${spec} }`));
      expect(validate(document)).toEqual([]);
      expect(() =>
        new Runtime({ hostModules: TEST_HOST_MODULES })
          .add("valid", document)
          .init(),
      ).not.toThrow();

      for (const parameters of [
        "",
        `${namespace} = {}`,
        `${namespace} = { other: Bool() }`,
      ]) {
        expect(() => parse(source(parameters))).toThrow();
      }
      const main = document.roots[1]!;
      delete main.signature;
      expectRejectedDocument(document, "UNKNOWN_CHANNEL_KEY");
      main.signature = { args: {}, returns: {} };
      expectRejectedDocument(document, "UNKNOWN_CHANNEL_KEY");
    },
  );

  it("compose.signature rejects undeclared return writes before evaluating their values", () => {
    const source = (parameters: string) => `
"arc";
import Api from "host:api";
function Main(${parameters}) {
  this.effects = () => { if (false) { returns.output.$set(Api.value()); } };
}
`;
    const document = parse(source("returns = { output: Num() }"));
    for (const parameters of ["", "returns = {}", "args = { output: Num() }"]) {
      expect(() => parse(source(parameters))).toThrow(/UNKNOWN_CHANNEL_KEY/);
    }
    delete document.roots[0]!.signature;
    expectRejectedDocument(document, "UNKNOWN_CHANNEL_KEY");
  });

  it("compose.signature requires each nested node to declare its own channels", () => {
    const source = (parameters: string) => `
"arc";
function Main(args = { value: Bool() }, returns = { value: Bool() }) {
  function Child(${parameters}) {
    if (args.value == true) {}
    this.effects = () => { returns.value.$set(true); };
  }
}
`;
    const document = parse(
      source("args = { value: Bool() }, returns = { value: Bool() }"),
    );
    expect(() => parse(source(""))).toThrow(/UNKNOWN_CHANNEL_KEY/);
    delete document.roots[0]!.children[0]!.signature;
    expect(
      validate(document).filter(
        (issue) => issue.code === "UNKNOWN_CHANNEL_KEY",
      ),
    ).toHaveLength(2);
    expectRejectedDocument(document, "UNKNOWN_CHANNEL_KEY");
  });

  it.each(["$enter", "$enterLoop"])(
    "compose.typed-binding requires declarations for every local %s binding",
    (entry) => {
      for (const namespace of ["args", "returns"] as const) {
        for (const target of ["Child", "newcopy(Child)", "forgetful(Child)"]) {
          const source = (parameters: string) => `
"arc";
function Main() {
  let value = Bool();
  if (false) {
    ${entry}(${target}, { ${namespace}: { value }, ${entry === "$enterLoop" ? "resolveWhen: () => true" : ""} });
  }
  function Child(${parameters}) {}
}
`;
          const code =
            namespace === "args"
              ? "UNDECLARED_ARGS_KEY"
              : "UNDECLARED_RETURNS_KEY";
          const document = parse(source(`${namespace} = { value: Bool() }`));
          expect(validate(document)).toEqual([]);
          for (const parameters of [
            "",
            `${namespace} = {}`,
            `${namespace} = { other: Bool() }`,
          ]) {
            expect(() => parse(source(parameters))).toThrow(code);
          }
          delete document.roots[0]!.children[0]!.signature;
          expectRejectedDocument(document, code);
        }
      }
    },
  );

  it("compose.typed-binding requires declarations for forwarded caller args", () => {
    for (const imported of [false, true]) {
      const source = (parameters: string) => `
"arc";
${imported ? 'import { Child } from "child";' : ""}
function Main(${parameters}) {
  $enter(Child, { args: { value: args.value } });
  ${imported ? "" : "function Child(args = { value: Bool() }) {}"}
}
`;
      const document = parse(source("args = { value: Bool() }"));
      expect(() => parse(source(""))).toThrow(/UNKNOWN_ARGS_PROJECTION/);
      delete document.roots[0]!.signature;
      expectRejectedDocument(document, "UNKNOWN_ARGS_PROJECTION");
    }
  });

  it("compose.signature treats prototype members as undeclared channel keys", () => {
    for (const namespace of ["args", "returns"] as const) {
      for (const key of ["constructor", "toString", "__proto__"]) {
        expect(() =>
          parse(
            `"arc"; function Main(${namespace} = {}) { if (${namespace}.${key}.isUnset()) {} }`,
          ),
        ).toThrow(/UNKNOWN_CHANNEL_KEY/);
        const document = parse(
          `"arc"; function Main() { let value = Bool(); $enter(Child); function Child(${namespace} = {}) {} }`,
        );
        const action = document.roots[0]!.statements[0]!;
        if (action.kind !== "enter-node") throw new Error("Expected entry");
        action[namespace] = { [key]: { kind: "cell", cell: "value" } };
        expectRejectedDocument(
          document,
          namespace === "args"
            ? "UNDECLARED_ARGS_KEY"
            : "UNDECLARED_RETURNS_KEY",
        );
      }
    }
  });
});
