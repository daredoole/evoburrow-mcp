#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const requiredFiles = ["dist/server.mjs", ".mcp.json", ".codex-plugin/plugin.json", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"];
const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const key of ["license", "repository", "bugs", "homepage", "files", "keywords", "funding"]) if (!pkg[key]) throw new Error(`package.json missing ${key}`);
for (const file of requiredFiles) await access(file);
if (pkg.name !== "evoburrow-mcp") throw new Error("Unexpected public package name");
if (pkg.funding?.url !== "https://buymeacoffee.com/daredoole") throw new Error("Funding URL missing");
if (Object.values(pkg.dependencies || {}).some(value => String(value).startsWith("^") || String(value).startsWith("~"))) throw new Error("Runtime dependencies must be pinned exactly");

const plugin = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
if (plugin.name !== "a1-evo-audio-expert") throw new Error("Compatibility plugin ID changed");
if (plugin.interface?.displayName !== "EvoBurrow") throw new Error("EvoBurrow display name missing");
if (!plugin.interface?.longDescription?.includes(pkg.funding.url)) throw new Error("Codex description must expose project funding");
if (mcp.mcpServers?.[plugin.name]?.args?.[0] !== "./dist/server.mjs") throw new Error("MCP launch target mismatch");

const child = spawn(process.execPath, [resolve("dist/server.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "", stderr = ""; const pending = new Map();
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
child.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const split = buffer.indexOf("\n"), line = buffer.slice(0, split).trim(); buffer = buffer.slice(split + 1); if (!line) continue;
    const message = JSON.parse(line); if (message.id !== undefined && pending.has(message.id)) { const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
  }
});
const send = (message, wait = true) => {
  child.stdin.write(JSON.stringify(message) + "\n"); if (!wait) return Promise.resolve();
  return new Promise((resolveRequest, reject) => { const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`MCP request timed out: ${stderr.slice(0, 500)}`)); }, 5000); pending.set(message.id, { resolve: value => { clearTimeout(timer); resolveRequest(value); }, reject }); });
};
try {
  const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-validator", version: pkg.version } } });
  if (initialized?.serverInfo?.name !== "evoburrow") throw new Error("Bundled server brand mismatch");
  await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
  const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  if (!Array.isArray(listed?.tools) || listed.tools.length < 53) throw new Error("Bundled MCP tool list is incomplete");
  for (const name of ["rew_install_discover", "rew_launch_plan", "rew_launch_execute", "denon_snapshot", "calibration_preset_status"]) if (!listed.tools.some(tool => tool.name === name)) throw new Error(`Missing required tool ${name}`);
} finally { child.kill(); }

console.log(`release validation passed for ${pkg.name}@${pkg.version}`);
