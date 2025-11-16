# md-talk

`md-talk` is a TypeScript/Node.js CLI that exports AI agent transcripts (Codex CLI, Claude Code) to clean Markdown files. It normalizes metadata, tool calls, and write operations into a single readable log so you can archive or share your sessions.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- npm (comes with Node)
- Local session history:
  - **Codex**: `~/.codex/history.jsonl` plus `~/.codex/sessions/**.jsonl`
  - **Claude Code**: `~/.claude/history.jsonl` plus `~/.claude/projects/**.jsonl`

## Installation

```bash
# with npm
npm install
npm run build
npm link   # optional: expose the CLI globally

# with pnpm
pnpm install
pnpm run build
pnpm link --global
```

Thanks to the `prepare` script you can also install the tool globally in one shot:

```bash
npm install -g .
# or
pnpm install -g .
```

Without linking you can call the local binary with `npx md-talk ...`, `pnpm dlx md-talk ...`, or run `npm run start -- <args>`.

## Usage

```bash
# list recent sessions for an agent
npx md-talk ls codex
pnpm dlx md-talk ls claude

# export a specific session
npx md-talk codex <session-id> -o transcript.md --include-metadata "agent,session-id" --display-tool-output

# interactively choose a session (TTY only)
md-talk claude -o claude.md        # if globally linked/installed
```

### Options

| Option | Description |
| --- | --- |
| `<agent>` | Supported aliases: `codex`, `claude`, `claude-code` |
| `ls <agent>` | Prints recent sessions with timestamps and counts |
| `-o, --out <file>` | Target Markdown file (required for exports) |
| `-s, --session <id>` | Skip interactive picker and load this session id |
| `--include-metadata "agent,session-id,..."` | Comma-separated metadata fields to show at the top of the document |
| `--display-tool-output` | Include tool stdout/stderr blocks in the conversation |

Codex sessions are discovered from the JSONL history file and the matching transcript under `~/.codex/sessions`. Claude Code sessions read from `~/.claude/projects/<project>/<session>.jsonl`. Make sure those files exist on the machine running the CLI.

## Development

```bash
# live-reload during development
npm run dev -- claude <session-id> -o out.md

# build the distributable CLI
npm run build

# run tests (if/when they exist)
npm run test
```

The compiled CLI lives in `dist/`. `npm run build` must be executed before publishing or using `md-talk` outside of the repo (e.g., after `npm link`).
