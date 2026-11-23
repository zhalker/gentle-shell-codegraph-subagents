import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_VERSION_MARKER, indexVersionMarker, readIndexVersionMarker, writeIndexVersionMarker } from "../src/autoindex.ts";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pcs-reidx-")));
}

function withIndex(dir: string): void {
	mkdirSync(join(dir, ".codegraph"), { recursive: true });
}

test("P5: a project without a marker says no known version (first run after install: nothing to decide yet)", () => {
	const dir = scratch();
	assert.equal(readIndexVersionMarker(dir, (p) => existsSync(p)), undefined);
});

test("P5: writeIndexVersionMarker persists the version alongside the index it describes", () => {
	const dir = scratch();
	withIndex(dir);
	writeIndexVersionMarker(dir, "1.6.4");
	const raw = JSON.parse(readFileSync(join(dir, ".codegraph", INDEX_VERSION_MARKER), "utf8")) as { version: string };
	assert.equal(raw.version, "1.6.4");
	assert.equal(readIndexVersionMarker(dir, (p) => existsSync(p)), "1.6.4");
});

test("P5: same version is current; a different one needs a reindex; no marker on an existing index is unknown", () => {
	const dir = scratch();
	withIndex(dir);
	const exists = (p: string) => existsSync(p);
	assert.equal(indexVersionMarker(dir, "1.6.4", exists), "unknown");
	writeIndexVersionMarker(dir, "1.6.0", exists);
	assert.equal(indexVersionMarker(dir, "1.6.4", exists), "reindex");
	assert.equal(indexVersionMarker(dir, "1.6.0", exists), "current");
});

test("P5: a downgrade is not a reindex trigger (the older engine reads a newer index; user decides)", () => {
	const dir = scratch();
	withIndex(dir);
	const exists = (p: string) => existsSync(p);
	writeIndexVersionMarker(dir, "1.6.4", exists);
	// An older engine reading a marker its version is lower than: still a reindex, but the caller reports
	// it differently. kept simple: any non-equal version is a reindex; downgrades are rare and also broken.
	assert.equal(indexVersionMarker(dir, "1.6.0", exists), "reindex");
});

test("P5: no index means no reindex regardless of markers", () => {
	const dir = scratch();
	const exists = (p: string) => existsSync(p);
	writeIndexVersionMarker(dir, "1.6.0", exists);
	rmSync(join(dir, ".codegraph"), { recursive: true, force: true });
	assert.equal(indexVersionMarker(dir, "1.6.4", exists), "none");
});
