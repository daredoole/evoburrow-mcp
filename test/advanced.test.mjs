import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { z } from "zod";
import { advancedInternals, decodeDenonLine, registerAdvancedTools } from "../advanced.mjs";
import { internals } from "../server.mjs";

test("X1800H protocol responses decode into readable fields",()=>{
  assert.deepEqual(decodeDenonLine("MV655"),{raw:"MV655",field:"masterVolume",relativeDb:-14.5,display:"-14.5 dB"});
  assert.equal(decodeDenonLine("SIBD").value,"BD");
  assert.equal(decodeDenonLine("MSDOLBY AUDIO-DSUR").upmixer,"Dolby Surround");
  assert.deepEqual(decodeDenonLine("SPPR 1"),{raw:"SPPR 1",field:"speakerPreset",value:1});
});

test("Speaker Preset verification accepts Denon SPPR replies",()=>{
  assert.equal(advancedInternals.matchesSpeakerPreset(["SPPR 1"],1),true);
  assert.equal(advancedInternals.matchesSpeakerPreset(["SPPR2"],2),true);
  assert.equal(advancedInternals.matchesSpeakerPreset(["SPPR 2"],1),false);
});

test("REW configuration preserves the global microphone calibration",()=>{
  const payload=advancedInternals.inputCalRestorePayload({inputDeviceIsCWeighted:false,calDataAllInputs:{calFilePath:"/tmp/mic.txt",dBFSAt94dBSPL:-22.9,fullScaleSineVrms:1}});
  assert.deepEqual(payload,{separateCalFileForEachInput:false,inputDeviceIsCWeighted:false,calDataAllInputs:{calFilePath:"/tmp/mic.txt",dBFSAt94dBSPL:-22.9,fullScaleSineVrms:1}});
  assert.equal(advancedInternals.inputCalRestorePayload({calDataAllInputs:{calFilePath:""}}),null);
});

test("series parser tolerates corrupt tokens without executing content",()=>{
  assert.deepEqual(advancedInternals.parseSeries("1, 2, NaN, nope, 3"),[1,2,3]);
  const encoded=Buffer.alloc(12);encoded.writeFloatBE(52.5,0);encoded.writeFloatBE(-128.25,4);encoded.writeFloatBE(0,8);
  assert.deepEqual(advancedInternals.parseSeries(encoded.toString("base64")),[52.5,-128.25,0]);
  for(let i=0;i<250;i++)assert.doesNotThrow(()=>advancedInternals.parseSeries(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))));
});

test("workspace path guard rejects traversal, wrong extensions, and symlink escapes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"a1-path-")),outside=await mkdtemp(join(tmpdir(),"a1-out-"));
  await writeFile(join(root,"ok.mdat"),"x");await writeFile(join(outside,"secret.mdat"),"x");await mkdir(join(root,"links"));await symlink(join(outside,"secret.mdat"),join(root,"links","escape.mdat"));
  assert.equal(await advancedInternals.canonicalInside(root,"ok.mdat",[".mdat"]),await realpath(join(root,"ok.mdat")));
  await assert.rejects(()=>advancedInternals.canonicalInside(root,"../secret.mdat",[".mdat"]));
  await assert.rejects(()=>advancedInternals.canonicalInside(root,"ok.mdat",[".oca"]));
  await assert.rejects(()=>advancedInternals.canonicalInside(root,"links/escape.mdat",[".mdat"]));
});

test("confirmation tokens bind the complete target and change set",()=>{
  const a=advancedInternals.token({host:"192.0.2.11",changes:{mute:true},commands:["MUON"]});
  const b=advancedInternals.token({host:"192.0.2.11",changes:{mute:false},commands:["MUOFF"]});
  assert.notEqual(a,b);assert.equal(a.length,64);
});

test("REW post-measurement plans are tamper evident",()=>{
  const unsigned={kind:"rew-post-calibration-measurements",request:{host:"192.0.2.11",runs:[{speakerPreset:1,title:"P1 FL"}]}};
  const plan=advancedInternals.planWithToken(unsigned);
  assert.equal(advancedInternals.token(advancedInternals.unsignedPlan(plan)),plan.confirmationToken);
  assert.notEqual(advancedInternals.token({...advancedInternals.unsignedPlan(plan),request:{...plan.request,runs:[{speakerPreset:2,title:"P2 FL"}]}}),plan.confirmationToken);
});

test("REW Denon volume encoder enforces safe protocol range",()=>{
  assert.equal(advancedInternals.denonVolume(-30),"MV50");
  assert.equal(advancedInternals.denonVolume(-29.5),"MV505");
  assert.throws(()=>advancedInternals.denonVolume(-81));
});

