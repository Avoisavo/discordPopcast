import { Events } from 'discord.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { personas } from './personas.js';
import { NewsDesk } from './news.js';
import { Conversation } from './dialogue.js';
import { Speech } from './tts.js';
import { Host } from './host.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// script.md at the project root is performed verbatim on startup — lines
// labelled **Emy:**/**Max:** go to host A, **Liam:**/**Nova:** to host B —
// then the show continues generated, with the script in memory. Delete the
// file to skip straight to the generated show.
const SPEAKER_KEYS = { emy: 'A', max: 'A', liam: 'B', nova: 'B' };
function loadScript() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(root, 'script.md'), 'utf8')
      .split('\n')
      .map((line) => line.match(/^\*\*([A-Za-z]+):\*\*\s*(.+)$/))
      .filter(Boolean)
      .map((m) => ({ key: SPEAKER_KEYS[m[1].toLowerCase()], text: m[2].trim() }))
      .filter((line) => line.key && line.text);
  } catch {
    return [];
  }
}

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
    A: ['hahaha.', 'no way.', 'wait— [laughs]', 'bro.', 'okay okay.', "that's true."],
    B: ['ya ya hahaha.', '[laughs]', 'hahaha cannot.', 'mm-hmm.', 'so true.', 'aiyo.'],
  };
  const backchannelCache = new Map();
  // Laughs and murmurs render at a relaxed pace regardless of the host's
  // talking speed — sped-up laughter sounds broken.
  const BACKCHANNEL_SPEED = 0.95;
  // Pre-warm every clip at startup: an uncached murmur takes v3 seconds to
  // synthesize, so it used to land AFTER its line ended — colliding with the
  // next speaker. Only cached clips ever play, so timing is exact.
  (async () => {
    for (const key of ['A', 'B']) {
      for (const phrase of BACKCHANNELS[key]) {
        const cacheKey = `${key}|${phrase}`;
        if (backchannelCache.has(cacheKey)) continue;
        try {
          backchannelCache.set(cacheKey, await speech.synthesize(phrase, voices[key], BACKCHANNEL_SPEED));
        } catch {}
      }
    }
    console.log('[voice] backchannel clips warmed');
  })();
  function cachedBackchannel(key) {
    const clips = BACKCHANNELS[key]
      .map((phrase) => backchannelCache.get(`${key}|${phrase}`))
      .filter(Boolean);
    return clips.length ? clips[Math.floor(Math.random() * clips.length)] : null;
  }
  // Schedules a murmur strictly inside the first 60% of the line's estimated
  // duration, so it can never straddle the hand-off to the next speaker.
  function scheduleBackchannel(speakerKey, lineLength) {
    if (Math.random() >= 0.5 || lineLength <= 70) return;
    const partnerKey = speakerKey === 'A' ? 'B' : 'A';
    const clip = cachedBackchannel(partnerKey);
    if (!clip) return;
    const estMs = lineLength * 60;
    const delay = Math.min(estMs * 0.6, 800 + Math.random() * estMs * 0.5);
    sleep(delay)
      .then(() => hosts[partnerKey].interject(clip))
      .catch(() => {});
  }

  // Perform script.md first if present — exact lines, right voices, next
  // line synthesized while the current one plays — then fall through to the
  // generated show with the script's tail in the hosts' memory.
  const scriptLines = loadScript();
  if (scriptLines.length) {
    console.log(`[script] Performing script.md — ${scriptLines.length} lines`);
    const synthLine = (line) =>
      speech.synthesize(line.text, voices[line.key], speeds[line.key]).catch((err) => {
        console.warn(`[tts] ${err.message} — playing this line as text only`);
        return null;
      });
    // Synthesize a few lines ahead so short lines never wait on the API, and
    // keep the inter-line gap near zero — real banter catches up instantly.
    const audioPromises = new Array(scriptLines.length);
    const ensureSynth = (idx) => {
      if (idx < scriptLines.length && !audioPromises[idx]) audioPromises[idx] = synthLine(scriptLines[idx]);
    };
    for (let i = 0; i < scriptLines.length; i += 1) {
      for (let j = i; j < i + 4; j += 1) ensureSynth(j);
      const line = scriptLines[i];
      const audio = await audioPromises[i];
      const persona = line.key === 'A' ? personaA : personaB;
      try {
        console.log(`[script] ${persona.name}: ${line.text}`);
        // Fire-and-forget: the transcript post must never delay the audio.
        hosts[line.key].post(config.discord.textChannelId, line.text);
        if (audio) {
          const playback = hosts[line.key].speak(audio);
          // Scripted lines get live murmurs from the listening host too.
          scheduleBackchannel(line.key, line.text.length);
          await playback;
        } else {
          await sleep(Math.min(12_000, 1_000 + line.text.length * 45));
        }
      } catch (err) {
        console.warn(`[script] line failed (${err.message}) — continuing`);
      }
      convo.history.push({ speaker: persona.name, text: line.text });
      await sleep(150);
    }
    convo.history = convo.history.slice(-40);
    console.log('[script] Script finished — continuing with generated conversation');
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
    // ~1 in 5 turns the same host keeps the mic ("wait— one more thing"),
    // breaking the robotic strict alternation.
    speakerIndex += Math.random() < 0.2 ? 0 : 1;
    let audio = null;
    try {
      audio = await speech.synthesize(line, voices[persona.key], speeds[persona.key]);
    } catch (err) {
      console.warn(`[tts] ${err.message} — playing this line as text only`);
    }
    return { persona, line, audio };
  }

  // Two-deep production chain: while a line plays, the next is already done
  // and the one after is being written. Generation runs continuously instead
  // of restarting after each playback, so hand-offs never wait on the writers.
  let next = null;
  let after = null;
  for (;;) {
    try {
      if (!next) {
        next = produceTurn();
        after = next.then(() => produceTurn());
        next.catch(() => {});
        after.catch(() => {});
      }
      const turn = await next;
      next = after;
      after = next.then(() => produceTurn());
      next.catch(() => {});
      after.catch(() => {});

      const host = hosts[turn.persona.key];
      console.log(`[show] ${turn.persona.name}: ${turn.line}`);
      // Audio tags are for the TTS engine; keep the transcript readable.
      // Fire-and-forget: the transcript post must never delay the audio.
      const readable = turn.line.replace(/\[[^\]\n]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();
      host.post(config.discord.textChannelId, readable);

      if (turn.audio) {
        const playback = host.speak(turn.audio);
        scheduleBackchannel(turn.persona.key, turn.line.length);
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
      next = null; // never re-await a rejected (or superseded) turn
      after = null;
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
