# Testing

This document defines how Arc parser and runtime behavior is inventoried for testing and how test cases are derived from that inventory. It exists so coverage is driven by the specs rather than by bug history: when a feature is added or changed, this document says what test cases it owes and where they belong.

The companion manifest `__tests__/COVERAGE.md` maps every inventory entry below to the tests that exercise it. A change that adds or alters spec behavior updates the inventory here, the manifest, and the tests in the same change.

## Coverage Model

Arc behavior is specified in three documents: [arc-scripts.md](./arc-scripts.md) defines the authored language, [arc-runtime-api.md](./arc-runtime-api.md) defines the host-facing protocol, and [internal-semantics.md](./internal-semantics.md) defines implementer-facing invariants. The inventory below decomposes those specs into **behavior entries** — individually testable rules, each with a stable id. An entry is the unit of coverage accounting: the manifest marks it covered, partially covered, or uncovered, naming the tests that prove it.

A behavior entry is not one test. Most entries expand into several required cases along two axes, and missed basics historically hide at the intersections.

### Contexts

An authored form keeps one meaning everywhere it is admitted, but each admission is a separate evaluation path in the runtime. The contexts are:

- the main action graph of a node body,
- a trigger body,
- a guard body,
- an effects body,
- an instruction `resolveWhen` / `deflectWhen` body,
- an `enterLoop` `resolveWhen` body,
- a `catchDeflection` body,
- an invoke body,
- a `$map` callback body,
- an owned child node,
- an imported arc.

The specs define which forms each context admits. A form's entry owes cases in every admitted context, and a rejection case in at least one context that does not admit it.

### Outcomes

Every case exercises the form to a definite outcome. The outcome families are:

- **resolves** — the happy path; the form completes and traversal continues,
- **blocks and resumes** — the form yields a brief and a later report resolves it, including across a fresh runtime after persistence,
- **unknown or needs-user** — the host cannot resolve; the form consumes or resurfaces per its rules,
- **invalid item** — the reported value fails validation; the item re-yields while the valid subset applies,
- **invalid report** — the report as a whole is rejected and the frontier re-yields,
- **deflects** — the form triggers deflection and propagation runs,
- **poisons** — authored error or host contract failure terminates the traversal.

### Required cases rule

For every behavior entry:

1. One resolving case per admitted context.
2. For forms involving host work, one blocked-and-resumed case, and the non-resolving outcomes the form's rules distinguish (unknown, needs-user, invalid item).
3. For typed or validated forms, one boundary case and one invalid case per validation rule.
4. For forms that write persistent state, one case proving the state round-trips through serialization onto a fresh runtime.
5. For forms with an authored rejection rule, one parse-time or validation rejection case per rule.

Cases 2–5 may live in one test when the scenario naturally covers them, but the manifest must name which entry cases a test proves.

## Adding or Changing a Feature

1. Write or update the owning spec section first ([internal-semantics.md](./internal-semantics.md) governs conflicts).
2. Add or update behavior entries below, one per new rule, keeping ids stable.
3. Expand each entry with the required cases rule and write the tests.
4. Update `__tests__/COVERAGE.md` in the same change.

When a test must change during a semantic change, first decide whether the old expectation exposed a real bug. Do not weaken a test to match implementation behavior unless the spec intentionally changed.

## Behavior Inventory

Ids are `area.slug`. The **Behavior** column states the rule and any entry-specific required cases beyond the standard rubric.

### Documents (`doc`)

| Id | Behavior |
| --- | --- |
| `doc.directive` | The first statement must be the `"arc"` directive; anything else is rejected. |
| `doc.multi-arcs` | Every root-level function declaration is an arc; multiple roots in one document register independently by identifier. |
| `doc.arc-imports` | Arcs import by named import, optionally aliased; default arc imports and `export` syntax are rejected. |
| `doc.host-imports` | Host modules import as default imports from `host:*` sources; named host-module imports are rejected. |
| `doc.comments` | Line and block comments are ignored in every source position. |
| `doc.validation` | Public `Document` IR validation rejects semantic invariants that parser output normally enforces, including finalization-only expressions outside their scopes, non-canonical `this.deflection.escaped(...)` targets, self-entry, target import mismatches, duplicate bindings, and node import visibility that does not correspond to a document import. |
| `doc.element-ids` | Element ids are structural and SEG-scoped: every statement (control flow included) and briefable expression gets its position-derived id, editing one SEG or if-branch shifts no ids outside it, and ids are node-relative. Stamping is idempotent and canonical (`parse` stamps its output, `Runtime.add` stamps its private clone so unstamped hand-built IR registers, `validate` reports non-canonical ids without mutating). Inherited `deflectWhen` copies stamp under the static `deflectWhen/` scope with per-owner brief qualification intact; anonymous-copy refs round-trip ids through ref encoding. |

