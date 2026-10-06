/**
 * Safety copy and resources.
 *
 * CRISIS_CONTENT_APPROVED stays false until a qualified reviewer signs off the
 * wording and the resource list (PRD FD-5). The engine refuses to start in
 * production while it is false — see engine guard in orchestrator.ts.
 *
 * Launch scope: US only.
 */
export const CRISIS_CONTENT_APPROVED = false;

export interface Resource { label: string; detail: string }

/** DRAFT — pending clinical/legal review. Do not ship as-is. */
export const US_CRISIS_RESOURCES: Resource[] = [
  { label: '988 Suicide & Crisis Lifeline', detail: 'Call or text 988, 24/7, free and confidential.' },
  { label: 'Crisis Text Line', detail: 'Text HOME to 741741.' },
  { label: 'Emergency services', detail: 'Call 911 if you or someone else is in immediate danger.' },
];

export const CRISIS_MESSAGE =
  "I'm glad you told me. What you're describing sounds heavy, and you deserve support from a real person right now — not from me. Here are ways to reach someone who can help straight away.";

export const URGENT_MEDICAL_MESSAGE =
  "What you're describing can be serious and it needs a medical opinion now, not suggestions from me. Please contact a doctor or urgent care, or call 911 if it's severe or getting worse.";

export const CLINICAL_BOUNDARY_MESSAGE =
  "I can't help with what's causing that or what to take for it — that's for a clinician. What I can do is help you find wellness support alongside whatever care you get.";

export const SYMPTOM_PIVOT =
  "If you'd like, I can look for gentle movement, rest and stress support near you in the meantime.";
