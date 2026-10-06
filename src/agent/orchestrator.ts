import { AgentRequest, AgentResponse, Mode, type Recommendation } from '../types.js';
import { classifyRisk } from '../safety/classifier.js';
import {
  CRISIS_CONTENT_APPROVED, CRISIS_MESSAGE, US_CRISIS_RESOURCES,
  URGENT_MEDICAL_MESSAGE, CLINICAL_BOUNDARY_MESSAGE, SYMPTOM_PIVOT,
} from '../safety/content.js';
import { decideClarification, userDeclinedQuestions } from './clarify.js';
import { type EntityRepository, type SearchResult, toRecommendation } from '../discovery/repository.js';
import type { ZipIndex } from '../geo/zip.js';
import { RELEVANCE_FLOOR, type Embedder, type VectorIndex } from '../discovery/embeddings.js';
import { DeterministicProvider, type LlmProvider } from '../llm/adapter.js';
import type { MemoryStore } from '../memory/store.js';
import { InMemoryStore } from '../memory/store.js';

/**
 * The agent loop. Every surface calls this and nothing else.
 *
 * Fixed order, always:
 *   1 risk  →  2 mode  →  3 extract  →  4 clarify?  →  5 search
 *   →  6 phrase  →  7 validate (re-resolve every id against the catalog)
 *
 * Steps 1, 2, 5 and 7 are ordinary code. The model only touches 3 and 6.
 */

export interface SessionState {
  askedClarifyingQuestion: boolean;
  declinedQuestions: boolean;
}

export interface EngineDeps {
  repo: EntityRepository;
  /** US ZIP/city index. Without it, location falls back to text matching. */
  zips?: ZipIndex;
  /** Meaning-based retrieval. Both must be present for it to be used. */
  embedder?: Embedder;
  vectors?: VectorIndex;
  llm?: LlmProvider;
  memory?: MemoryStore;
  sessions?: Map<string, SessionState>;
  now?: () => Date;
}

let traceCounter = 0;
const newTraceId = () => `tr_${Date.now().toString(36)}_${(traceCounter++).toString(36)}`;

export class SuzzieEngine {
  private readonly repo: EntityRepository;
  private readonly llm: LlmProvider;
  private readonly memory: MemoryStore;
  private readonly sessions: Map<string, SessionState>;
  private readonly zips?: ZipIndex;
  private readonly embedder?: Embedder;
  private readonly vectors?: VectorIndex;

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.zips = deps.zips;
    this.embedder = deps.embedder;
    this.vectors = deps.vectors;
    this.llm = deps.llm ?? new DeterministicProvider();
    this.memory = deps.memory ?? new InMemoryStore();
    this.sessions = deps.sessions ?? new Map();

