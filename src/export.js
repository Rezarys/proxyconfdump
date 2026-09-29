/**
 * Read a self-hosted proxy manager SQLite database and turn it into a sorted, secret-free
 * plain object ready to be serialised as JSON and committed to git.
 *
 * Two properties matter more than features here:
 *
 *  1. The database is opened read-only and no code path writes to it.
 *  2. The output is deterministic. No timestamp, no file path, no tool version is written
 *     into the document, because a field that changes on every run turns every diff into
 *     noise and defeats the whole point of committing the file.
 */

import { DatabaseSync } from "node:sqlite";
import { redact } from "./redact.js";

/** Document format marker, bumped when the shape of the output changes. */
export const FORMAT = "proxyconfdump/1";

/**
 * Tables that are exported, in output order.
 * The schema itself is never hardcoded: whatever columns a table actually has are read back
 * with PRAGMA table_info, so older and newer database versions both work without a rewrite.
 */
export const EXPORTED_TABLES = [
	"proxy_host",
	"redirection_host",
	"dead_host",
	"stream",
	"access_list",
	"access_list_auth",
	"access_list_client",
	"certificate",
	"setting",
	"user",
	"user_permission",
];

/**
 * Tables that are never exported, whatever the options.
 * `auth` holds login secrets and `audit_log` grows without bound and says nothing about the
 * configuration.
 */
export const NEVER_EXPORTED = ["auth", "audit_log"];

/** Columns dropped from every table: they carry no configuration. */
const DROPPED_COLUMNS = new Set(["created_on", "modified_on"]);

/** Columns whose text content is stored as JSON by the upstream schema. */
const JSON_COLUMNS = new Set(["domain_names", "meta", "roles"]);

/**
 * Columns the upstream schema declares as plain strings but that sometimes hold a serialised
 * object. `setting.value` is the one that matters: a settings row can carry a whole block of
 * configuration, and a secret inside it would otherwise never be walked by the redaction rule.
 * Such a column is only replaced when it parses into an object or an array, so an ordinary
 * string setting keeps its exact value and its type.
 */
const MAYBE_JSON_COLUMNS = new Set(["value"]);

function parseMaybeJson(columnName, value) {
	if (typeof value !== "string") {
		return value;
	}
	if (JSON_COLUMNS.has(columnName)) {
		try {
			return JSON.parse(value);
		} catch {
			// A column the schema calls JSON but that holds something else is kept verbatim
			// rather than dropped: losing data quietly is worse than an odd-looking line.
			return value;
		}
	}
	if (MAYBE_JSON_COLUMNS.has(columnName)) {
		try {
			const parsed = JSON.parse(value);
			return parsed !== null && typeof parsed === "object" ? parsed : value;
		} catch {
			return value;
		}
	}
	return value;
}

/**
 * Quote a table name for use in a statement.
 * Table names reach this point from a command line flag, so they are checked rather than
 * escaped: anything that is not a plain identifier is refused outright.
 */
function quoteIdent(name) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`not a valid table name: ${name}`);
	}
	return `"${name}"`;
}

/** Table names present in the database file. */
export function tablesIn(db) {
	return db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => row.name);
}

function columnsOf(db, table) {
	return db
		.prepare(`PRAGMA table_info(${quoteIdent(table)})`)
		.all()
		.map((row) => row.name);
}

/**
 * Sort key of a row: the first domain name when there is one, then the name, then the id.
 * Sorting by domain rather than by id keeps a diff readable when rows are recreated.
 */
function sortKeyOf(row) {
	const domains = row.domain_names;
	if (Array.isArray(domains) && domains.length > 0) {
		return [String(domains[0]), Number(row.id ?? 0)];
	}
	if (typeof row.name === "string") {
		return [row.name, Number(row.id ?? 0)];
	}
	if (typeof row.username === "string") {
		return [row.username, Number(row.id ?? 0)];
	}
	if (typeof row.email === "string") {
		return [row.email, Number(row.id ?? 0)];
	}
	return ["", Number(row.id ?? 0)];
}

function compareRows(a, b) {
	const [ka, ia] = sortKeyOf(a);
	const [kb, ib] = sortKeyOf(b);
	if (ka !== kb) {
		return ka < kb ? -1 : 1;
	}
	return ia - ib;
}

function readTable(db, table, { includeDeleted }) {
	const columns = columnsOf(db, table).filter((name) => !DROPPED_COLUMNS.has(name));
	const hasDeletedFlag = columns.includes("is_deleted");
	const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
	const out = [];
	for (const raw of rows) {
		if (hasDeletedFlag && !includeDeleted && Number(raw.is_deleted) === 1) {
			continue;
		}
		const row = {};
		for (const column of columns) {
			if (column === "is_deleted" && !includeDeleted) {
				continue;
			}
			row[column] = redact(parseMaybeJson(column, raw[column]), column);
		}
		out.push(row);
	}
	out.sort(compareRows);
	return out;
}

/**
 * Build the export document.
 *
 * @param {string} databasePath path to the SQLite file, opened read-only
 * @param {{includeDeleted?: boolean, tables?: string[], exclude?: string[]}} [options]
 * @returns {{format: string, tables: Record<string, object[]>}}
 */
export function exportDatabase(databasePath, options = {}) {
	const includeDeleted = options.includeDeleted === true;
	const excluded = new Set(options.exclude ?? []);
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const present = new Set(tablesIn(db));
		let wanted = options.tables && options.tables.length > 0 ? options.tables : EXPORTED_TABLES;
		wanted = wanted.filter((table) => !NEVER_EXPORTED.includes(table) && !excluded.has(table));

		if (wanted.length === 0) {
			throw new Error("nothing left to export once the excluded tables are removed");
		}
		const unknown = wanted.filter((table) => !present.has(table));
		if (unknown.length === wanted.length) {
			throw new Error(
				`no exportable table found in ${databasePath} (looked for: ${wanted.join(", ")})`,
			);
		}

		const tables = {};
		for (const table of wanted) {
			if (!present.has(table)) {
				continue;
			}
			tables[table] = readTable(db, table, { includeDeleted });
		}
		return { format: FORMAT, tables };
	} finally {
		db.close();
	}
}

/** Serialise a document the way the CLI writes it: two-space indent, trailing newline. */
export function serialise(document) {
	return `${JSON.stringify(document, null, 2)}\n`;
}
