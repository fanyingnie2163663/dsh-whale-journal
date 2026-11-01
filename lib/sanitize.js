// 简笔画 SVG 净化：只放行「线条画」需要的标签和属性，拒绝脚本/事件/外链。
//
// 设计：整串必须由允许的标签与空白组成——不做宽松替换，避免把危险内容
// 「洗掉一部分」后继续渲染。任何不合规都返回 { ok:false, reason }，不抛错，
// 由调用方决定丢弃（写日记仍然成功）。

export const DOODLE_MAX_CHARS = 8000;
export const DOODLE_SIDES = ['left', 'right', 'inline'];

const ALLOWED_TAGS = new Set(['path', 'circle', 'line', 'polyline', 'polygon', 'ellipse']);
const ALLOWED_ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'transform', 'opacity'
]);
const NUMERIC_ATTRS = new Set(['cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2']);

const BAD_PATTERN = /(<script|<style|<image|<use|<foreignobject|on[a-z]+\s*=|href\s*=|javascript:|url\s*\()/i;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;
const POINTS = /^[0-9.,\s+-]+$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const TRANSFORM = /^(?:translate|rotate|scale)\(\s*[0-9.,\s+-]+\s*\)(?:\s+(?:translate|rotate|scale)\(\s*[0-9.,\s+-]+\s*\))*$/;
const LINE_CAP = /^(?:butt|round|square)$/;
const LINE_JOIN = /^(?:miter|round|bevel)$/;

function attrValueOk(name, value) {
  switch (name) {
    case 'd':
      return PATH_DATA.test(value);
    case 'points':
      return POINTS.test(value);
    case 'fill':
      return value === 'none' || HEX_COLOR.test(value);
    case 'stroke':
      return value === 'currentColor' || HEX_COLOR.test(value);
    case 'stroke-width': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0.5 && n <= 3;
    }
    case 'stroke-linecap':
      return LINE_CAP.test(value);
    case 'stroke-linejoin':
      return LINE_JOIN.test(value);
    case 'transform':
      return TRANSFORM.test(value);
    case 'opacity': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1;
    }
    default:
      return NUMERIC_ATTRS.has(name) && NUMERIC.test(value);
  }
}

function sanitizeSvg(input) {
  const src = String(input ?? '').trim();
  if (!src) return { ok: false, reason: 'svg 为空' };
  if (src.length > DOODLE_MAX_CHARS) return { ok: false, reason: 'svg 过长' };
  if (BAD_PATTERN.test(src)) return { ok: false, reason: 'svg 含不允许的内容' };

  const tagRe = /<([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z][\w:-]*\s*=\s*"[^"]*")*)\s*\/?>/g;
  const attrRe = /([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;
  const out = [];
  let cursor = 0;
  let match;

  while ((match = tagRe.exec(src)) !== null) {
    if (src.slice(cursor, match.index).trim()) {
      return { ok: false, reason: 'svg 含标签外的文本' };
    }
    const tag = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return { ok: false, reason: `不允许的标签 ${tag}` };

    const attrText = match[2] ?? '';
    const attrs = [];
    let attr;
    while ((attr = attrRe.exec(attrText)) !== null) {
      const name = attr[1].toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) return { ok: false, reason: `不允许的属性 ${name}` };
      if (!attrValueOk(name, attr[2])) return { ok: false, reason: `属性值非法 ${name}` };
      attrs.push(`${name}="${attr[2]}"`);
    }
    attrRe.lastIndex = 0;
    if (attrText.replace(attrRe, '').trim()) {
      return { ok: false, reason: '属性格式非法' };
    }
    attrRe.lastIndex = 0;

    out.push(`<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}/>`);
    cursor = match.index + match[0].length;
  }

  if (src.slice(cursor).trim()) return { ok: false, reason: 'svg 含标签外的文本' };
  if (out.length === 0) return { ok: false, reason: 'svg 没有可用图元' };
  return { ok: true, svg: out.join('') };
}

export function sanitizeDoodle(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'doodle 必须是对象' };
  }
  const svg = sanitizeSvg(input.svg);
  if (!svg.ok) return svg;

  const anchor = String(input.anchor ?? '').trim();
  if (!anchor || anchor.length > 80) {
    return { ok: false, reason: 'anchor 需要 1–80 字' };
  }
  const side = input.side === undefined ? 'right' : String(input.side);
  if (!DOODLE_SIDES.includes(side)) {
    return { ok: false, reason: 'side 只能是 left/right/inline' };
  }
  return { ok: true, value: { svg: svg.svg, anchor, side } };
}
