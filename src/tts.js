const QUOTA_RETRY_MS = 30 * 60 * 1000;

export class Speech {
  constructor(cfg) {
    this.apiKey = cfg.apiKey;
    this.modelId = cfg.modelId;
    this.charsUsed = 0;
    this.disabledUntil = 0;
  }

  get disabled() {
    return Date.now() < this.disabledUntil;
  }

  /** Returns an MP3 Buffer, or null when the credit quota is exhausted (text-only mode). */
  async synthesize(text, voiceId, speed = 1) {
    if (this.disabled) return null;

    const isV3 = this.modelId.startsWith('eleven_v3');
    // Audio tags like [laughs] are only rendered by v3 — older models would
    // read them out loud, so strip them there.
    if (!isV3) text = text.replace(/\[[^\]\n]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: this.modelId,
            // v3 only accepts stability 0.0/0.5/1.0 and rejects the v2-era
            // knobs. 0.0 = Creative: maximum emotional range (pitch swings,
            // real laughs); bump to 0.5 if delivery gets too wild.
            // On v2 models: lower stability + style exaggeration +
            // a slightly faster pace = livelier, less robotic delivery.
            voice_settings: isV3
              ? { stability: 0.0, speed }
              : {
                  stability: 0.4,
                  similarity_boost: 0.8,
                  style: 0.35,
                  use_speaker_boost: true,
                  speed,
                },
          }),
          // Hard wall-clock cap — a hung request must not stall the show loop.
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (res.ok) {
        this.charsUsed += text.length;
        return Buffer.from(await res.arrayBuffer());
      }

      const body = await res.text().catch(() => '');
      if (body.includes('quota_exceeded')) {
        console.warn('[tts] ElevenLabs credits exhausted — switching to text-only, will retry in 30 min');
        this.disabledUntil = Date.now() + QUOTA_RETRY_MS;
        return null;
      }

      // 429 (too_many_concurrent_requests / system_busy) is transient: honor
      // Retry-After when present, else exponential backoff, capped at 30s.
      if (res.status === 429 && attempt < 3) {
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const waitMs =
          retryAfterSec > 0
            ? Math.min(30_000, retryAfterSec * 1000)
            : Math.min(30_000, 2_000 * 2 ** attempt);
        console.warn(
          `[tts] ElevenLabs 429 — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/3)`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 300)}`);
    }
  }

  /** { character_count, character_limit } for the current billing cycle, or null. */
  async subscription() {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
