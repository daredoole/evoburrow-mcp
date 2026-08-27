import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
const REGISTRY_FILE = "calibration-presets.json";
const STATUS_COMMANDS = ["SPPR ?", "PW?", "MV?", "MU?", "SI?", "MS?"];
const MODES = ["Flat", "Reference"];
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function confirmation(payload) {
  return sha(Buffer.from(JSON.stringify(payload))).slice(0, 20);
}
function textValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (html.match(new RegExp(`${escaped}:\\s*([^<]+)`, "i")) || [])[1]?.trim() || null;
}
function parseRun(html) {
  return { targetCurve: textValue(html, "targetCurve"), measurementFile: textValue(html, "measurementFile"), lowVolumeBassDb: Number(textValue(html, "lowVolListeningOffset")) || null, lowVolumeTrebleDb: Number(textValue(html, "lowVolListeningOffsetHi")) || null };
}
function calibrationSummary(data) {
  return { model: data.model || null, eqType: data.eqType || null, ampAssign: data.ampAssign || null, bassMode: data.bassMode || null, lpfForLfeHz: data.lpfForLFE ?? null, channels: (data.channels || []).map((c) => ({ id: c.commandId, crossoverHz: c.xover ?? null, distanceMeters: c.distanceInMeters ?? null, trimDb: c.trimAdjustmentInDbs ?? null, hasFlatFilter: Array.isArray(c.filter), hasReferenceFilter: Array.isArray(c.filterLV) })) };
}
function suggestedLabel(run, summary, file) {
  const curve = run.targetCurve?.replace(/\.txt$/i, "") || "A1 default";
  const xos = summary.channels.filter((x) => x.crossoverHz).map((x) => `${x.id}${x.crossoverHz}`).join("-");
  return `${curve} (${xos || basename(file, ".oca")})`;
}
async function scanCatalog(root) {
  const names = (await readdir(root)).filter((x) => extname(x).toLowerCase() === ".oca").sort(), items = [];
  for (const file of names) {
    const raw = await readFile(join(root, file)), data = JSON.parse(raw), htmlFile = file.replace(/\.oca$/i, ".html");
    let run = {};
    try {
      run = parseRun(await readFile(join(root, htmlFile), "utf8"));
    } catch {
    }
    const summary = calibrationSummary(data);
    items.push({ artifact: file, sha256: sha(raw), htmlFile, run, summary, suggestedLabel: suggestedLabel(run, summary, file) });
  }
  const groups = /* @__PURE__ */ new Map();
  for (const x of items) {
    const a = groups.get(x.sha256) || [];
    a.push(x.artifact);
    groups.set(x.sha256, a);
  }
  for (const x of items) x.duplicates = groups.get(x.sha256).filter((y) => y !== x.artifact);
  return items;
}
async function loadRegistry(root) {
  try {
    return JSON.parse(await readFile(join(root, REGISTRY_FILE), "utf8"));
  } catch {
    return { schemaVersion: 1, updatedAt: null, bindings: [] };
  }
}
async function saveRegistry(root, registry) {
  registry.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile(join(root, REGISTRY_FILE), JSON.stringify(registry, null, 2) + "\n", "utf8");
}
function bindingPlan(args, item) {
  return { device: { host: args.host, model: item.summary.model }, speakerPreset: args.speakerPreset, artifact: item.artifact, artifactSha256: item.sha256, label: args.label || item.suggestedLabel, audysseyCurve: args.audysseyCurve, intendedContent: args.intendedContent, status: args.status, verificationNote: args.verificationNote || null };
}
function firstState(lines) {
  const first = (re) => lines.find((x) => re.test(x)) || null;
  const volume = first(/^MV(?!MAX)\d/), preset = first(/^SPPR\s*[12]$/i), input = first(/^SI[A-Z0-9]/), mode = first(/^MS(?!QUICK)/), mute = first(/^MU(?:ON|OFF)$/), power = first(/^PW(?:ON|STANDBY)$/), dynamicEq = first(/^PSDYNEQ\s+(?:ON|OFF)$/), dynamicVolume = first(/^PSDYNVOL\s+/), multEq = first(/^PSMULTEQ/i), referenceLevel = first(/^PSREFLEV/i), lfe = first(/^PSLFE\s+/);
  return { power: power?.slice(2) || null, volumeRaw: volume, mute: mute?.slice(2) || null, input: input?.slice(2) || null, soundMode: mode?.slice(2) || null, speakerPreset: preset ? Number(preset.match(/[12]$/)[0]) : null, dynamicEq: dynamicEq?.split(/\s+/)[1] || null, dynamicVolume: dynamicVolume?.replace(/^PSDYNVOL\s+/i, "") || null, multEq: multEq?.replace(/^PSMULTEQ[:\s]*/i, "") || null, referenceLevel: referenceLevel?.replace(/^PSREFLEV[:\s]*/i, "") || null, lfeRaw: lfe };
}
async function sendSequence(tcpExchange, host, commands, port) {
  for (const command of commands) {
    await tcpExchange(host, [command], port, 2e3);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
function restoreCommands(state) {
  const out = ["MUON"];
  if (state.speakerPreset) out.push(`SPPR ${state.speakerPreset}`);
  if (state.input) out.push(`SI${state.input}`);
  if (state.volumeRaw) out.push(state.volumeRaw);
  if (state.soundMode) out.push(`MS${state.soundMode}`);
  if (state.dynamicEq) out.push(`PSDYNEQ ${state.dynamicEq}`);
  if (state.dynamicVolume) out.push(`PSDYNVOL ${state.dynamicVolume}`);
  out.push(state.mute === "ON" ? "MUON" : "MUOFF");
  return out;
}
function errorWrap(result, fn) {
  return async (a) => {
    try {
      return await fn(a);
    } catch (e) {
      return result({ error: e.message }, true);
    }
  };
}
function registerPresetTools(server, d) {
  const { z, result, resolveHome, tcpExchange, assertHost } = d;
  server.tool("calibration_preset_catalog", "Discover, hash, deduplicate, and describe generated A1 OCA calibrations without assigning device slots.", { home: z.string().optional() }, errorWrap(result, async ({ home }) => {
    const root = await resolveHome(home), items = await scanCatalog(root), registry = await loadRegistry(root);
    return result({ workspace: root, items, bindings: registry.bindings, rule: "An artifact is not considered installed in a Speaker Preset until explicitly bound after transfer." });
  }));
  server.tool("calibration_preset_propose_binding", "Propose binding one exact OCA artifact hash to Denon Speaker Preset 1 or 2; does not write or control the AVR.", { home: z.string().optional(), host: z.string(), artifact: z.string(), speakerPreset: z.union([z.literal(1), z.literal(2)]), label: z.string().min(2).max(100).optional(), audysseyCurve: z.enum(MODES).default("Flat"), intendedContent: z.enum(["general", "music", "movie", "low-volume", "testing"]).default("general"), status: z.enum(["planned", "user-confirmed"]).default("planned"), verificationNote: z.string().max(500).optional() }, errorWrap(result, async (args) => {
    assertHost(args.host);
    const root = await resolveHome(args.home), items = await scanCatalog(root), item = items.find((x) => x.artifact === args.artifact);
    if (!item) throw new Error("artifact was not found in the A1 workspace");
    if (args.status === "user-confirmed" && !args.verificationNote) throw new Error("user-confirmed bindings require a verification note describing when/how the OCA was transferred");
    const plan = bindingPlan(args, item);
    return result({ plan, confirmationToken: confirmation(plan), requiresConfirmation: true, deviceControl: false, warning: "This records coordination metadata only; it does not transfer or switch the AVR preset." });
  }));
  server.tool("calibration_preset_commit_binding", "Commit an exact proposed preset binding to the workspace registry. Requires matching token and confirm=true.", { home: z.string().optional(), host: z.string(), artifact: z.string(), speakerPreset: z.union([z.literal(1), z.literal(2)]), label: z.string().min(2).max(100).optional(), audysseyCurve: z.enum(MODES).default("Flat"), intendedContent: z.enum(["general", "music", "movie", "low-volume", "testing"]).default("general"), status: z.enum(["planned", "user-confirmed"]).default("planned"), verificationNote: z.string().max(500).optional(), confirmationToken: z.string(), confirm: z.boolean().default(false) }, errorWrap(result, async (args) => {
    assertHost(args.host);
    const root = await resolveHome(args.home), items = await scanCatalog(root), item = items.find((x) => x.artifact === args.artifact);
    if (!item) throw new Error("artifact was not found in the A1 workspace");
    if (args.status === "user-confirmed" && !args.verificationNote) throw new Error("user-confirmed bindings require a verification note");
    const plan = bindingPlan(args, item);
    if (!args.confirm || args.confirmationToken !== confirmation(plan)) throw new Error("confirmation missing or token does not match the exact binding");
    const registry = await loadRegistry(root);
    for (const old of registry.bindings) if (old.device.host === args.host && old.speakerPreset === args.speakerPreset && old.status !== "superseded") old.status = "superseded";
    registry.bindings.push({ ...plan, boundAt: (/* @__PURE__ */ new Date()).toISOString() });
    await saveRegistry(root, registry);
    return result({ committed: true, registry: join(root, REGISTRY_FILE), binding: registry.bindings.at(-1), supersededBindings: registry.bindings.filter((x) => x.status === "superseded").length });
  }));
  server.tool("calibration_preset_status", "Join the local calibration registry with read-only live AVR context, including the active Speaker Preset when supported.", { home: z.string().optional(), host: z.string(), port: z.number().int().min(1).max(65535).default(23) }, errorWrap(result, async ({ home, host, port }) => {
    assertHost(host);
    const root = await resolveHome(home), registry = await loadRegistry(root), lines = await tcpExchange(host, STATUS_COMMANDS, port, 3e3), match = lines.map((x) => x.match(/^SPPR\s*([12])$/i)).find(Boolean), active = match ? Number(match[1]) : null, bindings = registry.bindings.filter((x) => x.device.host === host && x.status !== "superseded");
    return result({ host, bindings, live: { raw: lines }, activeSpeakerPreset: active, activeBinding: active ? bindings.find((x) => x.speakerPreset === active) || null : null, verification: active ? "device-reported-via-SPPR-query" : "speaker-preset-query-unavailable", manualCheck: active ? null : "Report the AVR Speaker Preset without opening/editing Distances." });
  }));
  server.tool("denon_speaker_preset_audit", "Recall Denon Speaker Presets while muted, capture their Audyssey processing state, and restore the exact baseline.", { host: z.string(), port: z.number().int().min(1).max(65535).default(23), presets: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2).default([1, 2]), confirm: z.boolean().default(false) }, errorWrap(result, async ({ host, port, presets, confirm }) => {
    assertHost(host);
    const extended = STATUS_COMMANDS.concat(["PSDYNEQ ?", "PSDYNVOL ?", "PSMULTEQ ?", "PSREFLEV ?", "PSLFE ?"]);
    if (!confirm) return result({ audited: false, requiresConfirmation: true, presets, sequence: "snapshot → mute → recall each Speaker Preset → inspect Audyssey state → restore baseline" });
    const baseline = firstState(await tcpExchange(host, extended, port, 3500)), audits = [];
    try {
      await sendSequence(tcpExchange, host, ["MUON"], port);
      for (const preset of presets) {
        await sendSequence(tcpExchange, host, [`SPPR ${preset}`, "MUON"], port);
        const lines = await tcpExchange(host, ["SPPR ?", ...extended], port, 3500);
        audits.push({ preset, state: firstState(lines), raw: lines });
      }
    } finally {
      await sendSequence(tcpExchange, host, restoreCommands(baseline), port);
    }
    const restored = firstState(await tcpExchange(host, ["SPPR ?", ...extended], port, 3500));
    return result({ audited: true, baseline, audits, restored, restoreVerified: JSON.stringify(restored) === JSON.stringify(baseline) });
  }));
  server.tool("denon_quick_select_audit", "Safely recall selected Denon Quick Select slots while muted, capture their state, and restore the exact baseline. State-changing recalls require explicit confirmation.", { host: z.string(), port: z.number().int().min(1).max(65535).default(23), slots: z.array(z.number().int().min(1).max(4)).min(1).max(4).default([1, 2, 3, 4]), confirmRecall: z.boolean().default(false), home: z.string().optional(), confirmRecord: z.boolean().default(false) }, errorWrap(result, async ({ host, port, slots, confirmRecall, home, confirmRecord }) => {
    assertHost(host);
    if (!confirmRecall) return result({ audited: false, requiresConfirmation: true, slots, sequence: "snapshot \u2192 mute \u2192 recall each slot \u2192 inspect \u2192 restore baseline", warning: "Quick Select recall can change input, volume, sound mode, and Speaker Preset." });
    const baselineLines = await tcpExchange(host, STATUS_COMMANDS.concat(["PSDYNEQ ?", "PSDYNVOL ?"]), port, 3500), baseline = firstState(baselineLines), audits = [];
    try {
      for (const slot of slots) {
        await tcpExchange(host, ["MUON", `MSQUICK${slot}`], port, 3500);
        await tcpExchange(host, ["MUON"], port, 1500);
        const lines = await tcpExchange(host, STATUS_COMMANDS.concat(["PSDYNEQ ?", "PSDYNVOL ?", "PSLFE ?"]), port, 3500);
        audits.push({ slot, state: firstState(lines), raw: lines });
      }
    } finally {
      await tcpExchange(host, restoreCommands(baseline), port, 4e3);
    }
    const restoredLines = await tcpExchange(host, STATUS_COMMANDS.concat(["PSDYNEQ ?", "PSDYNVOL ?"]), port, 3500), restored = firstState(restoredLines), restoreVerified = JSON.stringify(restored) === JSON.stringify(baseline);
    let recorded = null;
    if (confirmRecord) {
      const root = await resolveHome(home), registry = await loadRegistry(root);
      registry.quickSelectAudits = registry.quickSelectAudits || [];
      registry.quickSelectAudits.push({ host, auditedAt: (/* @__PURE__ */ new Date()).toISOString(), baseline, audits: audits.map((x) => ({ slot: x.slot, state: x.state })), restoreVerified });
      await saveRegistry(root, registry);
      recorded = join(root, REGISTRY_FILE);
    }
    return result({ audited: true, baseline, audits, restored, restoreVerified, recorded });
  }));
}
const presetInternals = { parseRun, calibrationSummary, suggestedLabel, confirmation, bindingPlan, firstState, restoreCommands };
export {
  presetInternals,
  registerPresetTools,
  scanCatalog
};
