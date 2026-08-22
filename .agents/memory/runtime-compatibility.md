---
name: Runtime and deployment compatibility
description: Runtime and Replit visibility constraints for external clients.
---

Node built-in SQLite requires Node 22.5 or newer. Replit password-protected Deployments intercept unauthenticated API requests before the app and return HTML.

**Why:** A lower workflow runtime can prevent startup, while Deployment privacy can make an external game client receive a protection page instead of JSON.

**How to apply:** Match the configured Node module to the package engine requirement. For unauthenticated external clients, use a Public Deployment or an explicitly supported external access mechanism.