# Arc Scripts

Arc is a language for encoding structured information graphs. Arc scripts center around **nodes** — a self-contained unit of state, logic, and content. Nodes compose into trees. The runtime walks those trees and yields structured briefs that a host application resolves.

Arc has a familiar function-and-block surface syntax, but its semantics are its own. Arc scripts can only be executed by the Arc runtime.

## Document Structure

An Arc script is a `.arc` file, or a `.arc.js` file when JavaScript editor tooling is useful. Arc intentionally uses a JavaScript-shaped surface syntax, so authors can lean on JavaScript grammar familiarity for functions, blocks, imports, calls, conditions, and template literals. Do not infer JavaScript runtime behavior: Arc accepts only the documented subset, and each construct has the Arc semantics defined in this spec.

The first statement of a standalone Arc script must always be the Arc directive:

```js
"arc";
```

Each function declaration defines a **node**; each document root-level node is an **arc**:

```js
"arc";

// This defines an arc
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

[Host modules](#host-modules) are imported with a default import whose source starts with `host:`:

```js
import Dice from "host:rng";
```

## Nodes

A node (function) body contains four sections, in order:

1. **Config statements** — `this.*` assignments that set metadata and hooks.
2. **Cell declarations** — typed state scoped to this node.
3. **Action graph** — the executable logic that progresses through runtime walks.
4. **Child node declarations** — nested function declarations.

Config, cells, and child declarations are **declarative** — they define fixed structure. The action graph is the only part that progresses through the brief/report cycle.

### String Conventions

Arc gives literal string syntax its meaning from the use site.

At semantic-text use sites — `$instruct(...)`, `$instructLoop(...)`, `judge(...)`, `$observe(...)`, `$observeOrAsk(...)`, `this.guidance`, `this.deflectWhen`, an instruction or `$enterLoop` `resolveWhen` / `deflectWhen`, cell `observing`, and inside host calls — authors may use either a string literal or a template literal. Template interpolation can mention `Dialog.user`/`Dialog.self` (and their shorthand forms `user`/`self`), artifacts, host variables, and ordinary value expressions. When this text is handed to the host, Arc renders ordinary value expressions to text and preserves semantic references for the host to render or route.

Semantic templates render lazily. A template is stored unevaluated where it is authored and renders each time its text is emitted to the host, using inner values current at that emission. A declaration-site template such as a cell's `observing` may therefore mention cells that are unset at declaration; an interpolation is a runtime error only when a render reaches it while its value is unset.

At value-expression use sites — for example `cell.$set(...)`, conditionals, comparisons, and hook returns — string and template literals produce ordinary string values. Semantic references such as `${Dialog.user}`/`${user}`, `${Dialog.self}`/`${self}`, artifacts, and host variables, as well as evaluating unset cells, are rejected.

### Arrow Functions

Arc uses arrow functions for hooks and authored resolution logic. An arrow may use either a block body or a concise expression body. In a value-returning position, `() => expression` is shorthand for `() => { return expression; }`.

### Config Statements

`this.*` assignments at the start of a node body.

| Config | Type | Description |
| --- | --- | --- |
| `this.displayName` | string literal | Optional human-facing label. Presentation metadata only. |
| `this.description` | string literal | Brief summary. |
| `this.guidance` | string literal or template literal | Guidance for content delivery. |
| `this.forgetfulEntry` | boolean literal | Default `false`. When `true`, each new entry is forgetful: it clears the prior outcome and action frame, so resolved-once actions run again. During the entry, resolved-once actions remain remembered normally. Cell values, child traversals, and canonical identity are preserved. |
| `this.trigger` | arrow function | Trigger condition for dormant arcs. See [Trigger](#thistrigger). |
| `this.deflectWhen` | string literal, template literal, or arrow function | Default deflection policy inherited by instruction actions in this node subtree. See [DeflectWhen](#thisdeflectwhen). |
| `this.catchDeflection` | arrow function | Deflection interception hook for the current node. See [CatchDeflection](#thiscatchdeflection). |
| `this.guard` | arrow function | Explicit state guard. See [Guard](#thisguard). |
| `this.effects` | arrow function | Reactive observations and emitted host effects. See [Effects](#thiseffects). |
| `this.hostParams` | object literal | Host-interpreted metadata carried on semantic work from this node. See [Host Params](#host-params). |

Each config may be assigned at most once in a node. A duplicate assignment is a parse error.

Structural identity comes from the function declaration identifier, not metadata.

- `function HeavyMetal() {}` — structural identifier is `HeavyMetal`
- `this.displayName = "Heavy Metal"` — presentation metadata only
- `$enter(HeavyMetal)` and `HeavyMetal.state` resolve by structural identifier or import binding

A **reference name** in Arc source is either a local node declaration identifier or a local import binding.

### Cells

Cells are a node's persistent typed state. Each cell is scoped to the node that declares it and holds a typed inner value.

Inner values are written only through dedicated channels: `cell.$set(...)`, a resolved `$observe(...)` or `$observeOrAsk(...)` report, and `returns` committed by a covered `$enter(...)` (see [Control Transfer](#control-transfer)).

A cell starts _unset_ and stays so until a write action provides its inner value. It becomes unset again when `cell.$unset()` resolves. Using a cell in a value position attempts its inner value: a set cell produces the inner value, while an unset cell resolves only where [Operators](#operators) define a result for an unset operand, and any other evaluation of it raises a runtime error. Member forms target the cell itself rather than its inner value and stay available while unset: `cell.isUnset()` reports whether the cell is unset, and `$set`, `$unset`, `observing`, and observation calls work the same way on set and unset cells.

Cells are declared with `let` inside a node body:

```js
let interest = Enum(["cold", "lukewarm", "curious", "enthusiastic"], {
  observing: `how interested is ${user} in heavy metal`,
});

let musicSurfaced = Bool({
  observing: `has ${user} mentioned a specific band or song`,
});

let topic = Str({
  observing: `what topic has ${user} mentioned`,
});

let skill = RangedInt(1, 10, {
  observing: `how skilled ${user} feels at this`,
});

let startedAt = Dialog.Cursor();

