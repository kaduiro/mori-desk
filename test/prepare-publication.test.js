"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = path.resolve(__dirname, "../scripts/prepare-publication.mjs");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
function git(cwd, ...args) {
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, "-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", `core.hooksPath=${os.devNull}`, "-c", "commit.gpgsign=false", "-c", "user.name=Publication Test", "-c", "user.email=publication-test@example.invalid", ...args], { env, maxBuffer: 4 * 1024 * 1024 });
}
function write(root, name, bytes, executable = false) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  if (executable) fs.chmodSync(file, 0o755);
}
function commit(repo, message) {
  git(repo, "add", "--all", "--force");
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD").toString().trim();
}
function item(repo, base, source, name) {
  const content = git(repo, "show", `${source}:${name}`);
  const entry = git(repo, "ls-tree", source, "--", name).toString().split(" ");
  const before = git(repo, "ls-tree", base, "--", name).length > 0;
  return { path: name, operation: before ? "modify" : "add", sourceCommit: source, blobSha: entry[2].split("\t")[0], mode: entry[0], bytes: content.length, sha256: hash(content) };
}
function fixture(root) {
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet", "--object-format=sha1");
  write(repo, ".gitignore", "*.log\n");
  write(repo, "README.md", "Original public text.\n");
  write(repo, "asset.bin", Buffer.from([0, 255, 1, 2, 3, 128]));
  write(repo, "non-utf8.txt", Buffer.from([0x41, 0xe9, 0x0a]));
  write(repo, "release/a/before/file.dat", "Original nested path.\n");
  write(repo, "remove.txt", "This file is removed by the candidate.\n");
  write(repo, "docs/baseline.log", "Already tracked, despite the ignore rule.\n");
  const base = commit(repo, "public base");
  write(repo, "README.md", "Updated public text.\n+++ b/after/this-is-content\n");
  write(repo, "asset.bin", Buffer.from([0, 255, 128, 3, 2, 1, 0]));
  write(repo, "non-utf8.txt", Buffer.from([0x42, 0xf1, 0x0a]));
  write(repo, "release/a/before/file.dat", "Updated nested path.\n");
  write(repo, "new.bin", Buffer.from([0, 80, 78, 71, 255, 128, 0, 10]));
  write(repo, "docs/pr.md", "# 公開候補\n\n未承認のローカル準備物。\n");
  write(repo, "docs/public.md", "Reviewed public evidence.\n");
  write(repo, "docs/proof.log", "Explicitly selected evidence.\n");
  write(repo, "run.sh", "#!/bin/sh\nprintf 'test fixture\\n'\n", process.platform !== "win32");
  fs.unlinkSync(path.join(repo, "remove.txt"));
  const candidate = commit(repo, "reviewed product change");
  const expectedTree = git(repo, "rev-parse", `${candidate}^{tree}`).toString().trim();
  write(repo, "README.md", "A later product-only correction.\n");
  git(repo, "add", "README.md");
  // A real Git tree is the oracle, not the CLI's tree/hash algorithm.
  const mixedExpectedTree = git(repo, "write-tree").toString().trim();
  write(repo, "docs/approval-incident-analysis-ja.md", "PRIVATE_CANARY: internal analysis.\n");
  write(repo, "docs/private-not-selected.md", "PRIVATE_CANARY: unselected source document.\n");
  write(repo, "docs/public.md", "PRIVATE_CANARY: later working document.\n");
  const later = commit(repo, "internal analysis plus a product correction");
  write(repo, "README.md", "DIRTY_CANARY: must never be read by the CLI.\n");
  write(repo, "untracked.txt", "DIRTY_CANARY: untracked file.\n");
  const files = ["README.md", "asset.bin", "non-utf8.txt", "new.bin", "release/a/before/file.dat", "docs/pr.md", "docs/public.md", "docs/proof.log", "run.sh"].map(name => item(repo, base, candidate, name));
  files.push({ path: "remove.txt", operation: "delete", beforeBlobSha: git(repo, "rev-parse", `${base}:remove.txt`).toString().trim() });
  const spec = {
    schemaVersion: 1,
    destination: { repository: "kaduiro/mori-desk", visibility: "public", branch: "codex/browser-conversation-labels", pullRequest: 5 },
    authorization: "not-recorded", baseCommit: base, expectedTargetTreeSha: expectedTree,
    prBodyPath: "docs/pr.md", productReadiness: "Synthetic packet fixture; no product acceptance.", files
  };
  const observation = {
    observedAtJst: "2026-10-21T20:11:32+09:00",
    repository: { fullName: "kaduiro/mori-desk", visibility: "public", archived: false },
    pullRequest: { number: 5, headRepository: "kaduiro/mori-desk", headBranch: "codex/browser-conversation-labels", headSha: base, baseBranch: "main", state: "open", draft: true, merged: false }
  };
  return { repo, base, candidate, later, expectedTree, mixedExpectedTree, spec, observation };
}

