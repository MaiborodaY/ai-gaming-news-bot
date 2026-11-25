import test from 'node:test';
import assert from 'node:assert/strict';

import { extractArticleContext } from '../src/article-context.js';

test('article context includes a useful description and plain article paragraphs', () => {
  const html = [
    '<head><meta content="The evaluation checks inputs &gt; 1 GB." property = "og:description"></head>',
    '<p>Navigation and unrelated recommended stories are outside the article.</p>',
    '<main><article>',
    '<p>The <strong>model</strong> supports image &amp; audio input.</p>',
    '<p>THE MODEL SUPPORTS IMAGE &amp; AUDIO INPUT!</p>',
    '<p>API access starts on Monday for existing subscribers.</p>',
    '</article></main>'
  ].join('\n');

  assert.equal(extractArticleContext(html), [
    'The evaluation checks inputs > 1 GB.',
    'The model supports image & audio input.',
    'API access starts on Monday for existing subscribers.'
  ].join('\n\n'));
});

test('main content works without an article and excludes boilerplate and scripts', () => {
  const html = [
    '<!-- <meta name="description" content="This description was commented out."> -->',
    '<main>',
    '<nav><p>This menu is longer than a useful paragraph.</p></nav>',
    '<aside><p>This sidebar is unrelated to the article body.</p></aside>',
    '<script>const tag = "<p>This JavaScript must stay out of the story text.</p>";</script>',
    '<template><p>This template is not rendered article prose.</p></template>',
    '<p>We use cookies to analyze traffic and improve the site.</p>',
    '<p>Analysis now accepts audio files up to twenty minutes long.</p>',
    '<p>Subscribe to receive our latest news by email.</p>',
    '</main>'
  ].join('\n');

  assert.equal(extractArticleContext(html), 'Analysis now accepts audio files up to twenty minutes long.');
});

test('a meta description duplicating the article lead is excluded', () => {
  const html = [
    '<meta name="description" content="API access is now available on all tiers.">',
    '<article><p>API access is now available on all tiers, including the free plan.</p></article>'
  ].join('\n');

  assert.equal(extractArticleContext(html), 'API access is now available on all tiers, including the free plan.');
});

test('metadata can supply context on pages with no article body', () => {
  const html = [
    '<head><meta name=description content="The release adds an option to combine multiple clips."></head>',
    '<body><p>An unrelated site description appears outside the content scope.</p></body>'
  ].join('\n');

  assert.equal(extractArticleContext(html), 'The release adds an option to combine multiple clips.');
  assert.equal(extractArticleContext('<body><p>An unrelated site description is only in the body.</p></body>'), '');
  assert.equal(extractArticleContext(null), '');
});

test('article context ignores invalid numeric entities without losing the surrounding prose', () => {
  const html = '<article><p>The model &#x110000; accepts &amp;#9000000; photos and generates &#x1f680; images.</p></article>';

  assert.equal(extractArticleContext(html), 'The model accepts photos and generates 🚀 images.');
});

test('article context stays within the character budget and preserves whole emoji', () => {
  const first = 'The first version of the API is now available. '.repeat(22).trim();
  const second = 'The release will also include multilingual transcription and a documented sample. 🚀 '.repeat(20).trim();
  const context = extractArticleContext('<article><p>' + first + '</p><p>' + second + '</p></article>');

  assert.ok(context.startsWith(first));
  assert.match(context, /multilingual transcription/);
  assert.ok(context.length <= 1500);
  assert.doesNotMatch(context, /\p{Surrogate}/u);
});
