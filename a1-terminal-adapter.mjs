import os from "node:os";
import { access, appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node-pty";

const ESC = "\u001b";
const MAIN = { express:0, sub_level:1, measure:2, optimize_default:3, transfer:4, customize:5, replace_config:6, exit:7 };
export const stripAnsi = s => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "");
export const confirmationToken = plan => createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0,24);

function executableFor(home, supplied) {
  if (supplied) return resolve(home, supplied);
  if (process.platform === "win32") return resolve(home, "a1-evo-acoustix-win-x64.exe");
  if (process.platform === "darwin") return resolve(home, process.arch === "arm64" ? "a1-evo-acoustix-macos-arm64" : "a1-evo-acoustix-macos-x64");
  return resolve(home, "a1-evo-acoustix-linux-x64");
}

async function artifact(path, extension) {
  const p=resolve(path); if (!p.toLowerCase().endsWith(extension)) throw new Error(`Expected ${extension} artifact`);
  const data=await readFile(p); return {path:p,name:basename(p),bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};
}

export async function makePlan({home, action, executable, artifactPath, preset, positions, repeats, centeringCheck=false}) {
  const exe=executableFor(home,executable); await access(exe,fsConstants.X_OK);
  const plan={version:1,action,home:resolve(home),executable:exe,platform:process.platform,arch:process.arch};
  const receiver=JSON.parse(await readFile(resolve(home,"receiver_config.avr"),"utf8"));
  if(!receiver.targetModelName || !receiver.ipAddress) throw new Error("receiver_config.avr is missing targetModelName or ipAddress");
  plan.receiver={model:receiver.targetModelName,ipAddress:receiver.ipAddress};
  if(action==="transfer"){ if(![1,2].includes(preset)) throw new Error("preset must be 1 or 2"); plan.preset=preset; plan.artifact=await artifact(artifactPath,".oca"); }
  if(action==="measure"){ if(!Number.isInteger(positions)||positions<1||positions>20) throw new Error("positions must be 1..20"); if(!Number.isInteger(repeats)||repeats<1||repeats>9) throw new Error("repeats must be 1..9"); plan.positions=positions; plan.repeats=repeats; plan.centeringCheck=!!centeringCheck; }
  plan.token=confirmationToken(plan); return plan;
}

class Session {
  constructor(plan, timeoutMs){ this.plan=plan; this.timeoutMs=timeoutMs; this.clean=""; this.raw=""; this.cursor=0; this.proc=null; }
  async start(){
    const lock=resolve(this.plan.home,".a1-terminal-adapter.lock"); this.lock=lock;
    try{this.lockHandle=await open(lock,"wx");}catch{throw new Error("A1 adapter is already active (lock exists)");}
    await this.lockHandle.writeFile(JSON.stringify({pid:process.pid,action:this.plan.action,started:new Date().toISOString()}));
    const logDir=resolve(this.plan.home,"adapter-logs"); await mkdir(logDir,{recursive:true});
    this.liveLog=resolve(logDir,`${new Date().toISOString().replace(/[:.]/g,"-")}-${this.plan.action}-live.log`); await writeFile(this.liveLog,"");
    this.proc=spawn(this.plan.executable,[],{name:"xterm-256color",cols:140,rows:42,cwd:this.plan.home,env:{...process.env,TERM:"xterm-256color"}});
    this.proc.onData(d=>{this.raw+=d;this.clean=stripAnsi(this.raw);appendFile(this.liveLog,stripAnsi(d)).catch(()=>{});});
    this.exitPromise=new Promise(resolveExit=>this.proc.onExit(resolveExit)); return this;
  }
  send(s){this.proc.write(s);}
  async wait(pattern, timeout=this.timeoutMs){
    const start=Date.now(); const rx=typeof pattern==="string"?null:pattern;
    while(Date.now()-start<timeout){const view=this.clean.slice(this.cursor); const found=rx?rx.test(view):view.includes(pattern); if(found){this.cursor=this.clean.length;return view;} await new Promise(r=>setTimeout(r,50));}
    throw new Error(`Timed out waiting for ${pattern}`);
  }
  async menu(index){await this.wait("Main Menu");this.send(ESC+"[H"+(ESC+"[B").repeat(index)+"\r");}
  async finish(success){
    const logDir=resolve(this.plan.home,"adapter-logs"); await mkdir(logDir,{recursive:true});
    const log=resolve(logDir,`${new Date().toISOString().replace(/[:.]/g,"-")}-${this.plan.action}.log`); await writeFile(log,this.clean);
    try{if(this.proc) this.proc.kill();}catch{} try{await this.lockHandle?.close();}catch{} await rm(this.lock,{force:true});
    return {success,log,tail:this.clean.split("\n").slice(-35).join("\n")};
  }
}

