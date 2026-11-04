// TEACH_SYNC=git-pr: ship the learning folder (topics + PROFILE.md), when it sits in a git checkout with a GitHub
// remote, through a PR: a branch in a throwaway worktree, a PR, a squash-merge (gh), then the main checkout
// fast-forwards. Runs after a session pauses or finishes, and from the Sync button. One at a time; the result is
// kept for the UI. Off by default.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LEARNING, STATE } from "./paths.mjs";
import { readJSON, writeJSON, globalFile } from "./store.mjs";

const run = promisify(execFile);
// Everything under the data folder (its path inside the checkout), except an app checkout kept inside it.
const dataSpec = (rel) => (rel ? [rel, `:(exclude)${rel}/app`] : [".", ":(exclude)app"]);
let running = null;

export const lastSync = () => readJSON(globalFile("sync"), { state: "never" });

async function git(cwd, ...args) {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 32 << 20 });
  return stdout.trim();
}

const hash = (file) => { try { return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex"); } catch { return null; } };

// Changed and new files under the data folder (minus an app inside it), straight from `git status -z`: no trimming, which would
// eat the leading space of a first " M" line, and no quoting to undo for non-ASCII names.
export async function changedFiles(repo, rel = path.relative(repo, LEARNING)) {
  const { stdout } = await run("git", ["-C", repo, "status", "--porcelain", "-z", "--untracked-files=all", "--", ...dataSpec(rel)], { maxBuffer: 32 << 20 });
  return stdout.split("\0").filter(Boolean).map((e) => ({ code: e.slice(0, 2), file: e.slice(3) }));
}

export function sync(reason = "") {
  if (running) return running;
  running = doSync(reason).catch((e) => ({ state: "error", error: String(e.stderr || e.message || e).trim().slice(-400) }))
    .then((r) => { const out = { ...r, at: new Date().toISOString(), reason }; writeJSON(globalFile("sync"), out); running = null; return out; });
  return running;
}

async function doSync(reason) {
  let repo;
  try { repo = await git(LEARNING, "rev-parse", "--show-toplevel"); } catch { return { state: "off", error: "the learning folder isn't in a git checkout" }; }
  const rel = path.relative(repo, fs.realpathSync(LEARNING));
  const changed = await changedFiles(repo, rel);
  if (!changed.length) return { state: "clean" };
  if (changed.some((c) => /^[RC]/.test(c.code))) return { state: "error", error: "a rename is staged in the main checkout; sync by hand" };
  const head = await git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const base = (await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "origin/main")).replace(/^origin\//, "");
  await git(repo, "fetch", "-q", "origin", base);

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const branch = `claude/learn-sync-${stamp}`;
  const wt = path.join(STATE, "sync-worktree");
  await git(repo, "worktree", "remove", "--force", wt).catch(() => {});
  fs.rmSync(wt, { recursive: true, force: true });
  await git(repo, "worktree", "add", "-q", "-b", branch, wt, `origin/${base}`);
  const shipped = [];
  try {
    for (const { file } of changed) {
      const src = path.join(repo, file), dst = path.join(wt, file);
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); shipped.push({ file, hash: hash(src) }); }
      else if (fs.existsSync(dst)) { fs.rmSync(dst); shipped.push({ file, hash: null }); }
    }
    await git(wt, "add", "-A", "--", ...dataSpec(rel));
    if (!(await git(wt, "status", "--porcelain"))) return { state: "clean" };
    const topicsAt = (rel ? `${rel}/` : "") + "topics/";
    const topics = [...new Set(changed.map((c) => c.file.startsWith(topicsAt) ? c.file.slice(topicsAt.length).split("/")[0] : "").filter(Boolean))];
    const what = [topics.length ? topics.join(", ") : "", changed.some((c) => c.file.endsWith("PROFILE.md")) ? "profile" : ""].filter(Boolean).join(" + ");
    const title = `learning: ${what}${reason ? ` (${reason})` : ""}`;
    await git(wt, "commit", "-q", "-m", `${title}\n\nSynced by the Teach app.\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
    await git(wt, "push", "-q", "-u", "origin", branch);
    const body = `Teach app sync: ${changed.length} file(s) under ${rel || "."}/.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const { stdout: url } = await run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: wt });
    await run("gh", ["pr", "merge", url.trim(), "--squash", "--delete-branch"], { cwd: wt });

    // Bring the main checkout up to date: drop the local copies that went out unchanged, then fast-forward.
    // Each copy is parked first, so if the pull fails the checkout gets exactly its files back.
    let pulled = false;
    if (head === base) {
      const parked = [], park = path.join(STATE, "sync-parked");
      fs.rmSync(park, { recursive: true, force: true });
      for (const s of shipped) {
        const p = path.join(repo, s.file);
        if (!s.hash || hash(p) !== s.hash) continue;
        const q = path.join(park, s.file);
        fs.mkdirSync(path.dirname(q), { recursive: true });
        fs.copyFileSync(p, q);
        parked.push([q, p]);
        if (await git(repo, "ls-files", "--", s.file)) await git(repo, "checkout", "--", s.file); else fs.rmSync(p);
      }
      await git(repo, "pull", "-q", "--ff-only", "origin", base).then(() => { pulled = true; }).catch(() => {});
      if (!pulled) for (const [q, p] of parked) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(q, p); }
      fs.rmSync(park, { recursive: true, force: true });
    }
    return { state: "ok", pr: url.trim(), files: changed.length, pulled };
  } finally {
    await git(repo, "worktree", "remove", "--force", wt).catch(() => {});
    await git(repo, "branch", "-D", branch).catch(() => {});
  }
}
