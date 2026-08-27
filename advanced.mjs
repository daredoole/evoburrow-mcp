import { readFile, writeFile, readdir, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
const REW_BASE = process.env.A1_REW_URL || "http://127.0.0.1:4735";
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(REW_BASE)) throw new Error("A1_REW_URL must use HTTP on localhost");
const STATUS_COMMANDS = ["PW?", "MV?", "MU?", "SI?", "MS?", "SV?"];
const WRITE_ACTIONS = { power_on: "PWON", power_standby: "PWSTANDBY", mute_on: "MUON", mute_off: "MUOFF" };
const ROLE_ALIASES = { FL: "front_left", FR: "front_right", C: "center", SL: "surround_left", SR: "surround_right", SBL: "surround_back_left", SBR: "surround_back_right", TFL: "top_front_left", TFR: "top_front_right", TRL: "top_rear_left", TRR: "top_rear_right", SW1: "subwoofer_1", SW2: "subwoofer_2", SW3: "subwoofer_3", SW4: "subwoofer_4" };
function err(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }], isError: true };
    }
  };
}
function median(a) {
  const x = a.filter(Number.isFinite).sort((a2, b) => a2 - b);
  return x.length ? x[Math.floor(x.length / 2)] : null;
}
function percentile(a, p) {
  const x = a.filter(Number.isFinite).sort((a2, b) => a2 - b);
  return x.length ? x[Math.min(x.length - 1, Math.max(0, Math.round((x.length - 1) * p)))] : null;
}
function parseSeries(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (text.length >= 16 && !/[\s,;]/.test(text) && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length % 4 === 0) {
      const out = [];
      for (let i = 0; i < bytes.length; i += 4) out.push(bytes.readFloatBE(i));
      return out.filter(Number.isFinite);
    }
  }
  return text.split(/[\s,;]+/).map(Number).filter(Number.isFinite);
}
function frequencies(trace, n) {
  if (Array.isArray(trace.frequency)) return trace.frequency.map(Number);
  if (trace.ppo && trace.startFreq) return Array.from({ length: n }, (_, i) => trace.startFreq * 2 ** (i / trace.ppo));
  return Array.from({ length: n }, (_, i) => (trace.startFreq || 0) + i * (trace.freqStep || 1));
}
function interp(xs, ys, x) {
  if (!xs.length || x < xs[0] || x > xs.at(-1)) return null;
  let hi = 1;
  while (hi < xs.length && xs[hi] < x) hi++;
  const lo = hi - 1, t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
function unwrap(deg) {
  if (!deg.length) return [];
  const out = [deg[0]];
  for (let i = 1; i < deg.length; i++) {
    let v = deg[i];
    while (v - out[i - 1] > 180) v -= 360;
    while (v - out[i - 1] < -180) v += 360;
    out.push(v);
  }
  return out;
}
function circularDelta(a, b) {
  return (a - b + 540) % 360 - 180;
}
function token(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
}
function unsignedPlan(plan) {
  const { confirmationToken, ...unsigned } = plan;
  return unsigned;
}
function measurementEntries(value) {
  return Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value || {});
}
async function waitForSingleNewMeasurement(before, timeoutMs = 45e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = measurementEntries(await rew("/measurements"));
    const fresh = after.filter(([id]) => !before.has(id));
    if (fresh.length === 1) return fresh[0];
    if (fresh.length > 1) throw new Error(`expected one new REW measurement, found ${fresh.length}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("REW measurement did not produce a trace within 45 seconds");
}
async function setAndVerifyRewValue(path, body, timeoutMs = 5e3) {
  await rew(path, { method: "POST", body });
  const deadline = Date.now() + timeoutMs;
  let consecutiveMatches = 0;
  while (Date.now() < deadline) {
    if (JSON.stringify(await rew(path)) === JSON.stringify(body)) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= 4) return;
    } else {
      consecutiveMatches = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`REW did not apply ${path}=${JSON.stringify(body)}`);
}
function denonVolume(db) {
  const n = Math.round((Number(db) + 80) * 2) / 2;
  if (!Number.isFinite(n) || n < 0 || n > 98) throw new Error("AVR volume must be between -80 and +18 dB");
  return `MV${String(Math.floor(n)).padStart(2, "0")}${Number.isInteger(n) ? "" : "5"}`;
}
function safeProtection(current, maxSplDb) {
  const out = { ...current && typeof current === "object" ? current : {} };
  let clippingGuard = false;
  for (const key of Object.keys(out)) {
    if (/clip/i.test(key) && typeof out[key] === "boolean") {
      out[key] = true;
      clippingGuard = true;
    }
    if (/spl/i.test(key) && /(limit|max)/i.test(key) && typeof out[key] === "number") out[key] = maxSplDb;
    if (/spl/i.test(key) && /(abort|protect|enable)/i.test(key) && typeof out[key] === "boolean") out[key] = true;
  }
  return { options: out, clippingGuard };
}
async function rewAudioSnapshot() {
  const status = await rew("/audio/status"), configuration = await rew("/audio/configuration"), driver = await rew("/audio/driver"), sampleRate = await rew("/audio/samplerate"), inputCal = await rew("/audio/input-cal");
  const driverName = typeof driver === "string" ? driver : driver?.driver;
  const family = String(driverName).toLowerCase().includes("asio") ? "asio" : "java", base = `/audio/${family}`;
  const paths = family === "asio" ? ["device", "devices", "input", "inputs", "output", "outputs"] : ["input-device", "input-devices", "input", "inputs", "output-device", "output-devices", "output", "outputs", "input-channel", "num-input-channels", "output-channel", "output-channels"];
  const settings = {};
  for (const p of paths) {
    try {
      settings[p] = await rew(`${base}/${p}`);
    } catch (error) {
      settings[p] = { unavailable: error.message };
    }
  }
  return { status, configuration, driver, driverName, family, sampleRate, inputCal, settings };
}
async function rewMeasureSnapshot() {
  const paths = ["/measure/commands", "/measure/sweep/configuration", "/measure/sweep/repetitions", "/measure/level", "/measure/protection-options", "/measure/naming", "/measure/notes", "/measure/timing/reference", "/measure/sequential-channels"];
  const out = {};
  for (const p of paths) {
    try {
      out[p] = await rew(p);
    } catch (error) {
      out[p] = { unavailable: error.message };
    }
  }
  return out;
}
function planWithToken(unsigned) {
  return { ...unsigned, confirmationToken: token(unsigned) };
}
function decodeVolume(raw) {
  const s = raw.slice(2);
  if (!/^\d{2,3}$/.test(s)) return null;
  const tenths = s.length === 3 && s.endsWith("5") ? Number(s.slice(0, 2)) + 0.5 : Number(s);
  return { relativeDb: tenths - 80, display: tenths - 80 === 0 ? "0.0 dB" : `${tenths - 80 > 0 ? "+" : ""}${(tenths - 80).toFixed(1)} dB` };
}
function decodeDenonLine(raw) {
  const line = String(raw).trim();
  if (/^MV\d/.test(line)) return { raw, field: "masterVolume", ...decodeVolume(line) };
  if (/^PW/.test(line)) return { raw, field: "power", value: line.slice(2) === "ON" ? "on" : "standby" };
  if (/^MU/.test(line)) return { raw, field: "mute", value: line.slice(2) === "ON" };
  if (/^SI/.test(line)) return { raw, field: "input", value: line.slice(2).trim() };
  if (/^MS/.test(line)) {
    const v = line.slice(2).trim();
    return { raw, field: "soundMode", value: v, codec: v.split(/[- ]/)[0] || v, upmixer: v.includes("DSUR") ? "Dolby Surround" : null };
  }
  if (/^SV/.test(line)) return { raw, field: "videoSelect", value: line.slice(2) === "OFF" ? null : line.slice(2) };
  if (/^SPPR\s*[12]$/i.test(line)) return { raw, field: "speakerPreset", value: Number(line.match(/[12]$/)[0]) };
  return { raw, field: "unknown", value: line };
}
function structured(lines) {
  const decoded = lines.map(decodeDenonLine), state = {};
  for (const x of decoded) if (x.field !== "unknown") state[x.field] = x.relativeDb ?? x.value;
  return { state, decoded, raw: lines };
}
function matchesSpeakerPreset(lines, preset) {
  return lines.some((line) => new RegExp(`^SPPR\\s*${preset}$`, "i").test(line));
}
function inputCalRestorePayload(inputCal) {
  const data = inputCal?.calDataAllInputs;
  if (!data?.calFilePath) return null;
  return {
    separateCalFileForEachInput: false,
    inputDeviceIsCWeighted: Boolean(inputCal.inputDeviceIsCWeighted),
    calDataAllInputs: {
      calFilePath: data.calFilePath,
      dBFSAt94dBSPL: data.dBFSAt94dBSPL,
      fullScaleSineVrms: data.fullScaleSineVrms
    }
  };
}
export async function rew(path, options = {}) {
  const controller = new AbortController(), id = setTimeout(() => controller.abort(), options.timeoutMs || 5e3);
  try {
    const r = await fetch(REW_BASE + path, { method: options.method || "GET", headers: { "content-type": "application/json" }, body: options.body ? JSON.stringify(options.body) : void 0, signal: controller.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`REW ${r.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(id);
  }
}
async function canonicalInside(root, file, allowed) {
  const path = resolve(root, file), realRoot = await realpath(root), realPath = await realpath(path), rel = relative(realRoot, realPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path must stay inside A1 workspace");
  const info = await stat(realPath);
  if (!info.isFile()) throw new Error("path is not a regular file");
  if (allowed && !allowed.includes(extname(realPath).toLowerCase())) throw new Error(`allowed extensions: ${allowed.join(", ")}`);
  return realPath;
}
function channelsFromAdy(data) {
  const list = data.detectedChannels || data.channels || data.measurements || [];
  return list.map((c, i) => {
    const id = String(c.commandId || c.channel || c.name || `channel-${i + 1}`).toUpperCase();
    return { id, role: ROLE_ALIASES[id] || id.toLowerCase(), make: null, model: null, needsProfile: true };
  });
}
function modeClusters(rows) {
  const candidates = [];
  for (const r of rows) {
    const m = r.magnitude;
    for (let i = 1; i < m.length - 1; i++) if (m[i] > m[i - 1] && m[i] > m[i + 1] && m[i] > median(m) + 4) candidates.push(r.f[i]);
  }
  candidates.sort((a, b) => a - b);
  const clusters = [];
  for (const f of candidates) {
    const c = clusters.find((x) => Math.abs(x.center - f) / x.center < 0.025);
    if (c) {
      c.values.push(f);
      c.center = median(c.values);
    } else clusters.push({ center: f, values: [f] });
  }
  return clusters.map((c) => ({ frequencyHz: +c.center.toFixed(1), seatCount: c.values.length })).sort((a, b) => b.seatCount - a.seatCount);
}
function scoreCalibration(inputs) {
  const parts = [];
  if (inputs.ady) parts.push({ name: "measurement", score: inputs.ady.score ?? 70, weight: 0.3 });
  if (inputs.oca) parts.push({ name: "calibration", score: inputs.oca.score ?? 75, weight: 0.3 });
  if (inputs.html) parts.push({ name: "reportIntegrity", score: inputs.html.score ?? 70, weight: 0.05 });
  if (inputs.rew) parts.push({ name: "acousticVerification", score: inputs.rew.score ?? 70, weight: 0.25 });
  if (inputs.avr) parts.push({ name: "avrConsistency", score: inputs.avr.score ?? 80, weight: 0.1 });
  const w = parts.reduce((n, p) => n + p.weight, 0);
  return { score: w ? Math.round(parts.reduce((n, p) => n + p.score * p.weight, 0) / w) : null, components: parts, confidence: w >= 0.9 ? "high" : w >= 0.5 ? "medium" : "low", missing: ["ady", "oca", "html", "rew", "avr"].filter((k) => !inputs[k]) };
}
function registerAdvancedTools(server, d) {
  const { z, result, resolveHome, resolveArtifact, readJsonArtifact, tcpExchange, pluginRoot } = d;
  const avrSequence = async (host, commands, port = 23, timeoutMs = 2500) => {
    const responses = [];
    for (const command of commands) {
      responses.push(...await tcpExchange(host, [command], port, timeoutMs));
      await new Promise((resolve2) => setTimeout(resolve2, 150));
    }
    return responses;
  };
  const avrCommands = (changes) => {
    const commands = [];
    if (changes.power) commands.push(changes.power === "on" ? "PWON" : "PWSTANDBY");
    if (changes.input) commands.push(`SI${changes.input.toUpperCase()}`);
    if (changes.volumeDb !== void 0) commands.push(denonVolume(changes.volumeDb));
    if (changes.mute !== void 0) commands.push(changes.mute ? "MUON" : "MUOFF");
    return commands;
  };
  const verifyAvrChanges = (state, changes) => {
    const failures = [];
    if (changes.power && state.power !== changes.power) failures.push(`power expected ${changes.power}, got ${state.power}`);
    if (changes.input && String(state.input).toUpperCase() !== changes.input.toUpperCase()) failures.push(`input expected ${changes.input}, got ${state.input}`);
    if (changes.volumeDb !== void 0 && Math.abs(Number(state.masterVolume) - changes.volumeDb) > 0.1) failures.push(`volume expected ${changes.volumeDb}, got ${state.masterVolume}`);
    if (changes.mute !== void 0 && state.mute !== changes.mute) failures.push(`mute expected ${changes.mute}, got ${state.mute}`);
    if (failures.length) throw new Error(`AVR verification failed: ${failures.join("; ")}`);
  };
  server.tool("receiver_models", "List explicitly profiled Denon/Marantz models and capability confidence.", { brand: z.enum(["Denon", "Marantz"]).optional(), model: z.string().optional() }, err(async ({ brand, model }) => {
    const all = JSON.parse(await readFile(join(pluginRoot, "knowledge", "receiver-models.json"), "utf8"));
    const models = all.models.filter((x) => (!brand || x.brand === brand) && (!model || x.model.toLowerCase().includes(model.toLowerCase())));
    return result({ count: models.length, models, policy: "Unknown capabilities remain unknown; model-family inference is never used to authorize writes." });
  }));
  server.tool("speaker_inventory_detect", "Detect configured channels from A1/ADY artifacts and return prompts for physical speaker details the AVR cannot know.", { home: z.string().optional(), measurement: z.string().optional() }, err(async ({ home, measurement }) => {
    const root = await resolveHome(home);
    let file = measurement;
    if (!file) {
      const names = (await readdir(root)).filter((x) => extname(x).toLowerCase() === ".ady");
      file = names[0];
    }
    if (!file) return result({ channels: [], prompts: ["No ADY found. Supply a measurement artifact or channel list."], fact: "An AVR reports channel roles, not reliable loudspeaker make/model or physical coordinates." });
    const { data } = await readJsonArtifact(root, file);
    const channels = channelsFromAdy(data);
    return result({ source: file, channels, prompts: channels.map((c) => ({ channel: c.id, required: ["manufacturer", "model"], recommended: ["f3Hz", "sensitivityDb", "nominalImpedanceOhm", "minimumImpedanceOhm", "maxContinuousSplDb", "coordinatesMeters", "listeningDistanceMeters", "externalAmplifier"] })) });
  }));
  server.tool("speaker_profile_save", "Save verified speaker/sub capability profiles. No specification is invented.", { profiles: z.array(z.object({ channel: z.string(), manufacturer: z.string(), model: z.string(), f3Hz: z.number().positive().optional(), sensitivityDb: z.number().optional(), nominalImpedanceOhm: z.number().positive().optional(), minimumImpedanceOhm: z.number().positive().optional(), maxContinuousSplDb: z.number().optional(), coordinatesMeters: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(), listeningDistanceMeters: z.number().positive().optional(), externalAmplifier: z.string().optional(), source: z.string().optional() })), home: z.string().optional(), confirm: z.boolean().default(false) }, err(async ({ profiles, home, confirm }) => {
    if (!confirm) return result({ saved: false, requiresConfirmation: true, preview: profiles });
    const root = await resolveHome(home), path = join(root, "speaker-profiles.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), profiles }, null, 2) + "\n");
    return result({ saved: true, path, profiles: profiles.length });
  }));
  server.tool("rew_probe", "Check the local REW API and report version/capabilities.", { timeoutMs: z.number().int().min(200).max(15e3).default(3e3) }, err(async ({ timeoutMs }) => {
    const [measurements, commands] = await Promise.all([rew("/measurements", { timeoutMs }), rew("/measurements/commands", { timeoutMs })]);
    const count = Array.isArray(measurements) ? measurements.length : measurements && typeof measurements === "object" ? Object.keys(measurements).length : 0;
    return result({ online: true, base: REW_BASE, measurements: count, measurementSummaries: measurements, commands });
  }));
  server.tool("rew_audio_inventory", "Inspect REW audio readiness, selected devices/channels, calibration file, and available choices without changing anything.", {}, err(async () => result(await rewAudioSnapshot())));
  server.tool("rew_audio_configure_plan", "Create a confirmation-bound plan to select REW audio driver, devices, channels, and sample rate.", { driver: z.enum(["Java", "ASIO"]).default("Java"), inputDevice: z.string().optional(), input: z.string().optional(), inputChannel: z.string().optional(), outputDevice: z.string().optional(), output: z.string().optional(), outputChannel: z.string().optional(), sampleRateHz: z.number().int().min(44100).max(192e3).default(48e3) }, err(async (args) => {
    const before = await rewAudioSnapshot();
    const unsigned = { kind: "rew-audio-configuration", createdAt: (/* @__PURE__ */ new Date()).toISOString(), before, requested: args };
    return result(planWithToken(unsigned));
  }));
  server.tool("rew_audio_configure", "Apply an exact REW audio configuration plan. The token and confirm=true are mandatory.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, err(async ({ plan, confirmationToken, confirm }) => {
    if (!confirm) throw new Error("confirm=true is required");
    if (confirmationToken !== plan.confirmationToken || token(unsignedPlan(plan)) !== confirmationToken) throw new Error("configuration token mismatch");
    const r = plan.requested, family = r.driver.toLowerCase(), base = `/audio/${family}`;
    await rew("/audio/driver", { method: "POST", body: { driver: r.driver } });
    if (r.inputDevice) await rew(`${base}/${family === "java" ? "input-device" : "device"}`, { method: "POST", body: { device: r.inputDevice } });
    if (r.input) await rew(`${base}/input`, { method: "POST", body: { input: r.input } });
    if (r.outputDevice && family === "java") await rew(`${base}/output-device`, { method: "POST", body: { device: r.outputDevice } });
    if (r.output) await rew(`${base}/output`, { method: "POST", body: { output: r.output } });
    if (r.inputChannel && family === "java") await rew(`${base}/input-channel`, { method: "POST", body: { channel: Number(r.inputChannel) } });
    if (r.outputChannel && family === "java") await rew(`${base}/output-channel`, { method: "POST", body: { channel: r.outputChannel } });
    await rew("/audio/samplerate", { method: "POST", body: { value: r.sampleRateHz, unit: "Hz" } });
    const calibration = inputCalRestorePayload(plan.before?.inputCal);
    if (calibration) await rew("/audio/input-cal", { method: "PUT", body: calibration });
    const after = await rewAudioSnapshot();
    if (calibration && after.inputCal?.calDataAllInputs?.calFilePath !== calibration.calDataAllInputs.calFilePath) throw new Error("REW microphone calibration restoration failed");
    return result({ configured: true, after, microphoneCalibrationPreserved: Boolean(calibration) });
  }));
  server.tool("rew_input_level_check", "Monitor the connected REW microphone for a bounded period and report peak/RMS headroom. Starts capture but emits no sweep.", { durationMs: z.number().int().min(1e3).max(15e3).default(4e3), confirm: z.boolean().default(false) }, err(async ({ durationMs, confirm }) => {
    if (!confirm) return result({ started: false, requiresConfirmation: true, durationMs });
    const commands = await rew("/input-levels/commands"), start = Array.isArray(commands) ? commands.find((x) => /start/i.test(String(x))) : "Start";
    await rew("/input-levels/command", { method: "POST", body: { command: start || "Start" } });
    await new Promise((r) => setTimeout(r, durationMs));
    const levels = await rew("/input-levels/last-levels");
    const stop = Array.isArray(commands) ? commands.find((x) => /stop/i.test(String(x))) : "Stop";
    await rew("/input-levels/command", { method: "POST", body: { command: stop || "Stop" } });
    return result({ completed: true, levels, caveat: "Aim for healthy input without clipping; exact SPL requires a valid mic calibration/SPL reference." });
  }));
  server.tool("rew_post_measurement_plan", "Build a guarded, level-matched post-calibration sweep plan. It can switch Denon Speaker Presets and REW output channels automatically after the microphone and HDMI path are ready.", { host: z.string(), home: z.string().optional(), avrInput: z.string().regex(/^[A-Z0-9 _-]{1,20}$/).optional(), avrVolumeDb: z.number().min(-60).max(-10).default(-30), startHz: z.number().min(5).max(200).default(10), endHz: z.number().min(1e3).max(24e3).default(2e4), sweepLength: z.string().default("256k"), repetitions: z.number().int().min(1).max(8).default(1), levelDbfs: z.number().min(-40).max(-3).default(-12), maxSplDb: z.number().min(70).max(105).default(95), minSnrDb: z.number().min(5).max(50).default(20), timingReference: z.enum(["None", "Acoustic", "Loopback"]).default("Acoustic"), runs: z.array(z.object({ speakerPreset: z.number().int().min(1).max(2), title: z.string().min(1).max(80), outputChannel: z.string().optional(), notes: z.string().max(500).optional() })).min(1).max(20), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/).default("post-calibration-measurements.mdat") }, err(async (args) => {
    const root = await resolveHome(args.home), audio = await rewAudioSnapshot(), measure = await rewMeasureSnapshot(), measurements = await rew("/measurements"), avr = await tcpExchange(args.host, ["SPPR ?", "PW?", "MV?", "MU?", "SI?", "MS?"], 23, 2500);
    const protection = safeProtection(measure["/measure/protection-options"], args.maxSplDb);
    const unsigned = { kind: "rew-post-calibration-measurements", createdAt: (/* @__PURE__ */ new Date()).toISOString(), root, savePath: join(root, args.saveFile), request: { ...args, home: void 0 }, baselineMeasurementIds: measurementEntries(measurements).map(([id]) => id), audio, measure, protection, avr };
    return result(planWithToken(unsigned));
  }));
  server.tool("rew_post_measurement_execute", "Execute an exact post-calibration plan: configure safe sweep settings, switch/verify preset, run and label each sweep, save the MDAT, and restore the original preset.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, err(async ({ plan, confirmationToken, confirm }) => {
    if (!confirm) throw new Error("confirm=true is required immediately before sweeps");
    if (confirmationToken !== plan.confirmationToken || token(unsignedPlan(plan)) !== confirmationToken) throw new Error("measurement plan token mismatch");
    if (plan.kind !== "rew-post-calibration-measurements") throw new Error("wrong plan kind");
    const q = plan.request, initialRaw = await tcpExchange(q.host, ["SPPR ?", ...STATUS_COMMANDS], 23, 2500), initialPreset = Number((initialRaw.find((x) => /^SPPR\s*[12]$/i.test(x)) || "").match(/[12]$/)?.[0]), initialState = structured(initialRaw).state;
    if (!initialPreset) throw new Error("could not read current Denon Speaker Preset");
    const created = [];
    await rew("/application/blocking", { method: "POST", body: true });
    try {
      const armed = { power: "on", ...q.avrInput ? { input: q.avrInput } : {}, volumeDb: q.avrVolumeDb, mute: false };
      await avrSequence(q.host, avrCommands(armed));
      const armedState = structured(await tcpExchange(q.host, STATUS_COMMANDS, 23, 3e3)).state;
      verifyAvrChanges(armedState, armed);
      await rew("/measure/sweep/configuration", { method: "POST", body: { startFrequency: q.startHz, endFrequency: q.endHz, length: q.sweepLength, fillSilenceWithDither: true } });
      await rew("/measure/sweep/repetitions", { method: "POST", body: q.repetitions });
      await rew("/measure/level", { method: "POST", body: { value: q.levelDbfs, unit: "dBFS" } });
      await setAndVerifyRewValue("/measure/timing/reference", q.timingReference);
      if (Object.keys(plan.protection?.options || {}).length) await rew("/measure/protection-options", { method: "POST", body: plan.protection.options });
      const advertised = plan.measure?.["/measure/commands"] || [], check = Array.isArray(advertised) ? advertised.find((x) => /check.*level/i.test(String(x))) : null;
      if (check) {
        try {
          await rew("/measure/command", { method: "POST", body: { command: check }, timeoutMs: 6e4 });
        } catch (error) {
          if (!/REW 501:[\s\S]*not implemented/i.test(error.message)) throw error;
        }
      }
      for (const run of q.runs) {
        await avrSequence(q.host, [`SPPR ${run.speakerPreset}`]);
        const verify = await tcpExchange(q.host, ["SPPR ?"], 23, 2e3);
        if (!matchesSpeakerPreset(verify, run.speakerPreset)) throw new Error(`Speaker Preset ${run.speakerPreset} verification failed`);
        if (run.outputChannel) {
          const family = String(plan.audio.family), base = `/audio/${family}`;
          if (family === "java") await rew(`${base}/output-channel`, { method: "POST", body: { channel: run.outputChannel } });
        }
        if (run.outputChannel === "L+R") await setAndVerifyRewValue("/measure/sequential-channels", { channels: [] });
        await setAndVerifyRewValue("/measure/timing/reference", q.timingReference);
        await rew("/measure/notes", { method: "POST", body: `Speaker Preset ${run.speakerPreset}; ${run.notes || "post-calibration verification"}` });
        const before = new Set(measurementEntries(await rew("/measurements")).map(([id2]) => id2));
        const response = await rew("/measure/command", { method: "POST", body: { command: "SPL" }, timeoutMs: 18e4 });
        const [id, summary] = await waitForSingleNewMeasurement(before);
        await rew(`/measurements/${encodeURIComponent(id)}`, { method: "PUT", body: { title: run.title, notes: `Speaker Preset ${run.speakerPreset}; ${run.notes || "post-calibration verification"}` } });
        if (Number.isFinite(summary?.signalToNoisedB) && summary.signalToNoisedB < q.minSnrDb) throw new Error(`REW measurement SNR ${summary.signalToNoisedB.toFixed(1)} dB is below the ${q.minSnrDb} dB minimum`);
        created.push({ id, title: run.title, speakerPreset: run.speakerPreset, outputChannel: run.outputChannel || null, response, summary });
      }
      await rew("/measurements/command", { method: "POST", body: { command: "Save all", parameters: [plan.savePath, "Automated level-matched Denon Speaker Preset post-calibration measurements"] }, timeoutMs: 12e4 });
      return result({ completed: true, created, savePath: plan.savePath, restoredSpeakerPreset: initialPreset, protectionApplied: plan.protection });
    } finally {
      const restore = { power: "on", ...initialState.input ? { input: initialState.input } : {}, ...Number.isFinite(initialState.masterVolume) ? { volumeDb: initialState.masterVolume } : {}, ...typeof initialState.mute === "boolean" ? { mute: initialState.mute } : {} };
      await avrSequence(q.host, [`SPPR ${initialPreset}`, ...avrCommands(restore)]).catch(() => {
      });
      if (initialState.power === "standby") await avrSequence(q.host, ["PWSTANDBY"]).catch(() => {
      });
      const initialTimingReference = plan.measure?.["/measure/timing/reference"];
      if (typeof initialTimingReference === "string") await rew("/measure/timing/reference", { method: "POST", body: initialTimingReference }).catch(() => {
      });
      const initialSequentialChannels = plan.measure?.["/measure/sequential-channels"];
      if (initialSequentialChannels && typeof initialSequentialChannels === "object") await rew("/measure/sequential-channels", { method: "POST", body: initialSequentialChannels }).catch(() => {
      });
      await rew("/application/blocking", { method: "POST", body: false }).catch(() => {
      });
    }
  }));
  server.tool("rew_measurement_cancel", "Cancel a REW measurement currently in progress. This does not change AVR calibration data.", { confirm: z.boolean().default(false) }, err(async ({ confirm }) => {
    if (!confirm) return result({ cancelled: false, requiresConfirmation: true });
    const commands = await rew("/measure/commands"), cancel = Array.isArray(commands) ? commands.find((x) => /cancel/i.test(String(x))) : "Cancel measurement";
    if (!cancel) throw new Error("REW did not advertise a cancel command");
    return result({ cancelled: true, response: await rew("/measure/command", { method: "POST", body: { command: cancel } }) });
  }));
  server.tool("rew_save_all", "Save all live REW measurements to a workspace-contained MDAT file.", { home: z.string().optional(), saveFile: z.string().regex(/^[A-Za-z0-9._-]+\.mdat$/), note: z.string().max(500).default("A1 Evo post-calibration measurements"), confirm: z.boolean().default(false) }, err(async ({ home, saveFile, note, confirm }) => {
    const root = await resolveHome(home), savePath = join(root, saveFile);
    if (!confirm) return result({ saved: false, requiresConfirmation: true, savePath, note });
    const response = await rew("/measurements/command", { method: "POST", body: { command: "Save all", parameters: [savePath, note] }, timeoutMs: 12e4 });
    return result({ saved: true, savePath, response });
  }));
  server.tool("rew_load_file", "Load a workspace-contained .mdat into live REW. Explicit confirmation is mandatory.", { file: z.string(), home: z.string().optional(), confirm: z.boolean().default(false) }, err(async ({ file, home, confirm }) => {
    const root = await resolveHome(home), path = await canonicalInside(root, file, [".mdat"]);
    if (!confirm) return result({ loaded: false, requiresConfirmation: true, path, command: "Load" });
    const response = await rew("/measurements/command", { method: "POST", body: { command: "Load", parameters: [path] }, timeoutMs: 3e4 });
    return result({ loaded: true, path, response });
  }));
  server.tool("rew_generate_trace", "Generate an allowlisted derived trace in live REW from selected measurements.", { processName: z.enum(["Vector sum", "Vector average", "RMS average", "dB average", "Magn plus phase average", "dB plus phase average", "Arithmetic", "Smooth", "Time align", "Cross corr align"]), measurementIndices: z.array(z.number().int().positive()).min(1).max(30), parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}), confirm: z.boolean().default(false) }, err(async ({ processName, measurementIndices, parameters, confirm }) => {
    const proposal = { processName, measurementIndices, parameters };
    if (!confirm) return result({ generated: false, requiresConfirmation: true, proposal });
    const response = await rew("/measurements/process-measurements", { method: "POST", body: proposal, timeoutMs: 3e4 });
    return result({ generated: true, proposal, response });
  }));
  server.tool("rew_trace", "Fetch a bounded live REW trace including magnitude/phase, group delay, distortion, decay/RT60, or impulse.", { id: z.string(), kind: z.enum(["frequency-response", "group-delay", "distortion", "rt60", "impulse-response"]), ppo: z.number().int().min(1).max(192).default(48), smoothing: z.string().default("1/12"), maxPoints: z.number().int().min(20).max(5e3).default(1e3) }, err(async ({ id, kind, ppo, smoothing, maxPoints }) => {
    const q = new URLSearchParams();
    if (["frequency-response", "group-delay"].includes(kind)) q.set("smoothing", smoothing);
    if (["frequency-response", "group-delay", "distortion"].includes(kind)) q.set("ppo", String(ppo));
    const data = await rew(`/measurements/${encodeURIComponent(id)}/${kind}?${q}`);
    for (const k of ["magnitude", "phase", "frequency", "groupDelay", "distortion", "time", "value"]) {
      const a = parseSeries(data?.[k]);
      if (a.length > maxPoints) {
        const step = Math.ceil(a.length / maxPoints);
        data[k] = a.filter((_, i) => i % step === 0);
      }
    }
    return result({ id, kind, data });
  }));
  server.tool("rew_crossover_analysis", "Analyze phase agreement and predicted vector summation through a crossover band.", { mainId: z.string(), subId: z.string(), crossoverHz: z.number().min(20).max(300), spanOctaves: z.number().min(0.25).max(2).default(1), ppo: z.number().int().min(24).max(192).default(96) }, err(async ({ mainId, subId, crossoverHz, spanOctaves, ppo }) => {
    const [a, b] = await Promise.all([rew(`/measurements/${encodeURIComponent(mainId)}/frequency-response?ppo=${ppo}&smoothing=1%2F24`), rew(`/measurements/${encodeURIComponent(subId)}/frequency-response?ppo=${ppo}&smoothing=1%2F24`)]);
    const am = parseSeries(a.magnitude), ap = unwrap(parseSeries(a.phase)), af = frequencies(a, am.length), bm = parseSeries(b.magnitude), bp = unwrap(parseSeries(b.phase)), bf = frequencies(b, bm.length);
    const lo = crossoverHz / 2 ** spanOctaves, hi = crossoverHz * 2 ** spanOctaves, rows = [];
    for (let f = lo; f <= hi; f *= 2 ** (1 / 24)) {
      const ma = interp(af, am, f), mb = interp(bf, bm, f), pa = interp(af, ap, f), pb = interp(bf, bp, f);
      if ([ma, mb, pa, pb].every(Number.isFinite)) {
        const va = 10 ** (ma / 20), vb = 10 ** (mb / 20), sum = 20 * Math.log10(Math.hypot(va * Math.cos(pa * Math.PI / 180) + vb * Math.cos(pb * Math.PI / 180), va * Math.sin(pa * Math.PI / 180) + vb * Math.sin(pb * Math.PI / 180)));
        rows.push({ frequencyHz: +f.toFixed(2), phaseDeltaDeg: +Math.abs(circularDelta(pa, pb)).toFixed(1), predictedSumDb: +sum.toFixed(2), gainOverLouderDb: +(sum - Math.max(ma, mb)).toFixed(2) });
      }
    }
    const at = rows.reduce((x, y) => Math.abs(y.frequencyHz - crossoverHz) < Math.abs(x.frequencyHz - crossoverHz) ? y : x);
    return result({ mainId, subId, crossoverHz, atCrossover: at, band: { medianAbsPhaseDeltaDeg: median(rows.map((x) => x.phaseDeltaDeg)), p10SummationGainDb: percentile(rows.map((x) => x.gainOverLouderDb), 0.1) }, rows, caveat: "Prediction uses measured complex responses; verify with a real main+sub trace at identical timing and level settings." });
  }));
  server.tool("rew_multiseat_analysis", "Analyze seat consistency, modal clusters, outliers, and estimate Schroeder frequency when room volume and RT60 are supplied.", { ids: z.array(z.string()).min(2).max(30), lowHz: z.number().min(10).max(500).default(20), highHz: z.number().min(30).max(1e3).default(300), roomVolumeM3: z.number().positive().optional(), rt60Seconds: z.number().positive().optional() }, err(async ({ ids, lowHz, highHz, roomVolumeM3, rt60Seconds }) => {
    const traces = await Promise.all(ids.map(async (id) => {
      const x = await rew(`/measurements/${encodeURIComponent(id)}/frequency-response?ppo=48&smoothing=1%2F12`), m = parseSeries(x.magnitude), f = frequencies(x, m.length);
      return { id, f, m };
    }));
    const grid = Array.from({ length: Math.ceil(Math.log2(highHz / lowHz) * 48) + 1 }, (_, i) => lowHz * 2 ** (i / 48)), seatScores = traces.map((t) => {
      const v = grid.map((f) => interp(t.f, t.m, f)).filter(Number.isFinite), med = median(v);
      return { id: t.id, deviationDb: Math.sqrt(v.reduce((n, x) => n + (x - med) ** 2, 0) / v.length) };
    }), medDev = median(seatScores.map((x) => x.deviationDb)), mad = median(seatScores.map((x) => Math.abs(x.deviationDb - medDev))) || 0.01;
    for (const s of seatScores) s.outlier = s.deviationDb > medDev + 3 * mad;
    const schroeder = roomVolumeM3 && rt60Seconds ? 2e3 * Math.sqrt(rt60Seconds / roomVolumeM3) : null;
    return result({ seats: seatScores, modalClusters: modeClusters(traces), schroederFrequencyHz: schroeder ? +schroeder.toFixed(1) : null, formula: "2000*sqrt(RT60/roomVolumeM3)", caveat: schroeder ? null : "Supply measured RT60 and room volume for a Schroeder estimate." });
  }));
  server.tool("denon_decode", "Decode Denon/Marantz text-protocol responses into structured status.", { lines: z.array(z.string()).min(1) }, async ({ lines }) => result(structured(lines)));
  server.tool("denon_snapshot", "Read live AVR state and optionally save a workspace backup.", { host: z.string(), port: z.number().int().min(1).max(65535).default(23), home: z.string().optional(), save: z.boolean().default(false), confirmSave: z.boolean().default(false) }, err(async ({ host, port, home, save, confirmSave }) => {
    const snap = { capturedAt: (/* @__PURE__ */ new Date()).toISOString(), host, ...structured(await tcpExchange(host, STATUS_COMMANDS, port, 3e3)) };
    if (save && !confirmSave) return result({ ...snap, saved: false, requiresConfirmation: true });
    if (save) {
      const root = await resolveHome(home), path = join(root, `denon-snapshot-${Date.now()}.json`);
      await writeFile(path, JSON.stringify(snap, null, 2) + "\n");
      snap.saved = path;
    }
    return result(snap);
  }));
  server.tool("denon_propose_changes", "Create a deterministic AVR change plan and confirmation token; does not write.", { host: z.string(), changes: z.object({ power: z.enum(["on", "standby"]).optional(), mute: z.boolean().optional(), input: z.string().regex(/^[A-Z0-9 _-]{1,20}$/).optional(), volumeDb: z.number().min(-80).max(18).optional() }) }, err(async ({ host, changes }) => {
    const commands = avrCommands(changes), plan = { host, changes, commands };
    return result({ plan, confirmationToken: token(plan), warning: "Review the diff and reissue through denon_execute_plan with confirm=true." });
  }));
  server.tool("denon_execute_plan", "Apply an allowlisted AVR plan, then query and verify live state.", { host: z.string(), changes: z.object({ power: z.enum(["on", "standby"]).optional(), mute: z.boolean().optional(), input: z.string().regex(/^[A-Z0-9 _-]{1,20}$/).optional(), volumeDb: z.number().min(-80).max(18).optional() }), confirmationToken: z.string(), confirm: z.boolean().default(false), port: z.number().int().min(1).max(65535).default(23) }, err(async ({ host, changes, confirmationToken, confirm, port }) => {
    const commands = avrCommands(changes), plan = { host, changes, commands };
    if (!confirm || confirmationToken !== token(plan)) throw new Error("confirmation missing or token does not match the exact plan");
    await avrSequence(host, commands, port, 3e3);
    const verified = structured(await tcpExchange(host, STATUS_COMMANDS, port, 3500));
    verifyAvrChanges(verified.state, changes);
    return result({ executed: true, plan, verified, verification: "Every requested field was re-queried and matched after sequential execution." });
  }));
  server.tool("calibration_report_score", "Score ADY, OCA, HTML, live REW, and optional AVR evidence with explicit provenance and missing-data confidence.", { home: z.string().optional(), adyFile: z.string().optional(), ocaFile: z.string().optional(), htmlFile: z.string().optional(), avrHost: z.string().optional() }, err(async ({ home, adyFile, ocaFile, htmlFile, avrHost }) => {
    const evidence = {};
    if (adyFile) {
      const { data } = await readJsonArtifact(home, adyFile), n = channelsFromAdy(data).length;
      evidence.ady = { score: Math.min(100, 55 + n * 5), file: adyFile, channels: n };
    }
    if (ocaFile) {
      const { data } = await readJsonArtifact(home, ocaFile), n = (data.channels || data.detectedChannels || data.filters || []).length;
      evidence.oca = { score: Math.min(100, 60 + n * 3), file: ocaFile, channels: n };
    }
    if (htmlFile) {
      const f = await resolveArtifact(home, htmlFile), text = await readFile(f.path, "utf8");
      evidence.html = { score: /error|critical/i.test(text) ? 45 : 80, file: htmlFile, bytes: f.info.size };
    }
    try {
      const m = await rew("/measurements", { timeoutMs: 1500 }), n = Array.isArray(m) ? m.length : Object.keys(m || {}).length;
      evidence.rew = { score: n ? Math.min(100, 65 + n * 4) : 40, measurements: n };
    } catch {
    }
    if (avrHost) {
      evidence.avr = { score: 80, status: structured(await tcpExchange(avrHost, STATUS_COMMANDS, 23, 2500)).state };
    }
    const scored = scoreCalibration({ ady: evidence.ady, oca: evidence.oca, rew: evidence.rew, avr: evidence.avr });
    return result({ ...scored, evidence, html: evidence.html || null, note: "Scores are transparent completeness/consistency heuristics, not a claim of subjective sound quality." });
  }));
  server.tool("ab_test_plan", "Create a level-matched, preset-tracked A/B protocol without changing the AVR.", { baseline: z.object({ name: z.string(), preset: z.string(), volumeDb: z.number() }), candidate: z.object({ name: z.string(), preset: z.string(), volumeDb: z.number() }), trials: z.number().int().min(4).max(40).default(10) }, async ({ baseline, candidate, trials }) => {
    const levelOffsetDb = baseline.volumeDb - candidate.volumeDb;
    const order = Array.from({ length: trials }, (_, i) => i % 4 < 2 ? i % 2 ? "B" : "A" : i % 2 ? "A" : "B");
    return result({ baseline, candidate, levelOffsetDb, order, record: ["trial", "selection", "confidence", "notes", "measuredLevelDb"], rules: ["Match playback level within 0.2 dB at the listening position.", "Keep source, seat, passage, and processing fixed except the tested preset.", "Restore baseline after the session."] });
  });
}
const advancedInternals = { decodeDenonLine, parseSeries, unwrap, circularDelta, scoreCalibration, canonicalInside, token, unsignedPlan, planWithToken, denonVolume, measurementEntries, safeProtection, matchesSpeakerPreset, inputCalRestorePayload };
export {
  advancedInternals,
  decodeDenonLine,
  registerAdvancedTools
};
