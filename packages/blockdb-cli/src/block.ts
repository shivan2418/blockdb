import { compressionSuffix, type Compression } from "./types.js";
import { contentHash } from "./hash.js";
import type { BlockDescriptor } from "./types.js";

/** Past this many blocks, files nest under a 2-hex-char prefix subdir so no one directory holds an unwieldy number of files (ADR-0002 §8). */
export const HASH_PREFIX_THRESHOLD = 1000;
const HASH_PREFIX_LEN = 2;

/**
 * The on-disk (and served) path of a block file relative to `output`, given the TOTAL block
 * count — a deterministic, threshold-based rule shared with the runtime's read path
 * (`block-fetch.ts`), so no extra manifest field is needed to record the directory layout. The
 * gzip extension IS recorded in the manifest (`dataset.gzip`) since a query doesn't otherwise
 * know a deploy's build-time compression choice.
 */
export function blockRelPath(hash: string, blockCount: number, compression: Compression = "none"): string {
  const filename = `${hash}.ndjson${compressionSuffix(compression)}`;
  return blockCount > HASH_PREFIX_THRESHOLD ? `blocks/${hash.slice(0, HASH_PREFIX_LEN)}/${filename}` : `blocks/${filename}`;
}

/**
 * Cuts records (already globally sorted by `sortField`) into byte-target
 * blocks. Equal-key runs are kept contiguous even when that means a block
 * exceeds the target — otherwise the sort field's zonemap ranges could
 * overlap between adjacent blocks (ADR-0002).
 */
export function cutIntoBlocks(
  records: Record<string, unknown>[],
  sortField: string,
  targetBytes: number,
): Record<string, unknown>[][] {
  const blocks: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;

  for (const record of records) {
    const lineBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1; // + newline
    const wouldExceed = current.length > 0 && currentBytes + lineBytes > targetBytes;
    const sameKeyAsLast = current.length > 0 && current[current.length - 1]![sortField] === record[sortField];

    if (wouldExceed && !sameKeyAsLast) {
      blocks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(record);
    currentBytes += lineBytes;
  }
  if (current.length > 0) blocks.push(current);

  return blocks;
}

export interface BlockFile extends BlockDescriptor {
  content: string;
}

/** Serializes each block group to newline-terminated NDJSON and content-hashes it. */
export function materializeBlocks(groups: Record<string, unknown>[][]): BlockFile[] {
  return groups.map((group) => {
    const content = group.map((record) => JSON.stringify(record)).join("\n") + "\n";
    return {
      hash: contentHash(content),
      bytes: Buffer.byteLength(content, "utf8"),
      count: group.length,
      content,
    };
  });
}
