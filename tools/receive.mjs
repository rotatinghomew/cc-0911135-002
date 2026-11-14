import { readFile } from 'node:fs/promises';
import { receive } from '../src/receiver.mjs';

function parseArgs(argv) {
  const opts = { concurrency: 2, dir: '.', manifest: null, base: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (arg === '--manifest') opts.manifest = argv[++i];
    else positional.push(arg);
  }
  [opts.base] = positional;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.base) {
  console.error('用法：npm run receive -- <源站地址> [--dir 工作目录] [--concurrency N] [--manifest 清单文件]');
  process.exit(2);
}
if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
  console.error('--concurrency 必须是正整数');
  process.exit(2);
}

let manifest;
if (opts.manifest) {
  manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
} else {
  const response = await fetch(new URL('/manifest', opts.base));
  if (!response.ok) throw new Error(`清单拉取失败：HTTP ${response.status}`);
  manifest = await response.json();
}

const receipt = await receive({
  base: opts.base,
  manifest,
  dir: opts.dir,
  concurrency: opts.concurrency,
  crashAfterSeal: process.env.RECEIVE_CRASH_AFTER_SEAL === '1', // 演练钩子，非业务路径
});

console.log(JSON.stringify({
  allSealed: receipt.allSealed,
  receipt: `${opts.dir}/receipt.json`,
  items: receipt.items.map(({ id, status, reason }) => (reason ? { id, status, reason } : { id, status })),
}, null, 2));
process.exitCode = receipt.allSealed ? 0 : 1;
