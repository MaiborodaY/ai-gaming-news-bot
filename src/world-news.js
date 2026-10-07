import {
  createEditorialNewsTelegramOptions,
  formatEditorialNewsPost,
  getZagrebDateTime
} from './croatia-news.js';

export const WORLD_NEWS_SOURCES = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'France 24', url: 'https://www.france24.com/en/rss' }
];

export function getWorldNewsSlot(value) {
  const time = getZagrebDateTime(value);
  if (!time || time.hour !== 11) {
    return null;
  }
  return { date: time.date, hour: 11, label: '11:00' };
}

export function isOfficialWorldNewsLink(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && ['bbc.co.uk', 'bbc.com', 'france24.com']
      .some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function worldNewsItemKey(link) {
  if (!isOfficialWorldNewsLink(link)) {
    return null;
  }
  const url = new URL(link.trim());
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `world-news:item:${url.toString()}`;
}

export function worldNewsSlotKey(slot) {
  return slot?.date && slot.hour === 11 ? `world-news:slot:${slot.date}:11` : null;
}

export function formatWorldNewsPost(selection, item) {
  return formatEditorialNewsPost(selection, item, {
    icon: '🌍', isOfficialLink: isOfficialWorldNewsLink, fallbackSource: 'Новости мира'
  });
}

export function createWorldNewsTelegramOptions(link) {
  return createEditorialNewsTelegramOptions(link, isOfficialWorldNewsLink);
}
