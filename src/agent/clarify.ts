import type { Constraints } from '../types.js';

/**
 * The "just go with this" rule.
 *
 * The agent may ask at most ONE clarifying question per conversation, and only
 * when the answer would actually change the results. If the user declines, or
 * has already been asked, we proceed on best effort and state our assumptions
 * instead of asking again.
 */

const DECLINE = [
  /\bjust go\b/i,
  /\bgo (ahead|with (this|that|it))\b/i,
  /\bthat'?s (it|all)\b/i,
  /\bno more questions\b/i,
  /\bskip\b/i,
  /\bwhatever\b/i,
  /\bdon'?t (know|care)\b/i,
  /\bjust show me\b/i,
];

export function userDeclinedQuestions(text: string): boolean {
  return DECLINE.some(p => p.test(text));
}

export interface ClarifyDecision {
  ask: string | null;
  assumptions: string[];
  reasonCodes: string[];
}

export interface ClarifyInput {
  constraints: Constraints;
  alreadyAskedThisSession: boolean;
  userDeclined: boolean;
  candidateCount: number;
}

/**
 * Ask only when: we haven't asked yet, the user hasn't waved us off, and a
 * missing constraint is genuinely blocking (too many or too few candidates).
 */
export function decideClarification(input: ClarifyInput): ClarifyDecision {
  const { constraints, alreadyAskedThisSession, userDeclined, candidateCount } = input;
  const assumptions: string[] = [];

  const mustProceed = alreadyAskedThisSession || userDeclined;

  if (!constraints.location && !mustProceed && candidateCount > 6) {
    return {
      ask: 'Whereabouts are you, roughly? A city or ZIP is enough.',
      assumptions: [],
      reasonCodes: ['clarify.location.blocking'],
    };
  }

  // Proceeding: say out loud what we filled in, so the user can correct it.
  if (!constraints.location) assumptions.push('showing both online options and anything nationwide');
  if (!constraints.when) assumptions.push('looking at the next two weeks');
  if (constraints.maxPriceUsd === undefined) assumptions.push('including free and paid options');

  return {
    ask: null,
    assumptions,
    reasonCodes: mustProceed ? ['clarify.skipped.user_declined'] : ['clarify.not_needed'],
  };
}
