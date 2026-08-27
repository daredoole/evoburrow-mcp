#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { registerAdvancedTools, rew } from "./advanced.mjs";
import { registerPresetTools } from "./preset-tools.mjs";
import { registerA1TerminalTools } from "./a1-terminal-adapter.mjs";
import { discoverRewInstall, launchRew } from "./lib/rew-launcher.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = basename(SERVER_DIR) === "dist" ? dirname(SERVER_DIR) : SERVER_DIR;
const DEFAULT_HOME = resolve(PLUGIN_ROOT, process.env.A1_EVO_HOME || "../..");
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TEXT_LIMIT = 80_000;

function result(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError };
}

const planToken = payload => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
function bindPlan(payload) { return { ...payload, confirmationToken: planToken(payload) }; }
function verifyPlan(plan, confirmationToken) {
  const { confirmationToken: embedded, ...unsigned } = plan || {};
  const expected = planToken(unsigned);
  if (embedded !== expected || confirmationToken !== expected) throw new Error("Plan or confirmation token mismatch");
  return unsigned;
}

function assertHost(host) {
  if (typeof host !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$|^[a-z0-9][a-z0-9.-]*$/i.test(host)) {
    throw new Error("host must be an IPv4 address or local DNS hostname");
  }
  const parts = host.split(".");
  if (parts.every((part) => /^\d+$/.test(part))) {
    if (parts.some((part) => Number(part) > 255)) throw new Error("invalid IPv4 address");
    const [a,b] = parts.map(Number);
    if (!(a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254)) throw new Error("receiver host must use a private or loopback IPv4 address");
  } else if (host.includes(".") && !host.toLowerCase().endsWith(".local")) {
    throw new Error("receiver hostname must be single-label local DNS or end in .local");
  }
  return host;
}

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function resolveHome(home) {
  const candidate = resolve(home || DEFAULT_HOME);
  if (!(await exists(candidate))) throw new Error(`A1 workspace not found: ${candidate}`);
  return realpath(candidate);
}

async function resolveArtifact(home, file) {
  const root = await resolveHome(home);
  const path = await realpath(resolve(root, file));
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("file must stay inside the A1 workspace");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("artifact is not a regular file");
  if (info.size > MAX_FILE_BYTES) throw new Error(`artifact exceeds ${MAX_FILE_BYTES} bytes`);
  return { root, path, rel, info };
}

async function readJsonArtifact(home, file) {
  const found = await resolveArtifact(home, file);
  return { ...found, data: JSON.parse(await readFile(found.path, "utf8")) };
}

function numericStats(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  let sum = 0, sumSq = 0, peak = 0, peakIndex = 0;
  nums.forEach((v, i) => { sum += v; sumSq += v * v; if (Math.abs(v) > peak) { peak = Math.abs(v); peakIndex = i; } });
  const rms = Math.sqrt(sumSq / nums.length);
  return { samples: nums.length, mean: sum / nums.length, rms, peak, peakIndex, crestFactorDb: rms ? 20 * Math.log10(peak / rms) : null };
}

function channelId(channel, index) { return channel.commandId || channel.channel || channel.name || `channel-${index + 1}`; }

function fftMagnitudes(input, sampleRate) {
  let n = 1;
  while (n * 2 <= Math.min(input.length, 16384)) n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Number(input[i]) || 0;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let j = 0; j < len / 2; j++) {
      const c = Math.cos(angle * j), s = Math.sin(angle * j);
      const ur = re[i + j], ui = im[i + j];
      const vr = re[i + j + len / 2] * c - im[i + j + len / 2] * s;
      const vi = re[i + j + len / 2] * s + im[i + j + len / 2] * c;
      re[i + j] = ur + vr; im[i + j] = ui + vi;
      re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
    }
  }
  return { n, hzPerBin: sampleRate / n, magnitudes: Array.from({ length: n / 2 }, (_, i) => Math.hypot(re[i], im[i])) };
}

function bandLevels(values, sampleRate) {
  const { hzPerBin, magnitudes } = fftMagnitudes(values, sampleRate);
  const bands = [[20,40],[40,80],[80,160],[160,320],[320,640],[640,1250],[1250,2500],[2500,5000],[5000,10000],[10000,20000]];
  const raw = bands.map(([lo, hi]) => {
    const a = Math.min(magnitudes.length - 1, Math.max(1, Math.round(lo / hzPerBin)));
    const b = Math.max(a, Math.min(magnitudes.length - 1, Math.round(hi / hzPerBin)));
    let sumSq = 0, count = 0;
    for (let i = a; i <= b; i++) { sumSq += magnitudes[i] ** 2; count++; }
    return { bandHz: `${lo}-${hi}`, db: count ? 20 * Math.log10(Math.sqrt(sumSq / count) + 1e-15) : null };
  });
  const max = Math.max(...raw.map((x) => x.db ?? -Infinity));
  return raw.map((x) => ({ ...x, relativeDb: x.db == null ? null : x.db - max }));
}

function parseCurve(text) {
  const points = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || /^[#;*]/.test(line)) continue;
    const match = line.match(/^([0-9]+(?:\.[0-9]+)?)\s*[,;\t ]\s*(-?[0-9]+(?:\.[0-9]+)?)/);
    if (match) points.push({ line: index + 1, frequencyHz: Number(match[1]), levelDb: Number(match[2]) });
  }
  return points;
}

