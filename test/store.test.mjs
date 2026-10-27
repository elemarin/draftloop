import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffLines, formatDiff, htmlToLines } from '../src/text.mjs';
import { fixture, page } from './helpers.mjs';

test('text extraction keeps visible blocks and ignores styles', () => {
  assert.deepEqual(htmlToLines(page('<h1>A &amp; B</h1><p>one<br>two</p><svg><title>Diagram</title><text>Box</text></svg>')), ['A & B', 'one', 'two', 'Diagram', 'Box']);
  const diff = formatDiff(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), { context: 0 });
  assert.equal(diff.text, '- b\n+ x');
});

test('registration imports the draft once and keeps the workspace beside it', t => {
  const { store, file, doc } = fixture(t);
  assert.equal(store.latestRevision(doc), 1);
  assert.equal(store.register(file).latestRevision, 1);
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'draft.draftloop', 'revisions', '000001', 'content.html')));
});

test('saving requires the current base version and keeps every version', t => {
  const { store, file, doc } = fixture(t);
  const second = page('<h1>Plan</h1><p>Players get 45 minutes.</p><p>Second line.</p>');
  assert.equal(store.saveUserRevision(doc, { base: 1, html: second }).revision, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), second);
  assert.throws(() => store.saveUserRevision(doc, { base: 1, html: page('<p>stale</p>') }), { code: 'conflict' });
  assert.equal(store.restore(doc, { base: 2, revision: 1 }).revision, 3);
  assert.equal(store.readRevision(doc, 3), store.readRevision(doc, 1));
  assert.throws(() => store.saveUserRevision(doc, { base: 3, html: '<p>not a page</p>' }), { code: 'invalid' });
});

test('outside file edits become versions, but recent versions are not re-imported', t => {
  const { store, file, doc } = fixture(t);
  fs.writeFileSync(file, page('<p>Edited in another tool.</p>'));
  assert.equal(store.sync(doc).author, 'external');
  store.saveUserRevision(doc, { base: 2, html: page('<p>Saved in editor.</p>') });
  fs.writeFileSync(file, store.readRevision(doc, 2));
  assert.equal(store.sync(doc), null);
});

test('review feedback reports comments, anchor state, and the user inline changes', t => {
  const { store, doc } = fixture(t);
  const comment = store.createComment(doc, { revision: 1, kind: 'text', target: { quote: 'Players get 30 minutes.' }, body: 'Say play time instead.' });
  store.createComment(doc, { revision: 1, kind: 'element', target: { elementTag: 'svg', elementLabel: 'Option A' }, body: 'Add the timer.' });
  store.saveUserRevision(doc, { base: 1, html: page('<h1>Plan</h1><p>Players get 30 minutes.</p><p>Changed line.</p>') });
  const review = store.getReview(doc);
  assert.equal(review.sinceVersion, 1);
  assert.equal(review.openComments.length, 2);
  assert.equal(review.openComments.find(c => c.id === comment.id).anchor, 'found');
  assert.match(review.inlineChanges.diff, /- Second line\.\n\+ Changed line\./);
  store.reply(doc, comment.id, { author: 'assistant', body: 'Done.' });
  store.setStatus(doc, comment.id, { status: 'resolved', author: 'assistant' });
  assert.equal(store.getReview(doc).openComments.length, 1);
  assert.throws(() => store.createComment(doc, { kind: 'text', target: { quote: '  ' }, body: 'x' }), { code: 'invalid' });
  assert.throws(() => store.readComment(doc, '../registry'), { code: 'invalid' });
});

test('assistant edit lock blocks user saves and records an assistant version', t => {
  const { store, file, doc } = fixture(t);
  const lock = store.beginEdit(doc);
  assert.equal(lock.path, file);
  assert.throws(() => store.saveUserRevision(doc, { base: 1, html: page('<p>user</p>') }), { code: 'locked' });
  fs.writeFileSync(file, page('<h1>Plan</h1><p>Players get 30 minutes of play time.</p><p>Second line.</p>'));
  assert.equal(store.sync(doc), null, 'edits during the lock are not imported as outside changes');
  const result = store.finishEdit(doc, { summary: 'Use plain words' });
  assert.deepEqual([result.revision, result.changed, store.listRevisions(doc).at(-1).author], [2, true, 'assistant']);
  assert.equal(store.readLock(doc), null);
  assert.equal(store.getReview(doc).sinceVersion, 2);
});

test('edits wait for unsaved editor changes, and cancel restores the file', t => {
  const { store, file, doc } = fixture(t);
  store.setPresence(doc, true);
  assert.throws(() => store.beginEdit(doc), { code: 'busy' });
  store.setPresence(doc, false);
  store.beginEdit(doc);
  fs.writeFileSync(file, page('<p>abandoned</p>'));
  assert.deepEqual(store.cancelEdit(doc), { cancelled: true });
  assert.equal(fs.readFileSync(file, 'utf8'), store.readRevision(doc, 1));
  assert.throws(() => store.finishEdit(doc, {}), { code: 'invalid' });
});
