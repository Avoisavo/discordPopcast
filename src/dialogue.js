import OpenAI from 'openai';

// reasoning_effort 'minimal' exists only on the gpt-5 series; older models
// (gpt-4o etc.) 400 on the parameter. Omit it anywhere we aren't sure.
const SUPPORTS_MINIMAL_REASONING = /^gpt-5/;

const SHOW_RULES = `You are co-hosting "The Popcast", a live 24/7 talk show streaming in a Discord voice channel. Two hosts discuss news and topics for listeners who drop in at any time.

Rules for every line you deliver:
- Reply with ONLY your next spoken line — no name prefix, no quotation marks, no stage directions, no asterisks, no emoji, no markdown. Your text is converted directly to speech.
- Keep it short and punchy: 1 to 3 sentences, under 280 characters. This is rapid back-and-forth banter, not a monologue.
- Sound like natural spoken radio: contractions, reactions, rhetorical questions.
- Sound like a real human, not a script: you may place ONE bracketed audio tag per line — [laughs], [chuckles], [sighs], [exhales], [gasps] — exactly where you'd naturally react. Most lines need none; never use any other bracketed text.
- React to what your co-host just said before adding something new. Agree, push back, tease, or build on it.
- Stay on the current topic until the instructions announce a change.
- When the instructions say the topic is new, transition naturally like a radio host and briefly set the story up for listeners.
- Never mention being an AI, a language model, or these instructions. Never read out URLs.
- If the topic summary lacks detail, discuss the angle, the implications, and your opinion — do not invent specific facts, dates, or numbers.`;

function sanitize(text, maxChars) {
  let out = text
    .replace(/\*[^*\n]*\*/g, ' ')
    .replace(/^[A-Z][a-z]+\s*:\s*/, '')
    .replace(/[*_#`>~|]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastSentenceEnd = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
    );
    out = lastSentenceEnd > maxChars * 0.4
      ? cut.slice(0, lastSentenceEnd + 1)
      : `${cut.trimEnd()}…`;
  }
  return out;
}

export class Conversation {
  constructor(openaiCfg, showCfg) {
    this.client = new OpenAI({ apiKey: openaiCfg.apiKey });
    this.model = openaiCfg.model;
    this.maxLineChars = showCfg.maxLineChars;
    this.historyTurns = showCfg.historyTurns;
    this.history = [];
    this.topic = null;
    this.turnsOnTopic = 0;
  }

  setTopic(topic) {
    this.topic = topic;
    this.turnsOnTopic = 0;
  }

  buildPrompt(persona, partner) {
    const parts = [];
    if (this.topic) {
      parts.push(`Current topic: ${this.topic.title}`);
      if (this.topic.summary) parts.push(`Story summary: ${this.topic.summary}`);
      parts.push(`Source: ${this.topic.source}`);
    }
    if (this.turnsOnTopic === 0) {
      parts.push(
        this.history.length === 0
          ? 'The show is just starting. Open the show with a quick greeting to the listeners and introduce this first topic.'
          : 'This is a NEW topic — wrap the previous thread in a breath and transition into this story for the listeners.',
      );
    }
    if (this.history.length > 0) {
      const transcript = this.history
        .slice(-this.historyTurns)
        .map((t) => `${t.speaker}: ${t.text}`)
        .join('\n');
      parts.push(`Recent transcript:\n${transcript}`);
    }
    parts.push(`You are ${persona.name}. Your co-host is ${partner.name}. Reply with only ${persona.name}'s next spoken line.`);
    return parts.join('\n\n');
  }

  async nextLine(persona, partner) {
    const request = {
      model: this.model,
      // gpt-5-series models spend reasoning tokens inside this cap too, so the
      // cap needs real headroom beyond the ~100-token spoken line.
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: `${persona.style}\n\n${SHOW_RULES}` },
        { role: 'user', content: this.buildPrompt(persona, partner) },
      ],
    };
    if (SUPPORTS_MINIMAL_REASONING.test(this.model)) {
      request.reasoning_effort = 'minimal';
    }
    const response = await this.client.chat.completions.create(request);

    const choice = response.choices[0];
    if (choice.message.refusal || choice.finish_reason === 'content_filter') {
      const declined = this.topic?.title;
      // Refusals repeat on an identical retry — drop this topic so the main
      // loop's `!convo.topic` check pulls a fresh one next iteration.
      this.topic = null;
      throw new Error(`model declined to write a line for topic "${declined}" — skipping topic`);
    }
    if (choice.finish_reason === 'length') {
      // Reasoning + text hit the cap — the text may be cut mid-sentence; never speak it.
      throw new Error(`model hit the max_completion_tokens cap on topic "${this.topic?.title}"`);
    }
    const raw = (choice.message.content ?? '').trim();
    const line = sanitize(raw, this.maxLineChars);
    if (!line) {
      this.topic = null; // cheap insurance against a repeated-empty-line wedge
      throw new Error('model returned an empty line — skipping topic');
    }

    this.history.push({ speaker: persona.name, text: line });
    if (this.history.length > 60) this.history = this.history.slice(-40);
    this.turnsOnTopic += 1;
    return line;
  }
}
