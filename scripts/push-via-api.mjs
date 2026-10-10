/**
 * Push a local commit through the GitHub API when `github.com:443` is
 * unreachable but `api.github.com` still answers (observed on this network:
 * DNS hands back 20.205.243.166, whose TCP 443 is filtered, while other
 * GitHub edge IPs and the API host work fine).
 *
 * The commit is recreated with the *exact* metadata of the local one — same
 * tree, parent, message, author, committer and timestamps — so GitHub derives
 * the same SHA and the local branch stays identical to the remote. Only the
 * files changed by that commit are uploaded, on top of the parent's tree.
 *
 * Run:  node scripts/push-via-api.mjs [branch]
 */

import { execFileSync } from "node:child_process";

const REPO = "jay999280/nba-score";
const BRANCH = process.argv[2] ?? "main";

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** Raw blob bytes as git stored them — never the working-tree copy, which may
 * hold CRLF where the blob has LF and would produce a different tree. */
function gitBlob(rev, path) {
  return execFileSync("git", ["cat-file", "blob", `${rev}:${path}`], {
    maxBuffer: 512 * 1024 * 1024,
  });
}

const localHead = git(["rev-parse", "HEAD"]).trim();
const localParent = git(["rev-parse", "HEAD~1"]).trim();

const ref = JSON.parse(gh(["api", `repos/${REPO}/git/ref/heads/${BRANCH}`]));
const remoteHead = ref.object.sha;
console.log(`local  HEAD   ${localHead.slice(0, 7)}`);
console.log(`remote head   ${remoteHead.slice(0, 7)}`);

if (remoteHead !== localParent) {
  console.error(
    `\nRefusing to push: the local parent (${localParent.slice(0, 7)}) is not the remote head ` +
      `(${remoteHead.slice(0, 7)}). Reconcile the branches first.`,
  );
  process.exit(1);
}

const parent = JSON.parse(gh(["api", `repos/${REPO}/git/commits/${remoteHead}`]));
const baseTree = parent.tree.sha;

// --- what this commit changed ------------------------------------------------
const raw = git(["diff", "--name-status", "-z", `${localParent}`, `${localHead}`]);
const parts = raw.split("\0").filter((value) => value.length > 0);
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

const entries = [];
let bytes = 0;
for (const change of changes) {
  if (change.status === "D") {
    // A null sha removes the path from the base tree.
    entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
    continue;
  }
  const record = git(["ls-files", "-s", "--", change.path]).trim();
  const mode = record.split(/\s+/)[0] || "100644";
  const buffer = gitBlob(localHead, change.path);
  bytes += buffer.length;
  // Blobs go up as base64: only the blob endpoint decodes it, the tree
  // endpoint would store the literal text and corrupt every binary file.
  const blob = JSON.parse(
    gh(
      ["api", "--method", "POST", `repos/${REPO}/git/blobs`, "--input", "-"],
      JSON.stringify({ content: buffer.toString("base64"), encoding: "base64" }),
    ),
  );
  entries.push({ path: change.path, mode, type: "blob", sha: blob.sha });
}

console.log(`changed files ${entries.length} (${(bytes / 1024).toFixed(0)} KiB raw)`);

// --- tree -------------------------------------------------------------------
const tree = JSON.parse(
  gh(
    ["api", "--method", "POST", `repos/${REPO}/git/trees`, "--input", "-"],
    JSON.stringify({ base_tree: baseTree, tree: entries }),
  ),
);
console.log(`tree   ${tree.sha.slice(0, 7)}`);

// The tree must match the local commit exactly, or the recreated commit would
// carry different content. Abort rather than publish something else.
const localTree = git(["rev-parse", "HEAD^{tree}"]).trim();
if (tree.sha !== localTree) {
  console.error(
    `\nRefusing to commit: the uploaded tree (${tree.sha.slice(0, 7)}) does not match the ` +
      `local tree (${localTree.slice(0, 7)}), so file content or modes differ.`,
  );
  process.exit(1);
}

// --- commit, recreated byte-for-byte ----------------------------------------
const meta = git(["log", "-1", "--pretty=format:%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B"]).split(
  "\0",
);
const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, message] =
  meta;

const commit = JSON.parse(
  gh(
    ["api", "--method", "POST", `repos/${REPO}/git/commits`, "--input", "-"],
    JSON.stringify({
      message,
      tree: tree.sha,
      parents: [remoteHead],
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: committerName, email: committerEmail, date: committerDate },
    }),
  ),
);
console.log(`commit ${commit.sha.slice(0, 7)} (local ${localHead.slice(0, 7)})`);

if (commit.sha !== localHead) {
  console.error(
    "\nWarning: the recreated commit has a different SHA, so the branches now diverge.\n" +
      `remote ${commit.sha}\nlocal  ${localHead}`,
  );
}

// --- move the branch (force: a previous run may have left a placeholder) ----
gh(
  ["api", "--method", "PATCH", `repos/${REPO}/git/refs/heads/${BRANCH}`, "--input", "-"],
  JSON.stringify({ sha: commit.sha, force: true }),
);
console.log(`\n${BRANCH} -> ${commit.sha.slice(0, 7)} pushed via the API`);
