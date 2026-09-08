# Next.js Evals with Noodlbox

Run Next.js evals locally with Noodlbox enabled.

Baseline results (without Noodlbox): https://nextjs.org/evals

## Usage

```bash
# Run all agent evals with Noodlbox (local mode)
bun cli.ts --claude-code --local --all

# Single eval with verbose output
bun cli.ts --claude-code --local --eval agent-000-app-router-migration-simple --verbose

# Use faster model for testing
bun cli.ts --claude-code --local --eval agent-000-app-router-migration-simple --model haiku
```

## Flags

- `--claude-code` - Use Claude Code agent
- `--local` - Run locally instead of Vercel Sandbox (enables Noodlbox)
- `--model <opus|sonnet|haiku>` - Model to use (default: opus)
- `--verbose` - Show detailed logs

## Local Mode Flow

1. Creates temp directory per eval
2. Copies workspace files (excluding tests)
3. Installs dependencies
4. Initializes git repo and runs `nbx analyze`
5. Runs `claude --print --dangerously-skip-permissions`
6. Copies test files in
7. Runs build/lint/test validation
8. Cleans up temp directory
