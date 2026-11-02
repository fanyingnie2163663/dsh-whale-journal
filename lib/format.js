// 工具输出的纯格式化：只把 entry 变成给模型看的短文本，不碰 dsh、不碰 IO。

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function artSummary(entry) {
  const parts = [];
  if (entry?.doodle) {
    const anchor = clip(entry.doodle.anchor, 24);
    parts.push(anchor ? `简笔画（锚点「${anchor}」）` : '简笔画');
  }
  const photos = Array.isArray(entry?.photos) ? entry.photos : [];
  if (photos.length) {
    const captions = photos
      .map((photo) => clip(photo?.caption, 16))
      .filter(Boolean);
    parts.push(`照片 ${photos.length} 张${captions.length ? `（${captions.join(' ')}）` : ''}`);
  }
  return parts.length ? `\n〔${parts.join(' · ')}〕` : '';
}

export function entryLine(entry) {
  const mood = entry.mood ? `（${entry.mood}）` : '';
  return `[${entry.date}] ${entry.scope}${mood}\n${entry.text}${artSummary(entry)}`;
}
