# Codex multi-account launcher

This project runs multiple Codex accounts without sharing authentication state. Each account receives an independent `CODEX_HOME` under:

```text
~/.codex-accounts/
├── zxc/
└── aiasio/
```

Credentials stay outside this project. Do not copy `auth.json` between account homes: each account should complete its own login so refresh tokens remain independent.

### GUI account-switch protection on Windows

Codex login and logout actively revoke the current OAuth refresh token before removing local credentials. If the official Windows GUI and a background account home belong to the same ChatGPT account, switching the GUI through **Log out** can therefore invalidate the background session even though its `CODEX_HOME` is separate.

The launcher provides an optional, reversible compatibility guard:

```powershell
.\codex-multi.ps1 gui-switch-protection status
.\codex-multi.ps1 gui-switch-protection enable
.\codex-multi.ps1 gui-switch-protection disable
```

When enabled, future Windows sessions point the GUI's best-effort revoke request at an unused loopback port. The GUI still removes its own local credentials, but the server-side refresh token is not revoked. Commands and app-servers launched through this project explicitly clear that override, so `zxc` and `aiasio` retain normal independent login/logout semantics.

This is an intentionally narrow workaround for account switching, not an official Codex setting. It takes effect after the next Windows sign-in or reboot. The tradeoff is security: logging out of the GUI no longer invalidates a refresh token that may exist elsewhere. Disable protection before a security-sensitive logout, or revoke sessions through the ChatGPT account security controls.

## Windows PowerShell

Initialize the two default account homes:

```powershell
.\codex-multi.ps1 init
```

Log in to each account separately:

```powershell
.\codex-multi.ps1 login zxc
.\codex-multi.ps1 login aiasio
```

Check both logins:

```powershell
.\codex-multi.ps1 status
```

Run them at the same time in separate terminals:

```powershell
# Terminal 1
.\codex-multi.ps1 zxc

# Terminal 2
.\codex-multi.ps1 aiasio
```

All remaining arguments are passed through to Codex:

```powershell
.\codex-multi.ps1 zxc --search
.\codex-multi.ps1 aiasio exec "summarize this repository"
```

Use separate clones or Git worktrees if both accounts will edit the same repository concurrently.

## Coordination hub

Install the explicit cross-account tools and start the local hub:

```powershell
.\codex-multi.ps1 hub-install
.\codex-multi.ps1 hub-open
```

Keep using the normal Codex app, CLI, or remote client as the canonical interface. The observer at `http://127.0.0.1:47831` is deliberately read-only. Its desktop and phone layouts show account connection health, live quota/reset windows, model and reasoning effort, pinned intermediators, active/idle tasks, cross-account traffic, and a click-through conversation inspector.

You can publish the observer through a tunnel or reverse proxy. Non-loopback requests use the hub login screen; localhost remains login-free. Set a password explicitly before the supervisor starts:

```powershell
$env:CODEX_HUB_PASSWORD = 'a-longer-password'
.\hub.ps1 restart
```

When started through `hub.ps1` without that environment variable, the launcher creates a random local password in the ignored `.hub/public-password.txt` file.

Each operator account receives a `codex_multi_hub` MCP server with explicit tools modeled on Codex's native task coordination operations. The desktop account also receives a neutral `gui` coordinator identity so canonical GUI tasks can inspect quota and route work directly without posing as either operator. The GUI identity cannot publish bound Operator Host actions or source-read itself through `prepare_handoff`; it sends a concise task brief or asks an operator to prepare that richer transfer.

The explicit coordination tools include:

- `send_message` steers an active task and wakes an idle task. Waiting messages for the same target are coalesced into one available turn.
- `leave_note` is the explicit non-waking mailbox operation; an idle target retains it until a natural future turn.
- `cancel_message` withdraws a note that is still queued; delivered input cannot be recalled.
- `followup_task` steers an active task or starts a turn on an idle task.
- `steer_thread` and `interrupt_thread` affect work already in progress.
- `start_thread`, `fork_thread`, `read_thread`, and `list_threads` manage cross-account context.
- `start_thread`, `fork_thread`, and idle-turn delivery accept explicit `model` and `reasoning_effort` overrides.
- `list_models` reads the target account's live model catalog and its supported reasoning efforts.
- `ensure_intermediator`, `list_intermediators`, and `ask_intermediator` provide one persistent coordination task per instance for ambiguous routing and richer local decisions.
- `prepare_handoff` transfers recent conversation and Git state to the other account.
- `inspect_home` is a last-resort read-only fallback when the other account cannot answer. Authentication, credential, token, secret, and private-key paths are always excluded.

If a desktop task predates the GUI MCP registration and its in-turn tool catalog is stale, it can still use the same configured MCP boundary through the filesystem-backed stdio adapter (not the raw HTTP API):

```powershell
$env:HUB_INSTANCE = 'gui'
'{}' | node .\src\hub-tool.mjs status -
```

Pass a JSON object on stdin for tools with arguments. A later desktop app start will load the registered MCP normally.

Coordination inside one Codex instance should continue to use its richer native task operations. The hub is for crossing the account boundary. If a turn fails with a usage-limit or session-budget error, the coordinator automatically starts a one-hop handoff on the other account; it will not bounce indefinitely if that account is also exhausted.

