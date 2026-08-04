# Arc Runtime API

The runtime executes parsed Arc scripts together with a **host**. It traverses action graphs, manages traversal state, and yields structured briefs when it needs host involvement. The host carries out semantic work — LLM calls, cell extraction, instruction delivery — and reports back. The runtime never calls an LLM or performs any semantic resolution itself.

## Mental Model

Arc execution is a conversation between the runtime and the host. The runtime walks the graph and knows what work needs doing. The host knows how to do that work. They communicate through ephemeral **briefs** (runtime → host) and **reports** (host → runtime).

One walk of an arc proceeds in two stages:

1. **Trigger stage** — the runtime evaluates dormant arcs' triggers to decide which arc becomes active. Triggers may contain semantic checks that require host resolution, so this stage follows the brief/report exchange.

2. **Action stage** — the runtime traverses the active arc's action graph. At each step it advances until it reaches work it cannot resolve deterministically and yields a brief. The host resolves the brief and reports back with a move. This loop repeats until the arc completes or can no longer progress.

There is only one active arc being traversed at a time.

After the action graph resolves, the node's effects block runs. Effects may require additional resolution rounds. Once effects finish, any emitted host effects are surfaced in a brief for the host to handle.

## Traversal State

Traversal state is the persistent, serializable representation of an arc's progress. It lets the runtime resume walks from where it left off across turns, sessions, and process restarts.

### Arc Traversal and Node Traversal

An **arc traversal** represents the full state of one arc: its lifecycle phase, enter count, cell values, action resolution state, and child traversals. It is the top-level unit of persistence.

A **node traversal** represents the state of a single node within an arc. For owned children (nested function declarations), traversal data is stored inline under the parent. For imported arcs entered via a parent arc, each gets its own arc traversal managed directly by the runtime.

Runtime instances are purely in-memory. The host is responsible for persisting traversal state between turns — a serverless handler, for example, can spin up a fresh runtime, register the same documents, and resume any session from its own storage.

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

**Host-initiated.** The host reports `move: "poison"` on an action frontier it cannot execute — a malformed or unusable frontier, such as an instruction missing required host params. The runtime discards any work-item results carried by a poison report; poison ends the frontier rather than resolving its semantic work. The host may attach a `poisonReason` (`reasonCode`, `reason`); when it is omitted, the runtime records `reasonCode: "host-poisoned"`.

**Runtime-initiated.** Authored Arc execution throws while the runtime advances a trigger or an action. Known failure sites attach a stable cause-specific `reasonCode`, which the runtime preserves at the advancement boundary. An uncategorized exception records `reasonCode: "other-runtime-error"`.

In both cases the runtime sets the traversal `phase` to `"poisoned"` and surfaces a `poisoned-traversal` issue that names the responsible `arc`, the `active` node, and the `reasonCode`/`reason` describing the cause.

What poison terminates depends on the stage:

- **Action stage.** Poison ends the active root. `start()` or `progress()` returns a brief with the root `"poisoned"`, `canProgress: false`, and no further moves or work items.
- **Trigger stage.** A poisoned candidate is contained. Only that arc's traversal is poisoned; probing continues for the other arcs, and the poisoned arc is barred from future trigger matching.

The stable causes for runtime-initiated poison are:

