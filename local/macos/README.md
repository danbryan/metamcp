# MetaMCP macOS host

Personal-macOS deployment assets for MetaMCP. The signed background host gives the gateway and every MCP child a stable TCC responsible-app identity.

## Architecture

```text
launchd com.bryanlabs.metamcp
  -> Bryanlabs MetaMCP Host.app (net.bryanlabs.metamcp-host)
     -> run.sh
        -> backend Node :12009
        -> Next frontend :12008
        -> MCP child processes
```

The host remains resident, forwards termination signals, and restarts `run.sh` after a two-second delay when the launcher exits. The launcher path comes from `METAMCP_HOST_LAUNCHER` or is derived from `HOME`, so the same source works on both laptops. launchd restarts the host if the host itself dies. It has no UI and contains no credentials.

This replaced the prior launchd path that started `/bin/bash` and self-responsible Node directly. INF-474 verified the old path caused repeated macOS App Data prompts. A 14-hour Ghostty-hosted experiment survived sleep/wake and 19 backend restarts with zero Node/Herdr prompts, proving that a stable responsible app is the required boundary.

## Build

```sh
local/macos/build-host.sh
```

The app is written to `~/Applications/Bryanlabs MetaMCP Host.app` and signed with Bryanlabs Developer ID. Source and the in-place rebuild script are copied into the app Resources.

## Install

Copy the tracked assets to their live paths:

- `run.sh` and `watchdog.sh` -> `~/Library/Application Support/metamcp/`
- `com.bryanlabs.metamcp.plist` -> `~/Library/LaunchAgents/`
- `linear-mcp-serve.mjs` -> `~/Library/Application Support/metamcp/linear-mcp/serve.mjs` when using the local Linear transport

Then bootstrap the main, watchdog, and nightly LaunchAgents. The main plist launches the app executable, not shell or Node. The existing `.env`, Postgres database, endpoint keys, and pgdump job are unchanged.

`run.sh` accepts `METAMCP_NODE_DIR` for an isolated runtime test. Production defaults to `/opt/homebrew/bin`. It logs the selected Node executable/version, applies migrations, starts the backend and frontend, and force-reaps either child during shutdown.

### Local Linear MCP

The personal deployment pins `@kkaminsk/linear-mcp@1.0.0` under
`~/Library/Application Support/metamcp/linear-mcp/` and launches the tracked
`linear-mcp-serve.mjs` wrapper over stdio. The API key remains in the MetaMCP
server row's `LINEAR_API_KEY` environment value. The wrapper keeps the package's
structured MCP result and mirrors it into text because the current MetaMCP proxy
does not forward `structuredContent` to clients. Install with scripts disabled
and audit before use:

```sh
cd ~/Library/Application\ Support/metamcp/linear-mcp
npm install --ignore-scripts --save-exact @kkaminsk/linear-mcp@1.0.0
npm audit --omit=dev
```

Do not invoke the package's `.bin/linear-mcp` symlink. Version 1.0.0's main-module
check does not recognize that symlink name and exits without starting the MCP
server; the wrapper imports and runs the packaged entry point directly.

## Validation

Required after deployment:

1. App signature and designated requirement are valid for bundle ID `net.bryanlabs.metamcp-host` and Bryanlabs team `VS4G53Q3JB`.
2. Host, `run.sh`, backend, frontend, and MCP children resolve responsibility to the host PID.
3. Backend `/health` is 200; frontend is reachable and redirects to login.
4. Pi reconnects through dynamic `mcp`/`mcpScript`.
5. Killing the backend leaves the host PID unchanged and produces a healthy replacement backend.
6. Sleep/wake and reboot do not raise Node privacy prompts.

## Fantastical suggestions-only integration

The bundled Flexibits native helper is launched directly, not through the retired
Node MCP wrapper. The gateway policy in
`apps/backend/src/lib/metamcp/server-tool-policy.ts` reserves:

- Server UUID: `646228d4-3167-4be1-b3ee-615f8d5c43c2`
- Name: `fantastical-suggestions`
- Type: `STDIO`
- Command: `/Applications/Fantastical.app/Contents/Helpers/FantasticalMCP.app/Contents/MacOS/FantasticalMCP`
- Sole allowed tool: `findAvailableTimes`

