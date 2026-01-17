// This is the result of spamming Codex with "make it faster" prompts until it gave up.
// Queries are about 7x faster than v0.0.2 in my tests (4.4ms/10k queries, vs 34ms/10k), and also adds support for IPv6.
// You can import the original from here if you'd prefer that:
//   - https://cdn.jsdelivr.net/gh/josephrocca/is-vpn@v0.0.2/mod.js

/*
Algorithm overview (implementation notes, data layout, and query flow)
====================================================================

This module answers a single question: "is this IP in a known VPN / datacenter range?"
It does so by downloading CIDR lists (IPv4 + IPv6), converting each CIDR to an inclusive
range, compressing/merging overlaps, and then building indexes tuned for fast membership
tests. The hot path is the `isVpn(ip)` function, which:

1) Detects IPv4 vs IPv6 by scanning for '.' or ':' (early exit, no allocations).
2) Parses the textual IP into integers:
   - IPv4 -> a single 32-bit unsigned integer.
   - IPv6 -> four 32-bit unsigned integers (p0..p3) representing the 128-bit address.
3) Performs membership checks in the prebuilt indexes.

The design goal is fast queries with low constant factors (few allocations, compact arrays),
while keeping code readable. The structures are:

IPv4 index (bucketed high/low 16-bit scheme)
-------------------------------------------
Each IPv4 address is a 32-bit integer. We split it into:
  high = ip >>> 16   (top 16 bits)
  low  = ip & 0xFFFF (bottom 16 bits)

We store 65,536 buckets (one per possible high value). Each bucket is in one of three states:
  0 = empty (no ranges)
  1 = full  (entire low range [0..65535] is covered)
  2 = partial (a list of merged low ranges)

For partial buckets, we store two packed arrays:
  starts[] and ends[] (Uint16Array)
and two per-bucket arrays:
  offsets[] and counts[] (Uint32Array)

Query flow:
  - Read bucket type via high.
  - If full => true, if empty => false.
  - If partial => binary search the bucket's low-range list.

This yields O(log k) per lookup within a bucket, with k typically small.

IPv6 index (bucketed on top 32 bits, packed low-96-bit ranges)
--------------------------------------------------------------
We represent IPv6 addresses as four 32-bit unsigned integers: p0..p3.
We bucket by p0 (top 32 bits). This yields:
  - "full bucket" for p0 if that entire /32 is covered.
  - "partial bucket" for p0 with a list of low-96-bit ranges.
  - "super ranges" for ranges that span multiple p0 values.

Low-96-bit ranges are stored in six parallel Uint32Arrays:
  startsHi, startsMid, startsLo, endsHi, endsMid, endsLo
where each entry represents [p1,p2,p3] start and end of a range.
Each p0 bucket stores offset + count into these arrays.

For fast metadata lookup (p0 -> {type, offset, count}),
we build a flat open-addressed hash table (Uint32Array) plus
parallel arrays for keys, types, offsets, and counts.

Query flow:
  1) Check "super ranges" (binary search on sorted ranges).
     If covered => true.
  2) Hash-lookup p0 to find its bucket:
       - If missing => false.
       - If full => true.
       - If partial => binary search the low-96-bit ranges.

IPv6 parsing (string -> four 32-bit parts)
------------------------------------------
We avoid allocations for the hot path using scratch typed arrays:
  - IPV6_SCRATCH_SEGMENTS (Uint16Array[8]) for 8 hex groups
  - IPV6_SCRATCH_PARTS    (Uint32Array[4]) for p0..p3

Fast path:
  - If the input is exactly 39 chars and matches fully-expanded form
    (e.g. "2001:0db8:0000:0000:0000:0000:0000:0001"),
    parse 8 fixed 4-hex groups without any splitting.

General path:
  - Supports "::" compression and IPv4-mapped tails.
  - Scans char-by-char, accumulates hex digits, and handles the "::" gap.
  - Converts segments to p0..p3 with a final pack step.

CIDR conversion
---------------
IPv4 CIDR -> [start,end] by applying a mask.
IPv6 CIDR -> [start,end] by applying a 128-bit mask to p0..p3.

List updates
------------
The lists are refreshed every 12 hours. During update we rebuild the
indexes and replace the in-memory references atomically.

Correctness & performance
-------------------------
This is a "lossless" range conversion/merge (no heuristic expansion).
The indexes are tuned for speed and avoid object allocation in the hot path.
*/
const IPV4_LIST_URL = "https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ipv4-ranges.txt";
const IPV6_LIST_URL = "https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ipv6-ranges.txt";

