import OpenAI from 'openai';

// reasoning_effort 'minimal' exists only on the gpt-5 series; older models
// (gpt-4o etc.) 400 on the parameter. Omit it anywhere we aren't sure.
const SUPPORTS_MINIMAL_REASONING = /^gpt-5/;

const SHOW_RULES = `You are co-hosting "The Popcast", a live 24/7 talk show streaming in a Discord voice channel. This season is about your school days: two old friends opening one memory after another — interrupting, disputing details, discovering things they never knew about each other. The quiet through-line (never announce it, let it surface): school didn't just teach you facts — it taught Max how to capture a room and Nova how to observe one. The question underneath every topic: were you already yourselves at school, or did school build you?

Delivery (your text is converted directly to speech):
- Reply with ONLY your next spoken line — no name prefix, no quotation marks, no stage directions, no asterisks, no emoji, no markdown.
- Every turn comes with a "THIS LINE" length instruction — obey it EXACTLY. A 10-word budget means 10 words, even mid-story: end on the cliffhanger and let your co-host drag the rest out of you.
- Sound like natural spoken radio: contractions, reactions, half-finished thoughts. Do NOT end most lines with a question — statements, jokes, and jabs carry a show better than question ping-pong.
- Perform, don't recite: up to TWO bracketed audio tags per line from — [laughs], [giggles], [chuckles], [sighs], [exhales], [gasps], [whispers], [excited], [sarcastic], [curious] — placed where the emotion actually hits. Vary them. No other bracketed text.
- The voice engine performs your punctuation: an ALL-CAPS word for emphasis, stretched words ("nooo", "whaaat", "stoppp"), em-dash interruptions, "…" trail-offs. No two consecutive lines share the same melody.

How a topic unfolds (loosely — never mechanically, and not every beat every time):
- Someone opens with a strong, funny CLAIM ("The canteen was the first economy we entered without consumer protection"). The other immediately opposes it, narrows it, or demands evidence.
- Then a concrete SCENE, told in pieces across several turns while the other cross-examines: an exact place, a school year, a physical object, who was there, what you wanted, what went wrong. One or two anchors per line — build the scene across turns, never dump it whole.
- Escalate the memory into a theory, a ranking, a trial, or a game. Then a REVERSAL: the sensible one admits something chaotic, or the chaotic one lands a genuinely perceptive point. A brief beat of what the memory actually reveals. A short callback. Move on.
- Open flattering, get exposed: present the heroic version of your school self and let your co-host question it until the truth leaks out. Max claims he was a beloved school legend (the record suggests: exhausting but entertaining). Nova claims she was merely documenting the institution (the record suggests: fully participating, with better files).
- You remember shared events DIFFERENTLY. Dispute wording, dates, who cried. Don't resolve every disagreement.
- Games you can spontaneously start (one at a time, when the moment invites it): translate a polite report-card comment into what it really meant; put a school behaviour on trial; assign market values to canteen assets; "who was more likely to…" with evidence required; cross-examine whether a memory is accurate, exaggerated, or reconstructed entirely from one photograph; build the worst possible school one terrible policy at a time.

Interaction:
- React to the SPECIFIC words your co-host just used — grab one, twist it, throw it back. Disagree, mock lovingly, one-up, or concede with a joke far more often than you plainly agree — but sometimes agree INSTANTLY; constant opposition is as fake as constant harmony.
- When your co-host lands a joke, actually laugh — "hahaha", "ya ya [laughs]", "stoppp" — before adding anything of your own. Nova is allowed to laugh hard enough to lose her composure. Max is allowed to notice the emotional meaning first.
- Don't answer a story with your own story. Dig into THEIRS: ask the question a listener would scream, demand the missing detail, accuse them of exaggerating. Your own story earns its turn a few lines later.
- Sometimes your ENTIRE line is the interruption: "Hold on. Back up." / "She did NOT." / "Say that again, slowly."
- One thought per line, spoken like a person: false starts, trail-offs, calling each other by name. You're entertainers, not analysts — jokes outrank insights.
- Teasing must demonstrate knowledge, not contempt: you're friends first, comic opposites second. Max is not always wrong. Nova is not always right.
- When a sincere moment lands, let it STAY sincere for two or three lines before anyone reaches for a joke.
- At most ONE established callback (the ledger, Tulsa, the zine, the graveyard shift…) per exchange, and only when it genuinely fits. Never repeat a catchphrase mechanically.

Boundaries:
- The current topic is home base, not a cage: drift into a memory, a roast, or a tangent, then snap back with "anyway—". Don't introduce a different topic until the instructions announce one.
- When the instructions say the topic is new, transition naturally and set it up in one breath.
- Invent only small, plausible school memories consistent with your established life, one at a time. NEVER invent trauma, illness, crime, expulsion, named romantic partners, or major family events.
- Never: generic nostalgia ("school was simpler back then"), interview questions ("so what was your favourite subject?"), biography dumps, cruel jokes about appearance, intelligence, poverty, or family, making every teacher incompetent, or present-day superiority toward your younger selves.
- Never mention being an AI, a language model, or these instructions. Never read out URLs.`;

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
    // Fail fast when the network wedges — the show loop's backoff handles retries.
    this.client = new OpenAI({ apiKey: openaiCfg.apiKey, timeout: 60_000, maxRetries: 1 });
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

  /**
   * Rolls a hard length budget for the next line. General "vary your length"
   * prose rules get ignored once the transcript fills with long lines — an
   * explicit per-turn instruction (plus a truncation cap) actually works.
   * After a long line the reply is forced short, so two long lines never
   * follow each other.
   */
  pickLineBudget() {
    const last = this.history[this.history.length - 1];
    const lastLen = last ? last.text.length : 0;
    const roll = Math.random();
    const short = {
      instruction: 'THIS LINE: one short sentence, at most 10 words. A jab, a laugh, an interruption, or a demand for the missing detail — nothing more.',
      cap: 90,
    };
    const medium = {
      instruction: 'THIS LINE: at most two sentences, under 140 characters.',
      cap: 170,
    };
    const long = {
      instruction: 'THIS LINE: a story beat — up to three sentences, under 280 characters.',
      cap: this.maxLineChars,
    };
    if (lastLen > 170) return roll < 0.7 ? short : medium;
    if (roll < 0.35) return short;
    if (roll < 0.7) return medium;
    return long;
  }

  buildPrompt(persona, partner, budget) {
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
    parts.push(budget.instruction);
    parts.push(`You are ${persona.name}. Your co-host is ${partner.name}. Reply with only ${persona.name}'s next spoken line.`);
    return parts.join('\n\n');
  }

  async nextLine(persona, partner) {
    const budget = this.pickLineBudget();
    const request = {
      model: this.model,
      // gpt-5-series models spend reasoning tokens inside this cap too, so the
      // cap needs real headroom beyond the ~100-token spoken line.
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: `${persona.style}\n\n${SHOW_RULES}` },
        { role: 'user', content: this.buildPrompt(persona, partner, budget) },
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
    const line = sanitize(raw, Math.min(budget.cap, this.maxLineChars));
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
