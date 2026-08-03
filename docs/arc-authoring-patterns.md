# Arc Authoring Patterns

This document collects authoring patterns and anti-patterns for Arc scripts. The language spec ([arc-scripts.md](../specs/arc-scripts.md)) defines what is legal and what each form means; the runtime reference ([arc-runtime-api.md](../specs/arc-runtime-api.md)) defines how scripts execute. This document is about writing scripts that hold up well when the runtime walks them and the host resolves their semantic work.

## Mental models

### Runtime vs. host

Arc execution is split between two parties that never share a vocabulary.

The **runtime** owns control structure: nodes, the action-graph walk, node state and node frames, deflection, and control transfer through `$enter(...)`. None of this is visible to whatever resolves your semantic work.

The **host** owns meaning. It is the LLM or worker that resolves `judge(...)` questions, extracts observations, and delivers instructions, reasoning from the conversation and the text you wrote. The runtime does hand it some structured context — the cell being observed, an enum's allowed values, the current value, your host params — but it carries no model of your control structure: not why the work was emitted, how nodes route, or what a deflection is.

The natural-language channel you author for that worker is **semantic text**: the text in `$instruct(...)` / `$instructLoop(...)`, `judge(...)`, the question for `$observe(...)` / `$observeOrAsk(...)`, `this.guidance`, `this.deflectWhen`, a `resolveWhen` / `deflectWhen` written as text, and interpolations inside host calls. This is the prose the worker reads and acts on. Your control structure — the `if` conditions, `.state` checks, deflection, and the graph walk itself — never crosses: the worker sees the work, never the reason it was emitted.

Most anti-patterns below are a leak across this boundary: control vocabulary leaking into semantic text, or a semantic judgment that should live in text leaking into control structure.

### Functions in Arc

Arc borrows from JavaScript's two function-definition syntaxes — `function` and arrow — and enforces a role for each: a node must be a `function`, while a hook, an `invoke(...)` body, and a `$map` callback must be an arrow. The two differ in whether the invocation is remembered and what state they carry:

| Form | Invocation | Internal memory |
| --- | --- | --- |
| `function` (node) | `enter` resolves once, then skipped | Frame progress is retained by default; `this.forgetfulEntry = true` clears it at the next entry |
| arrow (hook/`invoke`/`$map` callback) | Runs in full every time it is reached | None — a fresh reach re-derives its whole body |

The visible consequence for `judge(...)` and other question-asking calls: an answer lives for the entry that asked it. It is asked once there, however many turns that entry spans, and asked again when the node is entered afresh or a hook consultation starts, where the question renders against the state current then.

In nodes, `this.forgetfulEntry = true` makes each new entry forget the prior node outcome and resolved-once action slots. Cell values, child traversals, and canonical identity persist, so do not use it to reset a cell. During an entry, resolved-once actions remain remembered normally.

## Semantic text reads as conversation, not control

**Write every piece of semantic text so that a careful person reading only the conversation could act on it.** That reader does not know your script exists.

The worker resolving an observation or a `judge(...)` sees the dialog and your text. It does not see which node emitted the work, that a deflection is in flight, or what a name like `route` means in your graph. Words such as _deflection_, _node_, _traversal_, _state_, _enter_, _catch_, _frame_, and _arc_ describe runtime machinery; at the boundary they carry no meaning.

Avoid — names concepts the worker cannot observe:

```js
let route = Enum(["unknown", "pricing"], {
  observing: `which route should handle the deflection`,
});
```

The worker is being asked to classify the conversation into `unknown` / `pricing`, but "route" and "deflection" describe the graph, not anything visible in the dialog.

Prefer — describes something observable in the conversation:

```js
let route = Enum(["unknown", "pricing"], {
  observing: `is ${user} asking about pricing, or about something else`,
});
```

The same rule governs the other semantic-text sites:

