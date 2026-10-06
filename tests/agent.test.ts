import { describe, it, expect, beforeEach } from 'vitest';
import { SuzzieEngine } from '../src/agent/orchestrator.js';
import { FixtureRepository } from '../src/discovery/repository.js';
import { InMemoryStore } from '../src/memory/store.js';
import { classifyRisk } from '../src/safety/classifier.js';
import { DeterministicProvider, withFallback, type LlmProvider } from '../src/llm/adapter.js';

const ask = (engine: SuzzieEngine, text: string, session = 's1', user = 'u1') =>
  engine.handle({ userId: user, sessionId: session, text, country: 'US' });

let engine: SuzzieEngine;
beforeEach(() => { engine = new SuzzieEngine({ repo: new FixtureRepository() }); });

describe('safety comes first', () => {
  it('crisis language enters crisis mode with no listings (AC-3)', async () => {
    const r = await ask(engine, "i don't want to be here anymore, i think about killing myself");
    expect(r.mode).toBe('CRISIS_SUPPORT');
    expect(r.recommendations).toHaveLength(0);
    expect(r.resources.length).toBeGreaterThan(0);
  });

  it('crisis outranks a normal request in the same message', async () => {
    const r = await ask(engine, 'find yoga near me tomorrow, honestly i want to end my life');
    expect(r.mode).toBe('CRISIS_SUPPORT');
    expect(r.recommendations).toHaveLength(0);
  });

  it('red-flag symptoms route to urgent care, not suggestions', async () => {
    for (const text of [
      'worst headache of my life came on suddenly',
      'headache with a fever and stiff neck',
      'chest pain and i cannot breathe',
    ]) {
      const r = await ask(engine, text);
      expect(r.mode, text).toBe('URGENT_MEDICAL');
      expect(r.recommendations, text).toHaveLength(0);
    }
  });
});

describe('the headache case', () => {
  it('states the boundary and never names a cause or treatment (AC-2)', async () => {
    const r = await ask(engine, 'i have a severe headache lately');
    expect(r.mode).toBe('CLINICAL_BOUNDARY');
    expect(r.message).toMatch(/clinician/i);
    expect(r.message).not.toMatch(/\b(caused by|because of|diagnos|you have|you should take|\d+\s?mg)\b/i);
    expect(r.quickActions.some(a => a.id === 'find_consultant')).toBe(true);
  });

  it('offers wellness support alongside, all of it real listings', async () => {
    const r = await ask(engine, 'my back pain is wearing me down');
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations.every(x => x.entityId.startsWith('ent_'))).toBe(true);
  });

  it('medication questions hit the boundary', async () => {
    const r = await ask(engine, 'should i take ibuprofen 400mg for this');
    expect(r.mode).toBe('CLINICAL_BOUNDARY');
  });
});

describe('one question, then just go with it', () => {
  it('asks at most one clarifying question', async () => {
    const first = await ask(engine, 'i want to meet people and feel less alone');
    expect(first.clarifyingQuestion).toBeTruthy();
    const second = await ask(engine, 'i want to meet people and feel less alone');
    expect(second.clarifyingQuestion).toBeNull();
    expect(second.recommendations.length).toBeGreaterThan(0);
  });

  it('"just go with this" proceeds and states assumptions', async () => {
    await ask(engine, 'i feel isolated', 's2');
    const r = await ask(engine, 'just go with this', 's2');
    expect(r.clarifyingQuestion).toBeNull();
    expect(r.assumptions.length).toBeGreaterThan(0);
    expect(r.message).toMatch(/I went with/i);
  });

  it('belonging requests favour groups over solo sessions', async () => {
    const r = await ask(engine, 'i feel lonely in Jersey City and want to be around people', 's3');
    const top = r.recommendations[0];
    expect(['community', 'event', 'nonprofit']).toContain(top?.entityType);
    expect(top.reasonCodes).toContain('rank.belonging_boost');
  });
});

