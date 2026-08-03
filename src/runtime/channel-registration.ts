import {
  cellSpecToChannelSpec,
  channelSpecsCompatible,
} from "../channel-compat.js";
import type {
  ArcRef,
  Cell,
  ChannelSpec,
  EnterChannelBindingSource,
  Node,
  NodeSignature,
  Statement,
} from "../types.js";
import { toArcRef } from "./refs.js";
import type { RegistryEntry } from "./state.js";

/**
 * Validates every `$enter(...)` / `$enterLoop(...)` binding whose target is an
 * imported arc now resolvable in the registry, against that arc's declared
 * signature. Same-document targets are already checked during document
 * analysis; this covers the cross-document case, which the single-document
 * analysis cannot see. Throws on the first incompatibility so an incompatible
 * binding rejects registration; the caller runs it on a prospective registry
 * before committing, keeping `Runtime.add()` atomic.
 */
export function validateImportedChannelBindings(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): void {
  for (const entry of entries.values()) {
    validateNodeImportedBindings(entry.root, [], entry, entries);
  }
}

function validateNodeImportedBindings(
  node: Node,
  ancestorCells: Cell[],
  entry: RegistryEntry,
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): void {
  const cells = [...ancestorCells, ...node.cells];
  for (const statement of collectEnterStatements(node.statements)) {
    checkEnterBinding(statement, node, cells, entry, entries);
  }
  for (const child of node.children) {
    validateNodeImportedBindings(child, cells, entry, entries);
  }
}

/**
 * The innermost declaration of a cell name in an outermost-first cell list,
 * matching runtime lexical shadowing.
 */
function findInnermostCell(cells: Cell[], name: string): Cell | undefined {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]!.name === name) return cells[index];
  }
  return undefined;
}

/** Collects every enter statement reachable in a node body, nesting included. */
function collectEnterStatements(
  statements: readonly Statement[],
): Array<Extract<Statement, { kind: "enter-node" | "enter-loop" }>> {
  const result: Array<
    Extract<Statement, { kind: "enter-node" | "enter-loop" }>
  > = [];
  const walk = (list: readonly Statement[]): void => {
    for (const statement of list) {
      if (statement.kind === "enter-node" || statement.kind === "enter-loop") {
        result.push(statement);
      } else if (statement.kind === "if") {
        walk(statement.consequent);
        if (statement.alternate) walk(statement.alternate);
      } else if (statement.kind === "label" || statement.kind === "invoke") {
        walk(statement.body);
      }
    }
  };
  walk(statements);
  return result;
}

function checkEnterBinding(
  statement: Extract<Statement, { kind: "enter-node" | "enter-loop" }>,
  callerNode: Node,
  cells: Cell[],
  entry: RegistryEntry,
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): void {
  if (!statement.target.imported) return;
  const targetArc = entry.importRefs[statement.target.identifier];
  if (!targetArc) return;
  const targetSignature = entries.get(targetArc)?.root.signature;
  if (!targetSignature) return;
  const callerSignature = callerNode.signature;
  const label = statement.kind === "enter-loop" ? "$enterLoop" : "$enter";

  const provided = (
    source: EnterChannelBindingSource,
  ): ChannelSpec | undefined => {
    if (source.kind === "cell") {
      // Resolve innermost-first to match runtime lexical resolution
      // (`findCellOwner` walks the lexical parent chain outward): a cell the
      // caller node declares shadows a same-named ancestor cell. `cells` is
      // ordered outermost-first, so the last match is the innermost owner.
      const cell = findInnermostCell(cells, source.cell);
      return cell ? cellSpecToChannelSpec(cell) : undefined;
    }
    if (source.kind === "argsProjection") {
      return callerSignature?.args[source.key];
    }
    if (source.kind === "span") {
      if (source.key === "index") return { type: "index" };
      // `span.item` / `span.result` element types are the enclosing `$map`'s;
      // the map driver checks them, so skip here.
      return undefined;
    }
    return undefined;
  };

  const checkMap = (
    namespace: "args" | "returns",
    bindings: Record<string, EnterChannelBindingSource> | undefined,
    schema: NodeSignature["args"],
  ): void => {
    for (const [key, source] of Object.entries(bindings ?? {})) {
      const declared = schema[key];
      if (!declared) {
        throw new Error(
          `ENTER_CHANNEL_UNDECLARED: ${label}(${statement.target.identifier}) binds ${namespace}.${key}, which the imported arc does not declare`,
        );
      }
      const providedSpec = provided(source);
      if (providedSpec && !channelSpecsCompatible(providedSpec, declared)) {
        throw new Error(
          `ENTER_CHANNEL_INCOMPATIBLE: ${label}(${statement.target.identifier}) ${namespace}.${key} binding is incompatible with the imported channel type`,
        );
      }
    }
  };

  checkMap("args", statement.args, targetSignature.args);
  checkMap("returns", statement.returns, targetSignature.returns);
}

/**
 * Recomputes each entry's resolved import refs against the given registry, as a
 * pure map transform (no mutation of the input entries). A binding resolves only
 * when its imported arc is present.
 */
export function computeImportRefs(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
): Map<ArcRef, RegistryEntry> {
  const result = new Map<ArcRef, RegistryEntry>();
  for (const [key, entry] of entries) {
    const importRefs: Record<string, ArcRef> = {};
    for (const binding of entry.document.imports) {
      const imported = toArcRef(binding.source, binding.importedName);
      if (entries.has(imported)) {
        importRefs[binding.localName] = imported;
      }
    }
    result.set(key, { ...entry, importRefs });
  }
  return result;
}
