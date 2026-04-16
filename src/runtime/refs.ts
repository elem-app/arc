import type {
  ArcRef,
  ArcTraversalSet,
  Node,
  NodeRef,
  StatementId,
  Traversal,
} from "../types.js";

import type { RegistryEntry } from "./state.js";

export function toArcRef(source: string, identifier: string): ArcRef {
  return `arc:${encodeURIComponent(source)}:${encodeURIComponent(identifier)}`;
}

export function toNodeRef(source: string, path: string[]): NodeRef {
  return `node:${encodeURIComponent(source)}:${path.map(encodeURIComponent).join(".")}`;
}

export function toArcRefParts(ref: ArcRef): {
  source: string;
  identifier: string;
} {
  const [, source, id] = ref.split(":");
  if (source === undefined || id === undefined)
    throw new Error(`Invalid ArcRef: ${ref}`);
  return {
    source: decodeURIComponent(source),
    identifier: decodeURIComponent(id),
  };
}

export function toNodeRefParts(ref: NodeRef): {
  source: string;
  path: string[];
} {
  const [, source, encodedPath] = ref.split(":");
  if (source === undefined || encodedPath === undefined)
    throw new Error(`Invalid NodeRef: ${ref}`);
  return {
    source: decodeURIComponent(source),
    path: encodedPath.split(".").map(decodeURIComponent),
  };
}

export function isArcRef(ref: ArcRef | NodeRef): ref is ArcRef {
  return ref.startsWith("arc:");
}

export function isArcTraversal(
  traversal: Traversal,
): traversal is Extract<Traversal, { ref: ArcRef }> {
  return isArcRef(traversal.ref);
}

export function rootRefOf(ref: ArcRef | NodeRef): ArcRef {
  if (isArcRef(ref)) return ref;
  const { source, path } = toNodeRefParts(ref);
  return toArcRef(source, path[0] ?? "");
}

export function arcToNodeRef(ref: ArcRef): NodeRef {
  const { source, identifier } = toArcRefParts(ref);
  return toNodeRef(source, [identifier]);
}

export function traversalToNodeRef(traversal: Traversal): NodeRef {
  return isArcTraversal(traversal)
    ? arcToNodeRef(traversal.ref)
    : traversal.ref;
}

export function toPseudoChildRef(
  ownerTraversal: Traversal,
  identifier: string,
  stmtId: StatementId,
): NodeRef {
  const owner = toNodeRefParts(traversalToNodeRef(ownerTraversal));
  return toNodeRef(owner.source, [...owner.path, `${identifier}#${stmtId}`]);
}

export function getEntryForRef(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  ref: ArcRef | NodeRef,
): RegistryEntry | undefined {
  return entries.get(rootRefOf(ref));
}

export function formatRef(ref: ArcRef | NodeRef): string {
  if (isArcRef(ref)) {
    const { source, identifier } = toArcRefParts(ref);
    return `${source}::${identifier}`;
  }
  const { source, path } = toNodeRefParts(ref);
  return `${source}::${path.join(".")}`;
}

export function indexTraversals(
  traversals: ArcTraversalSet,
): Map<ArcRef, Extract<Traversal, { ref: ArcRef }>> {
  const indexed = new Map<ArcRef, Extract<Traversal, { ref: ArcRef }>>();
  for (const traversal of traversals) indexed.set(traversal.ref, traversal);
  return indexed;
}

export function getNodeForRef(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  ref: ArcRef | NodeRef,
): Node | undefined {
  const target = isArcRef(ref) ? arcToNodeRef(ref) : ref;
  const targetParts = toNodeRefParts(target);
  const entryParts = toArcRefParts(entry.arc);
  if (targetParts.source !== entryParts.source) return undefined;

  let currentEntry: RegistryEntry | undefined = entry;
  let currentNode: Node | undefined = currentEntry.root;
  let currentRef: NodeRef = toNodeRef(targetParts.source, [
    targetParts.path[0]!,
  ]);
  if (targetParts.path[0] !== currentNode.identifier) return undefined;

  for (const part of targetParts.path.slice(1)) {
    if (!currentNode || !currentEntry) return undefined;

    const directChild: Node | undefined = currentNode.children.find(
      (child) => child.identifier === part,
    );
    if (directChild) {
      currentNode = directChild;
      currentRef = toNodeRef(targetParts.source, [
        ...toNodeRefParts(currentRef).path,
        directChild.identifier,
      ]);
      continue;
    }

    const alias = currentNode.freshAliases.find(
      (aliasEntry) => aliasEntry.identifier === part,
    );
    if (!alias) return undefined;

    const resolvedRef = resolveLexicalRef(
      entries,
      currentEntry,
      currentRef,
      currentNode,
      alias.target,
      alias.imported,
    );
    if (!resolvedRef) return undefined;

    if (isArcRef(resolvedRef)) {
      currentEntry = entries.get(resolvedRef);
      currentNode = currentEntry?.root;
      currentRef = arcToNodeRef(resolvedRef);
      continue;
    }

    currentEntry = getEntryForRef(entries, resolvedRef);
    if (!currentEntry) return undefined;
    currentRef = resolvedRef;
    currentNode = getNodeForRef(entries, currentEntry, resolvedRef);
    if (!currentNode) return undefined;
  }

  return currentNode;
}

export function resolveLexicalRef(
  entries: ReadonlyMap<ArcRef, RegistryEntry>,
  entry: RegistryEntry,
  ownerRef: NodeRef,
  ownerNode: Node,
  identifier: string,
  importedHint?: boolean,
): ArcRef | NodeRef | undefined {
  const ownerParts = toNodeRefParts(ownerRef);

  if (importedHint !== true) {
    const localChild = ownerNode.children.find(
      (child) => child.identifier === identifier,
    );
    if (localChild) {
      return toNodeRef(ownerParts.source, [
        ...ownerParts.path,
        localChild.identifier,
      ]);
    }
  }

  if (
    importedHint !== false &&
    ownerNode.imports.includes(identifier) &&
    entry.importRefs[identifier]
  ) {
    return entry.importRefs[identifier];
  }

  const parentRef = lexicalParentRef(ownerRef);
  if (!parentRef) return undefined;
  const parentEntry = getEntryForRef(entries, parentRef) ?? entry;
  const parentNode = getNodeForRef(entries, parentEntry, parentRef);
  if (!parentNode) return undefined;
  return resolveLexicalRef(
    entries,
    parentEntry,
    parentRef,
    parentNode,
    identifier,
    importedHint,
  );
}

export function lexicalParentRef(ref: NodeRef): NodeRef | undefined {
  const { source, path } = toNodeRefParts(ref);
  if (path.length <= 1) return undefined;
  return toNodeRef(source, path.slice(0, -1));
}

export function findTraversal(
  root: Traversal,
  ref: NodeRef,
): Traversal | undefined {
  if (!isArcTraversal(root) && root.ref === ref) return root;
  if (isArcTraversal(root) && arcToNodeRef(root.ref) === ref) return root;
  for (const child of root.ownedChildren) {
    const found = findTraversal(child, ref);
    if (found) return found;
  }
  for (const child of root.ephemeralChildren) {
    const found = findTraversal(child, ref);
    if (found) return found;
  }
  return undefined;
}

export function findTraversalInSet(
  traversals: ArcTraversalSet,
  ref: NodeRef,
): Traversal | undefined {
  for (const traversal of traversals) {
    const found = findTraversal(traversal, ref);
    if (found) return found;
  }
  return undefined;
}
