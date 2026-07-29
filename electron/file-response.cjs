const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

function contentTypeFor(filePath) {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webm': 'video/webm'
  };
  return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function protocolFileResponse(filePath, request) {
  const size = fs.statSync(filePath).size;
  const range = request?.headers?.get('range');
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentTypeFor(filePath)
  };

  if (!range) {
    headers['Content-Length'] = String(size);
    const body = request?.method === 'HEAD'
      ? null
      : Readable.toWeb(fs.createReadStream(filePath));
    return new Response(body, { status: 200, headers });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` }
    });
  }

  const requestedStart = match[1] === '' ? null : Number(match[1]);
  const requestedEnd = match[2] === '' ? null : Number(match[2]);
  const start = requestedStart === null
    ? Math.max(0, size - requestedEnd)
    : requestedStart;
  const end = requestedStart === null
    ? size - 1
    : Math.min(requestedEnd ?? size - 1, size - 1);

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` }
    });
  }

  headers['Content-Length'] = String(end - start + 1);
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = request?.method === 'HEAD'
    ? null
    : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(body, { status: 206, headers });
}

module.exports = { protocolFileResponse };
