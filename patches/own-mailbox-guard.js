// TEAM BUILD (2026-11-17) — request-level guard for the signed-in user's
// OWN mailbox under the 'draft' / 'observe' scope profiles.
//
// Tool filtering already hides send/delete/rule/settings tools. This is the
// second, independent layer: even if a tool slipped through, or the app the user
// signed into was consented with Mail.Send (delegated tokens carry every scope
// consented on the app, not just the ones requested), the request is refused
// locally BEFORE a token is fetched or anything is sent to Graph.
import { RealGraphApiClient } from './email-graph-provider.js';
import { logSharedMailboxGuard } from './shared-mailbox-readonly.js';
export class OwnMailboxRequestRefusedError extends Error {
    constructor(detail) {
        super(`TEAM_BUILD_REFUSED: ${detail}`);
        this.name = 'OwnMailboxRequestRefusedError';
        this.code = 'TEAM_BUILD_REFUSED';
    }
}
// POST actions that deliver mail (createReply/createReplyAll/createForward only make drafts and stay allowed).
const SEND_ACTION_RE = /\/(send|sendmail|reply|replyall|forward)$/;
// Allowed DELETE: only removing an attachment from a message (update_draft replaces draft attachments).
const ATTACHMENT_DELETE_RE = /^\/v1\.0\/me\/messages\/[^/]+\/attachments\/[^/]+$/;
export function classifyOwnMailboxRequest(method, url, profile) {
    const m = String(method ?? 'GET').toUpperCase();
    let u;
    try {
        u = new URL(String(url).startsWith('http') ? String(url) : `https://graph.microsoft.com/v1.0${url}`);
    }
    catch {
        return 'unparseable URL';
    }
    if (u.username !== '' || u.password !== '')
        return 'URL carries a username or password';
    if (u.origin !== 'https://graph.microsoft.com')
        return 'origin other than https://graph.microsoft.com';
    let p;
    try {
        p = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, '');
    }
    catch {
        return 'undecodable path';
    }
    if (p.includes('..'))
        return 'path traversal';
    if (p !== '/v1.0/me' && !p.startsWith('/v1.0/me/'))
        return 'URL outside the signed-in user\'s own mailbox (/me)';
    if (p.includes('/messagerules') || p.includes('/mailboxsettings'))
        return 'inbox rules / mailbox settings are not available in the team build';
    if (profile === 'observe' && m !== 'GET')
        return 'observe profile is read-only';
    if (m === 'GET')
        return null;
    if (m === 'POST') {
        if (SEND_ACTION_RE.test(p))
            return 'sending mail is not available in the team build';
        if (p.endsWith('/permanentdelete'))
            return 'deleting mail is not available in the team build';
        if (p.endsWith('/childfolders') || p === '/v1.0/me/mailfolders')
            return 'creating folders is not available in the team build';
        return null; // drafts (/messages, /createReply*, /attachments), /move
    }
    if (m === 'PATCH') {
        if (p.includes('/mailfolders/') && !p.includes('/messages/'))
            return 'changing folders is not available in the team build';
        return null; // isRead, flag, categories, draft body/recipients
    }
    if (m === 'DELETE') {
        return ATTACHMENT_DELETE_RE.test(p) ? null : 'deleting mail or folders is not available in the team build';
    }
    return `method ${m} not allowed`;
}
export class TeamOwnMailboxGraphClient extends RealGraphApiClient {
    profile;
    mailboxName;
    refusedCount = 0;
    constructor(getToken, onAuthError, mailboxName, profile = 'draft') {
        super(getToken, onAuthError);
        this.mailboxName = mailboxName;
        this.profile = profile;
    }
    check(method, url) {
        const why = classifyOwnMailboxRequest(method, url, this.profile);
        if (why === null)
            return;
        this.refusedCount++;
        let path = String(url);
        try { path = new URL(path, 'https://graph.microsoft.com/v1.0').pathname; } catch { /* keep raw */ }
        logSharedMailboxGuard({ result: 'REFUSED', mailbox: this.mailboxName, scope: 'own', method, path, why });
        throw new OwnMailboxRequestRefusedError(`${method} ${path} refused (${why}); no request was sent to Graph`);
    }
    async fetchWithAuthRetry(url, init) {
        this.check(String(init?.method ?? 'GET').toUpperCase(), url);
        return super.fetchWithAuthRetry(url, init);
    }
    async get(url) { this.check('GET', url); return super.get(url); }
    async getBytes(url) { this.check('GET', url); return super.getBytes(url); }
    async post(url, body) { this.check('POST', url); return super.post(url, body); }
    async patch(url, body) { this.check('PATCH', url); return super.patch(url, body); }
    async delete(url) { this.check('DELETE', url); return super.delete(url); }
}
//# TEAM BUILD END
