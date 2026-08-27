import test from "node:test";
import assert from "node:assert/strict";
import { internals } from "../server.mjs";

test("numericStats finds peak and RMS", () => {
  const s = internals.numericStats([0, -1, 0.5, 0]);
  assert.equal(s.peak, 1);
  assert.equal(s.peakIndex, 1);
  assert.ok(Math.abs(s.rms - Math.sqrt(1.25 / 4)) < 1e-12);
});

test("target curve parser and log interpolation", () => {
  const points = internals.parseCurve("3 6\n1000 0\n24000 -2\n");
  assert.equal(points.length, 3);
  assert.equal(internals.curveAt(points, 1000), 0);
});

test("host validation rejects shell-like and invalid addresses", () => {
  assert.throws(() => internals.assertHost("127.0.0.1;rm"));
  assert.throws(() => internals.assertHost("999.1.1.1"));
  assert.equal(internals.assertHost("192.0.2.120"), "192.0.2.120");
});

test("band analysis returns finite relative levels", () => {
  const impulse = Array(1024).fill(0); impulse[10] = 1;
  const bands = internals.bandLevels(impulse, 48000);
  assert.equal(bands.length, 10);
  assert.ok(bands.every(b => Number.isFinite(b.relativeDb)));
});

test("Denon volume commands use the protocol's absolute scale", () => {
  assert.equal(internals.denonCommand("volume_db", -80), "MV00");
  assert.equal(internals.denonCommand("volume_db", -30), "MV50");
  assert.equal(internals.denonCommand("volume_db", -29.5), "MV505");
  assert.equal(internals.denonCommand("volume_db", 0), "MV80");
  assert.throws(() => internals.denonCommand("volume_db", 19));
});

test("crossover advisor rounds conservatively to standard values", () => {
  assert.deepEqual(internals.chooseCrossover(45, 80), {
    recommendedHz: 80,
    currentHz: 80,
    minimumFromF3Hz: 67.5,
    risk: null
  });
  assert.match(internals.chooseCrossover(60, 80).risk, /below/);
});

test("speaker geometry uses listener-facing coordinate convention", () => {
  const a = internals.speakerAngles({x:0,y:0,z:1}, {x:1,y:1,z:1});
  assert.ok(Math.abs(a.azimuthDeg - 45) < 1e-9);
  assert.equal(a.elevationDeg, 0);
  assert.deepEqual(internals.placementTarget("FR").az, [22,30]);
});

test("designed target curve covers A1 range and normalizes 1 kHz", () => {
  const curve = internals.designCurve({bassBoostDb:6,bassShelfEndHz:80,trebleTiltDb:-2,points:121});
  assert.equal(curve[0].frequencyHz, 3);
  assert.equal(curve.at(-1).frequencyHz, 24000);
  assert.equal(curve.find(p => p.frequencyHz === 1000).levelDb, 0);
  assert.ok(curve.every((p,i) => !i || p.frequencyHz > curve[i-1].frequencyHz));
});

test("FIR headroom estimate is finite", () => {
  const filter = Array(512).fill(0); filter[0]=1; filter[1]=0.25;
  const gain = internals.filterSpectralGain(filter,48000);
  assert.ok(Number.isFinite(gain.relativePeakGainDb));
});
