import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationToken, makePlan, runPlan, stripAnsi } from "../a1-terminal-adapter.mjs";

test("terminal transcript strips ANSI control sequences",()=>assert.equal(stripAnsi("\u001b[32mOK\u001b[0m\r\n"),"OK\n"));
test("confirmation token is stable and change-sensitive",()=>{
  const a={action:"transfer",preset:2};
  assert.equal(confirmationToken(a),confirmationToken({...a}));
  assert.notEqual(confirmationToken(a),confirmationToken({...a,preset:1}));
});

async function workspace() {
  const home=await mkdtemp(join(tmpdir(),"evoburrow-terminal-"));
  const executable=join(home,"a1-evo-acoustix-linux-x64");
  await writeFile(executable,"#!/bin/sh\nexit 0\n"); await chmod(executable,0o755);
  await writeFile(join(home,"receiver_config.avr"),JSON.stringify({targetModelName:"AVR-X1800H",ipAddress:"192.168.1.11"}));
  await writeFile(join(home,"test.oca"),JSON.stringify({filters:[]}));
  return {home,executable};
}

test("terminal plan binds canonical executable, receiver config, and OCA bytes",async()=>{
  if(process.platform!=="linux") return;
  const {home}=await workspace();
  const plan=await makePlan({home,action:"transfer",artifactPath:"test.oca",preset:2});
  assert.equal(plan.version,2); assert.equal(plan.executableIdentity.sha256.length,64);
  assert.equal(plan.receiverConfigIdentity.sha256.length,64); assert.equal(plan.artifact.sha256.length,64);
  assert.equal(plan.token,confirmationToken({...plan,token:undefined}));
});

test("terminal plan rejects arbitrary executables and symlink escapes",async()=>{
  if(process.platform!=="linux") return;
  const {home}=await workspace(),outside=await mkdtemp(join(tmpdir(),"evoburrow-outside-"));
  const evil=join(outside,"a1-evo-acoustix-linux-x64"); await writeFile(evil,"#!/bin/sh\nexit 0\n"); await chmod(evil,0o755);
  await assert.rejects(()=>makePlan({home,action:"measure",executable:"/bin/sh",positions:1,repeats:1}),/platform A1 binary/);
  await writeFile(join(home,"a1-evo-acoustix-linux-x64"),"replacement");
  await symlink(evil,join(home,"trusted-link"));
  await assert.rejects(()=>makePlan({home,action:"measure",executable:"trusted-link",positions:1,repeats:1}),/platform A1 binary/);
});

test("terminal execution rejects OCA changes before launching A1",async()=>{
  if(process.platform!=="linux") return;
  const {home}=await workspace();
  const plan=await makePlan({home,action:"transfer",artifactPath:"test.oca",preset:1});
  await writeFile(join(home,"test.oca"),JSON.stringify({filters:[1]}));
  await assert.rejects(()=>runPlan(plan,{confirm:true,token:plan.token,timeoutMs:30000}),/OCA artifact changed/);
  assert.match(await readFile(join(home,"test.oca"),"utf8"),/filters/);
});

test("terminal plans reject incomplete receiver data and unsafe action parameters",async()=>{
  if(process.platform!=="linux") return;
  const {home}=await workspace();
  await writeFile(join(home,"receiver_config.avr"),JSON.stringify({targetModelName:"AVR-X1800H"}));
  await assert.rejects(()=>makePlan({home,action:"measure",positions:1,repeats:1}),/missing targetModelName or ipAddress/);
  await writeFile(join(home,"receiver_config.avr"),JSON.stringify({targetModelName:"AVR-X1800H",ipAddress:"192.168.1.11"}));
  await assert.rejects(()=>makePlan({home,action:"transfer",artifactPath:"test.oca",preset:3}),/preset/);
  await assert.rejects(()=>makePlan({home,action:"transfer",artifactPath:"receiver_config.avr",preset:1}),/Expected .oca/);
  await assert.rejects(()=>makePlan({home,action:"measure",positions:0,repeats:1}),/positions/);
  await assert.rejects(()=>makePlan({home,action:"measure",positions:1,repeats:10}),/repeats/);
});

test("terminal execution rejects missing confirmation, token tampering, executable changes, and receiver drift",async()=>{
  if(process.platform!=="linux") return;
  let ws=await workspace(),plan=await makePlan({home:ws.home,action:"measure",positions:1,repeats:1});
  await assert.rejects(()=>runPlan(plan,{confirm:false,token:plan.token}),/confirm=true/);
  await assert.rejects(()=>runPlan(plan,{confirm:true,token:"0".repeat(64)}),/token mismatch/);
  await writeFile(ws.executable,"#!/bin/sh\nexit 1\n"); await chmod(ws.executable,0o755);
  await assert.rejects(()=>runPlan(plan,{confirm:true,token:plan.token}),/executable changed/);
  ws=await workspace(); plan=await makePlan({home:ws.home,action:"measure",positions:1,repeats:1});
  await writeFile(join(ws.home,"receiver_config.avr"),JSON.stringify({targetModelName:"AVR-X1800H",ipAddress:"192.168.1.12"}));
  await assert.rejects(()=>runPlan(plan,{confirm:true,token:plan.token}),/receiver_config.avr changed/);
});
