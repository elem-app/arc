# Arc Runtime API

The runtime executes parsed Arc scripts together with a **host**. It traverses action graphs, manages traversal state, and yields structured briefs when it needs host involvement. The host carries out semantic work — LLM calls, variable extraction, instruction delivery — and reports back. The runtime never calls an LLM or performs any semantic resolution itself.

## Mental Model

Arc execution is a conversation between the runtime and the host. The runtime walks the graph and knows what work needs doing. The host knows how to do that work. They communicate through ephemeral **briefs** (runtime → host) and **reports** (host → runtime).

A turn proceeds in two stages:

1. **Trigger stage** — the runtime evaluates dormant arcs' triggers to decide which arc becomes active. Triggers may contain semantic checks that require host resolution, so this stage follows the brief/report exchange.

2. **Action stage** — the runtime traverses the active arc's action graph. At each step it advances until it reaches work it cannot resolve deterministically and yields a brief. The host resolves the brief and reports back with a move. This loop repeats until the arc completes or can no longer progress.

There is only one active arc being traversed at a time.

After the action graph resolves, the node's effects block runs. Effects may require additional resolution rounds. Once effects finish, any emitted host effects are surfaced in a brief for the host to handle.

Instructions are ephemeral — they are not preserved across brief/report rounds. The host should check for instructions at each brief before resolving anything else.

## Traversal State

Traversal state is the persistent, serializable representation of an arc's progress. It is what lets the runtime resume where it left off across turns, sessions, and process restarts.

### Arc Traversal and Node Traversal

An **arc traversal** represents the full state of one arc: its lifecycle phase, enter count, variable values, action resolution state, and child traversals. It is the top-level unit of persistence.

A **node traversal** represents the state of a single node within an arc. For owned children (nested function declarations), traversal data is stored inline under the parent. For imported arcs entered via a parent arc, each gets its own arc traversal managed directly by the runtime.

Runtime instances are purely in-memory. The host is responsible for persisting traversal state between turns — a serverless handler, for example, can spin up a fresh runtime, register the same documents, and resume any session from its own storage.

### Lifecycle Phases

Each arc traversal tracks where it is in its lifecycle:

| Phase         | Description                                      |
| ------------- | ------------------------------------------------ |
| `"dormant"`   | Initial state. The arc has not been triggered.   |
| `"entered"`   | The arc is active and being traversed.           |
| `"completed"` | All reachable actions and effects have resolved. |
| `"suspended"` | The arc was entered but left before completing.  |

### Node State vs. Node Frame

Two pieces of traversal state that serve distinct purposes:

**Node state** is the outcome — what happened to the node as a whole. It is one of `COVERED`, `DEFLECTED`, `SKIPPED`, or not yet resolved. The parent's action graph reads it through `ReferenceName.state` to decide whether to re-enter or move on. Node state is set by the runtime (`COVERED` when all reachable actions and effects complete, `DEFLECTED` on host-initiated deflection) or by explicit guard logic (`SKIPPED`).

**Node frame** is the internal resolution map — which individual actions within the node have been resolved. It is what makes turn-by-turn progression work: each walk re-traverses the action graph from the top, skips actions the frame marks as resolved, and stops at the first unresolved one. The frame is bookkeeping that the action graph author never sees directly.

When `this.resumable = false`, the frame is discarded on re-entry — previously resolved actions are forgotten and the walk starts fresh. But node state, variable values, and child states are preserved. A non-resumable node replays its action sequence without losing its accumulated state.

## Brief/Report Protocol

The runtime communicates with the host exclusively through briefs and reports. When the runtime reaches a point requiring host involvement, it yields a **brief** describing the pending work and carrying contextual information. The host resolves the pending items, chooses a move, and sends back a **report**. The runtime uses the report to advance.

Briefs also carry information the host may use at its discretion — traversal snapshots, instructions to deliver, host effects to apply. The report only needs to address the pending work items and the chosen move.

Briefs and reports are ephemeral — they are valid only for the runtime call that produced them.

### Brief Rules

A brief is emitted when the current walk reaches a frontier that requires host coordination.

An **execution walk** is one top-down pass through the active arc's action graph. Each `start()` call performs one planning walk. Each `progress()` call first applies the report, then performs a new planning walk to produce the next brief.

The runtime emits briefs under these conditions:

- **Trigger brief** — trigger evaluation encounters unresolved semantic work (`judge()`, `observe()`, expression-position host calls), or triggers finish with matchable arcs for the host to choose from.
- **Semantic-work action brief** — action traversal encounters unresolved `judge()`, `observe()`, `observeOrAsk()`, or expression-position host calls.
- **Instruction brief** — action traversal reaches one or more reachable instruction literals in the current node body.

Batching:

- Semantic work may batch when multiple unresolved items are reachable at the same frontier.
- Instruction literals batch only within the **currently executing node body**.
- Entering a child with `enter(ReferenceName)`, returning to a caller, or beginning `this.effects` ends an instruction batch.
- An action brief never mixes instructions from different node bodies.

