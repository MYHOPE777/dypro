export type DisplayLink = {
  alias: string;
  sessionId: string;
  expiresAt: number;
  path: string;
};

export class DisplayLinkClient {
  constructor(private readonly baseUrl = '') {}

  async create(sessionId: string): Promise<DisplayLink> {
    const response = await fetch(`${this.baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/display-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'local-operator' },
    });
    const payload = await response.json() as DisplayLink | { message?: string };
    if (!response.ok) throw new Error('message' in payload && payload.message ? payload.message : `生成主播屏入口失败 (${response.status})`);
    return payload as DisplayLink;
  }
}
