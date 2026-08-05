# Coverage Manifest

This manifest maps every behavior entry in [specs/testing.md](../specs/testing.md) to the tests that exercise it. Update it in the same change that adds or alters spec behavior or tests. The Tests column uses globally unique test names from the split suite; grep a name to locate its area-organized file.

Status values:

- **covered** — the entry's required cases have verifying assertions.
- **partial** — some required cases are proven; the Missing column lists the rest.
- **uncovered** — no test asserts the behavior.

Audit summary (2026-07-25): 126 entries — 125 covered, 1 partial, 0 uncovered.

## Documents

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `doc.directive` | covered | "requires the Arc directive" | — |
| `doc.multi-arcs` | covered | "parses multiple arcs in one document"; "rejects a document-level cell declaration instead of discarding it"; "rejects other statements at document level" | — |
| `doc.arc-imports` | covered | "parses aliased named imports and set() from cell references"; "rejects default imports"; "uses direct root node declarations and rejects export syntax" | — |
| `doc.host-imports` | covered | "parses Arc into the new root/node IR"; "requires host module imports to be default imports"; "requires host effects to be declared by host module import" | — |
| `doc.comments` | covered | "ignores line and block comments across Arc source" | — |
| `doc.validation` | covered | "validates finalization-only expressions in public Document IR"; "validates hand-crafted enter target binding invariants"; "validates duplicate public IR bindings and node import visibility"; "validates node writeDiffMode in public Document IR" | — |
| `doc.element-ids` | covered | "editing one SEG leaves every other SEG's ids unchanged"; "editing one if-branch leaves the other branch's ids unchanged"; "stamping is idempotent"; "validate reports non-canonical ids without mutating its input"; "Runtime.add stamps its clone, registering unstamped hand-built IR with owner-qualified inherited-hook briefs"; "anonymous-copy refs round-trip element ids nested under if and invoke"; "assigns structural element ids scoped by SEG" | — |

## Node Structure and Config

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `node.sections` | covered | "parses Arc into the new root/node IR"; "hoists direct cell declarations across node-body statement order"; "rejects a cell declaration nested in an if action branch"; "rejects a cell declaration nested in a label action body" | — |
| `node.identity` | covered | "resolves references by structural identifier regardless of displayName" | — |
| `cfg.display-metadata` | covered | "parses this.guidance and this.description into node metadata"; "rejects non-literal displayName and description" | — |
| `cfg.guidance` | partial | "parses this.guidance and this.description into node metadata" | Guidance reaching the host — blocked on the TODO at the node IR field (the runtime does not read it yet). |
| `cfg.forgetful-entry` | covered | "uses this.forgetfulEntry for node frame cleanup"; "keeps resolved action state for the lifetime of one entry regardless of forgetfulEntry"; "preserves cells across a forgetful entry while the frame resets" | — |
| `cfg.host-params` | covered | host-params-shape suite; "carries node host params into semantic briefs"; "merges object instruction host params over node host params"; "uses merged instruction host params for resolution host calls"; "uses merged instruction host params for resolution judgments"; "carries null transition host params for a child that declares none" | — |
| `cfg.duplicate-assignment` | covered | "rejects duplicate this.\* assignments" for every supported node config | — |
| `cfg.hook-shapes` | covered | "requires trigger, guard, and effects callbacks to be arrow functions"; concise-body suite | — |

