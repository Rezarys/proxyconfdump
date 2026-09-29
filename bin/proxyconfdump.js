#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * proxyconfdump <database.sqlite> [--out-dir <dir>] [--tables a,b] [--include-deleted]
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { EXPORTED_TABLES, exportDatabase, serialise } from "../src/export.js";

/** Single source of truth for the version: the manifest. */
const VERSION = createRequire(import.meta.url)("../package.json").version;

const USAGE = `proxyconfdump <database.sqlite> [options]

Reads a self-hosted proxy manager SQLite database and writes its configuration as sorted JSON.
The database is opened read-only. Values whose column or JSON key looks like a secret are
replaced by "[redacted]", and the auth and audit_log tables are never exported.

Options:
  --out-dir <dir>     write one file per entry under <dir>/<table>/ instead of stdout
  --tables <a,b,c>    export only these tables (default: ${EXPORTED_TABLES.join(", ")})
  --exclude <a,b,c>   drop these tables from whatever would be exported
  --include-deleted   keep rows flagged as deleted (they are dropped by default)
  -h, --help          show this message
  -v, --version       show the version

The user table carries the account email addresses. Use --exclude user,user_permission
if the export goes somewhere those addresses should not go.
`;

function parseArgs(argv) {
	const options = { includeDeleted: false, outDir: null, tables: null, exclude: [], path: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			return { help: true };
		}
		if (arg === "-v" || arg === "--version") {
			return { version: true };
		}
		if (arg === "--include-deleted") {
			options.includeDeleted = true;
		} else if (arg === "--out-dir") {
			options.outDir = argv[++i] ?? null;
			if (options.outDir === null) {
				throw new Error("--out-dir needs a directory");
			}
		} else if (arg === "--tables") {
			const list = argv[++i] ?? "";
			options.tables = list
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean);
			if (options.tables.length === 0) {
				throw new Error("--tables needs at least one table name");
			}
		} else if (arg === "--exclude") {
			const list = argv[++i] ?? "";
			options.exclude = list
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean);
			if (options.exclude.length === 0) {
				throw new Error("--exclude needs at least one table name");
			}
		} else if (arg.startsWith("-")) {
			throw new Error(`unknown option: ${arg}`);
		} else if (options.path === null) {
			options.path = arg;
		} else {
			throw new Error(`unexpected argument: ${arg}`);
		}
	}
	return options;
}

/** File name for one exported row: readable, stable, and safe on every platform. */
export function fileNameFor(row, index) {
	const domains = row.domain_names;
	const raw =
		(Array.isArray(domains) && domains.length > 0 && String(domains[0])) ||
		(typeof row.name === "string" && row.name) ||
		(typeof row.username === "string" && row.username) ||
		(typeof row.email === "string" && row.email) ||
		(row.incoming_port !== undefined && `port-${row.incoming_port}`) ||
		"";
	// A name comes from the database, so it is user input: anything that is not plainly safe in
	// a file name is folded away, runs of dots included, and a name left with nothing usable
	// falls back to the id.
	const slug = String(raw)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[.\-]+|[.\-]+$/g, "")
		.slice(0, 80);
	const id = row.id ?? index;
	return slug ? `${slug}.${id}.json` : `${id}.json`;
}

function writeSplit(document, outDir) {
	const written = [];
	for (const [table, rows] of Object.entries(document.tables)) {
		const dir = join(outDir, table);
		mkdirSync(dir, { recursive: true });
		rows.forEach((row, index) => {
			const name = fileNameFor(row, index);
			writeFileSync(join(dir, name), serialise(row));
			written.push(join(table, name));
		});
	}
	return written;
}

/**
 * Report files left over from an earlier export that this run did not rewrite.
 * They are listed, never deleted: removing a file the user put there by hand would be a
 * surprise, and a surprise that destroys data.
 */
function reportStale(document, outDir, written) {
	const kept = new Set(written);
	const stale = [];
	for (const table of Object.keys(document.tables)) {
		let entries = [];
		try {
			entries = readdirSync(join(outDir, table));
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.endsWith(".json") && !kept.has(join(table, entry))) {
				stale.push(join(table, entry));
			}
		}
	}
	return stale;
}

function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`proxyconfdump: ${error.message}\n\n${USAGE}`);
		return 2;
	}

	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.version) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	if (!options.path) {
		process.stderr.write(USAGE);
		return 2;
	}

	let document;
	try {
		document = exportDatabase(options.path, {
			includeDeleted: options.includeDeleted,
			tables: options.tables,
			exclude: options.exclude,
		});
	} catch (error) {
		process.stderr.write(`proxyconfdump: ${error.message}\n`);
		return 1;
	}

	if (options.outDir) {
		const written = writeSplit(document, options.outDir);
		const stale = reportStale(document, options.outDir, written);
		process.stderr.write(
			`proxyconfdump: wrote ${written.length} file(s) under ${options.outDir}\n`,
		);
		if (stale.length > 0) {
			process.stderr.write(
				`proxyconfdump: ${stale.length} file(s) left from an earlier export and not rewritten now, delete them yourself if the entries are gone:\n`,
			);
			for (const name of stale) {
				process.stderr.write(`  ${name}\n`);
			}
		}
		return 0;
	}

	process.stdout.write(serialise(document));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}

export { main, parseArgs, VERSION };