| `reasonCode` | Runtime condition |
| --- | --- |
| `invalid-cell-assignment` | A `$set()` value is absent, has the wrong primitive type, or targets a cell kind that cannot be assigned; `$unset()` also reaches this case when its target cannot be unset, including Artifact cells. Reading an unset cell into `$set()` reaches this case because the resulting value is `undefined`. |
| `invalid-cell-target` | A cell target attempts to access through a scalar or exceeds the runtime's supported target depth. Validated documents should normally prevent this. |
| `invalid-array-index` | An array read or cell-target accessor resolves to a value that is not a non-negative integer. |
| `array-index-out-of-range` | An array read or cell-target accessor resolves to an index outside the existing array bounds. An index equal to the array length does not append. |
| `invalid-array-operation` | Runtime evaluation attempts an array read, target access, element write, or map operation against a value that is not an array. Validated documents should normally prevent this. |
| `cell-out-of-range` | A value written to `RangedInt` falls outside its declared inclusive bounds. |
| `invalid-enum-value` | A value written to `Enum` is not one of its declared values. |
| `unknown-cell` | Runtime evaluation cannot resolve the cell targeted by `$set()`, `$unset()`, `$observe()`, or an internal write. Validated documents should normally prevent this. |
| `invalid-observation-target` | Runtime evaluation reaches `$observe()`, `$observeOrAsk()`, or a grouped `$observe({ ... })` field with a non-observable cell such as `Dialog.Cursor`. Validated documents should normally prevent this. |
| `unknown-channel-key` | An `args.*` or `returns.*` key is read or written but the caller's `$enter()` did not wire that key. |
| `invalid-channel-binding` | A wired channel points to a caller cell or owner traversal that no longer exists. |
| `invalid-return-value` | A `returns.*.$set()` host-call result is not a primitive value that can be committed to a caller cell. |
| `invalid-template-interpolation` | An evaluated interpolation in a value or semantic template resolves to an unset value; value templates also reject non-primitive values. |
| `unset-value` | An unset value is evaluated as a boolean or emitted as a concrete host-call value argument. Comparisons may consume unset values without poisoning: equality and ordering return `false`, except inequality returns `true`, whenever either operand is unset. |
| `invalid-artifact-path` | A rendered artifact path is blocked, empty, absolute, or contains `.` or `..` segments. |
| `invalid-dialog-cursor` | `Dialog.cursor`, a stored cursor, a cursor assignment, or a `*TurnsSince()` operand does not have a valid cursor shape. |
| `cross-view-comparison` | A cursor difference compares coordinates stamped with different dialog views; the issue reason names both views. |
| `cursor-moved-backwards` | A live `Dialog.cursor` is behind a stored cursor from the same view. |
| `other-runtime-error` | An exception reaches the advancement boundary without a recognized cause-specific code. |

Invalid judgment or observation results supplied in a report do not poison the traversal. They surface as `invalid-item` issues with their own validation reason codes. A grouped observation report that omits a field, or supplies a field value failing its cell's type, is invalid the same way: the group writes nothing and re-emits.

### Node State vs. Node Frame

Two pieces of traversal state that serve distinct purposes:

**Node state** is the outcome — what happened to the node as a whole. It is one of `COVERED`, `DEFLECTED`, `SKIPPED`, or not yet resolved. The parent's action graph reads it through `ReferenceName.state` to decide whether to re-enter or move on. Node state is set by the runtime (`COVERED` when all reachable actions and effects complete, `DEFLECTED` on host-initiated deflection) or by explicit guard logic (`SKIPPED`). `forgetful(ReferenceName)` explicitly clears the prior canonical node state and starts a new entry whose eventual outcome becomes the new `ReferenceName.state`.

Canonical node state is addressable from Arc source through `ReferenceName.state`. Blank anonymous copies created through `newcopy(ReferenceName)` are not addressable from Arc source and do not change the meaning of `ReferenceName.state`. Forgetful entries created through `forgetful(ReferenceName)` remain addressable and replace the prior canonical outcome with the new entry's outcome.

An `invoke(() => { ... })` body runs inline in its enclosing node, so a brief emitted from inside one carries the enclosing node's ref. Match reports to briefs by id rather than interpreting the ref.

An `arr.$map(callback, results?)` callback runs inline the same way: work a member emits directly carries the enclosing node's ref, while an `$enter(newcopy(...))` inside the callback briefs under the entered copy. Members run one at a time, so at most one member's work reaches any brief, and each member's brief ids are qualified by its index. The pending map state persists with the traversal set, so a blocked member resumes across brief/report rounds and across a process restart.

