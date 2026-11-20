import crypto from 'node:crypto';
import type { ClueStateSyncConfig, ClueStateSyncResult, EpisodePayload } from './types.js';

function resolveApiBase(baseUrl?: string): string {
  const clean = (baseUrl || 'https://app.cluestate.com').trim().replace(/\/+$/, '');
  return clean.endsWith('/api') ? clean : `${clean}/api`;
}

async function httpJson(
  method: string,
  url: string,
  apiKey: string,
  payload?: unknown,
  timeoutMs = 35000
): Promise<{ ok: boolean; status: number; data: any; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const errMsg = !res.ok
      ? (data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${res.status}`)
      : '';
    return { ok: res.ok, status: res.status, data, error: errMsg };
  } catch (err: any) {
    return { ok: false, status: 0, data: null, error: err?.message || 'ClueState request failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function syncEpisodesToClueState(
  config: ClueStateSyncConfig,
  episodes: EpisodePayload[]
): Promise<ClueStateSyncResult> {
  const apiBase = resolveApiBase(config.base_url);
  const result: ClueStateSyncResult = {
    cluestate_synced: false,
    cluestate_entity_id: null,
    external_id: config.external_id,
    formatted_prompt: '',
    memories: [],
    episodes_ingested: 0,
    episodes_replayed: 0,
    cluestate_error: null,
  };

  if (!config.api_key?.trim()) {
    result.cluestate_error = 'No ClueState API key provided.';
    return result;
  }

  // 1. Ensure entity exists
  const entityRes = await httpJson(
    'POST',
    `${apiBase}/entities`,
    config.api_key,
    {
      external_id: config.external_id,
      name: config.entity_name,
      entity_type: config.entity_type || 'organization',
      meta: config.meta || {},
    },
    15000
  );
  if (entityRes.ok && entityRes.data?.id) {
    result.cluestate_entity_id = String(entityRes.data.id);
  }

  // 2. Prepare episodes (optionally prepend profile header to first episode)
  const finalEpisodes: EpisodePayload[] = episodes
    .filter((ep) => ep.content && ep.content.trim().length > 0)
    .map((ep, idx) => ({
      ...ep,
      content:
        idx === 0 && config.profile_header
          ? `${config.profile_header.trim()}\n\n---\n\n${ep.content}`
          : ep.content,
    }));

  if (finalEpisodes.length === 0 && config.profile_header) {
    finalEpisodes.push({
      key: 'entity_profile',
      category: 'identity',
      title: 'Entity Profile & Notes',
      source_type: 'custom',
      occurred_at: new Date().toISOString(),
      content: config.profile_header,
    });
  }

  const payloadsToSend: EpisodePayload[] =
    config.multi_episode === false && finalEpisodes.length > 1
      ? [
          {
            key: 'combined_crawl',
            category: 'combined',
            title: `Website Intelligence: ${config.entity_name}`,
            source_type: 'custom',
            occurred_at: new Date().toISOString(),
            content: finalEpisodes.map((e) => `## ${e.title}\n\n${e.content}`).join('\n\n---\n\n'),
          },
        ]
      : finalEpisodes;

  // 3. Ingest episodes idempotently
  let lastError: string | null = null;
  for (const ep of payloadsToSend) {
    const contentHash = crypto.createHash('sha1').update(ep.content).digest('hex');
    const idemKey = crypto
      .createHash('sha256')
      .update(`${config.external_id}|${ep.key}|${contentHash}`)
      .digest('hex');

    const ingestRes = await httpJson(
      'POST',
      `${apiBase}/ingest`,
      config.api_key,
      {
        external_id: config.external_id,
        entity_name: config.entity_name,
        source_type: ep.source_type || 'custom',
        source_description: ep.title || ep.key,
        source_record_id: ep.key,
        idempotency_key: idemKey,
        content: ep.content.slice(0, 24000),
        occurred_at: ep.occurred_at || new Date().toISOString(),
        meta: { ...(config.meta || {}), category: ep.category || ep.key },
        auto_create_entity: true,
      },
      45000
    );

    if (ingestRes.ok) {
      result.cluestate_synced = true;
      if (ingestRes.data?.entity_id) {
        result.cluestate_entity_id = String(ingestRes.data.entity_id);
      }
      if (ingestRes.data?.idempotent_replay) {
        result.episodes_replayed++;
      } else {
        result.episodes_ingested++;
      }
    } else {
      lastError = ingestRes.error || `ClueState ingest HTTP ${ingestRes.status}`;
    }
  }

  if (lastError) {
    result.cluestate_error = lastError;
  }

  if (!result.cluestate_synced) {
    return result;
  }

  // 4. Fetch compiled intel & memories
  const intelRes = await httpJson(
    'GET',
    `${apiBase}/intel/by-external-id/${encodeURIComponent(config.external_id)}`,
    config.api_key,
    undefined,
    20000
  );
  if (intelRes.ok && intelRes.data) {
    result.formatted_prompt = intelRes.data.formatted_prompt || '';
    result.memories = Array.isArray(intelRes.data.memories) ? intelRes.data.memories : [];
    if (intelRes.data.entity_id) {
      result.cluestate_entity_id = String(intelRes.data.entity_id);
    }
  }

  return result;
}
