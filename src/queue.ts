import crypto from 'node:crypto';
import type { JobRecord, JobStep, StepState } from './types.js';

const MAX_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENCY || 2)));
const JOB_TTL_MS = Math.max(5, Number(process.env.JOB_TTL_MINUTES || 60)) * 60 * 1000;

interface QueuedJob {
  record: JobRecord;
  callbackUrl?: string;
  callbackSecret?: string;
  callbackMeta?: Record<string, unknown>;
  runner: (report: (key: string, status: StepState, detail?: string, progressPct?: number) => Promise<void>) => Promise<{
    status: 'completed' | 'partial' | 'failed';
    result: any;
    error?: string | null;
  }>;
}

const jobs = new Map<string, JobRecord>();
const pendingQueue: QueuedJob[] = [];
let activeCount = 0;

function pruneExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.completed_at && now - Date.parse(job.completed_at) > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

setInterval(pruneExpiredJobs, 5 * 60 * 1000).unref();

async function sendCallback(
  callbackUrl: string | undefined,
  callbackSecret: string | undefined,
  callbackMeta: Record<string, unknown> | undefined,
  record: JobRecord,
  isFinal: boolean
) {
  if (!callbackUrl) return;
  const payload = {
    event: isFinal ? 'job.finished' : 'job.progress',
    job_id: record.job_id,
    status: record.status,
    current_step: record.current_step,
    progress_pct: record.progress_pct,
    steps: record.steps,
    error: record.error,
    result: isFinal ? record.result : null,
    meta: callbackMeta || {},
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Coevo-Product': 'sales',
    'X-App-Product': 'sales',
  };
  if (callbackSecret) {
    headers['X-Scraper-Secret'] = callbackSecret;
    headers['X-Scraper-Signature'] = crypto.createHmac('sha256', callbackSecret).update(body).digest('hex');
  }

  for (let attempt = 0; attempt < (isFinal ? 2 : 1); attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      // retry once for final delivery
      if (attempt === 0 && isFinal) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

async function pumpQueue() {
  if (activeCount >= MAX_CONCURRENCY) return;
  const next = pendingQueue.shift();
  if (!next) return;

  activeCount++;
  const { record, callbackUrl, callbackSecret, callbackMeta, runner } = next;
  record.status = 'running';
  record.updated_at = new Date().toISOString();

  const report = async (key: string, status: StepState, detail?: string, progressPct?: number) => {
    const now = new Date().toISOString();
    const existing = record.steps.find((s) => s.key === key);
    if (existing) {
      existing.status = status;
      if (detail !== undefined) existing.detail = detail;
      existing.updated_at = now;
    } else {
      record.steps.push({ key, label: key, status, detail, updated_at: now });
    }
    record.current_step = detail || existing?.label || key;
    if (typeof progressPct === 'number') {
      record.progress_pct = Math.max(record.progress_pct, Math.min(99, progressPct));
    }
    record.updated_at = now;
    await sendCallback(callbackUrl, callbackSecret, callbackMeta, record, false);
  };

  try {
    const outcome = await runner(report);
    record.status = outcome.status;
    record.result = outcome.result;
    record.error = outcome.error || null;
    record.progress_pct = 100;
    record.current_step =
      outcome.status === 'completed'
        ? 'Completed'
        : outcome.status === 'partial'
          ? 'Completed with warnings'
          : outcome.error || 'Failed';
    record.completed_at = new Date().toISOString();
    record.updated_at = record.completed_at;
    await sendCallback(callbackUrl, callbackSecret, callbackMeta, record, true);
  } catch (err: any) {
    record.status = 'failed';
    record.error = err?.message || 'Unexpected worker error';
    record.progress_pct = 100;
    record.current_step = record.error || 'Failed';
    record.completed_at = new Date().toISOString();
    record.updated_at = record.completed_at;
    await sendCallback(callbackUrl, callbackSecret, callbackMeta, record, true);
  } finally {
    activeCount--;
    setImmediate(() => {
      void pumpQueue();
    });
  }
}

export function enqueueJob(params: {
  kind: JobRecord['kind'];
  initialSteps: Array<{ key: string; label: string }>;
  callbackUrl?: string;
  callbackSecret?: string;
  callbackMeta?: Record<string, unknown>;
  runner: QueuedJob['runner'];
}): JobRecord {
  const now = new Date().toISOString();
  const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
  const steps: JobStep[] = params.initialSteps.map((s) => ({
    key: s.key,
    label: s.label,
    status: 'pending',
    updated_at: now,
  }));

  const record: JobRecord = {
    job_id: jobId,
    kind: params.kind,
    status: 'queued',
    current_step: 'Queued',
    progress_pct: 5,
    steps,
    result: null,
    error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };

  jobs.set(jobId, record);
  pendingQueue.push({
    record,
    callbackUrl: params.callbackUrl,
    callbackSecret: params.callbackSecret,
    callbackMeta: params.callbackMeta,
    runner: params.runner,
  });

  setImmediate(() => {
    void pumpQueue();
  });

  return record;
}

export function getJob(jobId: string): JobRecord | null {
  return jobs.get(jobId) || null;
}

export function getQueueStats() {
  return {
    active: activeCount,
    queued: pendingQueue.length,
    max_concurrency: MAX_CONCURRENCY,
    tracked_jobs: jobs.size,
  };
}
