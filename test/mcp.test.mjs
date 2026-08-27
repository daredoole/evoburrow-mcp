import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

test("bundled MCP lists tools and scans the configured workspace", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve("dist/server.mjs")],
    env: { ...process.env, A1_EVO_HOME: resolve("test/fixtures") }
  });
  const client = new Client({ name: "a1-evo-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.length >= 17);
    assert.ok(listed.tools.some((tool) => tool.name === "denon_control"));
    assert.ok(listed.tools.some((tool) => tool.name === "a1_measurement_quality"));
    assert.ok(listed.tools.some((tool) => tool.name === "speaker_layout_validate"));
    const scanned = await client.callTool({ name: "a1_workspace_scan", arguments: {} });
    const body = JSON.parse(scanned.content[0].text);
    assert.ok(body.files.some((file) => file.name.endsWith(".ady")));
    const quality = await client.callTool({ name: "a1_measurement_quality", arguments: { file: "measurements.ady" } });
    const qualityBody = JSON.parse(quality.content[0].text);
    assert.ok(Number.isFinite(qualityBody.overallScore));
    const claims = await client.callTool({ name: "audio_claims", arguments: { model: "X1800H", minimumConfidence: "high" } });
    assert.ok(JSON.parse(claims.content[0].text).count >= 2);
    const mimo = await client.callTool({ name: "audio_claims", arguments: { topic: "MIMO", minimumConfidence: "medium" } });
    assert.ok(JSON.parse(mimo.content[0].text).claims.some((claim) => claim.id === "a1-mimo-combined-response"));
    const transcript = await client.callTool({ name: "audio_knowledge_search", arguments: { query: "manual time alignment upfiring reflection" } });
    assert.ok(JSON.parse(transcript.content[0].text).hits.some((hit) => hit.source === "a1-developer-transcript.md"));
  } finally {
    await client.close();
  }
});