test("publication packets use exact Git blobs and preserve the disclosure boundary", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mori-publication-test-"));
  const previousConfig = env.GIT_CONFIG_GLOBAL;
  env.GIT_CONFIG_GLOBAL = path.join(root, "git-config");
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[diff]\n\tmnemonicPrefix = true\n");
  t.after(() => { env.GIT_CONFIG_GLOBAL = previousConfig; fs.rmSync(root, { recursive: true, force: true }); });
  const f = fixture(root);
  let attempt = 0;
  function prepare(spec, output = path.join(root, `packet-${++attempt}`), observation = f.observation, repo = f.repo) {
    const specFile = path.join(root, `spec-${++attempt}.json`);
    const observationFile = path.join(root, `observation-${attempt}.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec));
    fs.writeFileSync(observationFile, JSON.stringify(observation));
    const result = spawnSync(process.execPath, [cli, "--repo", repo, "--spec", specFile, "--remote-observation", observationFile, "--output", output], { env, encoding: "utf8" });
    assert.equal(result.error, undefined, "CLI must actually start");
    return { ...result, output };
  }
  function reject(spec, reason, output, observation) {
    const result = prepare(spec, output, observation);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
    assert.equal(fs.existsSync(result.output), false, "validation failure must not leave a packet");
  }
  let goodPacket;

  await t.test("replays binary/add/delete/mode changes into the exact tree without reading the dirty worktree", () => {
    const originalIndex = fs.readFileSync(path.join(f.repo, ".git/index"));
    const originalHead = git(f.repo, "rev-parse", "HEAD");
    const originalStatus = git(f.repo, "status", "--porcelain=v1", "-z");
    const result = prepare(f.spec);
    assert.equal(result.status, 0, result.stderr);
    goodPacket = result.output;
    const manifest = JSON.parse(fs.readFileSync(path.join(goodPacket, "manifest.json")));
    assert.equal(manifest.targetTreeSha, f.expectedTree);
    assert.equal(manifest.authorization, "not-recorded");
    assert.equal(manifest.remoteFreshness, "pending");
    assert.equal(manifest.expectedRemoteHead, f.observation.pullRequest.headSha);
    assert.equal(JSON.parse(result.stdout).networkWrites, 0);
    for (const record of manifest.files.filter(record => record.operation !== "delete")) {
      assert.deepEqual(fs.readFileSync(path.join(goodPacket, record.payloadPath)), git(f.repo, "show", `${f.candidate}:${record.path}`), record.path);
    }
    const replay = path.join(root, "replay");
    // Only this isolated fixture is cloned. Production history is never exported.
    git(root, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", f.repo, replay);
    git(replay, "checkout", "--quiet", "--detach", f.base);
    git(replay, "apply", "--check", path.join(goodPacket, "changes.patch"));
    git(replay, "apply", "--binary", path.join(goodPacket, "changes.patch"));
    git(replay, "add", "--all", "--force");
    assert.equal(git(replay, "write-tree").toString().trim(), f.expectedTree);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), originalIndex);
    assert.deepEqual(git(f.repo, "rev-parse", "HEAD"), originalHead);
    assert.deepEqual(git(f.repo, "status", "--porcelain=v1", "-z"), originalStatus);
    for (const line of fs.readFileSync(path.join(goodPacket, "SHA256SUMS"), "utf8").trim().split("\n")) {
      const [expected, relative] = line.split("  ");
      assert.equal(hash(fs.readFileSync(path.join(goodPacket, relative))), expected, relative);
    }
  });

  await t.test("composes selected blobs from a private descendant without including its document changes or history", () => {
    const mixed = structuredClone(f.spec);
    mixed.files[0] = item(f.repo, f.base, f.later, "README.md");
    mixed.expectedTargetTreeSha = f.mixedExpectedTree;
    const result = prepare(mixed);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.output, "manifest.json")));
    assert.deepEqual(manifest.sourceCommits, [f.candidate, f.later].sort());
    assert.equal(manifest.targetTreeSha, f.mixedExpectedTree);
    assert.equal(manifest.baseCommit, f.base);
    assert.match(manifest.historyStrategy, /only parent/);
    assert.equal(fs.readFileSync(path.join(result.output, "payload/docs/public.md"), "utf8"), "Reviewed public evidence.\n");
    for (const name of ["docs/approval-incident-analysis-ja.md", "docs/private-not-selected.md", "untracked.txt", ".git"]) {
      assert.equal(fs.existsSync(path.join(result.output, "payload", name)), false, name);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(result.output, "changes.patch"), "utf8"), /PRIVATE_CANARY|DIRTY_CANARY/);
  });

  await t.test("accepts Windows drive and directory spelling aliases of the same physical repository", { skip: process.platform !== "win32" }, () => {
    assert.match(f.repo, /^[A-Za-z]:/);
    const driveAlias = f.repo.replace(/^[A-Za-z]/, drive => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
    const directoryAlias = path.join(path.dirname(f.repo), "SoUrCe").replace(/\\/g, "/");
    for (const alias of [driveAlias, directoryAlias]) {
      assert.notEqual(alias, f.repo);
      assert.equal(fs.readFileSync(path.join(alias, "untracked.txt"), "utf8"), "DIRTY_CANARY: untracked file.\n");
      const result = prepare(f.spec, undefined, f.observation, alias);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(result.output, "manifest.json")));
      assert.equal(manifest.targetTreeSha, f.expectedTree);
    }
  });

  await t.test("rejects a physically different root even when its name differs only by case", async t => {
    const differentRoot = path.join(root, "SOURCE");
    if (fs.existsSync(differentRoot)) { t.skip("The filesystem does not provide distinct case-sensitive directory names."); return; }
    fs.mkdirSync(differentRoot);
    write(differentRoot, ".git", `gitdir: ${path.join(f.repo, ".git")}\n`);
    git(f.repo, "config", "core.worktree", f.repo);
    try {
      assert.equal(fs.realpathSync(git(differentRoot, "rev-parse", "--show-toplevel").toString().trim()), fs.realpathSync(f.repo));
      const result = prepare(f.spec, undefined, f.observation, differentRoot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /actual repository top-level/);
      assert.equal(fs.existsSync(result.output), false);
    } finally { git(f.repo, "config", "--unset", "core.worktree"); }
  });

  await t.test("rejects changed bytes, blob IDs, modes, mutable revisions, and a different expected tree", () => {
    for (const [change, reason] of [
      [spec => { spec.files[0].sha256 = "0".repeat(64); }, /Content mismatch/],
      [spec => { spec.files[0].blobSha = "0".repeat(40); }, /Blob SHA mismatch/],
      [spec => { spec.files[0].mode = "100755"; }, /Mode mismatch/],
      [spec => { spec.files[0].sourceCommit = "HEAD"; }, /immutable full commit SHA/],
      [spec => { spec.expectedTargetTreeSha = "0".repeat(40); }, /differs from the expected tree/]
    ]) {
      const spec = structuredClone(f.spec);
      change(spec);
      reject(spec, reason);
    }
  });

  await t.test("keeps known internal documents excluded even when the spec omits exclusions", () => {
    const spec = structuredClone(f.spec);
    spec.files.push(item(f.repo, f.base, f.later, "docs/approval-incident-analysis-ja.md"));
    reject(spec, /Excluded publication path/);
    const inherited = structuredClone(f.spec);
    inherited.baseCommit = f.later;
    delete inherited.expectedTargetTreeSha;
    inherited.files = [item(f.repo, f.later, f.candidate, "README.md")];
    inherited.prBodyPath = "README.md";
    reject(inherited, /baseCommit does not match the supplied read-only remote observation/);
    const observedPrivateBase = structuredClone(f.observation);
    observedPrivateBase.pullRequest.headSha = f.later;
    reject(inherited, /Excluded material is present in the composed tree/, undefined, observedPrivateBase);
  });

  await t.test("uses the named Git objects even when the local repository has replace refs", () => {
    git(f.repo, "replace", f.candidate, f.base);
    try {
      const result = prepare(f.spec);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(result.output, "manifest.json")));
      assert.equal(manifest.targetTreeSha, f.expectedTree);
    } finally { git(f.repo, "replace", "--delete", f.candidate); }
  });

  await t.test("does not accept a self-declared approval or a different remote destination", () => {
    const claimed = structuredClone(f.spec);
    claimed.authorization = "granted";
    reject(claimed, /cannot assert or grant authorization/);
    const redirected = structuredClone(f.spec);
    redirected.destination.branch = "main";
    reject(redirected, /explicitly reviewed destination/);
  });

  await t.test("preserves existing packets and rejects output inside the source repository", () => {
    const before = fs.readFileSync(path.join(goodPacket, "manifest.json"));
    const result = prepare(f.spec, goodPacket);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Output already exists/);
    assert.deepEqual(fs.readFileSync(path.join(goodPacket, "manifest.json")), before);
    reject(f.spec, /outside the source repository/, path.join(f.repo, "packet"));
  });

  await t.test("cannot write into Git metadata through a subdirectory or a linked worktree", () => {
    const subdirectory = path.join(f.repo, "release");
    fs.mkdirSync(subdirectory, { recursive: true });
    const output = path.join(f.repo, ".git", "new-packet");
    const child = prepare(f.spec, output, f.observation, subdirectory);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /actual repository top-level/);
    assert.equal(fs.existsSync(output), false);
    const linked = path.join(root, "linked-worktree");
    git(f.repo, "worktree", "add", "--quiet", "--detach", linked, f.base);
    const shared = prepare(f.spec, output, f.observation, linked);
    assert.notEqual(shared.status, 0);
    assert.match(shared.stderr, /outside repository Git metadata/);
    assert.equal(fs.existsSync(output), false);
  });
});