const ipv4ToInt = (ip) => {
  let num = 0;
  let octet = 0;
  let octetCount = 0;
  for (let i = 0; i < ip.length; i++) {
    const code = ip.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      octet = octet * 10 + (code - 48);
      if (octet > 255) return null;
      continue;
    }
    if (code === 46) {
      if (octetCount >= 3) return null;
      num = (num << 8) | octet;
      octet = 0;
      octetCount++;
      continue;
    }
    if (code === 47 || code === 37) break;
    return null;
  }
  if (octetCount !== 3) return null;
  num = (num << 8) | octet;
  return num >>> 0;
};

const ipv4CidrToRange = (cidr) => {
  const [baseIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ipInt = ipv4ToInt(baseIp);
  if (ipInt === null) return null;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const start = (ipInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
};

const mergeRanges32 = (ranges) => {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const cur = ranges[i];
    const last = merged[merged.length - 1];
    if (cur.start > last.end + 1) {
      merged.push(cur);
    } else if (cur.end > last.end) {
      last.end = cur.end;
    }
  }
  return merged;
};

const buildIpv4IndexFromCidrs = (cidrs) => {
  const ranges = [];
  for (let i = 0; i < cidrs.length; i++) {
    const range = ipv4CidrToRange(cidrs[i]);
    if (range) ranges.push(range);
  }
  const merged = mergeRanges32(ranges);

  const bucketType = new Uint8Array(65536);
  const bucketLists = new Array(65536);

  for (let i = 0; i < merged.length; i++) {
    const range = merged[i];
    const startHigh = range.start >>> 16;
    const endHigh = range.end >>> 16;
    for (let high = startHigh; high <= endHigh; high++) {
      if (bucketType[high] === 1) continue;
      const lowStart = high === startHigh ? (range.start & 0xFFFF) : 0;
      const lowEnd = high === endHigh ? (range.end & 0xFFFF) : 0xFFFF;
      if (lowStart === 0 && lowEnd === 0xFFFF) {
        bucketType[high] = 1;
        bucketLists[high] = null;
      } else {
        if (!bucketLists[high]) bucketLists[high] = [];
        bucketLists[high].push([lowStart, lowEnd]);
      }
    }
  }

  let total = 0;
  for (let i = 0; i < bucketLists.length; i++) {
    const list = bucketLists[i];
    if (!list || bucketType[i] === 1) continue;
    list.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const mergedLow = [list[0]];
    for (let j = 1; j < list.length; j++) {
      const cur = list[j];
      const last = mergedLow[mergedLow.length - 1];
      if (cur[0] > last[1] + 1) {
        mergedLow.push(cur);
      } else if (cur[1] > last[1]) {
        last[1] = cur[1];
      }
    }
    if (mergedLow.length === 1 && mergedLow[0][0] === 0 && mergedLow[0][1] === 0xFFFF) {
      bucketType[i] = 1;
      bucketLists[i] = null;
    } else {
      bucketType[i] = 2;
      bucketLists[i] = mergedLow;
      total += mergedLow.length;
    }
  }

  const starts = new Uint16Array(total);
  const ends = new Uint16Array(total);
  const offsets = new Uint32Array(65536);
  const counts = new Uint32Array(65536);

  let cursor = 0;
  for (let i = 0; i < bucketLists.length; i++) {
    const list = bucketLists[i];
    if (!list || bucketType[i] !== 2) continue;
    offsets[i] = cursor;
    counts[i] = list.length;
    for (let j = 0; j < list.length; j++) {
      starts[cursor] = list[j][0];
      ends[cursor] = list[j][1];
      cursor++;
    }
  }

  return { bucketType, offsets, counts, starts, ends };
};

const containsIpv4 = (index, ipInt) => {
  const high = ipInt >>> 16;
  const type = index.bucketType[high];
  if (type === 1) return true;
  if (type === 0) return false;
  const low = ipInt & 0xFFFF;
  const offset = index.offsets[high];
  const count = index.counts[high];
  let lo = 0;
  let hi = count - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = index.starts[offset + mid];
    if (start <= low) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx >= 0 && low <= index.ends[offset + idx];
};

const HEX_TABLE = (() => {
  const table = new Int16Array(128);
  table.fill(-1);
  for (let i = 0; i <= 9; i++) table[48 + i] = i;
  for (let i = 0; i < 6; i++) {
    table[65 + i] = 10 + i;
    table[97 + i] = 10 + i;
  }
  return table;
})();

const IPV6_EXPANDED_OFFSETS = [0, 5, 10, 15, 20, 25, 30, 35];
const IPV6_SCRATCH_SEGMENTS = new Uint16Array(8);
const IPV6_SCRATCH_PARTS = new Uint32Array(4);

const parseIpv4Tail = (addr, start, end, segs, segIndex) => {
  let octet = 0;
  let octetCount = 0;
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    const code = addr.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      octet = octet * 10 + (code - 48);
      if (octet > 255) return -1;
      continue;
    }
    if (code === 46) {
      if (octetCount === 0) {
        a = (octet << 8);
      } else if (octetCount === 1) {
        a |= octet;
      } else if (octetCount === 2) {
        b = (octet << 8);
      } else {
        return -1;
      }
      octetCount++;
      octet = 0;
      continue;
    }
    return -1;
  }
  if (octetCount === 0) {
    a = (octet << 8);
  } else if (octetCount === 1) {
    a |= octet;
  } else if (octetCount === 2) {
    b = (octet << 8);
  } else if (octetCount === 3) {
    b |= octet;
  } else {
    return -1;
  }
  octetCount++;
  if (octetCount !== 4) return -1;
  if (segIndex + 1 >= 8) return -1;
  segs[segIndex] = a;
  segs[segIndex + 1] = b;
  return segIndex + 2;
};

