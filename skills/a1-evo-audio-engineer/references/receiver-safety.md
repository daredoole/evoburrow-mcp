# Denon and Marantz receiver safety

- Start read-only: probe reachability, then query power, volume, mute, input, and sound mode.
- Require explicit confirmation for power, mute, volume, or input changes. Never expose arbitrary raw commands through this plugin.
- Keep Network/IP Control set to Always On when standby access is required; this increases standby power consumption.
- A refused or unreachable connection does not prove receiver failure. Check IP address, VLAN/client isolation, receiver network-control setting, and whether that model exposes the requested protocol.
- Do not automate calibration upload through an undocumented protocol. Use A1 Evo’s own transfer workflow and preserve the pre-transfer receiver state.
- Changing speaker configuration can reset calibration. Do not disable a speaker in AVR setup merely for an A/B listening check.

Official Denon web-control example: https://manuals.denon.com/AVRX3500H/NA/EN/RQIFSYzprtydut.php