function curveAt(points, frequency) {
  if (!points.length || frequency < points[0].frequencyHz || frequency > points.at(-1).frequencyHz) return null;
  let i = 1;
  while (i < points.length && points[i].frequencyHz < frequency) i++;
  const a = points[i - 1], b = points[Math.min(i, points.length - 1)];
  if (a.frequencyHz === b.frequencyHz) return a.levelDb;
  const t = (Math.log(frequency) - Math.log(a.frequencyHz)) / (Math.log(b.frequencyHz) - Math.log(a.frequencyHz));
  return a.levelDb + t * (b.levelDb - a.levelDb);
}

async function tcpExchange(host, commands, port = 23, timeoutMs = 2500) {
  assertHost(host);
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host, port });
    const lines = [];
    let buffer = "", settled = false;
    const finish = () => { if (settled) return; settled = true; socket.destroy(); resolvePromise(lines); };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { for (const command of commands) socket.write(`${command}\r`); setTimeout(finish, Math.min(timeoutMs, 900)); });
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); const parts = buffer.split("\r"); buffer = parts.pop() || ""; lines.push(...parts.filter(Boolean)); });
    socket.on("timeout", finish);
    socket.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
    socket.on("close", () => { if (!settled) { if (buffer.trim()) lines.push(buffer.trim()); finish(); } });
  });
}

async function probePort(host, port, timeoutMs) {
  assertHost(host);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (open, error = null) => { if (done) return; done = true; socket.destroy(); resolvePromise({ port, open, latencyMs: Date.now() - started, error }); };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false, "timeout"));
    socket.on("error", (error) => finish(false, error.code || error.message));
  });
}

function launchCommand(executable, root) {
  if (process.platform === "win32") return { command: executable, args: [], options: { cwd: root, detached: true, windowsHide: false } };
  if (process.platform === "darwin") return { command: "open", args: ["-a", "Terminal", executable], options: { cwd: root, detached: true } };
  return { command: "x-terminal-emulator", args: ["-e", executable], options: { cwd: root, detached: true } };
}

function a1ExecutableNames() {
  if (process.platform === "win32") return ["a1-evo-acoustix-win-x64.exe", "a1-evo-acoustix.exe"];
  if (process.platform === "darwin") return process.arch === "arm64" ? ["a1-evo-acoustix-macos-arm64"] : ["a1-evo-acoustix-macos-x64", "a1-evo-acoustix-macos"];
  return ["a1-evo-acoustix-linux-x64"];
}

async function trustedA1Executable(root, supplied) {
  const allowed = a1ExecutableNames();
  if (supplied && !allowed.includes(basename(supplied))) throw new Error(`Executable must be a platform A1 binary: ${allowed.join(", ")}`);
  for (const candidate of supplied ? [supplied] : allowed) {
    try {
      const path = await realpath(resolve(root, candidate));
      const rel = relative(root, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !allowed.includes(basename(path))) throw new Error("A1 executable must stay inside the workspace");
      const info = await stat(path);
      if (!info.isFile()) throw new Error("A1 executable is not a regular file");
      await access(path, fsConstants.X_OK);
      return path;
    } catch (error) {
      if (supplied) throw error;
    }
  }
  throw new Error(`No trusted A1 executable found; checked ${allowed.join(", ")}`);
}

function denonCommand(action, value) {
  if (action === "power_on") return "PWON";
  if (action === "power_standby") return "PWSTANDBY";
  if (action === "mute_on") return "MUON";
  if (action === "mute_off") return "MUOFF";
  if (action === "input") {
    const input=String(value||"").toUpperCase();
    if(!/^[A-Z0-9 _-]{1,20}$/.test(input)) throw new Error("invalid input name");
    return `SI${input}`;
  }
  if (action === "volume_db") {
    const db=Number(value);
    if(!Number.isFinite(db)||db < -80 || db > 18) throw new Error("volume_db must be between -80 and +18 dB");
    const scaled=Math.round((db+80)*2)/2;
    return `MV${String(Math.floor(scaled)).padStart(2,"0")}${Number.isInteger(scaled)?"":"5"}`;
  }
  throw new Error("unsupported Denon action");
}

const STANDARD_CROSSOVERS = [40, 60, 80, 90, 100, 110, 120, 150, 180, 200, 250];

function chooseCrossover(f3Hz, currentHz) {
  const minimum = Math.max(40, Number(f3Hz) * 1.5);
  const recommended = STANDARD_CROSSOVERS.find((value) => value >= minimum) || 250;
  return { recommendedHz: recommended, currentHz: currentHz ?? null, minimumFromF3Hz: minimum, risk: currentHz && currentHz < minimum ? "current crossover is below the conservative 1.5×F3 heuristic" : null };
}