describe('grounding', () => {
  it('never returns an inactive listing (AC-1)', async () => {
    const r = await ask(engine, 'meditation near Jersey City', 's4');
    expect(r.recommendations.map(x => x.entityId)).not.toContain('ent_900');
  });

  it('drops a listing that disappears between search and render', async () => {
    const repo = new FixtureRepository();
    const flaky = {
      search: repo.search.bind(repo),
      byIds: async () => [],          // catalog says: none of these exist now
    };
    const e = new SuzzieEngine({ repo: flaky as any });
    const r = await ask(e, 'online meditation', 's5');
    expect(r.recommendations).toHaveLength(0);
  });

  it('every recommendation carries a reason', async () => {
    const r = await ask(engine, 'yoga in Jersey City this week', 's6');
    expect(r.recommendations.every(x => x.displayReason.length > 0)).toBe(true);
  });
});

describe('memory', () => {
  it('stores nothing without consent', async () => {
    const m = new InMemoryStore();
    expect(await m.add('u1', 'preference', 'prefers evening sessions')).toBeNull();
    expect(await m.list('u1')).toHaveLength(0);
  });

  it('stores preferences once consent is given', async () => {
    const m = new InMemoryStore();
    await m.setConsent('u1', { persistentMemory: true });
    expect(await m.add('u1', 'preference', 'prefers evening sessions in Jersey City')).not.toBeNull();
    expect(await m.list('u1')).toHaveLength(1);
  });

  it('refuses to store health content even when asked to', async () => {
    const m = new InMemoryStore();
    await m.setConsent('u1', { persistentMemory: true });
    for (const bad of ['has migraines', 'diagnosed with anxiety disorder', 'takes 50mg of something']) {
      expect(await m.add('u1', 'preference', bad), bad).toBeNull();
    }
    expect(await m.list('u1')).toHaveLength(0);
  });

  it('keeps users completely separate', async () => {
    const m = new InMemoryStore();
    await m.setConsent('u1', { persistentMemory: true });
    await m.setConsent('u2', { persistentMemory: true });
    await m.add('u1', 'preference', 'likes morning walks');
    expect(await m.list('u2')).toHaveLength(0);
    expect((await m.list('u1'))[0].userId).toBe('u1');
  });

  it('withdrawing consent deletes everything', async () => {
    const m = new InMemoryStore();
    await m.setConsent('u1', { persistentMemory: true });
    await m.add('u1', 'preference', 'likes morning walks');
    await m.setConsent('u1', { persistentMemory: false });
    expect(await m.list('u1')).toHaveLength(0);
  });
});

describe('degrading safely', () => {
  it('a broken provider still produces a valid answer (AC-10)', async () => {
    const broken: LlmProvider = {
      name: 'broken',
      extract: async () => { throw new Error('provider down'); },
      phrase: async () => { throw new Error('provider down'); },
    };
    const e = new SuzzieEngine({ repo: new FixtureRepository(), llm: withFallback(broken, 50) });
    const r = await ask(e, 'online meditation, just go with this', 's7');
    expect(r.mode).toBe('NORMAL_DISCOVERY');
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('a hanging provider times out into the fallback', async () => {
    const hanging: LlmProvider = {
      name: 'hanging',
      extract: () => new Promise(() => {}),
      phrase: () => new Promise(() => {}),
    };
    const e = new SuzzieEngine({ repo: new FixtureRepository(), llm: withFallback(hanging, 30) });
    const r = await ask(e, 'yoga in Jersey City, just show me', 's8');
    expect(r.mode).toBe('NORMAL_DISCOVERY');
  });
});

describe('quiet by default', () => {
  it('says nothing when there is nothing to say (AC-5)', async () => {
    const r = await ask(engine, 'ok', 's9');
    expect(r.mode).toBe('NO_ACTION');
    expect(r.message).toBe('');
  });
});

describe('classifier severity', () => {
  it('ranks crisis above urgent above clinical above symptom', () => {
    expect(classifyRisk('i want to kill myself').level).toBe('crisis');
    expect(classifyRisk('worst headache of my life').level).toBe('urgent_medical');
    expect(classifyRisk('what is wrong with me').level).toBe('clinical_request');
    expect(classifyRisk('my head hurts').level).toBe('physical_symptom');
    expect(classifyRisk('yoga near me').level).toBe('none');
  });
});

describe('extraction', () => {
  it('picks up place, time, format and budget', async () => {
    const p = new DeterministicProvider();
    const e = await p.extract('free online meditation this week near Jersey City');
    expect(e.constraints.format).toBe('online');
    expect(e.constraints.maxPriceUsd).toBe(0);
    expect(e.constraints.categories).toContain('meditation');
    expect(e.constraints.when).toMatch(/this week/i);
  });
});
