# Changelog

## 2.0.0-beta.1 - 2026-08-27

- Bound A1 execution plans to canonical executable, receiver configuration, and calibration artifact bytes with expiring, one-use confirmations.
- Replaced direct Denon mutation with snapshot, proposed diff, confirmation, post-change verification, and rollback workflows restricted to local receivers.
- Hardened REW sweep protection and restoration checks; added adversarial protocol, tamper, path, timeout, and opt-in Denon hardware-loop tests.
- Added MCPB and official MCP Registry metadata plus release provenance, SBOM, checksum, and prerelease automation.
- This remains a prerelease until the opt-in hardware-in-loop matrix passes on representative Denon/Marantz receivers and A1 Evo builds.

## 1.0.0 - 2026-08-27

- Introduced the EvoBurrow public brand while retaining the `a1-evo-audio-expert` plugin namespace for compatibility.
- Added cross-platform REW discovery, confirmed startup, executable identity checks, and capability negotiation.
- Added production package metadata, funding, privacy and security guidance, release validation, pinned dependencies, and hardened CI.
- Clarified the boundary between EvoBurrow's A1/AVR workflows and the generic Audio Calibration MCP.
