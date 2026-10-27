import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReviewServer, listen } from '../src/server.mjs';
import { fixture, page } from './helpers.mjs';

const TOKEN = 'a'.repeat(64);

async function start(t) {
  const context = fixture(t);
  const server = createReviewServer({ store: context.store, token: TOKEN });
  const port = await listen(server, 0, { strict: true });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const call = (route, { method = 'GET', body, token = TOKEN, headers = {} } = {}) => fetch(base + route, {
    method,
    headers: { ...(token && { 'x-review-token': token }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { ...context, port, base, call };
}

test('API and document pages require the token, and documents cannot run scripts', async t => {
  const { call, doc, port } = await start(t);
  assert.equal((await call('/api/health', { token: null })).status, 401);
  assert.equal((await call(`/doc/${doc.id}/rev/1`)).status, 401);
  const session = await call('/api/session', { method: 'POST', body: {} });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const pageResponse = await call(`/doc/${doc.id}/rev/latest`, { headers: { cookie } });
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(pageResponse.headers.get('content-security-policy'), /script-src/);
  const rebinding = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `evil.example:${port}`, 'x-review-token': TOKEN } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(rebinding, 421);
  assert.equal((await call('/api/session', { method: 'POST', body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
});

test('editor saves, conflicts, comments, and diffs go through the shared store', async t => {
  const { call, doc, store } = await start(t);
  const saved = await call(`/api/doc/${doc.id}/revisions`, { method: 'POST', body: { base: 1, html: page('<p>Edited.</p>') } });
  assert.equal((await saved.json()).revision, 2);
  const stale = await call(`/api/doc/${doc.id}/revisions`, { method: 'POST', body: { base: 1, html: page('<p>Stale.</p>') } });
  assert.deepEqual([stale.status, (await stale.json()).latestRevision], [409, 2]);
  const comment = await (await call(`/api/doc/${doc.id}/comments`, {
    method: 'POST',
    body: { revision: 2, kind: 'text', target: { quote: 'Edited.' }, body: 'Clarify.' }
  })).json();
  await call(`/api/doc/${doc.id}/comments/${comment.id}/replies`, { method: 'POST', body: { body: 'More detail.' } });
  const state = await (await call(`/api/doc/${doc.id}/state`)).json();
  assert.deepEqual([state.document.openComments, state.comments[0].replies[0].author, state.revisions.length], [1, 'user', 2]);
  const diff = await (await call(`/api/doc/${doc.id}/diff?from=1&to=2`)).json();
  assert.ok(diff.added > 0 && diff.removed > 0);
  store.beginEdit(doc);
  assert.equal((await call(`/api/doc/${doc.id}/revisions`, { method: 'POST', body: { base: 2, html: page('<p>x</p>') } })).status, 423);
});
