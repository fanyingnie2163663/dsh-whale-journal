# Whale Journal · dsh-whale-journal

A **diary / narrative memory** plugin for companion agents. It does not store another copy of the chat log: it lets the agent write a few first-person lines each day, grounded in that day's messages.

> Status: v0.1 — tools, storage, digest and grounding audit. Web panel, scheduling and weekly LLM review are on the roadmap.

![The journal page](https://cdn.jsdelivr.net/gh/fanyingnie2163663/dsh-whale-journal@main/docs/images/journal-page.png)

<sub>The read-only `/journal` page. The entries in the screenshot are synthetic data from `scripts/preview-page.mjs`, not real chats.</sub>

## Install

```sh
dsh plugin --profile <your-profile> add "https://github.com/fanyingnie2163663/dsh-whale-journal/releases/download/v0.1.3/dsh-whale-journal-0.1.3.tgz"
```

Restart DSH; `dsh --profile <your-profile> --dump-config | grep whale` should show it. This is a prebuilt
tarball — no local build step. Point `transcriptDir` at your message archive so `journal_digest` / `journal_audit` have material.


## What it is / is not

- Is: write per day and per scope (group/private), read/search/archive, build a prompt-ready digest from a day's messages, audit whether `refs` resolve.
- Is not: no model calls, no network, no auto-writing, no prompt injection. It does not decide what to write.
- Separate from fact cards: cards store facts (who is who, promises); the journal stores the agent's own view.

## Tools

| Tool | Purpose | Writes |
|---|---|---|
| `journal_write` | Write an entry (text + scope + optional date/mood/refs/doodle/photos) | yes |
| `journal_read` | Read recent entries | no |
| `journal_search` | Search entries by keyword | no |
| `journal_digest` | Build a day's writing material: messages with seq + recent entries + rules | no |
| `journal_audit` | Check refs resolve, duplicates, numeric tokens | no |
| `journal_peek` | Read-only peek facts (total / by day / last seen) | no |
| `journal_archive` | Soft-delete (reversible) | yes |

Nightly flow: `journal_digest` → agent writes 3–5 sentences → `journal_write` with `refs` from the digest's `[seq]`.

## Peeking page (read-only)

The Web profile mounts a read-only page (headless / SDK profiles do not register it):

- `http://127.0.0.1:3080/journal` (local or through an SSH tunnel; never expose it publicly)
- no edit / upload / delete; it only reads `$DSH_HOME/journal`
- opening a day records one peek (deduped per day for 10 minutes); the chat agent reads the facts through `journal_peek`
- doodles / photos follow their `anchor` sentence; skipped when the anchor is missing

Served directly by the DSH web server; no extra process.

Font: the page bundles `JournalHand` (an OFL subset of Yozai, renamed per the OFL reserved-name clause; see `assets/FONT-NOTICE.md`); if XianErTi (贤二体) is installed locally, it is used first. XianErTi is free for commercial use but its license forbids modification or embedding, so the repository does not bundle it.

## Storage

`$DSH_HOME/journal/entries.jsonl`, one JSON per line. Edits and archives append a new record with the same `id`; reads fold by `id` (last wins).

- 600 chars per entry by default (truncated flag);
- 3 entries per scope per day by default;
- archived entries are excluded from read/search/audit by default;
- malformed lines are skipped.

`samples/` contains synthetic data for tests.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `dir` | `''` | Journal dir; empty = `$DSH_HOME/journal` |
| `transcriptDir` | `''` | Message archive (qq-bridge `state/transcript`); empty disables digest/audit |
| `timezone` | `Asia/Shanghai` | Day boundary |
| `maxEntryChars` | `600` | Entry limit |
| `maxEntriesPerDay` | `3` | Per scope per day |
| `retentionDays` | `365` | Archived retention |
| `scopes` | `[]` | Allowed scopes; empty = any |

Validated by the Schemastery `Config` in `lib/index.js`.

## Install (local tarball, for development)

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-whale-journal-0.1.1.tgz
dsh --profile <name> --dump-config | grep dsh-whale-journal
```

## Privacy

- Local-only storage; no network or model calls.
- Entries are scoped; a group journal never reads private entries (caller passes scope).
- Prompts tell the writer not to include QQ numbers, private facts or real names; outbound guarding lives in the bridge.

## Development

```sh
npm test
node "<dsh-plugin-guide>/bin/dsh-plugin-dev.js" check --cwd .
```

## License

Apache-2.0.
