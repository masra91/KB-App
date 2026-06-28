// Past-chats conversation contract (SPEC-0060 VUX-11 slice-2b/2c). PURE types only (no electron/node),
// so the renderer + `types.ts` consume them without pulling the main-process store (`main/
// conversationStore.ts`, which owns the userData persistence) into the renderer bundle. The store
// implements over these shapes; `types.ts` re-exports them as the IPC contract.
import type { AskResult } from './recall';

/** One rendered Q→A exchange in a saved chat: the full AskResult (so a reloaded chat re-renders
 *  FAITHFULLY — citations/grounded/toolCalls intact, not a lossy Q+A transcript), plus when it was
 *  asked + the client-measured latency (optional; the Ask view measures it). */
export interface ConversationTurn {
  result: AskResult;
  askedAt: string;
  latencyMs?: number;
}

/** A saved Ask thread. `id` is a ULID (globally-unique + time-sortable); `title` defaults to the first
 *  question asked. `createdAt` is set once; `updatedAt` bumps on every save. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

/** A list-row for the "Past chats" affordance — enough to render a row without loading every turn. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
}
