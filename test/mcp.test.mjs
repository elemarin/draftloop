import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReviewStore } from '../src/store.mjs';
import { page } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

function client(t, home) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, DRAFTLOOP_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise(resolve => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    const result = response.result;
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
  return { request, call, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

test('MCP server exposes the review tools and completes an edit round trip', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const file = path.join(root, 'draft.html');
  fs.writeFileSync(file, page('<p>Grants are 30 minutes.</p>'));
  const store = new ReviewStore({ home });
  const doc = store.document(store.register(file).id);
  const comment = store.createComment(doc, { revision: 1, kind: 'text', target: { quote: 'Grants' }, body: 'Use plain words.' });

  const mcp = client(t, home);
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'draftloop');
  mcp.notify('notifications/initialized');
  const listed = await mcp.request('tools/list', {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    'list_review_documents', 'get_review_feedback', 'begin_document_edit',
    'finish_document_edit', 'cancel_document_edit', 'reply_to_review_comment'
  ]);

  const feedback = JSON.parse((await mcp.call('get_review_feedback', { documentId: doc.id })).text);
  assert.equal(feedback.openComments[0].body, 'Use plain words.');
  const begin = JSON.parse((await mcp.call('begin_document_edit', { documentId: doc.id })).text);
  fs.writeFileSync(begin.path, page('<p>Players get 30 minutes of play time.</p>'));
  const finish = JSON.parse((await mcp.call('finish_document_edit', { documentId: doc.id, summary: 'Plain words' })).text);
  assert.deepEqual([finish.revision, finish.changed], [2, true]);
  const reply = JSON.parse((await mcp.call('reply_to_review_comment', { documentId: doc.id, commentId: comment.id, message: 'Changed.', resolve: true })).text);
  assert.deepEqual([reply.status, reply.replies[0].author], ['resolved', 'assistant']);

  const missing = await mcp.call('get_review_feedback', { documentId: 'missing-doc' });
  assert.equal(missing.isError, true);
  assert.equal((await mcp.request('unknown/method', {})).error.code, -32601);
});