let researchLog = Artifact("research-log.md");
let reportName = Str();
let report = Artifact(`reports/${reportName}.md`);
```

`observing` sets the default observation question for `$observe(cell)` and `$observeOrAsk(cell)`. It may be defined once, either in the declaration config or later with `cell.observing = ...`. A second definition is a parse error. The question can be overridden per-call with a second argument.

| Cell type | Description | Params |
| --- | --- | --- |
| `Enum(values, config?)` | Ordered string enum. Comparisons use ordinal position. | `values: string[]` |
| `Bool(config?)` | True/false flag. |  |
| `Str(config?)` | Arbitrary plain string value. |  |
| `RangedInt(min, max, config?)` | Bounded integer. | `min: number, max: number` |
| `Dialog.Cursor()` | Snapshot of a scoped dialog cursor. |  |
| `Artifact(path)` | Semantic reference to a host artifact. | `path: string or value template` |
| `Array(elementCell)` | Ordered list of one element shape. See [Arrays](#arrays). | `elementCell: constructed scalar observable cell` |

The optional `config` object supports `observing`, a string literal or template literal.

Only `Enum`, `Bool`, `Str`, `RangedInt`, and `Array` cells are observable; `$observe(...)` and `$observeOrAsk(...)` accept only these types, whether observed singly or in a group (see [Grouped Observation](#grouped-observation)). `Array` cells are covered under [Arrays](#arrays).

Enum comparisons use **ordinal position** within the declared values array. For `Enum(["cold", "lukewarm", "curious", "enthusiastic"])`, `interest >= "lukewarm"` is true when `interest` is `"lukewarm"` (index 1), `"curious"` (index 2), or `"enthusiastic"` (index 3).

`Dialog.Cursor`s are local value cells. They are assigned with `cell.$set(Dialog.cursor)` and used as the receiver or argument of the `cursor.*TurnsSince(...)` methods.

`Artifact(path)`s are local mention-only cells: their inner value is the artifact reference declared at the cell, and they are valid only as semantic text interpolation references. `$set(...)` and `$unset()` are rejected on artifacts:

```js
let researchLog = Artifact(/*...*/);
$instruct(`Read ${researchLog}`);
```

`path` is a logical path relative to the host's workspace for the current Arc run. It may be a string literal or a value-position template literal such as `` `reports/${reportName}.md` ``. Path template interpolation may use ordinary value expressions, including Arc cells, and may not use semantic-only references such as `${user}`, `${self}`, artifacts, or host variables. A template path renders each time the artifact is mentioned, using inner values current at that mention. The rendered path must be a non-empty relative path and may not contain `.` or `..` path segments.

#### Arrays

`Array(elementCell)` declares an array cell whose inner value is an ordered list of one element shape. The element is a constructed scalar observable cell — `Bool`, `Str`, `Enum`, or `RangedInt` — declared once and instanced by every stored element:

```js
let findings = Array(Str({ observing: `a finding ${user} mentioned` }));
let scores = Array(RangedInt(1, 5));
```

The element's `observing` is the per-item extraction question for observation. `Array(Str)` (a bare constructor), a nested array, and extra arguments are parse errors.

An array cell holds a whole list value and supports:

- whole-value `$set(...)` and `$unset()`,
- `items[index]` as an element-value read,
- `items[index].$set(...)` as an existing-element cell write,
- `items.length` as a non-negative-integer read,
- `items.isUnset()`,
- observation as a whole collection or as one element.

An action cell target is a lexical cell name followed by zero or more accesses into its inner value. A direct target such as `items` addresses the whole cell; `items[i]` is a synthetic subcell target whose access expression is evaluated when the action reaches it. Arrays are the only inner-value container currently implemented, so object-field paths are not yet valid targets.

An element target must select an existing position. `$set(...)` replaces that element without changing its siblings, and `$observe(items[i])` briefs and writes the scalar element using the element's type and `observing` question. `$unset()` remains a whole-cell operation: `items[i].$unset()` is a parse error because array values are dense and have no unset element slots. An array literal is a contextually typed value where a compatible array type can be inferred, as in `items.$set(["a", "b"])` or `items == ["a", "b"]`; each element is validated against the element shape.

Equality and inequality compare ordered element values structurally, and the shared unset-comparison rule applies unchanged (equality involving an unset array is `false`, inequality is `true`). Ordering, arithmetic, and boolean evaluation of a whole array are rejected. Template interpolation renders an array by JavaScript array stringification — elements joined with commas, an empty array as the empty string.

Indexing, targeting an element, or reading `length` on an unset array is a runtime error, as is an out-of-range or non-integer index. A whole-array write validates every element; an element write or observation validates its scalar value against the element shape before replacing the parent array.

#### Operators

Operators combine cell values and literals into a result. Arc supports comparison operators and logical operators.

Comparison operators pair two values and produce a boolean:

- Equality — `==` and `!=` — compares by value. Scalars are equal when their values are identical; arrays are equal when they hold the same elements in the same order (see [Arrays](#arrays)). When either operand is an unset cell, `==` is `false` and `!=` is `true`. Arc applies no type coercion.
- Ordering — `>`, `>=`, `<`, and `<=` — compares magnitude. Numbers order numerically, enum values order by ordinal position within the cell's declared values, and other values order lexicographically by their string form. When either operand is an unset cell, all four are `false`. Arrays have no ordering.

`&&` and `||` are logical conjunction and disjunction over boolean operands, producing a boolean. Each short-circuits: `&&` evaluates its right operand only when its left is `true`, and `||` only when its left is `false`, so a blocking or effectful right operand runs only where the left has not already decided the result.

`!` returns the negation of its operand.

The ternary `test ? consequent : alternate` returns its consequent when the test is `true` and its alternate otherwise, evaluating only the branch it returns. Unlike `&&` and `||`, it selects a value: its branches may be any type.

### Action Graph

The action graph is the executable part of a node body. It contains actions and the control flow that routes between them.

The Arc runtime executes the graph's authored control flow. Work requiring host or child coordination may suspend execution until the host supplies a report or the child finishes.

Resolved-once actions are always prefixed with `$`, as can be seen below in `$instruct(...)`, `cell.$set(...)`, and `Memoir.facts.$apply(...)`. Once a `$` action resolves, subsequent runs of its containing node bypass it unless its execution context explicitly gives it fresh action state — for example, a forgetful entry or a new run of an enclosing `invoke(...)`.

#### Action Forms

Some action forms are statement-only. Others can also appear inside expressions.

Statement forms:

- `$observe(target)` — passive extraction from conversation using the target's `.observing` question text.
- ``$observe(target, `override question`)`` — passive extraction with a specific observation question.
- `$observeOrAsk(target)` — extraction with fallback to asking the user.
- ``$observeOrAsk(target, `override question`)`` — extraction with a specific observation question, fallback to asking.
- `$observe({ cellA, cellB })` — grouped extraction of several cells as one action. See [Grouped Observation](#grouped-observation).
- `$observeOrAsk({ cellA, cellB })` — grouped extraction with fallback to asking the user.
- `target.$set(value)` — typed direct-cell or existing-array-element write.
- `cell.$unset()` — clear a cell's inner value.
- `$instruct(text, { deflectWhen?, hostParams? })` — one-shot instruction.
- `$instructLoop(text, { resolveWhen, deflectWhen?, hostParams? })` — sticky instruction with authored resolution logic.
- `$enter(Target)` — enters a node or arc target.
- `$enter(Target, { args, returns })` — enters a node or arc target with explicit input/output cell wiring.
- `$enterLoop(Target, { resolveWhen, args?, returns? })` — repeatedly enters a target until the caller-authored loop condition resolves true.
- `arr.$map(callback, results?)` — runs a callback once per array element, optionally building a new array. See [Map](#map).

Expression-capable forms:

- ``judge(`semantic question`)`` — semantic boolean check against conversation context. Returns `boolean`.
- Host calls through imported `host:*` modules — yields a host-provided value. See [Host Modules](#host-modules).

`$observe()`, `target.$set(...)`, and `cell.$unset()` can also appear in hooks. Hooks can use expression-capable forms in their expressions. `this.catchDeflection` hook also allows `$observeOrAsk(...)`.

##### Grouped Observation

`$observe({ a, b })` and `$observeOrAsk({ a, b })` observe several cells as one resolved-once action. The object literal binds cells by same-name binding: each entry is a shorthand property naming an observable cell, and a renamed entry such as `{ x: age }`, a computed key, or a spread is a parse error. Each cell is observed with its own `.observing` question, so the grouped forms take no override question.

The action is atomic. The host extracts the whole set in one inference and reports every field in one report; the runtime applies that report as a unit and holds no per-field progress. When the report resolves all fields, the action writes them together. A `$observe({ ... })` field the host returns as `unknown` is skipped and its cell left unchanged. A `$observeOrAsk({ ... })` report that leaves any field pending re-emits the whole group and writes nothing until one report resolves every field.

#### Host Params

`this.hostParams` is optional host-interpreted node metadata for semantic work emitted by that node. Arc carries it on every judgment, observation, host-call, and instruction brief produced from the node.

```js
function Review() {
  this.hostParams = {
    role: "reviewer",
    mode: "foreground",
  };

  $observe(verdict);
  $instruct(`Review the current answer.`);
}
```

The value may be any scalar value or an array or object of scalar values with non-computed keys. Template literals are value expressions and are not valid inside `hostParams`.

Arc never interprets these keys. Which ones are meaningful, and what they select — the agent that carries out the node's work, the dialog view the node evaluates under — belongs to the host the arc is deployed on; write them as that host documents them. Host params do not inherit: each node declares its own or supplies none.

#### Instructions

Instruction actions are authored guidance that the runtime hands to the host. Unlike value-style actions, reaching an instruction does not immediately block on a single required value. Instead, the runtime first emits guidance, then derives the instruction outcome from authored `deflectWhen` / `resolveWhen` logic over subsequent handbacks.

Arc supports three instruction forms:

```js
$instruct(`Mention heavy metal naturally.`);

