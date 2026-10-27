const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '\u00b7',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', rarr: '\u2192', larr: '\u2190', times: '\u00d7', copy: '\u00a9'
};

const BLOCK_TAGS = 'address|article|aside|blockquote|br|caption|dd|desc|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|text|tfoot|th|thead|title|tr|ul';
const BLOCK = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');

export function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, key) => {
    if (key[0] === '#') {
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[key] ?? match;
  });
}

export function documentTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match ? decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
}

// Visible text, one block per line. Used for readable diffs that ignore markup-only changes.
export function htmlToLines(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');
  return decodeEntities(body.replace(BLOCK, '\n').replace(/<[^>]*>/g, ''))
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function diffLines(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const ops = before.slice(0, start).map(text => ({ type: 'same', text }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length * b.length > 4_000_000) {
    ops.push(...a.map(text => ({ type: 'removed', text })), ...b.map(text => ({ type: 'added', text })));
  } else {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ type: 'same', text: a[i++] });
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ type: 'removed', text: a[i++] });
      } else {
        ops.push({ type: 'added', text: b[j++] });
      }
    }
    while (i < a.length) ops.push({ type: 'removed', text: a[i++] });
    while (j < b.length) ops.push({ type: 'added', text: b[j++] });
  }
  ops.push(...before.slice(endBefore).map(text => ({ type: 'same', text })));
  return ops;
}

export function formatDiff(ops, { context = 1, maxLines = 400 } = {}) {
  const near = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) near[k] = 1;
  });
  const lines = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!near[index]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push({ type: 'gap', text: '\u2026' });
    skipped = false;
    lines.push(op);
  });
  const truncated = lines.length > maxLines;
  const shown = lines.slice(0, maxLines);
  const prefix = { same: '  ', added: '+ ', removed: '- ', gap: '' };
  return {
    added: ops.filter(op => op.type === 'added').length,
    removed: ops.filter(op => op.type === 'removed').length,
    truncated,
    lines: shown,
    text: shown.map(line => prefix[line.type] + line.text).join('\n') + (truncated ? '\n\u2026 (diff truncated)' : '')
  };
}