test("REW protection mapper enables clipping and SPL guards",()=>{
  const x=advancedInternals.safeProtection({abortOnClipping:false,abortOnExcessSpl:false,maxSpl:110},95);
  assert.equal(x.clippingGuard,true);
  assert.equal(x.splGuard,true);
  assert.equal(x.options.abortOnClipping,true);
  assert.equal(x.options.abortOnExcessSpl,true);
  assert.equal(x.options.maxSpl,95);
});

test("scoring reports uncertainty instead of fabricating missing evidence",()=>{
  const x=advancedInternals.scoreCalibration({ady:{score:90},oca:null,rew:null,avr:null});
  assert.equal(x.score,90);assert.equal(x.confidence,"low");assert.deepEqual(x.missing,["oca","html","rew","avr"]);
});

test("fake Denon protocol handles replies and timeout/reconnect",async()=>{
  let connections=0;
  const fake=createServer(socket=>{connections++;socket.on("data",chunk=>{if(chunk.toString().includes("PW?"))socket.write("PWON\rMV655\r")})});
  await new Promise(r=>fake.listen(0,"127.0.0.1",r));const port=fake.address().port;
  const first=await internals.tcpExchange("127.0.0.1",["PW?"],port,250);
  const second=await internals.tcpExchange("127.0.0.1",["PW?"],port,250);
  assert.deepEqual(first,["PWON","MV655"]);assert.deepEqual(second,first);assert.equal(connections,2);
  await new Promise(r=>fake.close(r));
  const sockets=new Set(),silent=createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket))});await new Promise(r=>silent.listen(0,"127.0.0.1",r));
  const started=Date.now(),timed=await internals.tcpExchange("127.0.0.1",["PW?"],silent.address().port,100);
  assert.deepEqual(timed,[]);assert.ok(Date.now()-started<1000);for(const socket of sockets)socket.destroy();await new Promise(r=>silent.close(r));
});

test("advanced MCP callbacks exercise safe inventory, Denon transaction, scoring, and A/B paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "evo-advanced-tools-"));
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const decode = response => JSON.parse(response.content[0].text);
  let state = { power: "ON", mute: false, input: "BD", masterVolume: -20 };
  const tcpExchange = async (_host, commands) => commands.flatMap(command => {
    if (command === "PW?") return [`PW${state.power}`];
    if (command === "MU?") return [`MU${state.mute ? "ON" : "OFF"}`];
    if (command === "SI?") return [`SI${state.input}`];
    if (command === "MV?") return [advancedInternals.denonVolume(state.masterVolume)];
    if (command.startsWith("PW")) state.power = command.slice(2);
    if (command.startsWith("MU")) state.mute = command.slice(2) === "ON";
    if (command.startsWith("SI")) state.input = command.slice(2);
    if (command.startsWith("MV") && command !== "MV?") state.masterVolume = decodeDenonLine(command).relativeDb;
    return [];
  });
  registerAdvancedTools(server, {
    z,
    result,
    resolveHome: async () => realpath(home),
    resolveArtifact: async (_home, file) => join(home, file),
    readJsonArtifact: async () => ({ data: {} }),
    tcpExchange,
    pluginRoot: join(process.cwd())
  });

  assert.ok(handlers.size >= 20);
  assert.equal(decode(await handlers.get("receiver_models")({ model: "X1800H" })).count, 1);
  assert.deepEqual(decode(await handlers.get("speaker_inventory_detect")({ home })).channels, []);
  const profiles = [{ channel: "FL", manufacturer: "ELAC", model: "Debut 2.0 B5.2" }];
  assert.equal(decode(await handlers.get("speaker_profile_save")({ profiles, home, confirm: false })).requiresConfirmation, true);
  assert.equal(decode(await handlers.get("speaker_profile_save")({ profiles, home, confirm: true })).saved, true);
  assert.equal(decode(await handlers.get("denon_decode")({ lines: ["MV655", "SIBD"] })).decoded.length, 2);
  const snapshot = decode(await handlers.get("denon_snapshot")({ host: "127.0.0.1", port: 23 }));
  assert.equal(snapshot.state.masterVolume, -20);
  const proposed = decode(await handlers.get("denon_propose_changes")({ host: "127.0.0.1", port: 23, changes: { mute: true, volumeDb: -25 } }));
  assert.match(proposed.warning, /confirm=true/);
  const executed = decode(await handlers.get("denon_execute_plan")({ plan: proposed.plan, confirm: true, confirmationToken: proposed.confirmationToken }));
  assert.equal(executed.executed, true);
  assert.equal(state.mute, true);
  assert.equal(state.masterVolume, -25);
  assert.equal(decode(await handlers.get("calibration_report_score")({})).confidence, "low");
  const ab = decode(await handlers.get("ab_test_plan")({ baseline: { name: "A", preset: "1", volumeDb: -30 }, candidate: { name: "B", preset: "2", volumeDb: -31 }, trials: 8 }));
  assert.equal(ab.levelOffsetDb, 1);
  assert.equal(ab.order.length, 8);
});