function filterSpectralGain(values, sampleRate = 48000) {
  if (!Array.isArray(values) || values.length < 8) return null;
  const { magnitudes, hzPerBin } = fftMagnitudes(values, sampleRate);
  const usable = magnitudes.slice(Math.max(1, Math.ceil(20 / hzPerBin)), Math.min(magnitudes.length, Math.floor(20000 / hzPerBin))).filter((v) => v > 1e-12).sort((a,b)=>a-b);
  if (!usable.length) return null;
  const median = usable[Math.floor(usable.length / 2)], peak = usable.at(-1);
  return { relativePeakGainDb: 20 * Math.log10(peak / median), medianMagnitude: median, peakMagnitude: peak, assumption: "FIR spectral peak relative to median 20 Hz-20 kHz; not an absolute AVR gain measurement." };
}

function speakerAngles(listener, speaker) {
  const dx=speaker.x-listener.x, dy=speaker.y-listener.y, dz=speaker.z-listener.z;
  const horizontal=Math.hypot(dx,dy), distance=Math.hypot(horizontal,dz);
  return { distanceMeters: distance, azimuthDeg: Math.atan2(dx,dy)*180/Math.PI, elevationDeg: Math.atan2(dz,horizontal)*180/Math.PI };
}

function placementTarget(role) {
  const key=role.toLowerCase().replace(/[ _-]/g,"");
  const targets={
    fl:{az:[-30,-22],el:[-5,10]},fr:{az:[22,30],el:[-5,10]},c:{az:[-5,5],el:[-10,15]},
    sl:{az:[-110,-90],el:[-5,20]},sr:{az:[90,110],el:[-5,20]},sbl:{az:[-150,-135],el:[-5,20]},sbr:{az:[135,150],el:[-5,20]},
    tfl:{az:[-55,-25],el:[30,55]},tfr:{az:[25,55],el:[30,55]},trl:{az:[-155,-125],el:[30,55]},trr:{az:[125,155],el:[30,55]}
  };
  return targets[key] || null;
}

function designCurve({ bassBoostDb, bassShelfEndHz, trebleTiltDb, points }) {
  const output=[];
  for(let i=0;i<points;i++){
    const frequency=3*Math.pow(24000/3,i/(points-1));
    let level;
    if(frequency<=bassShelfEndHz) level=bassBoostDb;
    else if(frequency<1000) level=bassBoostDb*(1-(Math.log(frequency)-Math.log(bassShelfEndHz))/(Math.log(1000)-Math.log(bassShelfEndHz)));
    else level=trebleTiltDb*Math.log(frequency/1000)/Math.log(24000/1000);
    output.push({frequencyHz:Number(frequency.toFixed(3)),levelDb:Number(level.toFixed(3))});
  }
  const nearest=output.reduce((a,b)=>Math.abs(b.frequencyHz-1000)<Math.abs(a.frequencyHz-1000)?b:a);
  nearest.frequencyHz=1000; nearest.levelDb=0;
  return output.sort((a,b)=>a.frequencyHz-b.frequencyHz);
}

export const internals = { numericStats, bandLevels, parseCurve, curveAt, assertHost, denonCommand, chooseCrossover, filterSpectralGain, speakerAngles, placementTarget, designCurve, tcpExchange, resolveHome, resolveArtifact, trustedA1Executable };

const server = new McpServer({ name: "evoburrow", version: "1.0.0" });

