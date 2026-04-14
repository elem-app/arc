# Arc

Arc is a scripting language and runtime that gives LLM-native applications structured, stateful interaction flows. It is a pluggable solution for encoding deep, sequence-dependent knowledge into a form an application can traverse reliably.

## Where Arc fits

LLM-powered interactions vary along two axes: how deep the domain knowledge is, and how much each step depends on what came before.

|                      | Sequence-independent | Sequence-dependent |
| -------------------- | -------------------- | ------------------ |
| **Shallow knowledge** | Free conversation    | Skills             |
| **Deep knowledge**    | Memory               | **Arc**            |

**Free conversation** is the baseline — the LLM responds to whatever the user says, drawing on general training knowledge.

**Memory** adds deep, persistent knowledge — facts, preferences, history — and surfaces it when relevant. Each recall stands alone: the system knows the user likes jazz, but there is no structured path through the domain.

**Skills** handle ordered sequences of steps (multi-step procedures like "book a flight") where each step is a fixed action with shallow domain knowledge.

**Arc** covers interactions that require both deep domain knowledge and meaningful sequential progression. A wine tasting course that adapts its pacing to what the user already knows. An onboarding flow that branches based on interest signals. A coaching session that tracks what has been covered, what was deflected, and what to revisit.

## How it works

An LLM-native application that uses Arc is called a **host**. The host handles all semantic work: calling the LLM, interpreting user messages, delivering content. Arc handles traversal logic and state; the host handles meaning.

An author writes an Arc script as a graph of nodes containing variables, branching logic, triggers, and effects. The host parses the script and runs it turn by turn through a **brief/report** protocol: when the runtime reaches a point requiring semantic judgment — is the user interested? have they mentioned a specific topic? — it yields a **brief** describing what it needs. The host resolves the brief (typically by prompting an LLM) and sends back a **report**. The runtime applies the report and advances.

This separation keeps Arc scripts declarative and testable while giving the host full control over LLM calls, content presentation, and external integrations.

### Inside an arc

Each arc is a top-level function in an Arc script — a `.js` file executed by the Arc runtime rather than a standard JavaScript engine. An arc defines a self-contained interaction flow through four parts:

- **Variables** — typed state that persists across turns: enums, booleans, and bounded integers. Each can carry an observation question for the host to evaluate against conversation context.
- **A trigger** — conditions under which the arc activates: pattern matches on recent messages, semantic checks via `judge()`, enter-count guards.
- **An action graph** — the sequential body: observations that extract state from conversation, instructions for the host to deliver, conditional branches, and entries into child nodes or imported arcs.
- **Effects** — post-resolution work: final observations and emitted host effects (e.g., writing to memory, updating external systems).

The runtime walks the action graph top-down each turn, skipping actions resolved in prior turns and stopping at the first unresolved one. This turn-by-turn progression is what makes arcs stateful.

## Example

```js
"use arc v2";

function Welcome() {
  this.displayName = "Welcome";

  const interested = new Boolean({
    observing: `is ${user} interested in getting started`,
  });

  this.trigger = () => {
    return judge(`${user} is opening the product for the first time`);
  };

  observeOrAsk(interested);
  if (interested) {
    `Give ${user} a short onboarding introduction.`;
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

- [Arc Scripts](specs/arc-scripts.md)
- [Arc Runtime API](specs/arc-runtime-api.md)
