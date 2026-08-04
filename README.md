# 🎙️ Discord Popcast

Two AI hosts — **Max** (energetic hot-take machine) and **Nova** (dry, skeptical wit) — run a 24/7 talk show in a Discord voice channel. OpenAI writes the banter, ElevenLabs voices it, RSS feeds keep the topics fresh, and a text channel gets the live transcript. Listeners can steer the show with `!topic <anything>`.

```
RSS news feeds ──► topic queue ──► OpenAI (dialogue) ──► ElevenLabs (voice)
                                        │                     │
                                        ▼                     ▼
                              #transcript channel    🔊 voice channel (2 bots)
```

## 1. Create the Discord side (one-time, ~10 minutes)

1. **Create a server** (or use an existing one) with a voice channel and a text channel for the transcript.
2. **Create TWO bot applications** at <https://discord.com/developers/applications>:
   - "New Application" → name it (e.g. `Max`) → **Bot** tab → **Reset Token** → copy the token → this is `DISCORD_TOKEN_BOT_A`.
   - On the same Bot tab, enable the **Message Content Intent** toggle (needed for `!topic`).
   - Repeat for the second app (e.g. `Nova`) → `DISCORD_TOKEN_BOT_B`. Enable Message Content Intent on it too (harmless, and lets you swap tokens freely).
3. **Invite both bots** to your server. For each app, grab its Application ID (General Information tab) and open:

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID_HERE&scope=bot&permissions=3214336
   ```

   (That permission set = View Channels, Send Messages, Read Message History, Connect, Speak.)
4. **Copy the IDs**: Discord Settings → Advanced → enable **Developer Mode**, then right-click your server → Copy Server ID (`DISCORD_GUILD_ID`), the voice channel → Copy Channel ID (`DISCORD_VOICE_CHANNEL_ID`), and the text channel → Copy Channel ID (`DISCORD_TEXT_CHANNEL_ID`).

## 2. API keys

- **ElevenLabs**: elevenlabs.io → profile → **API Keys** → `ELEVENLABS_API_KEY`. Voice IDs come from the Voices page (defaults are Liam & Alice).
- **OpenAI**: <https://platform.openai.com/api-keys> → Create new secret key → `OPENAI_API_KEY`.

## 3. Run it

```bash
cp .env.example .env   # then fill in every value
npm install
npm start
```

Both bots log in, join the voice channel, and start talking. On a laptop, prevent sleep from killing the show by starting it with `caffeinate -is npm start`. To keep it running 24/7 after you close the terminal:

```bash
npx pm2 start src/index.js --name popcast
npx pm2 logs popcast
```

## Stopping the show

- Started with `npm start` in a terminal → press **Ctrl+C** in that terminal.
- Running somewhere you can't see → `pkill -f "node src/index.js"`.
- Started with pm2 → `npx pm2 stop popcast` (or `npx pm2 delete popcast` to remove it).

The bots leave the voice channel the moment the process dies.

## The hosts' lives

[personas/max.md](personas/max.md) and [personas/nova.md](personas/nova.md) hold each host's backstory — their friendship, running jokes, and personal history. The hosts weave these into conversation on their own. Edit the files to reshape their lives; changes apply on the next restart.

## Credit math (ElevenLabs Creator plan)

- `eleven_multilingual_v2` (default — most natural) costs **1 credit per character**; `eleven_turbo_v2_5` costs 0.5. An average line here is ~200 characters ≈ 200 credits.
- **100,000 credits ≈ ~500 spoken lines ≈ 2–3 hours of near-continuous talk** (double that on turbo).
- To stretch a month of credits across the whole month, raise `PAUSE_BETWEEN_TURNS_MS` (e.g. `45000` ≈ one exchange per minute ≈ ~3.5k lines/month… tune to taste). Since you want to burn them: the default `4000` will happily do that.
- When credits run out, the show **automatically continues text-only** in the transcript channel and re-checks your quota every 30 minutes.

## Steering the show

- [script.md](script.md) at the project root → **script mode**: on every startup the hosts perform it verbatim, line by line (`**Emy:**`/`**Max:**` → bot A, `**Liam:**`/`**Nova:**` → bot B), then continue with the generated show. Delete the file to skip straight to generated conversation.
- `!topic anything you want` in the transcript channel → jumps the queue as the next topic.
- [topics.md](topics.md) at the project root → **theme mode**: the show rotates these topics (in random order) and ignores RSS entirely. Edit the list to change the show's theme; delete the file to go back to news mode.
- `NEWS_FEEDS` in `.env` → any comma-separated RSS feeds (default: BBC World, The Verge, Ars Technica, Variety). Only used when `topics.md` doesn't exist.
- `TURNS_PER_TOPIC`, `MAX_LINE_CHARS`, `OPENAI_MODEL` → pacing, cost, and brain of the show.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Used disallowed intents` on login | Enable **Message Content Intent** in the Developer Portal (Bot tab) for that bot. |
| Bot joins but is silent | Make sure the bot has **Speak** permission in the voice channel; check the terminal for `[tts]` errors. |
| `Missing Permissions` posting transcript | Give both bots Send Messages in the text channel. |
| ElevenLabs 401 | Wrong API key, or credits exhausted (the log will say which). |
