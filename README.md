# proxyconfdump

```
npx proxyconfdump /path/to/data/database.sqlite > proxy-config.json
```

Reads the SQLite database of a self-hosted Nginx Proxy Manager instance and writes its configuration as sorted, secret-free JSON that you can commit to a git repository and read in a diff.

It opens the database read-only, it never writes to it, and it never imports anything back.

I have not run this against a real instance. The schema comes from the migrations in the upstream repository and the tests run against a fixture database built from those same migrations. If you try it and something is missing or wrong, please open an issue with what you saw.

## Why

A backup of the container volume gives you a binary SQLite file. That file restores fine, but you cannot read it, you cannot diff it, and git has nothing useful to say about it. This turns the same data into text, so `git diff` tells you that a forward port moved from 3000 to 3001.

The request this was built for is [NginxProxyManager/nginx-proxy-manager#4373](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4373).

### Why not just diff the generated nginx conf files

The files under `/data/nginx/` are already plain text, so that is a fair question. They are the output, not the source: they are verbose, they are regenerated from the database, and they do not contain access lists, certificate metadata or the settings. They also say nothing about a host that exists but is disabled. This exports the source of truth instead, in a shape meant to be read.

## Install

No installation needed, `npx proxyconfdump` fetches and runs it. To keep it around:

```
npm install -g proxyconfdump
```

Node 24 or newer is required, because it uses the built in `node:sqlite` module, which is only stable and available without a flag from Node 24 on. On Node 22 and 23 that module exists behind `--experimental-sqlite`, and this tool has not been tested there. There are no dependencies at all, so there is no install step to compile and nothing else lands in your tree.

## Use

```
proxyconfdump <database.sqlite> [options]
```

- `--out-dir <dir>` write one file per entry under `<dir>/<table>/` instead of writing to stdout
- `--tables <a,b,c>` export only these tables
- `--exclude <a,b,c>` drop these tables from whatever would be exported
- `--include-deleted` keep rows flagged as deleted, which are dropped by default
- `-h`, `--help` show usage
- `-v`, `--version` show the version

One file per entry is the friendlier shape for a repository, because a change to one host touches one file:

```
npx proxyconfdump ./data/database.sqlite --out-dir ./config
git add config && git commit -m "proxy config snapshot"
```

Where the database lives depends on how you run the app. With the usual Docker Compose setup it is the `database.sqlite` file inside the directory mounted at `/data`.

`--out-dir` writes and never deletes. If you remove a host and export again, the old file stays behind and the diff will not show the removal. Files that were not rewritten are listed on stderr so you can delete them yourself, deliberately.

## Secrets, and the three things that still get out

An export that ends up in a git repository must not carry a secret, so this errs on the side of removing too much. The `auth` table, which holds login secrets, and the `audit_log` table are never exported, and asking for them explicitly does not change that. In every other table, any column whose name looks like a secret, and any key with such a name inside a JSON value, has its value replaced by `[redacted]`. That covers `password` in `access_list_auth`, the DNS provider credentials stored in the `meta` of a certificate, and a client secret stored inside a settings value.

The rule is a name rule, applied recursively. It will redact a harmless field whose name happens to match, and that is the trade chosen here: an over-redacted field is visible in the output and you can go and read the real value, a published credential is not recoverable. There is no flag to turn redaction off.

Three things a name rule cannot catch, said plainly rather than left for you to find:

1. **`advanced_config` is free text.** It holds raw nginx directives, so no rule about names can reach inside it. Whatever you put there comes out as written, a header with a token included.
2. **The `user` table carries the account email addresses**, along with names and nicknames. Use `--exclude user,user_permission` if the export goes somewhere those addresses should not go.
3. **The export describes your internal topology**: every hostname, every internal address, every port. That is the point of it, and it is also a map for anyone who reads it. Keep the repository private.

Certificate private keys are not in this database, they live on disk under `/data/letsencrypt`, so no export from this tool can leak one.

## What the output looks like

```json
{
  "format": "proxyconfdump/1",
  "tables": {
    "proxy_host": [
      {
        "id": 1,
        "owner_user_id": 1,
        "domain_names": ["alpha.example.com"],
        "forward_host": "10.0.0.2",
        "forward_port": 3000,
        "forward_scheme": "http",
        "certificate_id": 0,
        "ssl_forced": 0,
        "meta": {}
      }
    ]
  }
}
```

The document carries no timestamp, no file path and no tool version, on purpose. A field that changes on every run turns every diff into noise, which is exactly what this is meant to avoid. Rows are sorted by their first domain name, then by id, so the order does not depend on how the rows were inserted. The `created_on` and `modified_on` columns are dropped for the same reason.

Nothing about the schema is hardcoded. The columns that a table actually has are read back from the database, so an older or a newer version of the app exports without a change here.

## What this does not do

It does not import, restore or write anything. Reversing the export means writing to a live database, and getting that wrong costs you your configuration, so it is out of scope rather than half done.

It reads SQLite only. An instance backed by MySQL or MariaDB is not supported.

## Tests

```
npm test
```

## Notes

Built with AI assistance, reviewed and tested by me.

Not affiliated with, endorsed by, or connected to the Nginx Proxy Manager project. The name of that project is used only to say what this tool reads.

## License

MIT, Younes Z.