### Node Structure and Config (`node`, `cfg`)

| Id | Behavior |
| --- | --- |
| `node.sections` | A node body consists of config statements, cell declarations, an action graph, and child declarations. |
| `node.identity` | Structural identity comes from the declaration identifier; display name is presentation metadata only. |
| `cfg.display-metadata` | Display name and description parse into the IR as literals; non-literal shapes are rejected. |
| `cfg.guidance` | Authored guidance parses into the IR and reaches the host. |
| `cfg.forgetful-entry` | Defaults to false. When true, each new entry is forgetful: it discards the prior outcome and action frame while preserving cell values, child traversal outcomes, and canonical identity. During the entry, resolved actions remain remembered normally. |
| `cfg.host-params` | Only literal payload values are accepted; template literals are rejected. Host params are carried on every judgment, observation, host-call, and instruction brief from the node. Instruction-level host params merge over node host params when both are objects, and postcheck work uses the merged value. Host params are carried verbatim and are never interpreted by the runtime, and they do not inherit from parent to child. |
| `cfg.duplicate-assignment` | Every supported `this.*` config may be assigned at most once per node; a duplicate is rejected during parsing. |
| `cfg.hook-shapes` | Hooks are authored as arrow functions; `deflectWhen` also accepts a template-literal shorthand. Non-arrow hook values are rejected. Concise expression bodies are shorthand for a block with a single return, and for effects, for a single effect statement. |

### Cells (`cell`)

| Id | Behavior |
| --- | --- |
| `cell.declaration-form` | Every cell type uses call-form declaration syntax. A `new` initializer is rejected, including in a declaration that also contains a valid call-form declarator. |
| `cell.enum` | Ordered string enum. Comparisons use ordinal position in the declared values array, not lexicographic order, across every comparison operator. |
| `cell.enum-invalid` | An observation value outside the declared values is an invalid item: the item re-yields and the valid report subset applies. |
| `cell.bool` | True/false flag with typed writes and observations. |
| `cell.str` | Arbitrary plain string values via observation and via writes; a non-string observation result is an invalid item. |
| `cell.ranged-int` | Bounded integer. Boundary comparisons at min and max behave per ordinary comparison rules, and observation metadata carries the declared bounds. |
| `cell.ranged-int-bounds` | An out-of-range write is a runtime error that poisons the traversal; an out-of-range observation result is an invalid item. |
| `cell.cursor` | Cursor cells accept only cursor values, are not observable (rejected at parse), and poison the traversal on a non-cursor runtime assignment. |
| `cell.is-unset` | `cell.isUnset()` is a zero-argument local boolean expression and a cell read. It is true only while a value cell is unset, false for assigned falsey values, supports cursor cells, and rejects unknown or mention-only Artifact cells. |
| `cell.artifact` | Artifact cells are mention-only: writes, scalar/value use, observation, and use inside activation triggers are all rejected. A static path renders as authored. |
| `cell.artifact-template` | A template path renders from current cell state at mention time using value expressions only; semantic-only and briefable interpolations are rejected at parse; a rendered path that is empty, non-relative, or contains dot segments poisons the traversal. |
| `cell.observing` | The observation question may be defined once through declaration config or a later `observing` assignment; duplicate declaration keys, declaration-plus-assignment, and repeated assignments are parse errors. A per-call second argument to `observe` / `observeOrAsk` overrides the configured question for that call and flows into the observation brief. |
| `cell.bare-boolean` | A bare `Bool` cell in a boolean-evaluation position produces a lint warning because its unset value would poison the traversal. Direct branch and ternary tests, logical operands, negation operands, and boolean hook returns are covered, including when nested inside another value expression. Explicit equality and `cell.isUnset()` do not warn. A non-boolean value in the same position is a validation error, not a warning (see `cell.boolean-position`). |
| `cell.boolean-position` | A boolean position — an `if` test, a `&&`/`\|\|` or `!` operand, a ternary test, or a `this.trigger`/`this.catchDeflection`/`resolveWhen`/`deflectWhen` return — accepts only a boolean, without coercion. `&&`/`\|\|` are boolean operators: both operands are boolean positions wherever the expression appears, including a value position. A non-boolean whose type is statically known — a `Str`, `RangedInt`, `Enum`, `Dialog.Cursor`, array value, typed array element, or map span, whether bare or a logical, negation, or ternary-test operand — is a parse error; an unknown-typed non-boolean, such as a host-call return, raises at runtime. An explicit comparison of the same value is accepted, and a ternary's branches may be any type. |
| `cell.dead-read` | Reading an unset cell where a concrete value is required — a write value, host-call value argument, or template interpolation — is a runtime error that poisons the traversal. Comparisons may consume unset values: equality and ordering return false without coercion, except inequality returns true, whenever either operand is unset. Boolean evaluation rejects unset. Comparisons over not-yet-assigned cells can gate later work. Static analysis reports the same read ahead of a run: a cell read that no assignment in scope supplies is a `read-without-assignment` error, and a read ordered before its assignment on the same path is a `read-before-assignment` notice. The assignments counted are a direct `$set`, an observation of a direct target, an `$enter`/`$enterLoop` `returns` binding, and a `$map` `results` array; a decorated element write counts as a read of its root. Every statement kind that carries an expression contributes its reads, `$map` included: the mapped receiver, the callback body, and `span.result.$set(...)` values. Branch arms intersect and an invoke body walks inline, while a `$map` callback's own writes are not definite on the path, since an empty input runs it zero times. |
| `cell.array` | `Array(elementCell)` declares an array cell whose element is one constructed scalar observable cell; the element's `observing` is the per-item question. A bare element constructor (`Array(Str)`), a nested array, and extra arguments are parse errors. Direct and decorated action targets normalize to `[root, ...accessors]`; dot access becomes a string-literal accessor, while access through a scalar is invalid. |
| `cell.array-values` | Array cells take whole-value `$set`/`$unset`; an existing element is a synthetic scalar cell target for `$set`, while element `$unset` is rejected. A whole-array write validates every element and an element write validates the replacement against the element shape, clones the root list, and preserves siblings. Unset roots and negative, fractional, non-number, or out-of-range target indices poison. Equality and inequality compare ordered element values structurally, and the shared unset-comparison rule applies (equality false, inequality true when either operand is unset). Template interpolation renders an array as comma-joined JS stringification. Ordering, boolean evaluation, and negation of a whole array are rejected at parse. |
| `cell.array-read` | `items[index]` is a sigil-less element-value read and `items.length` a sigil-less non-negative-integer read, on a lexical array cell or a typed array channel. An out-of-range index, a non-integer index, and reading an element or length of an unset array are runtime errors that poison the traversal; indexing or reading length of a non-array cell is a parse error. A decorated action target reads the root aggregate and accessor cells and does not count as initializing the root. |

