// Browser check: node test/browser.e2e.mjs <draft.html> <screenshot-folder>
// Uses a temporary copy of the draft, a temporary store, and headless Microsoft Edge or Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ReviewStore } from '../src/store.mjs';
import { createReviewServer, listen } from '../src/server.mjs';

const [source, output] = process.argv.slice(2).map(value => value && path.resolve(value));
if (!source || !output) throw new Error('Usage: node test/browser.e2e.mjs <draft.html> <screenshot-folder>');
const BROWSERS = [
  process.env.REVIEW_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`
].filter(Boolean);
const browserPath = BROWSERS.find(file => fs.existsSync(file));
if (!browserPath) throw new Error('No Edge or Chrome found. Set REVIEW_BROWSER.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-e2e-'));
const profile = path.join(root, 'profile');
const draft = path.join(root, 'draft.html');
fs.copyFileSync(source, draft);
fs.mkdirSync(output, { recursive: true });
const steps = [];
const pass = message => {
  steps.push(message);
  console.log(`ok - ${message}`);
};

const store = new ReviewStore({ home: path.join(root, 'home') });
const doc = store.document(store.register(draft).id);
const token = crypto.randomBytes(32).toString('hex');
const server = createReviewServer({ store, token });
const port = await listen(server, 0, { strict: true });
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1500,1000', 'about:blank'
], { stdio: 'ignore' });

let socket;
try {
  let debugPort;
  for (let i = 0; i < 100 && !debugPort; i++) {
    await sleep(100);
    try {
      debugPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {}
  }
  assert.ok(debugPort, 'browser debugging port');
  const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const screenshot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, name), Buffer.from(data, 'base64'));
  };
  const rightClick = async ({ x, y }) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  };
  const comment = async text => {
    await evaluate(`document.getElementById('menu-comment').click()`);
    await waitFor(`!document.getElementById('composer').hidden`, 'comment box');
    await evaluate(`(() => { document.getElementById('composer-body').value = ${JSON.stringify(text)}; document.getElementById('composer').requestSubmit(); })()`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // Headless browsers can ignore --window-size; use a typical desktop viewport.
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?doc=${doc.id}#token=${token}` });
  await waitFor(`document.getElementById('save-status').textContent === 'Version 1'`, 'editor load');
  assert.equal(await evaluate('location.hash'), '', 'token removed from the address bar');
  assert.equal(await evaluate(`document.getElementById('document').contentDocument.body.contentEditable`), 'true');
  pass('editor loads the draft in editing mode and removes the token from the address bar');
  await screenshot('review-editor-1-loaded.png');

  const phrase = 'Decide which service';
  const textPoint = await evaluate(`(() => {
    const frame = document.getElementById('document'); const d = frame.contentDocument;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(phrase)});
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + ${phrase.length});
      const s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
      const b = r.getBoundingClientRect(); const f = frame.getBoundingClientRect();
      return { x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 };
    }
    return null;
  })()`);
  assert.ok(textPoint, 'phrase found');
  await rightClick(textPoint);
  await waitFor(`!document.getElementById('context-menu').hidden`, 'context menu for text');
  assert.equal(await evaluate(`document.getElementById('menu-comment').textContent`), 'Comment');
  await comment('Say which team owns this service.');
  await waitFor(`document.querySelectorAll('#comment-list .comment').length === 1`, 'text comment in the panel');
  await waitFor(`document.getElementById('document').contentWindow.CSS.highlights.get('review-active')?.size === 1`, 'text highlight');
  pass('right-clicking selected text opens the menu, saves a comment, and highlights the text');

  const diagramPoint = await evaluate(`(() => {
    const frame = document.getElementById('document'); const svg = frame.contentDocument.querySelector('svg');
    svg.scrollIntoView({ block: 'center' });
    const b = svg.getBoundingClientRect(); const f = frame.getBoundingClientRect();
    return { x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 };
  })()`);
  await rightClick(diagramPoint);
  await waitFor(`document.getElementById('menu-comment').textContent === 'Comment on this diagram' && !document.getElementById('context-menu').hidden`, 'context menu for diagram');
  await comment('Add the ad-start approval to this diagram.');
  await waitFor(`document.querySelectorAll('#comment-list .comment').length === 2`, 'diagram comment in the panel');
  await waitFor(`document.getElementById('document').contentDocument.querySelector('svg').getAttribute('data-review-outline') === 'active'`, 'diagram outline');
  pass('right-clicking a diagram comments on the whole diagram and outlines it');
  await screenshot('review-editor-2-comments.png');

  const leftClick = async ({ x, y }) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const sectionPoint = await evaluate(`(() => {
    const frame = document.getElementById('document'); const d = frame.contentDocument;
    const details = [...d.querySelectorAll('details')].find(item => !item.open && item.querySelector(':scope > summary strong'));
    if (!details) return null;
    details.id ||= 'e2e-section';
    const title = details.querySelector(':scope > summary strong');
    title.scrollIntoView({ block: 'center' });
    const b = title.getBoundingClientRect(); const f = frame.getBoundingClientRect();
    return { id: details.id, x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 };
  })()`);
  if (sectionPoint) {
    const isOpen = `document.getElementById('document').contentDocument.getElementById(${JSON.stringify(sectionPoint.id)}).open`;
    await leftClick(sectionPoint);
    await waitFor(isOpen, 'section opens on title click');
    await sleep(400);
    await leftClick(sectionPoint);
    await waitFor(`!${isOpen}`, 'section closes on second title click');
    pass('clicking a section title in editing mode opens and closes it');
  }

  const authoredOpen = (fs.readFileSync(draft, 'utf8').match(/<details\b[^>]*\bopen\b/g) || []).length;
  await evaluate(`document.getElementById('expand-all').click()`);
  const editPoint = await evaluate(`(() => {
    const d = document.getElementById('document').contentDocument;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf('Assign owners and release checks.');
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      d.body.focus();
      const r = d.createRange(); r.setStart(n, i + 'Assign owners and release checks.'.length); r.collapse(true);
      const s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }
    return false;
  })()`);
  assert.ok(editPoint, 'edit location found');
  await send('Input.insertText', { text: ' Typed in the review editor.' });
  await waitFor(`document.getElementById('save-status').textContent === 'Saved · version 2'`, 'autosave');
  const saved = fs.readFileSync(draft, 'utf8');
  assert.ok(saved.includes('Typed in the review editor.'), 'draft file updated');
  assert.doesNotMatch(saved, /__review-style|data-review|contenteditable|<script/i);
  assert.equal((saved.match(/<details\b[^>]*\bopen\b/g) || []).length, authoredOpen, 'expanding sections does not change saved open state');
  pass('typing autosaves a new version to the draft file without editor markup or changed section states');

  const review = store.getReview(doc);
  assert.equal(review.openComments.length, 2);
  assert.equal(review.openComments.find(item => item.kind === 'text').anchor, 'found');
  assert.match(review.inlineChanges.diff, /Typed in the review editor\./);
  pass('feedback for Copilot includes both comments and the inline change');

  const textComment = review.openComments.find(item => item.kind === 'text');
  store.beginEdit(doc);
  await waitFor(`document.getElementById('banner').textContent.includes('Copilot is editing') && document.getElementById('document').contentDocument.body.contentEditable === 'false'`, 'edit lock in the editor');
  pass('an assistant edit lock makes the editor read-only and shows a banner');
  await screenshot('review-editor-3-locked.png');
  fs.writeFileSync(draft, fs.readFileSync(draft, 'utf8').replace('Assign owners and release checks.', 'Assign owners and the checks needed for release.'));
  const finished = store.finishEdit(doc, { summary: 'Clarified release checks' });
  assert.equal(finished.revision, 3);
  store.reply(doc, textComment.id, { author: 'assistant', body: 'The service owner is still open. Who should own it?' });
  await waitFor(`document.getElementById('save-status').textContent.startsWith('Updated to version 3')`, 'assistant version loaded');
  assert.ok(await evaluate(`document.getElementById('document').contentDocument.body.textContent.includes('the checks needed for release')`));
  await waitFor(`document.getElementById('comment-list').textContent.includes('Copilot')`, 'assistant reply shown');
  assert.equal(await evaluate(`document.getElementById('document').contentDocument.body.contentEditable`), 'true');
  pass('the assistant version and reply appear automatically and editing resumes');

  await evaluate(`document.getElementById('tab-history').click()`);
  await waitFor(`document.querySelectorAll('#history-list .history-item').length === 3`, 'three versions in history');
  await evaluate(`document.querySelectorAll('#history-list .history-item button')[1].click()`);
  await waitFor(`document.querySelector('#history-detail .diff .added')?.textContent.includes('Typed in the review editor')`, 'version diff');
  pass('history lists every version and shows what changed');
  await screenshot('review-editor-4-history.png');

  console.log(JSON.stringify({ result: 'passed', browser: path.basename(browserPath), steps: steps.length, screenshots: output }, null, 2));
} finally {
  try {
    socket?.close();
  } catch {}
  browser.kill();
  await new Promise(resolve => server.close(resolve));
  await sleep(500);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
