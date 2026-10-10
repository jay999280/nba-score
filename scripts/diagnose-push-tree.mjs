/**
 * Local diagnostic for scripts/push-via-api.mjs.
 *
 * Rebuilds the tree exactly the way the push script does — base tree plus the
 * commit's changed paths — using a throwaway index, then compares it against
 * the commit's real tree. Any path/mode the script got wrong shows up here
 * without touching the GitHub API.
 *
 * Run:  node scripts/diagnose-push-tree.mjs
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const INDEX = ".git/.tmp-diagnose-index";

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
}

const head = git(["rev-parse", "HEAD"]).trim();
const parent = git(["rev-parse", "HEAD~1"]).trim();
const baseTree = git(["rev-parse", `${parent}^{tree}`]).trim();

const raw = git(["diff", "--name-status", "-z", parent, head]);
const parts = raw.split("\0").filter(Boolean);
const changes = [];
for (let index = 0; index < parts.length; ) {
  const status = parts[index];
  if (status.startsWith("R")) {
    changes.push({ status: "D", path: parts[index + 1] });
    changes.push({ status: "A", path: parts[index + 2] });
    index += 3;
  } else {
    changes.push({ status: status[0], path: parts[index + 1] });
    index += 2;
  }
}

rmSync(INDEX, { force: true });
const env = { ...process.env, GIT_INDEX_FILE: INDEX };
try {
  git(["read-tree", baseTree], { env });
  for (const change of changes) {
    if (change.status === "D") {
      git(["update-index", "--force-remove", "--", change.path], { env });
      continue;
    }
    const record = git(["ls-files", "-s", "--", change.path]).trim();
    const mode = record.split(/\s+/)[0] || "100644";
    const sha = git(["rev-parse", `${head}:${change.path}`]).trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${change.path}`], { env });
  }
  const rebuilt = git(["write-tree"], { env }).trim();
  const real = git(["rev-parse", `${head}^{tree}`]).trim();

  console.log(`rebuilt tree ${rebuilt}`);
  console.log(`real    tree ${real}`);
  if (rebuilt === real) {
    console.log("\nIDENTICAL — the push script's tree is correct; look elsewhere.");
  } else {
    console.log("\nDifferences (rebuilt vs real):");
    const diff = git(["diff-tree", "-r", "--name-status", rebuilt, real]);
    console.log(diff.trim() || "(none reported)");
  }
} finally {
  rmSync(INDEX, { force: true });
}
