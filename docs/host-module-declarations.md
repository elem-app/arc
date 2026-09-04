# Host Module Declarations

A host module declaration describes the operations one `host:*` module exposes to Arc. Host developers construct this declaration in JavaScript or TypeScript with `hmd`, then pass the normalized result to `Runtime` separately from the operation implementations.

```js
import { hmd } from "arc/host-utils";
import { Runtime } from "arc/runtime";

const storeModule = hmd.define({
  lookup: (name = hmd.Str()) => hmd.Artifact(),
  related: (artifacts = hmd.Array(hmd.Artifact())) => hmd.Array(hmd.Artifact()),
  archive: (artifact = hmd.Artifact()) => {},
  home: {
    rebuild: (force = hmd.Bool()) => hmd.Bool(),
  },
});

const runtime = new Runtime({
  hostModules: new Map([["store", storeModule]]),
});
```

The registry key `store` corresponds to the Arc import `host:store`. Arc core does not define declaration filenames, module resolution, handler registration, or the association between this declaration and host implementation code.

## `hmd.define()`

`hmd.define()` accepts a plain object tree and returns a normalized `HostModuleSpec`:

- a nested object declares a namespace;
- a function declares an operation;
- marker calls in default initializers declare required positional parameters;
- a returned marker declares the result;
- an undefined return, including an empty block body, declares no result.

The declaration function is schema notation, not the host operation implementation. `hmd.define()` evaluates it synchronously once to collect its markers. Parameter identifiers are for host-source readability and are discarded from the normalized spec.

An operation with a result may be used as an expression-position host call or as an effect. An operation without a result may be used only as an effect. The `$` sigil belongs only to an effect use in Arc source; declaration and host dispatch names remain unsigiled.

## Markers

| Marker | Parameter | Result | Admitted value |
| --- | --- | --- | --- |
| `hmd.Bool()` | Yes | Yes | Boolean |
| `hmd.Str()` | Yes | Yes | Plain string |
| `hmd.Enum(["a", "b"])` | Yes | Yes | One declared string member |
| `hmd.Num()` | Yes | Yes | Finite number |
| `hmd.Index()` | Yes | Yes | Non-negative safe integer |
| `hmd.Artifact()` | Yes | Yes | Artifact value with a valid relative path |
| `hmd.Dialog.Cursor()` | Yes | Yes | Dialog cursor |
| `hmd.Array(marker)` | Yes | Restricted | Array whose elements satisfy the marker |
| `hmd.Tuple([markerA, markerB])` | Yes | No | Fixed-length positional tuple |
| `hmd.SemanticText()` | Yes | No | Plain or structured rendered semantic text |

Parameter arrays may be recursive. Result arrays are one-level and permit the Arc element specs `Bool`, `Str`, `Enum`, `Num`, and `Artifact`; nested arrays, tuples, and other parameter-only specs remain unavailable as results. Enum domains must be nonempty arrays of unique strings.

`SemanticText` lets the host receive Arc's structured semantic rendering, including references such as users and Artifacts. `Str` requires a plain rendered string. `Artifact` gives the transport object Artifact meaning through the selected operation spec rather than through object shape alone.

Markers are private declaration tokens. They are valid only while an operation is being captured by `hmd.define()` and never appear in the returned `HostModuleSpec`, Arc IR, runtime state, briefs, reports, or payloads.

## Invalid declarations

`hmd.define()` rejects malformed namespace trees, accessors, symbol keys, custom prototypes, cycles, empty or `$`-prefixed member names, invalid marker composition, invalid Enum domains, and parameter-only markers used as results.

Declaration functions must be synchronous. Ordinary async functions are rejected before invocation. If a non-async function returns a Promise or thenable, `hmd.define()` observes its rejection and fails the declaration without leaving unhandled asynchronous work.

`hmd.define()` works from evaluated JavaScript objects and does not parse function source. It therefore cannot diagnose source details already erased by JavaScript evaluation, such as an overwritten duplicate object key.

## Runtime enforcement

The returned declaration participates at three existing runtime boundaries:

1. `Runtime.add()` resolves imported operations and rejects unknown paths, wrong arity, missing call results, and provably incompatible operands or consumers. A whole `Array(Artifact())` cell or channel satisfies a matching immediate host-array parameter under its registered element authority.
2. Before emitting a host-call brief, the runtime admits each concrete argument against its declared parameter spec. Recursive parameter arrays and tuples report the first failing payload path.
3. Before accepting a reported call result, the runtime admits it against the declared result spec. An `Array(Artifact())` result admits every exact Artifact member, reports the first invalid index, and retains its result authority through downstream landing and replay without serialized provenance.

`Runtime` accepts normalized `HostModuleSpec` values directly. Using `hmd` is the public host-authoring utility; it does not become part of runtime evaluation.
