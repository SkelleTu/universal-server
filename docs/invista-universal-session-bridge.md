# Invista Universal Session Bridge

## Required production configuration

- `INVISTA_UNIVERSAL_SERVER_KEY`: shared server-to-server secret used by V10, Aura, and Universal Server. Keep it out of browser code and logs.
- `INVISTA_MAIN_URL`: canonical HTTPS origin of Invista Pro V10.
- `INVISTA_AURA_URL`: canonical HTTPS origin of Invista Pro V10 Aura System Style.
- `INVISTA_DERIV_TOKEN_ENCRYPTION_KEY`: dedicated high-entropy secret for AES-256-GCM encryption of Deriv API tokens at rest. If absent, the existing operator encryption key is used as a compatibility fallback.
- `DERIV_APP_ID`: Deriv application ID required by the account gateway.

On Invista Pro V10, configure `UNIVERSAL_SERVER_URL=https://universal-server-sfhr.onrender.com` and `INVISTA_PLATFORM=main`. On Aura, use the same server URL and `INVISTA_PLATFORM=aura`.

## Deriv credential lifecycle

- The platform sends a token only from its authenticated backend to Universal Server over HTTPS.
- Universal Server encrypts the token with AES-256-GCM and stores the ciphertext in the persistent cache; plaintext tokens are never returned by the session status API.
- A per-user, per-platform WebSocket is opened using the Deriv account OTP flow. The session is kept alive with WebSocket pings and retried with bounded exponential backoff after transient disconnects.
- On platform logout, the socket is closed and the encrypted token is retained with `active=false`. On the next login, the platform reactivates the saved credential. Deleting the token removes the vault entry and closes the socket.
- A live Deriv connection does not arm trading or submit contracts.

## Remote browser handoff

The user must explicitly authorize the browser handoff from an authenticated platform session at `/api/auth/browser-access/consent`. The generated link expires after 120 seconds and can be redeemed once. The grant is scoped to the user and platform, stored as a SHA-256 hash, and exchanged server-to-server. The platform then creates its normal session cookie and redirects to the app. The link is a bearer credential and must be shared only with the specifically authorized remote browser.

## Internal endpoints

- `POST /api/invista/deriv/session`: store encrypted token and open the per-user Deriv connection.
- `GET /api/invista/deriv/session/:platform/:userId`: return connection status without credentials.
- `POST /api/invista/deriv/session/disconnect/:platform/:userId`: close the socket while retaining the credential.
- `DELETE /api/invista/deriv/session/:platform/:userId`: close the socket and delete the stored credential.
- `POST /api/invista/browser-access/grants`: issue an explicitly consented, one-use browser grant.
- `POST /api/invista/browser-access/redeem`: consume the grant from the platform backend.

All internal endpoints require `x-invista-server-key`. Never expose this key to the browser.
