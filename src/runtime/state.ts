import type {
  ActionBrief,
  ActionState,
  ActionStatement,
  ArcRef,
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  Dialog,
  Document,
  EnterChannelState,
  HostCallArgument,
  HostCallBrief,
  HostEffect,
  HostEffectStatement,
  InstructionAction,
  InstructionBrief,
  JudgmentBrief,
  Node,
  NodeFrame,
  NodeRef,
  NodeState,
  NodeTraversal,
  ObservationBrief,
  ObservationReport,
  ObserveAction,
  PayloadValue,
  PrimitiveValue,
  RuntimeIssue,
  SemanticString,
  SetAction,
  StatementId,
  Traversal,
  TriggerBrief,
  TriggerReport,
  TriggerStatement,
  ValueExpression,
} from "../types.js";
import {
  arcToNodeRef,
  findTraversalInSet,
  formatRef,
  getNodeForRef,
  isArcRef,
  isArcTraversal,
  lexicalParentRef,
  traversalToNodeRef,
} from "./refs.js";

export type RegistryEntry = {
  arc: ArcRef;
  document: Document;
  root: Node;
  importRefs: Record<string, ArcRef>;
};

export type Accumulator = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversal: Traversal;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  phase: "plan" | "apply";
  judgments: JudgmentBrief[];
  observations: ObservationBrief[];
  hostCalls: HostCallBrief[];
  instructions: InstructionBrief[];
  hostEffects: HostEffect[];
  blocked: boolean;
  active?: NodeRef;
  briefActive?: NodeRef;
  instructionBatchNode?: NodeRef;
  instructionBatchSignature?: string;
  judgmentResults: Map<string, boolean>;
  observationResults: Map<string, ObservationReport>;
  hostCallResults: Map<string, PayloadValue>;
  deflectionActive?: NodeRef;
  yieldedInstructionIds: Set<BriefId>;
};

export type ActionBriefSnapshot = Omit<
  ActionBrief,
  "traversals" | "hostEffects"
>;
export type TriggerBriefSnapshot = TriggerBrief;

export type ActionBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entry: RegistryEntry;
  traversals: ArcTraversalSet;
  snapshot: ActionBriefSnapshot;
};

export type TriggerBriefState = {
  entries: ReadonlyMap<ArcRef, RegistryEntry>;
  entryByArc: ReadonlyMap<ArcRef, RegistryEntry>;
  traversals: ArcTraversalSet;
  dialog: Dialog;
  priorReport: TriggerReport;
  snapshot: TriggerBriefSnapshot;
};

export function createAccumulator(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversal: Traversal,
  traversals: ArcTraversalSet,
  dialog: Dialog,
  phase: "plan" | "apply",
): Accumulator {
  return {
    entries,
    entry,
    traversal,
    traversals,
    dialog,
    phase,
    judgments: [],
    observations: [],
    hostCalls: [],
    instructions: [],
    hostEffects: [],
    blocked: false,
    active: undefined,
    briefActive: undefined,
    instructionBatchNode: undefined,
    instructionBatchSignature: undefined,
    judgmentResults: new Map(),
    observationResults: new Map(),
    hostCallResults: new Map(),
    deflectionActive: undefined,
    yieldedInstructionIds: new Set(),
  };
}

export function createEmptyEnterChannelState(): EnterChannelState {
  return { args: {}, returns: {}, stagedReturns: {} };
}

function createVariableSlots(
  node: Node,
): Record<string, PrimitiveValue | undefined> {
  const variables: Record<string, PrimitiveValue | undefined> = {};
  for (const variable of node.variables) variables[variable.name] = undefined;
  return variables;
}

function createTraversalFrame(): NodeFrame {
  return { actionStates: {}, evaluatorActionStates: {} };
}

export function createFreshArcTraversal(
  arcRef: ArcRef,
  node: Node,
  returnTo: ArcRef | null = null,
): ArcTraversal {
  return {
    ref: arcRef,
    returnTo,
    phase: "dormant",
    enterCount: 0,
    state: undefined,
    variables: createVariableSlots(node),
    frame: createTraversalFrame(),
    ownedChildren: [],
    ephemeralChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
    enterChannels: createEmptyEnterChannelState(),
  };
}