## Cells

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `cell.declaration-form` | covered | "accepts call-form declarations for every cell type"; former `new` forms; "rejects new when another declarator uses the call form"; "rejects a non-cell declarator mixed with a cell declaration" | — |
| `cell.enum` | covered | "compares enum values by ordinal position, not lexicographic order"; "compares enum cells by declaration order, not lexicographic order"; "compares enum values with <= and !== by ordinal position" | — |
| `cell.enum-invalid` | covered | "returns invalid-item when $observe() values do not match the cell type"; "applies the valid subset while an out-of-values enum item re-yields" | — |
| `cell.bool` | covered | "accepts observing config in cell declaration forms"; set/observe scenarios throughout | — |
| `cell.str` | covered | "parses Str as an observable string cell"; "stores arbitrary Str values from observation and set()"; "returns invalid-item when Str observations resolve to non-strings" | — |
| `cell.ranged-int` | covered | "compares RangedInt values at the declared boundaries"; "carries RangedInt bounds in observation meta and rejects out-of-range values" | — |
| `cell.ranged-int-bounds` | covered | "poisons traversal when set() writes a RangedInt outside its bounds"; "carries RangedInt bounds in observation meta and rejects out-of-range values" | — |
| `cell.cursor` | covered | "rejects observing Dialog cursor cells"; "poisons traversal for non-cursor assignments to cursor cells"; "snapshots Dialog.cursor and counts scoped turns locally" | — |
| `cell.is-unset` | covered | "reads unset state reactively and treats falsey assigned values as set"; "distinguishes an unknown observation from an observed value"; argument, unknown-cell, Artifact, and removed-spelling rejection | — |
| `cell.artifact` | covered | "parses Artifact as a non-observable local cell"; "rejects artifacts in scalar value positions"; "rejects artifacts inside activation triggers"; "rejects observing artifact cells"; "preserves entity and artifact references in host-facing semantic text" | — |
| `cell.artifact-template` | covered | template-path suite; "renders dynamic Artifact path templates from cell state"; "poisons traversal when a dynamic Artifact path renders invalid"; "poisons traversal when an empty or absolute Artifact path renders" | — |
| `cell.observing` | covered | "accepts observing config in cell declaration forms"; duplicate declaration-key, declaration-plus-assignment, and repeated-assignment rejection; "prefers the per-call observation question over the declared observing" | — |
| `cell.bare-boolean` | covered | branch, logical, negation, ternary, nested value-expression, and hook-return lint tests; explicit equality and `isUnset()` exclusions | — |
| `cell.boolean-position` | covered | "rejects a Str/RangedInt/Enum/Dialog.Cursor cell used directly as a boolean" (bare, `&&`, `\|\|`, `!`, ternary-test); "accepts an explicit comparison of a non-Bool cell"; "rejects a non-boolean && operand in a value position"; "rejects a non-boolean value in a trigger if-test"; "rejects a non-boolean trigger return"; "rejects a non-boolean catchDeflection return"; "checks statically typed array elements and map spans in boolean positions"; "poisons when an unknown-typed host call resolves to a non-boolean condition"; array cases under "rejects ordering, boolean, and negation of a whole array at parse" and "rejects a whole-array channel in a boolean position" | — |
| `cell.dead-read` | covered | lint suite; "treats a decorated write as a root read rather than initialization"; "records a dynamic target accessor as a cell read"; "counts a $map results array as an assignment of that cell"; "errors on a $map over a receiver array that is never assigned"; "errors on a $map callback reading a cell nothing assigns"; "accepts a cell a $map callback assigns and a later statement reads"; unset equality/boolean cases; all four ordering operators with unset on either side; unset value/semantic-template, host-call argument, and set() poison cases | — (comparisons evaluate unset values without error, by design — the resume machinery depends on it) |
| `cell.array` | covered | "parses Array(elementCell) as an array cell carrying its element spec"; "rejects a bare element constructor, nesting, and extra arguments in Array()"; "parses direct and decorated cell targets into root-plus-accessor tuples"; "normalizes raw nested cell-target AST accessors from root outward"; "normalizes dot access as a string accessor and rejects scalar traversal"; "rejects access past an array's scalar element"; "keeps unset direct-only and keeps returns root assignment unsupported" | — |
| `cell.array-values` | covered | "stores a whole array literal via $set"; "replaces one existing array element without changing its siblings"; "uses a dynamic index for an array-element write"; "poisons an element write with an %s array target"; "poisons a hand-authored negative array target index"; "poisons a non-numeric dynamic array target index"; "validates an array-element write against the element bounds"; "clears a set array via $unset"; "compares arrays structurally by value, order, and length"; "applies the unset-comparison rule to an unset array"; "interpolates an array value into a template as comma-joined text"; "rejects ordering, boolean, and negation of a whole array at parse"; "poisons the traversal when a fractional value writes a ranged-int element"; "poisons the traversal when an out-of-range value writes an element" | — |
| `cell.array-read` | covered | "reads an element by bracket index and reads length"; "poisons the traversal on an out-of-range index"; "poisons the traversal when indexing or reading length of an unset array"; "rejects reading length of a non-array cell at parse" | — |

