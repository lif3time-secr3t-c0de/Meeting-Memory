import { NextResponse } from "next/server";
import {
  claimNextProcessingJob,
  ensureProcessingQueueTable,
  markProcessingJobStatus,
} from "@/lib/server/processing-queue-repo";

export const runtime = "nodejs";
export const maxDuration = 300;

function resolveBaseUrl(request: Request): string {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const proto =
    request.headers.get("x-forwarded-proto") ||
    (request.url.startsWith("https://") ? "https" : "http");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return "http://localhost:3000";
  return `${proto}://${host}`;
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.PROCESSING_WORKER_SECRET?.trim();
  if (!expected) return true;

  const headerValue = request.headers.get("x-processing-worker-secret")?.trim();
  if (headerValue && headerValue === expected) return true;

  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (token === expected) return true;
  }

  return false;
}

function parseMaxJobs(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get("max_jobs");
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.max(1, Math.min(parsed, 10));
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized worker run." }, { status: 401 });
  }

  const queueReady = await ensureProcessingQueueTable();
  if (!queueReady) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const baseUrl = resolveBaseUrl(request);
  const maxJobs = parseMaxJobs(request);
  const processed: Array<{
    meeting_id: string;
    status: "done" | "failed";
    error?: string | null;
  }> = [];

  for (let i = 0; i < maxJobs; i += 1) {
    const claim = await claimNextProcessingJob();
    if (claim.skipped) {
      return NextResponse.json(
        { error: "Database is not configured. Set DATABASE_URL." },
        { status: 500 },
      );
    }

    const job = claim.job;
    if (!job) break;

    try {
      const response = await fetch(`${baseUrl}/api/meetings/${job.meeting_id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: job.model }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        const errorMessage = payload?.error ?? `Process route failed with ${response.status}.`;
        await markProcessingJobStatus(job.meeting_id, "failed", errorMessage);
        processed.push({
          meeting_id: job.meeting_id,
          status: "failed",
          error: errorMessage,
        });
        continue;
      }

      await markProcessingJobStatus(job.meeting_id, "done", null);
      processed.push({
        meeting_id: job.meeting_id,
        status: "done",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unexpected worker error.";
      await markProcessingJobStatus(job.meeting_id, "failed", errorMessage);
      processed.push({
        meeting_id: job.meeting_id,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return NextResponse.json({
    status: "ok",
    processed_count: processed.length,
    processed,
  });
}

