const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function createPng(width, height, getPixel) {
  const rowLen = width * 4 + 1;
  const raw = Buffer.alloc(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // Filter: none
    for (let x = 0; x < width; x++) {
      const idx = y * rowLen + 1 + x * 4;
      const [r, g, b, a] = getPixel(x, y, width, height);
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    let c = 0xFFFFFFFF;
    for (let i = 0; i < combined.length; i++) {
      c = crcTable[(c ^ combined[i]) & 0xFF] ^ (c >>> 8);
    }
    crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }

  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

const assetsDir = path.resolve(__dirname, '../assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// 1. Overlay Active: 16x16 vibrant green dot with white ring border
const overlayActive = createPng(16, 16, (x, y) => {
  const dx = x - 7.5;
  const dy = y - 7.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 7.5) return [0, 0, 0, 0];
  if (dist > 6.0) return [255, 255, 255, Math.floor(Math.max(0, 7.5 - dist) * 170)];
  if (dist > 5.0) return [255, 255, 255, 255]; // white border
  // Emerald green fill (#10b981)
  return [16, 185, 129, 255];
});
fs.writeFileSync(path.join(assetsDir, 'overlay-active.png'), overlayActive);

// 2. Overlay Paused: 16x16 amber/orange circle with white pause bars
const overlayPaused = createPng(16, 16, (x, y) => {
  const dx = x - 7.5;
  const dy = y - 7.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 7.5) return [0, 0, 0, 0];
  if (dist > 6.0) return [255, 255, 255, Math.floor(Math.max(0, 7.5 - dist) * 170)];
  if (dist > 5.0) return [255, 255, 255, 255]; // white border
  // Pause bars in center
  if (y >= 4 && y <= 11) {
    if ((x >= 5 && x <= 6) || (x >= 9 && x <= 10)) {
      return [255, 255, 255, 255]; // white bars
    }
  }
  // Amber-500 fill (#f59e0b)
  return [245, 158, 11, 255];
});
fs.writeFileSync(path.join(assetsDir, 'overlay-paused.png'), overlayPaused);

// 3. Thumbar Play: 24x24 clean play triangle
const thumbarPlay = createPng(24, 24, (x, y) => {
  // Triangle pointing right: (6, 4) to (19, 12) to (6, 20)
  if (x >= 6 && x <= 19) {
    const halfH = (x - 6) * (8 / 13);
    const top = 12 - halfH;
    const bottom = 12 + halfH;
    if (y >= top - 0.5 && y <= bottom + 0.5) {
      // Emerald / white
      return [52, 211, 153, 255];
    }
  }
  return [0, 0, 0, 0];
});
fs.writeFileSync(path.join(assetsDir, 'thumbar-play.png'), thumbarPlay);

// 4. Thumbar Pause: 24x24 clean pause symbol
const thumbarPause = createPng(24, 24, (x, y) => {
  if (y >= 5 && y <= 19) {
    if ((x >= 6 && x <= 10) || (x >= 14 && x <= 18)) {
      // Amber / white
      return [251, 191, 36, 255];
    }
  }
  return [0, 0, 0, 0];
});
fs.writeFileSync(path.join(assetsDir, 'thumbar-pause.png'), thumbarPause);

// 5. Thumbar Sync / Refresh: 24x24 circular arrows
const thumbarSync = createPng(24, 24, (x, y) => {
  const dx = x - 11.5;
  const dy = y - 11.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= 6.5 && dist <= 9.5) {
    // Gap in ring top-right and bottom-left
    const angle = Math.atan2(dy, dx);
    if ((angle > 0.3 && angle < 1.3) || (angle < -1.8 && angle > -2.8)) {
      return [0, 0, 0, 0];
    }
    return [148, 163, 184, 255]; // slate-400
  }
  // Arrow heads
  if ((x >= 16 && x <= 20 && y >= 7 && y <= 11) || (x >= 3 && x <= 7 && y >= 13 && y <= 17)) {
    return [148, 163, 184, 255];
  }
  return [0, 0, 0, 0];
});
fs.writeFileSync(path.join(assetsDir, 'thumbar-sync.png'), thumbarSync);

console.log('Generated taskbar and thumbar icons successfully.');
