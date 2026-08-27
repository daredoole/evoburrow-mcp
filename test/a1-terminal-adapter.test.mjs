import test from "node:test";
import assert from "node:assert/strict";
import { confirmationToken, stripAnsi } from "../a1-terminal-adapter.mjs";

test("terminal transcript strips ANSI control sequences",()=>assert.equal(stripAnsi("\u001b[32mOK\u001b[0m\r\n"),"OK\n"));
test("confirmation token is stable and change-sensitive",()=>{
  const a={action:"transfer",preset:2};
  assert.equal(confirmationToken(a),confirmationToken({...a}));
  assert.notEqual(confirmationToken(a),confirmationToken({...a,preset:1}));
});
