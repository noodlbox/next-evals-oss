# Next.js Evals with Noodlbox

Local evaluation harness for testing Claude Code with Noodlbox.

Baseline results (without Noodlbox) are published at: https://nextjs.org/evals

## Usage

```bash
# Run all evals with Noodlbox
bun cli-local.ts --all

# Single eval with verbose output
bun cli-local.ts --eval 001-server-component --verbose

# Save results to JSON
bun cli-local.ts --all -o results.json

# Debug mode - keep temp directories
bun cli-local.ts --eval 001-server-component --keep-work-dir
```

## Flow

1. Creates temp directory per eval
2. Copies workspace files (excluding tests)
3. Installs dependencies
4. Runs `noodl analyze` (if enabled)
5. Runs `claude --print --dangerously-skip-permissions`
6. Copies test files in
7. Runs build/lint/test validation
8. Cleans up (unless `--keep-work-dir`)
