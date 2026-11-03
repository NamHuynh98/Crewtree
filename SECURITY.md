# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
https://github.com/NamHuynh98/Crewtree/security/advisories/new

Include what is affected, how to reproduce it and the impact you expect. You will get an answer within
7 days. Fixes are released as a new version and credited in the release notes unless you prefer otherwise.

## Scope

Crewtree runs a local server that can start agents, run shell commands through Claude Code and write
files. In scope, for example:

- reaching the server from another machine or from a web page (Host/Origin checks, the session cookie);
- reading or writing files outside the allowed folders through the API;
- leaking MCP secrets or other credentials through the API or the database;
- installing or updating from a download that does not match `SHA256SUMS`.

Out of scope: what an agent does with permissions you granted it, and vulnerabilities in Claude Code itself
(report those to Anthropic).

## Verifying a release

Every release archive has a SHA-256 checksum in `SHA256SUMS` (the installers refuse a mismatch) and a
build provenance attestation made by GitHub Actions:

```bash
gh attestation verify crewtree-v0.2.0-darwin-arm64.tar.gz --owner NamHuynh98
```

Only download Crewtree from https://github.com/NamHuynh98/Crewtree/releases.
