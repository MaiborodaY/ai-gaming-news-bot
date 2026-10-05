export const AI_NEWS_CRON_EXPRESSION = '0 10,11,18,19 * * *';

const aiHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Zagreb',
  hour: '2-digit',
  hourCycle: 'h23'
});

export const AI_NEWS_SOURCES = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' }
];

export function isAiNewsSlot(scheduledTime) {
  const date = new Date(scheduledTime);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  // Cron runs at both UTC offsets; only 12:00 and 20:00 Zagreb may publish.
  const hour = Number(aiHourFormatter.format(date));
  return hour === 12 || hour === 20;
}
