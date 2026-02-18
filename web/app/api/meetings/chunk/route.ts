import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { upsertMeetingUpload } from "@/lib/server/meetings-repo";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CHUNK_BYTES = 5 * 1024 * 1024;
const TMP_UPLOADS_DIR = path.join(process.cwd(), "tmp", "uploads");
const TMP_RECORDINGS_DIR = path.join(process.cwd(), "tmp", "recordings");
const UPLOAD_ID_REGEX = /^[a-z0-9-]{16,80}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mpeg",
  "audio/mp3",
]);

type UploadState = {
  upload_id: string;
  next_chunk: number;
  total_chunks: number;
  size_bytes: number;
  mime_type: string;
  extension: "webm" | "mp3";
  original_name: string;
  user_email: string;
  created_at: string;
};

function resolveExtension(mimeType: string, originalName: string): "webm" | "mp3" | null {
  const type = mimeType.toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";

  const name = originalName.toLowerCase();
  if (name.endsWith(".webm")) return "webm";
  if (name.endsWith(".mp3")) return "mp3";
  return null;
}

function parseNumberField(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 0) return null;
  return parsed;
}

async function loadState(statePath: string): Promise<UploadState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as UploadState;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const uploadIdValue = formData.get("upload_id");
    const chunkIndex = parseNumberField(formData.get("chunk_index"));
    const totalChunks = parseNumberField(formData.get("total_chunks"));
    const chunk = formData.get("chunk");
    const mimeTypeValue = formData.get("mime_type");
    const originalNameValue = formData.get("original_name");
    const userEmailValue = formData.get("user_email");

    if (typeof uploadIdValue !== "string" || !UPLOAD_ID_REGEX.test(uploadIdValue)) {
      return NextResponse.json({ error: "Invalid upload_id." }, { status: 400 });
    }

    if (chunkIndex === null || totalChunks === null || totalChunks <= 0) {
      return NextResponse.json(
        { error: "Invalid chunk_index or total_chunks." },
        { status: 400 },
      );
    }

    if (chunkIndex >= totalChunks) {
      return NextResponse.json({ error: "chunk_index out of range." }, { status: 400 });
    }

    if (!(chunk instanceof File)) {
      return NextResponse.json(
        { error: "Missing chunk file. Expected form-data field 'chunk'." },
        { status: 400 },
      );
    }

    if (chunk.size === 0) {
      return NextResponse.json({ error: "Chunk is empty." }, { status: 400 });
    }

    if (chunk.size > MAX_CHUNK_BYTES) {
      return NextResponse.json(
        { error: "Chunk size too large. Max 5MB per chunk." },
        { status: 413 },
      );
    }

    if (typeof userEmailValue !== "string" || !EMAIL_REGEX.test(userEmailValue.trim())) {
      return NextResponse.json(
        { error: "Valid user_email is required for reminders." },
        { status: 400 },
      );
    }

    const mimeTypeFromField = typeof mimeTypeValue === "string" ? mimeTypeValue : chunk.type;
    const mimeType = mimeTypeFromField || "audio/webm";
    const originalName =
      typeof originalNameValue === "string" ? originalNameValue : `upload-${uploadIdValue}`;

    const extension = resolveExtension(mimeType, originalName);
    const allowedByMime = ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
    if (!extension && !allowedByMime) {
      return NextResponse.json(
        { error: "Unsupported audio format. Use WebM or MP3." },
        { status: 415 },
      );
    }

    const resolvedExtension =
      extension ?? (mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : "webm");

    await mkdir(TMP_UPLOADS_DIR, { recursive: true });
    await mkdir(TMP_RECORDINGS_DIR, { recursive: true });

    const statePath = path.join(TMP_UPLOADS_DIR, `${uploadIdValue}.json`);
    const partialPath = path.join(TMP_UPLOADS_DIR, `${uploadIdValue}.part`);

    let state = await loadState(statePath);

    if (!state) {
      if (chunkIndex !== 0) {
        return NextResponse.json(
          { error: "Upload session missing. Restart upload from chunk 0." },
          { status: 409 },
        );
      }

      state = {
        upload_id: uploadIdValue,
        next_chunk: 0,
        total_chunks: totalChunks,
        size_bytes: 0,
        mime_type: mimeType,
        extension: resolvedExtension,
        original_name: originalName,
        user_email: userEmailValue.trim(),
        created_at: new Date().toISOString(),
      };
      await writeFile(statePath, JSON.stringify(state), "utf8");
    } else {
      if (state.total_chunks !== totalChunks) {
        return NextResponse.json(
          { error: "Upload metadata mismatch (total_chunks)." },
          { status: 409 },
        );
      }

      if (state.user_email !== userEmailValue.trim()) {
        return NextResponse.json(
          { error: "Upload metadata mismatch (user_email)." },
          { status: 409 },
        );
      }

      if (state.extension !== resolvedExtension) {
        return NextResponse.json(
          { error: "Upload metadata mismatch (audio format)." },
          { status: 409 },
        );
      }

      if (chunkIndex < state.next_chunk) {
        return NextResponse.json({
          status: "chunk_received",
          next_chunk: state.next_chunk,
          total_chunks: state.total_chunks,
          message: "Chunk already received; continue with next chunk.",
        });
      }

      if (chunkIndex > state.next_chunk) {
        return NextResponse.json(
          { error: `Out-of-order chunk. Expected chunk ${state.next_chunk}.` },
          { status: 409 },
        );
      }
    }

    const bytes = Buffer.from(await chunk.arrayBuffer());
    const updatedSize = state.size_bytes + bytes.byteLength;

    if (updatedSize > MAX_FILE_BYTES) {
      await rm(partialPath, { force: true });
      await rm(statePath, { force: true });
      return NextResponse.json(
        { error: "Audio file exceeded 50MB total upload size." },
        { status: 413 },
      );
    }

    await appendFile(partialPath, bytes);
    state.size_bytes = updatedSize;
    state.next_chunk += 1;

    if (state.next_chunk < state.total_chunks) {
      await writeFile(statePath, JSON.stringify(state), "utf8");
      return NextResponse.json({
        status: "chunk_received",
        next_chunk: state.next_chunk,
        total_chunks: state.total_chunks,
      });
    }

    const meetingId = crypto.randomUUID();
    const filename = `${meetingId}.${state.extension}`;
    const finalPath = path.join(TMP_RECORDINGS_DIR, filename);
    const storedAs = path.join("tmp", "recordings", filename);

    await rename(partialPath, finalPath);
    await rm(statePath, { force: true });
    const databaseSaved = await upsertMeetingUpload({
      meetingId,
      audioFile: storedAs,
      userEmail: state.user_email,
      meetingDate: new Date(),
    });

    return NextResponse.json({
      status: "complete",
      meeting_id: meetingId,
      stored_as: storedAs,
      size_bytes: state.size_bytes,
      user_email: state.user_email,
      database_saved: databaseSaved,
      message: "Got it, processing now",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected server error while processing chunk upload.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
