import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import {
  DEFAULT_TIMEOUT,
  EvalResultBase,
  getEvalPaths,
  validateEval,
  collectFiles,
  buildEnhancedPrompt,
  getTemplateFiles,
} from "./eval-shared";

export interface LocalEvalOptions {
  timeout?: number;
  noodlboxEnabled?: boolean;
  verbose?: boolean;
  keepWorkDir?: boolean;
}

export interface LocalEvalResult extends EvalResultBase {
  workDir?: string;
  transcript?: string;
  noodlboxUsed?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
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

    proc.stdout?.on("data", (data) => (stdout += data.toString()));
    proc.stderr?.on("data", (data) => (stderr += data.toString()));
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
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

async function findRecentTranscript(): Promise<string | undefined> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

  try {
    const dirs = await fs.readdir(projectsDir);
    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(dirPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtime.getTime() > fiveMinutesAgo) {
          return await fs.readFile(filePath, "utf8");
        }
      }
    }
  } catch {
    // Transcript capture is best-effort
  }
  return undefined;
}

export async function runLocalEval(
  evalPath: string,
  options: LocalEvalOptions = {}
): Promise<LocalEvalResult> {
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

  const makeResult = (partial: Partial<LocalEvalResult>): LocalEvalResult => ({
    success: false,
    output: claudeOutput,
    duration: Date.now() - startTime,
    evalPath,
    timestamp: new Date().toISOString(),
    workDir: options.keepWorkDir ? workDir : undefined,
    noodlboxUsed: options.noodlboxEnabled ?? false,
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

    // Run Noodlbox if enabled
    if (options.noodlboxEnabled) {
      if (options.verbose) console.log("  Running noodl analyze...");
      const noodl = await runCommand("noodl", ["analyze", workDir], { cwd: workDir, timeout: 120000 });
      if (noodl.exitCode !== 0 && options.verbose) {
        console.log(`  Warning: noodl analyze failed: ${noodl.stderr}`);
      }
    }

    // Run Claude
    if (options.verbose) console.log("  Running Claude Code...");
    const claude = await runCommand(
      "claude",
      ["--print", "--dangerously-skip-permissions", "-p", buildEnhancedPrompt(prompt)],
      { cwd: workDir, timeout }
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
    const transcript = await findRecentTranscript();

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
      transcript,
    });
  } catch (error) {
    await cleanup();
    return makeResult({ error: error instanceof Error ? error.message : String(error) });
  }
}
