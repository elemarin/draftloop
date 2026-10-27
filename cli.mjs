#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EDITOR_VERSION, ReviewError, ReviewStore, readJson, writeAtomic } from './src/store.mjs';
import { createReviewServer, listen } from './src/server.mjs';
import { startMcpServer } from './src/mcp.mjs';

const CLI = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 4317;
const USAGE = `DraftLoop ${EDITOR_VERSION}: review local HTML drafts with comments, inline edits, and history.

Usage:
  node cli.mjs serve [--port <number>]                 Run the local editor server
  node cli.mjs open <draft.html> [--no-browser]         Register a draft and open it in the editor
  node cli.mjs status                                   Show the server and registered drafts
  node cli.mjs feedback <draft.html|id> [--since <n>]   Print open comments and inline changes
  node cli.mjs mcp                                      Run the MCP server over stdio

Data: versions and comments are kept in <draft>.draftloop next to each draft.
Set DRAFTLOOP_HOME to move the registry (default: ~/.draftloop).`;

function parse(args) {
  const options = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '--since') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) throw new ReviewError('invalid', `${arg} needs a whole number.`);
      options[arg.slice(2)] = value;
    } else if (arg === '--no-browser') {
      options.noBrowser = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new ReviewError('invalid', `Unknown option ${arg}.`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

const serverFile = store => path.join(store.home, 'server.json');

async function runningServer(store) {
  const info = readJson(serverFile(store), null);
  if (!info?.url || !info?.token) return null;
  try {
    const response = await fetch(`${info.url}/api/health`, {
      headers: { 'x-review-token': info.token },
      signal: AbortSignal.timeout(1500)
    });
    return response.ok ? info : null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function serve(store, options) {
  fs.mkdirSync(store.home, { recursive: true });
  const existing = await runningServer(store);
  if (existing) {
    console.log(`DraftLoop is already running at ${existing.url} (process ${existing.pid}).`);
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  const server = createReviewServer({ store, token });
  const port = await listen(server, options.port ?? DEFAULT_PORT, { strict: options.port !== undefined });
  const info = { pid: process.pid, port, url: `http://127.0.0.1:${port}`, token, started: new Date().toISOString(), version: EDITOR_VERSION };
  writeAtomic(serverFile(store), `${JSON.stringify(info, null, 2)}\n`, 0o600);
  const cleanup = () => {
    if (readJson(serverFile(store), null)?.pid === process.pid) fs.rmSync(serverFile(store), { force: true });
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
  console.log(`DraftLoop ${EDITOR_VERSION} listening on ${info.url}`);
  console.log(`Open a draft with: node "${CLI}" open <draft.html>`);
  console.log('Press Ctrl+C to stop.');
}

async function open(store, options) {
  const [file] = options.positional;
  if (!file) throw new ReviewError('invalid', 'Give the path of a draft .html file.');
  const doc = store.register(file);
  const info = await runningServer(store);
  console.log(`Draft:    ${doc.title}`);
  console.log(`ID:       ${doc.id}`);
  console.log(`Version:  ${doc.latestRevision}`);
  console.log(`History:  ${doc.workspace}`);
  if (!info) {
    console.error(`The editor server is not running. Start it with: node "${CLI}" serve`);
    process.exitCode = 3;
    return;
  }
  const url = `${info.url}/?doc=${encodeURIComponent(doc.id)}#token=${info.token}`;
  console.log(`Editor:   ${url}`);
  if (!options.noBrowser) openBrowser(url);
}

async function status(store) {
  const info = await runningServer(store);
  console.log(info ? `Server:   running at ${info.url} (process ${info.pid}, version ${info.version})` : 'Server:   not running');
  const documents = store.listDocuments();
  if (!documents.length) console.log('Drafts:   none registered');
  for (const doc of documents) {
    if (doc.error) {
      console.log(`- ${doc.id}: ${doc.error}`);
    } else {
      const lock = doc.lock ? ', Copilot is editing' : '';
      console.log(`- ${doc.id}: ${doc.title} (version ${doc.latestRevision}, ${doc.openComments} open comments${lock})`);
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parse(rest);
  if (!command || options.help || command === 'help') {
    console.log(USAGE);
    return;
  }
  const store = new ReviewStore();
  switch (command) {
    case 'serve':
      return serve(store, options);
    case 'open':
      return open(store, options);
    case 'status':
      return status(store);
    case 'feedback': {
      const [reference] = options.positional;
      if (!reference) throw new ReviewError('invalid', 'Give a draft path or document ID.');
      console.log(JSON.stringify(store.getReview(store.resolve(reference), { sinceRevision: options.since }), null, 2));
      return;
    }
    case 'mcp':
      startMcpServer({ store });
      return;
    default:
      throw new ReviewError('invalid', `Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch(error => {
  console.error(error instanceof ReviewError ? error.message : error.stack || String(error));
  process.exitCode = error instanceof ReviewError ? 2 : 1;
});
