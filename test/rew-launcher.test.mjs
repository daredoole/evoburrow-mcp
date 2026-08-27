import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRewInstall, launchRew, revalidateRewCandidate, rewLauncherInternals } from "../lib/rew-launcher.mjs";

const syntheticInspect = async (path, { source }) => ({ path, requestedPath: path, source, appBundle: path.endsWith(".app"), identityHash: path, identity: { canonicalPath: path } });

test("REW discovery prioritizes user input and covers conventional paths", async () => {
  const linux = await discoverRewInstall({ explicitPath: "/custom/rew", platform: "linux", home: "/home/example", pathLookup: async () => ["/usr/bin/rew"], inspect: syntheticInspect });
  assert.equal(linux.selected.path, "/custom/rew"); assert.equal(linux.explicitPathAccepted, true);
  const mac = await discoverRewInstall({ platform: "darwin", home: "/Users/example", pathLookup: async () => [], inspect: syntheticInspect });
  assert.ok(mac.candidates.some(x => x.path === "/Applications/REW.app" && x.appBundle));
  assert.ok(rewLauncherInternals.conventionalCandidates("win32", { ProgramFiles: "C:\\Program Files" }, "C:\\Users\\Example").some(x => /roomeqwizard\.exe$/i.test(x)));
});

test("REW discovery requests a path when no candidate is usable", async () => {
  const found = await discoverRewInstall({ platform: "linux", pathLookup: async () => [], inspect: async () => null });
  assert.equal(found.found, false); assert.equal(found.needsUserPath, true);
});

test("REW launch revalidates the executable and waits for API readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "evoburrow-rew-")), executable = join(root, "rew");
  await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o700);
  const discovery = await discoverRewInstall({ explicitPath: executable, platform: "linux", pathLookup: async () => [] });
  let probes = 0, unref = false;
  const launched = await launchRew({ candidate: discovery.selected, platform: "linux", timeoutMs: 1500, probe: async () => { if (++probes < 2) throw new Error("offline"); return { version: "test" }; }, spawnImpl: () => ({ pid: 1234, once: () => {}, unref: () => { unref = true; } }) });
  assert.equal(launched.apiReady, true); assert.equal(unref, true); assert.equal(launched.executable, await realpath(executable));
  await writeFile(executable, "#!/bin/sh\necho changed\n"); await assert.rejects(revalidateRewCandidate(discovery.selected, "linux"), /changed after planning/);
});
