# Arc Scripts

Arc is a language for encoding structured information graphs. Arc scripts center around **nodes** — a self-contained unit of state, logic, and content. Nodes compose into trees. The runtime walks those trees and yields structured briefs that a host application resolves.

Arc has a familiar function-and-block surface syntax, but its semantics are its own. Arc scripts can only be executed by the Arc runtime.

## Document Structure

An Arc script is a `.arc` file, (or `.arc.js` file for more available grammar highlights).

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
3. **Action graph** — the executable logic that progresses through runtime walks.
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
| `this.catchDeflection` | arrow function | Deflection interception hook for the current node. See [CatchDeflection](#catchdeflection). |
| `this.guard`       | arrow function   | Explicit state guard. See [Guard](#guard).                                                                           |
| `this.effects`     | arrow function   | Reactive observations and emitted host effects. See [Effects](#effects).                                             |

Structural identity comes from the function declaration identifier, not metadata.

- `function HeavyMetal() {}` — structural identifier is `HeavyMetal`
- `this.displayName = "Heavy Metal"` — presentation metadata only
- `enter(HeavyMetal)` and `HeavyMetal.state` resolve by structural identifier or import binding

A **reference name** in Arc source is either a local node declaration identifier or a local import binding.

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

An action graph describes reachable work, not a one-time imperative block. Arc interprets it repeatedly against node state: resolved actions are skipped, conditions are re-evaluated when reached, and the next unresolved reachable action becomes the current frontier. This persisted graph state is what makes nodes stateful.

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

`observe()`, `judge()`, and `variable.set(...)` can also appear in hooks where their statement or expression positions make sense. `judge()` is expression-only.

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
- An arrow function uses the same hook statement subset as `this.trigger`: `if` / `else`, labeled blocks, labeled `break`, `observe(...)`, `variable.set(...)`, and `return <expression>`.
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

Labels are only allowed on block statements. `break` must specify a label. Labels and labeled `break` are supported in the main action graph, hook arrow functions, and `this.effects`.

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

### CatchDeflection

`this.catchDeflection` runs when a deflection reaches the current node. It can inspect the transient deflection context with `deflection.from(Target)`, perform hook-local work such as `observe(...)`, `judge(...)`, and `variable.set(...)`, and return `true` to catch the deflection for this node.

```js
function Main() {
  const wantsPricing = new Boolean();

  this.catchDeflection = () => {
    if (deflection.from(ProductIntro) && judge(`${user} wants pricing`)) {
      wantsPricing.set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing === true) {
    enter(Pricing);
    wantsPricing.set(false);
  }

  enter(ProductIntro);
}
```

Processing rules:

- `deflection.from(Target)` v1 accepts only a bare node/import target. It does not accept `fresh(Target)` or `reopen(Target)`.
- If the hook returns `true`, the current node catches the deflection and immediately rewalks its own action graph.
- If the hook returns false or is absent, the current node becomes `State.DEFLECTED`, runs uncaught-deflection effects, and propagates the deflection to its parent.
- A node's catch hook only prevents that node from becoming deflected. It does not undo the triggering child or instruction deflection.

### Guard

`this.guard` is evaluated when traversal reaches a node — after the parent's `if` condition passes but before the node's action graph runs. It may return a `State.*` value to resolve the node without entering it. If it returns `undefined`, traversal continues normally.

```js
this.guard = () => {
  if (musicSurfaced) return State.SKIPPED;
};
```

Guards are for explicit, unconditional node-state decisions. `if` conditions in the parent's action graph serve a different purpose — they are re-evaluated whenever the walk reaches them and route based on current state.

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
- `reopen(ReferenceName)` — a forced new entry on the canonical traversal for that node or arc.

`fresh(ReferenceName)` requests a new empty traversal instance for the current call. Fresh targets are ephemeral and non-addressable:

- They do not participate in `ReferenceName.state`.
- They are not queryable from Arc source.
- They are valid only as direct targets to `enter(...)` and `enterLoop(...)`.

For owned child nodes, `fresh(ReferenceName)` creates a fresh traversal instance of that child for the current call.

For imported arcs, `fresh(ReferenceName)` creates a fresh call instance of the imported arc. This does not reset, replace, or mutate the canonical imported-arc traversal managed by the runtime.

`reopen(ReferenceName)` forces a new entry on the canonical traversal for the current call:

- It preserves canonical identity and therefore still participates in `ReferenceName.state`.
- It preserves variable values and child traversals.
- It clears the current node frame before the reopened entry begins.
- It is valid only as a direct target to `enter(...)` and `enterLoop(...)`.

### Control Transfer

#### Enter

Enter primitives transfer control into another node or arc traversal. They use a target to decide which traversal instance to run, suspend caller progress until that target iteration reaches a terminal outcome or remains unresolved, and optionally wire caller variables through explicit `args` / `returns` channels.

Arc supports three enter forms:

- `enterLoop(Target, { resolveWhen, args?, returns? })`
- `enter(Target)`
- `enter(Target, { args, returns })`

`enterLoop(...)` is the primitive form. `enter(...)` is the convenience form layered on top of it.

Form rules:

- `enterLoop(...)` requires `resolveWhen`.
- `resolveWhen` accepts the same authored forms as instruction `resolveWhen`:
  - a template literal, which desugars to `return judge(...)`
  - an arrow function using the constrained statement subset allowed in `this.trigger`
- `enter(...)` does not expose authored `resolveWhen`. Its resolution depends on the target node state.

Target semantics:

1. `Target` may be `ReferenceName`, `fresh(ReferenceName)`, or `reopen(ReferenceName)`.
2. A target iteration transfers control into the referenced callee traversal.
3. If `Target` is `ReferenceName`, the callee outcome is reflected through `ReferenceName.state` (`COVERED`, `DEFLECTED`, `SKIPPED`).
4. If `Target` is `fresh(ReferenceName)`, the callee outcome is not reflected through `ReferenceName.state`.
5. If `Target` is `reopen(ReferenceName)`, the runtime starts a new entry on the canonical traversal before control transfers: prior terminal node state is cleared, the node frame is cleared, variable values and child traversals are preserved, and the reopened run's eventual outcome becomes the new meaning of `ReferenceName.state`.

Execution semantics:

1. The runtime runs one target iteration using the target semantics.
2. During that iteration, `args` reads from caller-backed cells and `returns.<name>.set(...)` stages output candidates on the callee traversal.
3. Each iteration reaches a definite callee node state.
   - For `enter(...)`, the action resolves when the callee reaches `COVERED` or `SKIPPED`. If the callee reaches `COVERED`, staged `returns` commit to caller cells. If the callee reaches `SKIPPED`, becomes `DEFLECTED`, or remains unresolved, staged `returns` do not commit.
   - For `enterLoop(...)`, the runtime evaluates `resolveWhen` in the caller context after a covered or skipped iteration. Covered iterations may stage `returns` candidates to the enclosing loop action, but caller cells are updated only if the whole `enterLoop(...)` action later resolves normally. If the callee becomes `DEFLECTED` or remains unresolved, the action remains unresolved.
4. If `enterLoop(...)` is not resolved after an iteration, the runtime begins a new iteration by entering the same target shape again while respecting the target semantics described above.

#### Args and Returns Processing

`enter(..., { args, returns })` and `enterLoop(..., { args, returns })` wire caller variables into child input/output channels:

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

Arc variables are containers (cells), not scalar bindings. `enter(...)`/`enterLoop(...)` therefore wires cells, not copied scalar values.

Channel behavior:

1. On child entry, `args` exposes caller-backed input cells under child-local names.
2. Child writes output candidates through `returns.<name>.set(...)`; this stages a candidate output for the enclosing `enter(...)`-family action rather than mutating caller cells immediately.
3. Caller cells update only when the enclosing `enter(...)` or `enterLoop(...)` action resolves normally.
4. Keys in `returns` that the child never sets do not change caller cells.

Write boundary:

- `returns.*.set(...)` is only valid inside `this.effects`.
- `args` is read-only from the child perspective.

This model keeps control-flow ownership in `enter(...)`/`enterLoop(...)` while making dataflow explicit at the call site.

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

Arc scripts are interpreted by the Arc runtime. The runtime handles control flow according to the action graph, and it works together with a supplied host which drives the runtime and handles semantic work or external effects.

```text
┌────────────┐                    ┌─────────┐                        ┌──────┐
│            │                    │         │  ── delegates to ──▶   │      │
│ Arc script │ ◀── interprets ──  │ Runtime │                        │ Host │
│            │                    │         │  ◀──── drives ──────   │      │
└────────────┘                    └─────────┘                        └──────┘
```

The runtime does not advance on its own like an event loop in a separate process or thread. A useful analogy is a kernel: The host drives runtime entry, the runtime interprets the graph and decides what work is now reachable and delegates some to the host. Delegated work later hands new facts back for the runtime to interpret and drives the runtime forward.

A node's action graph is the unit the runtime interprets. The runtime works the graph to find the next reachable action frontier. Reaching an action creates a delegation boundary. The runtime then delegates that action in one of two ways:

- to the host, for actions whose outcome must be supplied externally;
- to another node or arc's action graph, for `enter(...)` and `enterLoop(...)`.

Delegated work produces inputs back to the runtime, such as a host report or an entered node's resulting state. The runtime interprets those inputs and decides whether the current action resolves normally.

When an action resolves after changing traversal-visible state (for example, `observe(...)` or `variable.set(...)`) or callee outcome state (for example, `enter(...)` finishing with `State.COVERED`), the runtime re-walks the _smallest enclosing graph_ from the top, goes past resolved actions, and continues with the next reachable unresolved action. Arc progression is graph re-interpretation under updated state, not fallthrough from a stored statement pointer.

Deflection is separate from normal resolution. Instruction actions may deflect instead of resolving. The runtime pauses normal work and propagates the deflection to the nearest enclosing handler. If no handler catches it, deflection escapes the current work and the root traversal becomes deflected and suspended.

For traversal state, node state, node frames, and the brief/report protocol, see [arc-runtime-api.md](arc-runtime-api.md).

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