export function createFreshNodeTraversal(
  nodeRef: NodeRef,
  node: Node,
): NodeTraversal {
  return {
    ref: nodeRef,
    enterCount: 0,
    state: undefined,
    variables: createVariableSlots(node),
    frame: createTraversalFrame(),
    ownedChildren: [],
    ephemeralChildren: [],
    refChildren: [],
    appliedHostCallKeys: [],
    enterChannels: createEmptyEnterChannelState(),
  };
}

export function restartTraversal(
  entry: RegistryEntry,
  base?: ArcTraversal,
): ArcTraversal {
  if (!base) {
    const fresh = createFreshArcTraversal(entry.arc, entry.root);
    fresh.phase = "entered";
    fresh.enterCount = 1;
    return fresh;
  }
  const next = cloneArcTraversal(base);
  next.enterCount += 1;
  next.phase = "entered";
  next.state = undefined;
  next.finalizing = undefined;
  next.returnTo = null;
  next.enterChannels = createEmptyEnterChannelState();
  if (!entry.root.resumable) clearFrame(next);
  return next;
}

export function cloneNodeTraversal(traversal: NodeTraversal): NodeTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversalToNodeRef(traversal),
  };
}

export function cloneArcTraversal(traversal: ArcTraversal): ArcTraversal {
  return {
    ...cloneTraversalBase(traversal),
    ref: traversal.ref,
    returnTo: traversal.returnTo,
    phase: traversal.phase,
  };
}

function cloneTraversalBase<T extends Traversal>(traversal: T) {
  return {
    enterCount: traversal.enterCount,
    state: traversal.state,
    finalizing: traversal.finalizing ? { ...traversal.finalizing } : undefined,
    variables: { ...traversal.variables },
    frame: {
      actionStates: Object.fromEntries(
        Object.entries(traversal.frame.actionStates).map(([id, state]) => [
          id,
          state
            ? {
                ...state,
                stagedReturns: state.stagedReturns
                  ? { ...state.stagedReturns }
                  : undefined,
                enterLoopPhase: state.enterLoopPhase,
              }
            : undefined,
        ]),
      ),
      evaluatorActionStates: Object.fromEntries(
        Object.entries(traversal.frame.evaluatorActionStates ?? {}).map(
          ([scopeKey, scopedStates]) => [
            scopeKey,
            scopedStates
              ? Object.fromEntries(
                  Object.entries(scopedStates).map(([id, state]) => [
                    id,
                    state ? { ...state } : undefined,
                  ]),
                )
              : undefined,
          ],
        ),
      ),
    },
    ownedChildren: traversal.ownedChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    ephemeralChildren: traversal.ephemeralChildren.map((child) =>
      cloneNodeTraversal(child),
    ),
    refChildren: [...traversal.refChildren],
    appliedHostCallKeys: [...traversal.appliedHostCallKeys],
    enterChannels: {
      args: Object.fromEntries(
        Object.entries(traversal.enterChannels.args).map(
          ([key, channelLink]) => [key, { ...channelLink }],
        ),
      ),
      returns: Object.fromEntries(
        Object.entries(traversal.enterChannels.returns).map(
          ([key, channelLink]) => [key, { ...channelLink }],
        ),
      ),
      stagedReturns: { ...traversal.enterChannels.stagedReturns },
    },
  };
}

export function cloneTraversalSet(
  traversals: ArcTraversalSet,
): ArcTraversalSet {
  return traversals.map((traversal) => cloneArcTraversal(traversal));
}

export function isStopped(traversal: ArcTraversal): boolean {
  return (
    traversal.phase === "completed" ||
    traversal.phase === "suspended" ||
    traversal.phase === "poisoned"
  );
}

export function isEnteredTraversal(traversal: Traversal): boolean {
  return isArcTraversal(traversal)
    ? traversal.phase === "entered" && traversal.state === undefined
    : traversal.state === undefined;
}

export function isSuspendedArcTraversal(traversal: Traversal): boolean {
  return isArcTraversal(traversal) && traversal.phase === "suspended";
}

export function selectActionRootTraversal(
  traversals: ArcTraversalSet,
  preferredRoot?: ArcRef,
): ArcTraversal {
  if (preferredRoot) {
    const preferred = traversals.find(
      (traversal) => traversal.ref === preferredRoot,
    );
    if (preferred) return preferred;
  }
  const root = traversals.find((traversal) => traversal.returnTo === null);
  if (root) return root;
  const first = traversals[0];
  if (!first) throw new Error("Action traversal set is empty");
  return first;
}

