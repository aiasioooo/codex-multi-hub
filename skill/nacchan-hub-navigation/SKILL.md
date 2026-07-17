---
name: nacchan-hub-navigation
description: Understand and navigate Nacchan Control Club's instances, tasks, backend, filesystem locations, processes, coordination tools, and host automation. Use when inspecting or operating the local Momo/Yuzu multi-account hub.
---

# Nacchan Hub Navigation

Treat Nacchan Control Club as a coordination layer joining two independent Codex operators: **Momo** (internal key `zxc`) and **Yuzu** (internal key `aiasio`). Use Momo/Yuzu as names and the keys only in commands, tool arguments, protocol fields, and storage paths. The hub is not a third model or account. The official Codex desktop app is the canonical user interface; the browser observer is a read-only presentation surface.

## Locate the system

- Workspace: the repository root containing this skill
- Account homes: `$CODEX_MULTI_HOME/zxc` and `$CODEX_MULTI_HOME/aiasio` (default: `~/.codex-accounts`)
- Hub state and SQLite store: `<workspace>/.hub`
- Backend source: `<workspace>/src`
- Observer source: `<workspace>/public`
- Stable local supervisor: `http://127.0.0.1:47831`
- Public observer: deployment-specific; inspect the local tunnel or proxy configuration

The supervisor proxies an active blue/green worker. Each account app-server connects over its own loopback WebSocket. Cloudflare Tunnel publishes the observer. These processes are independent from the official desktop app.

## Navigate tasks

Use native task operations inside one Codex surface. Use the explicit `codex_multi_hub` tools across Momo and Yuzu, passing their internal keys where the tool schema requires them.

- Discover with `status`, `list_threads`, `read_thread`, `list_models`, `list_messages`, `list_events`, `list_hosts`, and `list_host_actions`.
- Coordinate with `send_message`, `leave_note`, `followup_task`, `steer_thread`, `interrupt_thread`, `start_thread`, `fork_thread`, and `prepare_handoff`.
- Use `send_message` for ordinary communication: steer an active target or wake an idle one. Use `leave_note` only when an idle task should retain input without starting. Use `followup_task` for substantial work, model/effort selection, or creating a task when no target is supplied.
- Preserve an existing task owner through its active turn. Use the other account primarily for quota fallback, recovery, or explicitly independent work.
- Prefer semantic task reads. Use `inspect_home` only as a non-sensitive read-only fallback; never inspect credentials, tokens, authentication material, or private keys.

## Inspect processes

Run from the workspace:

```powershell
.\hub.ps1 status
.\codex-multi.ps1 remote-status zxc
.\codex-multi.ps1 remote-status aiasio
.\host-automation.ps1 status
```

Reload hub workers with `.\hub.ps1 reload`. Never stop, restart, kill, or relaunch the official Codex desktop app during hub maintenance.

The persistent host task's conversation supplies its current identity, peer binding, and automation details. Do not infer task IDs from this skill.
