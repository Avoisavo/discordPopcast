import Parser from 'rss-parser';

const FALLBACK_TOPICS = [
  'Is streaming actually better than cable was, or did we just rebuild cable with extra steps?',
  'The greatest movie sequel of all time — and why most sequels fail',
  'Will AI-generated music ever produce a genuine hit song people love?',
  'Physical media is making a comeback: vinyl, DVDs, even cassettes. Why?',
  'The best video game story ever told',
  'Remote work vs the office: five years on, who actually won?',
  'Are award shows still relevant to anyone under 40?',
  'The one piece of tech from the last decade that actually changed daily life',
  'Reboots and remakes: creative bankruptcy or smart business?',
  'What would actually happen in the first year after we discover alien life?',
];

export class NewsDesk {
  constructor(feeds) {
    this.feeds = feeds;
    this.parser = new Parser({ timeout: 15000 });
    this.queue = [];
    this.priority = [];
    this.seen = new Set();
    this.fallbackIndex = 0;
  }

  async refresh() {
    for (const url of this.feeds) {
      try {
        const feed = await this.parser.parseURL(url);
        for (const item of (feed.items ?? []).slice(0, 10)) {
          const title = (item.title ?? '').trim();
          if (!title || this.seen.has(title)) continue;
          this.seen.add(title);
          this.queue.push({
            title,
            summary: (item.contentSnippet ?? '').replace(/\s+/g, ' ').slice(0, 400),
            source: feed.title ?? url,
          });
        }
      } catch (err) {
        console.warn(`[news] Failed to fetch ${url}: ${err.message}`);
      }
    }
    if (this.queue.length > 200) this.queue = this.queue.slice(-200);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    console.log(`[news] Topic queue now has ${this.queue.length} stories`);
  }

  suggest(topic, requestedBy) {
    this.priority.push({
      title: topic,
      summary: '',
      source: requestedBy ? `listener suggestion from ${requestedBy}` : 'listener suggestion',
    });
  }

  next() {
    const item = this.priority.shift() ?? this.queue.shift();
    if (item) return item;
    const title = FALLBACK_TOPICS[this.fallbackIndex % FALLBACK_TOPICS.length];
    this.fallbackIndex += 1;
    return { title, summary: '', source: 'evergreen debate topic' };
  }
}
