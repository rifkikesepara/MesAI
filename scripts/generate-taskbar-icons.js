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
    const angle = Math.atan2(dy, dx);
    if ((angle > 0.3 && angle < 1.3) || (angle < -1.8 && angle > -2.8)) {
      return [0, 0, 0, 0];
    }
    return [148, 163, 184, 255];
  }
  if ((x >= 16 && x <= 20 && y >= 7 && y <= 11) || (x >= 3 && x <= 7 && y >= 13 && y <= 17)) {
    return [148, 163, 184, 255];
  }
  return [0, 0, 0, 0];
});
fs.writeFileSync(path.join(assetsDir, 'thumbar-sync.png'), thumbarSync);

// Helper to decode existing tray-icon.png
function decodePng(buffer) {
  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.slice(offset + 8, offset + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idatChunks.push(data);
    offset += 12 + len;
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowOffset = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let val = raw[rowOffset + x];
      if (filter === 1) val += a;
      else if (filter === 2) val += b;
      else if (filter === 3) val += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val += pr;
      }
      pixels[y * stride + x] = val & 0xFF;
    }
  }
  return { width, height, pixels };
}

const baseTrayPath = path.join(assetsDir, 'tray-icon.png');
if (fs.existsSync(baseTrayPath)) {
  const { width, height, pixels } = decodePng(fs.readFileSync(baseTrayPath));

  // 6. Tray Active: full vibrant color base icon + green dot at bottom right (cx=23, cy=23, r=7.0)
  const trayActive = createPng(width, height, (x, y) => {
    const dx = x - 23;
    const dy = y - 23;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 7.0) {
      if (dist > 5.6) return [15, 23, 42, 255]; // dark ring border #0f172a
      if (dist > 4.4) return [255, 255, 255, 255]; // white ring
      return [16, 185, 129, 255]; // emerald-500 #10b981
    }
    const idx = (y * width + x) * 4;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
  });
  fs.writeFileSync(path.join(assetsDir, 'tray-icon-active.png'), trayActive);

  // 7. Tray Paused: grayscale/dimmed base icon + high-contrast amber pause badge (cx=23, cy=23, r=7.5)
  const trayPaused = createPng(width, height, (x, y) => {
    const dx = x - 23;
    const dy = y - 23;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 7.5) {
      if (dist > 6.0) return [15, 23, 42, 255]; // dark outer ring border
      if (dist > 4.8) return [255, 255, 255, 255]; // white ring
      // Pause bars inside badge
      if (y >= 20 && y <= 26) {
        if ((x >= 20 && x <= 21) || (x >= 24 && x <= 25)) {
          return [255, 255, 255, 255]; // bold white pause bars
        }
      }
      return [249, 115, 22, 255]; // vivid orange #f97316
    }
    const idx = (y * width + x) * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];
    if (a === 0) return [0, 0, 0, 0];
    // Convert base icon to dimmed grayscale
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const dimmedGray = Math.round(gray * 0.45);
    return [dimmedGray, dimmedGray, dimmedGray, Math.round(a * 0.7)];
  });
  fs.writeFileSync(path.join(assetsDir, 'tray-icon-paused.png'), trayPaused);
}

console.log('Generated taskbar and tray icons successfully.');
