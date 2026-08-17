# Run doc — Bengaluru AI Atlas

Vite + three.js app, no backend, no env files. The dev server serves the map on
`http://localhost:5173/` (vite binds the IPv6 loopback only, so use
`localhost`, not `127.0.0.1`).

## Reproduce the artifacts

A fresh checkout needs no copied files — there are no `.env*` files in this
project (`.gitignore` ignores `*.local`) and no build step is required for the
dev server. Just install dependencies:

```bash
npm install
```

`node_modules/` is already present in this checkout. Node/npm come from
Homebrew (`/opt/homebrew/bin/node`, `/opt/homebrew/bin/npm`).

## Run the server

```bash
npm run dev        # dev server on http://localhost:5173/
npm run build      # production build → dist/
npm run preview    # serve the production build
```

To keep the server alive detached (macOS), submit it under launchd so it
outlives the terminal:

```bash
launchctl submit -l com.freebuff.preview.blr -- /bin/sh -c \
  "cd /Users/apple/Desktop/zoop/poc/bangloreatlas && \
   HOME=/Users/apple PATH=/opt/homebrew/bin:/usr/bin:/bin \
   /opt/homebrew/bin/npm run dev > /tmp/freebuff-preview-a1c6e38d.log 2>&1"
```

Then check it with `launchctl print gui/$(id -u)/com.freebuff.preview.blr`
(look for `state = running` and a `pid`) and `curl -s -o /dev/null -w
"%{http_code}" http://localhost:5173/`. Remove the job when done with
`launchctl remove com.freebuff.preview.blr`.

### Gotchas learned the hard way

- **launchd needs explicit env.** `launchctl submit` jobs get a bare
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no `HOME`; `npm` is not on that
  path and npm needs `$HOME`. Set both in the shell command, or the job dies
  instantly with `last exit code = 1`.
- **TCC blocks logging into the workspace.** launchd-spawned processes cannot
  write inside `~/Desktop/...` (macOS Transparency-Consent-Control), so any
  `> /Users/apple/Desktop/.../.freebuff/*.log` redirect fails with exit 1 and
  an *empty* log. Redirect to `/tmp` instead, and copy the log into
  `.freebuff/` afterwards if you want it recorded.
- **Poisoned launchd labels.** A label that has failed once gets throttled
  respawn state; re-submitting under the same label can keep failing even
  after the command is fixed. Remove the job and use a fresh label.
- A pid reported dead by `ps` right after a `nohup ... &` launch means the
  terminal reaped the process group, not that the server crashed — check the
  log, then use launchd as above.