## Action Forms

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `act.set` | covered | "re-walks from the top after set() changes action graph branch reachability"; "set() of the same value advances without a redundant re-walk"; "replaces one existing array element without changing its siblings"; "uses a dynamic index for an array-element write" | — |
| `act.unset` | covered | "parses unset in node bodies and hook statement subsets"; "clears a cell and re-walks the action graph"; "advances without re-walking when the cell is already unset"; "rejects arguments, unknown cells, and Artifact cells"; "keeps unset direct-only and keeps returns root assignment unsupported" | — |
| `act.observe` | covered | resolved/unknown/preserve tests; "carries a prior set() value as the observation brief currentValue"; "briefs and resolves one array element as a scalar cell target" | — |
| `act.observe-or-ask` | covered | "re-walks from the top after $observeOrAsk() resolves normally"; "records needs-user/proceed flow against the active owned child"; "resurfaces observeOrAsk when the host reports unknown"; "pins a dynamic observation target across needs-user and JSON restart" | — |
| `act.observe-group` | covered | "parses grouped observe forms with same-name cell bindings"; "rejects %s" (rename/computed/spread/duplicate/empty/second-arg); "rejects an unknown cell in a group"; "rejects a non-observable cell in a group"; "emits one grouped brief on the shared observation channel"; "writes every resolved field together before advancing"; "skips an unknown field and settles the group"; "writes nothing and re-emits when the report omits a field"; "writes nothing and re-emits when a field value fails its cell type"; "re-emits an observeOrAsk group while a field needs the user"; "briefs an array group field with element metadata and writes its whole list"; "writes nothing and re-emits when an array group field has a bad element" | — |
| `act.observe-array` | covered | "briefs an array observation with element metadata and writes the whole list"; "rejects an array observation whose element fails the element type" | — |
| `act.instruct` | covered | "rejects resolveWhen for $instruct()"; "treats $instruct() as one-shot instructions"; "resolves a one-shot instruction only after its application report"; "keeps a one-shot instruction pending across restart and rejected reports until application"; "keeps an applied one-shot resolved through a same-handback deflection"; "re-presents an unapplied one-shot after its deflection is caught"; "evaluates deflection independently of instruction application" (banked deflect evidence) | — |
| `act.instruct-loop` | covered | "requires resolveWhen for $instructLoop()"; "prefers deflectWhen over resolveWhen when both evaluate true"; "banks a settled resolveWhen while deflectWhen stays open"; "banks a settled deflectWhen while resolveWhen stays open"; "restores a banked resolveWhen consultation onto a fresh runtime"; "resolves the loop when a banked resolveWhen meets a later deflection"; "re-emits resolution observe when terminal false repeats the instruction"; "preserves pending instruction apply and postcheck phases across fresh runtimes" | — |
| `act.instruction-text` | covered | "renders cells and ternary expressions in explicit instructions"; "preserves entity and artifact references in host-facing semantic text" | — |
| `act.instruction-literal` | covered | "rejects bare string and template expression statements" | — |
| `act.judge` | covered | "accepts judge() inside set() value expressions"; trigger/branch judge scenarios; "resolves judge() in a set() value position from the reported boolean"; pin-lifetime cases in pins.test.ts ("a judge-gated condition before a blocking observation does not livelock"; "a pure seek reuses the pinned judgment with no repeated ids"; "a compound judge condition settles one side per brief without re-asking the other") | — |
| `act.host-call` | covered | host-call suite; "rejects host calls nested inside host call arguments"; "reuses computed cells across value expression positions"; "re-evaluates a host value call when a later evaluation reaches it" | — |

