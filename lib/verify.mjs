import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(Array.isArray(value.items));
  assert.equal(new Set(value.items.map(item => item.id)).size, value.items.length);
  for (const item of value.items) {
    assert.ok(['sealed', 'failed'].includes(item.status));
    if (item.status === 'sealed') {
      assert.equal(item.sha256, item.expectedSha256);
      assert.match(item.sha256, /^[a-f0-9]{64}$/);
      assert.ok(item.path.startsWith('sealed/') && !item.path.includes('..'));
      assert.ok(Number.isInteger(item.size) && item.size >= 0);
    } else assert.ok(item.reason);
  }
}
