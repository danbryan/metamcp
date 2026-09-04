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

## Node runtime

Node's official production recommendation is Active or Maintenance LTS. During INF-474, system Node 26.7.0 (Current) repeatedly crashed in built-in Undici HTTP/2 while the hosted Linear transport dropped. Official Node 26.8.1, which updates bundled Undici to 8.10.0, completed the accepted read-load sample without errors and became the current system runtime. Node 24 LTS remains installed keg-only for future comparison, not as an automatic fallback.

## Rollback

The pre-host LaunchAgent, scripts, database dump, and responsibility evidence are under:

`~/code/local/Backup/metamcp-tcc-option3-20260829-180217/`

To roll back, boot out the host-based main job, restore the prior plist and scripts, bootstrap main/watchdog/nightly, and verify both health surfaces. This restores function but also restores the known self-responsible Node TCC behavior.
