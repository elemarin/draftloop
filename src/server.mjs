import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EDITOR_VERSION, ReviewError } from './store.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/editor.css', ['editor.css', 'text/css; charset=utf-8']]
]);
const EDITOR_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Documents are displayed as content only: no scripts and no remote requests.
const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const STATUS = { not_found: 404, invalid: 400, conflict: 409, busy: 409, locked: 423 };
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ReviewError('invalid', 'The request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new ReviewError('invalid', 'The request is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function createReviewServer({ store, token }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,}$/.test(token)) throw new Error('A random hex token is required.');
  const expected = Buffer.from(token);
  const authorized = value => {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ReviewError) {
        send(res, STATUS[error.code] ?? 400, { error: error.message, code: error.code, ...error.details });
      } else {
        console.error(error);
        send(res, 500, { error: 'The review server hit an unexpected error.' });
      }
    });
  });

  async function handle(req, res) {
    const port = server.address().port;
    const host = String(req.headers.host || '').toLowerCase();
    // Rejecting other host names blocks DNS-rebinding pages from reaching this local server.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, { error: 'Unexpected host.' });
    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname;
    const cookieName = `review_token_${port}`;

    if (req.method === 'GET' && STATIC.has(route)) {
      const [file, type] = STATIC.get(route);
      const headers = { ...BASE_HEADERS, 'content-type': type };
      if (file === 'index.html') headers['content-security-policy'] = EDITOR_CSP;
      res.writeHead(200, headers);
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
      return;
    }

    const page = /^\/doc\/([a-z0-9-]{1,80})\/rev\/(latest|\d{1,6})$/.exec(route);
    if (page) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      if (!authorized(cookie(req, cookieName))) return send(res, 401, { error: 'Open the editor from the review link.' });
      const doc = store.document(page[1]);
      const revision = page[2] === 'latest' ? store.latestRevision(doc) : Number(page[2]);
      const html = store.readRevision(doc, revision);
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DOCUMENT_CSP });
      res.end(html);
      return;
    }

    if (!route.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    // A custom header cannot be sent cross-origin without a preflight, which this server never approves.
    if (!authorized(req.headers['x-review-token'])) return send(res, 401, { error: 'Open the editor from the review link.' });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'Unexpected origin.' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Send JSON.' });
      }
    }

    if (req.method === 'POST' && route === '/api/session') {
      return send(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true, version: EDITOR_VERSION });
    if (req.method === 'GET' && route === '/api/documents') return send(res, 200, { documents: store.listDocuments() });

    const match = /^\/api\/doc\/([a-z0-9-]{1,80})(\/[a-z0-9/-]*)$/.exec(route);
    if (!match) return send(res, 404, { error: 'Not found.' });
    const doc = store.document(match[1]);
    const action = match[2];

    if (req.method === 'GET') {
      if (action === '/state') {
        store.sync(doc);
        return send(res, 200, store.state(doc));
      }
      if (action === '/diff') {
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 1) {
          throw new ReviewError('invalid', 'Choose two versions to compare.');
        }
        return send(res, 200, store.diffRevisions(doc, from, to));
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });

    const body = await readBody(req);
    if (action === '/revisions') return send(res, 200, store.saveUserRevision(doc, { base: body.base, html: body.html }));
    if (action === '/restore') return send(res, 200, store.restore(doc, { base: body.base, revision: body.revision }));
    if (action === '/comments') return send(res, 200, store.createComment(doc, body));
    if (action === '/presence') return send(res, 200, store.setPresence(doc, body.dirty));
    if (action === '/conflicts') return send(res, 200, store.saveConflict(doc, body.html));
    const commentAction = /^\/comments\/(c[a-z0-9]+)\/(replies|status)$/.exec(action);
    if (commentAction) {
      const [, id, kind] = commentAction;
      if (kind === 'replies') return send(res, 200, store.reply(doc, id, { author: 'user', body: body.body }));
      return send(res, 200, store.setStatus(doc, id, { status: body.status, author: 'user' }));
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return server;
}

export function listen(server, port, { strict = false, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    let candidate = port;
    const attempt = () => {
      const onError = error => {
        if (error.code === 'EADDRINUSE' && !strict && candidate < port + 20) {
          candidate++;
          attempt();
        } else {
          reject(error);
        }
      };
      server.once('error', onError);
      server.listen(candidate, host, () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    };
    attempt();
  });
}
