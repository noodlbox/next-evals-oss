import fs from "fs/promises";
import path from "path";
import ignore from "ignore";

export const DEFAULT_TIMEOUT = 600000; // 10 minutes

export const IGNORED_PATTERNS = [
  ".git",
  ".next",
  "node_modules",
  ".DS_Store",
  "*.log",
  "build",
  "pnpm-lock.yaml",
  "package-lock.json",
];

export const TEST_FILE_PATTERNS = ["*.test.tsx", "*.test.ts"];

export interface EvalResultBase {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  buildSuccess?: boolean;
  lintSuccess?: boolean;
  testSuccess?: boolean;
  buildOutput?: string;
  lintOutput?: string;
  testOutput?: string;
  evalPath?: string;
  timestamp?: string;
  generatedFiles?: Record<string, string>;
}

export interface EvalPaths {
  evalsDir: string;
  fullEvalPath: string;
  inputDir: string;
  promptFile: string;
  templateDir: string;
}

export function getEvalPaths(evalPath: string): EvalPaths {
  const evalsDir = path.join(process.cwd(), "evals");
  const fullEvalPath = path.join(evalsDir, evalPath);
  return {
    evalsDir,
    fullEvalPath,
    inputDir: path.join(fullEvalPath, "input"),
    promptFile: path.join(fullEvalPath, "prompt.md"),
    templateDir: path.join(process.cwd(), "template"),
  };
}

export async function validateEval(paths: EvalPaths): Promise<void> {
  const evalStat = await fs.stat(paths.fullEvalPath).catch(() => null);
  if (!evalStat?.isDirectory()) {
    throw new Error(`Eval directory not found: ${paths.fullEvalPath}`);
  }

  const inputExists = await fs
    .stat(paths.inputDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!inputExists) {
    throw new Error(`No input directory found in ${paths.fullEvalPath}`);
  }

  const promptExists = await fs
    .stat(paths.promptFile)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!promptExists) {
    throw new Error(`No prompt.md file found in ${paths.fullEvalPath}`);
  }
}

export async function collectFiles(
  dir: string,
  options: { excludeTests?: boolean; onlyTests?: boolean } = {}
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = [];
  const ig = ignore();

  ig.add(IGNORED_PATTERNS);
  if (options.excludeTests) {
    ig.add(TEST_FILE_PATTERNS);
  }

  async function processDir(currentDir: string, relativePath = ""): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (ig.ignores(entryRelativePath)) continue;

      if (entry.isDirectory()) {
        await processDir(fullPath, entryRelativePath);
      } else {
        const isTestFile =
          entry.name.endsWith(".test.tsx") || entry.name.endsWith(".test.ts");

        if (options.onlyTests && !isTestFile) continue;
        if (options.excludeTests && isTestFile) continue;

        try {
          const content = await fs.readFile(fullPath);
          files.push({ path: entryRelativePath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await processDir(dir);
  return files;
}

export function buildEnhancedPrompt(prompt: string): string {
  return `${prompt.trim()}

IMPORTANT: Do not run npm, pnpm, yarn, or any package manager commands. Dependencies have already been installed. Do not run build, test, or dev server commands. Just write the code files.`;
}

export async function getTemplateFiles(
  templateDir: string
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = [];
  const templateFiles = ["package.json", "eslint.config.mjs", "tsconfig.json", "vite.config.mjs", "next.config.ts"];

  for (const filename of templateFiles) {
    const filePath = path.join(templateDir, filename);
    try {
      const content = await fs.readFile(filePath);
      files.push({ path: filename, content });
    } catch {
      // Skip missing template files
    }
  }

  return files;
}