const ipv6ToParts = (ip) => {
  let addr = ip;
  let end = addr.length;
  for (let i = 0; i < addr.length; i++) {
    const code = addr.charCodeAt(i);
    if (code === 47 || code === 37) {
      end = i;
      break;
    }
  }
  const len = end;
  const segs = IPV6_SCRATCH_SEGMENTS;

  if (len === 39) {
    if (addr[4] === ":" && addr[9] === ":" && addr[14] === ":" && addr[19] === ":" && addr[24] === ":" && addr[29] === ":" && addr[34] === ":") {
      for (let i = 0; i < 8; i++) {
        const o = IPV6_EXPANDED_OFFSETS[i];
        const c0 = addr.charCodeAt(o);
        const c1 = addr.charCodeAt(o + 1);
        const c2 = addr.charCodeAt(o + 2);
        const c3 = addr.charCodeAt(o + 3);
        if (c0 > 127 || c1 > 127 || c2 > 127 || c3 > 127) return null;
        const n0 = HEX_TABLE[c0];
        const n1 = HEX_TABLE[c1];
        const n2 = HEX_TABLE[c2];
        const n3 = HEX_TABLE[c3];
        if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0) return null;
        segs[i] = (n0 << 12) | (n1 << 8) | (n2 << 4) | n3;
      }
      IPV6_SCRATCH_PARTS[0] = ((segs[0] << 16) | segs[1]) >>> 0;
      IPV6_SCRATCH_PARTS[1] = ((segs[2] << 16) | segs[3]) >>> 0;
      IPV6_SCRATCH_PARTS[2] = ((segs[4] << 16) | segs[5]) >>> 0;
      IPV6_SCRATCH_PARTS[3] = ((segs[6] << 16) | segs[7]) >>> 0;
      return IPV6_SCRATCH_PARTS;
    }
  }

  let segIndex = 0;
  let segValue = 0;
  let segDigits = 0;
  let doubleColonIndex = -1;
  let segmentStart = 0;

  for (let i = 0; i < len; i++) {
    const code = addr.charCodeAt(i);
    if (code === 58) {
      if (i + 1 < len && addr.charCodeAt(i + 1) === 58) {
        if (doubleColonIndex !== -1) return null;
        if (segDigits > 0) {
          segs[segIndex++] = segValue;
          segValue = 0;
          segDigits = 0;
        }
        doubleColonIndex = segIndex;
        i++;
        segmentStart = i + 1;
      } else {
        if (segDigits === 0) return null;
        segs[segIndex++] = segValue;
        segValue = 0;
        segDigits = 0;
        segmentStart = i + 1;
      }
      if (segIndex > 8) return null;
      continue;
    }

    if (code === 46) {
      const newIndex = parseIpv4Tail(addr, segmentStart, len, segs, segIndex);
      if (newIndex < 0) return null;
      segIndex = newIndex;
      segValue = 0;
      segDigits = 0;
      i = len;
      break;
    }

    if (code > 127) return null;
    const nibble = HEX_TABLE[code];
    if (nibble < 0) return null;
    segValue = (segValue << 4) | nibble;
    segDigits++;
    if (segDigits > 4) return null;
  }

  if (segDigits > 0) {
    segs[segIndex++] = segValue;
  }

  if (doubleColonIndex !== -1) {
    const missing = 8 - segIndex;
    if (missing < 0) return null;
    for (let i = segIndex - 1; i >= doubleColonIndex; i--) {
      segs[i + missing] = segs[i];
    }
    for (let i = doubleColonIndex; i < doubleColonIndex + missing; i++) {
      segs[i] = 0;
    }
    segIndex += missing;
  }

  if (segIndex !== 8) return null;

  IPV6_SCRATCH_PARTS[0] = ((segs[0] << 16) | segs[1]) >>> 0;
  IPV6_SCRATCH_PARTS[1] = ((segs[2] << 16) | segs[3]) >>> 0;
  IPV6_SCRATCH_PARTS[2] = ((segs[4] << 16) | segs[5]) >>> 0;
  IPV6_SCRATCH_PARTS[3] = ((segs[6] << 16) | segs[7]) >>> 0;
  return IPV6_SCRATCH_PARTS;
};

