import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertHubSource, hubBaseUrl } from "./config.mjs";

const sourceInstance = assertHubSource(process.env.HUB_INSTANCE || "");

const tools = [
  {
    name: "status",
    description: "Read the federated status of both Codex instances, their recent threads, messages, and events.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_threads",
    description: "List threads from one or both Codex instances. Use native collaboration tools for agents inside your own live tree; use this for cross-instance discovery.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_thread",
    description: "Read a thread semantically through the selected instance's app server, including persisted turns when requested.",
    inputSchema: {
      type: "object",
      required: ["instance", "thread_id"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        thread_id: { type: "string" },
        include_turns: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    description: "List the target account's live Codex model catalog, including each model's supported reasoning efforts and default effort. Use this before requesting a non-default model.",
    inputSchema: {
      type: "object",
      required: ["instance"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        include_hidden: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_thread",
    description: "Create a thread directly in either Codex instance and optionally start its first turn. Model and reasoning overrides are sticky for subsequent turns. This path does not depend on the intermediator.",
    inputSchema: {
      type: "object",
      required: ["instance"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        message: { type: "string" },
        cwd: { type: "string" },
        ephemeral: { type: "boolean", default: false },
        model: { type: "string", minLength: 1 },
        reasoning_effort: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "fork_thread",
    description: "Fork an existing thread within its own instance, preserving its history, then optionally start a follow-up turn.",
    inputSchema: {
      type: "object",
      required: ["instance", "thread_id"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        thread_id: { type: "string" },
        message: { type: "string" },
        cwd: { type: "string" },
        ephemeral: { type: "boolean", default: false },
        model: { type: "string", minLength: 1 },
        reasoning_effort: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ensure_intermediator",
    description: "Return the persistent Hub Intermediator for an instance, lazily creating or repairing its ordinary Codex thread. Creation uses one minimal initialization turn so the task is durably saved; recreate only when intentionally replacing the current binding.",
    inputSchema: {
      type: "object",
      required: ["instance"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        model: { type: "string", minLength: 1, description: "Default model for future requests sent through this intermediator." },
        reasoning_effort: { type: "string", minLength: 1, description: "Default reasoning effort for future requests sent through this intermediator." },
        recreate: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_intermediators",
    description: "List both persistent intermediator bindings and validate whether their underlying Codex threads remain available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_intermediator",
    description: "Ask the other instance's persistent intermediator to make a coordination decision or perform routing. It is a convenience path; use direct thread and messaging tools whenever they are more precise or if this path is unavailable.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "message"],
      properties: {
        source_thread_id: { type: "string" },
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        message: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string", enum: ["normal", "high", "urgent"], default: "normal" },
        model: { type: "string", minLength: 1 },
        reasoning_effort: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ensure_host",
    description: "Return an instance's persistent Nacchan Operator Host task, lazily creating or repairing it from the durable persona profile. Use recreate only to intentionally replace the current host task.",
    inputSchema: {
      type: "object",
      required: ["instance"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        model: { type: "string", minLength: 1, default: "gpt-5.6-sol" },
        reasoning_effort: { type: "string", minLength: 1, default: "low" },
        recreate: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_hosts",
    description: "List and validate both persistent Operator Host bindings, their task IDs, model, effort, and availability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "host_observe",
    description: "Read compact live hub state, automation state, UI target registry, recent host actions, and durable relationship continuity. Only the bound host task may call this tool.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id"],
      properties: {
        source_thread_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_say",
    description: "Publish one short line in your own operator speech bubble. This is public observer content; never publish raw reasoning or private task material.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "text"],
      properties: {
        source_thread_id: { type: "string" },
        text: { type: "string", minLength: 1, maxLength: 280 },
        tone: { type: "string", enum: ["playful", "smug", "dry", "calm", "warm", "serious", "curious", "research"], default: "playful" },
        ttl_seconds: { type: "integer", minimum: 3, maximum: 180, default: 18 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_callout",
    description: "Attach a short public bubble or note to a semantic observer component. The hub handles responsive placement and expiration.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "target", "text"],
      properties: {
        source_thread_id: { type: "string" },
        target: { type: "string", enum: ["camera.scene", "service.status", "theme.palette", "relay.traffic", "activity.timeline", "operator.zxc.scene", "operator.aiasio.scene", "operator.zxc.card", "operator.aiasio.card", "operator.zxc.quota", "operator.aiasio.quota", "operator.zxc.missions", "operator.aiasio.missions"] },
        text: { type: "string", minLength: 1, maxLength: 220 },
        color: { type: "string", enum: ["mint", "violet", "pink", "peach", "lemon", "cyan", "neutral", "danger"] },
        style: { type: "string", enum: ["bubble", "thought", "note"], default: "bubble" },
        ttl_seconds: { type: "integer", minimum: 3, maximum: 180, default: 16 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_highlight",
    description: "Temporarily emphasize a semantic observer component with a palette-aware visual treatment.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "target"],
      properties: {
        source_thread_id: { type: "string" },
        target: { type: "string", enum: ["camera.scene", "service.status", "theme.palette", "relay.traffic", "activity.timeline", "operator.zxc.scene", "operator.aiasio.scene", "operator.zxc.card", "operator.aiasio.card", "operator.zxc.quota", "operator.aiasio.quota", "operator.zxc.missions", "operator.aiasio.missions"] },
        color: { type: "string", enum: ["mint", "violet", "pink", "peach", "lemon", "cyan", "neutral", "danger"] },
        style: { type: "string", enum: ["glow", "pulse", "outline", "spotlight", "sparkle"], default: "glow" },
        ttl_seconds: { type: "integer", minimum: 3, maximum: 180, default: 14 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_camera",
    description: "Request temporary camera focus. Recent manual viewer camera input always takes priority.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "target"],
      properties: {
        source_thread_id: { type: "string" },
        target: { type: "string", enum: ["zxc", "aiasio", "hub"] },
        ttl_seconds: { type: "integer", minimum: 3, maximum: 60, default: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_contact",
    description: "Wake an idle peer host or steer an active peer host with a concise message. Each host writes only its own dialogue.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "message"],
      properties: {
        source_thread_id: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: 1200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_remember",
    description: "Save one compact durable relationship fact, callback, preference, or running bit used to recreate host continuity after task loss.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "text"],
      properties: {
        source_thread_id: { type: "string" },
        kind: { type: "string", enum: ["memory", "callback", "preference", "ritual", "relationship"], default: "memory" },
        text: { type: "string", minLength: 1, maxLength: 600 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "host_research",
    description: "Publish a sourced public research card after using available internet research tools.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "title", "summary", "sources"],
      properties: {
        source_thread_id: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        summary: { type: "string", minLength: 1, maxLength: 600 },
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            required: ["url"],
            properties: {
              title: { type: "string", maxLength: 120 },
              url: { type: "string", minLength: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_host_actions",
    description: "Inspect recent public host speech, callouts, highlights, camera requests, and sourced research cards.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description: "Send information to a known thread. Active targets are steered immediately; idle targets are woken so the message is delivered in a new turn.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "target_thread_id", "message"],
      properties: {
        source_thread_id: { type: "string", description: "Your current thread id when known." },
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        message: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string", enum: ["normal", "high", "urgent"], default: "normal" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "leave_note",
    description: "Leave durable information for a known thread without waking it. An active target may receive it immediately; an idle target retains it until a later natural turn.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "target_thread_id", "message"],
      properties: {
        source_thread_id: { type: "string", description: "Your current thread id when known." },
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        message: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string", enum: ["normal", "high", "urgent"], default: "normal" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "followup_task",
    description: "Deliver work to the other instance and trigger a turn if the target is idle. If target_thread_id is omitted, create a new target thread.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "message"],
      properties: {
        source_thread_id: { type: "string" },
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        message: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string", enum: ["normal", "high", "urgent"], default: "normal" },
        cwd: { type: "string", description: "Working directory when a new target thread must be created." },
        model: { type: "string", minLength: 1, description: "Applied when this starts a new idle turn; an already-active turn keeps its current model." },
        reasoning_effort: { type: "string", minLength: 1, description: "Applied when this starts a new idle turn; an already-active turn keeps its current effort." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_message",
    description: "Cancel a message that is still queued for an idle target thread. Delivered messages cannot be recalled.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "steer_thread",
    description: "Steer an active thread in the other instance using Codex turn/steer. By default, queue the input when the target is idle.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "target_thread_id", "message"],
      properties: {
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        message: { type: "string" },
        reason: { type: "string" },
        queue_if_idle: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "interrupt_thread",
    description: "Interrupt the currently active turn in a target thread while keeping the thread available for later work.",
    inputSchema: {
      type: "object",
      required: ["target_instance", "target_thread_id"],
      properties: {
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prepare_handoff",
    description: "Transfer a task to the other instance. Read the source thread, capture recent conversation and Git state, then start or continue a target thread with the recovery context.",
    inputSchema: {
      type: "object",
      required: ["source_thread_id", "target_instance", "instruction"],
      properties: {
        source_thread_id: { type: "string" },
        target_instance: { type: "string", enum: ["zxc", "aiasio"] },
        target_thread_id: { type: "string" },
        instruction: { type: "string" },
        cwd: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_home",
    description: "Fallback inspection of another instance's CODEX_HOME when semantic APIs are unavailable or insufficient. Authentication and credential files are always excluded.",
    inputSchema: {
      type: "object",
      required: ["instance"],
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        relative_path: { type: "string", default: "sessions" },
        max_bytes: { type: "integer", minimum: 1, maximum: 256000, default: 64000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_messages",
    description: "Inspect queued and delivered hub messages for coordination and recovery.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["zxc", "aiasio"] },
        thread_id: { type: "string" },
        state: { type: "string", enum: ["queued", "delivered", "failed", "canceled"] },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description: "Read the hub's recent cross-instance and app-server event log.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      additionalProperties: false,
    },
  },
];

async function callHub(name, args) {
  const response = await fetch(`${hubBaseUrl}/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-instance": sourceInstance },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(90_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Hub returned HTTP ${response.status}`);
  return value.result;
}

const server = new Server(
  { name: `codex-multi-hub-${sourceInstance}`, version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await callHub(request.params.name, request.params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: { result },
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
