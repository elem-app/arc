import type { ElementId, SegKey } from "../types/parser.js";
import type {
  BriefId,
  PinEntry,
  PinTape,
  Traversal,
} from "../types/runtime.js";
import type { PayloadValue } from "../types/value.js";
import {
  clonePayloadValue,
  cloneWithCanonicalNumbers,
  firstNonFiniteNumberPath,
} from "../value-utils.js";

/**
 * The active pin cursor for one statement visit: the SEG's tape, the statement's
 * element id, and the replay position within that statement's entries.
 *
 * A SEG walk opens a scope per statement it evaluates (`beginPinForElement`),
 * and every sigil-less evaluation inside the statement consumes one entry:
 * replayed from the statement's entries while they remain, recorded past their
 * end. Because the walked route is deterministic under pins, the evaluation
 * order within one statement visit is prefix-stable across visits, so positional
 * replay is alignment-safe.
 */
export type PinScope = {
  tape: PinTape;
  key: ElementId;
  pos: number;
};

/** The slice of the accumulator the pin helpers read and write. */
type PinHolder = { pin?: PinScope };

type ValuePinEntry = Extract<PinEntry, { kind: "value" }>;

/** A value placeholder reserved before its expression subtree is evaluated. */
export type ValuePinReservation = {
  scope: PinScope;
  entry: ValuePinEntry;
  start: number;
};

function requirePinScope(holder: PinHolder): PinScope {
  if (!holder.pin) {
    throw new Error("Sigil-less evaluation requires an active pin scope");
  }
  return holder.pin;
}

/** Opens the pin cursor for one statement visit, keyed by its element id. */
export function beginPinForElement(
  holder: PinHolder,
  tape: PinTape,
  key: ElementId,
): void {
  holder.pin = { tape, key, pos: 0 };
}

/**
 * Releases one SEG's sigil-less pins by emptying its tape in place, leaving the
 * tape object attached. Paired with `dropPinTape`, which removes the tape's
 * frame key entirely: erase in place at an in-walk rewalk restart, where the
 * active walk still holds the tape and its next pass refills it (and for the
 * trigger, whose tape is a bare call-state object with no frame key); drop the
 * key out of walk, where nothing refills it and a `{}` husk would linger.
 */
export function erasePinTape(tape: PinTape): void {
  for (const key of Object.keys(tape)) delete tape[key as ElementId];
}

/**
 * The traversal-persisted pin tape for one SEG key, created on first use.
 * Hook-SEG tapes share the `evaluatorActionStates` key vocabulary; the
 * node-lifecycle SEGs use `body` / `guard` / `effects`.
 */
export function pinTapeFor(traversal: Traversal, segKey: SegKey): PinTape {
  const frame = traversal.frame;
  frame.pinTapes ??= {};
  return (frame.pinTapes[segKey] ??= {});
}

/** Drops one SEG's tape from the traversal frame (SEG completion). */
export function dropPinTape(traversal: Traversal, segKey: SegKey): void {
  delete traversal.frame.pinTapes[segKey];
}

/** Drops every tape on the frame (entry reset / traversal finalization). */
export function dropAllPinTapes(traversal: Traversal): void {
  traversal.frame.pinTapes = {};
}

function nextEntry(scope: PinScope): PinEntry | undefined {
  return scope.tape[scope.key]?.[scope.pos];
}

/** Truncates the statement's stale entry tail on a replay mismatch (tape drift). */
function truncateEntries(scope: PinScope): void {
  const entries = scope.tape[scope.key];
  if (entries && entries.length > scope.pos) entries.length = scope.pos;
}

function appendEntry(scope: PinScope, entry: PinEntry): void {
  (scope.tape[scope.key] ??= []).push(entry);
  scope.pos += 1;
}

