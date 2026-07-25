import { fetchCompressedText, fetchText, parseCorruptible } from "./fetch-file.js";
import { compressionSuffix, decompressionFormat, type Compression } from "./types.js";

/** Past this many shards, files nest under a 2-hex-char prefix subdir (ADR-0002 §8) — must match `shardRelPath` in the CLI's `shard.ts` exactly, since no manifest field records which layout a deploy used. */
const HASH_PREFIX_THRESHOLD = 1000;
const HASH_PREFIX_LEN = 2;

/**
 * The served path of a shard file, given the TOTAL shard count (`manifest.shards.length`) and
 * whether the deploy gzips shard payloads (`manifest.dataset.gzip`). Exported (rather than kept
 * module-private) solely so the CLI's own test suite can assert this stays byte-for-byte
 * identical to `shard.ts`'s build-side `shardRelPath` — the two are independent implementations
 * with no shared module, so an equivalence test is the only thing that catches drift between them.
 */
export function shardRelPath(hash: string, shardCount: number, compression: Compression): string {
  const filename = `${hash}.ndjson${compressionSuffix(compression)}`;
  return shardCount > HASH_PREFIX_THRESHOLD ? `shards/${hash.slice(0, HASH_PREFIX_LEN)}/${filename}` : `shards/${filename}`;
}

export async function fetchShardRecords(
  basePath: string,
  hash: string,
  shardCount: number,
  compression: Compression,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const url = `${basePath}/${shardRelPath(hash, shardCount, compression)}`;
  const format = decompressionFormat(compression);
  const text =
    format === undefined
      ? await fetchText(url, "referenced", fetchImpl, signal)
      : await fetchCompressedText(url, "referenced", format, fetchImpl, signal);
  return parseCorruptible(url, () =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}
