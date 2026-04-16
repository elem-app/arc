# Arc Scripts

Arc is a JS-like language for encoding structured information graphs. Each function declaration defines a **node** — a self-contained unit of state, logic, and content. Nodes compose into trees. The runtime walks those trees turn by turn, yielding structured briefs that a host application resolves.

Although Arc scripts employ a JS-based syntax, they can only be executed by the Arc runtime and not a standard JavaScript runtime.

## Document Structure

An Arc script is a `.js` file (or more commonly, a `.arc.js` file). **Semicolons are required** after every statement.

The first statement is the version directive (the only supported version is v2):

```js
"use arc v2";
```

Each function declaration defines a **node**; each document root-level node is an **arc**:

```js
"use arc v2";

// This function is an arc
function HeavyMetal() {

  // This is a node
  function Artists() {
    // ...
  }
}

// This is another arc
function HipHop() {}
```

Arcs are `import`-able by default; `export` is not part of the Arc language:

```js
import { HipHop } from "music";
```

See [Composition](#composition) for details about how arcs and nodes compose.

Host modules are imported with a default import whose source starts with `host:`:

```js
import Dice from "host:rng";
```

See [Host Modules](#host-modules) for more introduction about host modules.

## Nodes

A node (function) body contains four sections, in order:

1. **Config statements** — `this.*` assignments that set metadata and lifecycle hooks.
2. **Variable declarations** — typed state scoped to this node.
3. **Action graph** — the executable logic that progresses turn by turn.
4. **Child node declarations** — nested function declarations.

Config, variables, and child declarations are **declarative** — they define fixed structure. The action graph is the only part that progresses through the brief/report cycle.

### String Conventions

- **String literals** (`"..."` or `'...'`) — metadata and the version directive.
- **Template literals** (`` `...` ``) — semantic content interpreted by LLMs. Interpolated expressions (`${...}`) are type-checked for valid entity/variable references.

### Config Statements

`this.*` assignments at the start of a node body.

| Config             | Type             | Description                                                                                                          |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `this.displayName` | string literal   | Optional human-facing label. Presentation metadata only.                                                             |
| `this.description` | string literal   | Brief summary.                                                                                                       |
| `this.guidance`    | template literal | Guidance for content delivery.                                                                                       |
| `this.resumable`   | boolean literal  | Default `true`. When `false`, the action resolution map resets on re-entry. See [Execution Model](#execution-model). |
| `this.trigger`     | arrow function   | Trigger condition for dormant arcs. See [Trigger](#trigger).                                                         |
| `this.deflectWhen` | template literal or arrow function | Default deflection policy inherited by instruction actions in this node subtree. See [DeflectWhen](#deflectwhen). |
| `this.guard`       | arrow function   | Explicit state guard. See [Guard](#guard).                                                                           |
| `this.effects`     | arrow function   | Reactive observations and emitted host effects. See [Effects](#effects).                                             |

Structural identity comes from the JS declaration identifier, not metadata.

- `function HeavyMetal() {}` — structural identifier is `HeavyMetal`
- `this.displayName = "Heavy Metal"` — presentation metadata only
- `enter(HeavyMetal)` and `HeavyMetal.state` resolve by structural identifier or import binding

A **reference name** in Arc source is either a local function declaration identifier or a local import binding.

### Variables

Variables are typed state declarations scoped to the node that declares them. They persist in traversal state across turns and drive the action graph's conditional logic.

Declared as `const` inside a node body:

```js
const interest = new Enum(["cold", "lukewarm", "curious", "enthusiastic"], {
  observing: `how interested is ${user} in heavy metal`,
});

const musicSurfaced = new Boolean({
  observing: `has ${user} mentioned a specific band or song`,
});

const skill = new RangedInt(1, 10, {
  observing: `how skilled ${user} feels at this`,
});
```

`observing` sets the default observation question for `observe(variable)` and `observeOrAsk(variable)`. It can be provided in the constructor config or later with `variable.observing = ...`. It can be overridden per-call with a second argument.

| Constructor                    | Description                                            | Config                     |
| ------------------------------ | ------------------------------------------------------ | -------------------------- |
| `Enum(values, config?)`        | Ordered string enum. Comparisons use ordinal position. | `values: string[]`         |
| `Boolean(config?)`             | Boolean flag.                                          |                            |
| `RangedInt(min, max, config?)` | Bounded integer.                                       | `min: number, max: number` |

The optional `config` object supports `observing: template literal`.

Enum comparisons use **ordinal position** within the declared values array. For `new Enum(["cold", "lukewarm", "curious", "enthusiastic"])`, `interest >= "lukewarm"` is true when `interest` is `"lukewarm"` (index 1), `"curious"` (index 2), or `"enthusiastic"` (index 3).

### Action Graph

The action graph is the executable part of a node body. It contains **action forms** — things the runtime delegates to the host — and **control flow** that routes between them.

The runtime walks the action graph top-down each turn. Actions already resolved in prior turns are skipped. The walk stops at the first unresolved action and yields a brief for the host. This turn-by-turn progression is what makes nodes stateful.

#### Action Forms

Some action forms are statement-only. Others can also appear inside expressions.

Statement forms:

- `observe(variable)` — passive extraction from conversation using the variable's `.observing` question text.
- ``observe(variable, `override question`)`` — passive extraction with a specific observation question.
- `observeOrAsk(variable)` — extraction with fallback to asking the user.
- ``observeOrAsk(variable, `override question`)`` — extraction with a specific observation question, fallback to asking.
- `variable.set(value)` — typed variable write.
- **Instruction literal** (bare template literal) — shorthand for a one-shot instruction.
- `instruct(text, { deflectWhen? })` — one-shot instruction.
- `instructLoop(text, { resolveWhen, deflectWhen? })` — sticky instruction with authored resolution logic.
- `enter(Target)` — enters a node or arc target.
- `enter(Target, { args, returns })` — enters a node or arc target with explicit input/output variable wiring.
- `enterLoop(Target, { resolveWhen, args?, returns? })` — repeatedly enters a target until the caller-authored loop condition resolves true.

Expression-capable forms:

- ``judge(`semantic question`)`` — semantic boolean check against conversation context. Returns `boolean`.
- Host calls through imported `host:*` modules — yields a host-provided value. See [Host Modules](#host-modules).

`observe()` and `judge()` can also appear in `this.trigger`, `this.effects`, and instruction resolution logic.

#### Instructions

Instruction actions are authored guidance that the runtime hands to the host. Unlike value-style actions, reaching an instruction does not immediately block on a single required value. Instead, the runtime first emits guidance, then derives the instruction outcome from authored `deflectWhen` / `resolveWhen` logic over subsequent handbacks.

Arc supports three instruction forms:

```js
`Mention heavy metal naturally.`;

instructLoop(`Keep developing this topic.`, {
  resolveWhen: `${self} has covered the topic enough`,
});

instruct(`Mention this once.`, {
  deflectWhen: `${user} clearly does not want this topic`,
});
```

The instruction text must be a template literal. A bare instruction literal desugars to `instruct(...)`.

`resolveWhen` and `deflectWhen` define authored instruction semantics:

- A template literal desugars to `return judge(...)`.
- An arrow function uses the same constrained statement subset as `this.trigger`: `if` / `else`, `observe(...)`, and `return <expression>`.
- Expressions inside those functions may use variables, `judge(...)`, host calls, regex tests, and logical composition.

Authoring rules:

- `instructLoop(...)` is sticky and requires `resolveWhen`.
- `instruct(...)` is one-time and does not support `resolveWhen`.
- `deflectWhen` is optional on both forms.
- If an instruction omits `deflectWhen`, it inherits the nearest node-level `this.deflectWhen`, if any.

Execution semantics:

1. When traversal first reaches an instruction, the runtime emits the instruction text and marks the action pending.
2. While the instruction is pending, the runtime evaluates `deflectWhen` first, then `resolveWhen`.
3. If `deflectWhen` becomes true, the traversal is deflected.
4. If `resolveWhen` becomes true, the instruction action resolves and traversal continues.
5. Otherwise the instruction remains pending and continues to apply on later handbacks.
6. `instruct(...)` resolves implicitly when the host reports back, unless it is deflected.

Only the currently reachable semantic checks from `deflectWhen` / `resolveWhen` surface in a given brief. See [arc-runtime-api.md](arc-runtime-api.md) for the `InstructionBrief` and `postcheck` protocol.

#### Control Flow

- `if`/`else` — conditional branching based on variable state, `ReferenceName.state`, `judge()` results, or regex tests.
- `label: { ... }` — a labeled block that establishes a lexical control-flow region.
- `break label;` — exits the nearest enclosing labeled block whose label matches.

Labels are only allowed on block statements in the main action graph. `break` must specify a label. Labels and `break` are not allowed in `this.trigger`, `this.guard`, or `this.effects`.

Example:

```js
branch: {
  if (interest >= "lukewarm") {
    enter(Spark);
    break branch;
  }

  enter(Surface);
}

enter(Afterward);
```

If `interest >= "lukewarm"` is true, control exits the `branch` block after `enter(Spark)` and continues at `enter(Afterward)`. Otherwise the walk falls through to `enter(Surface)` before leaving the block.

#### Expressions

Conditions in `if` statements support:

- Variable references — `interest`, `musicSurfaced`
- Comparisons — `interest >= "lukewarm"`, `ready === true`
- Node state checks — `Spark.state === State.COVERED`
- Semantic checks — ``judge(`semantic question`)``
- Host calls — `Dice.roll(20)`, `Store.flags.enabled()`
- Regex tests — `/pattern/flags.test(target)` (e.g., `/music|band/i.test(Dialog.lastUserMessage)`)
- Logical composition — `&&`, `||`, `!`

### Host Modules

Host modules let arcs interact with host-owned systems — rolling dice, reading feature flags, writing to memoir. The arc declares what it needs; the host decides what the call means.

Host modules are imported with a default import whose source starts with `host:`:

```js
import Dice from "host:rng";
import Memoir from "host:memoir";
```

A host import can be used in two ways:

**Expression position** — asks the host for a value. The call blocks until the host reports back.

```js
const lucky = new Boolean();
lucky.set(Dice.roll(20));

if (Dice.roll(20)) {
  `That was a critical hit.`;
}
```

**Statement position inside `this.effects`** — emits an external effect for the host to handle. The runtime surfaces the effect in the brief without executing it.

```js
this.effects = () => {
  Memoir.facts.apply(`${user} survived the tavern brawl`);
};
```

Constraint: host-call arguments must be renderable without further host work. Nested host calls inside host-call arguments are rejected.

## Lifecycle Hooks

Four config entries control a node's lifecycle beyond its action graph: when the arc activates, how pending instructions deflect, whether a node should be entered, and what happens after actions resolve.

### Trigger

`this.trigger` is evaluated when the arc is dormant. It returns `true` to activate the arc for traversal. Only meaningful on arcs (top-level nodes).

```js
this.trigger = () => {
  if (
    this.enterCount === 0 &&
    /music|band/i.test(Dialog.lastUserMessage) &&
    judge(`${user} mentions music, bands, or concerts`)
  ) {
    observe(interest);
    return true;
  }
  if (
    this.enterCount === 0 &&
    judge(`${user} asks about hobbies or interests`)
  ) {
    return true;
  }
  if (
    this.enterCount > 0 &&
    interest >= "lukewarm" &&
    judge(`${user} mentions music again`)
  ) {
    return true;
  }
  if (this.enterCount > 0 && /music/i.test(Dialog.lastUserMessage)) {
    return true;
  }
};
```

- `this.enterCount` — starts at `0`. Counts how many times this arc has been successfully activated after trigger evaluation. Trigger evaluation alone does not increment it.
- `judge()` and `observe()` calls become part of the trigger brief and may be batched.
- `observe()` calls execute only on the branch that returns `true`. Branches that do not match are not evaluated — their `observe()` and `judge()` calls do not run.

### DeflectWhen

`this.deflectWhen` defines the default deflection policy for instruction actions in the current node and its descendants. It is consulted only while a reachable instruction remains pending; it is not a node-entry hook like `this.guard`.

```js
this.deflectWhen = () => {
  if (judge(`${user} wants to leave this topic`)) {
    return true;
  }
};
```

It accepts the same two authored forms as instruction-level `deflectWhen`:

- a template literal, which desugars to `return judge(...)`;
- an arrow function using the trigger-style subset.

Inheritance rules:

- A node's own instruction actions inherit `this.deflectWhen` by default.
- Child nodes inherit the nearest ancestor `this.deflectWhen` unless they define their own.
- An instruction-level `deflectWhen` overrides the inherited node default.

### Guard

`this.guard` is evaluated when traversal reaches a node — after the parent's `if` condition passes but before the node's action graph runs. It may return a `State.*` value to resolve the node without entering it. If it returns `undefined`, traversal continues normally.

```js
this.guard = () => {
  if (musicSurfaced) return State.SKIPPED;
};
```

Guards are for explicit, unconditional node-state decisions. `if` conditions in the parent's action graph serve a different purpose — they are re-evaluated each turn and route based on current state.

### Effects

`this.effects` runs when the node's action graph cannot progress further — whether all actions resolved or traversal stopped early (e.g., a child was deflected). Effects handle post-traversal bookkeeping: extracting final variable values and emitting host effects.

```js
import Memoir from "host:memoir";

this.effects = () => {
  observe(interest);
  observe(musicSurfaced);
  if (interest >= "curious") {
    musicSurfaced.set(true);
  }
  if (interest >= "curious") {
    Memoir.attitude.apply(`be more enthusiastic about music with ${user}`);
  }
  if (musicSurfaced === true) {
    Memoir.facts.apply(
      `${user} has shown interest in specific heavy metal music`,
    );
  }
};
```

- `observe()` calls use the variable's declared `.observing`.
- `variable.set(value)` performs a type-checked write.
- Statement-position host module calls emit effects for the host application.

Effects statements execute sequentially. `observe()` is best-effort: if the host
reports `unknown`, execution continues without writing a new value. By contrast,
`observeOrAsk()` remains pending until the host resolves it or asks the user.

## Composition

Arc has two distinct composition layers:

- **Structural composition (declaration-time)** — how nodes/arcs are declared and related in source.
- **Execution composition (runtime)** — how control transfers between declared units during traversal.

Structural composition uses two mechanisms, distinguished by ownership and scope:

**Child nodes** are function declarations nested inside a parent. They are owned by the parent — their traversal state is stored inline under it. Children can read outer variables through lexical scoping.

**Imported arcs** are roots from other arc documents imported at the top level. They have their own traversal lifecycle, managed directly by the runtime. Their scope is fully isolated — own variables, effects, and action graph.

Execution composition uses `enter(ReferenceName)` for both forms:

```js
"use arc v2";

import { AdvancedTechniques } from "advanced-techniques";

function CookingTogether() {
  this.displayName = "Cooking Together";

  enter(ShareRecipe);
  if (ShareRecipe.state === State.COVERED) {
    enter(AdvancedTechniques);
  }

  function ShareRecipe() {
    `Share a simple recipe with ${user}.`;
  }
}
```

`ReferenceName.state` works the same for both — it reports the node's outcome (`COVERED`, `DEFLECTED`, `SKIPPED`).

Import resolution is two-stage:

1. Resolve the document by source specifier (an opaque string — file path, module name, or registry key, depending on the host environment).
2. Resolve the root inside that document by structural identifier.

The local import binding is only a lexical name inside the importing document.

### Targets

A control-transfer target in Arc is one of:

- `ReferenceName` — the canonical traversal for that node or arc.
- `fresh(ReferenceName)` — a fresh ephemeral traversal instance of that node or arc.

`fresh(ReferenceName)` requests a new empty traversal instance for the current call. Fresh targets are ephemeral and non-addressable:

- They do not participate in `ReferenceName.state`.
- They are not queryable from Arc source.
- They are valid only as direct targets to `enter(...)` and `enterLoop(...)`.

For owned child nodes, `fresh(ReferenceName)` creates a fresh traversal instance of that child for the current call.

For imported arcs, `fresh(ReferenceName)` creates a fresh call instance of the imported arc. This does not reset, replace, or mutate the canonical imported-arc traversal managed by the runtime.

### Control Transfer

#### Enter

`enter(...)` is an action for execution control-transfer. It has two forms:

- `enter(Target)` — control-flow only.
- `enter(Target, { args, returns })` — control-flow with explicit dataflow wiring.

When traversing an `enter`:

1. `Target` resolves to either a canonical traversal (`ReferenceName`) or a fresh ephemeral traversal (`fresh(ReferenceName)`).
2. Control transfers to the referenced callee traversal.
3. The caller action graph does not move past this `enter` until the callee resolves for this entry.
4. If `Target` is `ReferenceName`, the callee outcome is reflected through `ReferenceName.state` (`COVERED`, `DEFLECTED`, `SKIPPED`).
5. If `Target` is `fresh(ReferenceName)`, the callee outcome is not reflected through `ReferenceName.state`.
6. When the callee becomes `COVERED` or `SKIPPED`, this `enter` action resolves and caller traversal continues.
7. If the callee is unresolved or becomes `DEFLECTED`, then `enter` remains unresolved.

#### Args and Returns Processing

`enter(..., { args, returns })` wires caller variables into child input/output channels:

```js
const report = new ...;
const verdict = new ...;

enter(Child, {
  args: { report },
  returns: { report, verdict },
});

// then inside Child
function Child({ args, returns }) {
  this.effects = () => {
    returns.report.set(...);
  }
}
```

Processing rules:

- `args` maps **child-side input channel keys** (accessed as `args.<key>`) to **caller variables**.
- `returns` maps **child-side output channel keys** (written as `returns.<key>.set(...)`) to **caller variables**.
- Each entry must be same-name (no renamed binding): `args: { report }` is valid, `args: { inputReport: report }` is invalid.
- `args` / `returns` must be object literals (no spread, no computed keys).
- These keys live under the callee's parameter object namespaces (`args` and `returns`), not as top-level callee bindings.

Arc variables are containers (cells), not scalar bindings. `enter(...)` therefore wires cells, not copied scalar values.

Execution semantics:

1. On child entry, `args` exposes caller-backed input cells under child-local names.
2. Child writes output candidates through `returns.<name>.set(...)`.
3. Return writes are staged during child execution and become visible to caller cells only when the child resolves to `State.COVERED`.
4. If child traversal does not reach `State.COVERED` for this `enter` (for example, remains blocked, is deferred, deflected, or skipped by guard), staged return writes are not committed to caller cells.
5. Keys in `returns` that the child never sets do not change caller cells.

Write boundary:

- `returns.*.set(...)` is only valid inside `this.effects`.
- `args` is read-only from the child perspective.

This model keeps control-flow ownership in `enter(...)` while making dataflow explicit at the call site.

#### Enter Loop

`enterLoop(...)` is an action for repeated control-transfer. It repeatedly enters the target and evaluates a caller-authored loop condition after each completed iteration.

`enterLoop(...)` has one form:

- `enterLoop(Target, { resolveWhen, args?, returns? })`

Authoring rules:

- `resolveWhen` is required.
- `resolveWhen` accepts the same authored forms as instruction `resolveWhen`:
  - a template literal, which desugars to `return judge(...)`
  - an arrow function using the constrained statement subset allowed in `this.trigger`
- `Target` may be either `ReferenceName` or `fresh(ReferenceName)`.
- `enterLoop(fresh(ReferenceName), ...)` is the explicit fresh-loop form.
- `enterLoop(ReferenceName, ...)` reuses the canonical traversal each iteration.

Execution semantics:

1. The runtime enters the target once, using normal `enter(...)` semantics for `args` and `returns`.
2. When one iteration reaches `State.COVERED`, staged `returns` are committed to caller cells.
3. After a covered iteration, the runtime evaluates `resolveWhen` in the caller context.
4. If `resolveWhen` is true, the `enterLoop(...)` action resolves.
5. If `resolveWhen` is false, the runtime begins a new iteration by entering the same target shape again.
6. For `fresh(ReferenceName)`, each iteration creates a new empty traversal instance.
7. For plain `ReferenceName`, each iteration re-enters the canonical traversal according to normal Arc semantics.
8. If an iteration is `SKIPPED`, the loop does not commit staged `returns`; `resolveWhen` is still evaluated.
9. If an iteration becomes `DEFLECTED` or remains unresolved, the `enterLoop(...)` action remains unresolved.

#### Examples

```js
function Parent() {
  const ready = new Boolean();
  const verdict = new Boolean();

  enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child({ args, returns }) {
    if (args.ready === true) {
      `...`;
    }

    this.effects = () => {
      returns.verdict.set(true);
    };
  }
}
```

## Primitives

### Values

| Value  | Description             |
| ------ | ----------------------- |
| `user` | The human interlocutor. |
| `self` | The AI companion.       |

### Objects

**`State`** — node outcome values used in `ReferenceName.state` comparisons.

| Property          | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `State.COVERED`   | All reachable actions and effects completed.                                              |
| `State.DEFLECTED` | The host reported a deflection (user redirected away). Eligible for re-entry.             |
| `State.SKIPPED`   | Permanently resolved via explicit guard logic. Not produced automatically by the runtime. |

**`Dialog`** — conversation context accessors.

| Property                 | Type                                            | Description                         |
| ------------------------ | ----------------------------------------------- | ----------------------------------- |
| `Dialog.lastUserMessage` | `string`                                        | The most recent user message.       |
| `Dialog.lastTurns(n)`    | `{ role: "self" \| "user"; content: string }[]` | The last `n` turns of conversation. |

## Execution Model

Arc's execution model is built around persistent **traversal state** and ephemeral **briefs**. Three concepts are essential to understand:

**Node state** is the outcome of a node: `COVERED`, `DEFLECTED`, `SKIPPED`, or not yet resolved. It answers "what happened to this node?" and determines whether `enter(ReferenceName)` re-enters or skips it. Node state is visible to the parent's action graph through `ReferenceName.state`.

**Node frame** is the per-action resolution map inside a node. It tracks which individual actions have been resolved so the walk can skip them on re-entry. The frame is internal bookkeeping — it is what makes turn-by-turn progression work. When `this.resumable = false`, the frame is discarded on re-entry (previously resolved actions are forgotten), but node state, variable values, and child states are preserved.

**Traversal** is the full runtime state for an arc or node: its lifecycle phase, enter count, variable values, node frame, child traversals, and node state.

### Turn Execution

When traversal is inside a node, each turn:

1. **Sets up declarative state** — evaluates config statements and variable declarations.
2. **Walks the action graph** — re-traverses from the top, skips every reachable action already resolved in the node frame, and stops at the first unresolved reachable action.

The runtime yields a brief describing the pending work. The host resolves it and reports back when it wants traversal to continue. The runtime applies the report and, if the host proceeds, walks again. This loop continues until the action graph completes or the host defers/deflects.

Traversal progression is host-driven and does not need to map one-to-one to conversation messages. A host may call `progress(...)` immediately, after one message round, or after many rounds while carrying the same instruction frontier.

Instruction actions have an extra pending phase: first the runtime emits guidance, then subsequent handbacks evaluate authored `deflectWhen` / `resolveWhen` conditions until the instruction resolves or deflects. That is why a follow-up brief may carry the same pending instruction again with a different `phase` and a different `postcheck` frontier.

After the action graph resolves, `this.effects` runs. Effects may require additional resolution rounds.

See [arc-runtime-api.md](arc-runtime-api.md) for the full brief/report protocol and host integration contract.

## Examples

A node with child nodes, variables, and branching:

```js
function HeavyMetal() {
  this.displayName = "Heavy Metal";

  const interest = new Enum(['cold', 'lukewarm', 'curious', 'enthusiastic'], {
    observing: `how interested is ${user} in heavy metal`,
  });

  // action graph
  enter(Surface);
  if (interest > 'cold') {
    enter(Spark);
  }
  if (Spark.state === State.COVERED) {
    enter(Deeper);
  }

  // child node declarations
  function Surface() {
    this.guidance = `casual mention, don't push`;
    `Mention that ${self} has been listening to some great heavy metal lately.`;
  }

  function Spark() { ... }
  function Deeper() { ... }
}
```

Semantic routing with `judge()`:

```js
if (judge(`${user} wants to learn something specific`)) {
  enter(TeachTechnique);
} else if (judge(`${user} is just exploring`)) {
  enter(CasualExplore);
}
```

A non-resumable node — the action resolution map resets on each entry, so the user is asked about readiness every time:

```js
function SeeWine() {
  this.resumable = false;

  const ready = new Boolean({
    observing: `does ${user} have a glass of wine`,
  });

  observeOrAsk(ready);
  if (ready) {
    `
      Tell ${user} to hold their glass up to the light and observe the color.
      Note the difference between the center and the rim.
    `;
  } else {
    `Tell ${user} to get one glass and come back later.`;
  }
}
```
