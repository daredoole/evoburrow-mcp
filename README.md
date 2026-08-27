# EvoBurrow MCP

> A careful little control room for A1 Evo AcoustiX and Denon/Marantz AVRs.

[![CI](https://github.com/daredoole/evoburrow-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/daredoole/evoburrow-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/daredoole/evoburrow-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/daredoole/evoburrow-mcp/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-6F8F72.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-support-FFDD00?logo=buymeacoffee&logoColor=111)](https://buymeacoffee.com/daredoole)

EvoBurrow is an unofficial, cross-platform Model Context Protocol server for inspecting A1 Evo AcoustiX artifacts, operating protected REW workflows, coordinating calibration presets, and making allowlisted Denon/Marantz LAN changes with backups and verification.

It is not affiliated with or endorsed by OCA, A1 Evo AcoustiX, Audyssey, Denon, or Marantz. A1 Evo remains the owner of measurement, optimization, and calibration transfer.

## What lives in the burrow

- Inspect and compare `.ady`, `.oca`, `.avr`, `.mdat`, HTML reports, target curves, and session logs.
- Diagnose measurement repeatability, polarity, timing, crossover headroom, subwoofer integration, and speaker geometry.
- Discover or start REW on Windows, macOS, and Linux, negotiate its local API, protect sweeps, save/load MDAT files, and analyze phase-aware crossover summation and multiseat consistency.
- Read Denon/Marantz status, decode protocol responses, snapshot the AVR, preview exact diffs, execute only allowlisted changes after confirmation, and verify the result.
- Catalog A1 calibration files and bind their hashes to Denon Speaker Preset 1/2 without confusing presets with Quick Select buttons.
- Run A1's terminal workflow only through a hash-bound, locked, time-limited adapter with saved transcripts.

Generic car, laptop, JamesDSP, FIR-laboratory, and listening-test workflows intentionally remain in [Audio Calibration MCP](https://github.com/daredoole/audio-calibration-mcp).

## Safety model

Read-only inspection comes first. Receiver writes, A1 terminal runs, file loads, target creation, and REW startup use explicit plans or confirmation. Arbitrary AVR protocol strings and undocumented calibration uploads are not exposed. Backups and post-change verification are part of the workflow, not optional cleanup.

EvoBurrow cannot make a calibration “perfect,” certify standards compliance, or derive listening preference from a graph. It separates measured facts, calculations, engineering interpretation, and community reports.

## Requirements

- Node.js 20 or 22
- A local A1 Evo AcoustiX workspace and supported executable
- REW with its local API enabled on `127.0.0.1:4735` for live measurement tools
- A Denon/Marantz receiver reachable on the local network for AVR tools

## Install and run

```bash
npm ci
npm run build
npm start
```

The Codex plugin manifest is in `.codex-plugin/plugin.json`; `.mcp.json` launches the bundled stdio server. `A1_EVO_HOME`, `A1_REW_URL`, and `A1_REW_EXECUTABLE` can override local discovery when needed.

### MCP configuration

```json
{
  "mcpServers": {
    "a1-evo-audio-expert": {
      "command": "node",
      "args": ["/absolute/path/to/evoburrow-mcp/dist/server.mjs"]
    }
  }
}
```

The compatibility server key stays `a1-evo-audio-expert` so existing clients do not lose their tool namespace. The public project and package name is EvoBurrow MCP.

## Recommended workflow

1. Scan the workspace and inspect the latest artifacts.
2. Probe REW and the AVR without changing anything.
3. Validate measurement quality, speaker capability, crossover choices, and subwoofer integration.
4. Let A1 generate and transfer the calibration.
5. Snapshot and map the exact calibration to a Denon Speaker Preset.
6. Run protected post-calibration measurements and a level-matched comparison.
7. Preserve the baseline and report uncertainty or missing evidence plainly.

## Privacy

There is no telemetry. Local artifacts may contain receiver IP addresses, usernames, absolute paths, room geometry, microphone metadata, and calibration fingerprints. Do not publish measurements, backups, transcripts, or receiver snapshots without reviewing and redacting them.

## Development

`npm test` builds the server and runs hardware-independent tests. `npm run validate:release` checks package/plugin metadata and the bundled MCP surface. Hardware smoke tests must remain opt-in and must never run in normal CI.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md).

Releases are built and tested from pinned GitHub Actions. Tag workflows produce an npm-compatible tarball plus a GitHub build-provenance attestation; npm publication remains a separate, explicitly configured step.

## Support the project

EvoBurrow is free and open source. If this little bunny saves your calibration from a bad day, you can [buy daredoole a coffee](https://buymeacoffee.com/daredoole).