```js
// Avoid: a judgment phrased about the script.
if (judge(`this node should be caught and re-entered`)) { ... }
// Prefer: a judgment about the conversation.
if (judge(`${user} wants to come back to pricing`)) { ... }

// Avoid: guidance written in control terms.
this.guidance = `deflect if the user leaves the SEG`;
// Prefer: guidance about delivery.
this.guidance = `casual mention, don't push`;
```

A quick test: strip the script away and hand the text plus the transcript to a stranger. If they could answer the question or carry out the instruction, the text lives on the right side of the boundary. If they could not, it names something only the script knows.

## Cells and observation

### Name cells for their decision, phrase `observing` for the conversation

The cell name is yours and stays on the runtime side; the `observing` text is the host's. It is fine to name a cell for the decision it drives, but the `observing` text must describe what the worker can actually see in the dialog.

```js
// The name `wantsPricing` is fine — it is never sent to the host.
let wantsPricing = Bool({
  observing: `has ${user} asked about cost, price, or plans`,
});
```

### Choose `observe` vs `observeOrAsk` by whether the walk can proceed without a value

`$observe(...)` is passive and best-effort: if the host cannot extract a value it reports `unknown`, and the walk continues with whatever value was already there. `$observeOrAsk(...)` blocks until a concrete value exists, asking the user directly if extraction fails.

Prefer `$observe(...)` when a missing value is acceptable — reading the room, gathering bookkeeping in `this.effects` or `this.trigger`, or any branch that has a sensible default.

Prefer `$observeOrAsk(...)` only when the next step genuinely cannot continue without the value.

```js
// Avoid: forcing a question for something incidental stalls the conversation.
let mood = Enum(["down", "neutral", "cheerful"], {
  observing: `how is ${user} sounding in this conversation`,
});
$observeOrAsk(mood);

// Prefer: read it passively and move on.
$observe(mood);
```

### A prior `$set(...)` does not resolve an `$observe(...)`

Writing a value with `cell.$set(...)` provides the observation's _current_ value but does not satisfy the `$observe(...)` action — the host still gets a brief. If you already know the value, branch on it; do not expect `$observe(...)` to short-circuit.

### Order enum values so comparisons read naturally

Enum comparisons use ordinal position in the declared array, so declare values in a meaningful low-to-high order.

```js
// Prefer: `interest >= "lukewarm"` lines up with intent.
Enum(["cold", "lukewarm", "curious", "enthusiastic"]);

// Avoid: a sentinel wedged into the ordering breaks `>=` comparisons.
Enum(["cold", "unknown", "curious", "enthusiastic"]);
```

When you need an "unknown" sentinel, put it at one end (typically first) so ordered comparisons stay coherent.

The value labels are worker-facing — the host receives them as the options to choose from when extracting the value — so keep them meaningful words (`"curious"`, `"enthusiastic"`), not internal codes.

## Instructions

### Say what to do, not what state to reach

Instruction text is delivered to the user-facing layer. Write it as guidance the assistant can act on, not as a description of the graph state you want.

```js
// Avoid: describes the script's goal.
$instruct(`get this node to covered by confirming interest`);
// Prefer: describes the move to make.
$instruct(`Ask ${user} whether they'd like to go deeper on this.`);
```

### Let `resolveWhen` / `deflectWhen` carry the semantics; the text carries the ask

`$instructLoop(...)` is sticky and requires `resolveWhen`; `$instruct(...)` is one-shot and must not declare `resolveWhen`. Put the "are we done" and "should we bail" judgments in these clauses rather than polling them with separate branches.

```js
$instructLoop(`Keep developing this topic.`, {
  resolveWhen: `${self} has covered the topic enough`,
  deflectWhen: `${user} clearly wants to move on`,
});
```

### Lift shared deflection policy to `this.deflectWhen`

When every instruction in a subtree should bail on the same condition, set `this.deflectWhen` once on the node and let descendants inherit it. Override at the instruction level only where the condition genuinely differs. This keeps a single source of truth for "the user left this topic."

```js
this.deflectWhen = `${user} wants to leave this topic`;
```

## Deflection and catchDeflection

### Deflection is exception-like; normal control flow is for tree-shaped branching

Arc has two ways to redirect a traversal, and they have different shapes.

Normal control flow — `if`, `.state` routing, `$enter(...)` — is for **anticipated, tree-shaped branching**: decisions taken at a known point as the walk reaches them. Use it whenever the choice belongs at a specific place in the graph.

Deflection is the **exception-like** complement. It arises two ways: a pending instruction whose `deflectWhen` becomes true deflects instead of resolving, and the host may deflect a semantic frontier at its own discretion — so a node that runs no instructions and authors no `deflectWhen` can still be deflected. Either way it cuts in from wherever the walk stands, however deep, and the runtime unwinds it up to the nearest enclosing `this.catchDeflection`, or suspends the root if nothing catches it. That non-local, cut-in-from-anywhere shape is the whole point: deflection lets an ancestor handle an interruption without every intermediate node having to anticipate where it might arise.

Choose by shape, the same way you would weigh a branch against an exception in ordinary code. When the decision is local and expected, branch. When an interruption can originate from many points and is best handled higher up, deflect.

### Keep catch decisions small, grounded, and on the right side of the boundary

`this.catchDeflection` runs while the node is finalizing. It may `$observe(...)`, `$observeOrAsk(...)`, `judge(...)`, `cell.$set(...)`, and `cell.$unset()`, each once per deflection that reaches this node, pausing for the host where it needs an answer. Keep it to the minimum needed to decide, and remember that its semantic text still crosses the boundary.

```js
// Avoid: asks the worker about a runtime decision.
let shouldCatch = Bool({ observing: `should this deflection be caught` });
this.catchDeflection = () => {
  $observe(shouldCatch);
  return shouldCatch == true;
};