$instructLoop(`Keep developing this topic.`, {
  resolveWhen: `${self} has covered the topic enough`,
});

$instruct(`Mention this once.`, {
  hostParams: {
    mode: "background",
  },
  deflectWhen: `${user} clearly does not want this topic`,
});
```

The instruction text may be a string literal or template literal. Template instruction text may interpolate semantic mentions such as `user`, `self`, and artifacts, plus value expressions such as cells, comparisons, and ternary conditionals.

`resolveWhen` and `deflectWhen` define authored instruction semantics:

- A string literal or template literal desugars to `return judge(...)`.
- An arrow function uses the same hook statement subset as `this.trigger`: `if` / `else`, labeled blocks, labeled `break`, `$observe(...)`, `cell.$set(...)`, `cell.$unset()`, and `return <expression>`.
- Expressions inside those functions may use cells, `judge(...)`, host calls, regex tests, and logical composition.

Authoring rules:

- `$instructLoop(...)` is sticky and requires `resolveWhen`.
- `$instruct(...)` is one-time and does not support `resolveWhen`.
- `deflectWhen` is optional on both forms.
- If an instruction omits `deflectWhen`, it inherits the nearest node-level `this.deflectWhen`, if any.

Execution semantics:

1. When traversal first reaches an instruction, the runtime emits the instruction text and marks the action pending.
2. While the instruction is pending, the runtime evaluates `deflectWhen` first, then `resolveWhen`.
3. If `deflectWhen` becomes true, the traversal is deflected.
4. If `resolveWhen` becomes true, the instruction action resolves and traversal continues.
5. Otherwise the instruction remains pending and continues to apply on later handbacks.
6. `$instruct(...)` resolves implicitly when the host reports back, unless it is deflected.

Only the currently reachable semantic checks from `deflectWhen` / `resolveWhen` surface in a given brief. See [arc-runtime-api.md](./arc-runtime-api.md) for the `InstructionBrief` and `postcheck` protocol.

An instruction may carry an optional `hostParams` that will be merged over (or override) node-level `this.hostParams` when both values are plain objects (or when either is a scalar or an array). Semantic work emitted while evaluating that instruction's `deflectWhen` or `resolveWhen` uses the same merged host params. See node-level [`hostParams`](#host-params) for its semantics and constraints.

#### Control Flow

- `if`/`else` — conditional branching based on cell state, `ReferenceName.state`, `judge()` results, or regex tests.
- `label: { ... }` — a labeled block that establishes a lexical control-flow region.
- `break label;` — exits the nearest enclosing labeled block whose label matches.

Labels are only allowed on block statements. `break` must specify a label. Labels and labeled `break` are supported in the main action graph and hook arrow functions.

Example:

```js
branch: {
  if (interest >= "lukewarm") {
    $enter(Spark);
    break branch;
  }

  $enter(Surface);
}

