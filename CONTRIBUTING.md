# Contributing to Crewtree

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Development

```bash
git clone https://github.com/NamHuynh98/Crewtree.git && cd Crewtree
pnpm install
pnpm dev          # server on 127.0.0.1:4317, web on localhost:5173
```

Requirements: Node 22+, pnpm 11, Claude Code installed and logged in.

Before opening a pull request:

```bash
pnpm lint && pnpm format:check && pnpm i18n:check && pnpm typecheck && pnpm test && pnpm build
```

- Add the SPDX header `// SPDX-License-Identifier: Apache-2.0` to new source files.
- UI strings go through i18n with both `en` and `vi` keys.
- Keep the code cross-platform: build paths through `paths.ts`, start processes without a shell, and keep the line
  endings a file already has (LF or CRLF) when writing it.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
you wrote the change or have the right to submit it under the project's license.

```bash
git commit -s -m "fix: …"
```

This adds a line like `Signed-off-by: Your Name <you@example.com>` with the name and email of your git config.
Pull requests with commits that are not signed off fail the DCO check; fix them with
`git rebase --signoff main` (or `git commit --amend -s` for the last commit) and force-push.

There is no CLA: contributions are licensed under Apache-2.0 like the rest of the project.

## Dependencies

New dependencies must use a license on the allow list (MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, 0BSD,
CC0-1.0, BlueOak-1.0.0, Python-2.0, Unlicense). CI checks this with `node scripts/check-licenses.mjs`.
