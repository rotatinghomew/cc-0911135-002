import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createSite, payload } from '../src/site.mjs';
import { receive } from '../src/receiver.mjs';
import { verify } from '../lib/verify.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/receive.mjs', import.meta.url));

// 异步调用接收命令：站点运行在测试进程内，不能用 spawnSync 冻结事件循环
async function runCli(args, env = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args],
      { env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    if (typeof error.code === 'number') return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
}

async function tempWorkdir() { return mkdtemp(path.join(tmpdir(), 'receiver-drill-')); }
async function withSite(run) {
  const site = await createSite();
  try { return await run(site); } finally { await site.close(); }
}
async function control(site, value) {
  const response = await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
  assert.equal(response.status, 200);
}
async function manifestOf(site) {
  return (await fetch(site.url + '/manifest')).json();
}
const blobRequests = (site, since = 0) => site.audit.slice(since).filter(entry => entry.path === '/blob');
const exists = async file => { try { await stat(file); return true; } catch { return false; } };

test('断流后可凭强验证器续传并封存', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { cutOnce: true });
    const manifest = await manifestOf(site);
    const first = await receive({ base: site.url, manifest, dir });
    assert.equal(first.allSealed, false);
    assert.equal(first.items[0].status, 'failed');
    assert.equal(first.items[0].reason, 'transfer-incomplete');
    verify(first);

    const partSize = (await stat(path.join(dir, 'var/inbound/SUP-01.part'))).size;
    assert.ok(partSize > 0 && partSize < manifest.attachments[0].size);

    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest, dir });
    assert.equal(second.allSealed, true);
    verify(second);

    const resumed = blobRequests(site, mark);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].headers.range, `bytes=${partSize}-`);
    assert.equal(resumed[0].headers.ifRange, '"revision-1"');

    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(1));
    const item = second.items[0];
    assert.equal(item.validator, '"revision-1"');
    assert.equal(item.source, `${site.url}/blob`);
    assert.equal(item.receivedBytes, manifest.attachments[0].size);
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('源端换版后旧分片废弃且原因可查', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { cutOnce: true });
    const first = await receive({ base: site.url, manifest: await manifestOf(site), dir });
    assert.equal(first.items[0].reason, 'transfer-incomplete');

    await control(site, { version: 2 });
    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest: await manifestOf(site), dir });
    assert.equal(second.allSealed, true);
    verify(second);

    // 旧分片在发起请求前因清单期望变化被废弃，不产生拼接
    const requests = blobRequests(site, mark);
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].headers.range && !requests[0].headers.ifRange);
    assert.ok(second.items[0].discards.some(d => d.reason === 'expectation-changed'));
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(2));
    assert.equal(second.items[0].sha256, createHash('sha256').update(payload(2)).digest('hex'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('弱 ETag 分片不续传，作废后完整重收', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { weak: true, cutOnce: true });
    const manifest = await manifestOf(site);
    const first = await receive({ base: site.url, manifest, dir });
    assert.equal(first.items[0].reason, 'transfer-incomplete');
    const ledger = JSON.parse(await readFile(path.join(dir, 'var/ledger/SUP-01.json'), 'utf8'));
    assert.equal(ledger.validator, null);
    assert.equal(ledger.weakValidatorSeen, true);

    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest, dir });
    assert.equal(second.allSealed, true);
    const requests = blobRequests(site, mark);
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].headers.range && !requests[0].headers.ifRange);
    assert.ok(second.items[0].discards.some(d => d.reason === 'weak-validator-not-resumable'));
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(1));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('服务端忽略 Range 返回 200 时不续写，以完整响应重收', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { cutOnce: true });
    const manifest = await manifestOf(site);
    await receive({ base: site.url, manifest, dir });
    const partSize = (await stat(path.join(dir, 'var/inbound/SUP-01.part'))).size;

    await control(site, { ignoreRange: true });
    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest, dir });
    assert.equal(second.allSealed, true);

    // 续接请求被 200 拒绝后，直接用该响应体重写，不再追加第二次请求
    const requests = blobRequests(site, mark);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.range, `bytes=${partSize}-`);
    assert.ok(second.items[0].discards.some(d => d.reason === 'range-not-honored'));
    const sealed = await readFile(path.join(dir, 'sealed/SUP-01'));
    assert.equal(sealed.length, manifest.attachments[0].size);
    assert.deepEqual(sealed, payload(1));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('Content-Range 与本地长度不符时拒绝拼接', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { cutOnce: true });
    const manifest = await manifestOf(site);
    await receive({ base: site.url, manifest, dir });

    await control(site, { wrongRange: true });
    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest, dir });
    assert.equal(second.allSealed, true);

    const requests = blobRequests(site, mark);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].headers.range);
    assert.ok(!requests[1].headers.range);
    assert.ok(second.items[0].discards.some(d => d.reason === 'content-range-mismatch'));
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(1));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('本地分片越界时 416 触发核对而非接收成功', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    await control(site, { cutOnce: true });
    const manifest = await manifestOf(site);
    await receive({ base: site.url, manifest, dir });

    // 模拟人工拼接：分片被外加字节撑长，账本同步到一致（超过远端长度）
    const partPath = path.join(dir, 'var/inbound/SUP-01.part');
    await appendFile(partPath, Buffer.alloc(70000, 7));
    const bloated = (await stat(partPath)).size;
    assert.ok(bloated > manifest.attachments[0].size);
    const ledgerPath = path.join(dir, 'var/ledger/SUP-01.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    ledger.received = bloated;
    await writeFile(ledgerPath, JSON.stringify(ledger));

    const mark = site.audit.length;
    const second = await receive({ base: site.url, manifest, dir });
    assert.equal(second.allSealed, true);

    const requests = blobRequests(site, mark);
    assert.equal(requests[0].headers.range, `bytes=${bloated}-`);
    assert.ok(second.items[0].discards.some(d => d.reason === 'range-unsatisfiable'));
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(1));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('摘要不符拒收且不影响其他独立附件，整批不冒报成功', async () => {
  const siteA = await createSite();
  const siteB = await createSite();
  const dir = await tempWorkdir();
  try {
    await control(siteA, { corrupt: true });
    const clean = payload(1);
    const manifest = {
      attachments: [
        { id: 'SUP-A', url: `${siteA.url}/blob`, size: clean.length,
          sha256: createHash('sha256').update(clean).digest('hex') },
        { id: 'SUP-B', url: `${siteB.url}/blob`, size: clean.length,
          sha256: createHash('sha256').update(clean).digest('hex') },
      ],
      allowedHosts: ['127.0.0.1'],
    };
    const manifestPath = path.join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const run = await runCli([siteA.url, '--manifest', manifestPath, '--dir', dir, '--concurrency', '2']);
    assert.equal(run.status, 1, run.stderr);

    const receipt = JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8'));
    verify(receipt);
    assert.equal(receipt.allSealed, false);
    const a = receipt.items.find(item => item.id === 'SUP-A');
    const b = receipt.items.find(item => item.id === 'SUP-B');
    assert.equal(a.status, 'failed');
    assert.equal(a.reason, 'digest-mismatch');
    assert.equal(b.status, 'sealed');
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-B')), clean);
    assert.equal(await exists(path.join(dir, 'sealed/SUP-A')), false);
    assert.ok((await readdir(path.join(dir, 'var/quarantine'))).some(name => name.startsWith('SUP-A')));
  } finally {
    await siteA.close();
    await siteB.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('封存后、回执前异常退出，恢复时不重复封存且回执可解释', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    const crashed = await runCli([site.url, '--dir', dir], { RECEIVE_CRASH_AFTER_SEAL: '1' });
    assert.equal(crashed.status, 3, crashed.stderr);
    assert.equal(await exists(path.join(dir, 'sealed/SUP-01')), true);
    assert.equal(await exists(path.join(dir, 'receipt.json')), false);

    const rerun = await runCli([site.url, '--dir', dir]);
    assert.equal(rerun.status, 0, rerun.stderr);
    const receipt = JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8'));
    verify(receipt);
    assert.equal(receipt.allSealed, true);
    assert.equal(receipt.items[0].recovered, true);
    assert.equal(blobRequests(site).length, 1, '恢复不应重复下载');
    assert.deepEqual(await readFile(path.join(dir, 'sealed/SUP-01')), payload(1));
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('磁盘已有封存文件但账本未提交时按清单核验收养或隔离', async () => withSite(async site => {
  const manifest = await manifestOf(site);
  const adoptDir = await tempWorkdir();
  const tamperDir = await tempWorkdir();
  try {
    // 孤立文件内容正确：收养入账，不重复下载
    await mkdir(path.join(adoptDir, 'sealed'), { recursive: true });
    await writeFile(path.join(adoptDir, 'sealed/SUP-01'), payload(1));
    const adopted = await receive({ base: site.url, manifest, dir: adoptDir });
    assert.equal(adopted.allSealed, true);
    assert.equal(adopted.items[0].recovered, true);
    assert.equal(adopted.items[0].adoptedOrphan, true);
    assert.equal(blobRequests(site).length, 0);
    verify(adopted);

    // 孤立文件内容被改：隔离重收，回执留废弃原因
    await mkdir(path.join(tamperDir, 'sealed'), { recursive: true });
    await writeFile(path.join(tamperDir, 'sealed/SUP-01'), 'tampered-bytes');
    const mark = site.audit.length;
    const fixed = await receive({ base: site.url, manifest, dir: tamperDir });
    assert.equal(fixed.allSealed, true);
    assert.ok(fixed.items[0].discards.some(d => d.reason === 'orphan-sealed-mismatch'));
    assert.equal(blobRequests(site, mark).length, 1);
    assert.deepEqual(await readFile(path.join(tamperDir, 'sealed/SUP-01')), payload(1));
    assert.ok((await readdir(path.join(tamperDir, 'var/quarantine'))).length > 0);
  } finally {
    await rm(adoptDir, { recursive: true, force: true });
    await rm(tamperDir, { recursive: true, force: true });
  }
}));

test('越域跳转被拒绝，同站跳转可用且验证信息不混用', async () => withSite(async site => {
  const clean = payload(1);
  const manifest = {
    attachments: [{ id: 'SUP-01', url: '/redirect', size: clean.length,
      sha256: createHash('sha256').update(clean).digest('hex') }],
    allowedHosts: ['127.0.0.1'],
  };
  const blockedDir = await tempWorkdir();
  const allowedDir = await tempWorkdir();
  try {
    await control(site, { external: true });
    const blocked = await receive({ base: site.url, manifest, dir: blockedDir });
    assert.equal(blocked.allSealed, false);
    assert.equal(blocked.items[0].status, 'failed');
    assert.equal(blocked.items[0].reason, 'redirect-host-not-allowed');
    assert.match(blocked.items[0].detail, /not-permitted\.invalid/);
    verify(blocked);
    assert.equal(blobRequests(site).length, 0, '越域目标不得产生实际请求');

    await control(site, { external: false });
    const mark = site.audit.length;
    const followed = await receive({ base: site.url, manifest, dir: allowedDir });
    assert.equal(followed.allSealed, true);
    const item = followed.items[0];
    assert.equal(item.requested, `${site.url}/redirect`);
    assert.equal(item.source, `${site.url}/blob`);
    const trail = site.audit.slice(mark).map(entry => entry.path);
    assert.deepEqual(trail, ['/redirect', '/blob']);
    const blobRequest = blobRequests(site, mark)[0];
    assert.ok(!blobRequest.headers.ifRange && !blobRequest.headers.range,
      '跳转后的请求不得携带跳转前的验证信息');
    assert.deepEqual(await readFile(path.join(allowedDir, 'sealed/SUP-01')), clean);
  } finally {
    await rm(blockedDir, { recursive: true, force: true });
    await rm(allowedDir, { recursive: true, force: true });
  }
}));

test('多附件限流并行接收，全部独立封存', async () => withSite(async site => {
  const dir = await tempWorkdir();
  try {
    const clean = payload(1);
    const sha256 = createHash('sha256').update(clean).digest('hex');
    const manifest = {
      attachments: ['SUP-1', 'SUP-2', 'SUP-3', 'SUP-4']
        .map(id => ({ id, url: '/blob', size: clean.length, sha256 })),
      allowedHosts: ['127.0.0.1'],
    };
    const receipt = await receive({ base: site.url, manifest, dir, concurrency: 2 });
    assert.equal(receipt.allSealed, true);
    verify(receipt);
    assert.equal(receipt.items.length, 4);
    for (const id of ['SUP-1', 'SUP-2', 'SUP-3', 'SUP-4']) {
      assert.deepEqual(await readFile(path.join(dir, `sealed/${id}`)), clean);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}));
