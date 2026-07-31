import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { Readable } from 'node:stream';

export class Host {
  constructor(persona, token, { withMessageContent = false } = {}) {
    this.persona = persona;
    this.token = token;
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
    if (withMessageContent) {
      intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    }
    this.client = new Client({ intents });
    this.connection = null;
    this.player = null;
    this.rejoining = false;
  }

  async login() {
    const ready = new Promise((resolve) => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.token);
    await ready;
    console.log(`[discord] ${this.persona.name} logged in as ${this.client.user.tag}`);
  }

  async joinVoice(guildId, channelId) {
    const guild = await this.client.guilds.fetch(guildId);
    // Two clients share this process: `group` must differ per client, otherwise
    // @discordjs/voice keys both connections under the same guild and the
    // second join steals the first bot's connection.
    this.connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      group: this.client.user.id,
      selfDeaf: true,
    });
    const connection = this.connection;

    // Transient UDP/voice-WebSocket/DAVE errors surface as 'error' events;
    // with no listener Node throws them as fatal uncaught exceptions. Real
    // connection loss also transitions to Disconnected, handled below.
    connection.on('error', (err) =>
      console.warn(`[voice] ${this.persona.name} connection error: ${err.message}`),
    );

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      try {
        connection.destroy();
      } catch {}
      throw err;
    }

    if (!this.player) {
      this.player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      this.player.on('error', (err) =>
        console.warn(`[voice] ${this.persona.name} player error: ${err.message}`),
      );
    }
    connection.subscribe(this.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (this.connection !== connection) return; // superseded by a newer join
        console.warn(`[voice] ${this.persona.name} lost the voice connection — rejoining`);
        try {
          connection.destroy();
        } catch {}
        this.rejoinForever(guildId, channelId);
      }
    });

    console.log(`[voice] ${this.persona.name} joined the voice channel`);
  }

  /** Retries joinVoice until it succeeds, with 5s → 5min exponential backoff. */
  async rejoinForever(guildId, channelId) {
    if (this.rejoining) return;
    this.rejoining = true;
    let delay = 5_000;
    for (;;) {
      try {
        await this.joinVoice(guildId, channelId);
        this.rejoining = false;
        return;
      } catch (err) {
        console.error(
          `[voice] ${this.persona.name} failed to rejoin: ${err.message} — retrying in ${Math.round(delay / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5 * 60_000);
      }
    }
  }

  async speak(mp3Buffer) {
    const resource = createAudioResource(Readable.from(mp3Buffer), {
      inputType: StreamType.Arbitrary,
    });
    this.player.play(resource);
    await entersState(this.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(this.player, AudioPlayerStatus.Idle, 5 * 60_000);
  }

  async post(channelId, content) {
    if (!channelId || !content) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      await channel.send(content.slice(0, 2000));
    } catch (err) {
      console.warn(`[discord] ${this.persona.name} could not post transcript: ${err.message}`);
    }
  }

  destroy() {
    try {
      this.connection?.destroy();
    } catch {}
    this.client.destroy();
  }
}
