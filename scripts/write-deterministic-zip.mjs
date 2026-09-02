#!/usr/bin/env node
// A byte-identical archive, so what ships is diffable.
//
// Two sources of nondeterminism are removed deliberately: file order (sorted)
// and modification times (fixed). zlib's output also varies between Node major
// versions, so the archive is pinned to one — the release workflow uses the
// version named here and the check below refuses to build under another.

import { createWriteStream } from 'node:fs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const PINNED_NODE_MAJOR = 22;
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x2821; // 2020-01-01

const stage = process.argv[2];
const out = process.argv[3];
if (!stage || !out) {
  process.stderr.write('usage: write-deterministic-zip.mjs <stageDir> <out.zip>\n');
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major !== PINNED_NODE_MAJOR && !process.env.RUSHES_ALLOW_ANY_NODE) {
  process.stderr.write(
    `refusing to build under Node ${major}: zlib output differs between majors, ` +
    `so the archive would not be reproducible. Use Node ${PINNED_NODE_MAJOR}, ` +
    `or set RUSHES_ALLOW_ANY_NODE=1 to build a non-reproducible archive.\n`);
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(stage).sort();
const chunks = [];
const central = [];
let offset = 0;

for (const file of files) {
  const name = relative(stage, file).split('\\').join('/');
  const data = readFileSync(file);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(FIXED_DOS_TIME, 10);
  local.writeUInt16LE(FIXED_DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, compressed);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(FIXED_DOS_TIME, 12);
  dir.writeUInt16LE(FIXED_DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(compressed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  // `<< 16` on a mode this size produces a NEGATIVE 32-bit int in JS; the
  // unsigned shift is what makes it a valid external-attributes field.
  dir.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
  dir.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([dir, nameBuf]));

  offset += local.length + nameBuf.length + compressed.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const stream = createWriteStream(out);
for (const c of [...chunks, centralBuf, end]) stream.write(c);
stream.end();
stream.on('close', () => {
  process.stderr.write(`wrote ${out} (${files.length} files)\n`);
  void dirname;
});
