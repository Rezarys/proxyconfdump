# Changelog

## 0.1.0

First release. Reads a self-hosted Nginx Proxy Manager SQLite database read-only and writes its configuration as sorted JSON, on stdout or as one file per entry. Secrets are removed by a name rule, and the `auth` and `audit_log` tables are never exported. Requires Node 24 or newer, and has no dependencies.
