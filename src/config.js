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

function num(value, fallback) {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : fallback;
}

// Values copied verbatim from the old .env.example point at retired ElevenLabs
// voices / stale pacing — treat them as unset so the real defaults apply.
function envExcept(name, ...stale) {
  const value = process.env[name]?.trim();
  return value && !stale.includes(value) ? value : undefined;
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
    model: envExcept('OPENAI_MODEL', 'gpt-4o-mini') || 'gpt-5',
  },
  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
    voiceA: envExcept('ELEVENLABS_VOICE_A', 'pNInz6obpnDSJ39PxFvo') || 'TX3LPaxmHKxFdv7VOQHJ',
    voiceB: envExcept('ELEVENLABS_VOICE_B', '21m00Tcm4TlvDq8ikWAM') || 'qAJVXEQ6QgjOQ25KuoU8',
    modelId: process.env.ELEVENLABS_MODEL || 'eleven_v3',
    // Talking pace (0.7–1.2). B (Aisyah) runs naturally slower, so push harder.
    speedA: num(process.env.ELEVENLABS_SPEED_A, 1.1),
    speedB: num(process.env.ELEVENLABS_SPEED_B, 1.15),
  },
  show: {
    pauseBetweenTurnsMs: int(envExcept('PAUSE_BETWEEN_TURNS_MS', '4000'), 800),
    // One topic cycle = one episode (cold open → stories → wind-down → sign-off).
    turnsPerTopic: int(envExcept('TURNS_PER_TOPIC', '10'), 40),
    maxLineChars: int(process.env.MAX_LINE_CHARS, 320),
    historyTurns: int(process.env.HISTORY_TURNS, 14),
    feeds: (process.env.NEWS_FEEDS || DEFAULT_FEEDS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    feedRefreshMs: int(process.env.FEED_REFRESH_MS, 30 * 60 * 1000),
  },
};
