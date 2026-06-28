// SPEC-0060 VUX-11 slice-2b/2c — the past-chats conversation store, persisted in Electron userData
// (mocked to a throwaway temp dir; the real fs round-trips). Covers the save→list→load round-trip
// (faithful AskResult), update-by-id, newest-first ordering, corrupt-file isolation (ENG-15/16), and
// the ULID containment guard (a crafted `../` id can never escape the conversations dir).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { ulid } from '../kb/ulid';
import type { AskResult } from '../kb/recall';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return state.userData;
    },
  },
}));

import { saveConversation, listConversations, loadConversation, type ConversationTurn } from './conversationStore';

function result(question: string, answer: string): AskResult {
  return { question, answer, citations: [{ kind: 'claim', ref: 'claims/x.md', label: 'Ada' }], grounded: true, toolCalls: 3, truncated: false };
}
function turn(question: string, answer: string, askedAt = '2026-06-28T00:00:00.000Z'): ConversationTurn {
  return { result: result(question, answer), askedAt, latencyMs: 1200 };
}
const convDir = (): string => path.join(state.userData, 'conversations');

describe('conversationStore (VUX-11 past-chats / save-chat)', () => {
  beforeEach(async () => {
    state.userData = await makeTempDir('kb-userdata-conv-');
  });
  afterEach(async () => {
    await rmTempDir(state.userData);
  });

  it('first run: no conversations dir yet → list is empty, load is null (never a crash)', async () => {
    expect(await listConversations()).toEqual([]);
    expect(await loadConversation(ulid())).toBeNull();
  });

  it('save → load round-trips the FULL AskResult (citations/grounded/toolCalls intact, not lossy)', async () => {
    const { id } = await saveConversation([turn('Who is Ada?', 'Ada Lovelace, the mathematician.')]);
    const loaded = await loadConversation(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(id);
    expect(loaded!.turns).toHaveLength(1);
    expect(loaded!.turns[0].result.answer).toBe('Ada Lovelace, the mathematician.');
    expect(loaded!.turns[0].result.citations[0].ref).toBe('claims/x.md'); // faithful re-render data
    expect(loaded!.turns[0].result.grounded).toBe(true);
    expect(loaded!.turns[0].latencyMs).toBe(1200);
  });

  it('auto-titles from the first question; the summary previews the last answer', async () => {
    await saveConversation([turn('What is the Analytical Engine?', 'A mechanical general-purpose computer.'), turn('Who designed it?', 'Charles Babbage.')]);
    const [s] = await listConversations();
    expect(s.title).toBe('What is the Analytical Engine?');
    expect(s.turnCount).toBe(2);
    expect(s.preview).toBe('Charles Babbage.'); // last answer, one line
  });

  it('lists newest-first by updatedAt', async () => {
    await saveConversation([turn('first', 'a1')], { now: () => '2026-06-28T01:00:00.000Z', newId: () => ulid(1) });
    await saveConversation([turn('second', 'a2')], { now: () => '2026-06-28T03:00:00.000Z', newId: () => ulid(3) });
    await saveConversation([turn('third', 'a3')], { now: () => '2026-06-28T02:00:00.000Z', newId: () => ulid(2) });
    expect((await listConversations()).map((s) => s.title)).toEqual(['second', 'third', 'first']);
  });

  it('update-by-id keeps createdAt, bumps updatedAt, replaces the turns (save-chat as a thread grows)', async () => {
    const { id } = await saveConversation([turn('q1', 'a1')], { now: () => '2026-06-28T00:00:00.000Z' });
    await saveConversation([turn('q1', 'a1'), turn('q2', 'a2')], { id, now: () => '2026-06-28T05:00:00.000Z' });
    const loaded = await loadConversation(id);
    expect(loaded!.createdAt).toBe('2026-06-28T00:00:00.000Z'); // preserved
    expect(loaded!.updatedAt).toBe('2026-06-28T05:00:00.000Z'); // bumped
    expect(loaded!.turns).toHaveLength(2); // replaced with the grown thread
    expect((await listConversations())).toHaveLength(1); // still ONE conversation, not two
  });

  it('an explicit title wins over the auto-derived one', async () => {
    const { id } = await saveConversation([turn('q', 'a')], { title: '  Ada research  ' });
    expect((await loadConversation(id))!.title).toBe('Ada research'); // trimmed
  });

  it('ENG-15/16: a corrupt file in the dir is SKIPPED by list, never throws', async () => {
    await saveConversation([turn('good', 'a')]);
    await fs.mkdir(convDir(), { recursive: true });
    await fs.writeFile(path.join(convDir(), 'broken.json'), '{ not json');
    const list = await listConversations();
    expect(list).toHaveLength(1); // the good one survives; the corrupt one is dropped
    expect(list[0].title).toBe('good');
  });

  it('tolerates partial/legacy turns (missing result) without crashing the title/preview', async () => {
    const legacy = [{ askedAt: '2026-06-28T00:00:00.000Z' } as unknown as ConversationTurn, turn('real q', 'real a')];
    const { id } = await saveConversation(legacy);
    const [s] = await listConversations();
    expect(s.title).toBe('real q'); // first NON-EMPTY question
    expect(await loadConversation(id)).not.toBeNull();
  });

  it('CONTAINMENT: load rejects a crafted non-ULID id (no path traversal out of conversations/)', async () => {
    // Plant a file outside the conversations dir; a traversal id must NOT reach it.
    await fs.writeFile(path.join(state.userData, 'secret.json'), JSON.stringify({ id: 'x', turns: [] }));
    expect(await loadConversation('../secret')).toBeNull();
    expect(await loadConversation('../../etc/passwd')).toBeNull();
    expect(await loadConversation('not-a-ulid')).toBeNull();
    expect(await loadConversation('')).toBeNull();
  });
});
