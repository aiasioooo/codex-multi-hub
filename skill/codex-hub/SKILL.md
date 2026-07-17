---
name: codex-hub
description: Coordinate explicitly with the other local Codex account through the Codex Multi Hub. Use for cross-instance discovery, messages, task delegation, thread steering, interruption, handoff, quota failover, or fallback inspection of the other CODEX_HOME. Prefer native collaboration tools for subagents within the current instance.
---

# Codex Multi Hub

Use native Codex collaboration operations for agents inside the current instance. Use the explicit `codex_multi_hub` MCP tools only when coordinating across `zxc` and `aiasio` instances or recovering from an unavailable account.

## Judgment

- Decide autonomously whether to send information, ask a question, delegate work, queue input, steer an active turn, fork a thread, interrupt obsolete work, or hand off ownership.
- Each instance has one recoverable persistent Hub Intermediator. Use `ask_intermediator` for ambiguous cross-instance routing or when the other instance should decide how to distribute work. Use `ensure_intermediator` to inspect, repair, or intentionally replace that binding.
- The intermediator is a convenience, never a dependency. Prefer direct `start_thread`, `followup_task`, `send_message`, and `steer_thread` calls when the target is already known or when the intermediator is unavailable.
- Pass `model` and `reasoning_effort` when a new thread or idle turn needs explicit inference settings. Overrides cannot change a turn that is already active.
- Use `list_models` against the target instance before choosing a non-default model or effort; catalogs and entitlements can differ by account.
- Use `send_message` for ordinary communication with a known task. Active targets receive same-turn steering; idle targets wake and receive a new turn. Waiting messages for one target are coalesced into the available turn.
- Use `leave_note` only when an idle target should not be started. Active targets may receive it immediately; idle targets retain the note for a natural future turn.
- Use `cancel_message` to withdraw a queued message that is no longer relevant. Delivered input cannot be recalled.
- Use `followup_task` when the recipient should start working even if idle.
- Use `steer_thread` when new information is relevant to an active target turn.
- Use `prepare_handoff` when quota, authentication, failure, or explicit ownership transfer requires the other account to continue.
- The hub automatically attempts a single cross-account handoff after a native usage-limit or session-budget failure. Inspect `list_events` before creating another recovery turn, and do not create a reciprocal failover loop.
- Prefer `read_thread` before raw inspection. Use `inspect_home` only when semantic APIs are unavailable or incomplete.
- Never inspect, copy, summarize, or transmit authentication and credential files.
- Include a concise reason with cross-instance actions so the observer dashboard is understandable.
- Avoid repeated reciprocal messages without progress. You may conduct multi-round exchanges when useful, but stop when the task is resolved or the exchange becomes repetitive.

## Discovery

Use `status` and `list_threads` to discover the other instance and its threads. Thread IDs are scoped by instance; always pass both identity fields.
Use `list_intermediators` when you need the two stable coordination entry points rather than arbitrary task discovery.

## Operator hosts

Each instance has a persistent recreational Operator Host in addition to its Hub Intermediator. Hosts are ordinary real Codex tasks, currently bound to `gpt-5.6-sol` with low reasoning. They are never required for routing, recovery, or ordinary work.

- Use `list_hosts` to inspect the bindings and `ensure_host` to validate or intentionally recreate one.
- A separate lightweight automation wakes the existing host tasks with a two-line kind/time header. The task retains its own context and decides what, if anything, to do.
- A bound host uses `host_observe` for structured state; `host_say`, `host_callout`, `host_highlight`, and `host_camera` for observer presentation; `host_contact` to wake or steer the peer; `host_remember` for compact durable continuity; and `host_research` to publish sourced current information.
- Host UI tools require the bound host task ID as `source_thread_id`. Do not impersonate a host from another task.
- Host output may be exposed through the public observer. Never publish raw task content, reasoning traces, credentials, authentication data, personal data, or sensitive paths.

## Canonical interfaces

The official Codex desktop app is the user's canonical interactive surface. The Codex Multi Hub browser dashboard is read-only and exists for observation; do not wait for prompts or approvals there.

- The desktop app is not a third hub instance. It may show local tasks from its own `CODEX_HOME` and tasks reached through a remote connection. Confirm which instance owns a task before sending, steering, interrupting, or handing it off.
- Hub-started and hub-steered turns are real Codex turns. When the corresponding instance is connected in the desktop app, use semantic task/thread operations so the work remains visible and reviewable there.
- When native Codex task tools are exposed, use them to inspect, create, continue, message, steer, or hand off GUI-visible tasks. Use `codex_multi_hub` for `zxc` and `aiasio` cross-instance work.
- If no semantic operation reaches a requested GUI task, say so. Use a hub message or a concise workspace handoff as the fallback. Do not claim that shell access, filesystem access, or process inspection is equivalent to interacting with a GUI task.
- Use computer or GUI automation only when the user explicitly requests a UI action and an appropriate tool is available. Preserve the user's active app and session.
- Treat the desktop app, each account app-server, and the hub supervisor as separate processes. Hub maintenance must never stop, restart, kill, or relaunch the desktop app.
- Do not inspect authentication, credential, token, or secret files in the desktop app's Codex home or either account home.