$enter(Afterward);
```

If `interest >= "lukewarm"` is true, control exits the `branch` block after `$enter(Spark)` and continues at `$enter(Afterward)`. Otherwise the walk falls through to `$enter(Surface)` before leaving the block.

#### Arrow Invocation

`invoke(() => { ... })` runs an attached action-graph body inline. The invocation itself does not carry resolved-once semantics, and each run treats the `$` actions in its body as unresolved. If a run blocks, a later report resumes that run.

```js
invoke(() => {
  ready.$set(interest >= "lukewarm");
});
```

The body shares the enclosing node's cell scope: it declares no cells of its own and reads and writes the enclosing node's cells directly. The body admits the full node-body action-graph dialect — `$enter(...)`, `$enterLoop(...)`, `$instruct(...)`, `$instructLoop(...)`, and a nested `invoke(...)`, alongside `cell.$set(...)`, `cell.$unset()`, `$observe(...)`, `$observeOrAsk(...)`, `judge(...)` (in expressions), and `if` / `label` / `break`. Labels and `break` are local to the body.

Not supported: `return`, parameters or call arguments, the `function`-expression form, and `let` / `this.*` / `function` declarations inside the body. These are rejected at parse time — the body is a pure action graph over the enclosing scope.

#### Map

`arr.$map(callback, results?)` runs a callback once per element of an array. With `results` it builds a new array of the same length; without it the callback runs for its effects only. It is a resolved-once action and never writes its receiver.

The callback is a zero-argument arrow attached to the `$map`. Inside it, `span` channel names the current element:

- `span.item` — the current element's value.
- `span.index` — the current element's zero-based position.
- `span.result` — this element's output, written with `span.result.$set(value)`. It exists only when `results` is bound.

The primary form enters a node per element, wiring `span` through the node's channels:

```js
input.$map(
  () =>
    $enter(newcopy(Op), {
      args: { in: span.item, idx: span.index },
      returns: { out: span.result },
    }),
  output,
);
```

`span.item` and `span.index` bind into a child's `args`; `span.result` binds as a `returns` sink the child writes (see [Args and Returns](#args-and-returns)). `span.item` and `span.index` are read-only `args` sources, and `span.result` is a `returns` sink only. A value transform can write `span.result` directly instead: `() => span.result.$set(expression)`.

`span.item` has the receiver's element type and `span.result` has the `results` element type. A write of an incompatible type is rejected before the script runs rather than failing at runtime — `intCell.$set(span.item)` where the receiver holds strings, or `span.result.$set(0)` where `results` holds strings.

The callback admits the same actions as an `invoke` body — control flow, `cell.$set(...)`, observations, instructions, `$enter(...)`, `$enterLoop(...)`, and a nested `invoke(...)`. Every `$enter(...)` target in the callback must be `newcopy(...)`, so each element runs its own copy.

Results and length:

- The receiver may be an array cell or a typed `args`/`returns` array channel; `$map` never writes it.
- `results` is a bare array cell whose element type must match what the callback produces. The outputs commit to it in one write, in element order, when the whole `$map` resolves.
- With `results` bound, every element must set `span.result`; an element that finishes without one is a runtime error. Referencing `span.result` in a forEach `$map` is a parse error.
- `$map` preserves length: one output per input, no filtering. `results` may be the receiver itself, replacing it in one write.

The callback may block on an observation, an instruction, or an entered child that waits on the host. Elements run one at a time, and a blocked element resumes where it left off on the next report. A deflection escaping an element aborts the whole `$map`, discarding any outputs earlier elements produced, and reaches the node's `this.catchDeflection`, where `escaped(...)` matches the callback's authored target. Cell writes and host effects that earlier elements already applied stay applied.

#### Resolution Rules

Different actions and expressions resolve as follows:

| Form | Resolution rule |
| --- | --- |
| `cell.$set(value)` | Resolves after the value expression is available and the typed write succeeds. |
| `cell.$unset()` | Resolves after clearing the inner value. Artifact cells reject this action. |
| `$observe(cell)` | Resolves after the host reports an observation result. A `resolved` result writes the reported value. An `unknown` result consumes the action and preserves any existing value. Prior `$set(...)` writes provide the observation's current value; they do not resolve the `$observe(...)` action. |
| `$observeOrAsk(cell)` | Resolves after the host reports a concrete value. |
| `$observe({ ... })` / `$observeOrAsk({ ... })` | Resolves after the host reports results for every field in one report. All `resolved` fields are written together; `unknown` fields are skipped. A grouped `$observeOrAsk` whose report leaves any field pending re-emits the whole group and writes nothing. See [Grouped Observation](#grouped-observation). |
| `$instruct(...)` | Resolves on the host handback unless its effective `deflectWhen` deflects first. |
| `$instructLoop(...)` | Resolves when its `resolveWhen` evaluates true. While pending, the runtime checks `deflectWhen` before `resolveWhen` on each handback. |
| `$enter(Target)` | Resolves when the target traversal reaches `State.COVERED` or `State.SKIPPED`. Covered targets commit staged `returns`; skipped targets resolve without committing staged `returns`. |
| `$enterLoop(Target, { resolveWhen, ... })` | Resolves after a covered or skipped target iteration when the caller-side `resolveWhen` evaluates true. Otherwise the loop action remains pending or starts another target iteration. |
| `judge(...)` and expression-position host calls | These are value dependencies, not standalone statement actions. A host report supplies the value. |
| `invoke(() => { ... })` | Does not carry resolved-once semantics. Each run treats the `$` actions in its body as unresolved; a blocked run resumes on the next report. |
| `arr.$map(callback, results?)` | Resolves after the callback has run for every element. With `results`, commits the constructed array in one write. A blocked element resumes on the next report. |

### Expressions

Arc expressions are shared across value positions, including `if` tests, hook returns, `cell.$set(...)` values, template interpolations, and expression-position host calls. They support:

- Value-bearing cell references — `interest`, `musicSurfaced`, `startedAt`
- Comparisons — `interest >= "lukewarm"`, `ready == true`
- Node state checks — `Spark.state == State.COVERED`
- Semantic checks — ``judge(`semantic question`)``
- Host calls — `Dice.roll(20)`, `Store.flags.enabled()`
- Regex tests — `/pattern/flags.test(target)` (e.g., `/music|band/i.test(Dialog.lastUserMessage)`)
- Cursor turn differences — `Dialog.cursor.userTurnsSince(startedAt)`, `endedAt.totalTurnsSince(startedAt)`
- Unset checks — `topic.isUnset()`, `startedAt.isUnset()`
- Logical composition — `&&`, `||`, `!`
- Ternary conditionals — `ready ? "continue" : "wait"`

Comparison and logical composition evaluate by the rules in [Operators](#operators).

A **boolean position** — an `if` test, the operands of `&&`, `||`, and `!`, a ternary test, and a `this.trigger`, `this.catchDeflection`, `resolveWhen`, or `deflectWhen` return — accepts only a boolean value, without coercion. A comparison, `&&` / `||` / `!`, `judge(...)`, a regex `.test(...)`, `.isUnset()`, `this.deflection.escaped(...)`, and a set `Bool` cell are booleans; a `Str`, `RangedInt`, `Enum`, `Dialog.Cursor`, or array value is not, and must be compared explicitly — `count > 0`, never `count`.

A non-boolean value in a boolean position is rejected at parse time when its type is statically known, and poisons the traversal at runtime otherwise. An unset `Bool` used bare poisons the traversal too — its type passes the parse check, but there is no boolean to read — so either compare it (`== true` / `== false`, which are `false` on an unset cell) or ensure it is set before the bare read.

Artifact cells are not value-bearing expression references. They may appear only as direct template interpolation mentions.

### Host Modules

Host modules let arcs interact with host-owned systems — rolling dice, reading feature flags, writing to memoir. The arc declares what it needs; the host decides what the call means.

Host modules are imported with a default import whose source starts with `host:`:

```js
import Dice from "host:rng";
import Memoir from "host:memoir";
```

A host module exposes a namespace under the imported binding. Arc reaches into that namespace through member access at any depth. A callable path such as `Dice.roll(...)` or `Dice["tables"].roll(...)` asks the host to perform an operation. A bare member path such as `Audience.supervisor`, `Audience.group.supervisor`, or `Audience["supervisor"]` mentions a host-owned symbolic variable. Paths may use dot segments or static string-literal bracket segments.

A host import can be used in three ways:

**Expression position** — a host call that asks the host for a value. The call blocks until the host reports back.

```js
let lucky = Bool();
lucky.$set(Dice["tables"].roll(20) >= 10);

