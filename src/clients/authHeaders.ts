export const V2_AUTH_TOKEN_KEY = 'v2-auth-token';
export const V2_AUTH_REQUIRED_EVENT = 'v2-auth-required';

export function storedAuthToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(V2_AUTH_TOKEN_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function storeAuthToken(token: string): void {
  globalThis.localStorage?.setItem(V2_AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  globalThis.localStorage?.removeItem(V2_AUTH_TOKEN_KEY);
}

export function authenticatedHeaders(init?: HeadersInit, actorId = 'local-operator'): Headers {
  const headers = new Headers(init);
  headers.set('X-Actor-Id', actorId);
  const token = storedAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}
