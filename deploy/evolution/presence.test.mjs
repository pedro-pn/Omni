import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Execute only the installed credential listener. No socket, network or live session.
const source = readFileSync(process.argv[2] || '/evolution/node_modules/baileys/lib/Socket/socket.js', 'utf8');
const start = source.indexOf("ev.on('creds.update', update => {");
const end = source.indexOf('\n    return {', start);
assert(start >= 0 && end > start);
const listenerSource = source.slice(start, end);
const results = [];
for (const [name, update, expected] of [
  ['partial', { accountSyncCounter: 2 }, 0],
  ['empty', { me: {} }, 0],
  ['empty-name', { me: { name: '' } }, 0],
  ['unchanged', { me: { name: 'Existing' } }, 0],
  ['real-name-change', { me: { name: 'Changed' } }, 1],
]) {
  const creds = { me: { name: 'Existing' } };
  const announcements = [];
  let handler;
  vm.runInNewContext(listenerSource, {
    ev: { on: (event, fn) => { assert.equal(event, 'creds.update'); handler = fn; } },
    creds,
    logger: { debug() {}, warn() {} },
    sendNode: node => { announcements.push(node); return Promise.resolve(); },
  }, { timeout: 1000 });
  handler(update);
  assert.equal(announcements.length, expected, name);
  for (const [key, value] of Object.entries(update)) assert.deepEqual(creds[key], value, name);
  if (expected) assert.equal(announcements[0].attrs.name, 'Changed');
  results.push({ case: name, announcements: announcements.length, credentialsUpdated: true });
}
console.log(JSON.stringify({ liveSocketCreated: false, messagesSent: 0, results }));