export function cloneDialog(dialog: Dialog): Dialog {
  return {
    lastTurns: dialog.lastTurns.map((turn) => ({ ...turn })),
    names: dialog.names ? { ...dialog.names } : undefined,
  };
}

export function cloneHostEffect(call: HostEffect): HostEffect {
  return {
    module: call.module,
    target: [...call.target],
    operation: call.operation,
    arguments: [...call.arguments],
  };
}

export function cloneHostCallBrief(brief: HostCallBrief): HostCallBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    module: brief.module,
    target: [...brief.target],
    operation: brief.operation,
    arguments: [...brief.arguments],
  };
}

export function cloneRuntimeIssue(issue: RuntimeIssue): RuntimeIssue {
  if (issue.kind === "invalid-item" || issue.kind === "invalid-report") {
    return { ...issue };
  }
  if (issue.kind === "ambiguous-match") {
    return {
      ...issue,
      matchableArcs: [...issue.matchableArcs],
    };
  }
  return {
    ...issue,
    source: issue.source
      ? {
          start: { ...issue.source.start },
          end: { ...issue.source.end },
        }
      : undefined,
  };
}

export function cloneInstructionBrief(
  brief: InstructionBrief,
): InstructionBrief {
  return {
    id: brief.id,
    sourceRef: brief.sourceRef,
    mode: brief.mode,
    phase: brief.phase,
    text: brief.text,
    postcheck: cloneInstructionPostcheck(brief.postcheck),
  };
}

export function cloneInstructionPostcheck(
  postcheck: InstructionBrief["postcheck"],
): InstructionBrief["postcheck"] {
  return postcheck
    ? {
        judgmentIds: [...postcheck.judgmentIds],
        observationIds: [...postcheck.observationIds],
        hostCallIds: [...postcheck.hostCallIds],
      }
    : undefined;
}

export function mergeInstructionBriefs(
  ...groups: readonly (readonly InstructionBrief[])[]
): InstructionBrief[] {
  const merged = new Map<string, InstructionBrief>();

  for (const group of groups) {
    for (const brief of group) {
      const current = merged.get(brief.id);
      if (!current) {
        merged.set(brief.id, cloneInstructionBrief(brief));
        continue;
      }
      merged.set(brief.id, {
        ...cloneInstructionBrief(brief),
        phase:
          current.phase === "apply" || brief.phase === "apply"
            ? "apply"
            : "postcheck",
        postcheck:
          cloneInstructionPostcheck(brief.postcheck) ??
          cloneInstructionPostcheck(current.postcheck),
      });
    }
  }
  return [...merged.values()];
}

export function cloneValueExpression(
  expression: ValueExpression,
): ValueExpression {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "ref":
      return { kind: "ref", name: expression.name };
    case "variable":
      return { kind: "variable", name: expression.name };
    case "channel":
      return {
        kind: "channel",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "deflectionFrom":
      return {
        kind: "deflectionFrom",
        target: { ...expression.target },
      };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "nodeState":
      return { kind: "nodeState", identifier: expression.identifier };
    case "judge":
      return {
        id: expression.id,
        kind: "judge",
        question: cloneSemanticString(expression.question),
        loc: expression.loc,
      };
    case "host-call":
      return {
        id: expression.id,
        kind: "host-call",
        module: expression.module,
        target: [...expression.target],
        operation: expression.operation,
        arguments: expression.arguments.map((arg) =>
          cloneHostCallArgument(arg),
        ),
        loc: expression.loc,
      };
    case "regexTest":
      return {
        kind: "regexTest",
        pattern: expression.pattern,
        flags: expression.flags,
        target: cloneValueExpression(
          expression.target,
        ) as typeof expression.target,
      };
    case "binary":
      return {
        kind: "binary",
        op: expression.op,
        left: cloneValueExpression(expression.left),
        right: cloneValueExpression(expression.right),
      };
    case "logical":
      return {
        kind: "logical",
        op: expression.op,
        left: cloneValueExpression(expression.left),
        right: cloneValueExpression(expression.right),
      };
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: cloneValueExpression(expression.argument),
      };
  }
}

