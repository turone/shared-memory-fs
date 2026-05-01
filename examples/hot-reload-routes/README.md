# hot-reload-routes

HTTP server whose route handlers live entirely in a memory-backed VFS place.
A simulated agent writes new `.js` files into the place at runtime; subsequent
HTTP requests immediately see them via patched `require()`.

## Run

```
node examples/hot-reload-routes/server.js
```

## Try

```
curl http://localhost:3000/hello   # initial route
# wait 2 s
curl http://localhost:3000/time    # written by agent at +2 s
# wait 2 s
curl http://localhost:3000/echo?x=1  # written by agent at +4 s
# wait 2 s
curl http://localhost:3000/hello   # /hello replaced with new body at +6 s
```

## What this shows

- `provider: 'memory'` place is fully writable; `place.writeFile(key, buf)` is
  the API used by the agent.
- Patched `require()` resolves absolute paths inside the place's mount even
  when the file does not exist on disk (memory-only).
- Hot reload = `delete require.cache[absPath]` after each write. The next
  `require()` recompiles from the updated buffer.
- `compile: true` could be added to the place config for V8 bytecode caching;
  it would be regenerated on every write automatically.
