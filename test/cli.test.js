import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VERSION, fileNameFor, main, parseArgs } from "../bin/proxyhosts.js";
import { makeFixture } from "./helpers/fixture.js";

const { path } = makeFixture();

function capture(argv) {
	const out = [];
	const err = [];
	const realOut = process.stdout.write;
	const realErr = process.stderr.write;
	process.stdout.write = (chunk) => {
		out.push(String(chunk));
		return true;
	};
	process.stderr.write = (chunk) => {
		err.push(String(chunk));
		return true;
	};
	try {
		const code = main(argv);
		return { code, out: out.join(""), err: err.join("") };
	} finally {
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	}
}

test("the version reported is the one in the manifest", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
	assert.equal(VERSION, manifest.version);
	assert.equal(capture(["--version"]).out.trim(), manifest.version);
});

test("help explains the tool and exits cleanly", () => {
	const { code, out } = capture(["--help"]);
	assert.equal(code, 0);
	assert.match(out, /--out-dir/);
	assert.match(out, /read-only/i);
});

test("no argument at all is a usage error, not a crash", () => {
	assert.equal(capture([]).code, 2);
});

test("an unknown option is refused with its name", () => {
	const { code, err } = capture(["--nope", path]);
	assert.equal(code, 2);
	assert.match(err, /unknown option: --nope/);
});

test("a missing database file is an error, not an empty export", () => {
	const { code, err } = capture([join(tmpdir(), "proxyhosts-absent.sqlite")]);
	assert.equal(code, 1);
	assert.match(err, /proxyhosts:/);
});

test("the default run writes the document to stdout", () => {
	const { code, out } = capture([path]);
	assert.equal(code, 0);
	const document = JSON.parse(out);
	assert.equal(document.format, "proxyhosts/1");
	assert.equal(document.tables.proxy_host.length, 3);
	assert.ok(out.endsWith("\n"));
});

test("--exclude keeps the account email addresses out of the export", () => {
	const { code, out } = capture([path, "--exclude", "user,user_permission"]);
	assert.equal(code, 0);
	assert.ok(!out.includes("admin@example.com"));
	assert.equal(JSON.parse(out).tables.user, undefined);
});

test("option parsing keeps the database path and the flags apart", () => {
	const options = parseArgs(["--include-deleted", "db.sqlite", "--tables", "proxy_host, stream"]);
	assert.equal(options.path, "db.sqlite");
	assert.equal(options.includeDeleted, true);
	assert.deepEqual(options.tables, ["proxy_host", "stream"]);
});

test("an option that needs a value and does not get one is refused", () => {
	assert.throws(() => parseArgs(["db.sqlite", "--out-dir"]), /--out-dir needs/);
	assert.throws(() => parseArgs(["db.sqlite", "--tables", ""]), /--tables needs/);
	assert.throws(() => parseArgs(["db.sqlite", "--exclude", ""]), /--exclude needs/);
});

test("file names come from the domain, the name or the id", () => {
	assert.equal(fileNameFor({ id: 1, domain_names: ["Alpha.Example.com"] }, 0), "alpha.example.com.1.json");
	assert.equal(fileNameFor({ id: 4, name: "family & friends" }, 0), "family-friends.4.json");
	assert.equal(fileNameFor({ id: 7, incoming_port: 2222 }, 0), "port-2222.7.json");
	assert.equal(fileNameFor({ id: 9 }, 0), "9.json");
	assert.equal(fileNameFor({}, 3), "3.json");
});

test("a file name never escapes its directory", () => {
	const name = fileNameFor({ id: 1, name: "../../etc/passwd" }, 0);
	assert.ok(!name.includes("/"));
	assert.ok(!name.includes(".."));
});

test("--out-dir writes one readable file per entry", () => {
	const dir = mkdtempSync(join(tmpdir(), "proxyhosts-out-"));
	const { code, err } = capture([path, "--out-dir", dir]);
	assert.equal(code, 0);
	assert.match(err, /wrote \d+ file/);
	const names = readdirSync(join(dir, "proxy_host")).sort();
	assert.deepEqual(names, [
		"alpha.example.com.1.json",
		"raw.example.com.4.json",
		"zeta.example.com.2.json",
	]);
	const host = JSON.parse(readFileSync(join(dir, "proxy_host", names[0])));
	assert.equal(host.forward_port, 3000);
});

test("a file left by an earlier export is reported and not deleted", () => {
	const dir = mkdtempSync(join(tmpdir(), "proxyhosts-stale-"));
	capture([path, "--out-dir", dir]);
	const stale = join(dir, "proxy_host", "old.99.json");
	writeFileSync(stale, "{}\n");
	const { err } = capture([path, "--out-dir", dir]);
	assert.match(err, /left from an earlier export/);
	assert.match(err, /old\.99\.json/);
	assert.equal(readFileSync(stale, "utf8"), "{}\n");
});
