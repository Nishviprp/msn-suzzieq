import { z } from 'zod';

/**
 * Response modes. The policy layer picks exactly one, deterministically,
 * before any model is called. The UI renders differently per mode.
 */
export const Mode = z.enum([
  'NORMAL_DISCOVERY',   // ordinary wellness navigation
  'PLATFORM_HELP',      // questions about how MSN works
  'CLINICAL_BOUNDARY',  // physical symptom / diagnosis / medication request
  'URGENT_MEDICAL',     // red-flag symptom: seek care now
  'CRISIS_SUPPORT',     // self-harm / suicide / emergency signals
  'NO_ACTION',          // nothing warranted; stay quiet
]);
export type Mode = z.infer<typeof Mode>;

export const RiskLevel = z.enum(['none', 'physical_symptom', 'clinical_request', 'urgent_medical', 'crisis']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Intent = z.enum([
  'direct_search',
  'felt_state',
  'belonging',
  'platform_help',
  'clinical',
  'crisis',
  'unclear',
]);
export type Intent = z.infer<typeof Intent>;

/** What the user is looking for, extracted from their words. Never inferred sensitive traits. */
export const Constraints = z.object({
  location: z.string().optional(),
  radiusMiles: z.number().positive().optional(),
  when: z.string().optional(),          // free text: "this week", "tomorrow morning"
  format: z.enum(['in_person', 'online', 'either']).default('either'),
  maxPriceUsd: z.number().nonnegative().optional(),
  categories: z.array(z.string()).default([]),
  language: z.string().optional(),
});
export type Constraints = z.infer<typeof Constraints>;

export const EntityType = z.enum(['practitioner', 'event', 'community', 'venue', 'business', 'nonprofit']);
export type EntityType = z.infer<typeof EntityType>;

export const Entity = z.object({
  id: z.string(),
  type: EntityType,
  name: z.string(),
  active: z.boolean(),
  categories: z.array(z.string()),
  city: z.string().optional(),
  state: z.string().optional(),          // US-only for launch
  zip: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  format: z.enum(['in_person', 'online', 'hybrid']),
  priceUsd: z.number().nonnegative().optional(),
  verified: z.boolean().default(false),
  bookingUrl: z.string().optional(),
  summary: z.string().optional(),
  /** Where this listing came from. Drives the trust badge the user sees. */
  source: z.enum(['msn_curated', 'partner_claimed', 'public_open_data']).default('msn_curated'),
  /** ISO date this listing was last confirmed. Public listings go stale after 90 days. */
  lastCheckedAt: z.string().optional(),
  contactEmail: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  schedule: z.string().optional(),
  accessibility: z.string().optional(),
  languages: z.array(z.string()).default([]),
});
export type Entity = z.infer<typeof Entity>;

export const Recommendation = z.object({
  entityId: z.string(),
  entityType: EntityType,
  name: z.string(),
  reasonCodes: z.array(z.string()),      // auditable: why it matched
  displayReason: z.string(),             // one plain sentence for the card
  verified: z.boolean(),
  source: z.enum(['msn_curated', 'partner_claimed', 'public_open_data']),
  format: z.string(),
  priceUsd: z.number().nonnegative().optional(),
  bookingUrl: z.string().optional(),
  distanceMiles: z.number().nonnegative().optional(),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const QuickAction = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['refine', 'navigate', 'call', 'dismiss']),
  value: z.string().optional(),
});

export const AgentResponse = z.object({
  mode: Mode,
  intent: Intent,
  riskLevel: RiskLevel,
  message: z.string(),
  clarifyingQuestion: z.string().nullable().default(null),
  assumptions: z.array(z.string()).default([]),   // what we proceeded on when the user said "just go with it"
  recommendations: z.array(Recommendation).default([]),
  quickActions: z.array(QuickAction).default([]),
  resources: z.array(z.object({ label: z.string(), detail: z.string() })).default([]),
  canContinue: z.boolean().default(true),
  /** What we searched around, e.g. "Austin, TX" — so the user can correct it. */
  searchedNear: z.string().nullable().default(null),
  traceId: z.string(),
  reasonCodes: z.array(z.string()).default([]),
})
  // Invariants the UI can rely on, enforced by the schema itself.
  .refine(r => r.mode !== 'CRISIS_SUPPORT' || r.recommendations.length === 0, {
    message: 'crisis mode must not carry recommendations',
  })
  .refine(r => r.mode !== 'URGENT_MEDICAL' || r.recommendations.length === 0, {
    message: 'urgent medical mode must not carry recommendations',
  })
  .refine(r => r.mode !== 'NO_ACTION' || (r.recommendations.length === 0 && r.message === ''), {
    message: 'no-action must be silent',
  })
  .refine(r => !(r.clarifyingQuestion && r.clarifyingQuestion.length > 0) || r.mode === 'NORMAL_DISCOVERY', {
    message: 'only discovery may ask a clarifying question',
  });
export type AgentResponse = z.infer<typeof AgentResponse>;

export const AgentRequest = z.object({
  userId: z.string(),                 // pseudonymous id; never an email
  sessionId: z.string(),
  text: z.string(),
  inputMode: z.enum(['typed', 'voice']).default('typed'),
  pageContext: z.object({ pageType: z.string(), entityId: z.string().optional() }).optional(),
  country: z.literal('US').default('US'),   // launch scope: US only
}).strict();
export type AgentRequest = z.infer<typeof AgentRequest>;
