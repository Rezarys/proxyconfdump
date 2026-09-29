import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPORTED_TABLES, exportDatabase, serialise } from "../src/export.js";
import { REDACTED, isSecretName, redact } from "../src/redact.js";
import { makeFixture } from "./helpers/fixture.js";

const { path } = makeFixture();

test("the auth and audit_log tables are never exported", () => {
	const document = exportDatabase(path);
	assert.equal(document.tables.auth, undefined);
	assert.equal(document.tables.audit_log, undefined);
	assert.ok(!serialise(document).includes("top-secret-hash"));
});

test("asking for a forbidden table explicitly does not export it", () => {
	assert.throws(() => exportDatabase(path, { tables: ["auth"] }), /nothing left to export/);
	const document = exportDatabase(path, { tables: ["auth", "proxy_host"] });
	assert.deepEqual(Object.keys(document.tables), ["proxy_host"]);
});

test("a stored password never reaches the output", () => {
	const text = serialise(exportDatabase(path));
	assert.ok(!text.includes("plain-or-hashed-either-way"));
	const entry = exportDatabase(path).tables.access_list_auth[0];
	assert.equal(entry.password, REDACTED);
	assert.equal(entry.username, "someone");
});

test("a DNS provider credential nested in a JSON column is redacted", () => {
	const text = serialise(exportDatabase(path));
	assert.ok(!text.includes("abcd1234"));
	const certificate = exportDatabase(path).tables.certificate[0];
	assert.equal(certificate.meta.dns_provider_credentials, REDACTED);
	assert.equal(certificate.meta.dns_provider, "cloudflare");
});

test("JSON columns come back as values, not as strings", () => {
	const hosts = exportDatabase(path).tables.proxy_host;
	assert.deepEqual(hosts[0].domain_names, ["alpha.example.com", "www.alpha.example.com"]);
	assert.equal(typeof hosts[0].meta, "object");
});

test("rows are sorted by domain name, not by insertion order", () => {
	const hosts = exportDatabase(path).tables.proxy_host;
	assert.deepEqual(
		hosts.map((host) => host.domain_names[0]),
		["alpha.example.com", "raw.example.com", "zeta.example.com"],
	);
});

test("deleted rows are dropped by default and kept on request", () => {
	assert.equal(exportDatabase(path).tables.proxy_host.length, 3);
	const withDeleted = exportDatabase(path, { includeDeleted: true }).tables.proxy_host;
	assert.equal(withDeleted.length, 4);
	assert.equal(withDeleted.find((host) => host.id === 3).is_deleted, 1);
});

test("a secret inside a settings value is walked and redacted", () => {
	const settings = exportDatabase(path).tables.setting;
	const oidc = settings.find((row) => row.id === "oidc-config");
	assert.equal(oidc.value.clientSecret, REDACTED);
	assert.equal(oidc.value.clientId, "proxy");
	assert.ok(!serialise(exportDatabase(path)).includes("must-not-leak"));
});

test("a settings value that is plain text keeps its exact value and type", () => {
	const settings = exportDatabase(path).tables.setting;
	const site = settings.find((row) => row.id === "default-site");
	assert.equal(site.value, "congratulations");
});

test("advanced_config is free text and is exported as written, filters do not apply to it", () => {
	// Documented limit rather than a silent one: the column holds raw nginx directives, so no
	// name rule can reach inside it. The README says so, and this test keeps it said.
	const host = exportDatabase(path).tables.proxy_host.find((row) => row.id === 4);
	assert.equal(host.advanced_config, "proxy_set_header X-Api-Token free-text-not-filtered;");
});

test("--exclude drops a table that would otherwise be exported", () => {
	const document = exportDatabase(path, { exclude: ["user", "user_permission"] });
	assert.equal(document.tables.user, undefined);
	assert.ok(document.tables.proxy_host.length > 0);
	assert.ok(!serialise(document).includes("admin@example.com"));
});

test("excluding everything is an error, not an empty document", () => {
	assert.throws(
		() => exportDatabase(path, { tables: ["proxy_host"], exclude: ["proxy_host"] }),
		/nothing left to export/,
	);
});

test("timestamp columns are dropped so a diff only shows configuration", () => {
	const host = exportDatabase(path).tables.proxy_host[0];
	assert.equal(host.created_on, undefined);
	assert.equal(host.modified_on, undefined);
});

test("the document carries no timestamp, path or version of its own", () => {
	const text = serialise(exportDatabase(path));
	assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["format", "tables"]);
	assert.ok(!text.includes(path));
});

test("two runs produce byte-identical output", () => {
	assert.equal(serialise(exportDatabase(path)), serialise(exportDatabase(path)));
});

test("reading the database does not change the file", () => {
	const before = createHash("sha256").update(readFileSync(path)).digest("hex");
	exportDatabase(path);
	const after = createHash("sha256").update(readFileSync(path)).digest("hex");
	assert.equal(before, after);
});

test("only the requested tables are exported", () => {
	const document = exportDatabase(path, { tables: ["proxy_host"] });
	assert.deepEqual(Object.keys(document.tables), ["proxy_host"]);
});

test("a table absent from the database is skipped, not an error", () => {
	const document = exportDatabase(path, { tables: ["proxy_host", "stream"] });
	assert.deepEqual(Object.keys(document.tables), ["proxy_host"]);
});

test("a table name that is not an identifier is refused", () => {
	assert.throws(
		() => exportDatabase(path, { tables: ['proxy_host" ; DROP TABLE user --'] }),
		/no exportable table|not a valid table name/,
	);
});

test("the exported table list is the documented one", () => {
	assert.ok(EXPORTED_TABLES.includes("proxy_host"));
	assert.ok(!EXPORTED_TABLES.includes("auth"));
	assert.ok(!EXPORTED_TABLES.includes("audit_log"));
});

test("the secret name rule covers the names it claims to cover", () => {
	for (const name of [
		"secret",
		"password",
		"dns_provider_credentials",
		"api_key",
		"apiKey",
		"private_key",
		"passphrase",
		"access_token",
		"token",
		"key",
	]) {
		assert.ok(isSecretName(name), `${name} should be treated as a secret`);
	}
	for (const name of ["domain_names", "forward_host", "certificate_id", "nice_name", "keys_count"]) {
		assert.ok(!isSecretName(name), `${name} should not be treated as a secret`);
	}
});

test("redaction walks arrays and nested objects", () => {
	const out = redact({ list: [{ password: "x", ok: 1 }], nested: { deep: { secret: "y" } } });
	assert.equal(out.list[0].password, REDACTED);
	assert.equal(out.list[0].ok, 1);
	assert.equal(out.nested.deep.secret, REDACTED);
});

test("a file that is not a database is refused with a message", () => {
	assert.throws(() => exportDatabase(new URL("./export.test.js", import.meta.url).pathname));
});
