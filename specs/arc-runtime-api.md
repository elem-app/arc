# Arc Runtime API

The runtime executes parsed Arc scripts together with a **host**. It traverses action graphs, manages traversal state, and yields structured briefs when it needs host involvement. The host carries out semantic work — LLM calls, cell extraction, instruction following — and reports back. The runtime never calls an LLM or performs any semantic resolution itself.

## Mental Model

Arc execution is a conversation between the runtime and the host. The runtime walks the graph and knows what work needs doing. The host knows how to do that work. They communicate through ephemeral **briefs** (runtime → host) and **reports** (host → runtime).

An arc runs in two stages:

1. **Trigger stage** — the runtime evaluates dormant arcs' triggers to decide which arc becomes active. Triggers may contain semantic checks that require host resolution, so this stage follows the brief/report exchange.

2. **Action stage** — the runtime traverses the active arc's action graph. At each step it advances until it reaches work it cannot resolve deterministically and yields a brief. The host resolves the brief and reports back with a move. This loop repeats until the arc completes or can no longer progress.

There is only one active arc being traversed at a time.

After the action graph resolves, the node's `this.effects` finalization graph runs. It uses the same actions and host-call protocol as the main graph and may require additional resolution rounds before the node settles.

## Host Integration Example

A host first constructs a `Runtime` and registers its documents (see [Registration](#registration)). A typical host turn then runs:

1. Build Dialog from session history.

2. Trigger stage:
   1. `startTrigger(traversals, dialog)` → trigger brief.
   1. Persist `brief.traversals`.
   1. While `brief.matched` is not set:
      1. Resolve judgments/observations/hostCalls and optional `preferredMatch`.
      1. `progressTrigger(brief, report, latestDialog)` → new trigger brief.
      1. Persist `brief.traversals`.
   1. Once `brief.matched` is set, proceed to action stage.

3. Action stage (if an arc is active):
   1. `start(traversals, dialog)` → `ActionBrief | TerminalBrief`.
   1. Persist `brief.traversals`.
   1. While `brief.canProgress`, inspect its instructions, pending work, and `allowedMoves`; choose when to hand control back; resolve available items; and call `progress(brief, { move, instructions, judgments, observations, hostCalls }, latestDialog)`. Unresolved or unreported work re-surfaces on later `ActionBrief`s under the same ids. When `brief.deflection` is present, prepare the handoff and report only `{ move: "deflect" }`. On other frontiers, report `move: "poison"` if the host cannot accept the frontier contract or fails a resolution fatally. Persist each returned `brief.traversals`.
   1. When `canProgress` is false, settle from `brief.root`, `brief.outcome`, `brief.returns`, and `brief.issues`.

## Registration

Runtime construction accepts the complete host-module declaration environment and has a collecting phase followed by an initialized phase:

```typescript
type RuntimeOptions = {
  hostModules?: ReadonlyMap<string, HostModuleSpec>;
};

const runtime = new Runtime({ hostModules });
```

`HostModuleSpec` is normalized data. Host developers may construct it with [`hmd.define()`](../docs/host-module-declarations.md) from the `arc/host-utils` entry point. The runtime validates and privately clones the registry at construction. Omitting `hostModules` means an empty registry.

Documents may be added in any Arc import order while collecting. Execution APIs require successful initialization; successful initialization seals the runtime against further additions.

Expected document and registry incoherence is reported through `RuntimeRegistrationError`. The error's `operation` is `"add"` or `"init"`, and its `issues` contains every independently discoverable structured registration issue from that call. Its message includes every issue code and message for ordinary logging; callers that present or classify failures should consume `issues` rather than parse the message. Caller misuse and impossible internal invariants remain ordinary immediate errors.

**`add(source, document)`** — validate and collect one document. `source` is the filename stem (e.g. `"heavy-metal"`). The runtime keeps a private copy, so the caller's object is not mutated and later caller mutation does not change runtime behavior. Hand-built IR may omit element IDs.

`add()` performs every document-local and host-module check: document grammar, semantic validity, every imported host module and action path, exact operation arity, compatible parameter operands, and satisfaction of each consumer's result demand. An action consumer creates no result demand. It does not require imported Arc documents to have been added yet.

`add()` is atomic. A failed call, including a duplicate source or Arc ref, collects nothing. A document that fails grammar or semantic validation is not checked against host modules, so fixing it may reveal further issues.

**`init()`** — resolve and validate the complete prospective registry. Initialization resolves every import and imported node-entry endpoint, then walks imported bindings with the caller's lexical cells, current node signature, and enclosing `$map` receiver/result element specs. Args bindings are checked provider-to-receiver; returns bindings are checked declared-return-to-local-receiver. It collects unresolved imports and every independently checkable undeclared, unresolved, or incompatible binding. A binding dependent on an unresolved import is skipped rather than reported as a cascade. Issues are returned in canonical source/position/binding order, independent of document-add order, and one `RuntimeRegistrationError` reports the complete result.

Initialization commits atomically. A failed `init()` leaves the runtime collecting and retryable, so the caller may add a missing document and call `init()` again. A successful call commits the resolved registry, enables execution, and rejects later `add()` calls. Calling `init()` again on an initialized runtime returns that runtime unchanged.

**`has(arc)`** — check whether an arc is registered.

**`newTraversalSet()`** — create an empty traversal set for a fresh trigger or action session.

**`newTraversal(arc)`** — after initialization, create a fresh arc traversal in the `"dormant"` phase with `enterCount = 0`.

## Payload Values

`PayloadValue` is the recursively serializable carrier for values crossing the Arc–host boundary: values supplied by the host that become visible to Arc, and values produced by Arc that become visible to the host. It is a directional TypeScript guarantee, not a complete encoding of every authored cell or operation constraint.

```typescript
type PayloadValue =
  | string
  | number
  | boolean
  | undefined
  | PayloadValue[]
  | StructValue;

type StructValue = {
  readonly [key: string]: PayloadValue;
};
```

A top-level payload may be a string, number, boolean, `undefined`, an Artifact value, or an array or object recursively composed from payload values. Nested values must be defined; arrays must be dense ordinary data arrays without accessors or extra properties; objects must be plain or null-prototype data objects without accessors or symbols. A typed position admits only what its spec declares, and no Struct spec can declare a `$`-prefixed field.

An Artifact value has the exact transport shape `{ $path: string }`. Use `createArtifactValue(path)` to validate and construct one, `isArtifactValue(value)` to validate an unknown value when the surrounding operation or declaration already requires an Artifact, and `pathOfArtifactValue(value)` to read its logical path. The shape carries no global runtime tag: an unconstrained `{ $path: "x" }` payload remains ordinary data. Artifact cells, channels, constructors, and interpolations require that exact shape. The registered document spec remains authoritative for persisted cell values.

## Traversal State

Traversal state is the persistent, serializable representation of an arc's progress. It lets the runtime resume walks from where it left off across turns, sessions, and process restarts.

### Arc Traversal and Node Traversal

An **arc traversal** represents the full state of one arc: its lifecycle phase, enter count, cell values, action resolution state, and child traversals. It is the top-level unit of persistence.

A **node traversal** represents the state of a single node within an arc. For owned children (nested function declarations), traversal data is stored inline under the parent. For imported arcs entered via a parent arc, each gets its own arc traversal managed directly by the runtime.

Runtime instances are purely in-memory. The host is responsible for persisting traversal state between turns — a serverless handler, for example, can spin up a fresh runtime, add and initialize the same documents, and resume any session from its own storage.

### Lifecycle Phases

Each arc traversal tracks where it is in its lifecycle:

| Phase         | Description                                        |
| ------------- | -------------------------------------------------- |
| `"dormant"`   | Initial state. The arc has not been triggered.     |
| `"entered"`   | The arc is active and being traversed.             |
| `"completed"` | All reachable actions and effects have resolved.   |
| `"suspended"` | The arc was entered but left before completing.    |
| `"poisoned"`  | Progression failed (host poison or runtime error). |

### Poisoning

A traversal becomes `"poisoned"` when progression cannot continue. The phase is terminal: a poisoned traversal counts as stopped and is never advanced again. Poison has two origins.

**Host-initiated.** The host reports `move: "poison"` where offered by `allowedMoves` on an action frontier it cannot execute — a malformed or unusable frontier, such as an instruction missing required host params. The runtime discards any work-item results carried by a poison report; poison ends the frontier rather than resolving its semantic work. The host may attach a `poisonReason` (`reasonCode`, `reason`); when it is omitted, the runtime records `reasonCode: "host-poisoned"`.

**Runtime-initiated.** Authored Arc execution throws while the runtime advances a trigger or an action. Known failure sites attach a stable cause-specific `reasonCode`, which the runtime preserves at the advancement boundary. An uncategorized exception records `reasonCode: "other-runtime-error"`.

In both cases the runtime sets the traversal `phase` to `"poisoned"` and surfaces a `poisoned-traversal` issue that names the responsible `arc`, the `active` node, and the `reasonCode`/`reason` describing the cause.

What poison terminates depends on the stage:

- **Action stage.** Poison ends the active Arc. `start()`, `enterArc()`, or `progress()` returns a `TerminalBrief` with `outcome: "poisoned"`, the poisoned Arc's `ArcRef`, and no moves or work items.
- **Trigger stage.** A poisoned candidate is contained. Only that arc's traversal is poisoned; probing continues for the other arcs, and the poisoned arc is barred from future trigger matching.

The stable causes for runtime-initiated poison are:

| `reasonCode` | Runtime condition |
| --- | --- |
| `invalid-cell-assignment` | A `$set()` value is absent or has the wrong cell shape, or `$unset()` reaches an invalid target. |
| `invalid-cell-target` | A cell target attempts to access through a scalar or exceeds the runtime's supported target depth. Validated documents should normally prevent this. |
| `invalid-array-index` | An array read or cell-target accessor resolves to a value that is not a non-negative JavaScript safe integer. |
| `array-index-out-of-range` | An array read or cell-target accessor resolves to an index outside the existing array bounds. An index equal to the array length does not append. |
| `invalid-array-operation` | Runtime evaluation attempts an array read, target access, element write, or map operation against a value that is not an array. Validated documents should normally prevent this. |
| `invalid-enum-value` | A value written to `Enum` is not one of its declared values. |
| `unknown-cell` | Runtime evaluation cannot resolve the cell targeted by `$set()`, `$unset()`, `$observe()`, or an internal write. Validated documents should normally prevent this. |
| `invalid-observation-target` | Runtime evaluation reaches `$observe()`, `$observeOrAsk()`, or a grouped `$observe({ ... })` field with a non-observable cell such as `Dialog.Cursor`. Validated documents should normally prevent this. |
| `unknown-channel-key` | An `args.*` or `returns.*` key is read or written that the node does not declare. A declared key the caller leaves unbound is legal. |
| `invalid-channel-binding` | A wired channel points to a caller cell or owner traversal that no longer exists. |
| `invalid-return-value` | A `returns.*.$set()` value has the wrong value shape, or violates an `Index()` channel's non-negative-safe-integer refinement. |
| `invalid-array-literal` | An array literal element is not a valid value. |
| `invalid-struct-literal` | A struct literal field does not hold a valid value. |
| `invalid-field-read` | A field read names a field the struct does not declare. Validated documents should normally prevent this. |
| `invalid-artifact-value` | A value used under Artifact authority does not have the exact valid `{ $path: string }` shape; nested array failures include the first invalid member path. |
| `invalid-artifact-operation` | Runtime evaluation receives an Artifact in ordering, regex, or another unsupported operation. Artifact equality and inequality are supported. |
| `non-numeric-arithmetic-operand` | A dynamically supplied arithmetic operand is not a number. The reason identifies the operator, operand position, and runtime value kind. |
| `non-numeric-is-finite-argument` | A dynamically supplied `Num.isFinite(...)` argument is not a number. |
| `non-finite-number` | Authored execution tries to use `NaN` or an infinity where a finite number is required. |
| `invalid-comparison-operands` | The operands of a comparison cannot be compared, such as an ordering between a number and a string, or an equality operand that is not a valid value. |
| `invalid-numeric-comparison` | A numeric comparison receives a non-number. |
| `invalid-string-comparison` | A string comparison receives a non-string. |
| `non-boolean-value` | A boolean position receives a value that is not a boolean. |
| `invalid-string` | A position that requires a string receives another value. |
| `span-outside-map` | `span` is read outside a `$map` callback. Validated documents should normally prevent this. |
| `invalid-host-argument` | A host-call argument does not satisfy the operation's declaration. No call is emitted. |
| `invalid-template-interpolation` | A value or semantic template attempts to interpolate an unset or unsupported value. |
| `unset-value` | An unset value is used where a concrete value is required. Comparisons may consume ordinary unset values without poisoning: equality and ordering return `false`, except inequality returns `true`, whenever either operand is unset. |
| `invalid-artifact-path` | An Artifact initializer or factory receives an empty or absolute path or one containing a `.` or `..` segment. |
| `invalid-dialog-cursor` | `Dialog.cursor`, a stored cursor, a cursor write, or a `*TurnsSince()` operand does not have a valid cursor shape. |
| `cross-view-comparison` | A cursor difference compares coordinates stamped with different dialog views; the issue reason names both views. |
| `cursor-moved-backwards` | A live `Dialog.cursor` is behind a stored cursor from the same view. |
| `other-runtime-error` | An exception reaches the advancement boundary without a recognized cause-specific code. |

Invalid judgment or observation results supplied in a report do not poison the traversal. They surface as `invalid-item` issues with their own validation reason codes. A grouped observation report that omits a field, or supplies a field value failing its cell's type, is invalid the same way: the group writes nothing and re-emits.

### Node State

Node state is the outcome of a node as a whole. It is `COVERED` after actions and effects complete, `DEFLECTED` after deflection finalization, `SKIPPED` when a guard bypasses the entry, `INTERRUPTED` when an interruption leaves work pending, or unset before an outcome is recorded. The parent's action graph reads it through `ReferenceName.state` to decide whether to re-enter or move on. `forgetful(ReferenceName)` explicitly clears the prior canonical node state and starts a new entry whose eventual outcome becomes the new `ReferenceName.state`.

Canonical node state is addressable from Arc source through `ReferenceName.state`. Blank anonymous copies created through `newcopy(ReferenceName)` are not addressable from Arc source and do not change the meaning of `ReferenceName.state`. Forgetful entries created through `forgetful(ReferenceName)` remain addressable and replace the prior canonical outcome with the new entry's outcome.

## Brief/Report Protocol

The runtime communicates with the host exclusively through briefs and reports. When the runtime reaches a point requiring host involvement, it yields a **brief** describing the pending work and carrying contextual information. The host resolves the pending items, chooses a move, and sends back a **report**. The runtime uses the report to advance.

Briefs also carry information the host may use at its discretion — traversal snapshots, instructions to follow, and host calls to resolve. Hosts must treat brief objects as immutable:

- Do not mutate brief fields in place.
- Do not reconstruct or clone a brief and pass the copy back.
- Pass the same trigger brief object instance returned by `startTrigger()` or `progressTrigger()` to the next `progressTrigger()` call.
- Pass the same brief object instance returned by `start()` / `progress()` to the next `progress()` call.

The report only needs to address the pending work items and the chosen move.

Briefs and reports are ephemeral — they are valid only for the runtime call that produced them.

### Brief Rules

A brief is emitted when the current walk reaches a frontier that requires host coordination.

A **walk** is one pass through the active arc's action graph. `start()` performs one walk. `progress()` first applies the report, then performs a new walk to produce the next brief.

The runtime emits briefs under these conditions:

- **Trigger brief** — trigger evaluation encounters unresolved semantic work (`judge()`, `$observe()`, or host calls), or triggers finish with matchable arcs for the host to choose from.
- **Action brief** — action traversal encounters unresolved `judge()`, `$observe()`, `$observeOrAsk()`, host calls, or instructions.
- **Transition brief** — the walk's position moved between nodes and evaluation is about to continue at the new position (see Transitions below). A transition brief carries no other work.

A brief may carry several reachable work items, including several instructions. Hosts must handle every presented item without depending on how many share a brief.

Resume:

- After a brief/report round, answered work is not asked again.
- Pending instructions continue to surface in follow-up `ActionBrief`s while they remain unresolved; a repeated instruction brief may carry the same instruction text with a different instruction `phase` and a different `postcheck` frontier as resolution work progresses.

### `TriggerBrief` and `TriggerReport`

`TriggerBrief` is what the runtime yields during the trigger stage. It carries the persisted trigger traversal state, unresolved semantic work from trigger bodies, and the set of arcs that are currently matchable. Trigger stage ends when `matched` is set.

```typescript
type TriggerBrief = {
  /** Selected arc once trigger stage resolves to one activation. */
  matched?: ArcRef;
  /** Arc definitions that must stay compatible with the returned traversals. */
  deps: ArcRef[];
  /** Updated trigger traversal state to persist after this yield. */
  traversals: ArcTraversalSet;
  /** Protocol or authored-execution issues surfaced while advancing from the previous yield. */
  issues: RuntimeIssue[];
  /** Unresolved semantic checks from trigger bodies. */
  judgments: JudgmentBrief[];
  /**
   * Unresolved observations from trigger bodies. A single `$observe(a)` is an
   * `ObservationBrief`; a grouped `$observe({ a, b })` is an
   * `ObservationGroupBrief`. Discriminate on the `kind` property.
   */
  observations: (ObservationBrief | ObservationGroupBrief)[];
  /** Unresolved host operation invocations from trigger bodies. */
  hostCalls: HostCallBrief[];
  /** Arcs whose triggers currently evaluate `true`. */
  matchableArcs: ArcRef[];
};
```

`TriggerReport` is what the host sends back after inspecting a trigger brief. It includes resolved work items and may name a preferred arc when multiple trigger candidates may match.

```typescript
type TriggerReport = {
  /** Preferred arc to activate if it becomes matchable. */
  preferredMatch?: ArcRef;
  /** Resolved boolean checks, keyed by brief id. */
  judgments?: Record<BriefId, boolean>;
  /**
   * Resolved observations, keyed by brief id. A single-observation id maps to an
   * `ObservationReport`; a grouped-observation id maps to an
   * `ObservationGroupReport`.
   */
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  /** Resolved host calls, keyed by brief id. */
  hostCalls?: Record<BriefId, HostCallReport>;
};
```

### `ActionBrief`

`ActionBrief` is the reportable frontier the runtime yields during the action stage. Action-stage entrypoints return `ActionBrief | TerminalBrief`, and hosts narrow the output through `canProgress`. Its `allowedMoves` determines which control moves the host may submit at the current frontier.

```typescript
type ActionBrief = {
  /** Updated traversal state. */
  traversals: ArcTraversalSet;
  /** The node currently being worked on. */
  active: NodeRef;
  /** This is a reportable frontier accepted by Runtime.progress. */
  canProgress: true;
  /** Protocol or authored-execution issues surfaced while advancing from the previous yield. */
  issues: RuntimeIssue[];
  /** Pending boolean checks. */
  judgments: JudgmentBrief[];
  /**
   * Pending cell assessments. Single `$observe(a)` yields an `ObservationBrief`;
   * grouped `$observe({ a, b })` yields an `ObservationGroupBrief`, resolved by
   * one atomic report. Discriminate on the `kind` property.
   */
  observations: (ObservationBrief | ObservationGroupBrief)[];
  /** Pending host operation invocations. */
  hostCalls: HostCallBrief[];
  /** Host-directed guidance text (typically used to steer host LLM output). */
  instructions: InstructionBrief[];
  /** The walk's position moved; exclusive of all other work (see Transitions). */
  transition?: NodeTransition;
  /** Required deflection awaiting host acknowledgement; exclusive of other work. */
  deflection?: DeflectionContext;
  /** Valid moves for the report. */
  allowedMoves: ActionMove[];
};
```

### `TerminalBrief`

`TerminalBrief` ends the current action progression and cannot be submitted to `Runtime.progress`.

```typescript
type TerminalBrief = {
  /** Updated traversal state at handback. */
  traversals: ArcTraversalSet;
  canProgress: false;
  /** Registered root whose action stage produced this result. */
  root: ArcRef;
  issues: RuntimeIssue[];
} & (
  | {
      outcome: "covered";
      /** Committed root returns, when the root declares return channels. */
      returns?: Record<string, CellValue>;
    }
  | {
      outcome: "deflected" | "poisoned" | "interrupted";
      returns?: never;
    }
);
```

`TerminalBrief` has no `active`, work arrays, `transition`, `deflection`, or `allowedMoves`. A covered root with declared returns exposes cloned values for the keys it actually staged, including `{}` when it staged none. `returns` is absent when the root declares no return channels and for every other outcome. `root` identifies the action root when `traversals` also contains other roots.

### `ActionReport`

`ActionReport` is what the host sends back after inspecting an action brief. It includes itemized results and a move that tells the runtime what to do next.

```typescript
type ActionMove = "proceed" | "deflect" | "interrupt" | "poison";

type ActionReport = {
  /**
   * "proceed" — host submits this report and requests traversal progression.
   *   This is host-driven and does not imply exactly one new user/assistant
   *   message since the prior brief. It does not imply that any instruction was
   *   applied; application is reported per instruction id below.
   * "deflect" — requests deflection at the active node, subject to its catch
   *   hook and the ordinary propagation rules. Only
   *   available when `allowedMoves` includes it: a brief carrying no
   *   instruction, unresolved host-call action, or transition, or the exclusive
   *   required-deflection frontier.
   * "interrupt" — requests interruption without acknowledging pending work.
   *   Requires interruption: { id: string; reason?: string }, without work results.
   * "poison" — host cannot execute the current frontier contract. The active
   *   arc becomes terminally poisoned. Available on progressable frontiers
   *   except the exclusive required-deflection frontier.
   */
  move: ActionMove;
  /** Required for interrupt; unavailable on other moves. Omitted reason reads as "". */
  interruption?: { id: string; reason?: string };
  /** Optional diagnostic used when `move` is "poison". */
  poisonReason?: {
    reasonCode?: string;
    reason?: string;
  };
  /** Instructions the host actually applied, keyed by apply-phase brief id. */
  instructions?: Record<BriefId, InstructionReport>;
  /** Resolved boolean checks, keyed by brief id. */
  judgments?: Record<BriefId, boolean>;
  /**
   * Resolved observations, keyed by brief id. A single-observation id maps to an
   * `ObservationReport`; a grouped-observation id maps to an
   * `ObservationGroupReport`.
   */
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  /** Resolved host calls, keyed by brief id. */
  hostCalls?: Record<BriefId, HostCallReport>;
};
```

Nodes that complete all reachable actions and effects become covered automatically. Nodes bypassed by explicit guard logic become skipped. A `poison` move reports a malformed or unusable frontier.

### Issues

Every brief carries the `RuntimeIssue`s surfaced while advancing from the previous yield.

```typescript
type RuntimeIssue =
  | {
      kind: "poisoned-traversal";
      arc: ArcRef;
      active: NodeRef;
      source?: SourceRange;
      reasonCode?: string;
      reason?: string;
    }
  | { kind: "invalid-report"; reasonCode?: string; reason?: string }
  | {
      kind: "invalid-item";
      briefId: BriefId;
      reasonCode?: string;
      reason?: string;
    }
  | {
      kind: "ambiguous-match";
      matchableArcs: ArcRef[];
      reasonCode?: string;
      reason?: string;
    };
```

- `poisoned-traversal` — a traversal poisoned. See [Poisoning](#poisoning).
- `invalid-report` — the whole report was rejected.
- `invalid-item` — one reported item was rejected, and valid items were applied.
- `ambiguous-match` — several arcs matched and no `preferredMatch` selected one.

### Deflections

Every new deflection starts with an accepted host `deflect` report. A host may choose deflection on an ordinary eligible frontier. When a guard or an instruction's `deflectWhen` requires deflection, the runtime instead yields an exclusive `ActionBrief` carrying `deflection: { origin }` whose `allowedMoves` is exactly `["deflect"]`. The host identifies this boundary by inspecting `brief.deflection`. The field is absent on ordinary work, transitions, and applied catch frontiers.

```typescript
type DeflectionContext = {
  /** The node where the deflection originated. Preserved while it propagates. */
  origin: NodeRef;
  /** The `$enter`/`$enterLoop` target it last propagated through. Unset at the origin. */
  from?: NodeRef;
};
```

The host persists the returned traversals and prepares the handoff before reporting `{ move: "deflect" }` with the dialog for the current position. Catch handling, effects, propagation, and deflection-driven abandonment begin after acknowledgement.

Guard completion, accepted instruction application and settled lap evidence, and enclosing invoke/map ownership survive reconstruction. `start(savedTraversals, dialog)` re-yields the same request without reevaluating its cause. An outstanding transition is acknowledged first, with the deflection request still pending afterward. Propagation and resumed catches create no new request; a new policy deflection after a caught restart does.

Accepted deflection is an execution boundary. A subsequent authored failure in catch, effects, or a restarted body returns a poisoned result based on the acknowledged state, preserving acceptance. Rejected reports leave the request pending. Repeating the same immutable brief and report remains deterministic; hosts suppress duplicate external records for repeated progression.

### Transitions

Every authored evaluation runs against the dialog the host supplied, and a host may project different parts of an arc against different views. A **transition** is how the runtime tells the host the walk's position changed, so the host can supply the dialog for the new position before evaluation continues there. The runtime does not decide which view a position gets: it names the position, hands over that node's `hostParams`, and evaluates against whatever comes back.

```typescript
type NodeTransition = {
  /** Nodes the walk left, innermost first. */
  exited: NodeRef[];
  /** Nodes the walk entered, outermost first. */
  entered: NodeRef[];
  /** The node evaluation continues at. */
  position: NodeRef;
  /** The position node's authored hostParams; `undefined` when it declares none. */
  hostParams: PayloadValue;
};
```

One transition describes one stretch of position changes with no intervening authored evaluation. A guarded child or a branch condition between hops forces a per-hop transition — that evaluation is precisely what needs the new view — while guard-less enter chains and uncaught deflections through hookless, effect-less ancestors coalesce into one multi-element transition.

A transition brief is **exclusive**: it carries no judgments, observations, host calls, or instructions. Any work that could ride along would have been produced under the old view, so it surfaces only after acknowledgment, posed under the fresh projection — which may also change what is posed. The resulting invariant is that reports are **view-pure**: a work report answers work under the current view (same view, possibly newer content), and a transition proceed changes the view and answers nothing.

`allowedMoves` for a transition brief is `["poison", "proceed"]`. The host may rely on exclusivity without checking: when `transition` is present the work arrays are empty, and the report is the bare move — no judgment, observation, host-call, or instruction entries, since there is nothing they could answer, and the runtime applies no itemized results when acknowledging a transition. The proceed's significance is the dialog argument that accompanies it, which the host projects for `position` — the runtime interprets no host params, so `hostParams` hands the host whatever its own projection rule reads. A host that cannot produce the projection fails the same way it fails a host call: it poisons the frontier rather than letting the walk continue on a wrong view. An unacknowledged transition persists with the traversal set and re-yields after a restart, and a rejected report re-carries it.

Transitions surface only during the action stage; trigger probing evaluates against the single projection of the activating inbound and never announces position changes.

### Work Items

Each work item identifies its request with `id` and its source node with `sourceRef`. Work from an `invoke(() => { ... })` body or an `arr.$map(callback, results?)` callback carries the enclosing node's ref, while an `$enter(newcopy(...))` inside a callback briefs under the entered copy. Match reports to briefs by id rather than interpreting the ref. Alongside work-specific inputs, it carries `hostParams`. Action-stage work also carries optional `guidance?: SemanticText` rendered from that node's `this.guidance`; trigger work neither evaluates nor carries guidance. The host applies guidance as standing context; observation groups share it across their fields. Undeclared guidance is absent, and an explicitly empty string is preserved.

#### Semantic Text

Semantic text is the host-facing representation of authored template literals intended for LLMs/agents to consume. The runtime resolves ordinary value expressions to text, but it preserves semantic mentions that only the host can render correctly for the current agent, workspace, and prompt format.

```typescript
type SemanticText = string | SemanticTextPart[];

type SemanticTextPart =
  | { kind: "text"; value: string }
  | { kind: "entity"; name: "user" | "self" }
  | { kind: "artifact"; path: string }
  | { kind: "hostVar"; module: string; path: string[] };
```

If a rendered semantic text contains no deferred mentions, the runtime may return it as a plain string. If it contains `user`, `self`, an artifact mention, or a host-variable mention, the runtime returns parts. The host is responsible for rendering those parts into the concrete text, file paths, URLs, routing metadata, or prompt conventions used by the agent harness it is driving.

Artifact semantic parts carry logical workspace-relative paths. The runtime does not open files or resolve those paths against the host filesystem.

Host variables are authored as direct member references on a `host:*` import inside a template literal, such as `${Audience.supervisor}` or `${Audience["group"].supervisor}` for `import Audience from "host:audience"`. The runtime emits `{ kind: "hostVar", module: "audience", path: ["supervisor"] }` or a longer `path` for nested references, and does not resolve the reference further. Hosts decide whether a host variable renders as text, selects an audience, maps to another runtime object, or is rejected as unsupported.

#### Judgments

`JudgmentBrief` represents a request by the runtime to answer a boolean question — from a `judge()` call in the arc source. The host evaluates the question against conversation context and reports `true` or `false`.

```typescript
type JudgmentBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Rendered action-stage standing guidance from the source node, when declared. */
  guidance?: SemanticText;
  /** Rendered semantic question. */
  question: SemanticText;
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
};
```

#### Observations and Observation Groups

`ObservationBrief` asks the host to extract a value for a whole cell, array element, or struct field selected by `$observe()` or `$observeOrAsk()`. The host uses the question and target metadata to interpret conversation context. With `mode: "observeOrAsk"`, it may ask the user directly.

```typescript
type ObservationBrief = {
  /** Discriminates this from `ObservationGroupBrief` on the shared channel. */
  kind: "observation";
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Rendered action-stage standing guidance from the source node, when declared. */
  guidance?: SemanticText;
  /** Canonical concrete target label, for example "items[2]". */
  cell: string;
  /** Whether the host may ask the user. */
  mode: "observe" | "observeOrAsk";
  /** Rendered semantic observation question from arc source. */
  question: SemanticText;
  /** Current target value, present only when the target is set. */
  currentValue?: ObservedValue;
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
  /** Target type metadata for host-side validation/UI. */
  meta: ObservationMeta;
};
```

`ObservedValue` and `ObservationMeta` are exported by `arc/runtime`. Metadata describes the target's scalar constraints, union members, array element spec, or struct fields. Struct fields carry their own questions; a union has one question for the whole target. `currentValue` is informational and may lie outside the constraints for a new observation.

The host reports one outcome:

```typescript
type ObservationReport =
  /** A complete concrete value of the target's type. */
  | { status: "resolved"; value: ObservedValue }
  /**
   * "unknown" — could not determine; existing state is preserved.
   * "needs-user" — a participant must be asked; `$observeOrAsk()` only.
   */
  | { status: "unknown" | "needs-user"; value?: never };
```

A resolved value must satisfy the target metadata. Arrays carry complete lists, and structs carry exactly their declared fields, recursively. A union accepts one value satisfying any member, including when several members match. Its report carries that value directly. An explicit Enum answer requires evidence and is never inferred from an unknown outcome.

Numeric values must be finite and satisfy inclusive bounds when present; `rangedInt` also requires a safe integer. Negative zero is represented as zero. For numeric targets, a wrong type or integer shape produces `invalid-item` with `reasonCode: "observation-type"`; a numeric bound violation uses `"observation-range"`. For a union target, a value matching the primitive type of exactly one member reports that member's fault; any other inadmissible value uses `"observation-type"`. Invalid outcomes write nothing and leave the observation pending.

For `$observe()`, a resolved value is written, `unknown` preserves existing state, and either outcome completes the action; `needs-user` is invalid. For `$observeOrAsk()`, only a resolved value completes the action. `unknown` and `needs-user` write nothing and the observation reappears on the next brief.

`ObservationGroupBrief` asks the host to extract several targets together, from `$observe({ ... })` or `$observeOrAsk({ ... })`. It shares the `observations` channel with single observations; hosts distinguish them by `kind`.

```typescript
type ObservationGroupBrief = {
  /** Discriminates this from `ObservationBrief` on the shared channel. */
  kind: "observation-group";
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Rendered action-stage standing guidance shared by this group's fields. */
  guidance?: SemanticText;
  /** Whether the host may ask the user. */
  mode: "observe" | "observeOrAsk";
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
  /** The cells to extract together, one entry per cell. */
  fields: ObservationGroupField[];
};

type ObservationGroupField = {
  /** Canonical concrete target label — the write target and report key. */
  cell: string;
  /** Rendered semantic observation question from the cell's `observing`. */
  question: SemanticText;
  /** Current value, present only when the member is set. */
  currentValue?: ObservedValue;
  /** Cell type metadata for host-side validation/UI. */
  meta: ObservationMeta;
};
```

The host returns every requested field in one report, keyed by its `cell` label:

```typescript
type ObservationGroupReport = {
  /** One entry per field, keyed by cell name. */
  fields: Record<string, ObservationReport>;
};
```

Each field follows the same value constraints as a single observation. Missing fields or invalid outcomes reject the group, write nothing, and leave it pending. Reports carry no `kind`; hosts identify the report shape from the originating brief or the presence of `fields`.

Grouped `$observe()` writes all resolved fields together, preserves unknown fields, and completes; a `needs-user` field leaves the whole group pending without writes. Grouped `$observeOrAsk()` writes only when every field resolves in the same report. The runtime keeps no per-field progress between reports.

#### Host Calls

`HostCallBrief` represents one host operation invocation. A host call may be consumed as an expression, as in `Dice.roll(20)`, or as an action, as in `Memoir.facts.$apply(text)`. Action use is accepted throughout action graphs, including `invoke(...)`, `$map(...)`, and `this.effects`. Every use shares the same brief shape and report channel. Built-in `Dialog` snapshot and cursor helpers are resolved locally and do not emit host calls.

```typescript
type HostCallBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Rendered action-stage standing guidance from the source node, when declared. */
  guidance?: SemanticText;
  /** Host module name from `host:*`. */
  module: string;
  /** Member path before the operation, e.g. `["facts"]`. */
  target: string[];
  /** Final called member name, e.g. `"roll"` or `"apply"`. */
  operation: string;
  /** Supplied arguments. Semantic arguments may preserve semantic text parts. */
  arguments: PayloadValue[];
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
};
```

The runtime resolves the call's `module + target + operation` path through its injected host-module registry and checks every argument, including nested fields and elements, against the operation's declaration before emitting the brief. If argument admission fails, the traversal poisons with `invalid-host-argument` and emits no invalid call. Nested host calls remain unavailable as arguments because arguments must be renderable without additional host work.

`HostCallBrief.arguments` contains exactly the arguments supplied by the authored call, preserving their positions and count, including the supplied fields of nested structs. Omittable arguments and fields left out of the call remain absent; the runtime inserts no values or defaults. Every supplied value must be set and satisfy the payload rules.

The consumer decides whether a result is required. An expression consumer requires the operation to declare a result compatible with the demanded spec. An action consumer imposes no result requirement; it accepts an operation with or without a declared result and discards any value the host reports. The brief does not identify the consumer, and `operation` is always unsigiled.

The host must not infer the originating consumer from a `HostCallBrief`. `ActionBrief.allowedMoves` is authoritative for control: a call awaiting action resolution withholds `"deflect"`, while a call awaiting an expression value does not by itself withhold it.

Every host-call report has an explicit resolution envelope:

```typescript
type HostCallReport = {
  status: "resolved";
  /** Present when the operation produced a value. */
  value?: PayloadValue;
};
```

This envelope represents a void resolution without using `undefined` as the acknowledgment: `{ status: "resolved" }` is resolved with no produced value. For an expression consumer, an absent or `undefined` value becomes the existing unset result and a concrete value is admitted against the declared result before use. A mismatch is rejected as an `invalid-item` with `reasonCode: "host-call-result-type"`. Artifact interpretation follows that result spec, so a `{ path: "x" }` payload acquires Artifact authority only through an Artifact result. An action consumer ignores the `value` member.

Report values first pass transport sanitation. Every nested value must satisfy the durable payload-shape rules and every number must be finite. A non-finite number is rejected with `reasonCode: "host-call-non-finite-number"`; a malformed recursive shape uses `invalid-struct-value`. Each invalid item is removed from the accepted report subset, valid siblings remain accepted, and the rejected call reappears under the same id. Negative zero is accepted and represented as zero.

A host call used as an action follows resolved-once action-state lifetime. On first reach, the runtime captures its admitted arguments, `hostParams`, and rendered `guidance` and suspends at that action. It re-emits the captured invocation under the same brief id without reevaluating its inputs until it receives `{ status: "resolved" }` or the host poisons the frontier. Once resolved, the action slot stays resolved through ordinary retries and re-entry. A new `invoke(...)` run, a different `$map(...)` member, or a forgetful entry clears the applicable action state, so the call executes again when reached.

Persisted action state includes pending captured invocations. Restoration validates pending and resolved state shapes, call identity, captured argument admission, captured `hostParams`, and the semantic-text shape of captured `guidance` before traversal resumes. Captured arguments must preserve the authored argument count, supplied struct fields, and authored array lengths at every nesting depth.

#### Instructions

`InstructionBrief` represents text that the arc sends to the host from `$instructLoop(...)` and `$instruct(...)` actions in the action graph. Hosts typically use it as guidance for LLM generation and decide how (or whether) to surface it to the user.

```typescript
type InstructionBrief = {
  /** Opaque key. */
  id: BriefId;
  /** Source node that produced this instruction. */
  sourceRef: NodeRef;
  /** Rendered action-stage standing guidance from the source node, when declared. */
  guidance?: SemanticText;
  /** Instruction mode from arc source. */
  mode: "once" | "persistent";
  /**
   * How the host should treat this instruction in the current brief.
   * - `apply`: the instruction is in effect and should be applied as guidance.
   * - `postcheck`: the instruction remains pending, but this brief is focused
   *   on follow-up resolution checks.
   */
  phase: "apply" | "postcheck";
  /** Rendered semantic instruction text. */
  text: SemanticText;
  /**
   * Host-interpreted metadata from `this.hostParams`, with
   * `$instruct(..., { hostParams })` merged over it when both values are objects.
   * Semantic work used to evaluate that instruction's postcheck receives this
   * same merged metadata.
   */
  hostParams: PayloadValue;
  /**
   * Reachable semantic probes attached to this instruction frontier.
   * These are ids of items already present in the same ActionBrief's
   * `judgments` / `observations` / `hostCalls`.
   */
  postcheck?: InstructionPostcheck;
};

type InstructionPostcheck = {
  judgmentIds: BriefId[];
  observationIds: BriefId[];
  hostCallIds: BriefId[];
};
```

`postcheck` is not the full authored resolution logic. It includes only the check ids that are currently pending in this brief. Later briefs for the same instruction may expose a different `postcheck` frontier. An answered check does not re-pose within the same decision cycle: a hook that settles while the other hook is still open keeps its answers, so follow-up briefs carry only the open hook's checks until the instruction resolves, deflects, or returns to `apply` for a fresh cycle.

After applying an instruction, the host reports it:

```typescript
type InstructionReport = {
  status: "applied";
};
```

The host reports each `apply`-phase instruction it performed as `instructions[id]: { status: "applied" }`. Omitted ids stay in `apply`, so a brief with several instructions may be acknowledged partially. A `postcheck` instruction has already been applied for its current cycle and must not be reported applied again. How the host establishes application is outside the runtime's concern.

A `once` instruction, from `$instruct()`, resolves only after it is reported applied. A `persistent` instruction, from `$instructLoop()`, stays pending until its `resolveWhen` resolves true.

A first reach emits `phase: "apply"`. Follow-up briefs while checks are open emit `phase: "postcheck"`, and after a non-terminal check cycle the same instruction may return to `phase: "apply"`.

Application and postcheck values are separate report channels with no ordering. A host may report application first, values for the `postcheck` ids first, or both together.

A pending instruction suppresses `move: "deflect"` in both phases. True deflect evidence yields the exclusive required-deflection frontier even when the instruction has not been reported applied; acknowledge that frontier with `{ move: "deflect" }`.

Each `$instruct`, and each `$instructLoop` iteration, is one lap collecting two evidences, each banked once settled and not posed again: the deflect evidence (`deflectWhen`) and the finished evidence (application for a one-shot, `resolveWhen` for a loop).

1. A deflect evidence that settles true decides the lap and yields the required acknowledgement, honoring the finished evidence collected up to the same handback: a finished lap stays resolved through the deflection, an unfinished one retains its evidence until acknowledgement and re-presents after the deflection is handled.
2. With both evidences in and no deflection, a finished lap resolves — for a loop, a true `resolveWhen` resolves the whole action and a false one starts a fresh lap with fresh evidence.
3. Else the lap waits for its open evidence. An unapplied instruction stays in `apply`; an applied instruction with unresolved checks stays in `postcheck`.

## Runtime API

### Dialog

#### Role

`Dialog` is the canonical script-visible conversation for the semantic context the host is using to resolve the current frontier. Which view a position is projected for is the host's decision; the runtime evaluates against what it is given, and transition briefs announce position changes so the host can change the projection before evaluation continues. Whatever rule the host applies, a supplied `Dialog` must describe one conversation as one participant sees it — a reviewer-scoped conversation, say — not a writer-scoped conversation under a reviewer's `view`, and not a raw multi-agent event log.

The runtime uses `Dialog` to resolve script-visible conversation references. `Dialog.lastTurns(n)` reads from the supplied `lastTurns`, `Dialog.lastUserMessage` is derived from the most recent `user` turn in that same list, and `Dialog.cursor` exposes the current scoped turn coordinate.

Arc scripts can store a cursor in `Dialog.Cursor()` cells and compare cursors with runtime-local methods. Cursor cells are not observable and are not exposed as observation metadata.

#### Data

The host passes a scoped `Dialog` on each runtime call:

```typescript
type Dialog = {
  lastTurns: DialogTurn[];
  cursor: DialogCursor;
  /** The view this dialog is projected for; absent = default view. */
  view?: string;
};

type DialogTurn = {
  role: "self" | "user";
  message: string;
};

type DialogCursor = {
  user: number;
  self: number;
  /** The view the cursor was read from; absent = default view. */
  view?: string;
};
```

`lastTurns` contains Arc-visible `user` and `self` turns only. Hidden reasoning, tool calls, tool results, retries, streaming chunks, and background agent work are not dialog turns unless the host explicitly projects them into visible `user` or `self` turns.

`cursor.user` and `cursor.self` are opaque numeric coordinates for the scoped visible dialog. Their absolute values have no portable meaning. The runtime accepts only non-negative JavaScript safe integer coordinates.

`Dialog.view` names the projection this dialog was taken from. The runtime treats it as an opaque identity token and only compares views for equality, so the host chooses both the token and the rule that maps positions to it. What the runtime relies on is that the same projection always carries the same token — for the life of the run and across restarts, since stored cursors keep their stamp. For its default projection the host omits `view`: absence is the canonical spelling of the default view, not a distinct state. When the runtime reads `Dialog.cursor`, it stamps the resulting cursor with the dialog's `view`, and the stamp travels with stored cursor cells through persistence.

Holding the view fixed while the walk stands at one position, and changing it only across an acknowledged transition, is what keeps cursors meaningful. The runtime does not check this. A host that reprojects mid-position is not detected, and where the node reads no cursor there is no effect at all; the consequences surface only through cursors, as a `cross-view-comparison` poison when a cursor stored before the change is compared after it, or a `cursor-moved-backwards` poison when the new projection's coordinate is behind the stored one. A host whose view is a function of position never encounters either.

#### Invariants

The host must uphold these invariants within each scoped `Dialog`:

- **Scope consistency**: `lastTurns`, `cursor`, and `view` describe the same scoped visible dialog.
- **Visible-turn projection**: `lastTurns` and `cursor` are based only on Arc-visible `user` and `self` turns, using the same projection rules.
- **Exact deltas**: for any earlier and later cursors from the same view, `later.user - earlier.user` must equal exactly the number of visible `user` turns added between those cursors, and `later.self - earlier.self` must equal exactly the number of visible `self` turns added between those cursors. These deltas are therefore never negative.
- **Same-view comparison only**: a cursor is a coordinate in one projection; two views count different subsets of the conversation, so a cross-view difference measures nothing. Comparing cursors with different views poisons the traversal with `reasonCode: "cross-view-comparison"`, and the issue reason names both views. A cursor with no stamp reads as the default view.

If the host windows `lastTurns`, it must still compute `cursor` from the full scoped visible dialog, or from another durable per-view coordinate source, so cursor deltas remain exact when older turns drop out of `lastTurns`. The runtime errors if the current cursor is earlier than a stored cursor of the same view.

### Trigger Stage

**`startTrigger(traversals, dialog, { arcRefs? })`** → `TriggerBrief`

Evaluates every registered arc's trigger against the dialog and supplied traversal state. When `arcRefs` is supplied, evaluates only those registered roots and rejects unknown refs. The scope is retained by later `progressTrigger()` calls for that brief. Returns a `TriggerBrief` that either identifies a matched arc or asks the host for more trigger-stage data. The brief also includes the updated traversal state and `deps`, the ArcRef compatibility set for that state. Hosts that persist and later resume the returned traversal set must provide compatible definitions for every ArcRef in `deps`; they may load other arcs as well.

For a fresh trigger probe with no persisted state, call:

```typescript
runtime.startTrigger(runtime.newTraversalSet(), dialog);
```

**`progressTrigger(brief, report, dialog)`** → `TriggerBrief`

Accepts a trigger report and returns the next trigger brief.

`dialog` is the current conversation snapshot at the time the host hands control back to Arc. It may be newer than the dialog that produced `brief`.

Arc selection: (1) resume each candidate's trigger consultation with the accepted report data — answered work stays pinned per candidate across the brief chain, candidates whose consultation already reached a terminal outcome keep it without re-running, and a `preferredMatch` sent on an earlier chain report is retained; (2) if the requested `preferredMatch` is currently matchable, select it immediately and forego all other pending trigger work; (3) otherwise, if any candidate consultation still has unresolved work, return another trigger brief containing both the current `matchableArcs` and that pending work; (4) otherwise, if the requested `preferredMatch` has settled unmatched, reject that selection with `trigger-match-not-matchable` without applying implicit auto-selection or ambiguity handling; (5) otherwise, if exactly one arc is matchable, auto-select it; (6) otherwise return the settled unmatched or ambiguous brief. A fresh `startTrigger(...)` starts new consultations for every candidate; consultation state does not survive a process restart.

When a trigger brief contains both `matchableArcs` and pending judgments, observations, or host calls, the host may continue the consultations by reporting that work, or it may return only a `preferredMatch` naming an arc already in `matchableArcs`. That explicit selection resolves trigger stage immediately; the resulting matched brief contains no leftover trigger work. A preference naming a still-open candidate remains pending until its consultation settles. Other matchable arcs do not provide an implicit fallback if that preference fails to match.

When trigger report validation fails, `progressTrigger(...)` returns a new `TriggerBrief` with `issues` describing the rejection. For those issues with `kind: "invalid-report"`, the runtime rejects the report as a whole, applies no changes, and re-yields the same trigger frontier. For issues with `kind: "invalid-item"`, the runtime applies the valid subset of reported results and re-yields the rejected work items. An `invalid-report` issue determined only after accepted results settle candidate consultations does not undo those results.

When authored trigger execution fails, `progressTrigger(...)` returns a `TriggerBrief` whose `issues` record the poisoned candidate; probing continues for the remaining arcs.

After all candidate consultations settle, when multiple arcs are matchable and no `preferredMatch` selects one, the runtime returns a `TriggerBrief` with `issues` containing `kind:"ambiguous-match"` and expects a later `TriggerReport` to name one specific `preferredMatch`.

### Action Stage

**`start(traversals, dialog)`** → `ActionBrief | TerminalBrief`

Begins or reconstructs runtime work for an existing action traversal. There must be exactly one root traversal in the `"entered"` phase. Pending work continues within its existing entry; an interrupted root has its node state cleared before continuation. In a trigger-driven run, use the traversal set in the latest `TriggerBrief` once `matched` is set. An in-progress direct Arc entry is resumed on a fresh runtime by adding compatible documents, calling `init()`, and then calling `start(savedTraversals, dialog)`; `enterArc` is not called again.

**`enterArc(arc, dialog, options?)`** → `ActionBrief | TerminalBrief`

Freshly enters one registered Arc without evaluating its trigger or creating traversals for other Arcs. The entered traversal has `enterCount: 1`, and the runtime executes the Arc's action graph until it yields an `ActionBrief` or stops with a `TerminalBrief`. `options.args` supplies its `args.*` channels by value: supplied keys must be declared and each value must satisfy its `ChannelSpec`; unknown keys and incompatible values throw as caller errors before action execution. Accepted values are deep-cloned and canonicalized, omitted declared args remain unset, and local initializers run after args installation and before the body.

**`progress(brief, report, dialog)`** → `ActionBrief | TerminalBrief`

Accepts the exact current `ActionBrief` object returned by this runtime and an action report, then returns the next `ActionBrief` frontier or a `TerminalBrief`. Only an `ActionBrief` is accepted by `progress`.

`dialog` is the current conversation snapshot at the time the host hands control back to Arc. It may be newer than the dialog that produced `brief`, and it must be projected for the current position — a transition brief announces when that position changes.

`progress(...)` cadence is host-driven. It is not required to map one-to-one to conversation message cadence. A host may call `progress(...)` whenever it finishes part or all of the work specified in a brief, regardless of after how many rounds of conversation with the user.

When the report is accepted and execution continues normally, `progress(...)` returns the next action frontier for the active root.

When the current action progression ends, the action-stage call returns `TerminalBrief` with its explicit `root` and `outcome`. Covered roots expose cloned committed root returns according to the rules above. Deflection, poison, and interruption expose no returns. When `report.move` is `"poison"`, or when authored execution fails during advancement, the terminal outcome is `"poisoned"` and `issues` carries the structured failure.

When report validation fails, `progress(...)` returns an `ActionBrief` with `issues`. For issues with `kind: "invalid-report"`, the runtime rejects the report as a whole, applies no changes, and re-yields the same frontier. This includes unlisted moves and fields disallowed by the selected move or frontier. For issues with `kind: "invalid-item"`, the runtime applies the valid subset of reported results and re-yields only the rejected work items.

### References

| Type      | Format                | Purpose                            |
| --------- | --------------------- | ---------------------------------- |
| `ArcRef`  | opaque runtime string | Identifies a registered arc.       |
| `NodeRef` | opaque runtime string | Identifies a node (source + path). |
| `BriefId` | opaque runtime string | Identifies a work item in a brief. |

Construct and destructure refs through the helpers exported by `arc/runtime` (`toArcRef`, `toArcRefParts`, `toNodeRef`, `toNodeRefParts`). Callers should not assume a specific string layout.
