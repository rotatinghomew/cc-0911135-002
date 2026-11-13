import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

test('Range、条件验证及摘要清单', async () => withSite(async site => {
  const manifest = await (await fetch(site.url + '/manifest')).json();
  const part = await fetch(site.url + '/blob', { headers: { range: 'bytes=10-', 'if-range': '"revision-1"' } });
  assert.equal(part.status, 206);
  assert.match(part.headers.get('content-range'), /^bytes 10-/);
  assert.equal((await part.arrayBuffer()).byteLength, manifest.attachments[0].size - 10);
  await control(site, { version: 2 });
  const changed = await fetch(site.url + '/blob', { headers: { range: 'bytes=10-', 'if-range': '"revision-1"' } });
  assert.equal(changed.status, 200);
  await changed.arrayBuffer();
}));
test('越界和忽略 Range 响应', async () => withSite(async site => {
  assert.equal((await fetch(site.url + '/blob', { headers: { range: 'bytes=9999999-' } })).status, 416);
  await control(site, { ignoreRange: true });
  const result = await fetch(site.url + '/blob', { headers: { range: 'bytes=10-' } });
  assert.equal(result.status, 200); await result.arrayBuffer();
}));
test('错误回执不能通过结构检查', () => {
  assert.throws(() => verify({ items: [{ id: 'a', status: 'sealed', sha256: 'bad', expectedSha256: 'other' }] }));
});

test('弱验证器不授予范围续接，错误范围和断流可观察', async () => withSite(async site => {
  await control(site, { weak: true });
  const weak = await fetch(site.url + '/blob', { headers: { range: 'bytes=10-', 'if-range': 'W/"revision-1"' } });
  assert.equal(weak.status, 200); await weak.arrayBuffer();
  await control(site, { weak: false, wrongRange: true });
  const wrong = await fetch(site.url + '/blob', { headers: { range: 'bytes=10-' } });
  assert.match(wrong.headers.get('content-range'), /^bytes 11-/); await wrong.arrayBuffer();
  await control(site, { cutOnce: true, wrongRange: false });
  await assert.rejects(async () => { const response = await fetch(site.url + '/blob'); await response.arrayBuffer(); });
}));
