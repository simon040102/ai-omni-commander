/**
 * Structured review result from CodeReviewAgent.
 */
export interface ReviewIssue {
  severity: 'critical' | 'warning' | 'info';
  file: string;
  line?: number;
  message: string;
}

export interface ReviewResult {
  verdict: 'pass' | 'fail';
  score: number; // 0-100
  issues: ReviewIssue[];
  summary: string;
}
