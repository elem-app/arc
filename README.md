# Arc

Arc is a scripting language and runtime for LLM-native applications that need both deep domain structure and broad continuity across a long-running interaction.

## Where Arc fits

An LLM can reason deeply about a compact context, or stay broadly aware across a long interaction. As the interaction gets longer and the domain gets richer, competence degrades because the model has to spend attention on both at once. Arc externalizes the structure, so the model does not have to hold the whole tree in context to take the next good step.

Existing scaffolding usually handles one side of this tradeoff well:

- **Prompts and skills** can encode deep guidance over a short horizon.
- **Memory** can preserve useful facts across time, but it does not define how an authored experience should progress.
- **Workflow engines** can preserve process state, but they are not built around semantic conversational frontiers.

Arc is for applications that need both depth and breadth: deep authored structure, plus coherent progression across many turns, sessions, branches, deflections, and returns.

That fit shows up in experiences like an adaptive course that changes pace based on what the learner already understands, an AI partner that preserves authored continuity over a relationship, an onboarding flow that branches on interest signals, or a coaching session that tracks what was covered, what was deflected, and what to revisit.

## How it works

An LLM-native application that uses Arc is called a **host**. The host handles semantic work: calling the LLM, interpreting user messages, delivering content, and integrating with external systems. Arc handles authored structure, traversal logic, and state. The host handles meaning.

An author writes an Arc script as a graph of nodes containing cells, branching logic, triggers, and effects. The runtime walks that graph and advances until it reaches work that needs semantic judgment: is the user interested, have they mentioned a specific topic, should this instruction be delivered now. At that point it yields a **brief** describing what it needs. The host resolves the brief, typically by prompting an LLM, and sends back a **report**. The runtime applies the report and continues.

This separation keeps the interaction graph outside the prompt. Arc remembers where the interaction is, what has already been resolved, and which authored paths remain available. The LLM resolves the current semantic frontier instead of carrying the whole structure in context.

### Inside an arc

Each arc is a top-level function in an Arc script. An arc defines a self-contained interaction flow through four parts:

- **Cells** — typed state that persists across turns: enums, booleans, and bounded integers. Each can carry an observation question for the host to evaluate against conversation context.
- **A trigger** — conditions under which the arc activates: pattern matches on recent messages, semantic checks via `judge()`, enter-count guards.
- **An action graph** — the sequential body: observations that extract state from conversation, instructions for the host to deliver, conditional branches, and entries into child nodes or imported arcs.
- **Effects** — post-resolution work: final observations and emitted host effects (e.g., writing to memory, updating external systems).

The runtime walks the action graph top-down on host calls, skipping actions resolved in prior walks and stopping at the first unresolved one. This host-driven progression is what makes arcs stateful.

## Example

```js
"arc";

function Welcome() {
  this.displayName = "Welcome";

  const interested = Bool({
    observing: `is ${user} interested in getting started`,
  });

  this.trigger = () => {
    return judge(`${user} is opening the product for the first time`);
  };

  $observeOrAsk(interested);
  if (interested) {
    $instruct(`Give ${user} a short onboarding introduction.`);
  }
}
```

The trigger fires when the host determines the user is new. The runtime observes whether the user is interested — extracting from conversation or asking directly. If they are, it yields an instruction for the host to deliver.

## Package surface

This package exposes:

- `arc/parser` — parses Arc source into a structured document
- `arc/runtime` — executes parsed documents with a host

## Deeper reference

The spec documents cover precise language and runtime details:

- [Arc Scripts](./specs/arc-scripts.md)
- [Arc Runtime API](./specs/arc-runtime-api.md)
- [Internal Semantics](./specs/internal-semantics.md)