Resume:

- After a brief/report round, traversal re-walks from the top of the current active node.
- `if` conditions are reevaluated whenever the walk reaches them.
- Resolved actions are skipped according to the node frame.
- The host should inspect `brief.instructions` before resolving any pending semantic work — delivered instructions are not replayed in later briefs.

### `TriggerBrief`

`TriggerBrief` is what the runtime yields during the trigger stage. It carries unresolved semantic work from trigger bodies and a list of arcs that already matched.

```typescript
type TriggerBrief = {
  /** Unresolved semantic checks from trigger bodies. */
  judgments: JudgmentBrief[];
  /** Unresolved observations from trigger bodies. */
  observations: ObservationBrief[];
  /** Unresolved host-backed value requests from trigger bodies. */
  hostCalls: HostCallBrief[];
  /** Arcs whose triggers returned `true` with no unresolved work. */
  matchableArcs: ArcRef[];
};
```

### `TriggerReport`

`TriggerReport` is what the host sends back after inspecting a trigger brief. It includes resolved work items and may explicitly select which arc to activate.

```typescript
type TriggerReport = {
  /** Explicitly select an arc from the matchable set. */
  match?: ArcRef;
  /** Resolved boolean checks, keyed by brief id. */
  judgments?: Record<BriefId, boolean>;
  /** Resolved observations, keyed by brief id. */
  observations?: Record<BriefId, ObservationReport>;
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
  /** Pending boolean checks. */
  judgments: JudgmentBrief[];
  /** Pending variable assessments. */
  observations: ObservationBrief[];
  /** Pending host-backed value requests. */
  hostCalls: HostCallBrief[];
  /** Text to deliver to the user. */
  instructions: InstructionBrief[];
  /** Host effects emitted during this step. */
  hostEffects: HostEffect[];
  /** Valid moves for the report. */
  allowedMoves: ActionMove[];
};
```

### `ActionReport`

`ActionReport` is what the host sends back after inspecting an action brief. It includes resolved work items and a move that tells the runtime what to do next.

```typescript
type ActionReport = {
  /**
   * "proceed" — instructions delivered, advance to the next step.
   * "defer" — do not advance this round.
   * "deflect" — user changed topic; the active node becomes deflected
   *   and is eligible for re-entry. Pending effects still run.
   */
  move: ActionMove;
  /** Resolved boolean checks, keyed by brief id. */
  judgments?: Record<BriefId, boolean>;
  /** Resolved observations, keyed by brief id. */
  observations?: Record<BriefId, ObservationReport>;
  /** Resolved host-call values, keyed by brief id. */
  hostCalls?: Record<BriefId, PayloadValue>;
};
```

Nodes that complete all reachable actions and effects become covered automatically. Nodes bypassed by explicit guard logic become skipped. Only deflect is host-initiated.

### Work Item Briefs

#### `JudgmentBrief`

`JudgmentBrief` represents a request by the runtime to answer a boolean question — from a `judge()` call in the arc source. The host evaluates the question against conversation context and reports `true` or `false`.

```typescript
type JudgmentBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Which arc produced this. */
  arc: ArcRef;
  /** Rendered question text. */
  question: string;
};
```

#### `ObservationBrief`

`ObservationBrief` represents a request by the runtime to extract a variable's value — from an `observe()` or `observeOrAsk()` call. The host infers the value from conversation context using the provided question and the variable's type definition. When `mode` is `"observeOrAsk"`, the host may ask the user directly instead of inferring.

```typescript
type ObservationBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Variable name. */
  variable: string;
  /** Whether the host may ask the user. */
  mode: "observe" | "observeOrAsk";
  /** Rendered observation question from arc source. */
  question: string;
  /** Current value, if any. */
  currentValue?: PrimitiveValue;
};
```

The host reports the outcome as an `ObservationReport`:

```typescript
type ObservationReport = {
  /**
   * "resolved" — value inferred, include `value`.
   * "unknown" — could not determine. For `observe()`, the action is consumed
   *   without writing a new value. For `observeOrAsk()`, the action resurfaces
   *   next brief.
   * "needs-user" — host wants the user to answer (observeOrAsk only), and the
   *   action resurfaces next brief.
   */
  status: "resolved" | "unknown" | "needs-user";
  /** The reported value. */
  value?: PrimitiveValue;
};
```

#### `HostCallBrief`

`HostCallBrief` represents a request by the runtime to get a value from a host module — from an expression-position host call like `Dice.roll(20)`. The runtime is blocked until the host reports a value.

```typescript
type HostCallBrief = {
  /** Opaque key. Echo back in the report. */
  id: BriefId;
  /** Which arc produced this. */
  arc: ArcRef;
  /** Which node produced this. */
  node: string;
  /** Host module name from `host:*`. */
  module: string;
  /** Member path before the operation, e.g. `["facts"]`. */
  target: string[];
  /** Final called member name, e.g. `"roll"` or `"apply"`. */
  operation: string;
  /** Fully rendered call arguments. */
  arguments: PayloadValue[];
};
```

