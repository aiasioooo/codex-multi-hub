import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertHubSource } from "./config.mjs";

function usage() {
  return "Usage: HUB_INSTANCE=gui node src/hub-tool.mjs <tool-name> [json-arguments|-]";
}

const [toolName, rawArguments = "{}"] = process.argv.slice(2);
if (!toolName) throw new Error(usage());

const source = assertHubSource(process.env.HUB_INSTANCE || "");
const input = rawArguments === "-"
  ? await new Promise((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
      process.stdin.on("error", reject);
    })
  : rawArguments;
const args = JSON.parse(input || "{}");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./mcp.mjs", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")],
  env: { ...process.env, HUB_INSTANCE: source },
});
const client = new Client({ name: "codex-multi-hub-tool", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: toolName, arguments: args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
