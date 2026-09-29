/**
 * Build a throwaway database that mirrors the upstream schema closely enough to test against.
 *
 * The column names come from the upstream initial migration and the later ones that added
 * columns; they are not invented here. This is still a fixture, not a real instance: see the
 * "what has not been verified" section of the README.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "proxyhosts-test-"));
	const path = join(dir, "database.sqlite");
	const db = new DatabaseSync(path);

	db.exec(`
		CREATE TABLE auth (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			user_id INTEGER, type TEXT, secret TEXT, meta TEXT, is_deleted INTEGER DEFAULT 0
		);
		CREATE TABLE user (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			is_deleted INTEGER DEFAULT 0, is_disabled INTEGER DEFAULT 0,
			email TEXT, name TEXT, nickname TEXT, avatar TEXT, roles TEXT
		);
		CREATE TABLE proxy_host (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			owner_user_id INTEGER, is_deleted INTEGER DEFAULT 0,
			domain_names TEXT, forward_host TEXT, forward_port INTEGER, forward_scheme TEXT,
			access_list_id INTEGER DEFAULT 0, certificate_id INTEGER DEFAULT 0,
			ssl_forced INTEGER DEFAULT 0, caching_enabled INTEGER DEFAULT 0,
			block_exploits INTEGER DEFAULT 0, allow_websocket_upgrade INTEGER DEFAULT 0,
			http2_support INTEGER DEFAULT 0, hsts_enabled INTEGER DEFAULT 0,
			hsts_subdomains INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
			advanced_config TEXT DEFAULT '', meta TEXT
		);
		CREATE TABLE access_list (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			owner_user_id INTEGER, is_deleted INTEGER DEFAULT 0, name TEXT, meta TEXT
		);
		CREATE TABLE access_list_auth (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			access_list_id INTEGER, username TEXT, password TEXT, meta TEXT
		);
		CREATE TABLE certificate (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			owner_user_id INTEGER, is_deleted INTEGER DEFAULT 0,
			provider TEXT, nice_name TEXT DEFAULT '', domain_names TEXT,
			expires_on TEXT, meta TEXT
		);
		CREATE TABLE setting (
			id TEXT PRIMARY KEY, name TEXT, description TEXT, value TEXT, meta TEXT
		);
		CREATE TABLE audit_log (
			id INTEGER PRIMARY KEY, created_on TEXT, modified_on TEXT,
			user_id INTEGER, object_type TEXT, object_id INTEGER, action TEXT, meta TEXT
		);
	`);

	db.exec(`
		INSERT INTO auth (id, created_on, modified_on, user_id, type, secret, meta)
		VALUES (1, '2025-01-01', '2025-01-01', 1, 'password', 'top-secret-hash', '{}');

		INSERT INTO user (id, created_on, modified_on, email, name, nickname, avatar, roles)
		VALUES (1, '2025-01-01', '2025-01-01', 'admin@example.com', 'Admin', 'Admin', '', '["admin"]');

		INSERT INTO proxy_host (id, created_on, modified_on, owner_user_id, domain_names,
			forward_host, forward_port, forward_scheme, certificate_id, ssl_forced, meta)
		VALUES (2, '2025-01-01', '2025-02-01', 1, '["zeta.example.com"]',
			'10.0.0.9', 8080, 'http', 1, 1, '{"letsencrypt_agree": true}');

		INSERT INTO proxy_host (id, created_on, modified_on, owner_user_id, domain_names,
			forward_host, forward_port, forward_scheme, certificate_id, ssl_forced, meta)
		VALUES (1, '2025-01-01', '2025-02-01', 1, '["alpha.example.com", "www.alpha.example.com"]',
			'10.0.0.2', 3000, 'http', 0, 0, '{}');

		INSERT INTO proxy_host (id, created_on, modified_on, owner_user_id, is_deleted,
			domain_names, forward_host, forward_port, forward_scheme, meta)
		VALUES (3, '2025-01-01', '2025-03-01', 1, 1, '["gone.example.com"]',
			'10.0.0.3', 80, 'http', '{}');

		INSERT INTO access_list (id, created_on, modified_on, owner_user_id, name, meta)
		VALUES (1, '2025-01-01', '2025-01-01', 1, 'family', '{}');

		INSERT INTO access_list_auth (id, created_on, modified_on, access_list_id, username, password, meta)
		VALUES (1, '2025-01-01', '2025-01-01', 1, 'someone', 'plain-or-hashed-either-way', '{}');

		INSERT INTO certificate (id, created_on, modified_on, owner_user_id, provider, nice_name,
			domain_names, expires_on, meta)
		VALUES (1, '2025-01-01', '2025-01-01', 1, 'letsencrypt', 'alpha',
			'["alpha.example.com"]', '2026-01-01',
			'{"dns_provider": "cloudflare", "dns_provider_credentials": "dns_cloudflare_api_token = abcd1234", "letsencrypt_agree": true}');

		INSERT INTO setting (id, name, description, value, meta)
		VALUES ('default-site', 'Default Site', 'What to show when nothing matches', 'congratulations', '{}');

		INSERT INTO setting (id, name, description, value, meta)
		VALUES ('oidc-config', 'OIDC', 'Single sign on', '{"clientId": "proxy", "clientSecret": "must-not-leak"}', '{}');

		INSERT INTO proxy_host (id, created_on, modified_on, owner_user_id, domain_names,
			forward_host, forward_port, forward_scheme, advanced_config, meta)
		VALUES (4, '2025-01-01', '2025-02-01', 1, '["raw.example.com"]',
			'10.0.0.4', 9000, 'http', 'proxy_set_header X-Api-Token free-text-not-filtered;', '{}');

		INSERT INTO audit_log (id, created_on, modified_on, user_id, object_type, object_id, action, meta)
		VALUES (1, '2025-01-01', '2025-01-01', 1, 'proxy-host', 1, 'created', '{}');
	`);

	db.close();
	return { dir, path };
}
