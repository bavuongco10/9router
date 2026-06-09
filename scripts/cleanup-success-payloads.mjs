// One-time / repeatable cleanup of heavy request-detail payloads for SUCCESSFUL
// requests. Going forward, requestDetailsRepo only writes payloads for failed
// requests; this prunes the success payloads written before that change.
//
// It only ever deletes gzip payload FILES on disk — it never touches the SQLite
// DB, so it is inherently DB-safe (the WAL / checkpoint protocol does not apply).
// The lightweight summary rows in the `requestDetails` table are left untouched,
// so success/failure analytics stay intact.
//
// Each payload file embeds its own `status` (see prepareRecord in
// requestDetailsRepo.js), so we decide purely from the file contents — no DB or
// app imports needed. Run it against a data dir, e.g.:
//
//   node scripts/cleanup-success-payloads.mjs ../data-development
//   node scripts/cleanup-success-payloads.mjs ../data-development --dry-run
//
// Defaults to $DATA_DIR, else ../data-development relative to this script.

import path from "node:path";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const gunzip = promisify(zlib.gunzip);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir =
  positional[0] ||
  process.env.DATA_DIR ||
  path.resolve(here, "..", "..", "data-development");

const payloadDir = path.join(dataDir, "request-details", "payloads");

async function statusOf(fp) {
  try {
    const buf = await fs.readFile(fp);
    const json = JSON.parse((await gunzip(buf)).toString("utf-8"));
    return json?.status ?? null;
  } catch {
    return undefined; // unreadable/corrupt — leave it alone
  }
}

async function main() {
  console.log(`[cleanup] payload dir: ${payloadDir}${dryRun ? " (dry-run)" : ""}`);

  let shards;
  try {
    shards = (await fs.readdir(payloadDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    console.error(`[cleanup] cannot read ${payloadDir}: ${e?.message || e}`);
    process.exit(1);
  }

  let scanned = 0;
  let deleted = 0;
  let freedBytes = 0;

  for (const shard of shards) {
    const dir = path.join(payloadDir, shard);
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json.gz")) continue;
      const fp = path.join(dir, f);
      scanned++;
      const status = await statusOf(fp);
      if (status !== "success") continue; // keep failed / unknown / unreadable
      let size = 0;
      try {
        size = (await fs.stat(fp)).size;
      } catch {
        /* gone */
      }
      if (!dryRun) {
        try {
          await fs.unlink(fp);
        } catch (e) {
          console.error(`[cleanup] failed to delete ${fp}: ${e?.message || e}`);
          continue;
        }
      }
      deleted++;
      freedBytes += size;
    }
    // Best-effort: drop the shard dir if it's now empty.
    if (!dryRun) {
      try {
        if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
      } catch {
        /* not empty / busy */
      }
    }
  }

  const mb = (freedBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[cleanup] scanned ${scanned}, ${dryRun ? "would delete" : "deleted"} ${deleted} success payloads, ${dryRun ? "would free" : "freed"} ${mb} MB`
  );
}

main();
