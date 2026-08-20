# Universal Server: durable recovery

The Replit Publish is treated as disposable compute. Runtime database state must not depend on the lifetime of that Publish.

## Durable backup

When configured, the server:

1. Exports the complete PGlite state (projects, collections, request logs and game cache).
2. Compresses it with gzip.
3. Encrypts it with AES-256-GCM.
4. Splits the encrypted payload into Git-safe chunks.
5. Stores the chunks and an atomic `runtime-backups/latest.json` pointer in the configured GitHub repository.
6. Repeats automatically every `BACKUP_INTERVAL_MS` (15 minutes by default).
7. Attempts a final backup on SIGTERM/SIGINT.

No plaintext database contents or API keys are written to the backup repository.

## Automatic recovery

On startup, after PGlite initializes and before the server accepts normal traffic, the server checks whether the local database contains persistent state. If it is empty and durable backup credentials are configured, the latest encrypted snapshot is downloaded, verified/decrypted, restored into PGlite, and the SQLite mirror is rebuilt from that snapshot.

Therefore a fresh Replit Publish can recover the last durable snapshot without relying on the old Publish filesystem.

## Required Replit Secrets

- `BACKUP_GITHUB_TOKEN`: GitHub fine-grained token with Contents read/write permission on the dedicated backup repository.
- `BACKUP_GITHUB_REPO`: e.g. `SkelleTu/universal-server-backups`.
- `BACKUP_ENCRYPTION_KEY`: base64-encoded 32-byte random key. Generate once with `openssl rand -base64 32` and keep it permanently. Losing this key makes encrypted backups unrecoverable.

Optional:

- `BACKUP_INTERVAL_MS=900000`
- `SERVER_EXPIRATION_AT=...`

## Operational rule

Do not delete or rotate `BACKUP_ENCRYPTION_KEY` unless a new encrypted backup is created and a restore test has succeeded with the replacement key.

The backup repository should be separate from the source repository so runtime snapshots cannot interfere with source-code synchronization.
