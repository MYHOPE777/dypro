import { storeAuthToken } from './authHeaders';

export class AuthClient {
  async login(actorId: string, password: string): Promise<void> {
    const response = await fetch('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId, password }),
    });
    const payload = await response.json().catch(() => ({})) as { token?: string; message?: string };
    if (!response.ok || !payload.token) throw new Error(payload.message ?? '登录失败');
    storeAuthToken(payload.token);
  }
}
