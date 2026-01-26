#!/usr/bin/env bun

import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

// Load .env from script directory
dotenv.config({ path: path.join(import.meta.dirname, ".env"), override: true });
import { runLocalEval, type LocalEvalResult } from "./lib/claude-code-local-runner";
import { formatClaudeCodeResultsTable } from "./lib/format-results";

function parseArgs(args: string[]) {
  const values: Record<string, any> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") values.help = true;
    else if (arg === "-a" || arg === "--all") values.all = true;
    else if (arg === "-v" || arg === "--verbose") values.verbose = true;
    else if (arg === "--keep-work-dir") values.keepWorkDir = true;
    else if (arg === "--no-noodlbox") values.noNoodlbox = true;
    else if (arg === "-e" || arg === "--eval") values.eval = args[++i];
    else if (arg === "-t" || arg === "--timeout") values.timeout = args[++i];
    else if (arg === "-o" || arg === "--output") values.output = args[++i];
    else if (arg === "-m" || arg === "--model") values.model = args[++i];
    else if (!arg.startsWith("-")) positionals.push(arg);
  }

  return { values, positionals };
}

const { values, positionals } = parseArgs(process.argv.slice(2));

function showHelp() {
  console.log(`
Local Claude Code Evals CLI (with Noodlbox)

Baseline results: https://nextjs.org/evals

Usage:
  bun cli-local.ts [options] [eval-path]

Options:
  -h, --help           Show this help
  -e, --eval <path>    Run specific eval
  -a, --all            Run all evals
  -v, --verbose        Show detailed logs
  -t, --timeout <ms>   Timeout (default: 600000)
  -o, --output <file>  Write results to JSON
  -m, --model <model>  Model to use: opus, sonnet, haiku (default: opus)
  --no-noodlbox        Disable Noodlbox (enabled by default)
  --keep-work-dir      Keep temp directories for debugging

Examples:
  # Run all evals with Noodlbox
  bun cli-local.ts --all

  # Single eval with verbose output
  bun cli-local.ts --eval 001-server-component --verbose

  # Save results to JSON
  bun cli-local.ts --all -o results.json
`);
}

async function getAllEvals(): Promise<string[]> {
  const evalsDir = path.join(process.cwd(), "evals");
  const entries = await fs.readdir(evalsDir, { withFileTypes: true });

  const evals: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+|^agent-\d+/.test(entry.name)) continue;

    const evalPath = path.join(evalsDir, entry.name);
    const hasInput = await fs.stat(path.join(evalPath, "input")).then(s => s.isDirectory()).catch(() => false);
    const hasPrompt = await fs.stat(path.join(evalPath, "prompt.md")).then(s => s.isFile()).catch(() => false);

    if (hasInput && hasPrompt) evals.push(entry.name);
  }

  return evals.sort();
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function validateEnv(): void {
  // Check for either Anthropic API key or Bedrock config
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1" && !!process.env.AWS_BEARER_TOKEN_BEDROCK;

  if (!hasAnthropicKey && !hasBedrock) {
    console.error("❌ Missing authentication. Set one of:");
    console.error("   - ANTHROPIC_API_KEY");
    console.error("   - CLAUDE_CODE_USE_BEDROCK=1 + AWS_BEARER_TOKEN_BEDROCK");
    process.exit(1);
  }

  if (hasBedrock) {
    console.log("🔑 Using Bedrock authentication");
  } else {
    console.log("🔑 Using Anthropic API key");
  }
}

async function main() {
  if (values.help) {
    showHelp();
    return;
  }

  validateEnv();

  // Noodlbox enabled by default (use --no-noodlbox to disable)
  const noodlboxEnabled = values.noNoodlbox !== true;
  const model = values.model ?? "opus";
  const evalOptions = {
    verbose: values.verbose ?? false,
    keepWorkDir: values.keepWorkDir ?? false,
    timeout: values.timeout ? parseInt(values.timeout) : 600000,
    noodlboxEnabled,
    model: model as "opus" | "sonnet" | "haiku",
  };

  console.log(`📦 Model: ${model}`);

  console.log(`\n🔧 Noodlbox: ${noodlboxEnabled ? "enabled" : "disabled"}\n`);

  if (values.all) {
    const allEvals = await getAllEvals();
    console.log(`Running ${allEvals.length} evals locally...\n`);

    const results: { evalPath: string; result: LocalEvalResult }[] = [];

    for (const evalPath of allEvals) {
      try {
        console.log(`🚀 ${evalPath}...`);
        const result = await runLocalEval(evalPath, evalOptions);
        results.push({ evalPath, result });

        const status = result.success ? "✅" : "❌";
        console.log(`${status} ${evalPath} (${formatDuration(result.duration)})`);
      } catch (error) {
        const errorResult: LocalEvalResult = {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          duration: 0,
          noodlboxUsed: noodlboxEnabled,
        };
        results.push({ evalPath, result: errorResult });
        console.log(`❌ ${evalPath} - ${errorResult.error}`);
      }
    }

    // Display results table
    console.log("\n" + formatClaudeCodeResultsTable(
      results.map(r => ({
        evalPath: r.evalPath,
        result: {
          buildSuccess: r.result.buildSuccess ?? false,
          lintSuccess: r.result.lintSuccess ?? false,
          testSuccess: r.result.testSuccess ?? false,
          duration: r.result.duration,
        },
      }))
    ));

    // Summary
    const passed = results.filter(r => r.result.success).length;
    console.log(`\n📈 Summary: ${passed}/${results.length} passed`);

    if (values.output) {
      await fs.writeFile(values.output, JSON.stringify(results, null, 2));
      console.log(`📝 Results written to: ${values.output}`);
    }

    return;
  }

  // Single eval
  const evalPath = values.eval || positionals[0];
  if (!evalPath) {
    console.error("❌ No eval specified. Use --eval <path> or --all");
    const allEvals = await getAllEvals();
    console.log("\nAvailable evals:");
    allEvals.slice(0, 10).forEach(e => console.log(`  ${e}`));
    if (allEvals.length > 10) console.log(`  ... and ${allEvals.length - 10} more`);
    process.exit(1);
  }

  console.log(`🚀 Running: ${evalPath}`);
  const result = await runLocalEval(evalPath, evalOptions);

  const status = result.success ? "✅ PASS" : "❌ FAIL";
  console.log(`\n${status} (${formatDuration(result.duration)})`);
  console.log(`  Build: ${result.buildSuccess ? "✅" : "❌"}`);
  console.log(`  Lint:  ${result.lintSuccess ? "✅" : "❌"}`);
  console.log(`  Tests: ${result.testSuccess ? "✅" : "❌"}`);

  if (!result.success && result.error) {
    console.log(`\nError: ${result.error}`);
  }

  if (result.workDir) {
    console.log(`\nWork dir preserved: ${result.workDir}`);
  }

  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