## Control Flow

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `flow.if-else` | covered | branch routing on cells, node state, judgments, and regex tests | — |
| `flow.label-break` | covered | label suite; "rejects break statements without a label"; nested-label unwinding tests; "a break after a resumed enter unwinds through the label-body frame"; "unwinds labeled breaks in effects, trigger, and invoke bodies at runtime" | — |
| `flow.unreached-branch` | covered | "re-walks from the top after set() changes action graph branch reachability"; "preserves resolved branch actions across later unreachable and reachable passes" | — |

## Invokes

| Id | Status | Evidence (tests) | Notes |
| --- | --- | --- | --- |
| `invoke.rerun` | covered | "re-runs a completed invoke only after a later sibling resolves with a changed read-set"; "a doubly-nested invoke constant write wins over a settled sibling set, in either order" | — |
| `invoke.continuation` | covered | "keeps an earlier branch decision while exposing an invoke write to later code"; experimental IR override: "a genuine rewalk re-reaches the invoke as a fresh invocation" | — |
| `invoke.convergence` | covered | Experimental IR override cases: "poisons a non-convergent invoke body instead of hanging"; "does not poison an idempotent convergent invoke body"; "poisons when a nested invoke write inverts its own read"; lint cases (`invoke-unconditional-set`, `invoke-self-mutating-set`, boolean-toggle pair) | — |
| `invoke.blocked-resume` | covered | "a report resumes the same blocked invocation without replaying earlier body leaves"; "a later sibling's report resumes at the sibling without re-running the invoke"; "resolves an expression-position blocker after the invoke and skips the invoke on that seek" | — |
| `invoke.dialect` | covered | "parses a block-bodied invoke into a first-class statement with body ids scoped under it"; "parses an expression-bodied invoke by wrapping the single statement"; "supports if branches, labels, and breaks scoped inside the body"; "admits enter, enterLoop, and instruct in the body"; "parses a nested invoke as an in-body statement"; "lets a nested invoke enter an enclosing node target"; "evaluates if/else branches inside the invoke body"; "admits $enter(Child) in the body, resuming through the child"; "admits enterLoop in the body"; "lints nested invokes without double-reporting the unguarded reach" | — |
| `invoke.rejections` | covered | IIFE parse-error table; invoke argument-shape table; body rejection table; "rejects invoke as a cell name"; "rejects invoke as a node name" | — |
| `invoke.scope` | covered | "records body reads in the invoke's local read-set and the enclosing node's"; "lets a body write to a parent cell show in the parent after the invocation completes"; "lets a nested invoke write a parent cell" | — |
| `invoke.deflection` | covered | "runs a fresh invocation after a deflection through the body is caught"; "a child that catches its own deflection leaves the invocation open"; "an uncaught child deflection abandons the invocation as it crosses into the body" | — |
| `invoke.refs` | covered | "surfaces the enclosing node ref as the sourceRef of an in-body instruct"; "surfaces the enclosing node ref as active/sourceRef for an in-body observe"; "inherits the enclosing node deflectWhen for an in-body instruct, including nested" | — |
| `invoke.transitions` | covered | "never latches transitions for invoke runs" | — |

## Map and Span

