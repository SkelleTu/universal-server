---
name: Runtime and deployment compatibility
description: Runtime and Replit visibility constraints for external clients.
---

Node built-in SQLite requires Node 22.5 or newer. Replit password-protected Deployments intercept unauthenticated API requests before the app and return HTML. GitHub backup repositories may start completely empty.

**Why:** A lower workflow runtime can prevent startup, Deployment privacy can make an external game client receive a protection page instead of JSON, and GitHub's empty repository has no `main` ref for a backup writer to update.

**How to apply:** Match the configured Node module to the package engine requirement. For unauthenticated external clients, use a Public Deployment or an explicitly supported external access mechanism. Backup writers must create the initial branch/commit when the repository has no history.