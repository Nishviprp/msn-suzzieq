import { RiskLevel } from '../types.js';

/**
 * Deterministic risk classification. Runs before anything else, on every message.
 *
 * This is rules only, on purpose: it must be testable, explainable and impossible
 * for a model outage to bypass. A trained classifier is added ALONGSIDE this in
 * Phase 3 — it can raise the risk level, never lower it.
 */

export interface RiskResult {
  level: RiskLevel;
  reasonCodes: string[];
  matched: string[];
}

const CRISIS = [
  /\bkill(ing)? (myself|me)\b/i,
  /\bdon'?t want to (be here|live|wake up)\b/i,
  /\bwant to disappear\b/i,
  /\b(want|going|plan) to die\b/i,
  /\bend (my|it all|my life)\b/i,
  /\bsuicid(e|al)\b/i,
  /\bself[- ]?harm\b/i,
  /\bcut(ting)? myself\b/i,
  /\bno reason to (live|go on)\b/i,
  /\bbetter off without me\b/i,
  /\boverdose\b/i,
  /\bhurt (myself|someone)\b/i,
];

/**
 * Physical descriptions that need care now, not suggestions.
 * US wording; reviewed content is approved by a clinician before launch.
 */
const URGENT_MEDICAL = [
  /\bworst (headache|pain) (of my life|ever)\b/i,
  /\b(sudden|thunderclap) (severe )?headache\b/i,
  /\bheadache\b[^.]*\b(fever|stiff neck|confusion|vision loss|head injury|hit my head)\b/i,
  /\b(chest pain|chest tightness)\b/i,
  /\b(can'?t|trouble) breath(e|ing)\b/i,
  /\b(numb|weakness) (on )?one side\b/i,
  /\bslurred speech\b/i,
  /\bfaint(ed|ing)\b/i,
  /\bseizure\b/i,
  /\bcoughing (up )?blood\b/i,
  /\bsuddenly (can'?t|cannot) (see|speak|move)\b/i,
];

const PHYSICAL_SYMPTOM = [
  /\bheadache|migraine\b/i,
  /\b(stomach|back|joint|neck|chest|body) (ache|pain)\b/i,
  /\b(nausea|vomiting|dizzy|dizziness|rash|fever|cough|insomnia)\b/i,
  /\bcan'?t sleep\b/i,
  /\b(my )?(head|stomach|back) hurts\b/i,
  /\bfatigue|exhausted all the time\b/i,
];

const CLINICAL_REQUEST = [
  /\bwhat('?s| is) wrong with me\b/i,
  /\bdiagnos(e|is|ed)\b/i,
  /\bdo i have\b/i,
  /\bshould i (take|stop taking)\b/i,
  /\b(dose|dosage|mg)\b/i,
  /\b(medication|medicine|prescription|antidepressant|ssri)\b/i,
  /\btreat(ment)? (for|plan)\b/i,
  /\bcure\b/i,
];

function firstMatch(text: string, patterns: RegExp[]): string[] {
  return patterns.filter(p => p.test(text)).map(p => p.source);
}

export function classifyRisk(text: string): RiskResult {
  const t = text.normalize('NFKC');

  const crisis = firstMatch(t, CRISIS);
  if (crisis.length) return { level: 'crisis', reasonCodes: ['risk.crisis.pattern'], matched: crisis };

  const urgent = firstMatch(t, URGENT_MEDICAL);
  if (urgent.length) return { level: 'urgent_medical', reasonCodes: ['risk.urgent.red_flag'], matched: urgent };

  const clinical = firstMatch(t, CLINICAL_REQUEST);
  if (clinical.length) return { level: 'clinical_request', reasonCodes: ['risk.clinical.request'], matched: clinical };

  const physical = firstMatch(t, PHYSICAL_SYMPTOM);
  if (physical.length) return { level: 'physical_symptom', reasonCodes: ['risk.clinical.symptom'], matched: physical };

  return { level: 'none', reasonCodes: [], matched: [] };
}

/** A later classifier may only escalate. Order defines severity. */
const SEVERITY: RiskLevel[] = ['none', 'physical_symptom', 'clinical_request', 'urgent_medical', 'crisis'];

export function escalateOnly(a: RiskLevel, b: RiskLevel): RiskLevel {
  return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;
}