// Prefer: judge something observable, set runtime state from it.
let wantsPricing = Bool();
this.catchDeflection = () => {
  if (this.deflection.escaped(ProductIntro) && judge(`${user} wants pricing`)) {
    wantsPricing.$set(true);
    return true;
  }
  return false;
};
```

`this.deflection` exposes the deflection currently being finalized. Its `escaped(Target)` predicate tests whether the deflection came up through one of this node's own entries of `Target` — a canonical, `forgetful`, or `newcopy` entry all count. A node's own deflection entered nothing, so `escaped(Self)` is always false. It is available inside `this.catchDeflection` and remains available in deflected `this.effects`.

Two constraints worth keeping in mind: `this.deflection.escaped(Target)` accepts only a bare node or import target (not `newcopy(...)` or `forgetful(...)`), and catching only spares _this_ node from becoming deflected — it does not undo the child or instruction that triggered the deflection.

Catching restarts this node's body under the canonical entry rule: resolved `$` actions stay skipped, and every condition is evaluated fresh, including one reading a cell the hook just set. That is how a catch redirects the node.

## Node decomposition and composition

### One node is one coherent unit of state, logic, and content

Split a chunk into its own node when it has its own state and its own content lifecycle — something the parent wants to enter, track an outcome for, and possibly re-enter. Keep logic inline in the parent when it is only branching over the parent's own cells.

Choose the composition layer by ownership:

- **Child nodes** (nested declarations) are owned by the parent, store their traversal state inline, and can read the parent's cells through lexical scope. Use them for structure that belongs to this arc.
- **Imported arcs** are fully isolated — their own cells, effects, and lifecycle. Use them for reusable units that should not see the importer's state.

### Route on outcomes through `.state`, not by re-deriving them

After `$enter(Target)`, read `Target.state` to branch. Let the runtime own the outcome rather than recomputing "did that go well" from cells.

```js
$enter(ShareRecipe);
if (ShareRecipe.state == State.COVERED) {
  $enter(AdvancedTechniques);
}
```

### Prefer `if`-routing for state-driven choices and `this.guard` for unconditional verdicts

`this.guard` is for an explicit, unconditional node-state decision (for example, returning `State.SKIPPED` when the node has nothing to do). `if` conditions in the parent are re-evaluated every walk and route on current state. Do not reach for a guard to express what is really a branch.

## Control transfer (enter / return)

### Make dataflow explicit through `args` / `returns`

When a callee needs caller data or produces a result, wire it through the `args` / `returns` channels rather than relying on ambient reads. Bindings are shorthand (`{ ready }`) or renamed (`{ input: ready }`), so the child-side key can differ from the caller cell name. `returns.<key>.$set(...)` is valid only inside the callee's `this.effects`, and staged returns commit to caller cells only when the callee reaches `State.COVERED` and the `$enter(...)` resolves normally.

```js
let ready = Bool();
let childVerdict = Str();
ready.$set(true);
$enter(Child, {
  args: { ready },
  returns: { verdict: childVerdict },
});
```

Because a skipped or deflected callee does not commit its returns, do not depend on a returned value on a path where the callee might not cover.

### Pick the target shape by what re-entry should mean

Every `$enter(...)` / `$enterLoop(...)` names a target, and the target shape decides whether the call uses retained canonical entry state, forces a forgetful entry, or creates a blank anonymous copy. Choose by what re-entering the node should mean.

**`ReferenceName` (canonical)** is the default: one logical occurrence of the node that resumes where it left off across turns, with an outcome addressable through `.state`. Reach for it whenever later logic routes on how the node went.

```js
$enter(ShareRecipe);
if (ShareRecipe.state == State.COVERED) {
  $enter(AdvancedTechniques);
}
```

**`newcopy(ReferenceName)`** creates a blank anonymous copy on each entry. It has no addressable identity, so `.state` never reflects its outcome. Reach for it when you run the same node many times as separate occurrences and track none of them individually, typically a loop body where each pass is its own run.

```js
// Each pass works through a blank anonymous copy.
$enterLoop(newcopy(CollectItem), {
  resolveWhen: `${user} has nothing more to add`,
});
```

**`forgetful(ReferenceName)`** forces a forgetful entry of the _same_ canonical node, regardless of that node's `forgetfulEntry` configuration. Its prior outcome and action frame are forgotten so the action graph walks again, while cell values, child traversals, and addressable identity carry over. The new entry's outcome replaces the prior `.state`. Reach for it to deliberately return to a node you already finished while keeping what it accumulated.

```js
// Revisit pricing later in the conversation, building on what's already known.
if (judge(`${user} is ready to talk numbers again`)) {
  $enter(forgetful(Pricing));
}
```

## Mapping over arrays

### Use `$map` to run one node per element and collect the results

`arr.$map(callback, results)` runs its callback once per element and, with `results`, builds a new array in element order. The primary shape enters a fresh copy of a worker node per element, passing `span.item` in and reading the element's output back through `span.result`:

```js
findings.$map(
  () =>
    $enter(newcopy(ScoreFinding), {
      args: { finding: span.item },
      returns: { score: span.result },
    }),
  scores,
);
```

Each element runs its own `newcopy`, so no element inherits another's progress or cell values. Omit `results` for the forEach shape, running the callback for its effects when there is no per-element output to collect.

### One mapping run reads one input

A `$map` reads its input once, when the run starts, and every element maps that list. Nothing written during the run changes it: the callback cannot write the receiver at all, and when `results` is the receiver the constructed array replaces it only after the last element finishes.

`results` is committed in one write when the whole map resolves, so an element cannot read an earlier element's output from it. Elements do see each other's ordinary cell writes — they run one at a time, in order — so carry anything an element needs from its predecessors through a cell of the enclosing node.

### Let the worker catch its own recoverable deflections

A deflection escaping any element aborts the whole `$map` and discards the outputs earlier elements already produced. When an element's work can deflect for a reason the element itself can handle, catch it inside the worker node, so only genuine abandonment escapes and aborts the map.

### Keep callback effects idempotent

A `$map` can run an element twice: a deflection escaping an element abandons the run, and if the node catches it the map runs again from the first element. Write any host effects the callback applies so that a repeat leaves the same result — earlier applied effects are not rolled back when the run aborts or starts again.

## Anti-pattern gallery

| Anti-pattern | Why it fails | Instead |
| --- | --- | --- |
| Re-firing a resolved-once action to repeat work (e.g. `$set` as a per-turn counter) | A resolved-once action is skipped for the rest of the entry, and a canonical re-entry skips it too | Use `$enterLoop` / `$instructLoop` with `resolveWhen`, or a `forgetful` / `newcopy` entry, for anything that recurs |
| Arc vocabulary in semantic text (`deflection`, `node`, `route`, `state`) | The host worker sees only the conversation; these words name nothing it can observe | Phrase the text as a question or instruction about the dialog |
| `$observeOrAsk(...)` for an incidental value | Forces the user to answer something the walk does not actually need | Use `$observe(...)` and continue on `unknown` |
| `$set(...)` then expecting `$observe(...)` to resolve | A prior write supplies the current value but does not satisfy the observe | Branch on the known value directly |
| Sentinel wedged into the middle of an enum | Breaks ordinal `>=` / `<=` comparisons | Put `"unknown"` at one end of the value list |
| Reaching for deflection where a local branch fits | Deflection is exception-like and non-local; a known, in-place decision reads clearer as a branch | Branch with `if` / `.state` at the decision point; deflect for interruptions that can arise from anywhere |
| `$instruct(...)` text that describes graph goals | The delivery layer cannot act on "reach covered" | Describe the conversational move to make |
| `this.forgetfulEntry = true` to reset a cell | Clears the prior outcome and the resolved-once actions; cell values persist anyway | Re-`$set(...)` the cell, or model the reset explicitly |
| Depending on `returns` where the callee may skip/deflect | Returns commit only on a covered callee and a normally resolved `$enter(...)` | Guard the dependent path on `Target.state == State.COVERED` |