### Action Forms (`act`)

| Id | Behavior |
| --- | --- |
| `act.set` | A typed write resolves its cell target before evaluating its value, writes either the whole root or one existing array element, then execution advances. Later statements observe the written value. |
| `act.unset` | A zero-argument clear resolves once reached, then execution advances. It accepts direct root targets only; arguments, decorated targets, unknown cells, and mention-only Artifact cells are rejected. |
| `act.observe` | A resolved report writes the target leaf; an unknown report consumes the action and preserves any existing value; a prior write supplies the brief's current value but does not resolve the action. An element observation briefs a canonical concrete path with scalar metadata and the element question, then replaces only that element. |
| `act.observe-or-ask` | Resolves only on a concrete reported value; unknown and needs-user reports resurface the action on later briefs. |
| `act.observe-group` | A grouped `$observe({ a, b })` / `$observeOrAsk({ a, b })` binds cells by same-name binding (rename, computed key, spread, duplicate, empty, and a second argument are parse errors; unknown and non-observable cells are validation issues), emits one brief carrying a per-cell field with its own `observing` question and type metadata, and resolves from one report addressing every field: `resolved` fields are written together before execution continues, `unknown` fields are skipped, a report that omits a field or supplies a value failing the field's type is an invalid item that writes nothing and re-emits, and a grouped `$observeOrAsk` report with any `needs-user` field writes nothing and re-emits the whole group. An `Array` field carries `{ type: "array", element: {...} }` metadata and reports its whole list per `act.observe-array`. |
| `act.observe-array` | Observing an array cell briefs the value as `{ type: "array", element: {...} }` with the element's `observing` as the per-item question; a resolved report supplies a complete element-typed list validated all-or-nothing (any bad element rejects the whole report as an invalid item that writes nothing and re-emits), and the runtime writes the whole array once before continuing. |
| `act.instruct` | One-shot instruction: emits its text, resolves implicitly on host handback unless deflected first; authored `resolveWhen` is rejected at parse. |
| `act.instruct-loop` | Sticky instruction: requires `resolveWhen` at parse, remains pending until it evaluates true, and evaluates `deflectWhen` before `resolveWhen` on each handback. |
| `act.instruction-text` | Instruction text accepts string and template literals; value expressions and ternaries render to text; entity and artifact mentions are preserved as semantic parts. |
| `act.instruction-literal` | Bare string and template expression statements are rejected as unsupported statements, through the same path as any other invalid statement. |
| `act.judge` | A semantic boolean check usable in every expression position: branch conditions, write values, and hook returns. It blocks until reported. The reported answer pins for the remainder of the SEG and a resumed walk replays it instead of re-asking. |
| `act.host-call` | An expression-position host call blocks until the host reports a value; the reported value (an explicit `undefined` included) pins for the remainder of the SEG, like a judgment. Targets accept dot and static string-literal bracket segments; dynamic computed targets, `$`-prefixed value-call operations, and host calls inside another host call's arguments are rejected. |