Any identity mismatch is denied. The guard is installed at the pooled SDK
client's request boundary, covering regular MCP, OpenAPI, discovery, and
reconnected clients. Unknown tools and alternate request methods are rejected
before dispatch; only the allowed tool is cached. Namespace name overrides
cannot turn another name into this tool. Meta search/describe also filter stale
reserved-name entries. Other providers retain their existing behavior.

Do not substitute namespace `INACTIVE` mappings for this policy: those mappings
permit unknown future tools and database lookup failures by default. The native
server remains write-capable internally; the gateway is the enforced boundary,
not an intrinsic read-only permission granted by Fantastical.

The integration uses one connection attempt and a 15-second initialization/tool
call deadline. A failed connection is held in server error state for operator
review. Native call failures return an MCP tool-error result, not a transport
exception, so the gateway cannot automatically reconnect and repeat the call.
Stop on a native consent prompt, never auto-click or respawn to obtain permission.
Deploy through the existing signed MetaMCP Host without changing macOS grants.

Suggestions default to the CURRENT Fantastical calendar set. Confirm that it
contains the intended calendars, and recheck availability through the owning
Google/Microsoft connector before booking. A suggestion is not a reservation.

Activation requires the focused policy/override tests, backend suite/typecheck,
full `pnpm build`, then a controlled signed-host restart. Register only on the
intended namespaces. Verify one advertised tool, denied calls to forbidden names
through both MCP and OpenAPI, unchanged unrelated tool mappings, and one real
read-only suggestion request. Never test by creating a disposable event.

The September 9, 2026 live checks passed discovery and denial enforcement but
native suggestion calls exceeded the 15-second deadline. The new registration
was removed after setting both mappings INACTIVE, because global idle warming
can still launch a server with no active namespace. Inactive registration SQL
is preserved in `~/code/local/Backup/fantastical-suggestions-20260909-185959/`.
No booking was made and no native consent dialog was observed. Do not activate
based on discovery alone. Resolve the native response failure and confirm
calendar scope first.

Rollback the new server registration/mappings before reverting the guard, so
there is never an unrestricted native server. Preserve unrelated database work;
do not restore the full preflight dump over newer records.

## Node runtime

Node's official production recommendation is Active or Maintenance LTS. During INF-474, system Node 26.7.0 (Current) repeatedly crashed in built-in Undici HTTP/2 while the hosted Linear transport dropped. Official Node 26.8.1, which updates bundled Undici to 8.10.0, completed the accepted read-load sample without errors and became the current system runtime. Node 24 LTS remains installed keg-only for future comparison, not as an automatic fallback.

The crash came back on Node 26.8.2 (INF-589, about 280 restarts): the bundled Undici negotiates HTTP/2 with TLS servers such as `mcp.exa.ai`, and its HTTP/2 idle timeout emits an `error` (`UND_ERR_INFO`) on a stream with no listener, which exits the backend. Since 2026-10-05 the backend sets a global Undici dispatcher with `allowH2: false` before anything fetches (`apps/backend/src/lib/http-dispatcher.ts`, `undici` pinned to the version Node bundles), so outbound fetch stays on HTTP/1.1 whatever Node ships. When Node's bundled Undici moves a major version, move the pin with it.

## Logs

`run.sh` rotates `~/Library/Logs/metamcp.{out,err}.log` and the backend's `app.log` and `error.log` at startup once they pass 256 MB, keeping three gzip generations. Every writer appends, so copy-then-truncate loses nothing, and the 04:00 nightly restart makes it a daily check. `LOG_LEVEL=info` in `.env` is what makes them large.

## Rollback

The pre-host LaunchAgent, scripts, database dump, and responsibility evidence are under:

`~/code/local/Backup/metamcp-tcc-option3-20260829-180217/`

To roll back, boot out the host-based main job, restore the prior plist and scripts, bootstrap main/watchdog/nightly, and verify both health surfaces. This restores function but also restores the known self-responsible Node TCC behavior.
