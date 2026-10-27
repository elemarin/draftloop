import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReviewStore } from '../src/store.mjs';

export const page = body => `<!doctype html>\n<html lang="en"><head><title>Test draft</title><style>p{color:red}</style></head><body>${body}</body></html>\n`;

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-editor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'draft.html');
  fs.writeFileSync(file, page('<h1>Plan</h1><p>Players get 30 minutes.</p><p>Second line.</p>'));
  const store = new ReviewStore({ home: path.join(root, 'home') });
  return { root, file, store, doc: store.document(store.register(file).id) };
}
