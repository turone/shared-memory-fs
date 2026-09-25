# prepared-scripts

`prepare` and `fs.script` across threads.

A handler is a bare function body in a `.handler` file:

```js
// handlers/hello.handler
return `hello ${name}`;
```

The `handler` preparer turns it — once, on the main thread — into the
file's canonical content, `(function (name) { … })`, with `scriptOptions`
(a filename for stack traces) and `meta`. `fs.script.compile` builds V8
cached data from exactly that prepared source. The extension stays
`.handler`; only the content changes.

A worker runs the handlers with `vm.Script` from `PlaceFs.script()` and the
shared cached data, then writes a new handler into `rules`, a
`sab + virtual` place. The write travels to the main thread, which prepares
and compiles it and publishes it to every thread before the worker's
`writeFile()` Promise resolves. Workers never prepare or compile anything.

## Run

```
node examples/prepared-scripts/run.js
```

Expected output:

```
handlers/bye.handler (bye) -> goodbye, world (cached data accepted)
handlers/hello.handler (hello) -> hello world (cached data accepted)
rules/greet.handler (greet) -> hi world (cached data accepted)
main thread sees rules/greet.handler as (function (name) {…
```

## What this shows

- `prepare` declared in the `fs` domain; the preparer function passed to
  `VfsKernel` (never part of the config).
- One canonical content per file: reads, `script()` bundles and cached data
  all refer to the prepared source.
- `fs.script` with a custom extension, and `cachedDataRejected === false` in
  another thread than the one that compiled.
- Worker → main mutations of a `sab + virtual` place: prepared and compiled
  once by the main thread, visible to the writer when its Promise settles.
