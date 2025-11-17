# md-talk

`md-talk` is a TypeScript/Node.js CLI that exports AI agent transcripts (Codex CLI, Claude Code) to clean Markdown files. It normalizes metadata, tool calls, and write operations into a single readable log so you can archive or share your sessions.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- npm (comes with Node)
- Your AI Agent

## Installation

```bash
npm install -g md-talk
# or
pnpm install -g md-talk
```

## Usage

```bash
# list recent sessions for an agent
md-talk ls codex
md-talk ls claude

# export a specific session
md-talk codex <session-id> -o transcript.md --include-metadata "agent,session-id" --display-tool-output

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
| `-i, --input-file <file>` | Export a specific JSONL session file directly |
| `-t, --title <text>` | Override the Markdown document title |
| `--include-metadata "agent,session-id,..."` | Comma-separated metadata fields to show at the top of the document |
| `--display-tool-output` | Include tool stdout/stderr blocks in the conversation |

Codex sessions are discovered from the JSONL history file and the matching transcript under `~/.codex/sessions`. Claude Code sessions read from `~/.claude/projects/<project>/<session>.jsonl`. Make sure those files exist on the machine running the CLI.

## Development

```bash
# live-reload during development
npm run dev -- claude <session-id> -o out.md

# build the distributable CLI
npm run build

# run tests (future)
npm run test
```

## License

AGPL-3 © Jel1yspot
