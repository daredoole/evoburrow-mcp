import test from "node:test";
import assert from "node:assert/strict";
import { internals } from "../server.mjs";

test("opt-in Denon hardware loop performs read-only identity/status queries",{skip:!process.env.EVOBURROW_HIL_DENON_HOST},async()=>{
  const host=internals.assertHost(process.env.EVOBURROW_HIL_DENON_HOST),port=Number(process.env.EVOBURROW_HIL_DENON_PORT||23);
  const replies=await internals.tcpExchange(host,["PW?","MV?","MU?","SI?","MS?","SPPR ?"],port,5000);
  assert.ok(replies.some(line=>/^PW/.test(line))); assert.ok(replies.some(line=>/^MV/.test(line)));
});
