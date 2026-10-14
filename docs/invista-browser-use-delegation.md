# Invista Browser Use Delegation

## Flow

1. An approved user signs in to Invista V10 or Aura System Style.
2. The platform registers the user ID, normalized account email, platform, and heartbeat with Universal Server using the server-to-server key.
3. The user explicitly opens `/api/auth/browser-access/consent` and enables delegation. Universal Server stores the opt-in under a platform-and-email scoped key.
4. The MCP tool `get_invista_browser_launch` requires `aura.execute` and requires the requested email to match the authenticated MCP profile.
5. Universal Server checks both the persistent opt-in and a live source-platform session, then mints a random, one-use grant with a two-minute expiry.
6. Browser Use navigates to the returned platform exchange URL. The platform redeems the grant server-to-server, rotates the web session ID, creates a delegated session, and redirects to the authenticated app.
7. Every authenticated API request from a delegated browser revalidates the source session and delegation status. Logout, heartbeat expiry, or delegation revocation fails closed.

## Security properties

- Deriv credentials are stored separately in the encrypted Universal Server vault and are never included in a Browser Use grant.
- A grant is opaque, stored by SHA-256 hash, expires after two minutes, and is deleted before its identity payload is returned.
- The MCP launch tool is scoped to `aura.execute` and the MCP profile's own email.
- Source and delegated web sessions are not browser-cookie copies. The exchange creates a new, rotated session cookie.
- Delegation never arms trading. Play/Stop remains a separate explicit control.
- Revocation removes the persisted delegation; the remote-session status check then rejects the delegated browser session.

## Required runtime configuration

- Invista platform services: `UNIVERSAL_SERVER_URL`, `INVISTA_UNIVERSAL_SERVER_KEY`, stable `SESSION_SECRET`, and persistent `DATABASE_URL`.
- Universal Server: matching `INVISTA_UNIVERSAL_SERVER_KEY`, persistent PGlite backing store, and `UNIVERSAL_OPERATOR_ENCRYPTION_KEY` (or the configured dedicated Deriv-token encryption key).
- Optional public URL overrides: `INVISTA_MAIN_URL` and `INVISTA_AURA_URL`. Production defaults are the current Render platform URLs.

## Validation checklist

- Typecheck and platform CI pass.
- Test an approved account on demo mode only.
- Verify consent required, email mismatch denied, inactive source session denied, grant replay denied, grant expiry denied, and revocation immediately invalidates the delegated browser.
- Verify no Deriv token appears in browser responses or logs.
- Verify logout closes the source session and does not arm or submit any trade.