| Id | Status | Evidence (tests) | Notes |
| --- | --- | --- | --- |
| `map.value-transform` | covered | "commits the callback output array to results in input order"; "binds span.index and builds one ordered output per member"; "accepts a concise expression-bodied callback"; "replaces the receiver in one write when results is the receiver"; "retains the last reachable span.result write in a member"; "poisons when a member sets no span.result while results is bound"; "poisons when a kind-compatible member output violates the results element bounds" | — |
| `map.for-each` | covered | "runs members for effects and writes no output array when results is omitted"; "runs each member exactly once and waits for its instruction application" | — |
| `map.empty-input` | covered | "resolves with an empty output array over an empty input" | — |
| `map.enter-callback` | covered | "binds span.item into a child arg and span.result from a child return sink"; "captures span.index by value into an Index() child argument"; "resumes a member through a briefing child and commits its return into span.result" | — |
| `map.continuation` | covered | "skips a completed map while seeking a later frontier"; default sequential map cases; experimental IR override cases for containing/member restart and the non-convergence bound; "re-reads an args-channel receiver on a forgetful re-entry of the mapping node" | — |
| `map.member-blocks` | covered | "suspends a briefing member and resumes it into the same member on report"; "resumes each member on its own brief across a multi-element input"; "qualifies member brief sites so two members carry distinct brief ids"; "keeps a span.result staged before a block through report resume"; "runs each member exactly once and waits for its instruction application"; "preserves an inherited instruction hook while the member awaits application" | — |
| `map.deflection` | covered | "clears the arena when a member deflects and the node catch re-reaches a virgin map"; "deflects the node with no commit when a member deflection is not caught"; "discards already-terminal members when a later member deflects"; "re-reads a receiver the catch replaced when the map restarts"; "keeps earlier members' cell writes applied after the arena is abandoned"; "keeps an earlier member's applied host effect after the arena is abandoned"; "aborts the map when a deflection escapes an entered child"; "canonicalizes the deflection through the callback so escaped matches the authored target"; "keeps the member running when the entered child catches its own deflection" (drives that recovered member to completion) | — |
| `map.json-restart` | covered | "resumes a blocked member across a JSON round-trip with earlier terminals intact"; "round-trips span-backed enter links while a member's child is blocked"; "preserves a span.result staged before a block across a JSON round-trip"; "preserves a staged result while an instruction awaits application across a JSON round-trip" | — |
| `map.span-types` | covered | "rejects assigning span.item to a cell of an incompatible kind"; "checks span.item against a decorated target's element type"; "rejects a span.result write whose value kind mismatches the results element"; "rejects a span.result write of a literal of the wrong kind"; "rejects binding span.item into a child arg of an incompatible type"; "accepts a kind-compatible span.index into a RangedInt results" | — |
| `map.rejections` | covered | "rejects a nested $map"; "rejects a cell declaration in a $map callback"; "rejects a non-newcopy enter target in the callback"; "rejects a non-newcopy enter target nested inside a callback invoke"; "rejects a write to the receiver inside the callback"; "rejects an element write to the receiver inside the callback"; "rejects an $unset of the receiver inside the callback"; "rejects an observation of the receiver inside the callback"; "rejects a callback enter that sinks a return into the receiver"; "rejects span.result in a forEach $map"; "rejects a forEach callback that binds span.result as a return sink"; "rejects span.result bound as an args source"; "rejects span.item bound as a returns sink"; "rejects a span.item read outside a $map callback"; "rejects a span.result write outside a $map callback"; "rejects a span binding in an $enter outside a $map callback" | — |