    // Production guard: unapproved crisis content must never reach real users.
    if (process.env.NODE_ENV === 'production' && !CRISIS_CONTENT_APPROVED) {
      throw new Error('refusing to start: crisis content is not approved (PRD FD-5)');
    }
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) { s = { askedClarifyingQuestion: false, declinedQuestions: false }; this.sessions.set(id, s); }
    return s;
  }

  async handle(raw: unknown): Promise<AgentResponse> {
    const req = AgentRequest.parse(raw);
    const traceId = newTraceId();
    const session = this.session(req.sessionId);
    const reasonCodes: string[] = [];

    // 1 — risk, on every message, before anything else.
    const risk = classifyRisk(req.text);
    reasonCodes.push(...risk.reasonCodes);

    // 2 — mode. Deterministic, and severity always wins over intent.
    if (risk.level === 'crisis') {
      return this.finish({
        mode: 'CRISIS_SUPPORT', intent: 'crisis', riskLevel: risk.level,
        message: CRISIS_MESSAGE,
        resources: US_CRISIS_RESOURCES,
        quickActions: [{ id: 'close', label: 'Close', kind: 'dismiss' }],
        canContinue: true, traceId, reasonCodes: [...reasonCodes, 'mode.crisis'],
      });
    }

    if (risk.level === 'urgent_medical') {
      return this.finish({
        mode: 'URGENT_MEDICAL', intent: 'clinical', riskLevel: risk.level,
        message: URGENT_MEDICAL_MESSAGE,
        resources: [{ label: 'Emergency services', detail: 'Call 911 if this is severe or getting worse.' }],
        quickActions: [{ id: 'close', label: 'Close', kind: 'dismiss' }],
        canContinue: true, traceId, reasonCodes: [...reasonCodes, 'mode.urgent_medical'],
      });
    }

    // 3 — extraction (model, with deterministic fallback).
    const extracted = await this.llm.extract(req.text);
    if (userDeclinedQuestions(req.text)) session.declinedQuestions = true;

    // Physical symptoms and clinical asks: state the boundary, then offer the
    // wellness side only — never a cause, never a treatment.
    if (risk.level === 'physical_symptom' || risk.level === 'clinical_request') {
      // The boundary hand-off is exactly when professional services belong.
      const candidates = await this.repo.search(
        { ...extracted.constraints, categories: [...new Set([...extracted.constraints.categories, 'stress', 'rest'])] },
        { limit: 3, allowClinical: true },
      );
      return this.finish({
        mode: 'CLINICAL_BOUNDARY', intent: 'clinical', riskLevel: risk.level,
        message: `${CLINICAL_BOUNDARY_MESSAGE} ${SYMPTOM_PIVOT}`,
        recommendations: candidates.map(toRecommendation),
        quickActions: [
          { id: 'find_consultant', label: 'Find a consultant', kind: 'navigate', value: '/directory/clinicians' },
          { id: 'close', label: 'Not now', kind: 'dismiss' },
        ],
        canContinue: true, traceId, reasonCodes: [...reasonCodes, 'mode.clinical_boundary'],
      });
    }

    if (extracted.intent === 'unclear' && req.text.trim().length < 3) {
      return this.finish({
        mode: 'NO_ACTION', intent: 'unclear', riskLevel: risk.level,
        message: '', canContinue: true, traceId, reasonCodes: [...reasonCodes, 'mode.no_action'],
      });
    }

    // 4–5 — clarify at most once, then search.
    const belonging = extracted.intent === 'belonging';
    const place = this.zips?.resolve(extracted.constraints.location) ?? null;
    const semantic = await this.meaningScores(req.text);
    if (semantic) reasonCodes.push(`retrieval.semantic:${semantic.size}`);
    // Only show treatment facilities when the member is actually looking for one.
    const asksForProfessional = /\b(therapist|counsell?or|counsell?ing|psychiatrist|psychologist|treatment|rehab|clinic|professional help)\b/i.test(req.text);
    const found = await this.searchCoverage(extracted.constraints, {
      belonging, limit: 12, place, semantic, allowClinical: asksForProfessional,
    });
    if (asksForProfessional) reasonCodes.push('discovery.clinical_allowed');
    const candidates = found.entities;

    const clarify = decideClarification({
      constraints: extracted.constraints,
      alreadyAskedThisSession: session.askedClarifyingQuestion,
      userDeclined: session.declinedQuestions || extracted.declinedQuestions,
      candidateCount: candidates.length,
    });
    reasonCodes.push(...clarify.reasonCodes);

    if (clarify.ask) {
      session.askedClarifyingQuestion = true;
      return this.finish({
        mode: 'NORMAL_DISCOVERY', intent: extracted.intent, riskLevel: risk.level,
        message: '', clarifyingQuestion: clarify.ask,
        quickActions: [{ id: 'skip', label: 'Just show me what you have', kind: 'refine', value: 'just go with this' }],
        canContinue: true, traceId, reasonCodes,
      });
    }

    const top = candidates.slice(0, 5);

    // 6 — wording, plus an honest note when we had to widen the search.
    let message = await this.llm.phrase({ intent: extracted.intent, count: top.length, assumptions: clarify.assumptions });
    if (found.onlineOnly) {
      message = `I couldn't find anything within reach of ${place?.label ?? 'you'} yet, so these are online — you can join them from anywhere. ${message}`;
      reasonCodes.push('coverage.online_fallback');
    } else if (found.widened) {
      message = `Nothing very close, so I widened the search to about ${found.radiusUsed} miles. ${message}`;
      reasonCodes.push('coverage.widened');
    }

    // 7 — validate: every id re-resolved against the live catalog before it ships.
    const recs = await this.groundRecommendations(top.map(toRecommendation));

    return this.finish({
      mode: 'NORMAL_DISCOVERY', intent: extracted.intent, riskLevel: risk.level,
      message, assumptions: clarify.assumptions, recommendations: recs,
      searchedNear: place?.label ?? extracted.constraints.location ?? null,
      quickActions: [{ id: 'close', label: 'Not now', kind: 'dismiss' }],
      canContinue: true, traceId, reasonCodes,
    });
  }

  /**
   * Scores the whole catalog against what the member actually said. Returns
   * undefined when embeddings aren't configured, and on any failure — meaning
   * search degrades to keywords rather than breaking (AC-10).
   */
  private async meaningScores(text: string): Promise<Map<string, number> | undefined> {
    if (!this.embedder || !this.vectors) return undefined;
    try {
      const [query] = await this.embedder.embed([text]);
      const hits = this.vectors.search(query, 200, RELEVANCE_FLOOR);
      return new Map(hits.map(h => [h.id, h.score]));
    } catch (err) {
      console.error('[suzzie] meaning search unavailable, falling back to keywords:', err);
      return undefined;
    }
  }

  /** Uses coverage-aware search when the repository offers it. */
  private async searchCoverage(c: Parameters<EntityRepository['search']>[0], opts: Parameters<NonNullable<EntityRepository['searchWithCoverage']>>[1]): Promise<SearchResult> {
    if (this.repo.searchWithCoverage) return this.repo.searchWithCoverage(c, opts);
    const entities = await this.repo.search(c, opts);
    return { entities, widened: false, onlineOnly: false, radiusUsed: Infinity };
  }

  /** Drops anything that isn't a live, active listing right now (AC-1). */
  private async groundRecommendations(recs: Recommendation[]): Promise<Recommendation[]> {
    const live = await this.repo.byIds(recs.map(r => r.entityId));
    const byId = new Map(live.map(e => [e.id, e]));
    return recs
      .filter(r => byId.has(r.entityId))
      .map(r => {
        const e = byId.get(r.entityId)!;
        return { ...r, name: e.name, verified: e.verified, source: e.source, format: e.format, priceUsd: e.priceUsd, bookingUrl: e.bookingUrl };
      });
  }

  private finish(draft: Record<string, unknown>): AgentResponse {
    // The schema is the last gate: a malformed response throws rather than renders.
    return AgentResponse.parse({
      clarifyingQuestion: null, assumptions: [], recommendations: [], quickActions: [], resources: [], searchedNear: null,
      ...draft,
    });
  }
}

export { Mode };