**Node frame** is the internal resolution map — which individual actions within the node have been resolved. When a `$` action resolves, the frame records it so subsequent runs of the node bypass it. The frame is bookkeeping that the action graph author never sees directly.

On re-entry with `this.forgetfulEntry = true`, or on entry via `forgetful(ReferenceName)`, the frame is discarded — resolved actions are forgotten and the new entry's walk starts from an empty frame. Cell values and child traversal state are preserved. The new entry replaces the node's own prior outcome through ordinary entry semantics. Forgetfulness applies only at the entry boundary: during the entry, resolved actions remain remembered normally.

## Brief/Report Protocol

The runtime communicates with the host exclusively through briefs and reports. When the runtime reaches a point requiring host involvement, it yields a **brief** describing the pending work and carrying contextual information. The host resolves the pending items, chooses a move, and sends back a **report**. The runtime uses the report to advance.

Briefs also carry information the host may use at its discretion — traversal snapshots, instructions to deliver, host effects to apply. Hosts must treat brief objects as immutable:

- Do not mutate brief fields in place.
- Do not reconstruct or clone a brief and pass the copy back.
- Pass the same trigger brief object instance returned by `startTrigger()` or `progressTrigger()` to the next `progressTrigger()` call.
- Pass the same brief object instance returned by `start()` / `progress()` to the next `progress()` call.

The report only needs to address the pending work items and the chosen move.

Briefs and reports are ephemeral — they are valid only for the runtime call that produced them.

### Brief Rules

A brief is emitted when the current walk reaches a frontier that requires host coordination.

An **execution walk** is one top-down pass through the active arc's action graph. Each `start()` call performs one planning walk. Each `progress()` call first applies the report, then performs a new planning walk to produce the next brief.

The runtime emits briefs under these conditions:

- **Trigger brief** — trigger evaluation encounters unresolved semantic work (`judge()`, `$observe()`, expression-position host calls), or triggers finish with matchable arcs for the host to choose from.
- **Semantic-work action brief** — action traversal encounters unresolved `judge()`, `$observe()`, `$observeOrAsk()`, or expression-position host calls.
- **Instruction brief** — action traversal reaches one or more reachable instruction actions in the current node body.
- **Transition brief** — the walk's position moved between nodes and evaluation is about to continue at the new position (see Transitions below). A transition brief carries no other work.

Batching:

- Semantic work may batch when multiple unresolved items are reachable at the same frontier.
- Instruction actions batch only within the **currently executing node body**.
- Instruction actions batch only when their effective merged `hostParams`, mode, `resolveWhen`, and `deflectWhen` match.
- Entering a child with `$enter(ReferenceName)`, returning to a caller, or beginning `this.effects` ends an instruction batch.
- An action brief never mixes instructions from different node bodies.

Resume:

- After a brief/report round, traversal seeks the suspended frontier: it lands back on the frontier without re-asking work answered earlier in the same walk.
- Pending instructions continue to surface in follow-up `ActionBrief`s while they remain unresolved; a repeated instruction brief may carry the same instruction text with a different instruction `phase` and a different `postcheck` frontier as resolution work progresses.

### `TriggerBrief`

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
  /** Unresolved host-backed value requests from trigger bodies. */
  hostCalls: HostCallBrief[];
  /** Arcs whose triggers currently evaluate `true`. */
  matchableArcs: ArcRef[];
};
```

### `TriggerReport`

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
  /** Resolved host-call values, keyed by brief id. */
  hostCalls?: Record<BriefId, PayloadValue>;
};
```

### `ActionBrief`

`ActionBrief` is what the runtime yields during the action stage. It describes the current traversal state, pending work items, and any instructions or host effects that surfaced during this walk.

