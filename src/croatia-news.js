export const CROATIA_NEWS_CRON_EXPRESSION = '0 8,9,11,12,14,15,17,18 * * *';

const CROATIA_NEWS_HOURS = new Set([10, 13, 16, 19]);
const RIJEKA_NEWS_HOUR = 16;
const ZAGREB_TIME_ZONE = 'Europe/Zagreb';
const HOUR_MS = 60 * 60 * 1000;

const zagrebDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZAGREB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function getZagrebDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = Object.fromEntries(
    zagrebDateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function createSlot(zagrebTime, includeMinutes) {
  const minute = includeMinutes ? zagrebTime.minute : 0;
  return {
    date: zagrebTime.date,
    hour: zagrebTime.hour,
    label: `${String(zagrebTime.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

export function getCroatiaNewsSlot(value) {
  const zagrebTime = getZagrebDateTime(value);
  if (!zagrebTime || !CROATIA_NEWS_HOURS.has(zagrebTime.hour)) {
    return null;
  }

  return createSlot(zagrebTime, false);
}

export function getCroatiaNewsTestSlot(value) {
  const zagrebTime = getZagrebDateTime(value);
  return zagrebTime ? createSlot(zagrebTime, true) : null;
}

export function isRijekaNewsSlot(slot) {
  return slot?.hour === RIJEKA_NEWS_HOUR;
}

export function isOfficialHrtLink(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && (url.hostname === 'hrt.hr' || url.hostname.endsWith('.hrt.hr'));
  } catch {
    return false;
  }
}

export function isOfficialCroatiaNewsLink(link) {
  if (isOfficialHrtLink(link)) {
    return true;
  }

  try {
    const url = new URL(link);
    return url.protocol === 'https:' && (url.hostname === 'rijeka.hr' || url.hostname.endsWith('.rijeka.hr'));
  } catch {
    return false;
  }
}

export function normalizeCroatiaNewsLink(link) {
  if (!isOfficialCroatiaNewsLink(link)) {
    return '';
  }

  const url = new URL(link.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export function isFreshCroatiaNews(item, now = Date.now(), maxAgeHours = 18) {
  const publishedAt = Date.parse(item?.publishedAt || '');
  const nowTimestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(publishedAt) || Number.isNaN(nowTimestamp)) {
    return false;
  }

  const ageMs = nowTimestamp - publishedAt;
  return ageMs >= -HOUR_MS && ageMs <= maxAgeHours * HOUR_MS;
}

export function cleanCroatiaFeedText(value = '') {
  return String(value)
    .replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .replace(/\s+Post\s+.+?\s+je prvi puta viđen na\s+Grad Rijeka\s*\.?\s*$/i, '')
    .trim()
    .slice(0, 1200);
}

function cleanGeneratedText(value, maxLength) {
  return String(value || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function escapeTelegramHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function parseCroatiaNewsSelection(text, candidateCount) {
  if (!text || !Number.isInteger(candidateCount) || candidateCount < 1) {
    return null;
  }

  try {
    const parsed = JSON.parse(String(text).replace(/```(?:json)?/gi, '').trim());
    if (parsed.selected === false && parsed.index === 0) {
      return { selected: false };
    }

    if (parsed.selected !== true || !Number.isInteger(parsed.index) || parsed.index < 1 || parsed.index > candidateCount) {
      return null;
    }

    const headline = cleanGeneratedText(parsed.headline, 140);
    const summary = cleanGeneratedText(parsed.summary, 650);
    if (!headline || !summary) {
      return null;
    }

    return {
      selected: true,
      index: parsed.index,
      headline,
      summary
    };
  } catch {
    return null;
  }
}

export function formatCroatiaNewsPost(selection, item, { isRijeka = false } = {}) {
  if (!selection?.selected || !isOfficialCroatiaNewsLink(item?.link)) {
    return null;
  }

  const headline = cleanGeneratedText(selection.headline, 140);
  const summary = cleanGeneratedText(selection.summary, 650);
  const link = escapeTelegramHtml(item.link.trim());
  const source = escapeTelegramHtml(item.source || 'HRT');
  if (!headline || !summary) {
    return null;
  }

  const icon = isRijeka ? '🌊' : '🇭🇷';
  return `${icon} <a href="${link}">${escapeTelegramHtml(headline)}</a>\n\n${escapeTelegramHtml(summary)}\n\n<a href="${link}">Источник: ${source}</a>`;
}

export function createCroatiaNewsTelegramOptions(link) {
  if (!isOfficialCroatiaNewsLink(link)) {
    return null;
  }

  return {
    parse_mode: 'HTML',
    link_preview_options: {
      is_disabled: false,
      url: link,
      prefer_large_media: true,
      show_above_text: true
    }
  };
}

export function croatiaNewsItemKey(link) {
  const normalizedLink = normalizeCroatiaNewsLink(link);
  return normalizedLink ? `croatia-news:item:${normalizedLink}` : null;
}

export function croatiaNewsSlotKey(slot) {
  if (!slot?.date || !Number.isInteger(slot.hour)) {
    return null;
  }

  return `croatia-news:slot:${slot.date}:${slot.hour}`;
}
