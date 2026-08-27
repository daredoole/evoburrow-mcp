import test from "node:test";
import assert from "node:assert/strict";
import { presetInternals } from "../preset-tools.mjs";

test("preset HTML metadata separates target and low-volume shaping",()=>{
 const x=presetInternals.parseRun("targetCurve: Dirac Harman 6dB.txt<br>lowVolListeningOffset: 8.5<br>lowVolListeningOffsetHi: 2.4<br>");
 assert.deepEqual(x,{targetCurve:"Dirac Harman 6dB.txt",measurementFile:null,lowVolumeBassDb:8.5,lowVolumeTrebleDb:2.4});
});

test("preset binding token changes with slot, artifact, and Audyssey curve",()=>{
 const a={device:{host:"192.0.2.11",model:"X1800H"},speakerPreset:1,artifact:"a.oca",artifactSha256:"abc",label:"A",audysseyCurve:"Flat",intendedContent:"general",status:"planned",verificationNote:null};
 assert.notEqual(presetInternals.confirmation(a),presetInternals.confirmation({...a,speakerPreset:2}));
 assert.notEqual(presetInternals.confirmation(a),presetInternals.confirmation({...a,audysseyCurve:"Reference"}));
});

test("calibration summary tracks both Flat and Reference filter presence",()=>{
 const x=presetInternals.calibrationSummary({model:"X1800H",channels:[{commandId:"FL",xover:80,filter:[1],filterLV:[2]}]});
 assert.equal(x.channels[0].hasFlatFilter,true);assert.equal(x.channels[0].hasReferenceFilter,true);
});

test("Quick Select state parsing and restoration are bounded to allowlisted fields",()=>{
 const state=presetInternals.firstState(["SPPR 2","PWON","MV625","MUON","SIBD","MSDIRECT","PSDYNEQ OFF","PSDYNVOL OFF"]);
 assert.equal(state.speakerPreset,2);assert.equal(state.soundMode,"DIRECT");
 assert.deepEqual(presetInternals.restoreCommands(state),["MUON","SPPR 2","SIBD","MV625","MSDIRECT","PSDYNEQ OFF","PSDYNVOL OFF","MUON"]);
});