/** Replays a resolved value entry: skips its flattened subtree, yields its value. */
function replayResolvedValueEntry(
  scope: PinScope,
  entry: ValuePinEntry,
): PayloadValue {
  if (entry.subtreeSize < 1) {
    throw new Error("Resolved value pin has an invalid subtree size");
  }
  scope.pos += entry.subtreeSize;
  return entry.hasValue ? clonePayloadValue(entry.value) : undefined;
}

/**
 * Reserves a value entry before descending into an expression subtree.
 *
 * A resolved entry replays its value and skips the whole flattened subtree.
 * An unresolved entry advances past its placeholder so evaluation can seek
 * through the already-recorded children. A fresh reservation truncates any
 * stale tail at the cursor before recording its placeholder.
 */
export function beginValuePin(
  holder: PinHolder,
):
  | { status: "replayed"; value: PayloadValue }
  | { status: "pending"; reservation: ValuePinReservation } {
  const scope = requirePinScope(holder);
  const start = scope.pos;
  const entry = nextEntry(scope);
  if (entry?.kind === "value") {
    if (entry.resolved) {
      return {
        status: "replayed",
        value: replayResolvedValueEntry(scope, entry),
      };
    }
    scope.pos += 1;
    return {
      status: "pending",
      reservation: { scope, entry, start },
    };
  }
  if (entry) truncateEntries(scope);
  const pending: ValuePinEntry = {
    kind: "value",
    resolved: false,
    subtreeSize: 1,
  };
  appendEntry(scope, pending);
  return {
    status: "pending",
    reservation: { scope, entry: pending, start },
  };
}

/** Completes a reserved value entry and captures its flattened subtree size. */
export function completeValuePin(
  reservation: ValuePinReservation,
  value: PayloadValue,
): void {
  if (firstNonFiniteNumberPath(value) !== undefined) {
    throw new Error("Internal invariant: a completed value pin must be finite");
  }
  const { scope, entry, start } = reservation;
  entry.resolved = true;
  entry.subtreeSize = Math.max(1, scope.pos - start);
  entry.hasValue = value !== undefined;
  if (value !== undefined) entry.value = clonePayloadValue(value);
  else delete entry.value;
}

/**
 * Replays one atomic value pin. Used by statement-level completion markers
 * such as `invoke`; expression evaluation uses `beginValuePin` so it can
 * reserve before descending into children.
 */
export function readValuePin(
  holder: PinHolder,
): { value: PayloadValue } | undefined {
  const scope = requirePinScope(holder);
  const entry = nextEntry(scope);
  if (!entry) return undefined;
  if (entry.kind !== "value" || !entry.resolved) {
    truncateEntries(scope);
    return undefined;
  }
  return { value: replayResolvedValueEntry(scope, entry) };
}

/** Records one live atomic value as a completed pin entry. */
export function recordValuePin(holder: PinHolder, value: PayloadValue): void {
  if (firstNonFiniteNumberPath(value) !== undefined) {
    throw new Error("Internal invariant: a completed value pin must be finite");
  }
  const scope = requirePinScope(holder);
  appendEntry(scope, {
    kind: "value",
    resolved: true,
    subtreeSize: 1,
    hasValue: value !== undefined,
    ...(value !== undefined ? { value: clonePayloadValue(value) } : {}),
  });
}

type BriefPinEntryByKind = {
  judgment: Extract<PinEntry, { kind: "judgment" }>;
  hostCall: Extract<PinEntry, { kind: "hostCall" }>;
};
type BriefPinKind = keyof BriefPinEntryByKind;

/**
 * The settle skeleton shared by brief-keyed pins: replays a resolved entry,
 * hydrates a pending entry from the report, or keeps it pending. Without a
 * matching entry the evaluation is fresh this walk — a pending entry is
 * recorded and the report is deliberately not consulted, so a dial-back that
 * crosses the gated condition re-asks under the fresh rendering rather than
 * silently reusing this call's answer. `hydrate` returns `undefined` when the
 * report has no answer yet; the value encoding lives in the two callbacks.
 */