const ipv6CidrToRange = (cidr) => {
  const [baseIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const parts = ipv6ToParts(baseIp);
  if (!parts) return null;
  const start = [parts[0], parts[1], parts[2], parts[3]];
  const end = [parts[0], parts[1], parts[2], parts[3]];

  for (let i = 0; i < 4; i++) {
    const bitStart = i * 32;
    const bitEnd = bitStart + 32;
    if (prefix >= bitEnd) continue;
    if (prefix <= bitStart) {
      start[i] = 0;
      end[i] = 0xFFFFFFFF;
      continue;
    }
    const bits = prefix - bitStart;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    start[i] = start[i] & mask;
    end[i] = start[i] | (~mask >>> 0);
  }

  return { start, end };
};

const compareLow96 = (aHi, aMid, aLo, bHi, bMid, bLo) => {
  if (aHi !== bHi) return aHi < bHi ? -1 : 1;
  if (aMid !== bMid) return aMid < bMid ? -1 : 1;
  if (aLo !== bLo) return aLo < bLo ? -1 : 1;
  return 0;
};

const lowAddOne = (hi, mid, lo) => {
  if (lo !== 0xFFFFFFFF) return [hi, mid, (lo + 1) >>> 0];
  if (mid !== 0xFFFFFFFF) return [hi, (mid + 1) >>> 0, 0];
  return [(hi + 1) >>> 0, 0, 0];
};

const compare128 = (a0, a1, a2, a3, b0, b1, b2, b3) => {
  if (a0 !== b0) return a0 < b0 ? -1 : 1;
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
};

const addOne128 = (p0, p1, p2, p3) => {
  if (p3 !== 0xFFFFFFFF) return [p0, p1, p2, (p3 + 1) >>> 0];
  if (p2 !== 0xFFFFFFFF) return [p0, p1, (p2 + 1) >>> 0, 0];
  if (p1 !== 0xFFFFFFFF) return [p0, (p1 + 1) >>> 0, 0, 0];
  return [(p0 + 1) >>> 0, 0, 0, 0];
};

const mergeRanges128 = (ranges) => {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => {
    const c = compare128(a.start[0], a.start[1], a.start[2], a.start[3], b.start[0], b.start[1], b.start[2], b.start[3]);
    if (c !== 0) return c;
    const c2 = compare128(a.end[0], a.end[1], a.end[2], a.end[3], b.end[0], b.end[1], b.end[2], b.end[3]);
    if (c2 !== 0) return c2;
    return 0;
  });
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const cur = ranges[i];
    const last = merged[merged.length - 1];
    const next = addOne128(last.end[0], last.end[1], last.end[2], last.end[3]);
    if (compare128(cur.start[0], cur.start[1], cur.start[2], cur.start[3], next[0], next[1], next[2], next[3]) > 0) {
      merged.push(cur);
    } else if (compare128(cur.end[0], cur.end[1], cur.end[2], cur.end[3], last.end[0], last.end[1], last.end[2], last.end[3]) > 0) {
      last.end = cur.end;
    }
  }
  return merged;
};

