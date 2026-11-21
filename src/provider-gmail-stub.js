// TEAM BUILD (prune trial): Gmail provider removed. This build is Microsoft-only, so the
// Google libraries are not shipped. Same export names as upstream 0.3.5 so server.js / cli.js load
// unchanged; no Gmail mailbox is ever listed, and anything that would use Gmail throws.
const off = () => { throw new Error('Gmail is not available in the team build (Microsoft only).'); };
export class GmailEmailProvider { constructor() { off(); } }
export class GmailAuthManager { constructor() { off(); } }
export class GoogleapisGmailClient { constructor() { off(); } }
export const GMAIL_OAUTH_SCOPES = Object.freeze([]);
export const DEFAULT_GMAIL_BROKER_URL = 'https://gmail-disabled.invalid';
export const isGmailReauthError = () => false;
export const formatGmailAuthError = (e) => (e instanceof Error ? e.message : String(e));
export async function listConfiguredGmailMailboxes() { return []; }
export async function loadGmailMailboxMetadata() { return null; }
export async function saveGmailMailboxMetadata() { off(); }
export { toFilesystemSafeKey, getConfigDir } from './config.js';
export { gmailProviderError, getErrorMessage, getErrorStatus } from './errors.js';
export function registerWatch() { off(); }
export function needsRenewal() { return false; }
export function pollHistory() { off(); }