## Hooks

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `hook.trigger-eval` | covered | trigger brief/batching/branch-scoping/host-call/regex tests | — |
| `hook.trigger-state` | covered | enterCount, seeding, unknown-observation, and deps tests | — |
| `hook.trigger-match` | covered | ambiguous-match, auto-select, fan-out, and multi-round tests; settlement cases in hooks.test.ts ("defers implicit auto-selection while another candidate has a pending judgment"; "defers implicit auto-selection while another candidate has a pending observation"; "defers implicit auto-selection while another candidate has a pending host call"; "an explicit matchable preferredMatch settles despite other pending trigger work"; "returns trigger-match-not-matchable when a retained preferredMatch settles unmatched beside one match"; "returns trigger-match-not-matchable instead of ambiguity when a retained preferredMatch settles unmatched beside multiple matches"); consultation cases in pins.test.ts ("a trigger retry seeks the candidate's answered judge"; "terminal candidates keep their outcomes and a chain-sent preferred match is retained"; "does not rerun a terminal match while another trigger candidate remains open"; "a fresh startTrigger starts new consultations") | — |
| `hook.deflect-when` | covered | inheritance/override tests; deflection-derivation tests; "an inherited deflectWhen poses a distinct judgment per owning instruction"; "preserves an inherited instruction hook while the member awaits application" | — |
| `hook.catch-deflection` | covered | "a catch consultation seeks its answered judge while a later leaf blocks"; "parses catchDeflection with deflection.escaped(), labels, and set()"; outside-finalization rejection; non-bare-target/body validation; "accepts deflection.escaped() referencing the enclosing node ..."; "returns false for escaped(Self) on the node's own frontier deflection"; "matches escaped(Child) against a newcopy(Child) entry"; "allows deflection.escaped() naming a child the node entered"; immediate-child versus nested-origin matching; catch/false-catch/resumed-catch/effects-ordering tests, including unset state during catch and deflected effects | — |
| `hook.guard` | covered | "blocks on a semantic guard and records skipped state on the owned child traversal" (skip); "lets a terminal child guard deflect its run for later re-entry" (deflect); "covers a node from its guard without running its body" (cover); forgetful-entry and acknowledging-dialog tests | — |
| `hook.effects-run` | covered | sequential/best-effort/early-stop/caught-vs-uncaught tests; pending-state and pending-deflection expression parsing; outside-effects rejection suite; covered-effects pending-deflection poison; covered and deflected pending-state exposure without early terminal-state commit | — |
| `hook.effects-host` | covered | unreported-effect resurfacing tests; "a reported effects host-call advances"; "accepts poison move for an unconfirmed host-effect frontier"; "waits for host-effect confirmation before entering the next node"; pending-state commit assertions | — |

## Composition

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `compose.children` | covered | lexical-read and lexical-owner tests | — |
| `compose.imports` | covered | "resolves imported arcs by source first, then root identifier"; "an imported arc's completion bubbles back to the caller enter"; "an imported arc deflection propagates to the caller catchDeflection"; "reads an imported arc's state and keeps its scope isolated from the caller" | — |
| `compose.node-state` | covered | "reflects a forgetful canonical entry's new terminal state through Child.state"; "covering a child re-walks a caller branch gated on its node state"; "reads an imported arc's state and keeps its scope isolated from the caller"; "rejects unknown node references in state expressions" | — |
| `compose.enter` | covered | returns-commit and covered-target tests; "does not force a forgetful entry of a covered imported arc on plain enter"; "rejects ... that re-enters the enclosing node" (bare/enterLoop/forgetful/newcopy); "rejects self-entry uniformly at a root arc" | — |
| `compose.enter-loop` | covered | "requires resolveWhen for $enterLoop()"; transactional-returns tests; "iterates enterLoop over a forgetful target with preserved child cells" | — |
| `compose.newcopy` | covered | anonymous-copy and blank-entry tests | — |
| `compose.forgetful` | covered | "forces a forgetful entry of a covered canonical child with preserved cells"; "forces a forgetful entry of a skipped canonical child and re-evaluates its guard"; "forces a forgetful entry of a covered imported arc with preserved cells"; "iterates enterLoop over a forgetful target with preserved child cells" | — |
| `compose.signature` | covered | "parses typed args/returns parameters into a node signature"; "rejects the old destructured parameter form"; "rejects Index() as a cell declaration"; "rejects reserved names as channel keys" | — |
| `compose.args` | covered | args-read and undeclared-poison tests; "parses $enter() renamed channel bindings decoupling caller cell names"; "reads renamed and aliased args bindings from the caller cell"; "rejects spread and computed keys in $enter() channel objects"; "rejects reading an args channel into a cell of an incompatible type"; "accepts reading an args channel into a compatible cell" | — |
| `compose.returns` | covered | commit-rule tests; "commits a renamed returns binding into the bound caller cell"; "rejects binding one caller cell to two returns keys"; "surfaces duplicate returns caller cell bindings as a structured validation issue"; "leaves caller cells unchanged for wired return keys the child never set"; effects-only rejections; "rejects a returns._.$set(...) value of an incompatible type"; "accepts a returns._.$set(...) value of a compatible type" | — |
| `compose.typed-binding` | covered | "rejects an incompatible binding"; "rejects an undeclared channel key"; "carries a Dialog.Cursor through a typed returns channel"; "rejects an incompatible imported-target binding at registration"; "rejects an incompatible imported binding regardless of registration order"; "rejects a length read on a non-array channel"; "rejects a whole-array channel in a boolean position"; "resolves a binding cell innermost-first when a child shadows an ancestor"; "resolves an imported binding cell innermost-first under shadowing" | — |
| `compose.unbound-channel` | covered | "reads a declared-unbound args channel as unset"; "stages a declared-unbound return and commits nothing at resolution"; "forwards a caller args projection into a child args channel" | — |

