import { Constraints, Intent } from '../types.js';

/**
 * Provider-agnostic model interface (PRD FD-4). Nothing in the product depends
 * on which provider is configured, and every call has a deterministic fallback
 * so an outage degrades instead of failing (AC-10).
 *
 * The model does exactly two jobs: read a request into structured fields, and
 * write friendly wording. It never decides mode, risk, ranking or which
 * listings exist.
 */

export interface Extraction {
  intent: Intent;
  constraints: Constraints;
  declinedQuestions: boolean;
}

export interface LlmProvider {
  name: string;
  extract(text: string): Promise<Extraction>;
  phrase(input: { intent: Intent; count: number; assumptions: string[] }): Promise<string>;
}

const CATEGORY_HINTS: Array<[RegExp, string[]]> = [
  [/\byoga\b/i, ['yoga', 'movement']],
  [/\bmeditat|mindful/i, ['meditation', 'stress']],
  [/\bbreath/i, ['breathwork', 'stress']],
  [/\bwalk|hike|run|move|exercise/i, ['movement', 'outdoors']],
  [/\bsleep|rest|tired\b/i, ['rest']],
  [/\bstress|overwhelm|anxious|burn(t|ed) out|pressure/i, ['stress']],
  [/\blonely|alone|isolat|disconnect|no (friends|one)/i, ['community', 'belonging']],
  [/\bgroup|community|meet people|social/i, ['community', 'belonging', 'social']],
];

const FELT_STATE = /\b(feel|feeling|felt|i'?m so|i am so|been)\b/i;
const HELP = /\b(how do i|how does|what is msn|verified|refund|cancel|booking work)\b/i;

/**
 * Deterministic provider: rules only, no network. Used in development, in tests,
 * and as the fallback whenever the configured provider errors or times out.
 */
export class DeterministicProvider implements LlmProvider {
  name = 'deterministic';

  async extract(text: string): Promise<Extraction> {
    const categories = new Set<string>();
    for (const [re, cats] of CATEGORY_HINTS) if (re.test(text)) cats.forEach(c => categories.add(c));

    const location = text.match(/\b(?:in|near|around)\s+([A-Z][A-Za-z.\- ]{2,30})/)?.[1]?.trim()
      ?? text.match(/\b(\d{5})\b/)?.[1];
    const when = text.match(/\b(today|tonight|tomorrow|this (week|weekend|evening)|next week|morning|evening)\b/i)?.[0];
    const online = /\bonline|virtual|remote|from home\b/i.test(text);
    const inPerson = /\bin[- ]person|near me|nearby\b/i.test(text);
    const free = /\bfree\b/i.test(text);
    const budget = text.match(/\bunder \$?(\d{1,4})\b/i)?.[1];

    const belonging = categories.has('belonging');
    const intent: Intent =
      HELP.test(text) ? 'platform_help'
      : belonging ? 'belonging'
      : FELT_STATE.test(text) ? 'felt_state'
      : categories.size ? 'direct_search'
      : 'unclear';

    return {
      intent,
      constraints: Constraints.parse({
        location,
        when,
        format: online ? 'online' : inPerson ? 'in_person' : 'either',
        maxPriceUsd: free ? 0 : budget ? Number(budget) : undefined,
        categories: [...categories],
      }),
      declinedQuestions: false,
    };
  }

  async phrase({ intent, count, assumptions }: { intent: Intent; count: number; assumptions: string[] }): Promise<string> {
    if (count === 0) return "I couldn't find anything that fits yet. Want to widen the area or the dates?";
    const opener =
      intent === 'belonging' ? 'Some people find it easier to start around others. Here are a few places to land:'
      : intent === 'felt_state' ? 'Here are a few things some people find helpful:'
      : 'Here’s what I found:';
    const tail = assumptions.length ? ` I went with ${assumptions.join(', ')} — tell me if that’s off.` : '';
    return opener + tail;
  }
}

/** Wraps any provider with a timeout and a deterministic fallback. */
export function withFallback(primary: LlmProvider, timeoutMs = 4000): LlmProvider {
  const backup = new DeterministicProvider();
  const race = async <T>(p: Promise<T>, fb: () => Promise<T>): Promise<T> => {
    try {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('llm_timeout')), timeoutMs); });
      const out = await Promise.race([p, timeout]);
      clearTimeout(timer!);
      return out;
    } catch {
      return fb();
    }
  };
  return {
    name: `${primary.name}+fallback`,
    extract: t => race(primary.extract(t), () => backup.extract(t)),
    phrase: i => race(primary.phrase(i), () => backup.phrase(i)),
  };
}
