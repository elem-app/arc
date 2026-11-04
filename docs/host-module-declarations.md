# Host Module Declarations

A host module declaration defines the operations available to Arc, their accepted arguments, and their returned values. `hmd` provides the declaration notation. Declarations are registered with `Runtime`; operation implementations are connected through the host’s dispatch mechanism.

## Module declaration and registration

`hmd.define()` accepts a plain object whose properties form a recursive tree of operations and namespaces. The same rule applies to every property, at every depth:

- A function declares an operation. Its parameter markers describe the arguments the operation accepts, and its returned marker describes the operation's returned value.
- A plain object declares a namespace. Its properties declare further operations or namespaces using the same rule.

Property names form the path to each operation. Namespaces group operations and are not callable themselves.

```js
import { hmd } from "arc/host-utils";
import { Runtime } from "arc/runtime";

const storeModule = hmd.define({
  lookup: (name = hmd.Str()) => hmd.Artifact(),
  archive: (artifact = hmd.Artifact()) => {},
  home: {
    rebuild: (force = hmd.Bool()) => hmd.Bool(),
    cache: {
      clear: () => {},
    },
  },
});

const runtime = new Runtime({
  hostModules: new Map([["store", storeModule]]),
});
```

The name `store` lets an Arc script import this module with `import Store from "host:store"`. The declaration exposes `Store.lookup(...)`, `Store.$archive(...)`, `Store.home.rebuild(...)`, and `Store.home.cache.$clear()`. The `$` prefix marks an action call in Arc source; it is not part of the declared operation name.

A plain object in this declaration tree defines a namespace. An object argument is declared separately with `hmd.Struct({...})` inside an operation's parameter declaration. Its fields describe argument data rather than further operations.

In `lookup`, `name = hmd.Str()` declares the string argument Arc supplies to the host. The returned `hmd.Artifact()` marker declares the value the host returns when Arc uses the result of `lookup`. The empty body of `archive` declares an operation with no returned value.

Declaration functions describe operations whose implementations are supplied separately. `hmd.define()` runs each declaration function synchronously once. These functions contain declaration markers; marker calls are valid only within an operation declaration. The JavaScript default-parameter syntax specifies argument requirements, not default argument values.

Arc passes arguments by position. Parameter names such as `name` and `artifact` serve as descriptive labels in the declaration; callers do not use them as named arguments.

## Arguments and returned values

An argument can use any value marker in the reference below. Arrays, tuples, and Structs can nest recursively.

An operation’s returned value can be declared with `hmd.Bool()`, `hmd.Str()`, `hmd.Enum(...)`, `hmd.Num()`, `hmd.Index()`, `hmd.Artifact()`, or `hmd.Dialog.Cursor()`.

An operation can also return a `hmd.Struct({...})` record, or a one-level array of booleans, strings, Enum members, finite numbers, Artifacts, or Struct records. A returned Struct's fields use `Bool`, `Str`, `Enum`, `Num`, a nested `Struct`, or a one-level array of any of these, and none is `Omittable`. For example:

```js
const storeModule = hmd.define({
  related: (artifact = hmd.Artifact()) => hmd.Array(hmd.Artifact()),
  contacts: () => hmd.Array(hmd.Struct({ name: hmd.Str(), age: hmd.Num() })),
});
```

`Tuple` and `SemanticText` describe arguments only.

An Arc caller can use an operation's returned value in an expression, such as `Store.lookup("notes")`. To call an operation as an action, the caller adds `$`, as in `Store.$archive(artifact)`. An action call waits for completion and discards any returned value. An operation with no returned value can only be called as an action. Declared operation names omit `$`, including names of operations that return no value.

## Value markers

