// Offloaded storage for the heavy request-detail JSON payloads.
//
// The lightweight summary of each request lives in the `requestDetails` SQLite
// table (uncapped). The heavy bodies (request / providerRequest /
// providerResponse / response) are written here as gzip-compressed files on
// disk, sharded by date, and capped by TOTAL size (oldest evicted first).
// They are read back — and decompressed — only when a user opens the detail
// drawer, so they never weigh down the list or the analytics queries.

import path from "node:path";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { DATA_DIR } from "@/lib/dataDir.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PAYLOAD_DIR = path.join(DATA_DIR, "request-details", "payloads");

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
// Evict down to this fraction of the cap so we don't prune on every write.
const EVICT_TARGET_RATIO = 0.95;

function getMaxBytes() {
  const raw = parseInt(process.env.OBSERVABILITY_PAYLOAD_MAX_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

// Running total of bytes on disk, seeded once by an initial walk.
let totalBytes = 0;
let sizeInitPromise = null;

// Filenames must be filesystem-safe (ids contain ISO timestamps with ":").
function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Date shard derived from the id/timestamp (ids begin with an ISO timestamp).
function shardFor(id, timestamp) {
  const src = (timestamp || id || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(src) ? src : "unknown";
}

function fileFor(id, timestamp) {
  return path.join(PAYLOAD_DIR, shardFor(id, timestamp), `${safeName(id)}.json.gz`);
}

async function walkSize() {
  let sum = 0;
  let shards;
  try {
    shards = await fs.readdir(PAYLOAD_DIR, { withFileTypes: true });
  } catch {
    return 0; // dir not created yet
  }
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const dir = path.join(PAYLOAD_DIR, shard.name);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      try { sum += (await fs.stat(path.join(dir, f))).size; } catch { /* gone */ }
    }
  }
  return sum;
}

function ensureSizeInitialized() {
  if (!sizeInitPromise) {
    sizeInitPromise = walkSize().then((sum) => { totalBytes = sum; });
  }
  return sizeInitPromise;
}

// Delete oldest shards/files until we're under EVICT_TARGET_RATIO of the cap.
async function evictIfNeeded() {
  const cap = getMaxBytes();
  if (totalBytes <= cap) return;
  const target = cap * EVICT_TARGET_RATIO;

  let shards;
  try {
    shards = (await fs.readdir(PAYLOAD_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // ascending date == oldest first
  } catch {
    return;
  }

  for (const shard of shards) {
    if (totalBytes <= target) break;
    const dir = path.join(PAYLOAD_DIR, shard);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (totalBytes <= target) break;
      const fp = path.join(dir, f);
      try {
        const { size } = await fs.stat(fp);
        await fs.unlink(fp);
        totalBytes -= size;
      } catch { /* already gone */ }
    }
    // Best-effort: remove the now-empty shard dir.
    try { await fs.rmdir(dir); } catch { /* not empty / busy */ }
  }
}

// Persist the full detail object as a gzip file. Best-effort: never throws.
export async function writePayload(id, timestamp, fullDetail) {
  if (!id) return;
  try {
    await ensureSizeInitialized();
    const buf = await gzip(Buffer.from(JSON.stringify(fullDetail ?? null), "utf-8"));
    const fp = fileFor(id, timestamp);
    await fs.mkdir(path.dirname(fp), { recursive: true });

    // Account for an overwrite of an existing file.
    let prev = 0;
    try { prev = (await fs.stat(fp)).size; } catch { /* new file */ }

    await fs.writeFile(fp, buf);
    totalBytes += buf.length - prev;

    await evictIfNeeded();
  } catch (e) {
    console.error("[requestPayloadStore] write failed:", e?.message || e);
  }
}

// Read + decompress a payload. Returns null if the file is missing (evicted /
// never stored), so callers can fall back to the light summary.
export async function readPayload(id, timestamp) {
  if (!id) return null;
  try {
    const buf = await fs.readFile(fileFor(id, timestamp));
    const json = (await gunzip(buf)).toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
