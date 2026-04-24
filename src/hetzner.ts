const BASE = 'https://api.hetzner.cloud/v1';

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  created: string; // ISO 8601
  public_net: { ipv4: { ip: string } };
}

export interface HetznerImage {
  id: number;
  description: string;
  type: string;
  status: string;
  created: string; // ISO 8601
  image_size: number | null; // compressed size in GB
}

export class ApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`${method} ${url} → ${status}`);
  }
}

export function createHetznerClient(token: string) {
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
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(method, url.toString(), res.status, data);
    return data as T;
  }

  async function findServer(name: string): Promise<HetznerServer | null> {
    const data = await request<{ servers: HetznerServer[] }>('GET', '/servers', { name });
    return data.servers[0] ?? null;
  }

  async function findSshKeyByName(name: string): Promise<number> {
    const data = await request<{ ssh_keys: { id: number }[] }>('GET', '/ssh_keys', { name });
    if (!data.ssh_keys[0]) throw new Error(`No SSH key found with name: "${name}"`);
    return data.ssh_keys[0].id;
  }

  async function findLatestSnapshot(prefix: string): Promise<HetznerImage | null> {
    const data = await request<{ images: HetznerImage[] }>('GET', '/images', { type: 'snapshot', sort: 'created:desc' });
    return data.images.find((img) => img.description === prefix || img.description.startsWith(`${prefix}-`)) ?? null;
  }

  async function findSnapshotsByPrefix(prefix: string): Promise<HetznerImage[]> {
    const data = await request<{ images: HetznerImage[] }>('GET', '/images', { type: 'snapshot', sort: 'created:desc' });
    return data.images.filter((img) => img.description === prefix || img.description.startsWith(`${prefix}-`));
  }

  const USER_DATA = `#!/bin/bash\nchage -d -1 root\n`;

  async function createServer(params: {
    name: string;
    serverType: string;
    location: string;
    image: number | string;
    sshKeyIds?: number[];
  }): Promise<{ server: HetznerServer; actionId: number }> {
    const data = await request<{ server: HetznerServer; action: { id: number } }>('POST', '/servers', undefined, {
      name: params.name,
      server_type: params.serverType,
      location: params.location,
      image: params.image,
      start_after_create: true,
      user_data: USER_DATA,
      ...(params.sshKeyIds?.length ? { ssh_keys: params.sshKeyIds } : {}),
    });
    return { server: data.server, actionId: data.action.id };
  }

  async function shutdownServer(serverId: number): Promise<{ actionId: number }> {
    const data = await request<{ action: { id: number } }>('POST', `/servers/${serverId}/actions/shutdown`);
    return { actionId: data.action.id };
  }

  async function createSnapshot(
    serverId: number,
    description: string,
  ): Promise<{ imageId: number; actionId: number }> {
    const data = await request<{ image: { id: number }; action: { id: number } }>(
      'POST',
      `/servers/${serverId}/actions/create_image`,
      undefined,
      { type: 'snapshot', description },
    );
    return { imageId: data.image.id, actionId: data.action.id };
  }

  async function waitForAction(actionId: number, onProgress?: (progress: number) => void): Promise<void> {
    for (;;) {
      const data = await request<{ action: { status: string; progress: number; error?: { message: string } } }>('GET', `/actions/${actionId}`);
      onProgress?.(data.action.progress);
      if (data.action.status === 'success') return;
      if (data.action.status === 'error') throw new Error(`Action failed: ${data.action.error?.message}`);
      await sleep(5000);
    }
  }

  async function deleteServer(serverId: number): Promise<void> {
    await request('DELETE', `/servers/${serverId}`);
  }

  async function deleteImage(imageId: number): Promise<void> {
    await request('DELETE', `/images/${imageId}`);
  }

  async function changeImageProtection(imageId: number, protect: boolean): Promise<void> {
    const data = await request<{ action: { id: number } }>(
      'POST',
      `/images/${imageId}/actions/change_protection`,
      undefined,
      { delete: protect },
    );
    await waitForAction(data.action.id);
  }

  return {
    findServer,
    findSshKeyByName,
    findLatestSnapshot,
    findSnapshotsByPrefix,
    createServer,
    shutdownServer,
    createSnapshot,
    waitForAction,
    deleteServer,
    deleteImage,
    changeImageProtection,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
