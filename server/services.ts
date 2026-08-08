import { DoubaoComplianceAnalyzer } from './providers/doubao';

export function createDoubaoAnalyzer(env: NodeJS.ProcessEnv = process.env): DoubaoComplianceAnalyzer {
  return new DoubaoComplianceAnalyzer(env);
}