#### `InstructionBrief`

`InstructionBrief` represents text that the arc wants delivered to the user — from bare template literals in the action graph. The host decides how to present it.

```typescript
type InstructionBrief = {
  /** Opaque key. */
  id: BriefId;
  /** Rendered instruction text. */
  text: string;
};
```

### Host Effects

Statement-position host calls inside `this.effects` emit host effects rather than blocking for a value. These are surfaced in `brief.hostEffects` as `HostEffect` records for the host to handle — the runtime does not execute them.

```typescript
type HostEffect = {
  /** Host module name from `host:*`. */
  module: string;
  /** Member path before the operation, e.g. `["facts"]`. */
  target: string[];
  /** Final called member name, e.g. `"apply"`. */
  operation: string;
  /** Fully rendered call arguments. */
  arguments: PayloadValue[];
};
```

Effect emissions are idempotent — each is keyed by its traversal, statement, and rendered payload. Duplicates are suppressed.

## Runtime API

### Dialog

The host provides a dialog on each runtime call so conversation references in arc source (`Dialog.lastUserMessage`, `Dialog.lastTurns(n)`) resolve correctly. `Dialog.lastUserMessage` is derived by the runtime from `lastTurns`.

```typescript
type Dialog = {
  lastTurns: DialogTurn[];
};

type DialogTurn = {
  role: "self" | "user";
  message: string;
};
```

### Registration

**`add(source, document)`** — register a parsed document. `source` is the filename stem (e.g. `"heavy-metal"`). Each root function becomes a registered arc. Throws on duplicate.

**`has(arc)`** — check whether an arc is registered.

**`createTraversal(arc)`** — create a fresh arc traversal in the `"dormant"` phase. Useful for seeding an arc without going through the trigger cycle. The caller must set `phase = "entered"` before passing it to `start()`.

### Trigger Stage

**`startTrigger(dialog, traversals?)`** → `TriggerBrief`

Evaluates every registered arc's trigger against the dialog. Returns pending semantic work and any arcs that already matched. If matches exist with nothing pending, the caller can skip resolution and select the first match.

**`progressTrigger(brief, report)`** → `TriggerOutcome`

Accepts a trigger report and returns the outcome: which arc matched (if any) and the updated traversal state.

Arc selection: (1) re-evaluate all triggers with resolved data — arcs whose triggers now return `true` join the matchable set; (2) if `report.match` is set, select it (must be matchable); (3) if exactly one arc is matchable, auto-select; (4) otherwise no activation.

**Constraint:** observations inside judgment-guarded blocks in triggers produce a two-step dependency the single-round trigger protocol cannot resolve. Place observations at the top level of the trigger body or seed variables in the effects phase.

### Action Stage

**`start(traversals, dialog)`** → `ActionBrief`

Begins the action stage. The active arc must be in the `"entered"` phase — either via trigger outcome or manual seeding with `createTraversal`.

**`progress(brief, report)`** → `ActionBrief`

Accepts an action report and returns the next brief.

### References

| Type      | Format                  | Purpose                               |
| --------- | ----------------------- | ------------------------------------- |
| `ArcRef`  | opaque runtime string   | Identifies a registered arc.          |
| `NodeRef` | opaque runtime string   | Identifies a node within a traversal. |

Construct and destructure refs through the helpers exported by `arc/runtime`
(`toArcRef`, `toArcRefParts`, `toNodeRef`, `toNodeRefParts`). Callers should
not assume a specific string layout.

## Host Integration Example

A typical host turn:

```
1. Build Dialog from session history.

2. Trigger stage:
   a. startTrigger(dialog, traversals) → TriggerBrief
   b. Resolve judgments/observations/hostCalls.
   c. progressTrigger(brief, report) → TriggerOutcome
   d. If a match exists, proceed to action stage.

3. Action stage (if an arc is active):
   a. start(traversals, dialog) → ActionBrief
   b. Resolution loop — advance until instructions surface:
      while brief.canProgress:
        if brief.instructions.length > 0: break    ← present these
        resolve brief.judgments, brief.observations, and brief.hostCalls
        brief = progress(brief, { move: "proceed", judgments, observations, hostCalls })
   c. Present brief.instructions to the user.
   d. Determine move (proceed / defer / deflect).
   e. Final progress — resolve remaining semantic work and advance:
      resolve brief.judgments, brief.observations, and brief.hostCalls
      brief = progress(brief, { move, judgments, observations, hostCalls })
   f. Post-progress resolution — effects-phase observations may surface:
      while brief.canProgress and brief has semantic work:
        resolve and progress
   g. Apply brief.hostEffects.
   h. Persist traversal state.
```

Step (b) breaks on instructions rather than semantic work because instructions are not preserved across `progress()` calls — resolving before checking would consume them without presenting them.

Step (f) handles observations and host calls from `this.effects` blocks, which only become reachable after the action graph advances past the current frontier.
