// Shared fixture for SPEC-0026 recall tests: a tiny but REAL evergreen graph on disk, built
// with the production renderers (renderEntityNode/renderClaimMd + the generated link/claims
// blocks) so the recall tools parse exactly what Connect/Claims actually write.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './tempVault';
import { renderEntityNode, applyLinksBlock, type EntityNode } from '../src/kb/connectDoc';
import { renderClaimMd, applyClaimsBlock } from '../src/kb/claimDoc';
import type { ClaimDecision } from '../src/kb/claims';
import { ulid } from '../src/kb/ulid';

export interface RecallVault {
  root: string;
  sourceDir: string; // repo-relative
  adaRel: string;
  engineRel: string;
  claimRel: string;
}

/** Ada Lovelace ↔ Analytical Engine: two linked entities, one grounded claim, one source. */
export async function buildRecallVault(): Promise<RecallVault> {
  const root = await makeTempDir('kb-recall-');
  const sourceDir = 'sources/2026/06/01/SRC1';
  const adaRel = 'entities/person/ada-lovelace.md';
  const engineRel = 'entities/concept/analytical-engine.md';
  const claimRel = 'claims/person/ada-lovelace.md';
  const ts = '2026-06-01T00:00:00.000Z';

  await fs.mkdir(path.join(root, sourceDir), { recursive: true });
  await fs.writeFile(
    path.join(root, sourceDir, 'source.md'),
    '---\nid: SRC1\n---\n\nAda Lovelace worked on the Analytical Engine and is regarded as the first computer programmer.\n',
  );

  // Ada: links to the engine (links block) + a claims-block backlink to the claim file.
  const ada: EntityNode = {
    id: ulid(),
    kind: 'person',
    name: 'Ada Lovelace',
    confidence: 0.92,
    aliases: ['Ada', 'Lovelace'],
    tags: ['type/person', 'mathematician'],
    derivedFrom: [sourceDir],
    resolvedFrom: [],
    createdAt: ts,
    updatedAt: ts,
  };
  let adaMd = renderEntityNode(ada);
  adaMd = applyLinksBlock(adaMd, [{ targetRel: engineRel }]);
  adaMd = applyClaimsBlock(adaMd, [
    { claimPath: claimRel, statement: 'Ada Lovelace is regarded as the first computer programmer.', status: 'fact', confidence: 0.8 },
  ]);
  await fs.mkdir(path.join(root, 'entities', 'person'), { recursive: true });
  await fs.writeFile(path.join(root, adaRel), adaMd);

  // Engine: links back to Ada → an incoming backlink for Ada.
  const engine: EntityNode = {
    id: ulid(),
    kind: 'concept',
    name: 'Analytical Engine',
    confidence: 0.85,
    aliases: [],
    tags: ['type/concept'],
    derivedFrom: [sourceDir],
    resolvedFrom: [],
    createdAt: ts,
    updatedAt: ts,
  };
  let engineMd = renderEntityNode(engine);
  engineMd = applyLinksBlock(engineMd, [{ targetRel: adaRel }]);
  await fs.mkdir(path.join(root, 'entities', 'concept'), { recursive: true });
  await fs.writeFile(path.join(root, engineRel), engineMd);

  // One grounded claim about Ada.
  const claim: ClaimDecision = {
    statement: 'Ada Lovelace is regarded as the first computer programmer.',
    status: 'fact',
    confidence: 0.8,
    mentions: ['first computer programmer'],
    relatesTo: ['Analytical Engine'],
  };
  const claimMd = renderClaimMd(claim, { id: ulid(), subject: adaRel, derivedFrom: sourceDir, createdAt: ts });
  await fs.mkdir(path.join(root, 'claims', 'person'), { recursive: true });
  await fs.writeFile(path.join(root, claimRel), claimMd);

  return { root, sourceDir, adaRel, engineRel, claimRel };
}