async function transfer(plan, timeoutMs){
  const s=await new Session(plan,timeoutMs).start();
  try{
    await s.menu(MAIN.transfer); await s.wait(/Select.*calibration|calibration.*file/i);
    s.send(ESC+"[F\r"); await s.wait(/full path|path.*\.oca/i); s.send(plan.artifact.path+"\r");
    await s.wait(/preset|Speaker Preset/i); s.send(String(plan.preset)+"\r");
    const out=await s.wait(/All calibration settings transferred successfully|Transfer complete|failed|error/i,timeoutMs);
    if(/failed|error/i.test(out)&&!/0 errors|without error/i.test(out)) throw new Error("A1 reported a transfer error; inspect transcript");
    return await s.finish(true);
  }catch(e){const end=await s.finish(false); throw Object.assign(e,{adapter:end});}
}

async function measure(plan, timeoutMs){
  if(plan.positions!==1) throw new Error("Automated execution is limited to one microphone position; multi-position runs require a human to move and confirm the microphone at each prompt");
  const s=await new Session(plan,timeoutMs).start();
  try{
    await s.menu(MAIN.measure);
    // The adapter answers only bounded setup prompts; microphone movement remains explicit.
    let completedPositions=0;
    while(completedPositions<plan.positions){
      const view=await s.wait(/subwoofer power mode|centering check|number of microphone positions|number of .*repeat|measurement repeats per speaker|Press Enter to begin|Ready to begin measurements|Move microphone to position|measurement.*complete|microphone.*not detected|Critical error/i,timeoutMs);
      if(/not detected|Critical error/i.test(view)) throw new Error("A1 did not detect the AVR calibration microphone");
      if(/subwoofer power mode/i.test(view)) s.send("y\r");
      else if(/centering check/i.test(view)) s.send((plan.centeringCheck?"y":"n")+"\r");
      else if(/number of .*repeat|measurement repeats per speaker/i.test(view)) s.send(String(plan.repeats)+"\r");
      else if(/number of microphone positions/i.test(view)) s.send(String(plan.positions)+"\r");
      else if(/Press Enter to begin|Ready to begin measurements/i.test(view)){s.send("\r");completedPositions++;}
      else break;
    }
    let manualRetries=0;
    for(;;){
      const end=await s.wait(/microphone position\(s\).*successfully completed|All channels measured.*saving|saved.*\.ady|Press Enter to retry|type 'skip'|process failed|error interrupted/i,timeoutMs);
      if(/Press Enter to retry|type 'skip'/i.test(end)){
        if(manualRetries++>=1) throw new Error("A1 exhausted the adapter's bounded manual retry");
        s.send("\r"); continue;
      }
      if(/process failed|error interrupted/i.test(end)) throw new Error("A1 measurement process failed");
      break;
    }
    return await s.finish(true);
  }catch(e){const end=await s.finish(false); throw Object.assign(e,{adapter:end});}
}

export async function runPlan(plan,{confirm,token,timeoutMs=900000}={}){
  if(confirm!==true) throw new Error("confirm=true is required immediately before launching A1");
  const expected=confirmationToken({...plan,token:undefined});
  // Accept tokens made before token was appended to the plan.
  if(token!==plan.token || plan.token!==expected) throw new Error("Plan token mismatch; regenerate the plan");
  const current=JSON.parse(await readFile(resolve(plan.home,"receiver_config.avr"),"utf8"));
  if(current.targetModelName!==plan.receiver?.model || current.ipAddress!==plan.receiver?.ipAddress) throw new Error("AVR identity changed after planning; regenerate the plan");
  if(plan.action==="transfer") return transfer(plan,timeoutMs);
  if(plan.action==="measure") return measure(plan,timeoutMs);
  throw new Error("Unsupported executable action");
}

export function registerA1TerminalTools(server,{z,result,resolveHome}){
  const planSchema={action:z.enum(["transfer","measure"]),executable:z.string().optional(),artifactPath:z.string().optional(),preset:z.number().int().min(1).max(2).optional(),positions:z.number().int().min(1).max(20).default(1),repeats:z.number().int().min(1).max(9).default(3),centeringCheck:z.boolean().default(false)};
  server.tool("a1_terminal_capabilities","Report guarded terminal workflows and platform support.",{},async()=>result({platform:process.platform,arch:process.arch,pty:"node-pty/ConPTY",workflows:Object.keys(MAIN),automated:["transfer","measure"],measurementSafety:"Mic placement prompts are preserved; position changes cannot be physically verified."}));
  server.tool("a1_terminal_plan","Create a hash-bound plan for an A1 transfer or measurement run.",planSchema,async args=>{try{return result(await makePlan({home:resolveHome(),...args}));}catch(e){return result({error:e.message},true);}});
  server.tool("a1_terminal_execute","Execute an exact A1 terminal plan. Requires the full plan, its token, and confirm=true.",{plan:z.record(z.any()),token:z.string(),confirm:z.boolean(),timeoutMs:z.number().int().min(30000).max(1800000).default(900000)},async args=>{try{return result(await runPlan(args.plan,args));}catch(e){return result({error:e.message,transcript:e.adapter},true);}});
}