```typescript
type ActionBrief = {
  /** Updated traversal state. */
  traversals: ArcTraversalSet;
  /** The node currently being worked on. */
  active: NodeRef;
  /** Whether the runtime can advance further. */
  canProgress: boolean;
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
  /** Pending host-backed value requests. */
  hostCalls: HostCallBrief[];
  /** Host-directed guidance text (typically used to steer host LLM output). */
  instructions: InstructionBrief[];
  /** Host effects emitted during this step. */
  hostEffects: HostEffectBrief[];
  /** The walk's position moved; exclusive of all other work (see Transitions). */
  transition?: NodeTransition;
  /** Valid moves for the report. */
  allowedMoves: ActionMove[];
};
```

### `ActionReport`

`ActionReport` is what the host sends back after inspecting an action brief. It includes resolved work items and a move that tells the runtime what to do next.

```typescript
type ActionReport = {
  /**
   * "proceed" — host hands control back and requests traversal progression.
   *   This is host-driven and does not imply exactly one new user/assistant
   *   message since the prior brief. For instruction frontiers, this hands the
   *   current instruction frontier back according to the semantics of its
   *   `mode`.
   * "deflect" — user changed topic; the active node becomes deflected and is
   *   eligible for re-entry. Pending effects still run. Only available when
   *   `allowedMoves` includes it: a brief whose pending work is semantic —
   *   judgments, observations, or host calls — carrying no instruction, host
   *   effect, or transition.
   * "poison" — host cannot execute the current frontier contract. The active
   *   arc becomes terminally poisoned. Available while the action traversal can
   *   progress, including frontiers that are blocked on unreported host
   *   effects.
   */
  move: ActionMove;
  /** Optional diagnostic used when `move` is "poison". */
  poisonReason?: {
    reasonCode?: string;
    reason?: string;
  };
  /** Resolved boolean checks, keyed by brief id. */
  judgments?: Record<BriefId, boolean>;
  /**
   * Resolved observations, keyed by brief id. A single-observation id maps to an
   * `ObservationReport`; a grouped-observation id maps to an
   * `ObservationGroupReport`.
   */
  observations?: Record<BriefId, ObservationReport | ObservationGroupReport>;
  /** Resolved host-call values, keyed by brief id. */
  hostCalls?: Record<BriefId, PayloadValue>;
  /** Resolved host effects, keyed by brief id. */
  hostEffects?: Record<BriefId, HostEffectReport>;
};
```

Nodes that complete all reachable actions and effects become covered automatically. Nodes bypassed by explicit guard logic become skipped. Poison is a host-initiated contract failure for a malformed or unusable frontier.

