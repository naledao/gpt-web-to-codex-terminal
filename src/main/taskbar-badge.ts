import { deflateSync } from 'node:zlib'
import { nativeImage } from 'electron'

const digits: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
}

function pngChunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  payload.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

/** Windows taskbar overlay: red badge with a white unread-completion count. */
export function taskbarCountIcon(count: number): Electron.NativeImage {
  const size = 32
  const label = String(Math.min(99, Math.max(1, Math.floor(count))))
  const scale = label.length === 1 ? 4 : 3
  const textWidth = label.length * 3 * scale + (label.length - 1) * scale
  const textX = Math.floor((size - textWidth) / 2)
  const textY = Math.floor((size - 5 * scale) / 2)
  const rowBytes = size * 4 + 1
  const pixels = Buffer.alloc(size * rowBytes)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let samples = 0
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
        if ((x + dx - 16) ** 2 + (y + dy - 16) ** 2 <= 15.5 ** 2) samples++
      }
      const offset = y * rowBytes + 1 + x * 4
      pixels[offset] = 224
      pixels[offset + 1] = 50
      pixels[offset + 2] = 65
      pixels[offset + 3] = Math.round(samples * 255 / 4)
    }
  }

  for (let i = 0; i < label.length; i++) {
    const glyph = digits[label[i]]
    for (let y = 0; y < glyph.length; y++) for (let x = 0; x < 3; x++) {
      if (glyph[y][x] !== '1') continue
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = textX + i * 4 * scale + x * scale + sx
        const py = textY + y * scale + sy
        const offset = py * rowBytes + 1 + px * 4
        pixels[offset] = 255
        pixels[offset + 1] = 255
        pixels[offset + 2] = 255
        pixels[offset + 3] = 255
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return nativeImage.createFromBuffer(png)
}