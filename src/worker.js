export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'ai-gaming-news-bot',
          version: '0.1.0'
        }),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8'
          }
        }
      );
    }

    return new Response('AI Gaming News Bot is running');
  }
};