A node reaches the deflected outcome two ways. `move: "deflect"` is host-initiated: the host decides, at its own discretion, on a frontier where `allowedMoves` offers the move. An authored `deflectWhen` deflects on the arc's own policy, evaluated by the runtime from probes the host answers — there the host supplies a judgment, not a decision. The two never compete for one frontier: `deflectWhen` is consulted only while a reachable instruction is pending, which is exactly when the host-initiated move is withheld.

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
  /** The position node's authored hostParams; null when it declares none. */
  hostParams: PayloadValue;
};
```

One transition describes one stretch of position changes with no intervening authored evaluation. A guarded child or a branch condition between hops forces a per-hop transition — that evaluation is precisely what needs the new view — while guard-less enter chains and uncaught deflections through hookless, effect-less ancestors coalesce into one multi-element transition.

A transition brief is **exclusive**: it carries no judgments, observations, host calls, instructions, or host effects. Any work that could ride along would have been produced under the old view, so it surfaces only after acknowledgment, posed under the fresh projection — which may also change what is posed. The runtime enforces this; a transition brief with work is a runtime defect, not a host concern. The resulting invariant is that reports are **view-pure**: a work report answers work under the current view (same view, possibly newer content), and a transition proceed changes the view and answers nothing.

`allowedMoves` for a transition brief is `["poison", "proceed"]`. The host may rely on exclusivity without checking: when `transition` is present the work arrays are empty, and the report is the bare move — no judgment, observation, host-call, or host-effect entries, since there is nothing they could answer, and the runtime applies no itemized results when acknowledging a transition. The proceed's significance is the dialog argument that accompanies it, which the host projects for `position` — the runtime interprets no host params, so `hostParams` hands the host whatever its own projection rule reads. A host that cannot produce the projection fails the same way it fails a host call: it poisons the frontier rather than letting the walk continue on a wrong view. An unacknowledged transition persists with the traversal set and re-yields after a restart, and a rejected report re-carries it.

Transitions surface only during the action stage; trigger probing evaluates against the single projection of the activating inbound and never announces position changes.

### Work Item Briefs

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

Artifact paths are logical paths relative to the host's workspace for the current Arc run. If an artifact was declared with a value-template path, the runtime evaluates that template when the artifact mention is rendered and emits the resulting logical path. The runtime does not open files, resolve those paths against the host filesystem, or translate them into agent tool calls.

Host variables are authored as direct member references on a `host:*` import inside a template literal, such as `${Audience.supervisor}` or `${Audience["group"].supervisor}` for `import Audience from "host:audience"`. The runtime emits `{ kind: "hostVar", module: "audience", path: ["supervisor"] }` or a longer `path` for nested references, and does not resolve the reference further. Hosts decide whether a host variable renders as text, selects an audience, maps to another runtime object, or is rejected as unsupported.

#### `JudgmentBrief`

`JudgmentBrief` represents a request by the runtime to answer a boolean question — from a `judge()` call in the arc source. The host evaluates the question against conversation context and reports `true` or `false`.

```typescript
type JudgmentBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Rendered semantic question. */
  question: SemanticText;
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
};
```

#### `ObservationBrief`

`ObservationBrief` represents a request by the runtime to extract a cell target's value — from an `$observe()` or `$observeOrAsk()` call. The target may be a whole cell or a concrete array element selected by the authored target expression. The host infers the value from conversation context using the provided question and the target leaf's type definition. When `mode` is `"observeOrAsk"`, the host may ask the user directly instead of inferring.

```typescript
type ObservationBrief = {
  /** Discriminates this from `ObservationGroupBrief` on the shared channel. */
  kind: "observation";
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Canonical concrete target label, for example "items[2]". */
  cell: string;
  /** Whether the host may ask the user. */
  mode: "observe" | "observeOrAsk";
  /** Rendered semantic observation question from arc source. */
  question: SemanticText;
  /** Current target-leaf value, if any. */
  currentValue?: PrimitiveValue | ArrayValue;
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
  /** Target-leaf type metadata for host-side validation/UI. */
  meta: ObservationValueMeta;
};

type ScalarObservationMeta = {
  type: "enum" | "boolean" | "rangedInt" | "string";
  values?: string[];
  min?: number;
  max?: number;
};

type ObservationValueMeta =
  | ScalarObservationMeta
  | {
      type: "array";
      element: ScalarObservationMeta;
    };
