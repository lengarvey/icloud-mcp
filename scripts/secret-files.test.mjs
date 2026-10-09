import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSecretFiles, sanitizedTemplate, secretFileKind } from "./secret-files.mjs";

test("secret variants and exact sanitized-template exceptions", () => {
  for (const name of [".env", ".env.local", ".env.production", "nested/.dev.vars", ".dev.vars.production", ".env.example.local", ".env.production\nignored"]) {
    assert.equal(secretFileKind(name), "secret", name);
  }
  for (const name of [".env.example", ".env.production.example", "nested/.dev.vars.example"]) {
    assert.equal(secretFileKind(name), "template", name);
  }
  for (const name of ["env.ts", ".environment", "README.md"]) assert.equal(secretFileKind(name), "ordinary");
  assert.equal(sanitizedTemplate("# Empty template\nKEY=\nOTHER=\"\"\nexport THIRD='' # fill locally\n"), true);
  for (const text of ["KEY=nonempty", "KEY=$(command)", "KEY=\ncontinued-value", "arbitrary text"]) assert.equal(sanitizedTemplate(text), false);
});

test("gitignore and staged gate resist force-add and worktree substitution", () => {
  const cwd = mkdtempSync(join(tmpdir(), "icloud-secret-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "--quiet");
    writeFileSync(join(cwd, ".gitignore"), readFileSync(new URL("../.gitignore", import.meta.url)));
    for (const name of [".env", ".env.local", ".dev.vars.preview", ".env.example.local"]) {
      assert.ok(git("check-ignore", name).trim());
    }
    for (const name of [".env.example", ".dev.vars.preview.example"]) {
      assert.throws(() => git("check-ignore", name));
    }
    writeFileSync(join(cwd, ".env.local"), "KEY=\n");
    git("add", "-f", ".env.local");
    assert.equal(checkSecretFiles("--staged", cwd).length, 1);
    git("rm", "--cached", "-f", ".env.local");
    writeFileSync(join(cwd, ".env.example"), "KEY=placeholder\n");
    git("add", ".env.example");
    writeFileSync(join(cwd, ".env.example"), "KEY=\n");
    assert.equal(checkSecretFiles("--staged", cwd).length, 1);
    git("add", ".env.example");
    assert.deepEqual(checkSecretFiles("--staged", cwd), []);
    assert.deepEqual(checkSecretFiles("--tracked", cwd), []);
    // A type change of a tracked template is checked too; a symlink's target
    // must not be mistaken for an empty sanitized template.
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "template");
    rmSync(join(cwd, ".env.example"));
    symlinkSync(".env.local", join(cwd, ".env.example"));
    git("add", ".env.example");
    assert.equal(checkSecretFiles("--staged", cwd).length, 1);
    git("restore", "--staged", ".env.example");
    const oddName = ".env.production\nexample";
    writeFileSync(join(cwd, oddName), "KEY=\n");
    git("add", "-f", oddName);
    assert.equal(checkSecretFiles("--staged", cwd).length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