server.tool("rew_install_discover", "Find a local REW installation across Windows, macOS, and Linux without starting it.", { executablePath: z.string().min(1).max(1000).optional() }, async ({ executablePath }) => {
  try {
    let api;
    try { api = { online: true, version: await rew("/version", { timeoutMs: 1200 }) }; }
    catch (error) { api = { online: false, error: String(error.message).slice(0, 240) }; }
    return result({ api, ...(await discoverRewInstall({ explicitPath: executablePath })) });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("rew_launch_plan", "Create a hash-bound plan to start the exact discovered REW executable.", { executablePath: z.string().min(1).max(1000).optional(), startupTimeoutSeconds: z.number().int().min(1).max(45).default(20) }, async ({ executablePath, startupTimeoutSeconds }) => {
  try {
    try {
      const version = await rew("/version", { timeoutMs: 1200 });
      return result(bindPlan({ kind: "rew-launch", createdAt: new Date().toISOString(), alreadyRunning: true, version, timeoutMs: startupTimeoutSeconds * 1000 }));
    } catch {}
    const discovery = await discoverRewInstall({ explicitPath: executablePath });
    if (!discovery.selected) return result({ planReady: false, ...discovery });
    return result(bindPlan({ kind: "rew-launch", createdAt: new Date().toISOString(), alreadyRunning: false, candidate: discovery.selected, timeoutMs: startupTimeoutSeconds * 1000 }));
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("rew_launch_execute", "Start the exact planned REW executable after explicit confirmation and verify its local API.", { plan: z.record(z.any()), confirmationToken: z.string(), confirm: z.boolean().default(false) }, async ({ plan, confirmationToken, confirm }) => {
  try {
    const p = verifyPlan(plan, confirmationToken);
    if (p.kind !== "rew-launch") throw new Error("Wrong plan kind");
    if (p.alreadyRunning) return result({ launched: false, alreadyRunning: true, apiReady: true, version: await rew("/version", { timeoutMs: 2000 }) });
    if (!confirm) throw new Error("Explicit confirmation required to start REW");
    return result(await launchRew({ candidate: p.candidate, timeoutMs: p.timeoutMs, probe: () => rew("/version", { timeoutMs: 1200 }) }));
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("rew_capability_negotiate", "Probe the live REW API and report which read-only command surfaces are available.", {}, async () => {
  const probes = [["version", "/version"], ["measurements", "/measurements"], ["measurementCommands", "/measure/commands"], ["audioStatus", "/audio/status"], ["generator", "/generator/commands"]];
  const entries = await Promise.all(probes.map(async ([name, path]) => {
    try { const value = await rew(path, { timeoutMs: 3000 }); return [name, { available: true, shape: Array.isArray(value) ? "array" : typeof value, count: Array.isArray(value) ? value.length : undefined, version: name === "version" ? value : undefined }]; }
    catch (error) { return [name, { available: false, error: String(error.message).slice(0, 300) }]; }
  }));
  return result({ schemaVersion: 1, negotiatedAt: new Date().toISOString(), capabilities: Object.fromEntries(entries), rule: "Run only workflows whose required REW capability is available." });
});

server.tool("a1_workspace_scan", "Inventory A1 Evo artifacts without modifying them.", { home: z.string().optional() }, async ({ home }) => {
  try {
    const root = await resolveHome(home), names = await readdir(root, { withFileTypes: true });
    const supported = new Set([".ady", ".avr", ".oca", ".mdat", ".html", ".txt"]);
    const files = [];
    for (const entry of names) if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
      const info = await stat(join(root, entry.name)); files.push({ name: entry.name, type: extname(entry.name).slice(1), bytes: info.size, modified: info.mtime.toISOString() });
    }
    return result({ workspace: root, platform: `${process.platform}/${process.arch}`, files: files.sort((a,b) => b.modified.localeCompare(a.modified)), facts: ["Inventory is read-only."] });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_inspect_artifact", "Inspect an ADY, AVR, OCA, target-curve, HTML report, or session log with bounded output.", { file: z.string(), home: z.string().optional() }, async ({ file, home }) => {
  try {
    const found = await resolveArtifact(home, file), extension = extname(found.path).toLowerCase();
    if ([".ady", ".avr", ".oca"].includes(extension)) {
      const data = JSON.parse(await readFile(found.path, "utf8"));
      const channels = (data.detectedChannels || data.channels || []).map((c, i) => ({ id: channelId(c, i), speakerType: c.speakerType, distanceMeters: c.distanceInMeters, trimDb: c.trimAdjustmentInDbs, crossoverHz: c.xover, positions: c.responseData ? Object.keys(c.responseData).length : undefined, filterTaps: Array.isArray(c.filter) ? c.filter.length : undefined }));
      return result({ source: found.rel, bytes: found.info.size, kind: extension.slice(1), receiver: { model: data.model || data.targetModelName, ipAddress: data.ipAddress, ampAssign: data.ampAssign, subwoofers: data.numberOfSubwoofers ?? data.subwooferNum, lpfForLfeHz: data.lpfForLFE, bassMode: data.bassMode }, channels });
    }
    const text = (await readFile(found.path, "utf8")).slice(0, TEXT_LIMIT);
    if (extension === ".txt" && !/session_log/i.test(found.rel)) {
      const points = parseCurve(text);
      if (points.length >= 2) return result({ source: found.rel, kind: "target-curve", points: points.length, frequencyRangeHz: [points[0].frequencyHz, points.at(-1).frequencyHz], levelRangeDb: [Math.min(...points.map(p=>p.levelDb)), Math.max(...points.map(p=>p.levelDb))] });
    }
    const lines = text.split(/\r?\n/), signals = lines.filter((line) => /error|warn|timeout|connect|transfer|upload|microphone|receiver/i.test(line));
    return result({ source: found.rel, kind: extension.slice(1), lines: lines.length, diagnosticSignals: signals.slice(-40) });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_analyze_measurements", "Analyze ADY impulse responses: timing, polarity, RMS/crest factor, and broad-band spectral balance. Interpretations are flagged separately.", { file: z.string(), home: z.string().optional(), sampleRateHz: z.number().int().min(8000).max(384000).default(48000) }, async ({ file, home, sampleRateHz }) => {
  try {
    const { rel, data } = await readJsonArtifact(home, file), channels = data.detectedChannels || [];
    if (!channels.length) throw new Error("no detectedChannels found");
    const analyzed = channels.map((channel, index) => {
      const responses = Object.entries(channel.responseData || {}).map(([position, values]) => {
        const stats = numericStats(values), peakValue = values[stats.peakIndex] || 0;
        return { position, peakDelayMs: stats.peakIndex / sampleRateHz * 1000, peakPolarity: Math.sign(peakValue), ...stats, bands: bandLevels(values, sampleRateHz) };
      });
      return { id: channelId(channel, index), responses };
    });
    const primary = analyzed.flatMap(c => c.responses.slice(0,1).map(r => ({ id:c.id, delay:r.peakDelayMs, polarity:r.peakPolarity })));
    const earliest = Math.min(...primary.map(x=>x.delay));
    const interpretations = primary.map(x => ({ channel: x.id, relativePeakDelayMs: x.delay - earliest, observation: x.polarity < 0 ? "Peak polarity is inverted relative to positive convention; verify wiring and measurement context." : "Peak polarity is positive at the dominant impulse." }));
    return result({ source: rel, assumptions: [`sampleRateHz=${sampleRateHz}`, "Broad-band levels are relative FFT energy, not a calibrated SPL response."], measured: analyzed, interpretations });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_compare_calibrations", "Compare two OCA calibration exports channel by channel.", { baseline: z.string(), candidate: z.string(), home: z.string().optional() }, async ({ baseline, candidate, home }) => {
  try {
    const a = await readJsonArtifact(home, baseline), b = await readJsonArtifact(home, candidate);
    const map = (data) => new Map((data.channels || []).map((c, i) => [channelId(c, i), c]));
    const am = map(a.data), bm = map(b.data), ids = [...new Set([...am.keys(), ...bm.keys()])].sort();
    const channels = ids.map((id) => {
      const x = am.get(id), y = bm.get(id);
      if (!x || !y) return { id, status: x ? "removed" : "added" };
      const xf = numericStats(x.filter || []), yf = numericStats(y.filter || []);
      return { id, distanceDeltaMeters: (y.distanceInMeters ?? 0) - (x.distanceInMeters ?? 0), trimDeltaDb: (y.trimAdjustmentInDbs ?? 0) - (x.trimAdjustmentInDbs ?? 0), crossover: [x.xover, y.xover], filterRms: [xf?.rms, yf?.rms], filterPeak: [xf?.peak, yf?.peak] };
    });
    return result({ baseline: a.rel, candidate: b.rel, receiverModel: [a.data.model, b.data.model], global: { lpfForLfeHz: [a.data.lpfForLFE, b.data.lpfForLFE], bassMode: [a.data.bassMode, b.data.bassMode] }, channels });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_validate_target_curve", "Validate an A1 Evo target curve and report engineering-relevant warnings.", { file: z.string(), home: z.string().optional() }, async ({ file, home }) => {
  try {
    const found = await resolveArtifact(home, file), points = parseCurve(await readFile(found.path, "utf8"));
    if (points.length < 2) throw new Error("fewer than two numeric frequency/level points found");
    const sorted = points.every((p,i) => !i || p.frequencyHz > points[i-1].frequencyHz), duplicates = points.filter((p,i) => i && p.frequencyHz === points[i-1].frequencyHz).map(p=>p.frequencyHz);
    const at1k = curveAt(points, 1000), warnings = [];
    if (points[0].frequencyHz > 3) warnings.push("Curve does not reach approximately 3 Hz.");
    if (points.at(-1).frequencyHz < 24000) warnings.push("Curve does not reach approximately 24 kHz.");
    if (at1k == null || Math.abs(at1k) > 0.25) warnings.push("Curve is not normalized near 0 dB at 1 kHz.");
    if (!sorted) warnings.push("Frequencies are not strictly increasing.");
    if (duplicates.length) warnings.push(`Duplicate frequencies: ${duplicates.join(", ")}`);
    for (let i=1;i<points.length;i++) if (Math.abs(points[i].levelDb-points[i-1].levelDb)>6) { warnings.push(`Abrupt >6 dB step near ${points[i].frequencyHz} Hz.`); break; }
    return result({ source: found.rel, valid: warnings.length === 0, points: points.length, rangeHz: [points[0].frequencyHz, points.at(-1).frequencyHz], levelAt1kHzDb: at1k, warnings, basis: "A1 Evo AcoustiX forum FAQ: roughly 3 Hz-24 kHz and 0 dB at 1 kHz." });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_diagnose_logs", "Summarize A1 Evo session logs with evidence lines and conservative remediation.", { home: z.string().optional(), file: z.string().optional() }, async ({ home, file }) => {
  try {
    const root = await resolveHome(home), names = file ? [file] : (await readdir(root)).filter(n => /^session_log_.*\.txt$/i.test(n));
    const findings = [];
    for (const name of names.slice(-30)) {
      const found = await resolveArtifact(root, name), lines = (await readFile(found.path,"utf8")).split(/\r?\n/);
      const evidence = lines.filter(l => /error|warn|timeout|ehost|microphone|port 3000|transfer|upload/i.test(l)).slice(-20);
      const actions = [];
      if (evidence.some(l=>/microphone.*not detected/i.test(l))) actions.push("Confirm the ACM1-X/calibration microphone is fully seated and headphones are disconnected.");
      if (evidence.some(l=>/EHOSTUNREACH|ECONNREFUSED/i.test(l))) actions.push("Verify the AVR IP, same-LAN reachability, and Network/IP Control=Always On.");
      if (evidence.some(l=>/port 3000.*in use/i.test(l))) actions.push("Close the other A1 Evo instance before launching another.");
      findings.push({ source: found.rel, evidence, actions });
    }
    return result({ findings, note: "Actions are tied only to matched evidence; no fault is inferred from absent data." });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_launch", "Launch the interactive A1 Evo application in a separate terminal. Requires confirmation.", { home: z.string().optional(), executable: z.string().optional(), confirm: z.boolean().default(false) }, async ({ home, executable, confirm }) => {
  try {
    if (!confirm) return result({ launched: false, requiresConfirmation: true, message: "Set confirm=true after verifying REW, AVR configuration, microphone, speaker wiring, and room readiness." });
    const root = await resolveHome(home);
    const path = await trustedA1Executable(root, executable);
    const spec = launchCommand(path, root), child = spawn(spec.command, spec.args, { ...spec.options, stdio: "ignore" }); child.unref();
    return result({ launched: true, executable: path, launcher: spec.command, pid: child.pid, note: "A1 Evo is interactive and owns its workflow; the MCP does not inject menu input." });
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("denon_probe", "Probe common Denon/Marantz LAN control ports without changing receiver state.", { host: z.string(), timeoutMs: z.number().int().min(200).max(10000).default(1500) }, async ({ host, timeoutMs }) => {
  try { return result({ host: assertHost(host), probes: await Promise.all([23,80,1256].map(p=>probePort(host,p,timeoutMs))), facts: ["23: legacy AVR text control", "80: receiver web control", "1256: A1/Audyssey control path observed in local A1 logs"] }); }
  catch (error) { return result({ error: error.message }, true); }
});

server.tool("denon_status", "Query power, volume, mute, input, and sound mode over the Denon/Marantz text protocol.", { host: z.string(), port: z.number().int().min(1).max(65535).default(23), timeoutMs: z.number().int().min(300).max(10000).default(2500) }, async ({ host, port, timeoutMs }) => {
  try { const responses = await tcpExchange(host, ["PW?","MV?","MU?","SI?","MS?"], port, timeoutMs); return result({ host, port, responses, changedState: false }); }
  catch (error) { return result({ error: error.message, hint: "Enable Network/IP Control=Always On and verify the model supports the legacy text protocol." }, true); }
});

server.tool("denon_control", "Send one allowlisted Denon/Marantz command. State-changing commands require confirm=true.", { host: z.string(), action: z.enum(["power_on","power_standby","mute_on","mute_off","volume_db","input"]), value: z.union([z.string(),z.number()]).optional(), confirm: z.boolean().default(false), port: z.number().int().min(1).max(65535).default(23) }, async ({ host, action, value, confirm, port }) => {
  try {
    const command = denonCommand(action, value);
    return result({ sent: false, deprecated: true, requiresPlan: true, requested: { host, port, action, value, command }, confirmedButNotExecuted: confirm === true, warning: "Direct receiver mutation is disabled. Use denon_snapshot, denon_propose_changes, review its baseline-bound diff, then denon_execute_plan." }, true);
  } catch (error) { return result({ error: error.message }, true); }
});

server.tool("a1_measurement_quality", "Score ADY measurement repeatability and flag timing, level, polarity, clipping, and missing-position anomalies. Scores are transparent heuristics.", { file: z.string(), home: z.string().optional(), sampleRateHz: z.number().int().min(8000).max(384000).default(48000) }, async ({ file, home, sampleRateHz }) => {
  try {
    const {rel,data}=await readJsonArtifact(home,file), channels=data.detectedChannels||[];
    if(!channels.length) throw new Error("no detectedChannels found");
    const reports=channels.map((channel,index)=>{
      const responses=Object.entries(channel.responseData||{}).map(([position,values])=>{
        const s=numericStats(values); return {position,rms:s?.rms||0,rmsDb:20*Math.log10((s?.rms||0)+1e-15),peak:s?.peak||0,peakIndex:s?.peakIndex||0,delayMs:(s?.peakIndex||0)/sampleRateHz*1000,polarity:Math.sign(values[s?.peakIndex||0]||0)};
      });
      let score=100; const issues=[];
      if(!responses.length){score=0;issues.push("No impulse responses.");}
      const delaySpread=responses.length?Math.max(...responses.map(r=>r.delayMs))-Math.min(...responses.map(r=>r.delayMs)):null;
      const levelSpread=responses.length?Math.max(...responses.map(r=>r.rmsDb))-Math.min(...responses.map(r=>r.rmsDb)):null;
      if(responses.some(r=>r.peak>=0.999)){score-=35;issues.push("Peak reaches digital full scale; possible clipping or normalization.");}
      if(responses.some(r=>r.rms<1e-7)){score-=35;issues.push("One or more responses have extremely low signal energy.");}
      if(delaySpread!=null&&delaySpread>1){score-=Math.min(30,Math.round(delaySpread*5));issues.push(`Repeat-position peak delay spread is ${delaySpread.toFixed(3)} ms.`);}
      if(levelSpread!=null&&levelSpread>3){score-=Math.min(25,Math.round(levelSpread*3));issues.push(`Repeat-position RMS spread is ${levelSpread.toFixed(2)} dB.`);}
      if(new Set(responses.map(r=>r.polarity)).size>1){score-=20;issues.push("Dominant impulse polarity changes across positions.");}
      return {channel:channelId(channel,index),score:Math.max(0,score),positions:responses.length,delaySpreadMs:delaySpread,levelSpreadDb:levelSpread,issues,measurements:responses};
    });
    return result({source:rel,overallScore:Math.round(reports.reduce((n,r)=>n+r.score,0)/reports.length),channels:reports,method:"Heuristic QC only. Thresholds flag retest candidates; they do not prove an acoustic fault.",assumptions:[`sampleRateHz=${sampleRateHz}`,"RMS values are relative digital impulse levels, not calibrated SPL."]});
  } catch(error){return result({error:error.message},true);}
});

server.tool("a1_crossover_headroom_advisor", "Evaluate OCA crossovers and approximate FIR/trim headroom using supplied speaker low-frequency limits.", { file:z.string(), home:z.string().optional(), speakers:z.array(z.object({channel:z.string(),f3Hz:z.number().positive(),continuousSplDb:z.number().optional()})).default([]), sampleRateHz:z.number().int().min(8000).max(384000).default(48000) }, async ({file,home,speakers,sampleRateHz})=>{
  try{
    const {rel,data}=await readJsonArtifact(home,file), specs=new Map(speakers.map(s=>[s.channel.toUpperCase(),s]));
    const channels=(data.channels||[]).map((c,i)=>{
      const id=channelId(c,i), spec=specs.get(id.toUpperCase()), crossover=spec?chooseCrossover(spec.f3Hz,c.xover):null, spectral=filterSpectralGain(c.filter,sampleRateHz), trim=Number(c.trimAdjustmentInDbs)||0;
      const combinedBoostDb=(spectral?.relativePeakGainDb||0)+Math.max(0,trim), warnings=[];
      if(crossover?.risk) warnings.push(crossover.risk);
      if(trim>6) warnings.push("Large positive trim reduces available AVR headroom.");
      if(combinedBoostDb>9) warnings.push("Approximate filter-plus-trim boost is high; validate clipping/headroom with measured playback.");
      if(!spec) warnings.push("No speaker F3 supplied; crossover suitability cannot be judged from the calibration file alone.");
      return {channel:id,currentCrossoverHz:c.xover,trimDb:trim,speakerSpec:spec||null,recommendation:crossover,filter:spectral,approximateCombinedBoostDb:combinedBoostDb,warnings};
    });
    return result({source:rel,receiverModel:data.model,channels,caveats:["1.5×F3 is a conservative starting heuristic, not a universal crossover rule.","FIR spectral gain is relative and cannot replace AVR clipping or acoustic compression measurements.","Do not lower a crossover merely because the speaker specification claims deeper extension."]});
  }catch(error){return result({error:error.message},true);}
});

server.tool("a1_subwoofer_integration_audit", "Audit OCA bass-management settings and optional ADY sub/main timing without changing the AVR.", { calibration:z.string(), measurements:z.string().optional(), home:z.string().optional(), sampleRateHz:z.number().int().min(8000).max(384000).default(48000) }, async ({calibration,measurements,home,sampleRateHz})=>{
  try{
    const oca=await readJsonArtifact(home,calibration), facts={subwoofers:oca.data.numberOfSubwoofers,lpfForLfeHz:oca.data.lpfForLFE,bassMode:oca.data.bassMode,crossovers:(oca.data.channels||[]).map((c,i)=>({channel:channelId(c,i),hz:c.xover}))}, warnings=[];
    if(oca.data.lpfForLFE!==120) warnings.push("LPF for LFE differs from the common 120 Hz soundtrack-channel ceiling; confirm this is intentional.");
    if(String(oca.data.bassMode).toUpperCase().includes("MAIN")) warnings.push("LFE+Main can duplicate bass depending on speaker-size/crossover configuration; verify with measurements.");
    let timing=null;
    if(measurements){const ady=await readJsonArtifact(home,measurements);const peaks=(ady.data.detectedChannels||[]).map((c,i)=>{const v=Object.values(c.responseData||{})[0]||[];const s=numericStats(v);return {channel:channelId(c,i),delayMs:s?s.peakIndex/sampleRateHz*1000:null};});const subs=peaks.filter(p=>/^SW|SUB/i.test(p.channel)),mains=peaks.filter(p=>/^(FL|FR|C)$/i.test(p.channel));timing={peaks,subVsEarliestMainMs:subs.length&&mains.length?subs.map(s=>({channel:s.channel,deltaMs:s.delayMs-Math.min(...mains.map(m=>m.delayMs))})):[],caveat:"Dominant impulse peak timing is a screening metric; crossover phase alignment requires band-limited phase/impulse analysis."};}
    return result({source:{calibration:oca.rel,measurements:measurements||null},facts,timing,warnings,recommendations:["Preserve the current calibration before changing bass management.","Validate crossover-region summation at multiple seats, not only raw subwoofer level.","Treat reported subwoofer distance as delay compensation, not tape-measure distance."]});
  }catch(error){return result({error:error.message},true);}
});

server.tool("speaker_layout_validate", "Calculate speaker azimuth/elevation from room coordinates and compare supported roles with broad Dolby placement windows.", { listener:z.object({x:z.number(),y:z.number(),z:z.number()}), speakers:z.array(z.object({id:z.string(),role:z.string(),x:z.number(),y:z.number(),z:z.number()})).min(1), units:z.enum(["meters","feet"]).default("meters") }, async ({listener,speakers,units})=>{
  try{
    const scale=units==="feet"?0.3048:1, l={x:listener.x*scale,y:listener.y*scale,z:listener.z*scale};
    const analyzed=speakers.map(s=>{const m={...s,x:s.x*scale,y:s.y*scale,z:s.z*scale},angles=speakerAngles(l,m),target=placementTarget(s.role),issues=[];if(target&&(angles.azimuthDeg<target.az[0]||angles.azimuthDeg>target.az[1]))issues.push(`Azimuth outside ${target.az[0]}° to ${target.az[1]}° window.`);if(target&&(angles.elevationDeg<target.el[0]||angles.elevationDeg>target.el[1]))issues.push(`Elevation outside ${target.el[0]}° to ${target.el[1]}° window.`);if(!target)issues.push("No built-in target for this role; angles are reported without judgment.");return {id:s.id,role:s.role,...angles,target,issues};});
    return result({coordinateConvention:"Listener faces +Y; +X is right; +Z is up.",speakers:analyzed,caveats:["Windows are broad implementation guidance, not a substitute for the exact Dolby layout drawing for your configuration.","Room boundaries, directivity, sightlines, and construction constraints still matter."]});
  }catch(error){return result({error:error.message},true);}
});

server.tool("a1_target_curve_design", "Design a smooth A1-compatible house curve and optionally write it to target_curves after explicit confirmation.", { bassBoostDb:z.number().min(-6).max(15).default(6), bassShelfEndHz:z.number().min(20).max(300).default(80), trebleTiltDb:z.number().min(-12).max(6).default(-2), points:z.number().int().min(20).max(500).default(121), filename:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _().-]*\.txt$/).optional(), home:z.string().optional(), confirmWrite:z.boolean().default(false) }, async ({bassBoostDb,bassShelfEndHz,trebleTiltDb,points,filename,home,confirmWrite})=>{
  try{
    const curve=designCurve({bassBoostDb,bassShelfEndHz,trebleTiltDb,points}), preview=curve.filter((_,i)=>i%Math.max(1,Math.floor(points/12))===0).concat(curve.at(-1));
    let written=null;
    if(filename){if(!confirmWrite)return result({written:false,requiresConfirmation:true,filename,preview,warning:"Writing a target curve changes the A1 workspace. Reissue with confirmWrite=true."});const root=await resolveHome(home),dir=join(root,"target_curves");await mkdir(dir,{recursive:true});const path=resolve(dir,filename);if(relative(dir,path).startsWith(".."))throw new Error("invalid target curve path");await writeFile(path,curve.map(p=>`${p.frequencyHz}\t${p.levelDb}`).join(os.EOL)+os.EOL,"utf8");written=path;}
    return result({parameters:{bassBoostDb,bassShelfEndHz,trebleTiltDb,points},preview,written,validation:{rangeHz:[3,24000],levelAt1kHzDb:0},caveats:["This is a smooth starting curve, not a prediction of in-room sound.","Choose bass boost from measured headroom and level-matched preference; do not assume more boost is safe."]});
  }catch(error){return result({error:error.message},true);}
});

server.tool("audio_claims", "Retrieve structured engineering claims filtered by topic, model, evidence type, and confidence.", { topic:z.string().optional(), model:z.string().optional(), evidenceType:z.enum(["manufacturer","software-author","measurement","community","heuristic"]).optional(), minimumConfidence:z.enum(["low","medium","high"]).default("medium") }, async ({topic,model,evidenceType,minimumConfidence})=>{
  try{const claims=JSON.parse(await readFile(join(PLUGIN_ROOT,"knowledge","claims.json"),"utf8")),rank={low:1,medium:2,high:3};const filtered=claims.filter(c=>rank[c.confidence]>=rank[minimumConfidence]&&(!topic||c.topic.toLowerCase().includes(topic.toLowerCase())||c.claim.toLowerCase().includes(topic.toLowerCase()))&&(!model||c.applicability.some(a=>a.toLowerCase().includes(model.toLowerCase())||a==="general"))&&(!evidenceType||c.evidenceType===evidenceType));return result({count:filtered.length,claims:filtered});}catch(error){return result({error:error.message},true);}
});

server.tool("audio_knowledge_search", "Search curated, provenance-tagged A1 Evo and audio-engineering guidance bundled with this plugin.", { query: z.string().min(2), limit: z.number().int().min(1).max(20).default(8) }, async ({ query, limit }) => {
  try {
    const dir=join(PLUGIN_ROOT,"knowledge"), files=(await readdir(dir)).filter(f=>f.endsWith(".md")), terms=query.toLowerCase().split(/\W+/).filter(t=>t.length>2), hits=[];
    for(const file of files){ const text=await readFile(join(dir,file),"utf8"); for(const section of text.split(/\n(?=## )/)){ const score=terms.reduce((n,t)=>n+(section.toLowerCase().split(t).length-1),0); if(score) hits.push({source:file,score,excerpt:section.slice(0,1600)}); } }
    hits.sort((a,b)=>b.score-a.score); return result({query,hits:hits.slice(0,limit),caveat:"Forum reports are community evidence, not guaranteed facts. Prefer measured artifacts and receiver documentation."});
  } catch(error){ return result({error:error.message},true); }
});

registerAdvancedTools(server, { z, result, resolveHome, resolveArtifact, readJsonArtifact, tcpExchange, assertHost, pluginRoot: PLUGIN_ROOT });
registerPresetTools(server, { z, result, resolveHome, resolveArtifact, tcpExchange, assertHost });
registerA1TerminalTools(server, { z, result, resolveHome });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await server.connect(new StdioServerTransport());
}
