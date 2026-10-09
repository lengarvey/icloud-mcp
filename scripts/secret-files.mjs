// Defense against force-adding local secrets. Names and template syntax only:
// diagnostics never print file contents or assignment values.
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function secretFileKind(path) {
  const name = basename(path);
  if (!/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name)) return "ordinary";
  return name.endsWith(".example") ? "template" : "secret";
}

export function sanitizedTemplate(contents) {
  return contents.split(/\r?\n/).every((line) =>
    /^\s*(?:#.*)?$/.test(line) || /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:""|'')?\s*(?:#.*)?$/.test(line),
  );
}

export function checkSecretFiles(mode, cwd = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const args = mode === "--staged"
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]
    : ["ls-files", "-z"];
  const failures = [];
  for (const path of git(args).split("\0").filter(Boolean)) {
    const kind = secretFileKind(path);
    if (kind === "ordinary") continue;
    if (kind === "secret") {
      failures.push(`${JSON.stringify(path)}: local secret file must not be committed`);
    } else if (!sanitizedTemplate(git(["show", `:${path}`]))) {
      failures.push(`${JSON.stringify(path)}: example template must contain comments and empty assignments only`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "--staged" && mode !== "--tracked") {
    console.error("Usage: node scripts/secret-files.mjs --staged|--tracked");
    process.exitCode = 1;
  } else {
    try {
      const failures = checkSecretFiles(mode);
      if (failures.length) {
        console.error(`Refusing secret files:\n${failures.join("\n")}`);
        process.exitCode = 1;
      }
    } catch {
      console.error("Unable to verify staged secret files; refusing to continue.");
      process.exitCode = 1;
    }
  }
}
