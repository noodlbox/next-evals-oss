import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import type { ClaudeCodeResult, ClaudeCodeEvalOptions } from "./claude-code-runner";
import {
  DEFAULT_TIMEOUT,
  getEvalPaths,
  validateEval,
  collectFiles,
  buildEnhancedPrompt,
  getTemplateFiles,
} from "./eval-shared";

export interface LocalEvalOptions extends ClaudeCodeEvalOptions {
  noodlboxEnabled?: boolean;
  verbose?: boolean;
  keepWorkDir?: boolean;
  model?: "opus" | "sonnet" | "haiku";
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number; stream?: boolean } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: process.env,
      timeout: options.timeout,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      const str = data.toString();
      stdout += str;
      if (options.stream) process.stdout.write(str);
    });
    proc.stderr?.on("data", (data) => {
      const str = data.toString();
      stderr += str;
      if (options.stream) process.stderr.write(str);
    });
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

async function runCommandWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  options: { cwd?: string; timeout?: number; stream?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      const str = data.toString();
      stdout += str;
      if (options.stream) process.stdout.write(str);
    });
    proc.stderr?.on("data", (data) => {
      const str = data.toString();
      stderr += str;
      if (options.stream) process.stderr.write(str);
    });
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));

    proc.stdin?.write(stdin);
    proc.stdin?.end();
  });
}

async function writeFilesToDir(
  dir: string,
  files: { path: string; content: Buffer }[]
): Promise<void> {
  for (const file of files) {
    const fullPath = path.join(dir, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content);
  }
}

async function captureGeneratedFiles(workDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const appDir = path.join(workDir, "app");

  const stat = await fs.stat(appDir).catch(() => null);
  if (!stat?.isDirectory()) return files;

  async function readDir(dir: string, relativePath = ""): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await readDir(entryPath, relPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        try {
          files[`app/${relPath}`] = await fs.readFile(entryPath, "utf8");
        } catch {
          // Skip
        }
      }
    }
  }

  await readDir(appDir);
  return files;
}

/**
 * Run Claude Code eval locally (without Vercel Sandbox).
 * Returns same ClaudeCodeResult interface as sandbox runner.
 */
export async function runLocalEval(
  evalPath: string,
  options: LocalEvalOptions = {}
): Promise<ClaudeCodeResult> {
  const paths = getEvalPaths(evalPath);
  await validateEval(paths);

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const prompt = await fs.readFile(paths.promptFile, "utf8");
  const workspaceFiles = await collectFiles(paths.inputDir, { excludeTests: true });
  const testFiles = await collectFiles(paths.inputDir, { onlyTests: true });
  const templateFiles = await getTemplateFiles(paths.templateDir);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `eval-${evalPath.replace(/\//g, "-")}-`));
  const startTime = Date.now();
  let claudeOutput = "";

  const cleanup = async () => {
    if (!options.keepWorkDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const makeResult = (partial: Partial<ClaudeCodeResult>): ClaudeCodeResult => ({
    success: false,
    output: claudeOutput,
    duration: Date.now() - startTime,
    evalPath,
    timestamp: new Date().toISOString(),
    ...partial,
  });

  try {
    // Setup workspace
    await writeFilesToDir(workDir, [...workspaceFiles, ...templateFiles]);

    if (options.verbose) console.log(`  Work dir: ${workDir}`);

    // Install dependencies
    if (options.verbose) console.log("  Installing dependencies...");
    const install = await runCommand("pnpm", ["install"], { cwd: workDir, timeout: 120000 });
    if (install.exitCode !== 0) throw new Error(`pnpm install failed: ${install.stderr}`);

    // Run Noodlbox if enabled - analyze workspace (plugin must be installed globally)
    if (options.noodlboxEnabled) {
      // Initialize git repo (required for nbx analyze)
      if (options.verbose) console.log("  Initializing git repo...");
      await runCommand("git", ["init"], { cwd: workDir });
      await runCommand("git", ["add", "."], { cwd: workDir });
      await runCommand("git", ["commit", "-m", "init"], { cwd: workDir });

      // Analyze the workspace to build the knowledge graph
      if (options.verbose) console.log("  Running nbx analyze...");
      const analysis = await runCommand("nbx", ["analyze", workDir], {
        cwd: workDir,
        timeout: 120000,
      });
      if (analysis.exitCode !== 0 && options.verbose) {
        console.log(`  Warning: nbx analyze failed: ${analysis.stderr}`);
      }
    }

    // Run Claude - pipe prompt via stdin
    if (options.verbose) console.log("  Running Claude Code...");
    const model = options.model ?? "opus";
    const enhancedPrompt = buildEnhancedPrompt(prompt);

    // Build claude args - add debug hooks flag if noodlbox is enabled
    const claudeArgs = ["--print", "--model", model, "--dangerously-skip-permissions"];
    if (options.noodlboxEnabled) {
      claudeArgs.push("--debug", "hooks");
    }
    claudeArgs.push("-p", "-");

    // Set NOODLBOX_HOOK_DEBUG to see hook activity
    const claudeEnv = options.noodlboxEnabled
      ? { ...process.env, NOODLBOX_HOOK_DEBUG: "true" }
      : process.env;

    const claude = await runCommandWithStdin(
      "claude",
      claudeArgs,
      enhancedPrompt,
      { cwd: workDir, timeout, stream: options.verbose, env: claudeEnv }
    );
    claudeOutput = claude.stdout + claude.stderr;

    if (claude.exitCode !== 0) {
      await cleanup();
      return makeResult({ error: `Claude exited with code ${claude.exitCode}` });
    }

    // Add test files and validate
    await writeFilesToDir(workDir, testFiles);

    if (options.verbose) console.log("  Running validation...");
    const [build, lint, test] = await Promise.all([
      runCommand("npx", ["next", "build"], { cwd: workDir, timeout: 120000 }),
      runCommand("./node_modules/.bin/eslint", ["app/"], { cwd: workDir, timeout: 60000 }),
      runCommand("npx", ["vitest", "run"], { cwd: workDir, timeout: 120000 }),
    ]);

    const generatedFiles = await captureGeneratedFiles(workDir);

    await cleanup();

    return makeResult({
      success: build.exitCode === 0 && lint.exitCode === 0 && test.exitCode === 0,
      buildSuccess: build.exitCode === 0,
      lintSuccess: lint.exitCode === 0,
      testSuccess: test.exitCode === 0,
      buildOutput: build.stdout + build.stderr,
      lintOutput: lint.stdout + lint.stderr,
      testOutput: test.stdout + test.stderr,
      generatedFiles,
    });
  } catch (error) {
    await cleanup();
    return makeResult({ error: error instanceof Error ? error.message : String(error) });
  }
}
