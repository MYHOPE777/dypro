import { DoubaoComplianceAnalyzer } from './providers/doubao';
import { createKnowledgeBase } from './knowledgeBase';

export function createDoubaoAnalyzer(): DoubaoComplianceAnalyzer {
  return new DoubaoComplianceAnalyzer(process.env, createKnowledgeBase());
}