function settleBriefPin<K extends BriefPinKind, TValue>(
  holder: PinHolder,
  kind: K,
  briefId: BriefId,
  replay: (entry: BriefPinEntryByKind[K]) => TValue,
  hydrate: (entry: BriefPinEntryByKind[K]) => { value: TValue } | undefined,
): { status: "resolved"; value: TValue } | { status: "pending" } {
  const scope = requirePinScope(holder);
  const entry = nextEntry(scope);
  if (entry && entry.kind === kind && entry.briefId === briefId) {
    scope.pos += 1;
    const matched = entry as BriefPinEntryByKind[K];
    if (matched.resolved) {
      return { status: "resolved", value: replay(matched) };
    }
    const hydrated = hydrate(matched);
    if (hydrated) return { status: "resolved", value: hydrated.value };
    return { status: "pending" };
  }
  if (entry) truncateEntries(scope);
  appendEntry(scope, { kind, briefId, resolved: false } as PinEntry);
  return { status: "pending" };
}

/** Settles a judgment against its pin. */
export function settleJudgmentPin(
  holder: PinHolder,
  briefId: BriefId,
  reported: boolean | undefined,
): { status: "resolved"; value: boolean } | { status: "pending" } {
  return settleBriefPin(
    holder,
    "judgment",
    briefId,
    (entry) => entry.value!,
    (entry) => {
      if (reported === undefined) return undefined;
      entry.resolved = true;
      entry.value = reported;
      return { value: reported };
    },
  );
}

/**
 * Settles a host call against its pin, with an explicitly encoded `undefined`
 * result (`hasValue: false`) and deep-cloned payloads so the tape never
 * aliases host-report objects.
 */
export function settleHostCallPin(
  holder: PinHolder,
  briefId: BriefId,
  reported: { value: PayloadValue } | undefined,
): { status: "resolved"; value: PayloadValue } | { status: "pending" } {
  return settleBriefPin(
    holder,
    "hostCall",
    briefId,
    (entry) => (entry.hasValue ? clonePayloadValue(entry.value) : undefined),
    (entry) => {
      if (!reported) return undefined;
      if (firstNonFiniteNumberPath(reported.value) !== undefined) {
        throw new Error(
          "Internal invariant: a host-call pin result must be finite",
        );
      }
      entry.resolved = true;
      entry.hasValue = reported.value !== undefined;
      if (reported.value !== undefined) {
        entry.value = cloneWithCanonicalNumbers(reported.value);
      }
      return { value: cloneWithCanonicalNumbers(reported.value) };
    },
  );
}

function clonePinEntry(entry: PinEntry): PinEntry {
  if (entry.kind === "value") {
    return {
      kind: "value",
      resolved: entry.resolved,
      subtreeSize: entry.subtreeSize,
      hasValue: entry.hasValue,
      ...(entry.value !== undefined
        ? { value: clonePayloadValue(entry.value) }
        : {}),
    };
  }
  if (entry.kind === "judgment") {
    return {
      kind: "judgment",
      briefId: entry.briefId,
      resolved: entry.resolved,
      ...(entry.value !== undefined ? { value: entry.value } : {}),
    };
  }
  return {
    kind: "hostCall",
    briefId: entry.briefId,
    resolved: entry.resolved,
    ...(entry.hasValue !== undefined ? { hasValue: entry.hasValue } : {}),
    ...(entry.value !== undefined
      ? { value: clonePayloadValue(entry.value) }
      : {}),
  };
}

export function clonePinTape(tape: PinTape): PinTape {
  return Object.fromEntries(
    Object.entries(tape).map(([key, entries]) => [
      key,
      entries.map((entry) => clonePinEntry(entry)),
    ]),
  );
}

export function clonePinTapes(
  tapes: Record<SegKey, PinTape | undefined>,
): Record<SegKey, PinTape | undefined> {
  return Object.fromEntries(
    Object.entries(tapes).map(([key, tape]) => [
      key,
      tape ? clonePinTape(tape) : undefined,
    ]),
  );
}
