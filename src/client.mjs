export async function inspect(base) {
  const manifest = await (await fetch(base + '/manifest')).json();
  const response = await fetch(new URL(manifest.attachments[0].url, base), { headers: { range: 'bytes=0-' } });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { manifest, response: { status: response.status, etag: response.headers.get('etag'), bytes } };
}