export function cloneHostCallArgument(arg: HostCallArgument): HostCallArgument {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: cloneSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: cloneValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      value: arg.value.map((entry) => cloneHostCallArgument(entry)),
    };
  }
  return {
    kind: "object",
    value: Object.fromEntries(
      Object.entries(arg.value).map(([key, value]) => [
        key,
        cloneHostCallArgument(value),
      ]),
    ),
  };
}

export function cloneSemanticString(semantic: SemanticString): SemanticString {
  return {
    kind: "semantic-string",
    parts: semantic.parts.map((part) =>
      part.kind === "text"
        ? { kind: "text", value: part.value }
        : {
            kind: "expression",
            expression: cloneValueExpression(part.expression),
          },
    ),
    loc: semantic.loc,
  };
}

export function pruneFrames(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  traversal: Traversal,
): void {
  const node = getNodeForRef(entries, entry, traversal.ref);
  if (!node) return;
  if (!node.resumable) traversal.frame = createTraversalFrame();
  for (const child of traversal.ownedChildren)
    pruneFrames(entries, entry, child);
  for (const child of traversal.ephemeralChildren)
    pruneFrames(entries, entry, child);
}

export function upsertTraversal(
  traversals: ArcTraversalSet,
  next: ArcTraversal,
): void {
  const key = next.ref;
  const index = traversals.findIndex((item) => item.ref === key);
  if (index >= 0) traversals[index] = cloneArcTraversal(next);
  else traversals.push(cloneArcTraversal(next));
}

export function ensureOwnedTraversal(
  accum: Accumulator,
  childRef: NodeRef,
  childNode: Node,
): Traversal {
  const ownerRef = lexicalParentRef(childRef);
  if (!ownerRef) {
    throw new Error(`Owned child ${formatRef(childRef)} has no lexical owner`);
  }
  const ownerTraversal = findTraversalInSet(accum.traversals, ownerRef);
  if (!ownerTraversal) {
    throw new Error(
      `Missing lexical owner traversal ${formatRef(ownerRef)} for ${formatRef(childRef)}`,
    );
  }
  let child = ownerTraversal.ownedChildren.find(
    (entry) => entry.ref === childRef,
  );
  if (!child) {
    child = createFreshNodeTraversal(childRef, childNode);
    ownerTraversal.ownedChildren.push(child);
  }
  return child;
}

export function findEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
): NodeTraversal | undefined {
  return ownerTraversal.ephemeralChildren.find(
    (entry) => entry.ref === childRef,
  );
}

export function replaceEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
  next: NodeTraversal,
): NodeTraversal {
  const index = ownerTraversal.ephemeralChildren.findIndex(
    (entry) => entry.ref === childRef,
  );
  if (index >= 0) ownerTraversal.ephemeralChildren[index] = next;
  else ownerTraversal.ephemeralChildren.push(next);
  return next;
}

export function ensureEphemeralTraversal(
  ownerTraversal: Traversal,
  childRef: NodeRef,
  childNode: Node,
): NodeTraversal {
  const existing = findEphemeralTraversal(ownerTraversal, childRef);
  if (existing && !isTerminalNodeTraversal(existing)) {
    return existing;
  }
  return replaceEphemeralTraversal(
    ownerTraversal,
    childRef,
    createFreshNodeTraversal(childRef, childNode),
  );
}

export function isTerminalNodeTraversal(traversal: NodeTraversal): boolean {
  return (
    traversal.state === "covered" ||
    traversal.state === "skipped" ||
    traversal.state === "deflected"
  );
}

export function resolveTraversalForBrief(
  traversals: ArcTraversalSet,
  active: NodeRef,
): Traversal {
  const found = findTraversalInSet(traversals, active);
  if (!found)
    throw new Error(`Active traversal not found: ${formatRef(active)}`);
  return found;
}

export function getActionState(
  traversal: Traversal,
  action: ActionStatement | HostEffectStatement,
): ActionState | undefined {
  return traversal.frame.actionStates[action.id];
}

export function getEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: string,
): Record<number, ActionState | undefined> {
  traversal.frame.evaluatorActionStates ??= {};
  traversal.frame.evaluatorActionStates[scopeKey] ??= {};
  return traversal.frame.evaluatorActionStates[scopeKey]!;
}

