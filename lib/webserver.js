// /journal 的只读 HTTP 面：页面、数据、媒体、偷看计数。
// 只依赖 node:http 与本地模块；不引入框架，也不做任何写日记的入口。

import fs from 'node:fs';
import path from 'node:path';
import { buildDay, listDays } from './page.js';
import { photoFile } from './media.js';
import { recordPeek } from './peek.js';

const ASSETS = {
  'journal.html': 'text/html; charset=utf-8',
  'journal.css': 'text/css; charset=utf-8',
  'journal.js': 'text/javascript; charset=utf-8',
  'journal-hand.woff2': 'font/woff2'
};
const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};
const MAX_BODY = 8192;

function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(head ? undefined : body);
}

function sendText(res, status, text, head = false) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(head ? undefined : text);
}

function sendMethodNotAllowed(res, allow) {
  const body = JSON.stringify({ error: 'method not allowed' });
  res.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    'allow': allow,
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (!raw) return false;
  const name = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function serveAsset(res, assetsDir, name, head = false) {
  let body;
  try {
    body = fs.readFileSync(path.join(assetsDir, name));
  } catch {
    return sendText(res, 404, 'not found');
  }
  res.writeHead(200, {
    'content-type': ASSETS[name],
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  return res.end(head ? undefined : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('body 过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createJournalHandler({ dir, assetsDir }) {
  return async function journalHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const isHead = req.method === 'HEAD';
      const isGet = req.method === 'GET' || isHead;

      // 页面只给本机/隧道用；Host 校验也挡住 DNS rebinding 的常见形态。
      if (!isLoopbackHost(req.headers.host)) {
        return sendJson(res, 403, { error: 'forbidden host' }, isHead);
      }

      if (pathname === '/journal' || pathname === '/journal/') {
        if (!isGet) return sendMethodNotAllowed(res, 'GET, HEAD');
        return serveAsset(res, assetsDir, 'journal.html', isHead);
      }

      if (pathname.startsWith('/journal/assets/')) {
        if (!isGet) return sendMethodNotAllowed(res, 'GET, HEAD');
        const name = pathname.slice('/journal/assets/'.length);
        if (!Object.hasOwn(ASSETS, name)) return sendText(res, 404, 'not found', isHead);
        return serveAsset(res, assetsDir, name, isHead);
      }

      if (pathname === '/journal/api/days' && isGet) {
        const scope = url.searchParams.get('scope') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 60);
        return sendJson(res, 200, { days: listDays(dir, { scope, limit }) }, isHead);
      }

      if (pathname === '/journal/api/day' && isGet) {
        const date = url.searchParams.get('date') ?? '';
        const scope = url.searchParams.get('scope') ?? '';
        try {
          return sendJson(res, 200, buildDay(dir, { date, scope }), isHead);
        } catch {
          return sendJson(res, 400, { error: 'date 必须是 YYYY-MM-DD' }, isHead);
        }
      }

      if (pathname.startsWith('/journal/media/') && isGet) {
        let rel;
        try {
          rel = decodeURIComponent(pathname.slice('/journal/media/'.length));
        } catch {
          return sendText(res, 400, 'bad path', isHead);
        }
        let file;
        try {
          file = photoFile(dir, path.posix.join('media', rel));
        } catch {
          return sendText(res, 404, 'not found', isHead);
        }
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          return sendText(res, 404, 'not found', isHead);
        }
        if (!stat.isFile()) return sendText(res, 404, 'not found', isHead);
        if (stat.size > 16 * 1024 * 1024) return sendText(res, 413, 'too large', isHead);

        const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        if (isHead) {
          res.writeHead(200, {
            'content-type': type,
            'content-length': stat.size,
            'cache-control': 'private, max-age=300'
          });
          return res.end();
        }

        // 读进内存再回，避免读流 error 在 headers 之后变成未捕获异常。
        let body;
        try {
          body = fs.readFileSync(file);
        } catch {
          return sendText(res, 404, 'not found');
        }
        res.writeHead(200, {
          'content-type': type,
          'content-length': body.length,
          'cache-control': 'private, max-age=300'
        });
        return res.end(body);
      }

      if (pathname === '/journal/api/peek' && req.method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          return sendJson(res, 415, { error: 'content-type must be application/json' });
        }
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') {
          return sendJson(res, 403, { error: 'cross-site request' });
        }
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = '';
          }
          if (!originHost || originHost !== req.headers.host) {
            return sendJson(res, 403, { error: 'cross-origin request' });
          }
        }

        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (error) {
          return sendJson(res, error.status ?? 400, { error: 'bad body' });
        }
        try {
          return sendJson(res, 200, recordPeek(dir, {
            date: body?.date,
            scope: body?.scope ?? 'all',
            source: 'web'
          }));
        } catch {
          return sendJson(res, 400, { error: 'bad date or scope' });
        }
      }

      if (pathname === '/journal/api/days' || pathname === '/journal/api/day') {
        return sendMethodNotAllowed(res, 'GET, HEAD');
      }
      if (pathname === '/journal/api/peek') {
        return sendMethodNotAllowed(res, 'POST');
      }
      return sendText(res, 404, 'not found', isHead);
    } catch {
      if (!res.headersSent) return sendText(res, 500, 'server error');
      return res.end();
    }
  };
}
