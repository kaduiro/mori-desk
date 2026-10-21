#!/usr/bin/env node
// Local-only publication packet preparation. No repository/remote writes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const usage = 'node scripts/prepare-publication.mjs --repo <repository> --spec <JSON> --remote-observation <JSON> --output <new-directory>';
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--repo', '--spec', '--remote-observation', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(usage);
  options[args[i]] = args[i + 1];
}
if (Object.keys(options).length !== 4) throw new Error(usage);
const repo = fs.realpathSync(options['--repo']);
const requestedOutput = path.resolve(options['--output']);
const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
const outputRelativeToRepo = path.relative(repo, output);
if (!outputRelativeToRepo || (!path.isAbsolute(outputRelativeToRepo) && outputRelativeToRepo !== '..' && !outputRelativeToRepo.startsWith('..' + path.sep))) throw new Error('Output must be outside the source repository.');
if (fs.existsSync(output)) throw new Error('Output already exists; choose a new packet directory.');
const specBytes = fs.readFileSync(options['--spec']);
const spec = JSON.parse(specBytes);
const observationBytes = fs.readFileSync(options['--remote-observation']);
const observation = JSON.parse(observationBytes);
const sha256 = b => createHash('sha256').update(b).digest('hex');
// Promisor repositories must not silently fetch missing objects during preparation.
const gitEnv = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[key];
const git = (...a) => execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '-C', repo, ...a], { env: gitEnv, maxBuffer: 32 * 1024 * 1024 });
const topLevel = fs.realpathSync(git('rev-parse', '--show-toplevel').toString().trim());
if (repo !== topLevel) {
  // Git and Node can spell the same Windows directory differently. Compare
  // exact filesystem identities; case-folding paths could admit another root
  // on a case-sensitive filesystem. Unknown/zero identities remain rejected.
  const requestedRoot = fs.statSync(repo, { bigint: true });
  const actualRoot = fs.statSync(topLevel, { bigint: true });
  if (!requestedRoot.isDirectory() || !actualRoot.isDirectory()
      || requestedRoot.dev === 0n || actualRoot.dev === 0n
      || requestedRoot.ino === 0n || actualRoot.ino === 0n
      || requestedRoot.dev !== actualRoot.dev || requestedRoot.ino !== actualRoot.ino)
    throw new Error('Use the actual repository top-level for --repo.');
}
const gitDirectories = ['--absolute-git-dir', '--git-common-dir'].map(option => fs.realpathSync(path.resolve(repo, git('rev-parse', option).toString().trim())));
for (const directory of gitDirectories) {
  const relative = path.relative(directory, output);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw new Error('Output must be outside repository Git metadata, including shared worktree metadata.');
}
const fullCommit = id => {
  if (typeof id !== 'string' || !/^[a-f0-9]{40}$/.test(id)) throw new Error('Use an immutable full commit SHA.');
  if (git('cat-file', '-t', id).toString().trim() !== 'commit') throw new Error('Source is not a commit.');
  return id;
};
const safePath = p => {
  if (typeof p !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(p) || p.startsWith('/') || p.includes('//') || p.split('/').some(s => ['', '.', '..', '.git', '.runtime', '.upstream'].includes(s.toLowerCase()))) throw new Error('Unsupported or unsafe repository path.');
  return p;
};
const treeCache = new Map();
function treeEntries(commit) {
  if (treeCache.has(commit)) return treeCache.get(commit);
  fullCommit(commit);
  const entries = new Map();
  for (const line of git('ls-tree', '-r', '-z', '--full-tree', commit).toString('utf8').split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    const name = safePath(line.slice(tab + 1));
    entries.set(name, { mode, type, oid });
  }
  treeCache.set(commit, entries);
  return entries;
}
function objectHash(type, buffer) {
  return createHash('sha1').update(Buffer.from(`${type} ${buffer.length}\0`)).update(buffer).digest('hex');
}
function composedTreeHash(entries) {
  const root = new Map();
  for (const [name, value] of entries) {
    const parts = name.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      if (!(node.get(part) instanceof Map)) throw new Error('Conflicting tree paths.');
      node = node.get(part);
    }
    const leaf = parts.at(-1);
    if (node.has(leaf)) throw new Error('Conflicting tree paths.');
    node.set(leaf, value);
  }
  const hashNode = node => {
    const sorted = [...node].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av instanceof Map ? '/' : '')), Buffer.from(b + (bv instanceof Map ? '/' : ''))));
    const chunks = sorted.map(([name, value]) => {
      const isTree = value instanceof Map;
      const mode = isTree ? '40000' : value.mode.replace(/^0+/, '');
      const oid = isTree ? hashNode(value) : value.oid;
      return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
    });
    return objectHash('tree', Buffer.concat(chunks));
  };
  return hashNode(root);
}
if (spec.schemaVersion !== 1 || !Array.isArray(spec.files) || !spec.files.length) throw new Error('Invalid publication specification.');
if (typeof spec.productReadiness !== 'string' || !spec.productReadiness.trim()) throw new Error('Describe the candidate readiness and remaining acceptance gaps.');
if (spec.destination?.repository !== 'kaduiro/mori-desk' || spec.destination?.branch !== 'codex/browser-conversation-labels' || spec.destination?.pullRequest !== 5 || spec.destination?.visibility !== 'public') throw new Error('This task requires the explicitly reviewed destination.');
if (spec.authorization !== 'not-recorded') throw new Error('Packet preparation cannot assert or grant authorization.');
const observedPr = observation.pullRequest;
if (observation.repository?.fullName !== spec.destination.repository || observation.repository?.visibility !== spec.destination.visibility || observation.repository?.archived !== false || observedPr?.number !== spec.destination.pullRequest || observedPr?.headRepository !== spec.destination.repository || observedPr?.headBranch !== spec.destination.branch || observedPr?.baseBranch !== 'main' || observedPr?.state !== 'open' || observedPr?.draft !== true || observedPr?.merged !== false || !Number.isFinite(Date.parse(observation.observedAtJst))) throw new Error('Supplied remote observation does not match the expected open Draft PR and public repository.');
if (spec.baseCommit !== observedPr.headSha) throw new Error('baseCommit does not match the supplied read-only remote observation.');
const base = fullCommit(spec.baseCommit);
const baseTree = treeEntries(base);
const targetTree = new Map(baseTree);
const baseTreeSha = git('rev-parse', `${base}^{tree}`).toString().trim();
if (composedTreeHash(baseTree) !== baseTreeSha) throw new Error('Local tree reconstruction did not match Git.');
const excluded = [...new Set([
  'docs/approval-incident-analysis-ja.md',
  'docs/parallel-delivery-recovery-plan-ja.md',
  'docs/review-evidence/approval-incident-20261021',
  'docs/review-evidence/parallel-plan-20261021',
  'docs/parallel-implementation-execution-ja.md',
  'docs/review-evidence/parallel-implementation-20261021',
  ...(spec.excludedPaths ?? [])
].map(safePath))];
const seen = new Set();
const payloads = new Map();
const records = [];
for (const item of [...spec.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
  const name = safePath(item.path);
  if (seen.has(name)) throw new Error('Duplicate publication path.');
  seen.add(name);
  if (excluded.some(p => name === p || name.startsWith(p + '/'))) throw new Error(`Excluded publication path: ${name}`);
  const before = baseTree.get(name);
  if (before && (before.type !== 'blob' || !['100644', '100755'].includes(before.mode))) throw new Error(`Changed base file must be a regular Git blob: ${name}`);
  if (item.operation === 'delete') {
    if (!before || item.beforeBlobSha !== before.oid) throw new Error(`Deletion precondition mismatch: ${name}`);
    targetTree.delete(name);
    records.push({ path: name, operation: 'delete', beforeMode: before.mode, beforeBlobSha: before.oid, mode: null, blobSha: null, sourceCommit: null, bytes: 0, sha256: null, payloadPath: null });
    continue;
  }
  const sourceCommit = fullCommit(item.sourceCommit);
  const entry = treeEntries(sourceCommit).get(name);
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Publication file must be a regular Git blob: ${name}`);
  if (item.blobSha !== entry.oid) throw new Error(`Blob SHA mismatch: ${name}`);
  if (item.mode !== entry.mode) throw new Error(`Mode mismatch: ${name}`);
  const content = git('cat-file', 'blob', entry.oid);
  if (item.sha256 !== sha256(content) || item.bytes !== content.length || objectHash('blob', content) !== entry.oid) throw new Error(`Content mismatch: ${name}`);
  const operation = before ? 'modify' : 'add';
  if (item.operation !== operation || (before && before.oid === entry.oid && before.mode === entry.mode)) throw new Error(`Operation mismatch/no-op: ${name}`);
  targetTree.set(name, entry);
  payloads.set(name, content);
  records.push({ path: name, operation, beforeMode: before?.mode ?? null, beforeBlobSha: before?.oid ?? null, mode: entry.mode, blobSha: entry.oid, sourceCommit, bytes: content.length, sha256: sha256(content), payloadPath: `payload/${name}` });
}
for (const name of targetTree.keys()) if (excluded.some(p => name === p || name.startsWith(p + '/'))) throw new Error(`Excluded material is present in the composed tree: ${name}`);
const targetTreeSha = composedTreeHash(targetTree);
if (spec.expectedTargetTreeSha && spec.expectedTargetTreeSha !== targetTreeSha) throw new Error('Composed publication tree differs from the expected tree.');
const prRecord = records.find(r => r.path === spec.prBodyPath && r.operation !== 'delete');
if (!prRecord) throw new Error('PR body must come from an explicitly included immutable file.');
new TextDecoder('utf-8', { fatal: true }).decode(payloads.get(prRecord.path));
const manifest = {
  schemaVersion: 1, destination: spec.destination, authorization: 'not-recorded',
  baseCommit: base, expectedRemoteHead: observedPr.headSha, baseTreeSha, targetTreeSha, excludedPaths: excluded,
  remoteObservation: { packetPath: 'remote-observation.json', sha256: sha256(observationBytes), observedAt: observation.observedAtJst, assurance: 'Matches supplied read-only observation; authenticity and current remote state are not verified by this offline CLI.' },
  remoteFreshness: 'pending',
  sourceCommits: [...new Set(records.map(r => r.sourceCommit).filter(Boolean))].sort(),
  historyStrategy: 'Create a new publication commit from this composed tree with baseCommit as its only parent. Do not push local source histories.',
  outboundPaths: records.filter(r => r.operation !== 'delete').map(r => r.payloadPath),
  fileCount: records.length, contentBytes: records.reduce((n, r) => n + r.bytes, 0),
  productReadiness: spec.productReadiness, files: records,
  pullRequestBody: { sourceCommit: prRecord.sourceCommit, sourcePath: prRecord.path, sha256: prRecord.sha256, packetPath: 'pr-body.md' },
  pendingChecks: ['Explicit publication scope authorization', 'Fresh remote head/destination check', 'Public-content review', 'Remote tree/commit/ref readback', 'Candidate Windows CI', 'Real-provider and target-OS acceptance']
};
const stage = fs.mkdtempSync(path.join(path.dirname(output), '.mori-publication-staging-'));
const write = (relative, bytes, mode = '100644') => {
  const filename = path.join(stage, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  fs.chmodSync(filename, mode === '100755' ? 0o755 : 0o644);
};
try {
  fs.mkdirSync(path.join(stage, 'before'));
  fs.mkdirSync(path.join(stage, 'after'));
  for (const record of records) {
    if (record.beforeBlobSha) write(`before/${record.path}`, git('cat-file', 'blob', record.beforeBlobSha), record.beforeMode);
    if (record.payloadPath) write(`after/${record.path}`, payloads.get(record.path), record.mode);
  }
  const diff = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.filemode=true', '-c', 'core.autocrlf=false', '-c', 'color.ui=false', 'diff', '--no-index', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'], { cwd: stage, env: gitEnv, maxBuffer: 32 * 1024 * 1024 });
  if (![0, 1].includes(diff.status)) throw new Error('Could not produce the review diff.');
  // Git can render a non-UTF-8 blob as text. Only rewrite ASCII header paths;
  // never decode the remaining patch bytes as UTF-8.
  let inHeader = false;
  const chunks = [];
  for (let start = 0; start < diff.stdout.length;) {
    let end = diff.stdout.indexOf(10, start);
    if (end < 0) end = diff.stdout.length;
    const line = diff.stdout.subarray(start, end);
    const asciiPrefix = line.subarray(0, 16).toString('latin1');
    if (asciiPrefix.startsWith('diff --git ')) inHeader = true;
    if (asciiPrefix.startsWith('@@') || asciiPrefix === 'GIT binary patch') inHeader = false;
    chunks.push(inHeader && /^(diff --git |--- |\+\+\+ )/.test(asciiPrefix)
      ? Buffer.from(line.toString('latin1').replace(/(^| )([ab])\/(?:before|after)\//g, '$1$2/'), 'latin1') : line);
    if (end < diff.stdout.length) chunks.push(diff.stdout.subarray(end, end + 1));
    start = end + 1;
  }
  const patch = Buffer.concat(chunks);
  write('changes.patch', patch);
  fs.rmSync(path.join(stage, 'before'), { recursive: true });
  fs.renameSync(path.join(stage, 'after'), path.join(stage, 'payload'));
  write('publication-spec.json', JSON.stringify(spec, null, 2) + '\n');
  write('remote-observation.json', observationBytes);
  write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  write('pr-body.md', payloads.get(prRecord.path));
  write('PUBLICATION-SCOPE.md', `# Mori Desk 公開候補\n\nこのパケットはローカル準備物です。公開許可・送信・CI実行は未実施です。\n\n- 宛先: publicリポジトリ kaduiro/mori-desk\n- ブランチ: codex/browser-conversation-labels / Draft PR #5\n- 期待remote head: ${base}\n- 公開候補tree: ${targetTreeSha}\n- 対象: ${records.length}変更、内容 ${manifest.contentBytes} bytes。manifest.outboundPathsだけを送信対象とし、PR本文はpr-body.mdです。\n- 許可の対象案: 修正ソース、試験、公開用の非機密検証記録、PR本文、および既存Windows CIの実行・公開ログ。同じ復旧タスクの同種の後続修正。mainマージ、リリース、配布、公開範囲変更、別宛先を含みません。\n- 現在の製品判定: ${spec.productReadiness}\n\n## 将来の送信手順\n\n具体的な公開範囲の許可後にremote headを再確認します。必要なpayloadのblobを送信し、そのblobとbaseTreeShaから新treeを作成します。treeがtargetTreeShaに一致することを確認してから、baseCommitだけを親に新しい公開commitを作成します。期待headを照合し、forceなしで作業refを更新します。作業側のsourceCommit・その祖先をpush/mergeしてはいけません。拒否が再発したら別経路で回避せず停止します。\n\nその後、Draftを維持してPR本文を更新し、remote内容・CI run ID・イベント・実checkout SHA・結果を照合します。候補の機械試験成功を実サービスや実Windowsの受入へ読み替えません。\n\n## パケットの境界\n\npayload以外のmanifest/spec/差分/この説明/後から追加する観察記録は提出内容の点検用です。パケット全体をリポジトリへコピーしたり、準備したことを公開許可と扱ったりしません。\n`);
  const digestLines = [];
  const collect = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) collect(path.join(directory, entry.name), relative + '/');
      else digestLines.push(`${sha256(fs.readFileSync(path.join(directory, entry.name)))}  ${relative}\n`);
    }
  };
  collect(stage);
  write('SHA256SUMS', digestLines.join(''));
  fs.renameSync(stage, output);
  process.stdout.write(JSON.stringify({ output, fileCount: manifest.fileCount, contentBytes: manifest.contentBytes, baseTreeSha, targetTreeSha, authorization: 'not-recorded', networkWrites: 0 }) + '\n');
} catch (error) {
  fs.rmSync(stage, { recursive: true, force: true });
  throw error;
}
