// TEAM BUILD — build-time constants. The tenant id, team client id and
// denied client id prefixes are filled in by tools/apply-team-config.mjs from the
// untracked team-build.config.json when tools/make-build-tree.sh copies this file
// into the patched tree; build.sh refuses a tree where they are missing. Change
// the shared-target policy here (then rebuild the package + sha256 manifest with
// build.sh). Deliberately NOT read from user config: a teammate's bot cannot
// widen these without the launcher's sha256 check failing.
export const TEAM_BUILD_ID = 'team-draft';
/**
 * Which shared targets this build will open for read.
 * - 'exchange': any mailbox Exchange already permits the signed-in user to read.
 *   Graph's 403/404 is the access control; this build does not keep an address list.
 * - 'shared-mailbox-only': only targets we can prove are Exchange shared mailboxes.
 *   If we cannot decide, refuse (fail closed). Never allow by default.
 * 'exchange' is the shipped default.
 */
export const SHARED_TARGET_POLICY = 'exchange';
export function getSharedTargetPolicy() {
    return SHARED_TARGET_POLICY;
}
/** The team app (email-agent-mcp-team), from the build config. Printed in setup hints and errors. */
export const TEAM_CLIENT_ID = '@@TEAM_CLIENT_ID@@';
/** The team tenant, from the build config. The team app is single-tenant, so sign-in must use this authority, not 'organizations'. */
export const TEAM_TENANT_ID = '@@TEAM_TENANT_ID@@';
/**
 * Client ids this build refuses to sign in with. c4f91d3e is the package
 * vendor's ("Junior local app") default; teammates must always name the team app.
 */
export const TEAM_FORBIDDEN_CLIENT_IDS = Object.freeze([
    'c4f91d3e-d2d9-4f8b-826f-6a3c19280241',
]);
/**
 * Client id prefixes this build also refuses (deniedClientIdPrefixes in the
 * build config, for example another app in the tenant that holds Mail.Send).
 */
export const TEAM_FORBIDDEN_CLIENT_ID_PREFIXES = Object.freeze([/* @@TEAM_DENIED_CLIENT_ID_PREFIXES@@ */]);
/**
 * true only when the build config said "allowNoDeniedClients": true. Otherwise an
 * empty prefix list means the config lost its denied apps, and the build refuses.
 */
export const TEAM_ALLOW_NO_DENIED_CLIENTS = '@@TEAM_ALLOW_NO_DENIED_CLIENTS@@';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class TeamBuildConfigMissingError extends Error {
    constructor(code = 'TEAM_BUILD_CONFIG_MISSING', detail = 'this build has no tenant id or team client id.') {
        super(`${code}: ${detail} `
            + 'Rebuild it with a team-build.config.json (see team-build.config.example.json). There is no built-in fallback.');
        this.name = 'TeamBuildConfigMissingError';
        this.code = code;
    }
}
/**
 * Throws unless the build config filled in a tenant id and team client id, and
 * either listed at least one denied client id prefix or explicitly opted out.
 */
export function assertTeamBuildConfig() {
    if (!GUID_RE.test(TEAM_TENANT_ID) || !GUID_RE.test(TEAM_CLIENT_ID) || typeof TEAM_ALLOW_NO_DENIED_CLIENTS !== 'boolean')
        throw new TeamBuildConfigMissingError();
    if (TEAM_FORBIDDEN_CLIENT_ID_PREFIXES.length === 0 && TEAM_ALLOW_NO_DENIED_CLIENTS !== true)
        throw new TeamBuildConfigMissingError('TEAM_BUILD_CONFIG_NO_DENIED_CLIENTS',
            'this build lists no denied client id prefixes and the config did not set "allowNoDeniedClients": true.');
}
export class TeamClientIdRequiredError extends Error {
    constructor(detail) {
        super(`TEAM_CLIENT_ID_REQUIRED: ${detail} This team build never falls back to the vendor app. `
            + `Run: email-agent-mcp configure --mailbox <you>@example.com --provider microsoft --client-id ${TEAM_CLIENT_ID}`);
        this.name = 'TeamClientIdRequiredError';
        this.code = 'TEAM_CLIENT_ID_REQUIRED';
    }
}
/** Throws unless the build is configured and clientId is an explicit GUID that is not a forbidden id. */
export function assertTeamClientId(clientId, where = 'sign-in') {
    assertTeamBuildConfig();
    const id = String(clientId ?? '').trim();
    if (!id)
        throw new TeamClientIdRequiredError(`No Microsoft client id for ${where} (no --client-id, no AGENT_EMAIL_CLIENT_ID, no saved clientId).`);
    if (!GUID_RE.test(id))
        throw new TeamClientIdRequiredError(`Client id "${id}" for ${where} is not a GUID.`);
    if (TEAM_FORBIDDEN_CLIENT_IDS.includes(id.toLowerCase()))
        throw new TeamClientIdRequiredError(`Client id ${id} (vendor default app) is refused for ${where}.`);
    if (TEAM_FORBIDDEN_CLIENT_ID_PREFIXES.some(prefix => id.toLowerCase().startsWith(prefix)))
        throw new TeamClientIdRequiredError(`Client id ${id} (a denied app in this tenant) is refused for ${where}.`);
    return id;
}