### Control Flow (`flow`)

| Id | Behavior |
| --- | --- |
| `flow.if-else` | Branch conditions re-evaluate whenever the walk reaches them, routing on cell state, node state, semantic checks, and regex tests. |
| `flow.label-break` | Labels attach only to block statements and `break` must name a label (both parse rules). A labeled break unwinds through nested labels to its target, in the action graph, hook bodies, effects bodies, and invoke bodies (where labels are local). |
| `flow.unreached-branch` | Actions on an unreached branch keep their existing state and become the frontier when later state makes the branch reachable. |

### Invokes (`invoke`)

| Id | Behavior |
| --- | --- |
| `invoke.rerun` | The body executes on every fresh reach and is never memoized; its completion pin skips it during resume. |
| `invoke.continuation` | The enclosing SEG continues after a completed invocation. Body writes are visible to later statements while earlier evaluations remain pinned. |
| `invoke.convergence` | Under the experimental `writeDiffMode: "rewalk"` Node IR override, a body that never reaches a fixpoint poisons the traversal at the re-walk bound while an idempotent convergent body settles. Authored parsing selects `advance`, where a completed body pins its completion instead of re-walking (see `seg.experimental-rewalk`). |
| `invoke.blocked-resume` | A blocked body resumes the same invocation on the next report; a completed invocation's pinned completion keeps it skipped while resuming toward a later frontier, and a later sibling's report does not re-run it. |
| `invoke.dialect` | `invoke(() => { ... })` is a first-class statement whose attached body admits the full node-body action dialect — enter forms, instruction forms, and nested invokes — with body element ids scoped under the invoke's own id and an independent label scope. The statement-position IIFE form is a parse error pointing at `invoke`. |
| `invoke.rejections` | A missing or extra argument, parameters, the function-expression form, and `return` / declarations inside the body are rejected at parse; `invoke` is a reserved name for cells and nodes. |
| `invoke.scope` | The body shares the enclosing node's cell scope; writes — including from nested invokes and in-body enters — become visible to the enclosing graph. Body reads belong to the invoke's local read-set and, transitively, to every enclosing set. |
| `invoke.deflection` | A deflection from the body abandons the open invocation and routes to the enclosing node's catch; a child that catches its own deflection leaves the invocation open; an uncaught child deflection abandons the invocation as it crosses into the body. A caught deflection re-reaches a fresh invocation. |
| `invoke.refs` | In-body work carries the enclosing node's ref as source and active ref; in-body instructions inherit the enclosing node's effective `deflectWhen`, including nested. |
| `invoke.transitions` | Invoke runs never latch node transitions. |

### Map and Span (`map`)

