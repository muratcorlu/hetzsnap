const BASE = 'https://api.cloudflare.com/client/v4';

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

export function createCloudflareClient(token: string) {
  async function request<T>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<T> {
    const url = new URL(BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  }

  async function findRecord(zoneId: string, name: string): Promise<DnsRecord | null> {
    const data = await request<{ result: DnsRecord[] }>('GET', `/zones/${zoneId}/dns_records`, { type: 'A', name });
    return data.result[0] ?? null;
  }

  async function upsertARecord(zoneId: string, name: string, ip: string): Promise<void> {
    const existing = await findRecord(zoneId, name);
    const record = { type: 'A', name, content: ip, ttl: 60, proxied: false };
    if (existing) {
      await request('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, undefined, record);
    } else {
      await request('POST', `/zones/${zoneId}/dns_records`, undefined, record);
    }
  }

  return { upsertARecord };
}
