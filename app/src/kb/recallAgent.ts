// The recall runtime substrate (SPEC-0026 ASK-4, ASK-12 / ORCH-21,22): Ask & Recall is the
// project's first GitHub Copilot **SDK** pilot. This module is the SDK adapter — it turns our
// substrate-agnostic `RecallClient` seam into a real `@github/copilot-sdk` Session: a CLI server
// over JSON-RPC (BYOA — reuses the `copilot` CLI's credentials), our tools registered as native
// typed-tools, the recall skill as the system message, streaming, and read-only enforced via the
// `availableTools` allow-list + `approveAll` (only our read tools are exposed).
//
// The SDK owns the multi-turn loop; recall.ts owns grounding/citation-verification/budget. The
// adapter is the ONLY module that imports the SDK, so the rest stays unit-testable behind the seam.
import { CopilotClient, defineTool, approveAll, RuntimeConnection } from '@github/copilot-sdk';
import type { CopilotClientOptions, SessionConfig, SystemMessageConfig, Tool, ToolHandler } from '@github/copilot-sdk';
import type { RecallClient, RecallSession, RecallSessionConfig, RecallToolDef } from './recall';

/** Version of the recall skill/instruction (for the audit trail; ORCH-16 / SPEC-0014 Q9). */
export const RECALL_SKILL_VERSION = 'recall/v2-sdk';

/**
 * The recall SKILL (ASK-4): teaches the agent the KB's structure + how to ground/cite, so it
 * navigates intentionally instead of blind text-search. Injected as the session system message.
 */
export const RECALL_SKILL = [
  'You are the KB-App Recall agent. Answer the Principal’s question from THEIR knowledge base,',
  'and ground every substantive assertion in real evidence. Retrieve by NAVIGATING the structured',
  'graph with the provided tools — not by blind text search.',
  '',
  'KB STRUCTURE:',
  '- sources/<date>/<id>/source.md — immutable primary ground truth (never changes).',
  '- entities/<kind>/<name>.md — deduped knowledge-graph nodes; frontmatter has id/kind/name/',
  '  aliases, tags (Obsidian Properties — e.g. type/<kind> + topic tags), and provenance.derivedFrom',
  '  (the source dirs it came from). Body may carry a generated claims block and a links block of',
  '  [[wikilinks]] to related nodes.',
  '- claims/<kind>/<subject>.md — one assertion about an entity; frontmatter has subject (the',
  '  entity node it is about), status (fact|interpretation|hypothesis), confidence, and',
  '  provenance.derivedFrom + mentions (verbatim evidence spans).',
  '- [[wikilinks]] connect nodes; provenance links everything back to sources.',
  '',
  'METHOD (multi-hop, entity-centric): find the relevant entity → read its claims → follow its',
  'links → read the underlying source text for exact quotes. Reason about relevance; do not dump.',
  'Mind the retrieval budget: a tool may tell you it is exhausted — then answer with what you have.',
  '',
  'GROUNDING (strict): cite the entity/claim/source each assertion rests on. Prefer claims and',
  'sources as evidence. If the KB does not support something, SAY SO — never present an',
  'unsupported statement as fact. Clearly distinguish KB-grounded facts from your own inference.',
  '',
  'FINISH by calling the submitAnswer tool exactly once, with your markdown answer and the',
  'citations (kind + repo-relative ref) it rests on. Set grounded:false and cite nothing if the',
  'KB does not support an answer.',
].join('\n');

export interface SdkRecallClientOptions {
  /** Default model for sessions (overridable per session). */
  model?: string;
  /**
   * Absolute path to the BYOA `copilot` CLI (SPEC-0030 BUG #65 / ORCH-21). The SDK spawns THIS
   * binary instead of searching for its bundled runtime — which it can't reach inside the packaged
   * app's asar, leaving recall ungrounded. Resolved by the caller (main tier, STACK-9 resolvePath).
   * When absent, the SDK falls back to its default runtime search (fine in dev).
   */
  cliPath?: string;
}

/**
 * Build the production `RecallClient` backed by `@github/copilot-sdk`. Lazily starts one CLI-backed
 * client and opens a fresh Session per question with our tools + skill. Read-only is enforced by
 * the `availableTools` allow-list (only our tools) + `approveAll` over that restricted set.
 */
export function makeSdkRecallClient(opts: SdkRecallClientOptions = {}): RecallClient {
  let client: CopilotClient | null = null;
  // BUG #65: point the SDK at the resolved BYOA `copilot` CLI so it spawns in the packaged app.
  const clientOptions: CopilotClientOptions = opts.cliPath ? { connection: RuntimeConnection.forStdio({ path: opts.cliPath }) } : {};

  return {
    async createSession(config: RecallSessionConfig): Promise<RecallSession> {
      if (!client) client = new CopilotClient(clientOptions);
      const tools: Tool[] = (config.tools ?? []).map((d: RecallToolDef) =>
        defineTool(d.name, {
          description: d.description,
          parameters: d.parameters,
          handler: d.handler as ToolHandler,
        }),
      );
      const sessionConfig: SessionConfig = {
        clientName: 'kb-app-recall',
        model: config.model ?? opts.model,
        systemMessage: config.systemMessage as SystemMessageConfig | undefined,
        tools,
        availableTools: config.allowedTools, // allow-list: ONLY our read tools + submitAnswer (ASK-3)
        onPermissionRequest: approveAll,
      };
      const session = await client.createSession(sessionConfig);
      return {
        sendAndWait: async (prompt: string): Promise<unknown> => session.sendAndWait(prompt),
        disconnect: async (): Promise<void> => {
          await session.disconnect();
        },
      };
    },
    async disconnect(): Promise<void> {
      if (client) await client.stop();
    },
  };
}