Intermediators are ordinary persistent, idle Codex tasks with durable developer instructions. Creation or recovery uses one minimal initialization turn so Codex commits the task to history; afterward it consumes no inference quota while idle. The hub stores only their current bindings, validates them on startup, and recreates a missing task lazily. Direct thread, message, steering, and handoff operations never depend on them, so losing or replacing an intermediator does not break the hub.

### Operator hosts

The observer also has two persistent recreational Operator Host tasks, one per account. They are separate from intermediators and never participate in critical routing. Both default to `gpt-5.6-sol` with low reasoning; their durable shared and individual identities live in `hosts/`.

`src/host-automation.mjs` is a separate low-overhead alarm clock. It reads private host-task bindings from environment variables or the ignored `.hub/host-bindings.json` file, checks that a target task is idle, and wakes that same persistent task with only this shape:

```text
[Host wake ambient_zxc]
ambient · 2026-01-01 13:30 Local/Time_Zone
```

There are no host sessions, turn/search leases, activation telemetry dumps, or repeated operational rules. The host's persistent developer instructions establish personality and authority once. After creation, one durable conversation prompt supplies its current task ID, peer ID, and automation controls. Stable hub and observer knowledge lives in the ID-free `nacchan-hub-navigation` and `nacchan-observer-stage` skills installed in both account homes.

Copy `host-bindings.example.json` to `.hub/host-bindings.json` and replace the placeholders locally, or set `CODEX_HOST_ZXC_THREAD_ID` and `CODEX_HOST_AIASIO_THREAD_ID`. The schedule uses the machine's local time zone by default: a lightly randomized ambient wake every 3-5 hours, a daily wake at 20:30, and a weekly wake on Sunday at 20:00. Starts normally alternate between hosts, with a 5% chance for the same host to initiate consecutive ambient wakes. Fixed wakes retry while their time window remains open. Hosts may inspect, edit, reschedule, stop, restart, replace, or extend the program themselves.

The explicit MCP surface includes `ensure_host`, `list_hosts`, `host_observe`, `host_say`, `host_callout`, `host_highlight`, `host_camera`, `host_contact`, `host_remember`, `host_research`, and `list_host_actions`. `host_contact` wakes an idle peer or steers an active peer. Host presentation is public and temporary; manual camera selection wins over host direction, and raw task text is never mirrored into the observer.

Host automation controls:

```powershell
.\host-automation.ps1 status
.\host-automation.ps1 start
.\host-automation.ps1 stop
.\host-automation.ps1 restart
.\host-automation.ps1 wake zxc manual
```

Hub lifecycle commands:

```powershell
.\codex-multi.ps1 hub-status
.\codex-multi.ps1 hub-start
.\codex-multi.ps1 hub-reload
.\codex-multi.ps1 hub-stop
```

The stable HTTP front door supervises two worker slots. Exactly one worker coordinates at a time; the other remains warm. `hub-reload` drains queue/failover work on the active slot, loads current code into the standby, health-checks it, switches traffic, and creates a fresh standby. If the active worker exits unexpectedly, the supervisor promotes the standby automatically. Neither path restarts the Codex desktop app or either account app-server.

Hub data stays local in `.hub/hub.sqlite`. The HTTP service, worker slots, and both app-server WebSockets bind to loopback only; `cloudflared` is the only public transport.

## Remote control

The native Codex Windows convenience command cannot manage its Unix-only daemon. This project works around that limitation by running the same app server on a loopback-only WebSocket and calling Codex's remote-control RPCs:

```powershell
.\codex-multi.ps1 remote-start zxc
.\codex-multi.ps1 remote-status zxc
.\codex-multi.ps1 remote-pair zxc
.\codex-multi.ps1 remote-stop zxc
```

The WebSocket binds only to `127.0.0.1`; the remote relay is handled by Codex. The workaround uses an experimental app-server transport, so re-run `remote-status` after Codex upgrades. Runtime state and logs stay inside the selected account's `CODEX_HOME`.

On Linux, macOS, or WSL, the launcher uses the CLI's built-in daemon commands:

```bash
chmod +x codex-multi.sh
./codex-multi.sh init
./codex-multi.sh login zxc
./codex-multi.sh login aiasio
./codex-multi.sh remote-start zxc
./codex-multi.sh remote-start aiasio
```

Each daemon uses its account's separate `CODEX_HOME`, preventing auth, socket, PID, and state collisions. If the installed CLI exposes manual pairing, pair each account independently:

```bash
./codex-multi.sh remote-pair zxc
./codex-multi.sh remote-pair aiasio
```

Run `doctor` to see the installed CLI version and whether `remote-control pair` is available:

```powershell
.\codex-multi.ps1 doctor
```

```bash
./codex-multi.sh doctor
```

## Custom account names or storage location

Initialize any account names you prefer:

```powershell
.\codex-multi.ps1 init client-a client-b
```

Override the account root before running the launcher:

```powershell
$env:CODEX_MULTI_HOME = 'D:\codex-accounts'
```

```bash
export CODEX_MULTI_HOME="$HOME/private/codex-accounts"
```