if (lucky) {
  $instruct(`That was a critical hit.`);
}
```

**Statement position inside `this.effects`** — a host call that emits an external effect.

```js
this.effects = () => {
  Memoir.facts.$apply(`${user} survived the tavern brawl`);
};
```

Host effects must prefix the operation name with `$`, as in `Memoir.facts.$apply(...)`.

**Template interpolation** — a host variable mentioned inside semantic text. The host variable carries a reference for the host to render or route when it consumes the text.

```js
import Audience from "host:audience";

$instruct(`Ask ${Audience["supervisor"]} whether the plan is acceptable.`);
```

Host variables are valid only inside template literals. `Audience.supervisor`, `Audience.group.supervisor`, and `Audience["group"]["supervisor"]` are host variables. Bracket segments must be static string literals, so `Audience[role]` is not a host variable. `Audience.supervisor()` is a host call, not a host variable, and follows the same static segment rule.

Arguments to a host call must be renderable without further host work: a host call may not appear inside another host call's arguments. Template-literal arguments follow the same semantic text rendering as judgments, observations, and instructions, so they may preserve `user`, `self`, artifact mentions, and host-variable mentions for host rendering.

## Hooks

Hooks are node config entries that control behavior beyond the action graph: when the arc activates, how pending instructions deflect, how deflections are caught, whether a node should be entered, and what happens after actions resolve. `this.trigger`, `this.catchDeflection`, `this.guard`, and `this.effects` are written as arrow functions; `this.deflectWhen` accepts either an arrow function or a template-literal shorthand.

### `this.trigger`

`this.trigger` is evaluated when the arc is dormant. It returns `true` to activate the arc for traversal. Only meaningful on arcs (top-level nodes).

```js
this.trigger = () => {
  if (
    this.enterCount == 0 &&
    /music|band/i.test(Dialog.lastUserMessage) &&
    judge(`${user} mentions music, bands, or concerts`)
  ) {
    $observe(interest);
    return true;
  }
  if (
    this.enterCount == 0 &&
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
- `judge()` and `$observe()` calls become part of the trigger brief and may be batched.
- `$observe()` calls execute only on the branch that returns `true`. Branches that do not match are not evaluated — their `$observe()` and `judge()` calls do not run.

### `this.deflectWhen`

`this.deflectWhen` defines the default deflection policy for instruction actions in the current node and its descendants. It is consulted only while a reachable instruction remains pending; it is not a node-entry hook like `this.guard`.

```js
this.deflectWhen = () => {
  if (judge(`${user} wants to leave this topic`)) {
    return true;
  }
};
```

It accepts the same two authored forms as instruction-level `deflectWhen`:

- a string literal or template literal, which desugars to `return judge(...)`;
- an arrow function using the trigger-style subset.

Inheritance rules:

- A node's own instruction actions inherit `this.deflectWhen` by default.
- Child nodes inherit the nearest ancestor `this.deflectWhen` unless they define their own.
- An instruction-level `deflectWhen` overrides the inherited node default.

### `this.catchDeflection`

`this.catchDeflection` runs when a deflection reaches the current node. It can inspect the transient deflection context through the `this.deflection` accessor, perform hook-local work such as `$observe(...)`, `$observeOrAsk(...)`, `judge(...)`, and `cell.$set(...)`, and return `true` to catch the deflection for this node.

```js
function Main() {
  let wantsPricing = Bool();

  this.catchDeflection = () => {
    if (
      this.deflection.escaped(ProductIntro) &&
      judge(`${user} wants pricing`)
    ) {
      wantsPricing.$set(true);
      return true;
    }
    return false;
  };

  if (wantsPricing == true) {
    $enter(Pricing);
    wantsPricing.$set(false);
  }

  $enter(ProductIntro);
}
```

Processing rules:

- `this.deflection.escaped(Target)` reports whether the pending deflection came up into the current node through one of its own `$enter(Target)`/`$enterLoop(Target)` sites. This form accepts only a bare node/import target. It does not accept `newcopy(Target)` or `forgetful(Target)` as the argument.
- If the hook returns `true`, the current node catches the deflection and runs its own action graph again while respecting existing `$`-action resolutions: actions that have already resolved are bypassed.
- If the hook returns false or is absent, the current node begins deflected finalization. Its state remains unset while uncaught-deflection effects run; after they finish, the node becomes `State.DEFLECTED` and propagates the deflection to its parent.
- A node's catch hook only prevents that node from becoming deflected. It does not undo the triggering child or instruction deflection.

### `this.guard`

`this.guard` is evaluated when traversal reaches a node — after the parent's `if` condition passes but before the node's action graph runs. It may return a `State.*` value to resolve the node without entering it. If it returns `undefined`, traversal continues normally.

```js
this.guard = () => {
  if (musicSurfaced) return State.SKIPPED;
};
```

Guards make unconditional node-entry decisions. An `if` in the parent instead routes control within the parent's action graph.

### `this.effects`

`this.effects` runs when the node's action graph cannot progress further — whether all actions resolved or traversal stopped early (e.g., a child was deflected). Effects handle post-traversal bookkeeping: extracting final cell values and emitting host effects.

While effects run, the node's terminal `state` remains unset. `this.pendingState` exposes the outcome being finalized: `State.COVERED` after normal graph completion or `State.DEFLECTED` after an uncaught deflection. During deflected effects, `this.deflection.escaped(Target)` reports whether the deflection came up through one of this node's own entries of `Target`. The runtime commits the pending state to the node's terminal state only after every effect finishes. `this.pendingState` is available only inside `this.effects`; `this.deflection` is unavailable during covered effects.

```js
import Memoir from "host:memoir";

this.effects = () => {
  $observe(interest);
  $observe(musicSurfaced);
  if (this.pendingState == State.DEFLECTED) {
    Memoir.facts.$apply(`${user} left before this node completed`);
    if (this.deflection.escaped(ProductIntro)) {
      Memoir.facts.$apply(`${user} left during the product introduction`);
    }
  }
  if (interest >= "curious") {
    musicSurfaced.$set(true);
  }
  if (interest >= "curious") {
    Memoir.attitude.$apply(`be more enthusiastic about music with ${user}`);
  }
  if (musicSurfaced == true) {
    Memoir.facts.$apply(
      `${user} has shown interest in specific heavy metal music`,
    );
  }
};
```

- `$observe()` calls use the cell's declared `.observing`.
- `cell.$set(value)` performs a type-checked write.
- `cell.$unset()` clears the inner value.
- Host effects prefix the operation name with `$`, as in `Memoir.facts.$apply(...)`.

Effects statements execute sequentially. `$observe()` is best-effort: if the host reports `unknown`, execution continues without writing a new value.

## Composition

Arc has two distinct composition layers:

- **Structural composition (declaration-time)** — how nodes/arcs are declared and related in source.
- **Execution composition (runtime)** — how control transfers between declared units during traversal.

Structural composition uses two mechanisms, distinguished by ownership and scope:

**Child nodes** are function declarations nested inside a parent. They are owned by the parent — their traversal state is stored inline under it. Children can read outer cells through lexical scoping.

**Imported arcs** are roots from other arc documents imported at the top level. They have their own traversal lifecycle, managed directly by the runtime. Their scope is fully isolated — own cells, effects, and action graph.

Execution composition uses `$enter(ReferenceName)` for both forms:

```js
"arc";

import { AdvancedTechniques } from "advanced-techniques";

function CookingTogether() {
  this.displayName = "Cooking Together";

  $enter(ShareRecipe);
  if (ShareRecipe.state == State.COVERED) {
    $enter(AdvancedTechniques);
  }

  function ShareRecipe() {
    $instruct(`Share a simple recipe with ${user}.`);
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
- `newcopy(ReferenceName)` — a blank anonymous copy of that node or arc.
- `forgetful(ReferenceName)` — a forced forgetful entry of the canonical node or arc.

A node may not enter itself in any form: `$enter(...)` and `$enterLoop(...)` are rejected at parse time when the target resolves to the enclosing node, whether bare, `forgetful(...)`, or `newcopy(...)`.

`newcopy(ReferenceName)` requests a blank anonymous copy for the current call. Anonymous copies are non-addressable:

- They do not participate in `ReferenceName.state`.
- They are not queryable from Arc source.
- They are valid only as direct targets to `$enter(...)` and `$enterLoop(...)`.

For owned child nodes, `newcopy(ReferenceName)` creates a blank anonymous copy of that child for the current call.

For imported arcs, `newcopy(ReferenceName)` creates a blank anonymous copy of the imported arc. This does not reset, replace, or mutate the canonical imported arc managed by the runtime.

If an anonymous copy blocks, the same copy resumes for that call. Once the copy reaches a terminal outcome, a later entry at that action site replaces it with a blank copy.

`forgetful(ReferenceName)` forces a forgetful entry of the canonical traversal for the current call, regardless of the target node's `forgetfulEntry` configuration:

- It preserves canonical identity and therefore still participates in `ReferenceName.state`.
- It preserves cell values and child traversals.
- It clears the prior canonical outcome.
- It clears the action frame before the forgetful entry begins.
- It is valid only as a direct target to `$enter(...)` and `$enterLoop(...)`.

The forgetting happens once when the new entry begins. If that entry blocks, its later report resumes the same traversal without forgetting again. Each continuing `$enterLoop(forgetful(...))` iteration begins another forgetful entry of the canonical target.

### Control Transfer

#### Enter

Enter primitives transfer control into another node or arc traversal. The target selects the canonical traversal or a blank anonymous copy, suspends caller progress until that target iteration reaches a terminal outcome or remains unresolved, and optionally wires caller cells through explicit `args` / `returns` channels.

Arc supports three enter forms:

- `$enterLoop(Target, { resolveWhen, args?, returns? })`
- `$enter(Target)`
- `$enter(Target, { args, returns })`

`$enterLoop(...)` is the primitive form. `$enter(...)` is the convenience form layered on top of it.

Form rules:

- `$enterLoop(...)` requires `resolveWhen`.
- `resolveWhen` accepts the same authored forms as instruction `resolveWhen`:
  - a string literal or template literal, which desugars to `return judge(...)`
  - an arrow function using the constrained statement subset allowed in `this.trigger`
- `$enter(...)` does not expose authored `resolveWhen`. Its resolution depends on the target node state.

Target semantics:

1. `Target` may be `ReferenceName`, `newcopy(ReferenceName)`, or `forgetful(ReferenceName)`.
2. A target iteration transfers control into the referenced callee traversal.
3. If `Target` is `ReferenceName`, the callee outcome is reflected through `ReferenceName.state` (`COVERED`, `DEFLECTED`, `SKIPPED`).
4. If `Target` is `newcopy(ReferenceName)`, the callee outcome is not reflected through `ReferenceName.state`.
5. If `Target` is `forgetful(ReferenceName)`, the runtime starts a forgetful entry on the canonical traversal before control transfers: prior terminal node state and action-frame progress are forgotten, cell values and child traversals are preserved, and the entry's eventual outcome becomes the new meaning of `ReferenceName.state`.

Execution semantics:

1. The runtime runs one target iteration using the target semantics.
2. During that iteration, `args` reads from caller-backed cells and `returns.<name>.$set(...)` stages output candidates on the callee traversal.
3. Each iteration reaches a definite callee node state.
   - For `$enter(...)`, the action resolves when the callee reaches `COVERED` or `SKIPPED`. If the callee reaches `COVERED`, staged `returns` commit to caller cells. If the callee reaches `SKIPPED`, becomes `DEFLECTED`, or remains unresolved, staged `returns` do not commit.
   - For `$enterLoop(...)`, the runtime evaluates `resolveWhen` in the caller context after a covered or skipped iteration. Covered iterations may stage `returns` candidates to the enclosing loop action, but caller cells are updated only if the whole `$enterLoop(...)` action later resolves normally. If the callee becomes `DEFLECTED` or remains unresolved, the action remains unresolved.
4. If `$enterLoop(...)` is not resolved after an iteration, the runtime begins a new iteration by entering the same target shape again while respecting the target semantics described above.

#### Args and Returns

A node's `args` and `returns` are its input and output channels: `args` let it read cells owned by other nodes and `returns` let it write them, in a managed way rather than by the direct lexical access a node has to its own cells.

A node declares each channel as an `args`/`returns` parameter defaulted to an object literal of keys and their types:

```js
function Op(
  args = {
    input: Str(),
    idx: Index(),
  },
  returns = {
    output: Str(),
  },
) {
  this.effects = () => {
    returns.output.$set(args.input);
  };
}
```

A node may declare `args`, `returns`, both, or neither; when both are present `args` precedes `returns`, and no other parameter name is admitted.

Each channel key has a type; a cell bound to a key must be that type. A key's type is `Bool()`, `Str()`, `Enum(...)`, `RangedInt(...)`, `Dialog.Cursor()`, or `Array(elementSpec)`, with no observation config. `Index()` is a channel-only non-negative-integer type and cannot declare a cell.

`$enter(...)` and `$enterLoop(...)` bind caller cells to the target's keys:

```js
function Parent() {
  let ready = Bool();
  let verdict = Bool();

  $enter(Child, {
    args: { ready },
    returns: { verdict },
  });

  function Child(args = { ready: Bool() }, returns = { verdict: Bool() }) {
    if (args.ready == true) {
      $instruct(`...`);
    }
    this.effects = () => {
      returns.verdict.$set(true);
    };
  }
}
```

Binding rules:

- An `args` binding gives the node a value to read: a caller cell, or the caller's own `args.<key>` (`args: { key: args.other }`).
- A `returns` binding is a caller cell the node writes.
- Each entry binds the node's key to a caller cell, shorthand (`{ ready }`) or renamed (`{ input: ready }`).
- The bound cell's type must match the key's type, including enum members, ranged-int bounds, and array element type (recursively). Same-document targets are checked during analysis; imported targets at registration.
- Binding a key the target does not declare is an error. Within one `returns` map, each caller cell may back at most one key.
- `args` and `returns` must be object literals (no spread, no computed keys).

Channel behavior:

1. Inside the node, `args.<key>` reads the cell bound to that key.
2. `returns.<key>.$set(...)` stages a value; it does not write the caller cell immediately, and it is valid only inside `this.effects`.
3. A caller cell updates when the `$enter`/`$enterLoop` resolves normally; a key the node never sets leaves its caller cell unchanged.
4. A declared key the caller leaves unbound is legal: an unbound `args` key reads as unset, and a write to an unbound `returns` key is discarded at resolution. Reading or writing a key the node does not declare poisons the traversal.

## Primitive Accessors

Arc provides built-in accessors for semantic participants, node outcomes, dialog context, and the current deflection. These forms are supplied by the language; they are not node-declared cells.

**`State`** — node outcome values used in `ReferenceName.state` comparisons.

| Property | Description |
| --- | --- |
| `State.COVERED` | All reachable actions and effects completed. |
| `State.DEFLECTED` | Deflection finalization, including effects, completed. Eligible for re-entry. |
| `State.SKIPPED` | Permanently resolved via explicit guard logic. Not produced automatically by the runtime. |

**`Dialog`** — conversation context accessors and cursor helpers.

| Form | Type | Description |
| --- | --- | --- |
| `Dialog.user` | semantic reference | The human interlocutor. |
| `Dialog.self` | semantic reference | The AI companion. |
| `Dialog.lastUserMessage` | `string` | The most recent user message. |
| `Dialog.lastTurns(n)` | `{ role: "self" \| "user"; message: string }[]` | The last `n` turns of conversation. |
| `Dialog.cursor` | `Dialog.Cursor` | The current scoped dialog cursor. |

`user` and `self` are shorthands for `Dialog.user` and `Dialog.self`. Both forms are semantic references: they are available in semantic template interpolation and are not ordinary value expressions.

`Dialog.cursor` is an opaque value — a position in the scoped dialog. It can be stored only in cells declared with `Dialog.Cursor()`. Any cursor value, whether `Dialog.cursor` or a stored cursor cell, exposes three turn-difference methods:

| Method | Type | Description |
| --- | --- | --- |
| `cursor.userTurnsSince(other)` | `number` | Signed visible user turns, `cursor` minus `other`. |
| `cursor.selfTurnsSince(other)` | `number` | Signed visible self turns, `cursor` minus `other`. |
| `cursor.totalTurnsSince(other)` | `number` | Signed visible user-plus-self turns, `cursor` minus `other`. |

Each method counts turns from `other` up to the receiver, so a later receiver yields a positive count and a `Dialog.cursor` receiver measures up to the present. The receiver and the argument are each `Dialog.cursor` or a stored cursor cell, which makes two stored cursors directly comparable.

A cursor remembers which view it was read from and counts turns only within that view. Two cursors are comparable only when they share a view: comparing across views is an authoring error — it poisons the traversal and the issue reason names both views, rather than computing a meaningless distance.

Views come from the host. It decides how much of an arc shares one conversation projection, and it may read a node's `hostParams` to decide. An arc that runs entirely under one view has every cursor comparable with every other. Otherwise, keep each cursor's stores and comparisons among nodes the host projects alike.

```js
let startedAt = Dialog.Cursor();
startedAt.$set(Dialog.cursor);

$instructLoop(`Keep going.`, {
  resolveWhen: () => {
    return (
      /thanks|done/i.test(Dialog.lastUserMessage) ||
      Dialog.cursor.userTurnsSince(startedAt) >= 2
    );
  },
});
```

Cursor values cannot be observed with `$observe()` or `$observeOrAsk()`.

**`this.deflection`** — current-deflection accessors available inside `this.catchDeflection` and deflected `this.effects`.

| Form | Type | Description |
| --- | --- | --- |
| `this.deflection.escaped(Target)` | `boolean` | Whether the pending deflection came up through one of this node's own entries of `Target` (canonical, `forgetful`, or `newcopy`). `Target` is a bare node/import. Available in `this.catchDeflection` and deflected `this.effects`. |

**`this.pendingState`** — the outcome being finalized, available only inside `this.effects`.

| Form | Type | Description |
| --- | --- | --- |
| `this.pendingState` | `State.COVERED \| State.DEFLECTED` | The outcome that will become the current node's terminal state after effects finish. |

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
- to another node or arc's action graph, for `$enter(...)` and `$enterLoop(...)`.

Delegated work produces inputs back to the runtime, such as a host report or an entered node's resulting state. The runtime interprets those inputs and decides whether the current action resolves normally.

When the delegated action resolves, the runtime continues executing the action graph.

Deflection is separate from normal resolution. It arises two ways: a pending instruction whose `deflectWhen` becomes true deflects instead of resolving, and the host may deflect any other frontier at its own discretion. A deflection therefore reaches `this.catchDeflection` in nodes that author no `deflectWhen` and run no instructions.

The runtime pauses normal work and propagates the deflection to the nearest enclosing handler. If no handler catches it, deflection escapes the current work and the root traversal becomes deflected and suspended.

## Authoring Rules of Thumb

- Use JavaScript familiarity for syntax shape, not behavior. Arc looks like JavaScript so functions, blocks, imports, calls, conditions, and template literals are easy to write, but the runtime semantics are the ones in this spec.
- Use `$instruct(...)` or `$instructLoop(...)` for instructions. Bare string and template expression statements are not instruction shorthand.
- `judge(...)`, `$observe(...)`, instructions, and host calls delegate work to the host. `$enter(...)` transfers traversal into another node or arc. They do not execute like ordinary JavaScript function calls.
- Host-module calls request or emit host work. Host-module member references inside template literals are host variables, not calls.
- Hooks are authored as constrained arrow-function bodies. Use only the hook statement and expression forms documented above.
- If JavaScript knowledge suggests a construct that this document does not define, assume it is not valid Arc.

For patterns and anti-patterns that go beyond what is legal — how to write scripts that hold up when the runtime walks them and the host resolves their semantic work — see [arc-authoring-patterns.md](../docs/arc-authoring-patterns.md).

## Examples

A node with child nodes, cells, and branching:

```js
function HeavyMetal() {
  this.displayName = "Heavy Metal";

  let interest = Enum(['cold', 'lukewarm', 'curious', 'enthusiastic'], {
    observing: `how interested is ${user} in heavy metal`,
  });

  // action graph
  $enter(Surface);
  if (interest > 'cold') {
    $enter(Spark);
  }
  if (Spark.state == State.COVERED) {
    $enter(Deeper);
  }

  // child node declarations
  function Surface() {
    this.guidance = "casual mention, don't push";
    $instruct(`Mention that ${self} has been listening to some great heavy metal lately.`);
  }

  function Spark() { ... }
  function Deeper() { ... }
}
```

Semantic routing with `judge()`:

```js
if (judge(`${user} wants to learn something specific`)) {
  $enter(TeachTechnique);
} else if (judge(`${user} is just exploring`)) {
  $enter(CasualExplore);
}
```

A forgetful-entry node — the prior action frame is forgotten upon re-entry, so the user is asked about readiness on every entry:

```js
function SeeWine() {
  this.forgetfulEntry = true;

  let ready = Bool({
    observing: `does ${user} have a glass of wine`,
  });

  $observeOrAsk(ready);
  if (ready) {
    $instruct(`
      Tell ${user} to hold their glass up to the light and observe the color.
      Note the difference between the center and the rim.
    `);
  } else {
    $instruct(`Tell ${user} to get one glass and come back later.`);
  }
}
```
