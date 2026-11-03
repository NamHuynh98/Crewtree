# Crewtree

Multi-agent orchestration on top of [Claude Code](https://docs.claude.com/claude-code), with a local web UI:
a Supervisor splits your goal into tasks and delegates them to a tree of agents you can watch, steer and
approve in real time.

## Install

Requirements: **Node 22+** and **Claude Code** installed and logged in (`claude` once). macOS and Windows
are supported; Linux and WSL are planned.

```bash
# macOS
curl -fsSL https://github.com/NamHuynh98/Crewtree/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://github.com/NamHuynh98/Crewtree/releases/latest/download/install.ps1 | iex
```

Options: `CREWTREE_VERSION=v0.2.0` (a specific release), `CREWTREE_INSTALL_DIR=…`, `CREWTREE_MODIFY_PATH=1`
(macOS: add `~/.local/bin` to your shell profile). The installers verify every download against `SHA256SUMS`
and never need admin rights. The Claude Agent SDK is installed from npm on your machine (it is proprietary
software of Anthropic and is not redistributed with Crewtree, see `NOTICE`).

**Official releases are only published at https://github.com/NamHuynh98/Crewtree/releases.**
Verify one with `gh attestation verify <file> --owner NamHuynh98` (see `SECURITY.md`).

## Use

```
crewtree [path]               start the server if needed and open the UI for that project (default: .)
crewtree stop | status        stop the server / pid, port, uptime, running agents, version
crewtree logs [-f]            server log
crewtree doctor               Node, Claude Code, permissions, server, port, Git Bash (Windows)
crewtree update [version]     update (--check, --pre, --wait, --force, --archive <file> for offline)
crewtree rollback             back to the previous version and its database backup
crewtree autostart on|off     start at login (launchd / Task Scheduler)
crewtree uninstall [--purge]  remove Crewtree; your data in ~/.crewtree is kept unless --purge
```

The server listens on `127.0.0.1` only (port 4317, or the next free one) and serves the web UI; each
`crewtree` call opens the browser with a one-time sign-in link.

## Develop

```bash
git clone https://github.com/NamHuynh98/Crewtree.git && cd Crewtree
pnpm install && pnpm dev        # server :4317, web :5173
pnpm pack                       # release bundle for this platform in dist-release/
```

See `CONTRIBUTING.md` (DCO sign-off, checks to run) and `docs/PLAN.md` for the design.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`. The name and logo are covered by `TRADEMARKS.md`.
Crewtree is an independent project, not affiliated with Anthropic.
