# opencode-misrules

Keep your project conventions in the agent's head — for good.

[![npm version](https://img.shields.io/npm/v/opencode-misrules.svg)](https://www.npmjs.com/package/opencode-misrules)

Load the `.md` files you need (code style, examples, agreements) and the agent follows them for the whole session. Even after compaction, they're never forgotten. No relying on skills deciding on their own whether to kick in — you control exactly what the agent follows.

```bash
opencode plugin opencode-misrules -g
```

## Use

Ask the agent to load your project docs:

> Load `docs/style.md` and `docs/testing/` as rules.

Behind the scenes the agent calls `misrules_add`. From then on, those rules are always in effect — no re-reading, no reminding.

| Tool | What it does |
|---|---|
| `misrules_add` | Load `.md` files or folders as session rules |
| `misrules_remove` | Stop following rules |
| `misrules_list` | See what's loaded |

## Lock it down

`.opencode/misrules.json` (or `~/.config/opencode/misrules.json`) — block sensitive files from ever being loaded:

```json
{ "denyPatterns": ["*.env*", "*secret*"] }
```

## License

MIT
