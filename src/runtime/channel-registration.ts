import { reusableSpecCompatible } from "../spec/resolution.js";
import type {
  ArrayReference,
  Cell,
  EnterChannelBindingSource,
  Node,
  NodeSignature,
  Statement,
} from "../types/parser.js";
import type { ArcRef, RuntimeRegistryIssue } from "../types/runtime.js";
import {
  cellSpecToChannelSpec,
  type ArrayElementSpec,
  type ChannelSpec,
} from "../types/spec.js";
import { toArcRef, toArcRefParts } from "./refs.js";
import type { RegistryEntry } from "./state.js";

type MapBindingContext = {
  receiver?: ArrayElementSpec;
  result?: ArrayElementSpec;
};

type RuntimeChannelIssue = Exclude<
  RuntimeRegistryIssue,
  { code: "UNRESOLVED_IMPORT" }
>;

/** Resolves every declared import against a complete prospective registry. */
export function resolveImportRefs(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): {
  entries: Map<ArcRef, RegistryEntry>;
  issues: RuntimeRegistryIssue[];
} {
  const result = new Map<ArcRef, RegistryEntry>();
  const issues: RuntimeRegistryIssue[] = [];
  const reportedUnresolved = new Set<string>();
  for (const [key, entry] of entries) {
    const source = toArcRefParts(entry.arc).source;
    const importRefs: Record<string, ArcRef> = {};
    for (const binding of entry.document.imports) {
      const imported = toArcRef(binding.source, binding.importedName);
      if (!entries.has(imported)) {
        const issueKey = `${source}\0${binding.localName}\0${binding.source}\0${binding.importedName}`;
        if (!reportedUnresolved.has(issueKey)) {
          reportedUnresolved.add(issueKey);
          issues.push({
            phase: "registry",
            code: "UNRESOLVED_IMPORT",
            message: `${binding.localName} resolves to an unregistered arc ${binding.source}:${binding.importedName}`,
            source,
            localName: binding.localName,
            importedSource: binding.source,
            importedName: binding.importedName,
            loc: binding.loc,
          });
        }
        continue;
      }
      importRefs[binding.localName] = imported;
    }
    result.set(key, { ...entry, importRefs });
  }
  return { entries: result, issues };
}

/**
 * Validates every imported enter binding with the lexical and map context of
 * its original statement. The caller runs this against a prospective resolved
 * registry and commits only after the complete walk succeeds.
 */
export function validateImportedChannelBindings(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): RuntimeRegistryIssue[] {
  const issues: RuntimeRegistryIssue[] = [];
  for (const entry of entries.values()) {
    validateNodeImportedBindings(entry.root, [], entry, entries, issues);
  }
  return issues;
}

function validateNodeImportedBindings(
  node: Node,
  ancestorCells: readonly Cell[],
  entry: RegistryEntry,
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  issues: RuntimeRegistryIssue[],
): void {
  const cells = [...ancestorCells, ...node.cells];
  walkStatements(
    node.statements,
    node,
    cells,
    undefined,
    entry,
    entries,
    issues,
  );
  for (const child of node.children) {
    validateNodeImportedBindings(child, cells, entry, entries, issues);
  }
}

function walkStatements(
  statements: readonly Statement[],
  callerNode: Node,
  cells: readonly Cell[],
  map: MapBindingContext | undefined,
  entry: RegistryEntry,
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  issues: RuntimeRegistryIssue[],
): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "enter-node":
      case "enter-loop":
        checkEnterBinding(
          statement,
          callerNode,
          cells,
          map,
          entry,
          entries,
          issues,
        );
        break;
      case "if":
        walkStatements(
          statement.consequent,
          callerNode,
          cells,
          map,
          entry,
          entries,
          issues,
        );
        if (statement.alternate) {
          walkStatements(
            statement.alternate,
            callerNode,
            cells,
            map,
            entry,
            entries,
            issues,
          );
        }
        break;
      case "label":
      case "invoke":
        walkStatements(
          statement.body,
          callerNode,
          cells,
          map,
          entry,
          entries,
          issues,
        );
        break;
      case "map":
        walkStatements(
          statement.body,
          callerNode,
          cells,
          {
            receiver: arrayReferenceElementSpec(
              statement.receiver,
              cells,
              callerNode.signature,
            ),
            result:
              statement.results === undefined
                ? undefined
                : arrayCellElementSpec(statement.results, cells),
          },
          entry,
          entries,
          issues,
        );
        break;
      default:
        break;
    }
  }
}

