// Offline fake MCP server for tests/verify-install-test.sh.
// Records every tools/call to $STUB_LOG and refuses shared-mailbox writes.
// Shared list_emails returns id REAL-SHARED-MSG-ID with isRead false, so a
// regression that writes a real id or flips isRead is visible in the log.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const LOG = process.env.STUB_LOG, ME = 'user@example.com', SH = 'shared@example.com';
const WRITE_ERR = process.env.STUB_SHARED_WRITE_ERROR || 'SHARED_MAILBOX_READ_ONLY: refused';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
process.stdout.write('non-json banner line Bearer eyJfake.fake.fake\n');
readline.createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l); if (m.id == null) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: ['list_emails','read_email','create_draft','mark_read','move_to_folder','flag_email','list_mailboxes'].map(name => ({ name })) } });
  const { name, arguments: a } = m.params; appendFileSync(LOG, JSON.stringify({ name, a }) + '\n');
  const txt = o => out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
  const err = t => out({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: t }] } });
  if (name === 'list_mailboxes') return txt({ mailboxes: [{ name: ME, status: 'connected' }, { name: 'shared', emailAddress: SH, status: 'connected' }] });
  if (name === 'list_emails') return txt({ emails: [{ id: a.mailbox === ME ? 'OWN-MSG-ID' : 'REAL-SHARED-MSG-ID', isRead: false }] });
  if (name === 'read_email') return txt({ ok: true });
  if (a.mailbox !== ME) return err(WRITE_ERR);
  if (name === 'create_draft') return txt({ draftId: 'DRAFT-1' });
  return err('Tool unavailable in this build');
});
