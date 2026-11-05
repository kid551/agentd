# AGENTS.md

This repository is public. Everything committed here — code, tests, docs, commit
messages — is published for good: forks, caches and GitHub's pull-request refs keep
it even after a history rewrite. These rules bind every person and every agent
(Claude Code, Codex, agentd Workers) that writes to this repository.

## 1. Never commit

- **Secrets**: API keys, tokens, passwords, private keys, cookies, webhook URLs,
  `.env` files — real or "only for a test".
- **Who the owner is**: real names beyond the public handle, personal email
  addresses, phone numbers, employer or client names.
- **The owner's machine**: absolute home paths (`/Users/<name>/…`), the local
  folder layout, usernames, the state of local tools ("gh token expired", which
  CLI is logged in where).
- **Private infrastructure**: internal git hosts, company domains, Tailscale /
  VPN host names, private IPs, ports of internal services, CI or deploy
  environment names.
- **Other private projects**: their names, repository paths, MR / issue numbers,
  CI behaviour, scripts, environment variable names, or anything learnt while
  working inside them. agentd dispatches Workers into other repositories; what
  they see there stays there.
- **Private notes**: `implementation-notes.md`, `history_record.md`, local
  databases and logs. They are ignored by git; keep it that way.

## 2. Write examples with placeholders

| Need        | Use                                                                   |
| ----------- | --------------------------------------------------------------------- |
| a project   | `acme`, `acme-flutter`, `memos`, `billboard`                          |
| a person    | `alice`, `bob`                                                        |
| a home path | `~/code`, `/Users/alice`                                              |
| a git host  | `github.com` for public repos, `gitlab.example.com` for a private one |
| an email    | `alice@example.com`                                                   |
| a secret    | `<TOKEN>`, `process.env.X` — never a value that looks real            |

A real bug report goes in as its shape, not its contents: "a GitLab behind a VPN
rejects …", not the host name.

## 3. Commit identity

Commit with the GitHub noreply address, never a personal one:

```sh
git config user.email "<id>+<login>@users.noreply.github.com"
```

The pre-commit hook refuses any other address.

Merging a PR on GitHub writes a new commit as your **GitHub account's** name and
email, not the branch's: no hook sees it. Turn on Settings → Emails → "Keep my
email addresses private" so that commit gets the noreply address too. CI checks
the identities of every new commit on main and fails if a personal one got in.

The PR title and body become the squash commit's message, so they follow section
1 as well; CI scans them on every PR edit.

## 4. The check

`pnpm install` points git at `.githooks/`, whose pre-commit runs
`node scripts/check-sensitive.mjs --staged` and whose commit-msg checks the
message the same way. Run `pnpm check:sensitive` to scan
every tracked file; `pnpm check` includes it.

- Its rules are generic on purpose. Words that would identify the owner
  (employer, hosts, private project names) go one per line in
  `.sensitive-words` at the repository root. That file is ignored by git and
  must never be committed — listing the words publicly would leak them.
- A hit that is truly fine (a documented public example) may carry a
  `sensitive-check: allow` comment on the same line. Prefer a placeholder.
- Do not bypass the hook (`--no-verify`) and do not weaken the rules to get a
  commit through. Fix the content.

## 5. If something slipped in

- Not pushed yet: amend or rewrite the local commits, then check again.
- Already pushed: stop and tell the owner. Revoke any secret at once; deleting
  it from the files does not take it back.

## 6. Agents in particular

- Before every commit, read the staged diff for the items in section 1. The
  hook is a net, not a substitute.
- Development notes, deviations and investigation logs go to
  `implementation-notes.md` (local only), not into tracked docs.
- When a test needs a realistic value, invent one per section 2. Never paste
  from a real config, log, session or another repository.
