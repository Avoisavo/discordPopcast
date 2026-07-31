import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required env var: ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.theverge.com/rss/index.xml',
  'https://feeds.arstechnica.com/arstechnica/index',
  'https://variety.com/feed/',
].join(',');

export const config = {
  discord: {
    tokenA: required('DISCORD_TOKEN_BOT_A'),
    tokenB: required('DISCORD_TOKEN_BOT_B'),
    guildId: required('DISCORD_GUILD_ID'),
    voiceChannelId: required('DISCORD_VOICE_CHANNEL_ID'),
    textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID || null,
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
    voiceA: process.env.ELEVENLABS_VOICE_A || 'pNInz6obpnDSJ39PxFvo',
    voiceB: process.env.ELEVENLABS_VOICE_B || '21m00Tcm4TlvDq8ikWAM',
    modelId: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
  },
  show: {
    pauseBetweenTurnsMs: int(process.env.PAUSE_BETWEEN_TURNS_MS, 4000),
    turnsPerTopic: int(process.env.TURNS_PER_TOPIC, 10),
    maxLineChars: int(process.env.MAX_LINE_CHARS, 320),
    historyTurns: int(process.env.HISTORY_TURNS, 14),
    feeds: (process.env.NEWS_FEEDS || DEFAULT_FEEDS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    feedRefreshMs: int(process.env.FEED_REFRESH_MS, 30 * 60 * 1000),
  },
};
