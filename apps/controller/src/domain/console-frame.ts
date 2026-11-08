import { deflateSync } from "node:zlib";
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** Windows Hyper-V RGB565 little-endian thumbnail; no third-party image dependency. */
export function rgb565Png(raw: Buffer, width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    width > 1024 ||
    height < 16 ||
    height > 768 ||
    raw.length !== width * height * 2
  )
    throw Error("Invalid console frame");
  const scan = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = raw.readUInt16LE((y * width + x) * 2),
        r = pixel >>> 11,
        g = (pixel >>> 5) & 63,
        b = pixel & 31;
      const i = y * (width * 3 + 1) + 1 + x * 3;
      scan[i] = (r << 3) | (r >>> 2);
      scan[i + 1] = (g << 2) | (g >>> 4);
      scan[i + 2] = (b << 3) | (b >>> 2);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scan)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
