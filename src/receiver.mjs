import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 6;

export class ItemFailure extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.name = 'ItemFailure';
    this.reason = reason;
    this.detail = detail || reason;
  }
}

export function isStrongValidator(etag) {
  return typeof etag === 'string' && etag.startsWith('"') && etag.length > 2;
}

async function pathSize(file) {
  try { return (await stat(file)).size; } catch { return null; }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value || '');
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

async function cancelBody(response) {
  try { if (response.body) await response.body.cancel(); } catch { /* 取消失败不影响主流程 */ }
}

function safeName(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

async function mapPool(items, width, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run));
  return results;
}

function newLedger(item, requested) {
  return {
    id: item.id, state: 'receiving', source: requested, requested,
    expectedSha256: item.sha256, expectedSize: item.size,
    validator: null, weakValidatorSeen: false,
    received: 0, receivedBytes: 0, size: null, sha256: null, reason: null,
    adoptedOrphan: false, discards: [], updatedAt: null,
  };
}

async function loadLedger(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function saveLedger(paths, ledger) {
  await writeAtomic(paths.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function quarantinePath(ctx, file, id, kind) {
  const name = `${id}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${kind}`;
  await rename(file, path.join(ctx.quarantineDir, name));
  return `var/quarantine/${name}`;
}

// 作废当前分片：移入隔离区并在账本上留下原因，随后清空续接凭据
async function discardFragment(ctx, ledger, paths, reason, detail) {
  const size = await pathSize(paths.part);
  let quarantine = null;
  if (size !== null) quarantine = await quarantinePath(ctx, paths.part, ledger.id, 'part');
  ledger.discards.push({ at: ctx.now(), offset: size ?? ledger.received ?? 0, reason, detail, quarantine });
  ledger.received = 0;
  ledger.validator = null;
  await saveLedger(paths, ledger);
}

function resolveUrl(ctx, raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('清单条目缺少资源地址');
  const url = new URL(raw, ctx.base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议 ${url.protocol}`);
  if (!ctx.allowedHosts.includes(url.hostname)) throw new Error(`资源地址主机 ${url.hostname} 不在清单允许列表`);
  return url.toString();
}

// 发起一次请求；人工处理跳转，跳转目标必须在清单允许域名内，
// 且跳转前后的验证信息不混用：已有分片与验证器一律作废，从偏移 0 重收。
async function openResponse(ctx, ledger, paths, offset) {
  let url = ledger.source;
  let currentOffset = offset;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers = {};
    if (currentOffset > 0) {
      headers.range = `bytes=${currentOffset}-`;
      headers['if-range'] = ledger.validator;
    }
    let response;
    try {
      response = await ctx.fetchImpl(url, { headers, redirect: 'manual' });
    } catch (error) {
      throw new ItemFailure('network-error', `请求失败：${error.cause?.message ?? error.message}`);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, offset: currentOffset };
    const location = response.headers.get('location');
    await cancelBody(response);
    if (!location) throw new ItemFailure('redirect-without-location', '跳转响应缺少 Location');
    const target = new URL(location, url);
    if (!ctx.allowedHosts.includes(target.hostname)) {
      throw new ItemFailure('redirect-host-not-allowed',
        `跳转目标 ${target.hostname} 不在本次清单允许的域名范围，未发起请求`);
    }
    if (currentOffset > 0) {
      await discardFragment(ctx, ledger, paths, 'redirect-restart',
        '发生跳转，跳转前后的验证信息不混用，已有分片作废');
      currentOffset = 0;
    }
    ledger.validator = null;
    ledger.source = target.toString();
    url = ledger.source;
  }
  throw new ItemFailure('redirect-loop', '跳转次数超过上限');
}

// 封存态核对：账本已封存的重新验证；磁盘已有封存文件但账本未提交的，
// 按清单摘要核验业务归属后收养或隔离。返回 { result } 表示无需传输。
async function reconcileSealed(ctx, item, ledger, paths, loaded) {
  const sealedSize = await pathSize(paths.sealed);
  if (loaded?.state === 'sealed') {
    if (sealedSize !== null) {
      const sha256 = await sha256File(paths.sealed);
      if (sealedSize === item.size && sha256 === item.sha256) {
        ledger.received = sealedSize;
        await saveLedger(paths, ledger);
        return { result: sealedReceipt(ledger, item, { recovered: true }) };
      }
      const quarantine = await quarantinePath(ctx, paths.sealed, ledger.id, 'sealed');
      ledger.discards.push({ at: ctx.now(), offset: sealedSize, reason: 'sealed-file-lost',
        detail: '账本已封存但磁盘文件摘要不符，隔离后重新接收', quarantine });
    } else {
      ledger.discards.push({ at: ctx.now(), offset: 0, reason: 'sealed-file-lost',
        detail: '账本已封存但磁盘文件缺失，重新接收', quarantine: null });
    }
    Object.assign(ledger, { state: 'receiving', received: 0, validator: null, size: null, sha256: null });
    await saveLedger(paths, ledger);
    return { ledger };
  }
  if (sealedSize !== null) {
    const sha256 = await sha256File(paths.sealed);
    if (sealedSize === item.size && sha256 === item.sha256) {
      Object.assign(ledger, { state: 'sealed', received: sealedSize, size: sealedSize, sha256,
        expectedSha256: item.sha256, expectedSize: item.size, adoptedOrphan: true, updatedAt: ctx.now() });
      await saveLedger(paths, ledger);
      return { result: sealedReceipt(ledger, item, { recovered: true }) };
    }
    const quarantine = await quarantinePath(ctx, paths.sealed, ledger.id, 'sealed');
    ledger.discards.push({ at: ctx.now(), offset: sealedSize, reason: 'orphan-sealed-mismatch',
      detail: '未登记的封存文件与清单摘要不符，已隔离并重新接收', quarantine });
    await saveLedger(paths, ledger);
  }
  return { ledger };
}

// 分片核对：返回可续接偏移。无账本归属、账本与磁盘长度不符、清单期望已变的分片一律作废。
async function reconcileFragment(ctx, item, ledger, paths, loaded) {
  const size = await pathSize(paths.part);
  if (size === null) {
    if (ledger.received > 0) {
      ledger.received = 0;
      ledger.validator = null;
      await saveLedger(paths, ledger);
    }
    return 0;
  }
  if (!loaded || loaded.state !== 'receiving') {
    await discardFragment(ctx, ledger, paths, 'fragment-unattributed',
      '分片缺少对应接收账本，无法确认来源验证器，作废重收');
    return 0;
  }
  if (size !== ledger.received) {
    await discardFragment(ctx, ledger, paths, 'ledger-size-mismatch',
      `账本记录 ${ledger.received} 字节但磁盘分片为 ${size} 字节，分片不可信，作废重收`);
    return 0;
  }
  if (ledger.expectedSha256 !== item.sha256 || ledger.expectedSize !== item.size) {
    await discardFragment(ctx, ledger, paths, 'expectation-changed',
      '清单期望的摘要或长度已变化（源端换版），旧分片作废重收');
    return 0;
  }
  return ledger.received;
}

function sealedReceipt(ledger, item, { recovered }) {
  const receipt = {
    id: ledger.id, status: 'sealed', path: `sealed/${ledger.id}`,
    size: ledger.size ?? ledger.received, sha256: ledger.sha256, expectedSha256: item.sha256,
    validator: ledger.validator ?? null, source: ledger.source, requested: ledger.requested,
    receivedBytes: ledger.receivedBytes, discards: ledger.discards,
  };
  if (recovered) receipt.recovered = true;
  if (ledger.adoptedOrphan) receipt.adoptedOrphan = true;
  if (ledger.weakValidatorSeen) receipt.weakValidatorSeen = true;
  return receipt;
}

function failedReceipt({ id, reason, detail, item, ledger }) {
  return {
    id, status: 'failed', reason, detail,
    expectedSha256: item?.sha256 ?? null, expectedSize: item?.size ?? null,
    source: ledger?.source ?? null, requested: ledger?.requested ?? null,
    validator: ledger?.validator ?? null, receivedBytes: ledger?.receivedBytes ?? 0,
    discards: ledger?.discards ?? [],
  };
}

async function receiveItem(item, ctx) {
  const id = String(item?.id ?? '');
  if (!safeName(id)) {
    return failedReceipt({ id, reason: 'invalid-id', detail: '业务编号不符合命名约束', item });
  }
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isInteger(item.size) || item.size < 0) {
    return failedReceipt({ id, reason: 'invalid-manifest-entry', detail: '清单条目缺少有效长度或摘要', item });
  }
  let requested;
  try {
    requested = resolveUrl(ctx, item.url);
  } catch (error) {
    return failedReceipt({ id, reason: 'url-not-allowed', detail: error.message, item });
  }
  const paths = {
    part: path.join(ctx.inboundDir, `${id}.part`),
    sealed: path.join(ctx.sealedDir, id),
    ledger: path.join(ctx.ledgerDir, `${id}.json`),
  };
  const loaded = await loadLedger(paths.ledger);
  const ledger = loaded ?? newLedger(item, requested);
  ledger.requested = requested;

  try {
    const sealed = await reconcileSealed(ctx, item, ledger, paths, loaded);
    if (sealed.result) return sealed.result;

    let offset = await reconcileFragment(ctx, item, ledger, paths, loaded);

    ledger.state = 'receiving';
    ledger.reason = null;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      if (offset > 0 && !isStrongValidator(ledger.validator)) {
        await discardFragment(ctx, ledger, paths, 'weak-validator-not-resumable',
          '分片缺少强验证器（弱 ETag 或缺失），不能证明两段可拼接，作废重收');
        offset = 0;
      }
      ledger.received = offset;
      ledger.expectedSha256 = item.sha256;
      ledger.expectedSize = item.size;
      ledger.updatedAt = ctx.now();
      await saveLedger(paths, ledger);

      const opened = await openResponse(ctx, ledger, paths, offset);
      offset = opened.offset;
      const { response } = opened;

      if (offset > 0) {
        if (response.status === 416) {
          await cancelBody(response);
          await discardFragment(ctx, ledger, paths, 'range-unsatisfiable',
            '服务端返回 416：本地分片长度超出远端资源，作废后完整重收');
          offset = 0;
          continue;
        }
        if (response.status === 206) {
          const range = parseContentRange(response.headers.get('content-range'));
          const length = Number(response.headers.get('content-length'));
          if (!range || range.start !== offset) {
            await cancelBody(response);
            await discardFragment(ctx, ledger, paths, 'content-range-mismatch',
              'Content-Range 起点与本地分片长度不符，拒绝拼接，作废重收');
            offset = 0;
            continue;
          }
          if ((range.total !== null && range.total !== item.size)
            || (Number.isInteger(length) && length !== item.size - offset)) {
            await cancelBody(response);
            await discardFragment(ctx, ledger, paths, 'size-changed',
              '远端长度与清单期望不一致，分片作废重收以重新核对');
            offset = 0;
            continue;
          }
        } else if (response.status === 200) {
          await discardFragment(ctx, ledger, paths, 'range-not-honored',
            '服务端对条件范围请求返回 200（忽略断点或验证器不符），旧分片作废，以本次完整响应重收');
          offset = 0;
        } else {
          await cancelBody(response);
          throw new ItemFailure(`http-${response.status}`, `范围请求返回状态 ${response.status}`);
        }
      } else if (response.status === 206) {
        const range = parseContentRange(response.headers.get('content-range'));
        if (!range || range.start !== 0) {
          await cancelBody(response);
          throw new ItemFailure('content-range-mismatch', '未请求范围却返回起点不为 0 的 206');
        }
      } else if (response.status !== 200) {
        await cancelBody(response);
        throw new ItemFailure(`http-${response.status}`, `请求返回状态 ${response.status}`);
      }

      const etag = response.headers.get('etag');
      if (isStrongValidator(etag)) {
        ledger.validator = etag;
        ledger.weakValidatorSeen = false;
      } else {
        ledger.validator = null;
        if (etag) ledger.weakValidatorSeen = true;
      }

      try {
        await pipeline(Readable.fromWeb(response.body),
          createWriteStream(paths.part, { flags: offset > 0 ? 'a' : 'w' }));
      } catch (error) {
        ledger.received = (await pathSize(paths.part)) ?? 0;
        ledger.receivedBytes += Math.max(0, ledger.received - offset);
        ledger.updatedAt = ctx.now();
        await saveLedger(paths, ledger);
        return failedReceipt({ id, reason: 'transfer-incomplete',
          detail: `传输中断（${error.message}）：分片与验证器已保留，可重跑续传`, item, ledger });
      }

      const size = (await pathSize(paths.part)) ?? 0;
      ledger.receivedBytes += Math.max(0, size - offset);
      ledger.received = size;
      if (size < item.size) {
        ledger.updatedAt = ctx.now();
        await saveLedger(paths, ledger);
        return failedReceipt({ id, reason: 'transfer-incomplete',
          detail: `响应提前结束（${size}/${item.size}），分片已保留，可重跑续传`, item, ledger });
      }
      if (size > item.size) {
        await discardFragment(ctx, ledger, paths, 'size-overflow', '接收字节超过清单长度，分片已隔离');
        ledger.state = 'failed';
        await saveLedger(paths, ledger);
        return failedReceipt({ id, reason: 'size-overflow', detail: '接收字节超过清单长度', item, ledger });
      }
      const sha256 = await sha256File(paths.part);
      if (sha256 !== item.sha256) {
        await discardFragment(ctx, ledger, paths, 'digest-mismatch', '摘要校验不符，分片已隔离，不进入封存');
        ledger.state = 'failed';
        await saveLedger(paths, ledger);
        return failedReceipt({ id, reason: 'digest-mismatch', detail: '摘要校验不符，分片已隔离', item, ledger });
      }
      await rename(paths.part, paths.sealed);
      Object.assign(ledger, { state: 'sealed', size, sha256, updatedAt: ctx.now() });
      await saveLedger(paths, ledger);
      if (ctx.crashAfterSeal) process.exit(3); // 演练钩子：模拟封存后、回执写入前异常退出
      return sealedReceipt(ledger, item, { recovered: false });
    }
    ledger.state = 'failed';
    await saveLedger(paths, ledger);
    return failedReceipt({ id, reason: 'attempts-exhausted', detail: '重试次数耗尽', item, ledger });
  } catch (error) {
    if (error instanceof ItemFailure) {
      if (ledger.state !== 'sealed') ledger.state = 'failed';
      ledger.reason = error.reason;
      ledger.updatedAt = ctx.now();
      await saveLedger(paths, ledger);
      return failedReceipt({ id, reason: error.reason, detail: error.detail, item, ledger });
    }
    throw error;
  }
}

async function createContext({ base, manifest, dir, fetchImpl, crashAfterSeal, now }) {
  const sealedDir = path.join(dir, 'sealed');
  const inboundDir = path.join(dir, 'var', 'inbound');
  const ledgerDir = path.join(dir, 'var', 'ledger');
  const quarantineDir = path.join(dir, 'var', 'quarantine');
  for (const directory of [sealedDir, inboundDir, ledgerDir, quarantineDir]) {
    await mkdir(directory, { recursive: true });
  }
  const allowedHosts = Array.isArray(manifest.allowedHosts) && manifest.allowedHosts.length > 0
    ? manifest.allowedHosts
    : (base ? [new URL(base).hostname] : []);
  return {
    base, manifest, dir, fetchImpl, crashAfterSeal, now,
    sealedDir, inboundDir, ledgerDir, quarantineDir,
    receiptPath: path.join(dir, 'receipt.json'), allowedHosts,
  };
}

// 正式接收入口：逐项接收（限流并行、流式写盘），只有长度、摘要、业务归属
// 全部通过的条目才进入 sealed/；每次运行结束原子重写 receipt.json。
export async function receive({ base, manifest, dir = '.', concurrency = 2,
  fetchImpl = fetch, crashAfterSeal = false, now = () => new Date().toISOString() }) {
  if (!manifest || !Array.isArray(manifest.attachments)) throw new Error('清单缺少 attachments 数组');
  const ctx = await createContext({ base, manifest, dir, fetchImpl, crashAfterSeal, now });
  const seen = new Set();
  const tasks = manifest.attachments.map(item => {
    const id = String(item?.id ?? '');
    if (seen.has(id)) return () => failedReceipt({ id, reason: 'duplicate-id', detail: '清单内业务编号重复', item });
    seen.add(id);
    return () => receiveItem(item, ctx);
  });
  const items = await mapPool(tasks, Math.max(1, concurrency), task => task());
  const receipt = {
    generatedAt: now(), origin: base ?? null,
    allSealed: items.every(item => item.status === 'sealed'), items,
  };
  await writeAtomic(ctx.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
