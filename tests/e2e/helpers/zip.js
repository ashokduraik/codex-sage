import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-project');

/**
 * Encodes a 16-bit little-endian integer.
 *
 * @param {number} value Unsigned 16-bit value.
 * @returns {Buffer} Two-byte buffer.
 */
function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

/**
 * Encodes a 32-bit little-endian integer.
 *
 * @param {number} value Unsigned 32-bit value.
 * @returns {Buffer} Four-byte buffer.
 */
function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

/**
 * Builds a store-only ZIP (no compression) so E2E does not need a zip library.
 *
 * @param {Array<{ name: string, data: Buffer | string }>} entries Archive members.
 * @returns {Buffer} ZIP bytes.
 */
export function buildStoreZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const endOfCentral = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDirectory, endOfCentral]);
}

/**
 * Writes a sample-project ZIP to a temp file for Playwright `setInputFiles`.
 *
 * @param {{ extraFiles?: Array<{ name: string, data: string }>, fileName?: string }} [options] Extra members.
 * @returns {Promise<string>} Absolute ZIP path.
 */
export async function writeSampleProjectZip(options = {}) {
  const hello = await readFile(join(fixturesRoot, 'src', 'hello.js'));
  const guide = await readFile(join(fixturesRoot, 'docs', 'guide.md'));
  const extra = Array.isArray(options.extraFiles) ? options.extraFiles : [];
  const zip = buildStoreZip([{ name: 'src/hello.js', data: hello }, { name: 'docs/guide.md', data: guide }, ...extra]);
  const directory = await mkdtemp(join(tmpdir(), 'codex-sage-e2e-'));
  const filePath = join(directory, options.fileName ?? 'sample-project.zip');
  await writeFile(filePath, zip);
  return filePath;
}

/**
 * Writes a second ZIP with an added file so Changes shows path diffs.
 *
 * @returns {Promise<string>} Absolute ZIP path.
 */
export async function writeSampleProjectZipWithExtraFile() {
  return writeSampleProjectZip({
    fileName: 'sample-project-v2.zip',
    extraFiles: [{ name: 'src/extra.js', data: "export const extra = 'codexSageE2eExtra';\n" }],
  });
}

/**
 * Writes a non-ZIP text file for the reject-non-zip path.
 *
 * @returns {Promise<string>} Absolute file path.
 */
export async function writeNonZipUpload() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-sage-e2e-'));
  const filePath = join(directory, 'not-a-zip.txt');
  await writeFile(filePath, 'not a zip');
  return filePath;
}
