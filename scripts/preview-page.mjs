// M2 预览：造一份临时日记（含简笔画 + 照片），起 /journal 页面看效果。
// 运行：node scripts/preview-page.mjs   → 打开打印出的 URL
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { writeEntry } from '../lib/store.js';
import { createJournalHandler } from '../lib/webserver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, '..', 'assets');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-preview-'));

// 极简 PNG 编码：一张日落照片，避免预览依赖外部图片。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}

function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const sunsetPng = makePng(120, 90, (x, y) => {
  const t = y / 90;
  let r = Math.round(248 - 40 * t);
  let g = Math.round(178 - 60 * t);
  let b = Math.round(106 - 20 * t);
  const d = Math.hypot(x - 84, y - 56);
  if (d < 12) [r, g, b] = [255, 230, 189];
  if (y > 64) [r, g, b] = [90, 64, 62];
  if (y > 76) [r, g, b] = [60, 44, 46];
  return [r, g, b];
});

fs.mkdirSync(path.join(dir, 'media', '2026-11-02'), { recursive: true });
fs.writeFileSync(path.join(dir, 'media', '2026-11-02', 'abcdef123456.png'), sunsetPng);

const sunset = `
<path d="M75 26 q-1 -8 6 -9 q9 -1 10 7 q1 9 -7 10 q-9 1 -9 -8"/>
<path d="M74 10 l-2 -6 M92 12 l4 -5 M100 26 l6 -1 M98 38 l5 3 M72 39 l-5 3 M66 28 h-6"/>
<path d="M6 51 C26 47 42 55 60 50 S94 54 116 49"/>
<path d="M14 60 q7 -3 13 0 t13 0 t13 0"/>
<path d="M30 69 q7 -3 13 0 t15 0"/>
<path d="M32 45 q7 7 18 2 l-5 7 h-11 z"/>
<path d="M41 45 l-1 -11"/>
<path d="M40 34 q10 6 11 11 h-11"/>
<path d="M96 15 q3 -4 6 0 q3 -4 6 0"/>`;

const cat = `
<path d="M35 39 q-1 -14 12 -14 q8 0 12 6 q3 4 2 10 q-1 9 -12 9 q-11 0 -14 -11 z"/>
<path d="M38 28 l-5 -10 l10 5"/>
<path d="M59 27 l6 -9 l-8 6"/>
<path d="M43 37 q3 2 5 0"/>
<path d="M52 37 q2 2 4 0"/>
<path d="M50 41 v2"/>
<path d="M47 44 q3 2 5 0"/>
<path d="M36 41 h-9 M36 45 h-8 M63 41 h9 M63 45 h7"/>
<path d="M42 50 q-7 14 2 16 h11 q8 -2 2 -16"/>
<path d="M60 65 q10 0 8 -11"/>
<path d="M45 66 v4 M55 66 v4"/>
<path d="M46 56 h5 M46 60 h5"/>`;

writeEntry(dir, {
  text: '今天群里聊到很晚。阿宁说她换了新工作，大家吵着要她请客，她发了个逃跑的表情。我没说话，只把这件事记住了。',
  scope: 'group:100000001',
  date: '2026-11-01',
  mood: '安静'
}, { now: Date.now() });

writeEntry(dir, {
  text: '今天群里聊到很晚。阿宁说她换了新工作，大家吵着要她请客。',
  scope: 'group:100000001',
  date: '2026-11-02',
  mood: '暖',
  doodle: { svg: sunset, anchor: '阿宁说她换了新工作', side: 'right' },
  photos: [{ file: 'media/2026-11-02/abcdef123456.png', anchor: '大家吵着要她请客', side: 'left', caption: '她发的晚霞' }]
}, { now: Date.now() });

writeEntry(dir, {
  text: '夜里又翻到白天的照片，她存下来了。她说要留着，等哪天想起来再看。我把这句也记下了。',
  scope: 'group:100000001',
  date: '2026-11-02',
  mood: '困'
}, { now: Date.now() });

writeEntry(dir, {
  text: '她问我是不是没睡好。我说没有。其实有。',
  scope: 'private:100000002',
  date: '2026-11-02',
  doodle: { svg: cat, anchor: '没睡好', side: 'left' }
}, { now: Date.now() });

const server = http.createServer(createJournalHandler({ dir, assetsDir }));
server.listen(4180, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:4180/journal?date=2026-11-02`);
  console.log(`journal dir: ${dir}`);
});

function shutdown() {
  server.close(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
