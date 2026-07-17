# Codex Multi Hub

This repository contains a local coordination hub for two independent Codex account instances. It is source-only: credentials, account homes, task history, messages, quota snapshots, service state, and deployment secrets must remain outside Git.

If `AGENTS.local.md` exists, read it after this file. It contains deployment-specific instructions for this machine and is intentionally ignored by Git. Never copy private values from that file into commits, issues, logs, screenshots, or public observer output.

## System model

- The operator names are **Momo** and **Yuzu**. Never present their internal keys as character or operator names.
- Their internal instance IDs are `zxc` (Momo) and `aiasio` (Yuzu). They have separate `CODEX_HOME` directories, authentication, app servers, tasks, and quota pools. Keep those keys stable in protocols, storage, CSS hooks, automation bindings, and tool arguments.
- The hub is a coordinator, not another model or account. It discovers tasks, relays messages, starts or steers turns, supports handoffs, and exposes live state to an observer.
- The official Codex app or CLI remains the canonical interactive surface. The browser observer is read-only.
- A stable supervisor runs blue/green hub workers so source and static UI changes can reload without restarting either account app server or the Codex desktop app.
- Persistent Intermediator tasks help with ambiguous routing. Persistent Operator Host tasks provide optional recreational speech and UI presentation. Neither role is required for core coordination.
- `ui-demo-vercel/` is a UI-only simulated deployment. It must never connect to real account homes, task stores, or live hub data.

## Repository map

- `src/` — hub, supervisor, storage, observer projection, MCP tools, and host automation.
- `public/` — live read-only observer UI.
- `ui-demo-vercel/` — ignored local deployment copy for the simulated public showcase.
- `test/` — Node test suite.
- `hosts/` — durable Operator Host personality prompts.
- `skill/` — installable hub and observer skills.
- `codex-multi.ps1`, `codex-multi.sh` — account launchers.
- `hub.ps1`, `host-automation.ps1` — local service controls.

## Development rules

- Never commit authentication files, tokens, passwords, private keys, account homes, SQLite files, logs, task IDs, task content, generated runtime state, local absolute paths, or tunnel configuration.
- Preserve the `zxc` and `aiasio` internal identifiers unless intentionally performing a full protocol and data migration.
- Keep public aliases centralized in the observer presentation layer.
- Treat quota as live only after a successful semantic rate-limit read. Clearly distinguish stale or unavailable telemetry.
- Do not make the browser observer a prompt, approval, or consequential control surface.
- Do not stop, kill, restart, or relaunch the official Codex desktop app during hub maintenance.
- Prefer `hub.ps1 reload` for live source or static-asset updates when the supervisor is already healthy.
- Keep the Vercel demo synthetic. Simulated tasks, messages, quotas, and host actions should be obviously fictional and contain no copied production data.

## Verification

Run before committing:

```powershell
npm run check
npm test
```

For live local changes, also verify:

```powershell
.\hub.ps1 status
.\codex-multi.ps1 remote-status zxc
.\codex-multi.ps1 remote-status aiasio
```

UI changes should be checked at desktop and phone breakpoints, with console errors inspected and the read-only boundary preserved.
