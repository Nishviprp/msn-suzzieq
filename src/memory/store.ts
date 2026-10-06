/**
 * Memory.
 *
 * Step A ships session-only memory. The interface below is the one Step B
 * implements against Postgres, so persistence is a swap, not a rewrite.
 *
 * Rules baked into the design:
 *  - Everything is scoped to one userId. Nothing is readable across users.
 *  - Only three kinds of thing are ever stored, and none of them is a diagnosis,
 *    a symptom, or an inferred health condition.
 *  - Persistence is off until the user opts in (`consent.persistentMemory`).
 *  - The user can list, edit and delete every item.
 */

export type MemoryKind = 'preference' | 'visit_summary' | 'interaction';

export interface MemoryItem {
  id: string;
  userId: string;
  kind: MemoryKind;
  /** Plain text the user would recognize as their own. No inferences. */
  content: string;
  createdAt: string;
  /** Hard delete date. Step B default: 12 months after creation. */
  expiresAt?: string;
}

export interface Consent {
  persistentMemory: boolean;
  proactiveSuggestions: boolean;
  updatedAt: string;
}

export interface MemoryStore {
  consent(userId: string): Promise<Consent>;
  setConsent(userId: string, consent: Partial<Omit<Consent, 'updatedAt'>>): Promise<Consent>;
  list(userId: string): Promise<MemoryItem[]>;
  add(userId: string, kind: MemoryKind, content: string): Promise<MemoryItem | null>;
  remove(userId: string, id: string): Promise<boolean>;
  clear(userId: string): Promise<number>;
}

/** Anything matching these never enters memory, whatever the caller passes. */
const NEVER_STORE = [
  /\bheadache|migraine|pain|nausea|dizzy|fever|rash|insomnia\b/i,
  /\bdiagnos(is|ed)|depress(ed|ion)|anxiety disorder|ptsd|bipolar|adhd\b/i,
  /\bmedication|prescription|mg\b/i,
  /\bsuicid|self[- ]?harm\b/i,
];

export function isStorable(content: string): boolean {
  return !NEVER_STORE.some(p => p.test(content));
}

let counter = 0;
const newId = () => `mem_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** In-memory implementation used by Step A and by tests. */
export class InMemoryStore implements MemoryStore {
  private items = new Map<string, MemoryItem[]>();
  private consents = new Map<string, Consent>();

  async consent(userId: string): Promise<Consent> {
    return this.consents.get(userId)
      ?? { persistentMemory: false, proactiveSuggestions: false, updatedAt: new Date(0).toISOString() };
  }

  async setConsent(userId: string, patch: Partial<Omit<Consent, 'updatedAt'>>): Promise<Consent> {
    const next: Consent = { ...(await this.consent(userId)), ...patch, updatedAt: new Date().toISOString() };
    this.consents.set(userId, next);
    if (!next.persistentMemory) await this.clear(userId);   // withdrawing consent deletes the data
    return next;
  }

  async list(userId: string): Promise<MemoryItem[]> {
    return [...(this.items.get(userId) ?? [])];
  }

  async add(userId: string, kind: MemoryKind, content: string): Promise<MemoryItem | null> {
    const consent = await this.consent(userId);
    if (!consent.persistentMemory) return null;     // no consent, no storage
    if (!isStorable(content)) return null;          // health content never stored
    const item: MemoryItem = { id: newId(), userId, kind, content, createdAt: new Date().toISOString() };
    const rows = this.items.get(userId) ?? [];
    rows.push(item);
    this.items.set(userId, rows);
    return item;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = this.items.get(userId) ?? [];
    const next = rows.filter(r => r.id !== id);
    this.items.set(userId, next);
    return next.length !== rows.length;
  }

  async clear(userId: string): Promise<number> {
    const n = (this.items.get(userId) ?? []).length;
    this.items.set(userId, []);
    return n;
  }
}
