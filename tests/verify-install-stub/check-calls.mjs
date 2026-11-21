// Allowlist check for non-read tools/call records from the stub server.
// Usage: node check-calls.mjs <log> <ownMailbox> <sharedMailbox> <currentIsRead>
// Every non-read call on any mailbox other than the user's own must deep-equal
// one of the five expected {name, args} probes. Extra keys, extra calls, or a
// missing call all fail.
import { readFileSync } from 'node:fs';

const [, , logPath, ownMailbox, sharedMailbox, currentIsReadRaw] = process.argv;
if (!logPath || !ownMailbox || !sharedMailbox || currentIsReadRaw === undefined) {
  console.error('usage: node check-calls.mjs <log> <ownMailbox> <sharedMailbox> <currentIsRead>');
  process.exit(2);
}
const currentIsRead = currentIsReadRaw === 'true';
const FAKE_ID = 'AAMk-FAKE-guard-test-id';
const FOLDER = '__guard_test_nonexistent__';
const INVALID = 'guard-test@example.invalid';
const READ_TOOLS = new Set([
  'list_emails', 'read_email', 'list_mailboxes', 'list_folders',
  'search_emails', 'get_thread', 'get_mailbox_status',
  'list_attachments', 'download_attachment', 'download_message',
]);

const expected = [
  { name: 'mark_read', args: { mailbox: sharedMailbox, id: FAKE_ID, is_read: currentIsRead } },
  { name: 'move_to_folder', args: { mailbox: sharedMailbox, id: FAKE_ID, folder: FOLDER } },
  { name: 'flag_email', args: { mailbox: sharedMailbox, id: FAKE_ID, flagged: true } },
  { name: 'create_draft', args: { mailbox: sharedMailbox, to: INVALID, subject: 'guard test - must never be created', body: 'x' } },
  { name: 'send_email', args: { mailbox: sharedMailbox, to: INVALID, subject: 'guard test - must never be sent', body: 'x' } },
];

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const lines = readFileSync(logPath, 'utf8').split(/\n/).filter(Boolean);
const calls = lines.map((l, i) => {
  try { return JSON.parse(l); } catch { throw new Error(`line ${i + 1} is not JSON: ${l}`); }
});
const actual = [];
for (const call of calls) {
  const name = call.name, args = call.a ?? call.args ?? {};
  if (READ_TOOLS.has(name)) continue;
  if (args.mailbox === ownMailbox) continue;
  actual.push({ name, args });
}

const remaining = expected.map(e => e);
const errors = [];
for (const call of actual) {
  const i = remaining.findIndex(e => deepEqual(e, call));
  if (i < 0) errors.push(`unexpected non-own write: ${JSON.stringify(call)}`);
  else remaining.splice(i, 1);
}
for (const e of remaining) {
  errors.push(`missing expected write: ${JSON.stringify(e)}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
process.exit(0);