const META_HASH_MULT = 2654435761;

const buildMetaTable = (entries) => {
  const count = entries.length;
  const keys = new Uint32Array(count);
  const types = new Uint8Array(count);
  const offsets = new Uint32Array(count);
  const counts = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    keys[i] = entry.key >>> 0;
    types[i] = entry.type;
    offsets[i] = entry.offset >>> 0;
    counts[i] = entry.count >>> 0;
  }
  let tableSize = 1;
  const target = Math.max(4, Math.ceil(count * 1.3));
  while (tableSize < target) tableSize <<= 1;
  const table = new Uint32Array(tableSize);
  const mask = tableSize - 1;
  for (let i = 0; i < count; i++) {
    let slot = (Math.imul(keys[i], META_HASH_MULT) >>> 0) & mask;
    while (table[slot] !== 0) slot = (slot + 1) & mask;
    table[slot] = i + 1;
  }
  return { keys, types, offsets, counts, table, mask };
};

const metaLookup = (index, p0) => {
  const table = index.metaTable;
  if (!table || table.length === 0) return -1;
  const mask = index.metaMask;
  const keys = index.metaKeys;
  let slot = (Math.imul(p0, META_HASH_MULT) >>> 0) & mask;
  while (true) {
    const stored = table[slot];
    if (stored === 0) return -1;
    const idx = stored - 1;
    if (keys[idx] === p0) return idx;
    slot = (slot + 1) & mask;
  }
};

const buildSuperRanges = (superRanges) => {
  if (!superRanges.length) return [];
  const ranges = superRanges.slice();
  ranges.sort((a, b) => compare128(a.start[0], a.start[1], a.start[2], a.start[3], b.start[0], b.start[1], b.start[2], b.start[3]));
  return ranges;
};

const containsSuperRange = (ranges, p0, p1, p2, p3) => {
  if (!ranges.length) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (compare128(range.start[0], range.start[1], range.start[2], range.start[3], p0, p1, p2, p3) <= 0) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return false;
  const range = ranges[idx];
  return compare128(p0, p1, p2, p3, range.end[0], range.end[1], range.end[2], range.end[3]) <= 0;
};

