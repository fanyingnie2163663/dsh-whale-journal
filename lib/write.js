// 写一条日记的编排层：净化简笔画 → 导入照片 → 落库。
// 坏素材只记录到 dropped，不阻断正文——写日记不该因为一张画或一张照片失败。

import { sanitizeDoodle } from './sanitize.js';
import { importPhoto } from './media.js';
import { MAX_PHOTOS, dayKey, isDateKey, normalizePhotoMeta, writeEntry } from './store.js';

export function writeJournal(cfg, args = {}, { now = Date.now() } = {}) {
  const date = args.date ? String(args.date).trim() : dayKey(now, cfg.timezone);
  if (!isDateKey(date)) throw new Error('date 必须是 YYYY-MM-DD');

  const dropped = { doodle: null, photos: [] };

  let doodle = null;
  if (args.doodle !== undefined && args.doodle !== null) {
    const result = sanitizeDoodle(args.doodle);
    if (result.ok) doodle = result.value;
    else dropped.doodle = result.reason;
  }

  const photos = [];
  const rawPhotos = Array.isArray(args.photos) ? args.photos : [];
  for (const raw of rawPhotos) {
    if (photos.length >= MAX_PHOTOS) {
      dropped.photos.push({ path: String(raw?.path ?? ''), reason: `最多 ${MAX_PHOTOS} 张` });
      continue;
    }
    try {
      const imported = importPhoto(cfg.dir, raw?.path, { date });
      photos.push(normalizePhotoMeta({
        file: imported.file,
        anchor: raw?.anchor,
        side: raw?.side,
        caption: raw?.caption
      }));
    } catch (error) {
      dropped.photos.push({ path: String(raw?.path ?? ''), reason: error.message });
    }
  }

  const { entry, remaining } = writeEntry(cfg.dir, {
    text: args.text,
    scope: args.scope,
    date,
    mood: args.mood,
    refs: args.refs,
    ...(doodle ? { doodle } : {}),
    ...(photos.length ? { photos } : {})
  }, {
    timeZone: cfg.timezone,
    maxChars: cfg.maxEntryChars,
    maxEntriesPerDay: cfg.maxEntriesPerDay,
    source: 'agent',
    now
  });

  return { entry, remaining, dropped };
}