export function getEvaluatorActionState(
  traversal: Traversal,
  scopeKey: string,
  action: ObserveAction | SetAction,
): ActionState | undefined {
  return getEvaluatorActionStates(traversal, scopeKey)[action.id];
}

export function markEvaluatorActionResolved(
  traversal: Traversal,
  scopeKey: string,
  action: ObserveAction | SetAction,
): void {
  getEvaluatorActionStates(traversal, scopeKey)[action.id] = {
    kind: action.kind,
    status: "resolved",
  };
}

export function clearEvaluatorActionStates(
  traversal: Traversal,
  scopeKey: string,
): void {
  traversal.frame.evaluatorActionStates ??= {};
  delete traversal.frame.evaluatorActionStates[scopeKey];
}

export function clearActionState(traversal: Traversal, actionId: number): void {
  delete traversal.frame.actionStates[actionId];
}

export function isResolvedActionState(state: ActionState | undefined): boolean {
  return state?.status === "resolved";
}

export function markResolvedActionState(
  traversal: Traversal,
  actionId: number,
  kind: ActionState["kind"],
): void {
  traversal.frame.actionStates[actionId] = { kind, status: "resolved" };
}

export function markPendingActionState(
  traversal: Traversal,
  actionId: number,
  kind: ActionState["kind"],
  extras?: Pick<ActionState, "stagedReturns" | "enterLoopPhase">,
): void {
  traversal.frame.actionStates[actionId] = {
    kind,
    status: "pending",
    stagedReturns: extras?.stagedReturns
      ? { ...extras.stagedReturns }
      : undefined,
    enterLoopPhase: extras?.enterLoopPhase,
  };
}

export function markActionResolved(
  traversal: Traversal,
  action: ActionStatement | HostEffectStatement,
): void {
  markResolvedActionState(traversal, action.id, action.kind);
}

export function clearFrame(traversal: Traversal): void {
  traversal.frame = createTraversalFrame();
}

export function setActiveTraversal(
  accum: Accumulator,
  traversal: Traversal,
): void {
  accum.active = traversalToNodeRef(traversal);
}

export function noteBriefYield(accum: Accumulator, traversal: Traversal): void {
  accum.briefActive ??= traversalToNodeRef(traversal);
}

export function childState(
  traversals: ArcTraversalSet,
  ref: ArcRef | NodeRef,
): NodeState | undefined {
  const child = findTraversalInSet(
    traversals,
    isArcRef(ref) ? arcToNodeRef(ref) : ref,
  );
  return child?.state;
}

export function makeBriefId(
  kind: "observe" | "judge" | "host-call" | "instruction",
  arc: ArcRef,
  traversal: Traversal,
  actionId: StatementId,
): BriefId {
  return `${kind}:[${arc}]:[${traversalToNodeRef(traversal)}]:${actionId}`;
}

export function makeObservationId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: StatementId,
): BriefId {
  return makeBriefId("observe", arc, traversal, actionId);
}

export function makeJudgeId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: StatementId,
): BriefId {
  return makeBriefId("judge", arc, traversal, actionId);
}

export function makeHostCallId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: StatementId,
): BriefId {
  return makeBriefId("host-call", arc, traversal, actionId);
}

export function makeInstructionId(
  arc: ArcRef,
  traversal: Traversal,
  actionId: StatementId,
): BriefId {
  return makeBriefId("instruction", arc, traversal, actionId);
}

export function dedupeBriefIds(ids: BriefId[]): BriefId[] {
  return [...new Set(ids)];
}

export function instructionResolutionFrameKey(
  statement: InstructionAction,
  kind: "resolveWhen" | "deflectWhen",
): string {
  return `instruction:${String(statement.id)}:${kind}`;
}

export function enterLoopFrameKey(
  statement: Extract<ActionStatement, { kind: "enter-loop" }>,
): string {
  return `enter-loop:${statement.id}`;
}

export function isInstructionBatchActive(
  accum: Accumulator,
  traversal: Traversal,
): boolean {
  return accum.instructionBatchNode === traversalToNodeRef(traversal);
}

export function canBatchInstruction(
  accum: Accumulator,
  statement: InstructionAction,
): boolean {
  const signature = accum.instructionBatchSignature;
  return (
    signature === undefined ||
    signature === instructionBatchSignature(statement)
  );
}