| Id | Behavior |
| --- | --- |
| `map.value-transform` | `arr.$map(callback, results)` reads one pinned input array, runs the callback once per element in index order, stages each element's output with `span.result.$set(...)`, and commits the constructed output array to `results` in one write when it resolves. A member that completes with `results` bound but no `span.result` set is a runtime error. When `results` is the receiver, evaluation reads the pinned old value and the commit performs one replacement. |
| `map.for-each` | Omitting `results` runs members for their effects only: no output array is constructed and `span.result` is unbound. |
| `map.empty-input` | An empty input runs no members and resolves immediately, committing an empty output array when `results` is bound. |
| `map.enter-callback` | A callback `$enter(newcopy(...))` binds `span.item` and `span.index` into child args by value captured at bind time, and `span.result` as a child return sink that commits into the member when the child covers. A child that briefs suspends the member and resumes it on the next report. |
| `map.continuation` | A resolved `$map` pins its completion, so it is skipped while seeking a later frontier. Member writes and the final `results` commit are visible to later statements while earlier evaluations remain pinned; forgetful re-entry starts a fresh mapping instance. |
| `map.member-blocks` | A member that briefs suspends in the arena and resumes into that same member on the next report. Members run sequentially, each resuming on its own brief, with brief sites qualified by member index. |
| `map.deflection` | A member deflection abandons the member and clears the whole arena — arena, terminal rows, and pinned input together. A caught node re-reaches a virgin map that re-reads the receiver and evaluates afresh; an uncaught deflection deflects the node with no output commit. A deflection escaping a callback's `$enter` canonicalizes `from` through the callback to the authored target, so `escaped(Op)` matches in the node's catch. |
| `map.json-restart` | The pending arena and its span-backed enter links survive a JSON round-trip of the traversal set and resume into the suspended member with earlier terminal rows intact. |
| `map.rejections` | A `$map` callback admits the invoke action-graph dialect, and rejects at parse: a non-`newcopy` enter target at any depth, a receiver write inside the callback (direct or decorated `$set`, `$unset`, observation, or a `returns` sink into the receiver), `span.result` in a forEach `$map` (direct or as a `returns` sink), a nested `$map`, and any `span` read, write, or binding outside a `$map` callback. Binding direction is also fixed: `span.item`/`span.index` are read-only args sources and `span.result` is a returns sink only. |
| `map.span-types` | `span.item` carries the receiver's element schema and `span.result` the `results` element schema. These typings are validated in the shared analysis pass, so both `parse` and `Runtime.add` reject a mismatch: a `span.*` value written to an incompatible direct or decorated target, a `span.result.$set(...)` value of the wrong kind, and a `span.item`/`span.index` bound into an incompatible child channel. Writes check at scalar-kind granularity (enum membership and ranged-int bounds stay runtime concerns, so a number-kind `span.index` writes a `RangedInt` `results` and an out-of-bounds value poisons at the commit); channel bindings check at full channel-schema compatibility. |

### Hooks (`hook`)

| Id | Behavior |
| --- | --- |
| `hook.trigger-eval` | Triggers evaluate on dormant arcs only. Semantic checks and observations from trigger bodies surface on the trigger brief and may batch; branches that do not match are not evaluated, so their checks never run. Regex tests and host calls participate in trigger expressions. |
| `hook.trigger-state` | Enter count starts at zero and increments on activation, not evaluation, and is readable in trigger conditions across re-entries. Trigger observations seed traversal cells before entry; unknown observations do not block matching. Probe dependencies report the full compatibility set, including transitive imports. |
| `hook.trigger-match` | With multiple matchable arcs the runtime reports ambiguity until a preferred match names one; a single matchable arc auto-selects; a preferred match seeds an independent selected traversal per brief; resolution may take multiple rounds as earlier answers unlock later trigger work. One consultation is one walk per candidate: retry round-trips on the same chain seek each candidate's pins, terminal candidates keep their outcomes without re-running, a chain-sent preferred match is retained, and a fresh `startTrigger` starts new consultations for every candidate. |
| `hook.deflect-when` | The node-level default applies to the node's own and descendants' pending instructions; an instruction-level policy overrides it; the template form desugars to a judgment; the policy is consulted only while a reachable instruction is pending. An inherited default shares its hook IR (element ids under the `deflectWhen/` scope) across owners, so its brief identity is qualified by the owning instruction's consultation instance — the same inherited judge poses under a distinct id per owner, shaped like an authored per-instruction hook's. |
| `hook.catch-deflection` | The finalization-scoped `this.deflection.escaped(...)` predicate accepts only bare targets (`newcopy` and `forgetful` argument forms are rejected at parse), matches a canonical/`forgetful`/`newcopy` entry of the target by name, is always false for a self-target (a node enters nothing of its own), is available in `this.catchDeflection` and deflected `this.effects`, and is rejected outside those hooks or at runtime during covered effects. Hook-local observations, asks, judgments, and writes are allowed; resolved leaves advance within the consultation and answered judgments remain pinned. The current node's state remains unset throughout the catch. Returning true catches and restarts the node's own graph without running its effects; returning false or omitting the hook begins deflected finalization, whose effects must finish before `State.DEFLECTED` is committed and propagated. Catching does not erase the triggering child's deflected state. |
| `hook.guard` | Runs when traversal reaches the node, before its body. Returning a node-state value resolves the node without entry — each of the three state values needs a case — and returning undefined continues normally. Guards re-evaluate on a forgetful entry and evaluate under the acknowledging dialog when entry follows a transition. |
| `hook.effects-run` | Effects run when the graph can no longer progress: after full resolution and after an early stop such as a deflected child. The node's terminal state remains unset while effects run; effects-only `this.pendingState` exposes `State.COVERED` or `State.DEFLECTED` from the finalizing reason, including through conditions, writes, payloads, templates, suspension, and persisted resume. Deflected effects can use `this.deflection.escaped(...)`; covered-effects use poisons the traversal. Statements execute sequentially after pending observations resolve; observation statements are best-effort on unknown. Effects run on both caught and uncaught deflection paths per the propagation rules, and an ancestor that catches a child deflection does not run its own effects. Use of `this.pendingState` outside effects is rejected. |
| `hook.effects-host` | Statement-position host calls in effects emit host effects. An unreported effect keeps the node unfinished and its terminal state unset, blocks later nodes, and resurfaces under the same id on every brief until applied or the frontier is poisoned. |