| Marker | Values it accepts |
| --- | --- |
| `hmd.Bool()` | A boolean. |
| `hmd.Str()` | A plain string. |
| `hmd.Enum(["a", "b"])` | One of the listed strings. The list must be nonempty and contain no duplicates. |
| `hmd.Num()` | A finite number. |
| `hmd.Index()` | A non-negative safe integer. |
| `hmd.Artifact()` | An Artifact. |
| `hmd.Dialog.Cursor()` | A dialog cursor. |
| `hmd.Array(marker)` | An array in which every element satisfies the given marker. |
| `hmd.Tuple([markerA, markerB])` | An array with exactly the listed positions, each satisfying its corresponding marker. |
| `hmd.Struct({ field: marker })` | An object with the declared fields, each satisfying its corresponding marker. |
| `hmd.SemanticText()` | Semantic text. |

## Omittable arguments and fields

`hmd.Omittable(marker)` allows an argument or Struct field to be absent. Omitted arguments and fields remain absent; the host implementation determines any defaults. Supplied values must satisfy the wrapped marker; unset and null values are invalid.

For example, an operation can declare an omittable second argument:

```js
const storeModule = hmd.define({
  lookup: (name = hmd.Str(), limit = hmd.Omittable(hmd.Num())) =>
    hmd.Artifact(),
});
```

Arc callers may write `Store.lookup("x")` or `Store.lookup("x", 10)`.

Required arguments precede omittable arguments. A caller can omit any trailing portion of the omittable arguments, and an operation may make all its arguments omittable. Named Struct fields have no ordering requirement; omittable fields may appear anywhere in the declaration.

`Omittable` can wrap any value marker. It applies only to operation parameters and Struct fields; wrapping array elements, tuple positions, another `Omittable`, or an operation's returned value is invalid.

## Object arguments with Struct

`hmd.Struct({...})` declares the fields an object argument accepts:

```js
const recordsModule = hmd.define({
  record: (
    entry = hmd.Struct({
      title: hmd.Str(),
      limit: hmd.Omittable(hmd.Num()),
    }),
  ) => {},
});
```

Arc callers must supply `title`. They may omit `limit`; when supplied, it must be a finite number. Additional fields are rejected. These are both valid arguments:

```js
{ title: "Review" }
{ title: "Review", limit: 3 }
```

Field order is irrelevant. `hmd.Struct({})` accepts an empty object; a Struct whose fields are all omittable also accepts an empty object.

An omittable field can contain a nested Struct:

```js
const recordsModule = hmd.define({
  record: (
    entry = hmd.Struct({
      title: hmd.Str(),
      tags: hmd.Array(hmd.Str()),
      context: hmd.Omittable(
        hmd.Struct({
          instruction: hmd.SemanticText(),
          attachment: hmd.Omittable(hmd.Artifact()),
        }),
      ),
    }),
  ) => {},
});
```

Here, the caller may omit `context` entirely. When it supplies `context`, it must include `instruction` and may omit `attachment`.

Field names must be nonempty and cannot be `__proto__`, `prototype`, or `constructor`.

## Declaration errors and call validation

`hmd.define()` rejects invalid declarations. Namespace and Struct field declaration objects must be plain objects, including objects with a null prototype. Their properties must be own enumerable data properties. Accessors, symbol properties, non-enumerable properties, custom prototypes, and cycles are invalid. Namespace and operation names must be nonempty and cannot begin with `$`.

Operations must be synchronous functions that declare arguments and returned values through HMD markers. Async functions, Promise-returning declarations, invalid Enum lists, and unsupported uses of markers are rejected.

JavaScript overwrites duplicate keys in declaration objects before `hmd.define()` receives them. The declaration utility therefore cannot detect overwritten entries.

Arc checks calls against registered declarations. During script registration, it rejects unknown operations, incorrect argument counts, and argument mismatches that can be established at that stage. Before emitting a call to the host, Arc checks the actual supplied arguments, including every nested field and array element. An invalid argument prevents the call from being emitted; diagnostics identify the failing field or element.

When Arc uses an operation’s returned value, it checks that value against the declaration before allowing the script to continue with it. The call and completion-report APIs are described in [Host Calls in the runtime API](../specs/arc-runtime-api.md#host-calls).
