// zip.mjs — write a .zip from a directory with only Node built-ins (deflate
// via zlib). Store-compatible readers everywhere: PowerShell's Expand-Archive,
// Windows Explorer, unzip, bsdtar. No zip64, so entries must stay under 4 GB.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}
function* walk(dir, base = dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full, base);
		else if (entry.isFile()) yield { full, name: relative(base, full).split("\\").join("/") };
	}
}

/** Zip `dir` into `outFile`, with every entry prefixed by `rootName/`. Returns the file's sha256. */
export function zipDirectory(dir, outFile, rootName) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	const { time, date } = dosDateTime(new Date());
	for (const { full, name } of walk(dir)) {
		const data = readFileSync(full);
		const packed = deflateRawSync(data, { level: 9 });
		const entryName = Buffer.from(`${rootName}/${name}`, "utf8");
		const crc = crc32(data);
		const mode = statSync(full).mode;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4); // version needed
		header.writeUInt16LE(0x0800, 6); // utf-8 names
		header.writeUInt16LE(8, 8); // deflate
		header.writeUInt16LE(time, 10);
		header.writeUInt16LE(date, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(packed.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(entryName.length, 26);
		header.writeUInt16LE(0, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4); // made by: unix, so the mode bits below are honoured
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(packed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(entryName.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38); // external attrs
		central.writeUInt32LE(offset, 42);
		locals.push(header, entryName, packed);
		centrals.push(central, entryName);
		offset += header.length + entryName.length + packed.length;
	}
	const centralStart = offset;
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(centrals.length / 2, 8);
	eocd.writeUInt16LE(centrals.length / 2, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(centralStart, 16);
	eocd.writeUInt16LE(0, 20);
	const out = Buffer.concat([...locals, centralBuf, eocd]);
	writeFileSync(outFile, out);
	return createHash("sha256").update(out).digest("hex");
}
