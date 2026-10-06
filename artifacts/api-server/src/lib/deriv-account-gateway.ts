export type DerivAccountType = 'demo' | 'real';

const DERIV_API_BASE = 'https://api.derivws.com';

function appId(): string {
  const value = String(process.env.DERIV_APP_ID ?? '').trim();
  if (!value) throw new Error('DERIV_APP_ID is required');
  return value;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Deriv-App-ID': appId(),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function requestDeriv<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${DERIV_API_BASE}${path}`, {
    ...init,
    headers: { ...headers(token), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(body?.errors?.[0]?.message ?? body?.error?.message ?? `Deriv HTTP ${response.status}`);
  }
  return body as T;
}

function objects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) objects(item, out);
    return out;
  }
  const item = value as Record<string, unknown>;
  out.push(item);
  for (const child of Object.values(item)) objects(child, out);
  return out;
}

function typeOf(account: Record<string, unknown>): DerivAccountType | null {
  const raw = String(account.account_type ?? account.accountType ?? account.type ?? account.environment ?? account.mode ?? '').toLowerCase();
  if (raw.includes('demo') || raw.includes('virtual') || raw.includes('vrt')) return 'demo';
  if (raw.includes('real') || raw.includes('live') || raw === 'cr' || raw.startsWith('cr')) return 'real';
  return null;
}

function idOf(account: Record<string, unknown>): string | null {
  const id = account.account_id ?? account.accountId ?? account.id ?? account.loginid ?? account.loginId;
  const value = String(id ?? '').trim();
  return value || null;
}

export async function getDerivAccounts(token: string): Promise<unknown> {
  return requestDeriv(token, '/trading/v1/options/accounts');
}

export async function resolveDerivAccount(token: string, accountType: DerivAccountType, preferredAccountId?: string): Promise<string> {
  if (preferredAccountId?.trim()) {
    const requestedId = preferredAccountId.trim();
    const response = await getDerivAccounts(token);
    const match = objects(response).find(account => idOf(account) === requestedId && typeOf(account) === accountType);
    if (!match) throw new Error(`Deriv account ${requestedId} is not a ${accountType} account or is not available to this token`);
    return requestedId;
  }
  const response = await getDerivAccounts(token);
  const match = objects(response).find(account => typeOf(account) === accountType && idOf(account));
  if (!match) throw new Error(`No Deriv Options ${accountType} account found`);
  return idOf(match)!;
}

export async function createDerivAccountContext(token: string, accountType: DerivAccountType, preferredAccountId?: string) {
  const authorizationToken = String(token ?? '').trim();
  if (!authorizationToken) throw new Error('Deriv authorization token is required');
  const accountId = await resolveDerivAccount(authorizationToken, accountType, preferredAccountId);
  const response = await requestDeriv<any>(
    authorizationToken,
    `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: 'POST', body: '{}' },
  );
  const websocketUrl = String(response?.data?.url ?? '').trim();
  if (!websocketUrl) throw new Error('Deriv OTP response did not contain a WebSocket URL');

  const parsed = new URL(websocketUrl);
  const expectedPath = accountType === 'real'
    ? '/trading/v1/options/ws/real'
    : '/trading/v1/options/ws/demo';
  if (parsed.pathname !== expectedPath || !parsed.searchParams.get('otp')) {
    throw new Error(`Deriv account routing mismatch for ${accountType}`);
  }

  return { accountId, accountType, websocketUrl, appId: appId() };
}