### Composition (`compose`)

| Id | Behavior |
| --- | --- |
| `compose.children` | Owned children store traversal state inline under the parent and read outer cells lexically; lexically owned siblings attach to the lexical owner, not the immediate caller. |
| `compose.imports` | Imported arcs resolve by source then root identifier, keep fully isolated scope and their own lifecycle; completion bubbles back to the caller's enter and deflection propagates to the caller's catch. |
| `compose.node-state` | Node state reads report the canonical target's outcome uniformly for children and imports; unknown references are rejected at validation; a forgetful entry's new terminal state replaces the reported outcome; anonymous copies never affect the canonical outcome. |
| `compose.enter` | Resolves when the target reaches covered or skipped; the caller suspends while the target is unresolved. A covered target commits staged returns; a skipped target resolves without committing. A plain canonical enter does not re-enter a covered target, for children and for imports. Self-entry is rejected at parse in every form — `$enter`/`$enterLoop` whose bare, `forgetful`, or `newcopy` target resolves to the enclosing node — uniformly for root and non-root. |
| `compose.enter-loop` | Requires `resolveWhen` at parse. After a covered or skipped iteration the loop condition evaluates in the caller context; while unresolved a new iteration enters the same target shape; a deflected iteration leaves the loop action unresolved. Staged returns commit only when the whole loop resolves. |
| `compose.newcopy` | A `newcopy` target creates a blank anonymous copy per call — for children and imports — stored under its caller, never addressable through node-state reads. A completed copy is replaced on the next entry, while an unresolved copy resumes. |
| `compose.forgetful` | A `forgetful` target forces a forgetful entry of the canonical node: it preserves canonical identity, cell values, and child traversals; clears the prior outcome and action frame once at the entry boundary; re-evaluates the guard; and makes the entry's outcome the new reported state. Covered and skipped targets both support forgetful entry. Applies to children and imports, as an `enter` target and as an `enterLoop` target. |
| `compose.signature` | A node declares its typed channels with `args = { … }` / `returns = { … }` defaulted parameters whose values are constructed channel specs (`Bool`, `Str`, `Enum`, `RangedInt`, `Dialog.Cursor`, `Index`, `Array`). Both parameters are optional; when both are present `args` precedes `returns`, and no other parameter name is admitted. The parsed signature is public IR on the node. The old destructured `{ args, returns }` form is a parse error, and `Index()` cannot declare a cell. |
| `compose.args` | The args channel exposes caller-backed cells read-only under child-local keys declared in the signature, readable in the child's action flow and effects. Entries bind shorthand (`{ report }`) or renamed (`{ inputReport: report }`), so channel keys decouple from caller cell names, and one caller cell may back several args keys. A key the caller declares but leaves unbound reads as unset (see `compose.unbound-channel`); a reference to a key the node does not declare poisons the traversal. Non-literal channel objects and unknown caller cells are rejected at validation. Reading `args.<key>` into a `cell.$set(...)` of an incompatible scalar kind is a validation issue (at `parse` and `Runtime.add`), the same static check as `span.item`. |
| `compose.returns` | Return writes are valid only inside effects (rejected elsewhere at parse, including inside control flow), validate against the node's own declared returns spec, and stage candidates rather than mutating caller cells. Entries bind shorthand or renamed, and a renamed entry commits through the child key into the bound caller cell. Binding one caller cell to more than one returns key is a parse error. Candidates commit on normal resolution only — not on skip or deflection — and keys the child never set leave caller cells unchanged. A write to a channel the node does not declare poisons the traversal. A `returns.<key>.$set(value)` whose value is an incompatible scalar kind is a validation issue (at `parse` and `Runtime.add`), the same static check as `span.result`. |
| `compose.typed-binding` | An `$enter(...)` channel binding is checked against the target's declared signature: an undeclared key and a binding whose provided schema is incompatible with the declared channel schema are errors. Same-document targets are checked during document analysis; imported targets are checked at registration whenever the reference resolves, in either registration order, and an incompatible binding rejects `Runtime.add()` without mutating the registry. Scalar type, enum members, ranged-integer bounds, dialog-cursor shape, and array element shape (recursively) must match. An array-typed channel supports `channel[i]` / `channel.length` and is rejected in ordering/boolean positions; a non-array channel receiver of those operators is a validation error. A `Dialog.Cursor` crosses a typed returns channel and commits into the caller cursor cell. |
| `compose.unbound-channel` | A channel a node declares but the caller leaves unbound is legal on both sides: a declared-unbound args read is unset (`isUnset()` true, comparisons follow the unset rule), a declared-unbound return stages locally and is discarded at resolution with no caller commit, and a read-set snapshot records it as resolved-unset rather than an unresolved read. A caller forwards its own typed `args.*` into a child via an args projection (`args: { key: args.other }`), including passing an unbound projection through as unset. |

