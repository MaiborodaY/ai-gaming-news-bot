import { cleanCroatiaFeedText } from './croatia-news.js';

const MAX_CONTEXT_LENGTH = 1500;
const MIN_PARAGRAPH_LENGTH = 25;
const DESCRIPTION_KEYS = ['og:description', 'description', 'twitter:description'];
const BOILERPLATE = /^(?:advertisement\b|accept (?:all )?cookies\b|we use cookies\b|cookie (?:policy|settings)\b|(?:manage|update) (?:your )?(?:privacy|cookie) preferences\b|enable javascript\b|(?:sign up|subscribe) (?:for|to)\b|read more\b|related (?:articles|stories)\b|all rights reserved\b)/i;

function cleanArticleText(fragment) {
  // The shared RSS cleaner decodes numeric entities with String.fromCodePoint.
  const validEntities = fragment.replace(/(?:&amp;|&)#(x[\da-f]+|\d+);/gi, (entity, value) => {
    const codePoint = /^x/i.test(value) ? parseInt(value.slice(1), 16) : Number(value);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? entity
      : ' ';
  });
  return cleanCroatiaFeedText(validEntities);
}

function firstBlock(html, tag) {
  const pattern = new RegExp('<' + tag + '(?=[\\s>])[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'i');
  return pattern.exec(html)?.[1] ?? '';
}

function articleDescription(html) {
  const descriptions = new Map();
  for (const [tag] of html.matchAll(/<meta(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map();
    for (const [, name, quoted, singleQuoted, unquoted] of tag.matchAll(
      /\s([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g
    )) {
      attributes.set(name.toLowerCase(), quoted ?? singleQuoted ?? unquoted);
    }

    const key = (attributes.get('property') ?? attributes.get('name') ?? '').trim().toLowerCase();
    if (!DESCRIPTION_KEYS.includes(key) || descriptions.has(key) || !attributes.has('content')) {
      continue;
    }

    const description = cleanArticleText(attributes.get('content'));
    if (description && !BOILERPLATE.test(description)) {
      descriptions.set(key, description);
    }
  }

  return DESCRIPTION_KEYS.map((key) => descriptions.get(key)).find(Boolean) ?? '';
}

function comparisonText(text) {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function articleParagraphs(html) {
  const paragraphs = [];
  const seen = new Set();
  let length = 0;
  for (const [, fragment] of html.matchAll(/<p(?=[\s>])[^>]*>([\s\S]*?)(?:<\/p\s*>|(?=<p(?=[\s>]))|$)/gi)) {
    const paragraph = cleanArticleText(fragment);
    const key = comparisonText(paragraph);
    if (paragraph.length < MIN_PARAGRAPH_LENGTH || !key || seen.has(key) || BOILERPLATE.test(paragraph)) {
      continue;
    }

    paragraphs.push(paragraph);
    seen.add(key);
    length += paragraph.length + 2;
    if (length >= MAX_CONTEXT_LENGTH) {
      break;
    }
  }
  return paragraphs;
}

export function extractArticleContext(html) {
  if (typeof html !== 'string' || !html) {
    return '';
  }

  const page = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|template|noscript)(?=[\s>])[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const description = articleDescription(firstBlock(page, 'head') || page);
  const body = page.replace(/<(nav|aside|footer|figure|form|iframe|svg)(?=[\s>])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = firstBlock(body, 'main');
  const paragraphs = articleParagraphs(firstBlock(main || body, 'article'));
  if (paragraphs.length === 0 && main) {
    paragraphs.push(...articleParagraphs(main));
  }

  const descriptionKey = comparisonText(description);
  if (descriptionKey && !paragraphs.some((paragraph) => {
    const key = comparisonText(paragraph);
    return key.includes(descriptionKey) || descriptionKey.includes(key);
  })) {
    paragraphs.unshift(description);
  }

  const context = paragraphs.join('\n\n');
  if (context.length <= MAX_CONTEXT_LENGTH) {
    return context;
  }

  const head = context.slice(0, MAX_CONTEXT_LENGTH).replace(/[\uD800-\uDBFF]$/u, '');
  return (head.replace(/\s+\S*$/, '') || head).trimEnd();
}