## Expressions and Dialog

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `expr.value-positions` | covered | "differential read-coverage: the static plan covers reads nested under every expression kind"; "parses local value expressions across expression-bearing positions" | — |
| `expr.regex` | covered | "evaluates regexTest expressions at runtime"; "routes on a regex test against a Str cell value"; trigger regex test; "propagates expression parser context through regex targets" | — |
| `expr.ternary` | covered | "renders cells and ternary expressions in explicit instructions"; "routes on a ternary conditional in a branch condition" | — |
| `expr.template-value` | covered | value-template render and unset-poison tests; rejection tests | — |
| `dialog.participants` | covered | "lowers Dialog participant accessors and shorthands to the same semantic references"; semantic-only value-position rejection tests | — |
| `dialog.last-user-message` | covered | "evaluates regexTest expressions at runtime" | — |
| `dialog.last-turns` | covered | "accepts Dialog snapshot globals in authored expressions"; "routes on a regex test against Dialog.lastTurns(n) text" | — |
| `dialog.replan` | covered | "replans against the latest dialog passed to progress"; trigger equivalent | — |
| `cursor.snapshot` | covered | "snapshots Dialog.cursor and counts scoped turns locally" | — |
| `cursor.diffs` | covered | "computes a signed difference between two stored cursors" | — |
| `cursor.validity` | covered | backwards/ahead/shape/non-cursor poison tests | — |
| `cursor.views` | covered | view-bound cursors suite (stamping, round-trip, same-view deltas, unstamped default); "poisons a cross-view comparison with a reason naming both views" | — |

## Protocol

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `proto.registration` | covered | "throws on duplicate registration and unknown traversal arcs"; "registers multiple roots from one document by declaration identifier"; "rejects invalid public documents atomically"; "snapshots documents at registration"; "creates dormant root traversals with enterCount 0 until first entry" | — |
| `proto.trigger-scope` | covered | "scopes trigger calculation to the requested Arc refs"; "retains the requested trigger scope across progressTrigger rounds" | — |
| `proto.start` | covered | "rejects starting the action stage without an entered root"; "keeps other dormant roots dormant while the entered root runs" | — |
| `proto.brief-identity` | covered | payload-cloning and continuation-isolation tests; "rejects cloned brief objects as caller misuse" | — |
| `proto.moves` | covered | "rejects deflect move while an instruction brief is pending"; "keeps a one-shot instruction pending across restart and rejected reports until application"; "rejects deflect move while a host effect is unreported"; "captures only currently reachable postchecks and postpones deeper checks" (postcheck-phase suppression); poison-move tests | — |
| `proto.report-validation` | covered | "validates instruction application reports by id, status, and phase"; invalid-report/invalid-item suites for action and trigger stages | — |
| `proto.batching` | deferred | — | Instruction batching is dormant. The optimization cases remain under the skipped `proto.batching` suite so the batch-shaped protocol and implementation can be revisited without reconstructing them. |
| `proto.brief-fields` | covered | "evaluates deflection independently of instruction application"; sourceRef/host-params/mode/postcheck suites; semantic-text-parts tests; "preserves host-variable mentions in instruction text parts"; "carries boolean observation meta"; "carries a prior set() value as the observation brief currentValue" (with enum values meta); RangedInt meta test | — |
| `proto.poison` | covered | "preserves a runtime cause code and defaults uncategorized errors"; "accepts poison move as a terminal host contract failure"; "defaults a host poison without a reason to host-poisoned"; cause-specific runtime poison tests; "contains a poisoned trigger candidate while other arcs keep probing" | — |
| `proto.idempotence` | covered | "resumes idempotently: the same brief and report twice yield the same brief"; "re-surfaces an unreported host effect under one id until it is reported" | — |
| `proto.persistence` | covered | "resumes an ordinary blocked frontier from JSON state on a fresh runtime"; covered/deflected "fresh runtime resumes effects" JSON-roundtrip cases; "keeps a one-shot instruction pending across restart and rejected reports until application"; "preserves pending instruction apply and postcheck phases across fresh runtimes"; "restores a banked resolveWhen consultation onto a fresh runtime"; deps tests; transition/cursor JSON round-trips | — |
| `trans.shapes` | covered | entry/exit transition tests; "carries null transition host params for a child that declares none" | — |
| `trans.coalescing` | covered | guard-less chain and deflection coalescing tests | — |
| `trans.exclusivity` | covered | exclusivity, effects-after, and acknowledging-dialog tests | — |
| `trans.non-latching` | covered | "never latches transitions for invoke runs"; "records no pending transitions during trigger probing"; "latches no transition for a set-driven re-walk inside one node body" | — |
| `trans.persistence` | covered | "re-yields the same transition after a JSON round-trip on a fresh runtime"; "re-carries the transition when a report is rejected" | — |