function checkEnterBinding(
  statement: Extract<Statement, { kind: "enter-node" | "enter-loop" }>,
  callerNode: Node,
  cells: readonly Cell[],
  map: MapBindingContext | undefined,
  entry: RegistryEntry,
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  issues: RuntimeRegistryIssue[],
): void {
  if (!statement.target.imported) return;
  const targetArc = entry.importRefs[statement.target.identifier];
  if (!targetArc) return;
  const target = entries.get(targetArc);
  if (!target) {
    throw new Error(
      `Resolved import ${statement.target.identifier} is missing from the prospective registry`,
    );
  }
  const targetSignature = target.root.signature;
  const label = statement.kind === "enter-loop" ? "$enterLoop" : "$enter";

  checkBindings(
    "args",
    statement.args,
    targetSignature?.args ?? {},
    statement.target.identifier,
    label,
    (source) => sourceSpec(source, callerNode.signature, cells, map),
    statement,
    callerNode,
    entry,
    issues,
  );
  checkBindings(
    "returns",
    statement.returns,
    targetSignature?.returns ?? {},
    statement.target.identifier,
    label,
    (source) => sourceSpec(source, callerNode.signature, cells, map),
    statement,
    callerNode,
    entry,
    issues,
  );
}

function checkBindings(
  namespace: "args" | "returns",
  bindings: Record<string, EnterChannelBindingSource> | undefined,
  schema: Readonly<Record<string, ChannelSpec>>,
  target: string,
  label: string,
  provided: (source: EnterChannelBindingSource) => ChannelSpec | undefined,
  statement: Extract<Statement, { kind: "enter-node" | "enter-loop" }>,
  callerNode: Node,
  entry: RegistryEntry,
  issues: RuntimeRegistryIssue[],
): void {
  for (const [key, source] of Object.entries(bindings ?? {})) {
    const declared = schema[key];
    if (!declared) {
      issues.push({
        ...bindingIssueContext(
          "ENTER_CHANNEL_UNDECLARED",
          `${label}(${target}) binds ${namespace}.${key}, which the imported arc does not declare`,
          namespace,
          key,
          statement,
          callerNode,
          entry,
        ),
        target,
      });
      continue;
    }
    const providedSpec = provided(source);
    if (!providedSpec) {
      issues.push({
        ...bindingIssueContext(
          "ENTER_CHANNEL_UNRESOLVED",
          `${label}(${target}) ${namespace}.${key} source has no spec in its lexical or map context`,
          namespace,
          key,
          statement,
          callerNode,
          entry,
        ),
        target,
      });
      continue;
    }
    const providerSpec = namespace === "args" ? providedSpec : declared;
    const receiverSpec = namespace === "args" ? declared : providedSpec;
    const compatible = reusableSpecCompatible(providerSpec, receiverSpec);
    if (!compatible) {
      issues.push({
        ...bindingIssueContext(
          "ENTER_CHANNEL_INCOMPATIBLE",
          `${label}(${target}) ${namespace}.${key} binding is incompatible with the imported channel type`,
          namespace,
          key,
          statement,
          callerNode,
          entry,
        ),
        target,
      });
    }
  }
}

function bindingIssueContext(
  code: RuntimeChannelIssue["code"],
  message: string,
  namespace: "args" | "returns",
  key: string,
  statement: Extract<Statement, { kind: "enter-node" | "enter-loop" }>,
  callerNode: Node,
  entry: RegistryEntry,
): Omit<RuntimeChannelIssue, "target"> {
  return {
    phase: "registry",
    code,
    message,
    arc: entry.arc,
    node: callerNode.identifier,
    actionId: statement.id,
    namespace,
    key,
    loc: statement.loc,
  };
}

function sourceSpec(
  source: EnterChannelBindingSource,
  signature: NodeSignature | undefined,
  cells: readonly Cell[],
  map: MapBindingContext | undefined,
): ChannelSpec | undefined {
  switch (source.kind) {
    case "cell": {
      const cell = findInnermostCell(cells, source.cell);
      return cell ? cellSpecToChannelSpec(cell) : undefined;
    }
    case "argsProjection":
      return signature?.args[source.key];
    case "span":
      if (source.key === "index") return { type: "index" };
      return source.key === "item" ? map?.receiver : map?.result;
  }
}

function findInnermostCell(
  cells: readonly Cell[],
  name: string,
): Cell | undefined {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]!.name === name) return cells[index];
  }
  return undefined;
}

function arrayReferenceElementSpec(
  reference: ArrayReference,
  cells: readonly Cell[],
  signature: NodeSignature | undefined,
): ArrayElementSpec | undefined {
  if (reference.kind === "channel") {
    const spec = signature?.[reference.namespace][reference.key];
    return spec?.type === "array" ? spec.element : undefined;
  }
  const cell = findInnermostCell(cells, reference.name);
  return cell?.type === "array" ? cell.element : undefined;
}

function arrayCellElementSpec(
  name: string,
  cells: readonly Cell[],
): ArrayElementSpec | undefined {
  const cell = findInnermostCell(cells, name);
  return cell?.type === "array" ? cell.element : undefined;
}
