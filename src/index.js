import { Events } from 'discord.js';
import { config } from './config.js';
import { personas } from './personas.js';
import { NewsDesk } from './news.js';
import { Conversation } from './dialogue.js';
import { Speech } from './tts.js';
import { Host } from './host.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord's voice handshake intermittently exceeds the 30s Ready window even
// when nothing is misconfigured — retry a few times before giving up.
async function joinWithRetry(host, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await host.joinVoice(config.discord.guildId, config.discord.voiceChannelId);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(
        `[voice] ${host.persona.name} initial join failed (${err.message}) — retrying (${attempt}/${attempts})`,
      );
      await sleep(3_000);
    }
  }
}

const [personaA, personaB] = personas;
const hostA = new Host(personaA, config.discord.tokenA, { withMessageContent: true });
const hostB = new Host(personaB, config.discord.tokenB);

function shutdown() {
  console.log('[show] Shutting down…');
  hostA.destroy();
  hostB.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('[show] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[show] Uncaught exception:', err);
});

async function main() {
  const news = new NewsDesk(config.show.feeds);
  const speech = new Speech(config.elevenlabs);
  const convo = new Conversation(config.openai, config.show);

  await Promise.all([hostA.login(), hostB.login()]);
  await joinWithRetry(hostA);
  await joinWithRetry(hostB);

  // Listeners can steer the show: !topic <anything> (handled by bot A only).
  hostA.client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!topic ')) return;
    const topic = message.content.slice('!topic '.length).trim();
    if (!topic) return;
    news.suggest(topic.slice(0, 300), message.author.username);
    await message.react('🎙️').catch(() => {});
    console.log(`[show] Listener topic queued: ${topic}`);
  });

  await news.refresh();
  setInterval(
    () => news.refresh().catch((err) => console.warn(`[news] refresh failed: ${err.message}`)),
    config.show.feedRefreshMs,
  );

  await hostA.post(
    config.discord.textChannelId,
    `🔴 **The Popcast is live.** ${personaA.name} and ${personaB.name} are on air 24/7 in <#${config.discord.voiceChannelId}>. Steer the show anytime with \`!topic <your topic>\`.`,
  );

  const voices = { A: config.elevenlabs.voiceA, B: config.elevenlabs.voiceB };
  const hosts = { A: hostA, B: hostB };

  const speeds = { A: config.elevenlabs.speedA, B: config.elevenlabs.speedB };

  // Short reactions the listening host drops mid-line, like a real co-host —
  // laughs included. Each (host, phrase) pair is synthesized once, then reused.
  const BACKCHANNELS = {
    A: ['hahaha!', 'no way.', 'wait— [laughs]', 'bro.', 'okay okay.', "that's true."],
    B: ['ya ya hahaha.', '[laughs]', 'hahaha cannot.', 'mm-hmm.', 'so true.', 'aiyo.'],
  };
  const backchannelCache = new Map();
  async function backchannelClip(key) {
    const pool = BACKCHANNELS[key];
    const phrase = pool[Math.floor(Math.random() * pool.length)];
    const cacheKey = `${key}|${phrase}`;
    if (!backchannelCache.has(cacheKey)) {
      backchannelCache.set(cacheKey, await speech.synthesize(phrase, voices[key], speeds[key]));
    }
    return backchannelCache.get(cacheKey);
  }

  let speakerIndex = 0;
  let turnCount = 0;
  let consecutiveErrors = 0;

  // Generates the next line and its audio. Runs while the previous line is
  // still playing, so the next speaker starts with no dead air between turns.
  async function produceTurn() {
    if (!convo.topic || convo.turnsOnTopic >= config.show.turnsPerTopic) {
      const topic = news.next();
      convo.setTopic(topic);
      console.log(`[show] New topic: ${topic.title} (${topic.source})`);
    }
    const persona = personas[speakerIndex % 2];
    const partner = personas[(speakerIndex + 1) % 2];
    const line = await convo.nextLine(persona, partner);
    speakerIndex += 1;
    let audio = null;
    try {
      audio = await speech.synthesize(line, voices[persona.key], speeds[persona.key]);
    } catch (err) {
      console.warn(`[tts] ${err.message} — playing this line as text only`);
    }
    return { persona, line, audio };
  }

  let pending = null;
  for (;;) {
    try {
      const turn = await (pending ?? produceTurn());
      const host = hosts[turn.persona.key];
      console.log(`[show] ${turn.persona.name}: ${turn.line}`);
      // Audio tags are for the TTS engine; keep the transcript readable.
      const readable = turn.line.replace(/\[[^\]\n]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();
      await host.post(config.discord.textChannelId, readable);

      // Write and voice the NEXT turn while this one is playing.
      pending = produceTurn();
      pending.catch(() => {}); // surfaced when awaited on the next iteration

      if (turn.audio) {
        const playback = host.speak(turn.audio);
        // The listening host occasionally murmurs agreement partway through —
        // capped well before the line's estimated end so it never collides
        // with their own next line.
        if (Math.random() < 0.5 && turn.line.length > 80) {
          const partnerKey = turn.persona.key === 'A' ? 'B' : 'A';
          const delay = 1_500 + Math.random() * Math.min(6_000, turn.line.length * 25);
          sleep(delay)
            .then(() => backchannelClip(partnerKey))
            .then((clip) => (clip ? hosts[partnerKey].interject(clip) : null))
            .catch(() => {}); // best-effort — never disturb the main line
        }
        await playback;
      } else {
        // Text-only mode: pause roughly as long as the line would take to read.
        await sleep(Math.min(12_000, 1_000 + turn.line.length * 45));
      }

      turnCount += 1;
      consecutiveErrors = 0;

      if (turnCount % 25 === 0) {
        const sub = await speech.subscription();
        if (sub) {
          console.log(
            `[usage] ElevenLabs credits: ${sub.character_count}/${sub.character_limit} used this cycle (this session sent ${speech.charsUsed} chars to TTS)`,
          );
        }
      }

      await sleep(config.show.pauseBetweenTurnsMs);
    } catch (err) {
      pending = null; // never re-await a rejected (or superseded) turn
      // OpenAI 400s are deterministic (bad model/parameter combo) and will
      // never succeed on retry — crash loudly so the operator sees it.
      if (err?.status === 400) {
        console.error(
          `[show] Fatal: OpenAI rejected the request (${err.message}). Check OPENAI_MODEL and request parameters.`,
        );
        process.exit(1);
      }
      consecutiveErrors += 1;
      const backoff = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(consecutiveErrors, 6));
      console.error(
        `[show] Turn failed (${consecutiveErrors} in a row): ${err.message} — backing off ${Math.round(backoff / 1000)}s`,
      );
      await sleep(backoff);
    }
  }
}

main().catch((err) => {
  console.error('[show] Fatal error during startup:', err);
  process.exit(1);
});
