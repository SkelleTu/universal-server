# Universal Server backup key

The runtime backup encryption secret is now provided through `UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY`.

It must be a base64-encoded random 32-byte value (256 bits). Generate one locally with:

```bash
openssl rand -base64 32
```

or, with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store the value only as a secret in the hosting provider. Do not commit it to GitHub.

The old `BACKUP_ENCRYPTION_KEY` variable is no longer read by the Universal Server.

Important: snapshots encrypted with the old lost key cannot be restored with the new key. Keep the old encrypted backup repository intact for archival purposes, but start a new backup chain with the new key.