## Execution Engine

| Id | Status | Tests | Missing |
| --- | --- | --- | --- |
| `seg.write-diff` | covered | "retains earlier pins and accrues later expressions after a direct write"; "keeps an earlier branch decision while exposing an invoke write to later code"; "resumes after a blocking enter whose returns change the caller"; "still catches its own instruction deflection and rewalks itself"; "sets every parsed node to advance" | — |
| `seg.experimental-rewalk` | covered | Test-only Node IR overrides retain direct-write, wide-action, scoped-pin-release, and non-convergence coverage; authored parsing always selects `advance` | — |
| `seg.resume` | covered | resumePath unit cases; owner-first positive/negative pairs; nested and alternate-path positional-resume cases | — |
| `seg.pins` | covered | pins.test.ts: default write continuation retains earlier pins and accrues later entries; pure seek; compound judge and judge-or-host-call splits; "a judge inside a resolved $set value is skipped with its statement"; "pins a dynamic observation target across needs-user and JSON restart"; JSON round-trip persistence; experimental scoped restart coverage | — |
| `seg.isolation` | covered | "a blocked child's caller mutation surfaces only when the enter resolves"; "a pending instruction isolates its hook mutation until it resolves"; owner-first negative pairs | — |
| `seg.dialog-gating` | covered | "a dialog-gated ancestor branch above a blocked child stays bound when only the dialog advances"; "a nested enter's resolution under an advanced dialog does not re-walk the caller"; clean-advance pairs; "a judgment resolving under an advanced dialog with no write advances without re-asking" | — |
| `defl.propagation` | covered | catch/propagation suite across owned and imported children | — |
| `defl.restart` | covered | trigger-restart retry and enterCount tests | — |
| `defl.effects-order` | covered | deflection effects-ordering and retained-frame/forgetful-entry tests | — |

## Spec Issues Found During Audit

Recorded here so they are resolved in the specs before coverage is extended over them:

1. **Ask form mentioned in the effects section.** The effects section of arc-scripts.md describes `observeOrAsk` behavior, but effects bodies reject it at parse. The runtime's shared leaf machinery would execute it (effects already block and resume); the exclusions are the parse rejection and the effects statement union. Decide whether to admit the form in effects or move the sentence to where the form is admitted.
2. **Guidance is parsed and dropped.** `this.guidance` parses into the IR and the runtime never reads it; no brief carries it. A TODO on the node IR field tracks surfacing it to the host.