export function instructionBatchSignature(
  statement: InstructionAction,
): string {
  return JSON.stringify({
    mode: statement.mode,
    resolveWhen: normalizeResolutionStatements(statement.resolveWhen),
    deflectWhen: normalizeResolutionStatements(statement.deflectWhen),
  });
}

export function normalizeResolutionStatements(
  statements: TriggerStatement[] | undefined,
): unknown {
  return (
    statements?.map((statement) => normalizeResolutionStatement(statement)) ??
    null
  );
}

export function normalizeResolutionStatement(
  statement: TriggerStatement,
): unknown {
  if (statement.kind === "if") {
    return {
      kind: "if",
      test: normalizeValueExpression(statement.test),
      consequent: statement.consequent.map((entry) =>
        normalizeResolutionStatement(entry),
      ),
      alternate: statement.alternate?.map((entry) =>
        normalizeResolutionStatement(entry),
      ),
    };
  }
  if (statement.kind === "return") {
    return {
      kind: "return",
      value: statement.value ? normalizeValueExpression(statement.value) : null,
    };
  }
  if (statement.kind === "label") {
    return {
      kind: "label",
      label: statement.label,
      body: statement.body.map((entry) => normalizeResolutionStatement(entry)),
    };
  }
  if (statement.kind === "break") {
    return {
      kind: "break",
      label: statement.label,
    };
  }
  if (statement.kind === "set") {
    return {
      kind: "set",
      variable: statement.variable,
      value: normalizeValueExpression(statement.value),
    };
  }
  return {
    kind: "observe",
    variable: statement.variable,
    question: statement.question
      ? normalizeSemanticString(statement.question)
      : null,
  };
}

export function normalizeValueExpression(expression: ValueExpression): unknown {
  switch (expression.kind) {
    case "literal":
      return { kind: "literal", value: expression.value };
    case "ref":
      return { kind: "ref", name: expression.name };
    case "variable":
      return { kind: "variable", name: expression.name };
    case "channel":
      return {
        kind: "channel",
        namespace: expression.namespace,
        key: expression.key,
      };
    case "deflectionFrom":
      return {
        kind: "deflectionFrom",
        target: { ...expression.target },
      };
    case "scope":
      return {
        kind: "scope",
        name: expression.name,
        count: expression.count ?? null,
      };
    case "enterCount":
      return { kind: "enterCount" };
    case "nodeState":
      return { kind: "nodeState", node: expression.identifier };
    case "judge":
      return {
        kind: "judge",
        question: normalizeSemanticString(expression.question),
      };
    case "host-call":
      return {
        kind: "host-call",
        module: expression.module,
        target: [...expression.target],
        operation: expression.operation,
        arguments: expression.arguments.map((arg) =>
          normalizeHostCallArgument(arg),
        ),
      };
    case "regexTest":
      return {
        kind: "regexTest",
        pattern: expression.pattern,
        flags: expression.flags,
        target: normalizeValueExpression(expression.target),
      };
    case "binary":
      return {
        kind: "binary",
        op: expression.op,
        left: normalizeValueExpression(expression.left),
        right: normalizeValueExpression(expression.right),
      };
    case "logical":
      return {
        kind: "logical",
        op: expression.op,
        left: normalizeValueExpression(expression.left),
        right: normalizeValueExpression(expression.right),
      };
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        argument: normalizeValueExpression(expression.argument),
      };
  }
}

export function normalizeHostCallArgument(arg: HostCallArgument): unknown {
  if (arg.kind === "semantic") {
    return { kind: "semantic", value: normalizeSemanticString(arg.value) };
  }
  if (arg.kind === "value") {
    return { kind: "value", value: normalizeValueExpression(arg.value) };
  }
  if (arg.kind === "array") {
    return {
      kind: "array",
      value: arg.value.map((entry) => normalizeHostCallArgument(entry)),
    };
  }
  return {
    kind: "object",
    value: Object.fromEntries(
      Object.entries(arg.value).map(([key, value]) => [
        key,
        normalizeHostCallArgument(value),
      ]),
    ),
  };
}

export function normalizeSemanticString(semantic: SemanticString): unknown {
  return semantic.parts.map((part) =>
    part.kind === "text"
      ? { kind: "text", value: part.value }
      : {
          kind: "expression",
          expression: normalizeValueExpression(part.expression),
        },
  );
}
