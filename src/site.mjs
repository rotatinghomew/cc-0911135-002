import { createHash } from 'node:crypto';
import { serve, json } from '../lib/http.mjs';
export const payload = version => Buffer.from(('样品原始附件-' + version + '\n').repeat(4096));
export async function createSite(port = 0) {
  return serve(({ request, response, url, state }) => {
    const content = payload(state.version);
    const etag = (state.weak ? 'W/' : '') + `"revision-${state.version}"`;
    if (url.pathname === '/manifest') {
      json(response, 200, { attachments: [{ id: 'SUP-01', url: '/blob', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex') }], allowedHosts: ['127.0.0.1'] });
      return true;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: state.external ? 'http://not-permitted.invalid/blob' : '/blob' });
      response.end(); return true;
    }
    if (url.pathname !== '/blob') return false;
    const range = request.headers.range;
    const canRange = range && !state.ignoreRange && (!request.headers['if-range'] || request.headers['if-range'] === etag && !state.weak);
    let offset = 0;
    let status = 200;
    const headers = { etag, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
    if (canRange) {
      const match = /^bytes=(\d+)-$/.exec(range);
      if (!match) throw new Error('仅支持开放结束位置的单一 Range');
      offset = Number(match[1]);
      if (offset >= content.length) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${content.length}` });
        response.end(); return true;
      }
      status = 206;
      headers['content-range'] = `bytes ${state.wrongRange ? offset + 1 : offset}-${content.length - 1}/${content.length}`;
    }
    const data = content.subarray(offset);
    headers['content-length'] = data.length;
    response.writeHead(status, headers);
    if (state.cutOnce) {
      state.cutOnce = false;
      response.write(data.subarray(0, Math.max(1, Math.floor(data.length / 3))));
      setImmediate(() => response.destroy());
    } else {
      response.end(state.corrupt ? Buffer.alloc(data.length, 120) : data);
    }
    return true;
  }, { version: 1, weak: false, ignoreRange: false, wrongRange: false, cutOnce: false, corrupt: false, external: false }, port);
}