```

The host reports the outcome as an `ObservationReport`:

```typescript
type ObservationReport = {
  /**
   * "resolved" — value inferred, include `value`.
   * "unknown" — could not determine. For `$observe()`, the action is consumed
   *   without writing a new value. For `$observeOrAsk()`, the action resurfaces
   *   next brief.
   * "needs-user" — host wants the user to answer (observeOrAsk only), and the
   *   action resurfaces next brief.
   */
  status: "resolved" | "unknown" | "needs-user";
  /** The reported value. */
  value?: PrimitiveValue | ArrayValue;
};
```

#### `ObservationGroupBrief`

`ObservationGroupBrief` represents a request to extract several cells together — from an `$observe({ ... })` or `$observeOrAsk({ ... })` call. It shares the `observations` channel with `ObservationBrief`; the two are distinguished by `kind`. Sharing the channel means a host that iterates `observations` is forced to handle the group variant rather than silently leaving it unresolved (which would deadlock the arc). The host infers the whole set in one inference and reports every field in one report. The group is one resolved-once action: the runtime applies the report as a unit and keeps no per-field progress.

```typescript
type ObservationGroupBrief = {
  /** Discriminates this from `ObservationBrief` on the shared channel. */
  kind: "observation-group";
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
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
  /** Current value, if any. */
  currentValue?: PrimitiveValue | ArrayValue;
  /** Cell type metadata for host-side validation/UI. */
  meta: ObservationValueMeta;
};
```

The host reports the outcome as an `ObservationGroupReport`. It must carry an entry for every field in the brief; a report that omits a field is invalid, surfaces an `invalid-item` issue, writes nothing, and re-emits the group.

Each entry is an `ObservationReport`, so an `Array` field reports its whole list exactly as a single array observation does. Reports carry no `kind`: read `ObservationGroupReport` apart from `ObservationReport` by the `fields` property, or by the `kind` of the brief the id came from.

```typescript
type ObservationGroupReport = {
  /** One entry per field, keyed by cell name. */
  fields: Record<string, ObservationReport>;
};
```

When every field is `resolved` or `unknown`, the runtime writes all `resolved` values together and resolves the group. When any field is `needs-user`, the group re-emits and nothing is written.

#### `HostCallBrief`

`HostCallBrief` represents a request by the runtime to get a value from a host module — from an expression-position host call like `Dice.roll(20)` or `Dice["tables"].roll(20)`. The runtime is blocked until the host reports a value. Built-in `Dialog` snapshot and cursor helpers are resolved locally by the runtime and do not emit host calls.

```typescript
type HostCallBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node that produced this brief item. */
  sourceRef: NodeRef;
  /** Host module name from `host:*`. */
  module: string;
  /** Member path before the operation, e.g. `["facts"]`. */
  target: string[];
  /** Final called member name, e.g. `"roll"` or `"apply"`. */
  operation: string;
  /** Rendered call arguments. Semantic arguments may preserve semantic text parts. */
  arguments: PayloadValue[];
  /** Semantic metadata for this work item. */
  hostParams: PayloadValue;
};
```

#### `HostEffectBrief`

`HostEffectBrief` represents a statement-position host call emitted from a node's `this.effects` body — the runtime does not execute it; the host does, and reports back. An unreported effect keeps its node unfinished and its terminal state unset: the run cannot cover or deflect that node or continue into later nodes, and every subsequent brief re-surfaces the effect under the same id until the host reports it or rejects the frontier with `move: "poison"`. Inside the effects body, `this.pendingState` derives the eventual covered or deflected outcome from persisted finalizing state. During deflected effects, `this.deflection.escaped(Target)` compares the persisted entry-target `from` node, which is unset for the node's own frontier deflection; using it during covered effects poisons the traversal. Other briefable work from the same effects body may surface alongside the effect on the same brief; work from later nodes cannot.

Authored host-effect targets may use dot segments or static string-literal bracket segments. The runtime emits the same `module`, `target`, and `operation` shape either way.

```typescript
type HostEffectBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Source node whose effects body emitted this effect. */
  sourceRef: NodeRef;
  /** Host module name from `host:*`. */
  module: string;
  /** Member path before the operation, e.g. `["facts"]`. */
  target: string[];
  /** Final called member name, e.g. `"apply"`. */
  operation: string;
  /** Rendered call arguments. Semantic arguments may preserve semantic text parts. */
  arguments: PayloadValue[];
};
```

Each effect statement is emitted once — re-briefs of a still-unreported effect reuse its id, so the host can deduplicate deliveries by id.

The host reports a handled effect as a `HostEffectReport`:

```typescript
type HostEffectReport = {
  /** "applied" — the host handled the effect. */
  status: "applied";
};
```

#### `InstructionBrief`

`InstructionBrief` represents text that the arc sends to the host from `$instructLoop(...)` and `$instruct(...)` actions in the action graph. Hosts typically use it as guidance for LLM generation and decide how (or whether) to surface it to the user.

```typescript
type InstructionBrief = {
  /** Opaque key. */
  id: BriefId;
  /** Source node that produced this instruction. */
  sourceRef: NodeRef;
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

`postcheck` is not the full authored resolution logic. It includes only the check ids that are currently pending in this brief. Later briefs for the same instruction may expose a different `postcheck` frontier.

#### Host Treatment of `InstructionBrief`

Instruction handback is intentionally different from value-style actions. For value-style actions, the host reports values and runtime advances from those values.

For instructions, the host should:

1. Respect instruction `mode` in host logic.
   - `once`: the host is expected to report back **only after** the instruction has been fully applied downstream. How the host establishes that is outside the runtime's concern; the runtime does not independently verify completed application. Set for `$instruct()`s.
   - `persistent`: the instruction remains pending until its authored `resolveWhen` resolves true. Set for `$instructLoop()`s.
2. Respect instruction `phase` in the current brief.
   - `apply`: treat the instruction as guidance currently in effect.
   - `postcheck`: the instruction is still pending, but this brief is focused on resolving follow-up checks rather than treating it as a fresh instruction presentation.
   - Typical progression is: first reach emits `phase: "apply"`; follow-up briefs while primarily checking conditions emit `phase: "postcheck"`; after a non-terminal check cycle the same instruction may return to `phase: "apply"`.
3. Report any available values for `postcheck` ids in the same brief (`judgments` / `observations` / `hostCalls`).
4. Expect no `move: "deflect"` on an instruction brief: a pending instruction suppresses it in both the `apply` and `postcheck` phases.
   - Finish the current instruction application window. Deflection is reported at the next frontier where `allowedMoves` exposes `move: "deflect"`.

Runtime then derives instruction outcome from authored conditions:

1. Evaluate `deflectWhen` first.
2. Then evaluate `resolveWhen`.
3. Else remain pending.

Hosts can handle this in either style:

- **Aggressive batching:** deliver instruction and resolve postcheck ids in the same handback.
- **Incremental handback:** apply instruction first, then hand back later with values as they become available.

If values are still missing, runtime returns the next action brief directly. That brief may include the same instruction again with `phase: "postcheck"`, or with `phase: "apply"` if the instruction has come back into effect after a non-terminal check cycle.

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

`cursor.user` and `cursor.self` are opaque numeric coordinates for the scoped visible dialog. Their absolute values have no portable meaning. The runtime accepts only non-negative safe integer coordinates.

`Dialog.view` names the projection this dialog was taken from. The runtime treats it as an opaque identity token and only compares views for equality, so the host chooses both the token and the rule that maps positions to it. What the runtime relies on is that the same projection always carries the same token — for the life of the run and across restarts, since stored cursors keep their stamp. For its default projection the host omits `view`: absence is the canonical spelling of the default view, not a distinct state. When the runtime reads `Dialog.cursor`, it stamps the resulting cursor with the dialog's `view`, and the stamp travels with stored cursor cells through persistence.

Holding the view fixed while the walk stands at one position, and changing it only across an acknowledged transition, is what keeps cursors meaningful. The runtime does not check this. A host that reprojects mid-position is not detected, and where the node reads no cursor there is no effect at all; the consequences surface only through cursors, as a `cross-view-comparison` poison when a cursor stored before the change is compared after it, or a `cursor-moved-backwards` poison when the new projection's coordinate is behind the stored one. A host whose view is a function of position never encounters either.

#### Invariants

The host must uphold these invariants within each scoped `Dialog`:

- **Scope consistency**: `lastTurns`, `cursor`, and `view` describe the same scoped visible dialog.
- **Visible-turn projection**: `lastTurns` and `cursor` are based only on Arc-visible `user` and `self` turns, using the same projection rules.
- **Exact deltas**: for any earlier and later cursors from the same view, `later.user - earlier.user` must equal exactly the number of visible `user` turns added between those cursors, and `later.self - earlier.self` must equal exactly the number of visible `self` turns added between those cursors. These deltas are therefore never negative.
- **Same-view comparison only**: a cursor is a coordinate in one projection; two views count different subsets of the conversation, so a cross-view difference measures nothing. Comparing cursors with different views poisons the traversal with `reasonCode: "cross-view-comparison"`, and the issue reason names both views. Cursors stored before views existed carry no stamp and read as the default view.

If the host windows `lastTurns`, it must still compute `cursor` from the full scoped visible dialog, or from another durable per-view coordinate source, so cursor deltas remain exact when older turns drop out of `lastTurns`. The runtime errors if the current cursor is earlier than a stored cursor of the same view.

### Registration

**`add(source, document)`** — register a document. `source` is the filename stem (e.g. `"heavy-metal"`). The runtime treats `document` as public IR: it snapshots the document, validates the snapshot, then atomically registers each root function as an arc. It throws without changing the runtime on duplicate sources, duplicate arc refs, or validation issues. Mutating the caller's `document` after registration does not change registered runtime behavior.

**`has(arc)`** — check whether an arc is registered.

**`newTraversalSet()`** — create an empty traversal set for a fresh trigger or action session.

**`newTraversal(arc)`** — create a fresh arc traversal in the `"dormant"` phase with `enterCount = 0`.

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

**`start(traversals, dialog)`** → `ActionBrief`

Begins the action stage. There should be exactly one active traversal in the `"entered"` phase. In most cases, just use the traversal set in the latest `TriggerBrief` once `matched` is set.

**`progress(brief, report, dialog)`** → `ActionBrief`

Accepts an action report and returns the next brief.

`dialog` is the current conversation snapshot at the time the host hands control back to Arc. It may be newer than the dialog that produced `brief`, and it must be projected for the current position — a transition brief announces when that position changes.

`progress(...)` cadence is host-driven. It is not required to map one-to-one to conversation message cadence. A host may call `progress(...)` whenever it finishes part or all of the work specified in a brief, regardless of after how many rounds of conversation with the user.

When the report is accepted and execution continues normally, `progress(...)` returns the next action frontier for the active root.

When `report.move` is `"poison"`, or when authored execution fails during advancement, `progress(...)` returns a terminal `ActionBrief` with the root traversal in the `"poisoned"` phase.

When report validation fails, `progress(...)` returns an `ActionBrief` with `issues`. For issues with `kind: "invalid-report"`, the runtime rejects the report as a whole, applies no changes, and re-yields the same frontier. For issues with `kind: "invalid-item"`, the runtime applies the valid subset of reported results and re-yields only the rejected work items.

### References

| Type      | Format                | Purpose                            |
| --------- | --------------------- | ---------------------------------- |
| `ArcRef`  | opaque runtime string | Identifies a registered arc.       |
| `NodeRef` | opaque runtime string | Identifies a node (source + path). |

Construct and destructure refs through the helpers exported by `arc/runtime` (`toArcRef`, `toArcRefParts`, `toNodeRef`, `toNodeRefParts`). Callers should not assume a specific string layout.

## Host Integration Example

A typical host turn:

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
   1. `start(traversals, dialog)` → action brief.
   1. Persist `brief.traversals`.
   1. Inspect instructions and pending work items.
   1. Host chooses when to hand control back (after 0/1/N conversation rounds).
   1. Resolve any available judgments/observations/hostCalls/hostEffects and call `progress(brief, { move, judgments, observations, hostCalls, hostEffects }, latestDialog)`. Unresolved work re-surfaces on later briefs under the same ids. Report `move: "poison"` instead if the host cannot accept the frontier contract or fails a resolution fatally.
   1. `progress(...)` returns a new action brief.
   1. Repeat from b as needed until traversal cannot progress.
