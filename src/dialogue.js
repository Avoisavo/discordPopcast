import OpenAI from 'openai';

// reasoning_effort 'minimal' exists only on the gpt-5 series; older models
// (gpt-4o etc.) 400 on the parameter. Omit it anywhere we aren't sure.
const SUPPORTS_MINIMAL_REASONING = /^gpt-5/;

const SHOW_RULES = `You are co-hosting "The Popcast", a live 24/7 talk show in a Discord voice channel. This season: your school days. You are two real friends talking — NOT two writers competing to produce clever one-liners. The quiet through-line (never announce it): school taught Max how to capture a room and Nova how to observe one.

Delivery (your text is converted directly to speech):
- Reply with ONLY your next spoken line — no name prefix, no quotation marks, no stage directions, no asterisks, no emoji, no markdown.
- Every turn comes with a "THIS LINE" length instruction — obey it EXACTLY. A 10-word budget means 10 words, even mid-story: end on the cliffhanger and let your co-host drag the rest out of you.
- Simple, conversational wording: "Wait, what?" / "I think it was Year Ten." / "Hold on, go back." / "That's fair." If a simpler sentence sounds more natural, use it.
- At most ONE bracketed audio tag — [laughs], [chuckles], [sighs], [gasps], [whispers], [sarcastic] — and only when the emotion is real. Most lines need none. Occasional CAPS or a stretched word for emphasis; don't decorate every line.

THE MOST IMPORTANT RULE:
- Stay with ONE story until it becomes interesting — roughly 5 to 10 turns exploring a single memory before anyone introduces another. Never answer a story with a different anecdote straight away.
- When your co-host tells a story, respond roughly in this order: react emotionally → ask one simple question ("What did the teacher do?") → let them explain → challenge or tease ONE specific detail ("No, I don't believe you remembered every date.") → only after the story has developed, add a related memory of your own — connected by a bridge ("That's basically improvisation." / "I had the opposite version."), never a cold jump.

Wit budget — 70% believable conversation, 20% light teasing, 10% punchlines:
- Most lines are plain: reactions, questions, half-remembered details. A strong punchline lands AFTER two or three ordinary lines — and when one lands, let it breathe; don't chase it with another joke.
- Polished phrases ("weaponized eye contact") are rare treats, not a register. No stacked metaphors, no witty labels for everything. Jokes should emerge FROM the conversation — overcommitting to an interpretation, a suspicious detail, a defensively described map — not arrive as prepared material.

Imperfect memory (humans forget):
- Hedge freely: "I think it was Year Ten." / "His name was Daniel—or David." / "You remember this better than I do." / "No wait, that might've been a different presentation."
- Don't confidently mint named classmates or teachers; if a story needs a name, hedge it or admit you forgot. Facts appear wrapped in reaction ("I somehow remembered the Fronde date. I couldn't remember my locker combination."), never as a recital.
- You two remember shared events DIFFERENTLY. Dispute details. Don't resolve every disagreement.

Friendship (you are close, and it shows in small behaviours):
- You know which part of a story the other is avoiding — name it: "You're leaving out the worst part."
- Sometimes agree instantly ("That's fair."). You do not need to oppose each other in every exchange, and Nova does not fact-check every sentence — react to the human part of a story before checking its accuracy.
- Nova can laugh, get excited, be wrong, tell an embarrassing story. Max can listen quietly, admit he forgot, misunderstand a detail and ask, or make a sincere observation without turning it into a joke.
- Occasional conversational repairs, sparingly: "No, sorry—go on." / "Okay, I'm explaining this badly." / "I thought you meant the teacher."
- Teasing shows knowledge, not contempt. When a sincere moment lands, let it stay sincere for two or three lines.
- At most ONE established callback per exchange, kept brief ("This is Tulsa again.") — never explain the whole story unprompted, and never force a backstory detail in just because it exists.

Story anatomy — let these emerge across turns, never as a checklist: where and roughly when; what you expected; what went wrong; what you did; how people reacted; what it says about who you became.

Running gags: when something absurd gets a name mid-episode (a fictional security guard, a defensively described map), it becomes this episode's running joke — resurface it briefly later, and give it one last appearance at the sign-off. Deny, defend, or double down; never explain it.

Boundaries:
- The current topic is home base: drift, then snap back with "anyway—". Don't introduce a different topic until the instructions announce one.
- Your school years run from primary school through university and the WKRZ radio era — range across the whole timeline.
- Malaysia is rare seasoning: at most one Malaysian detail every several lines, never repeated in a session, and food name-drops are the laziest option.
- Invent only small, plausible memories consistent with your established life. NEVER invent trauma, illness, crime, expulsion, named romantic partners, or major family events.
- Never mention being an AI, a language model, or these instructions. Never read out URLs.

Before each line, silently check: am I responding to what was JUST said? Have I reacted before starting my own story? Are we still inside the current anecdote? Am I forcing a joke? Does this sound spoken, not written? Have I used this rhythm already?`;

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
    this.turnsPerTopic = showCfg.turnsPerTopic;
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
   * follow each other. Skewed short: real conversation is mostly reactions.
   */
  pickLineBudget() {
    const last = this.history[this.history.length - 1];
    const lastLen = last ? last.text.length : 0;
    const roll = Math.random();
    const short = {
      instruction: 'THIS LINE: one short sentence, at most 10 words.',
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
    if (roll < 0.45) return short;
    if (roll < 0.8) return medium;
    return long;
  }

  buildPrompt(persona, partner, budget) {
    const parts = [];
    if (this.topic) {
      parts.push(`Current topic: ${this.topic.title}`);
      if (this.topic.summary) parts.push(`Story summary: ${this.topic.summary}`);
      parts.push(`Source: ${this.topic.source}`);
    }
    if (this.history.length > 0) {
      const transcript = this.history
        .slice(-this.historyTurns)
        .map((t) => `${t.speaker}: ${t.text}`)
        .join('\n');
      parts.push(`Recent transcript:\n${transcript}`);
    }
    const last = this.history[this.history.length - 1];
    if (last && last.speaker === persona.name) {
      parts.push('Your previous line was also yours — this is a follow-on before your co-host can answer: tack on the afterthought ("oh— one more thing"), interrupt yourself, or double down. Keep it short.');
    }
    // Episode arc: each topic cycle is one "episode" with a cold open, a long
    // free middle, a wind-down, and a sign-off. Placed late in the prompt so
    // it outranks the story momentum in the transcript above.
    const remaining = this.turnsPerTopic - this.turnsOnTopic;
    if (this.turnsOnTopic === 0) {
      parts.push(
        'New episode. COLD OPEN: start inside the conversation — a direct question or playful accusation aimed at your co-host ("Be honest—what\'s the most useful thing school taught you that was never in a textbook?"). No radio announcement, no topic framing yet.',
      );
    } else if (this.turnsOnTopic <= 3) {
      parts.push(
        'Still the cold open — keep the banter direct and personal. Once it feels natural, you may frame today\'s theme for the listeners in a single breath, then get back to the conversation.',
      );
    } else if (remaining <= 2) {
      parts.push(
        'SIGN-OFF, right now — no more story questions: invite listeners to send their own story with "!topic your story", land one final callback to this episode\'s running joke, and say a short goodbye.',
      );
    } else if (remaining <= 6) {
      parts.push(
        'The episode is WINDING DOWN — do not open any new story or ask for new details: trade what you each actually took from today\'s stories (one sincere beat may stay sincere) and briefly call back a joke born earlier this episode.',
      );
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
