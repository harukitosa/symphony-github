import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type SpecFinding = {
  file: string;
  module: string;
  name: string;
  arity: number;
  line: number;
};

export async function missingPublicSpecs(
  paths: string[],
  opts: { exemptions?: string[] } = {},
): Promise<SpecFinding[]> {
  const exemptions = new Set(opts.exemptions ?? []);
  const files = (await Promise.all(paths.map(collectElixirFiles))).flat();
  const findings: SpecFinding[] = [];
  for (const file of files) {
    findings.push(...(await fileFindings(file, exemptions)));
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name) || left.arity - right.arity,
  );
}

export function findingIdentifier(finding: SpecFinding): string {
  return `${finding.module}.${finding.name}/${finding.arity}`;
}

async function collectElixirFiles(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile() && path.endsWith(".ex")) return [path];
    if (!info.isDirectory()) return [];

    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => collectElixirFiles(join(path, entry.name))));
    return nested.flat();
  } catch {
    return [];
  }
}

async function fileFindings(file: string, exemptions: Set<string>): Promise<SpecFinding[]> {
  const source = await readFile(file, "utf8");
  const lines = source.split(/\r?\n/);
  const findings: SpecFinding[] = [];
  let moduleName: string | null = null;
  let pendingSpecs = new Set<string>();
  let pendingImpl = false;
  const seenDefs = new Set<string>();

  lines.forEach((line, index) => {
    const moduleMatch = line.match(/^\s*defmodule\s+([A-Za-z0-9_.]+)/);
    if (moduleMatch?.[1]) moduleName = moduleMatch[1];

    const specMatch = line.match(/^\s*@spec\s+([a-zA-Z_?!][\w?!]*)\s*(?:\(([^)]*)\))?/);
    if (specMatch?.[1]) {
      pendingSpecs.add(`${specMatch[1]}/${arityFromArgs(specMatch[2])}`);
      return;
    }

    if (/^\s*@impl\b/.test(line)) {
      pendingImpl = true;
      return;
    }

    const defpMatch = line.match(/^\s*defp\s+/);
    if (defpMatch) {
      pendingSpecs = new Set();
      pendingImpl = false;
      return;
    }

    const defMatch = line.match(/^\s*def\s+([a-zA-Z_?!][\w?!]*)\s*(?:\(([^)]*)\)|\s+do\b|\s*,)/);
    if (!defMatch?.[1] || moduleName === null) return;

    const id = `${defMatch[1]}/${arityFromArgs(defMatch[2])}`;
    if (seenDefs.has(id)) {
      pendingSpecs = new Set();
      pendingImpl = false;
      return;
    }
    seenDefs.add(id);

    const finding: SpecFinding = {
      file,
      module: moduleName,
      name: defMatch[1],
      arity: arityFromArgs(defMatch[2]),
      line: index + 1,
    };

    if (!pendingSpecs.has(id) && !pendingImpl && !exemptions.has(findingIdentifier(finding))) {
      findings.push(finding);
    }
    pendingSpecs = new Set();
    pendingImpl = false;
  });

  return findings;
}

function arityFromArgs(rawArgs: string | undefined): number {
  if (rawArgs === undefined) return 0;
  const trimmed = rawArgs.trim();
  if (trimmed === "") return 0;
  return trimmed.split(",").length;
}