### Expressions and Dialog (`expr`, `dialog`, `cursor`)

| Id | Behavior |
| --- | --- |
| `expr.value-positions` | One expression grammar serves branch tests, write values, hook returns, template interpolations, and expression-position host calls; static read-coverage analysis sees reads nested under every expression kind. |
| `expr.regex` | Regex tests evaluate at runtime against string values, including the last user message, in graph conditions and trigger bodies. |
| `expr.ternary` | Ternary conditionals evaluate in value positions and render inside instruction text. |
| `expr.template-value` | Value-position template literals render from current values; interpolating an unset cell poisons the traversal; semantic-only interpolations are rejected at parse. |
| `dialog.participants` | `Dialog.user` and `Dialog.self` lower to the same semantic entity references as their `user` and `self` shorthands; all four forms remain semantic-only. |
| `dialog.last-user-message` | Derived from the most recent user turn of the supplied dialog. |
| `dialog.last-turns` | The last-turns accessor reads from the supplied dialog's turns with defined value semantics in conditions. |
| `dialog.replan` | Action and trigger progression evaluate against the latest supplied dialog, which may be newer than the one that produced the brief. |
| `cursor.snapshot` | The live cursor can be read, stored into cursor cells, and used for scoped turn counting. |
| `cursor.diffs` | The three turn-difference methods produce signed differences between any two cursor values, stored or live. |
| `cursor.validity` | A live cursor behind a stored baseline, a stored cursor ahead of the live baseline, an invalid cursor shape, and a non-cursor receiver or argument each poison the traversal. |
| `cursor.views` | Cursors stamp the dialog's view on read and the stamp persists through serialization. Same-view deltas compute; cross-view comparisons poison with `cross-view-comparison` and an issue reason naming both views. Unstamped cursors and dialogs read as the default view. |

### Protocol (`proto`, `trans`)

