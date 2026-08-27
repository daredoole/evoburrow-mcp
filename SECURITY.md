# Security policy

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/daredoole/evoburrow-mcp/security/advisories/new). Do not include receiver IPs, calibration files, room coordinates, microphone identifiers, terminal transcripts, or credentials in a public issue.

EvoBurrow accepts only local REW API URLs, validates workspace paths, allowlists AVR commands, binds mutable operations to exact plans, and requires explicit confirmation. These controls are security boundaries; requests to bypass them will not be accepted.

Supported releases receive fixes on the latest published major version. Dependency review, CodeQL, pinned-action CI, lockfile auditing, and release attestations reduce risk, but no scanner or package manager can guarantee the absence of a future vulnerability.
