/** Shared structural forms and traversal for specs, declarations, and metadata. */

/**
 * A struct shape whose fields belong to one field family `F`. A family is
 * closed under nesting when each of its struct members is itself a
 * `StructShape<F>`, as for guarantees and for authored declarations.
 * The interface permits those recursive families to instantiate the shape
 * without eager circular type-alias expansion.
 */
export interface StructShape<F> {
  type: "struct";
  fields: Record<string, F>;
}

/** Ordered alternatives shared by guarantees, declarations, and metadata. */
export interface UnionShape<M> {
  type: "union";
  members: M[];
}

/**
 * Resolves the field a non-empty path names inside a struct. `asStruct`
 * exposes a field as a nested struct of the same family, or returns
 * `undefined` for a non-struct field, so a field at any depth keeps the
 * receiver's family.
 */
export function fieldAtPath<F>(
  struct: StructShape<F>,
  path: readonly string[],
  asStruct: (field: F) => StructShape<F> | undefined,
): F | undefined {
  let fields = struct.fields;
  let field: F | undefined;
  for (const [depth, name] of path.entries()) {
    if (depth > 0) {
      const nested = asStruct(field!);
      if (!nested) return undefined;
      fields = nested.fields;
    }
    if (!Object.hasOwn(fields, name)) return undefined;
    field = fields[name]!;
  }
  return field;
}