| Id | Behavior |
| --- | --- |
| `proto.registration` | Duplicate document registration and unknown arc references throw as caller misuse; invalid public documents are rejected without partial registration; registered documents are snapshotted so caller mutation after `add()` does not affect runtime behavior; fresh traversals start dormant with a zero enter count. |
| `proto.trigger-scope` | Trigger probing scopes to requested arc refs, rejects unknown refs, and later progression retains the scope. |
| `proto.start` | Starting the action stage requires exactly one entered root; other dormant roots stay dormant. |
| `proto.brief-identity` | Progression accepts only the exact brief instance last returned; briefs are immutable and payloads deep-cloned so host mutation cannot leak into runtime state. |
| `proto.moves` | Allowed moves are authoritative: an unlisted move is an invalid report; deflect is offered only on a brief whose pending work is semantic and that carries no instruction, host effect, or transition, so it is rejected while an instruction brief is pending — in the `apply` and `postcheck` phases alike — and while an emitted host effect is unreported; poison is accepted on any progressable frontier, including one blocked on unreported host effects. |
| `proto.report-validation` | An invalid report is rejected as a whole and the same frontier re-yields; invalid items apply the valid subset and re-yield only the rejected items; unknown work-item ids are protocol issues, for action and trigger stages alike. |
| `proto.batching` | Semantic work batches at a shared frontier. Instructions batch only within the currently executing node body and only when merged host params, mode, and resolution hooks match; entering a child, returning to a caller, or beginning effects ends the batch. |
| `proto.brief-fields` | Work items carry their source ref and merged host params. Observation briefs carry mode, current value, and type metadata including enum values and integer bounds. Semantic text preserves entity, artifact, and host-variable parts through briefs and host effects. Instruction briefs carry mode, the apply/postcheck phase progression, and postcheck ids referencing items on the same brief. |
| `proto.poison` | Host poison applies with or without a reason (defaulting the reason code); authored failures preserve their cause-specific runtime reason code and uncategorized exceptions use `other-runtime-error`. In the action stage the root becomes terminally poisoned and cannot progress; in the trigger stage the poisoned candidate is contained, other arcs keep probing, and the candidate is barred from matching. |
| `proto.idempotence` | Re-sending the same brief and report yields the same next brief; unresolved work resurfaces under stable ids. |
| `proto.persistence` | Traversal state plus registered documents suffice to resume on a fresh runtime after any brief, including covered and deflected effects finalization with stable `this.pendingState` and persisted pending-deflection `origin`/`from` references, and trigger briefs report the dependency set that must stay compatible. |
| `trans.shapes` | Entry transitions carry the entered stretch and the position's host params; exit transitions surface before the caller re-evaluates under the new view. |
| `trans.coalescing` | Guard-less enter chains and uncaught deflections through hookless ancestors coalesce into one multi-element transition; guarded or branching hops transition per hop. |
| `trans.exclusivity` | A transition brief carries no other work; declared effects surface on the following brief; guard evaluation and loop resolution after an exit use the acknowledging dialog. |
| `trans.non-latching` | Invoke runs and SEG-local restarts never latch transitions, and trigger probing never announces them. |
| `trans.persistence` | An unacknowledged transition re-yields after a JSON round-trip onto a fresh runtime and re-carries when a report is rejected. |

### Execution Engine (`seg`, `defl`)

| Id | Behavior |
| --- | --- |
| `seg.write-diff` | Parsed nodes use `advance`: direct writes and resolved wide actions continue after themselves, earlier branch decisions and pins remain, and later evaluations observe the new state and append to the same tape. Explicit restart boundaries remain independent, so caught deflection still restarts the catching node body. |
| `seg.experimental-rewalk` | A test-only Node IR override covers the experimental changed-write restart and its non-convergence bound; authored source cannot enable it. |
| `seg.resume` | Resume seeks: it replays the deepest blocked graph from its top with pinned sigil-less values honored, landing back on the frontier without re-asking answered work, and bubbles up one ancestor at a time through the entering action. A blocked hook resolves owner-first before the enclosing body continues; positional reconstruction reaches nested owners, alternate branches, label bodies, and loop hooks exactly. |
| `seg.pins` | Every non-constant sigil-less evaluation — cell/channel/outcome reads, dialog reads, judgments, host-call results — pins on the SEG's tape. Pins survive suspension, seek, brief rebuild, and later writes, persist through JSON round-trips, and release at scoped explicit restart or fresh-instance boundaries. A judge-gated condition before a later blocking action does not livelock: the answer pins, the later action surfaces, and progress continues every brief. |
| `seg.isolation` | A blocked child's or pending hook's mutations stay isolated from the caller until the blocking action resolves. |
| `seg.dialog-gating` | Dialog advancement does not revisit an earlier branch. A dialog-gated branch keeps its pinned dialog reads until an explicit restart or fresh SEG instance; a clean bubble-up reaches only the caller's own tail. |
| `defl.propagation` | Deflection propagates from the originating frontier upward: owned children, imported children, ancestor catching, self catching, false catching, resumed and ask-blocked catching, and uncaught propagation to the root each behave per the catch rules. |
| `defl.restart` | After a root deflection, trigger restart retries deflected children, auto-skips covered ones, and re-enters suspended arcs with an incremented enter count. |
| `defl.effects-order` | Child deflection effects run before blocked ancestor effects, deflection completes only after effect observations resolve, and resolved action state survives when the frame is retained while dropping when `forgetfulEntry` applies at re-entry. |
