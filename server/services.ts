import { DoubaoComplianceAnalyzer } from './providers/doubao';
import { createKnowledgeBase } from './knowledgeBase';
import type { ComplianceKnowledgeBase } from './knowledgeBase';

export function createDoubaoAnalyzer(env: NodeJS.ProcessEnv = process.env, knowledgeBase: ComplianceKnowledgeBase = createKnowledgeBase(env)): DoubaoComplianceAnalyzer {
  return new DoubaoComplianceAnalyzer(env, knowledgeBase);
}