const buildIpv6IndexFromCidrs = (cidrs) => {
  const ranges = [];
  for (let i = 0; i < cidrs.length; i++) {
    const range = ipv6CidrToRange(cidrs[i]);
    if (range) ranges.push(range);
  }
  const merged = mergeRanges128(ranges);

  const bucketMap = new Map();
  const fullBuckets = new Set();
  const superRanges = [];

  for (let i = 0; i < merged.length; i++) {
    const range = merged[i];
    if (range.start[0] !== range.end[0]) {
      superRanges.push(range);
      continue;
    }
    const high = range.start[0] >>> 0;
    if (fullBuckets.has(high)) continue;
    const lowStart = range.start;
    const lowEnd = range.end;
    const isFull = lowStart[1] === 0 && lowStart[2] === 0 && lowStart[3] === 0 &&
      lowEnd[1] === 0xFFFFFFFF && lowEnd[2] === 0xFFFFFFFF && lowEnd[3] === 0xFFFFFFFF;
    if (isFull) {
      fullBuckets.add(high);
      bucketMap.delete(high);
      continue;
    }
    let list = bucketMap.get(high);
    if (!list) {
      list = [];
      bucketMap.set(high, list);
    }
    list.push([lowStart[1], lowStart[2], lowStart[3], lowEnd[1], lowEnd[2], lowEnd[3]]);
  }

  let total = 0;
  for (const [high, list] of bucketMap.entries()) {
    list.sort((a, b) => compareLow96(a[0], a[1], a[2], b[0], b[1], b[2]));
    const mergedLow = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const cur = list[i];
      const last = mergedLow[mergedLow.length - 1];
      const [endHi, endMid, endLo] = [last[3], last[4], last[5]];
      const [nextHi, nextMid, nextLo] = lowAddOne(endHi, endMid, endLo);
      if (compareLow96(cur[0], cur[1], cur[2], nextHi, nextMid, nextLo) > 0) {
        mergedLow.push(cur);
      } else if (compareLow96(cur[3], cur[4], cur[5], endHi, endMid, endLo) > 0) {
        last[3] = cur[3];
        last[4] = cur[4];
        last[5] = cur[5];
      }
    }
    total += mergedLow.length;
    bucketMap.set(high, mergedLow);
  }

  const startsHi = new Uint32Array(total);
  const startsMid = new Uint32Array(total);
  const startsLo = new Uint32Array(total);
  const endsHi = new Uint32Array(total);
  const endsMid = new Uint32Array(total);
  const endsLo = new Uint32Array(total);

  const metaEntries = [];
  let cursor = 0;
  for (const [high, list] of bucketMap.entries()) {
    metaEntries.push({ key: high, type: 2, offset: cursor, count: list.length });
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      startsHi[cursor] = row[0];
      startsMid[cursor] = row[1];
      startsLo[cursor] = row[2];
      endsHi[cursor] = row[3];
      endsMid[cursor] = row[4];
      endsLo[cursor] = row[5];
      cursor++;
    }
  }

  for (const high of fullBuckets) {
    metaEntries.push({ key: high, type: 1, offset: 0, count: 0 });
  }

  const metaTableInfo = buildMetaTable(metaEntries);

  return {
    metaKeys: metaTableInfo.keys,
    metaTypes: metaTableInfo.types,
    metaOffsets: metaTableInfo.offsets,
    metaCounts: metaTableInfo.counts,
    metaTable: metaTableInfo.table,
    metaMask: metaTableInfo.mask,
    startsHi,
    startsMid,
    startsLo,
    endsHi,
    endsMid,
    endsLo,
    superRanges: buildSuperRanges(superRanges),
  };
};

const containsIpv6Parts = (index, p0, p1, p2, p3) => {
  p0 >>>= 0;
  p1 >>>= 0;
  p2 >>>= 0;
  p3 >>>= 0;

  if (containsSuperRange(index.superRanges, p0, p1, p2, p3)) return true;

  const metaIndex = metaLookup(index, p0);
  if (metaIndex < 0) return false;
  if (index.metaTypes[metaIndex] === 1) return true;
  const offset = index.metaOffsets[metaIndex];
  const count = index.metaCounts[metaIndex];
  let lo = 0;
  let hi = count - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const startHi = index.startsHi[offset + mid];
    const startMid = index.startsMid[offset + mid];
    const startLo = index.startsLo[offset + mid];
    if (compareLow96(startHi, startMid, startLo, p1, p2, p3) <= 0) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return false;
  const endHi = index.endsHi[offset + idx];
  const endMid = index.endsMid[offset + idx];
  const endLo = index.endsLo[offset + idx];
  return compareLow96(p1, p2, p3, endHi, endMid, endLo) <= 0;
};

let ipv4Index = buildIpv4IndexFromCidrs([]);
let ipv6Index = buildIpv6IndexFromCidrs([]);

async function updateList() {
  const timeoutMs = 20000;
  const ipv4CidrRanges = await fetch(IPV4_LIST_URL, { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.text()).then(t => t.trim().split("\n"));
  const ipv6CidrRanges = await fetch(IPV6_LIST_URL, { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.text()).then(t => t.trim().split("\n"));
  ipv4Index = buildIpv4IndexFromCidrs(ipv4CidrRanges);
  ipv6Index = buildIpv6IndexFromCidrs(ipv6CidrRanges);
}

await updateList();
setInterval(updateList, 1000 * 60 * 60 * 12);

const isVpnV4 = (ip) => {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return containsIpv4(ipv4Index, ipInt);
};

const isVpnV6 = (ip) => {
  const parts = ipv6ToParts(ip);
  if (!parts) return false;
  return containsIpv6Parts(ipv6Index, parts[0], parts[1], parts[2], parts[3]);
};

export const isVpn = (ip) => {
  for (let i = 0; i < ip.length; i++) {
    const code = ip.charCodeAt(i);
    if (code === 58) return isVpnV6(ip);
    if (code === 46) return isVpnV4(ip);
    if (code === 47 || code === 37) break;
  }
  return false;
};
