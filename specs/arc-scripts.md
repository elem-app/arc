# Arc Scripts

Arc is a JS-like language for encoding structured information graphs. Each function declaration defines a **node** — a self-contained unit of state, logic, and content. Nodes compose into trees. The runtime walks those trees turn by turn, yielding structured briefs that a host application resolves. 

Although Arc scripts employ a JS-based syntax, they can only be executed by the Arc runtime and not a standard JavaScript runtime.

## Document Structure

An Arc script is a `.js` file (or more commonly, a `.arc.js` file). **Semicolons are required** after every statement.

The first statement is the version directive (the only supported version is v2):

```js
"use arc v2";
```

Each top-level function declaration is an **arc** — a root node that can be independently triggered and traversed:

```js
function HeavyMetal() {
  this.displayName = "Heavy Metal";
  // ...
}
```

A document may contain multiple arcs. `export` is not part of the Arc DSL.

Arcs can import roots from other documents via named imports:

```js
import { AdvancedTechniques } from "advanced-techniques";
```

Imported arcs are entered in the action graph with `enter(AdvancedTechniques)`, the same way as child nodes. See [Composition](#composition).

Host modules are imported with a default import whose source starts with `host:`:

```js
import Dice from "host:rng";
```

See [Host Calls](#host-calls) for more introduction about host modules.

### String Conventions

- **String literals** (`"..."` or `'...'`) — metadata and the version directive.
- **Template literals** (`` `...` ``) — semantic content interpreted by LLMs. Interpolated expressions (`${...}`) are type-checked for valid entity/variable references.

## Nodes

Every function declaration defines a node. Top-level functions are arcs. Nested function declarations inside a parent are child nodes.

A node body contains four sections, in order:

1. **Config statements** — `this.*` assignments that set metadata and lifecycle hooks.
2. **Variable declarations** — typed state scoped to this node.
3. **Action graph** — the executable logic that progresses turn by turn.
4. **Child node declarations** — nested function declarations.

Config, variables, and child declarations are **declarative** — they define fixed structure. The action graph is the only part that progresses through the brief/report cycle.

### Config Statements

`this.*` assignments at the start of a node body.

| Config             | Type             | Description                                                                                                    |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `this.displayName` | string literal   | Optional human-facing label. Presentation metadata only.                                                       |
| `this.description` | string literal   | Brief summary.                                                                                                 |
| `this.guidance`    | template literal | Guidance for content delivery.                                                                                 |
| `this.resumable`   | boolean literal  | Default `true`. When `false`, the action resolution map resets on re-entry. See [Execution Model](#execution-model). |
| `this.trigger`     | arrow function   | Trigger condition for dormant arcs. See [Trigger](#trigger).                                                   |
| `this.guard`       | arrow function   | Explicit state guard. See [Guard](#guard).                                                                     |
| `this.effects`     | arrow function   | Reactive observations and emitted host effects. See [Effects](#effects).                                       |

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
- **Instruction literal** (bare template literal) — content for the host to deliver to the user.
- `enter(ReferenceName)` — enters another node or arc by structural reference.

Expression-capable forms:

- ``judge(`semantic question`)`` — semantic boolean check against conversation context. Returns `boolean`.
- Host calls through imported `host:*` modules — yields a host-provided value. See [Host Calls](#host-calls).

`observe()` and `judge()` can also appear in `this.trigger` and `this.effects`.

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

### Host Calls

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

Three config functions control a node's lifecycle beyond its action graph: when the arc activates, whether a node should be entered, and what happens after actions resolve.

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

Nodes compose via two mechanisms, distinguished by ownership and scope:

**Child nodes** are function declarations nested inside a parent. They are owned by the parent — their traversal state is stored inline under it. Children can read outer variables through lexical scoping.

**Imported arcs** are roots from other arc documents imported at the top level. They have their own traversal lifecycle, managed directly by the runtime. Their scope is fully isolated — own variables, effects, and action graph.

Both are entered the same way with `enter(ReferenceName)`:

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

## Primitives

### Values

| Value  | Description             |
| ------ | ----------------------- |
| `user` | The human interlocutor. |
| `self` | The AI companion.       |

### Objects

**`State`** — node outcome values used in `ReferenceName.state` comparisons.

| Property          | Description                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `State.COVERED`   | All reachable actions and effects completed.                                             |
| `State.DEFLECTED` | The host reported a deflection (user redirected away). Eligible for re-entry.            |
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

The runtime yields a brief describing the pending work. The host resolves it and reports back. The runtime applies the report and, if the host proceeds, walks again. This loop continues until the action graph completes or the host defers/deflects.

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
