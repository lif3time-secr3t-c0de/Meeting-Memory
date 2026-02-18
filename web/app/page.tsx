"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DURATION_SECONDS = 60 * 60;
const RECORDING_CHUNK_MS = 1000;
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const MIME_OPTIONS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mpeg",
] as const;

type RecorderPhase =
  | "idle"
  | "recording"
  | "stopping"
  | "ready"
  | "uploading"
  | "uploaded"
  | "error";

type StopReason = "manual" | "size_limit" | "time_limit";

type ChunkUploadResponse = {
  status?: "chunk_received" | "complete";
  next_chunk?: number;
  total_chunks?: number;
  meeting_id?: string;
  message?: string;
  error?: string;
};

type ExtractedPromise = {
  person: string;
  task: string;
  deadline: string | null;
  actual_date: string | null;
  done?: boolean;
  rescheduled_to?: string | null;
};

type WhisperProcessResponse = {
  status?: "complete";
  meeting_id?: string;
  model?: "tiny" | "base";
  duration_seconds?: number;
  processing_seconds?: number;
  segment_count?: number;
  transcript_text?: string;
  promises_list?: ExtractedPromise[];
  meeting_timestamp?: string;
  audio_download_url?: string | null;
  quality?: {
    avg_no_speech_prob?: number;
    avg_logprob?: number;
    avg_compression_ratio?: number;
  } | null;
  warnings?: string[];
  error?: string;
  error_code?: string;
};

type MeetingSummaryResponse = {
  status?: "ready";
  meeting_id?: string;
  meeting_timestamp?: string;
  transcript_text?: string;
  promises_list?: ExtractedPromise[];
  audio_download_url?: string | null;
  error?: string;
};

type MeetingListItem = {
  meeting_id: string;
  meeting_timestamp: string;
  processing_status: string;
  error_message: string | null;
  promise_count: number;
  done_count: number;
  open_count: number;
};

type MeetingListResponse = {
  status?: "ok";
  email?: string;
  meetings?: MeetingListItem[];
  error?: string;
};

type DashboardSummary = {
  meetingId: string;
  meetingTimestamp: string;
  transcriptText: string;
  promisesList: ExtractedPromise[];
  audioDownloadUrl: string | null;
};

type UploadSession = {
  uploadId: string;
  nextChunk: number;
  totalChunks: number;
  fileName: string;
  mimeType: string;
  email: string;
};

function pickMimeType(): string | undefined {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return undefined;
  }

  return MIME_OPTIONS.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatLongDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";
  return parsed.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function buildPromiseKey(item: ExtractedPromise, index: number): string {
  return `${index}:${item.person}:${item.task}:${item.deadline ?? ""}:${item.actual_date ?? ""}`;
}

function buildCompletedMap(promises: ExtractedPromise[]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  promises.forEach((item, index) => {
    if (item.done) {
      next[buildPromiseKey(item, index)] = true;
    }
  });
  return next;
}

function resolveAudioDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

type WaveformCaptureStats = {
  frameCount: number;
  sumRms: number;
  sumSqRms: number;
  loudFrameCount: number;
  clippedFrameCount: number;
};

function createWaveformCaptureStats(): WaveformCaptureStats {
  return {
    frameCount: 0,
    sumRms: 0,
    sumSqRms: 0,
    loudFrameCount: 0,
    clippedFrameCount: 0,
  };
}

function buildPreProcessingNoiseWarning(
  stats: WaveformCaptureStats,
  elapsedSeconds: number,
): string | null {
  if (stats.frameCount < 80 || elapsedSeconds < 30) return null;

  const avgRms = stats.sumRms / stats.frameCount;
  const variance = Math.max(0, stats.sumSqRms / stats.frameCount - avgRms * avgRms);
  const stdDev = Math.sqrt(variance);
  const loudRatio = stats.loudFrameCount / stats.frameCount;
  const clippedRatio = stats.clippedFrameCount / stats.frameCount;

  if (clippedRatio >= 0.02) {
    return "Warning before processing: audio may be clipping or heavily noisy. Results may be less accurate.";
  }

  if (avgRms >= 0.07 && stdDev <= 0.03 && loudRatio >= 0.65) {
    return "Warning before processing: this recording appears noisy. A quieter place can improve accuracy.";
  }

  return null;
}

export default function Home() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [capturedBytes, setCapturedBytes] = useState(0);
  const [selectedMimeType, setSelectedMimeType] = useState("audio/webm");
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    "Press Record to request mic permission and start capturing.",
  );
  const [uploadProgress, setUploadProgress] = useState(0);
  const [chunkProgressText, setChunkProgressText] = useState<string | null>(null);
  const [uploadRetryAvailable, setUploadRetryAvailable] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [permissionState, setPermissionState] = useState<
    "prompt" | "granted" | "denied"
  >("prompt");
  const [selectedWhisperModel, setSelectedWhisperModel] = useState<"tiny" | "base">("base");
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  const [autoProcessPending, setAutoProcessPending] = useState(false);
  const [preProcessWarning, setPreProcessWarning] = useState<string | null>(null);
  const [transcriptionWarnings, setTranscriptionWarnings] = useState<string[]>([]);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [transcriptionText, setTranscriptionText] = useState("");
  const [extractedPromises, setExtractedPromises] = useState<ExtractedPromise[]>([]);
  const [transcriptionMeta, setTranscriptionMeta] = useState<{
    model: "tiny" | "base";
    duration_seconds: number;
    processing_seconds: number;
    segment_count: number;
  } | null>(null);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [meetingsList, setMeetingsList] = useState<MeetingListItem[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);
  const [inboxToken, setInboxToken] = useState<string | null>(null);
  const [inboxEmail, setInboxEmail] = useState("");
  const [manualPromisePerson, setManualPromisePerson] = useState("You");
  const [manualPromiseTask, setManualPromiseTask] = useState("");
  const [manualPromiseDueDate, setManualPromiseDueDate] = useState("");
  const [showLandingView, setShowLandingView] = useState(true);
  const [showMeetingsView, setShowMeetingsView] = useState(false);
  const [showRecorderView, setShowRecorderView] = useState(true);
  const [completedPromises, setCompletedPromises] = useState<Record<string, boolean>>({});
  const [processingProgress, setProcessingProgress] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunkListRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef(0);
  const timerIntervalRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const stopRequestedRef = useRef(false);

  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformStatsRef = useRef<WaveformCaptureStats>(createWaveformCaptureStats());

  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const uploadSessionRef = useRef<UploadSession | null>(null);
  const initialRouteHandledRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const stopWaveformAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const drawIdleWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const internalWidth = Math.max(1, Math.floor(width * dpr));
    const internalHeight = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== internalWidth || canvas.height !== internalHeight) {
      canvas.width = internalWidth;
      canvas.height = internalHeight;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(31, 18, 14, 0.96)";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255, 214, 171, 0.45)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
  }, []);

  const releaseMediaResources = useCallback(() => {
    stopWaveformAnimation();

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    waveformDataRef.current = null;
    drawIdleWaveform();
  }, [drawIdleWaveform, stopWaveformAnimation]);

  const startWaveformAnimation = useCallback(() => {
    const draw = () => {
      const canvas = waveformCanvasRef.current;
      const analyser = analyserRef.current;
      const data = waveformDataRef.current;
      if (!canvas || !analyser || !data) return;

      const context = canvas.getContext("2d");
      if (!context) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const internalWidth = Math.max(1, Math.floor(width * dpr));
      const internalHeight = Math.max(1, Math.floor(height * dpr));

      if (canvas.width !== internalWidth || canvas.height !== internalHeight) {
        canvas.width = internalWidth;
        canvas.height = internalHeight;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      analyser.getByteTimeDomainData(data);

      context.clearRect(0, 0, width, height);
      context.fillStyle = "rgba(31, 18, 14, 0.96)";
      context.fillRect(0, 0, width, height);

      context.strokeStyle = "#ffd6ab";
      context.lineWidth = 2;
      context.beginPath();

      const sliceWidth = width / data.length;
      let x = 0;
      let sumSquares = 0;
      let maxAbsSample = 0;
      for (let i = 0; i < data.length; i += 1) {
        const normalized = data[i] / 128.0;
        const centered = normalized - 1;
        const absCentered = Math.abs(centered);
        sumSquares += centered * centered;
        if (absCentered > maxAbsSample) maxAbsSample = absCentered;
        const y = (normalized * height) / 2;

        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
        x += sliceWidth;
      }

      context.lineTo(width, height / 2);
      context.stroke();

      const rms = Math.sqrt(sumSquares / data.length);
      const stats = waveformStatsRef.current;
      stats.frameCount += 1;
      stats.sumRms += rms;
      stats.sumSqRms += rms * rms;
      if (rms >= 0.08) stats.loudFrameCount += 1;
      if (maxAbsSample >= 0.97) stats.clippedFrameCount += 1;

      animationFrameRef.current = window.requestAnimationFrame(draw);
    };

    draw();
  }, []);

  const stopRecording = useCallback(
    (reason: StopReason = "manual") => {
      if (stopRequestedRef.current) return;
      stopRequestedRef.current = true;

      clearTimer();

      if (reason === "time_limit") {
        setNotice("Reached the 60-minute limit. Recording stopped automatically.");
      } else if (reason === "size_limit") {
        setNotice("Reached the 50MB file limit. Recording stopped automatically.");
      }

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        releaseMediaResources();
        return;
      }

      setPhase("stopping");
      recorder.stop();
    },
    [clearTimer, releaseMediaResources],
  );

  const startRecording = useCallback(async () => {
    if (phase === "stopping" || phase === "uploading") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPhase("error");
      setRecordingError("This browser does not support in-browser audio recording.");
      return;
    }

    setRecordingError(null);
    setShowLandingView(false);
    setShowMeetingsView(false);
    setShowRecorderView(true);
    setMeetingId(null);
    setAutoProcessPending(false);
    setManualPromisePerson("You");
    setManualPromiseTask("");
    setManualPromiseDueDate("");
    setPreProcessWarning(null);
    setTranscriptionWarnings([]);
    setTranscriptionBusy(false);
    setTranscriptionError(null);
    setTranscriptionText("");
    setExtractedPromises([]);
    setTranscriptionMeta(null);
    setProcessingProgress(0);
    setNotice("Requesting microphone access...");
    setChunkProgressText(null);
    setUploadRetryAvailable(false);
    setUploadProgress(0);
    setElapsedSeconds(0);
    setCapturedBytes(0);
    setRecordedBlob(null);
    uploadSessionRef.current = null;
    chunkListRef.current = [];
    recordedBytesRef.current = 0;
    stopRequestedRef.current = false;
    waveformStatsRef.current = createWaveformCaptureStats();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setPermissionState("granted");
      mediaStreamRef.current = stream;

      const chosenMimeType = pickMimeType();
      const recorder = chosenMimeType
        ? new MediaRecorder(stream, { mimeType: chosenMimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      setSelectedMimeType(chosenMimeType ?? recorder.mimeType ?? "audio/webm");

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size === 0) return;

        chunkListRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
        setCapturedBytes(recordedBytesRef.current);

        if (recordedBytesRef.current >= MAX_FILE_BYTES) {
          stopRecording("size_limit");
        }
      };

      recorder.onerror = () => {
        setPhase("error");
        setRecordingError("Recorder encountered an error while capturing audio.");
        releaseMediaResources();
        mediaRecorderRef.current = null;
      };

      recorder.onstop = () => {
        clearTimer();
        releaseMediaResources();

        const resolvedMime =
          chosenMimeType ?? recorder.mimeType ?? selectedMimeType ?? "audio/webm";
        const combinedBlob = new Blob(chunkListRef.current, { type: resolvedMime });
        chunkListRef.current = [];
        mediaRecorderRef.current = null;

        if (combinedBlob.size === 0) {
          setPhase("error");
          setRecordingError("No audio data was captured. Please try again.");
          return;
        }

        if (combinedBlob.size > MAX_FILE_BYTES) {
          setPhase("error");
          setRecordingError("Captured file exceeded 50MB. Please keep recordings shorter.");
          return;
        }

        setSelectedMimeType(resolvedMime);
        setRecordedBlob(combinedBlob);
        setCapturedBytes(combinedBlob.size);
        setPhase("ready");
        const startedAt = recordingStartedAtRef.current;
        const capturedSeconds = startedAt
          ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
          : 0;
        recordingStartedAtRef.current = null;
        const noiseWarning = buildPreProcessingNoiseWarning(
          waveformStatsRef.current,
          capturedSeconds,
        );
        setPreProcessWarning(noiseWarning);
        setNotice(
          noiseWarning
            ? "Recording stopped. Potential noise detected. Enter your email, upload, then review warning before processing."
            : "Recording stopped. Enter your email for reminders, then upload.",
        );
      };

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;
      waveformDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

      recordingStartedAtRef.current = Date.now();
      timerIntervalRef.current = window.setInterval(() => {
        const startedAt = recordingStartedAtRef.current;
        if (startedAt === null) return;

        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(seconds);

        if (seconds >= MAX_DURATION_SECONDS) {
          stopRecording("time_limit");
        }
      }, 1000);

      recorder.start(RECORDING_CHUNK_MS);
      setPhase("recording");
      setNotice("Recording in 1-second chunks and holding them in browser memory.");
      startWaveformAnimation();
    } catch (error) {
      setPermissionState("denied");
      setPhase("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setRecordingError("Microphone permission was denied. Allow mic access and try again.");
      } else {
        setRecordingError("Unable to start recording. Check your microphone and retry.");
      }
      releaseMediaResources();
      mediaRecorderRef.current = null;
    }
  }, [
    clearTimer,
    phase,
    releaseMediaResources,
    selectedMimeType,
    startWaveformAnimation,
    stopRecording,
  ]);

  const uploadRecording = useCallback(
    async (resume: boolean) => {
      if (!recordedBlob) {
        setPhase("error");
        setRecordingError("Please record audio before uploading.");
        return;
      }

      if (recordedBlob.size > MAX_FILE_BYTES) {
        setPhase("error");
        setRecordingError("File is larger than 50MB and cannot be uploaded.");
        return;
      }

      const trimmedEmail = userEmail.trim();
      if (!isValidEmail(trimmedEmail)) {
        setPhase("error");
        setRecordingError("Enter a valid email address for reminders before uploading.");
        setNotice("Email required for reminders.");
        emailInputRef.current?.focus();
        return;
      }

      let session = resume ? uploadSessionRef.current : null;
      if (resume && !session) {
        setPhase("error");
        setRecordingError("No paused upload found. Start upload again.");
        return;
      }

      if (!session || session.email !== trimmedEmail) {
        const isMp3 = selectedMimeType.includes("mpeg") || selectedMimeType.includes("mp3");
        const extension = isMp3 ? "mp3" : "webm";
        const mimeType = selectedMimeType || (isMp3 ? "audio/mpeg" : "audio/webm");
        const fileName = `meeting-${Date.now()}.${extension}`;
        const totalChunks = Math.ceil(recordedBlob.size / UPLOAD_CHUNK_BYTES);
        session = {
          uploadId: crypto.randomUUID(),
          nextChunk: 0,
          totalChunks,
          fileName,
          mimeType,
          email: trimmedEmail,
        };
        uploadSessionRef.current = session;
      }

      const file = new File([recordedBlob], session.fileName, {
        type: session.mimeType,
      });

      setPhase("uploading");
      setUploadRetryAvailable(false);
      setRecordingError(null);
      setNotice("Processing... uploading to server in chunks.");
      setUploadProgress(Math.round((session.nextChunk / session.totalChunks) * 100));
      setChunkProgressText(`Chunk ${session.nextChunk}/${session.totalChunks}`);

      try {
        let chunkIndex = session.nextChunk;

        while (chunkIndex < session.totalChunks) {
          const chunkStart = chunkIndex * UPLOAD_CHUNK_BYTES;
          const chunkEnd = Math.min(chunkStart + UPLOAD_CHUNK_BYTES, file.size);
          const chunkBlob = file.slice(chunkStart, chunkEnd, session.mimeType);
          const chunkFile = new File([chunkBlob], `${session.fileName}.part${chunkIndex}`, {
            type: session.mimeType,
          });

          setNotice(
            `Processing... uploading chunk ${chunkIndex + 1}/${session.totalChunks}.`,
          );

          const formData = new FormData();
          formData.append("upload_id", session.uploadId);
          formData.append("chunk_index", String(chunkIndex));
          formData.append("total_chunks", String(session.totalChunks));
          formData.append("mime_type", session.mimeType);
          formData.append("original_name", session.fileName);
          formData.append("user_email", session.email);
          formData.append("chunk", chunkFile);

          const response = await fetch("/api/meetings/chunk", {
            method: "POST",
            body: formData,
          });

          const payload = (await response
            .json()
            .catch(() => null)) as ChunkUploadResponse | null;

          if (!response.ok) {
            throw new Error(payload?.error ?? `Chunk upload failed at part ${chunkIndex + 1}.`);
          }

          if (payload?.status === "complete") {
            uploadSessionRef.current = null;
            setUploadProgress(100);
            setChunkProgressText(`Chunk ${session.totalChunks}/${session.totalChunks}`);
            setMeetingId(payload.meeting_id ?? null);
            setTranscriptionBusy(false);
            setTranscriptionError(null);
            setTranscriptionText("");
            setExtractedPromises([]);
            setTranscriptionMeta(null);
            setTranscriptionWarnings([]);
            const shouldAutoProcess = !preProcessWarning;
            setAutoProcessPending(shouldAutoProcess);
            setPhase("uploaded");
            setNotice(
              shouldAutoProcess
                ? `${payload.message ?? "Got it, processing now."} Starting transcription automatically. We'll email you when your summary is ready.`
                : `${payload.message ?? "Got it, processing now."} We'll email you when ready. Review the noise warning before processing.`,
            );
            return;
          }

          const nextChunkFromServer = payload?.next_chunk;
          const nextChunk =
            typeof nextChunkFromServer === "number" ? nextChunkFromServer : chunkIndex + 1;
          const boundedNextChunk = Math.min(Math.max(nextChunk, chunkIndex + 1), session.totalChunks);

          session.nextChunk = boundedNextChunk;
          uploadSessionRef.current = session;
          chunkIndex = boundedNextChunk;

          setUploadProgress(Math.round((boundedNextChunk / session.totalChunks) * 100));
          setChunkProgressText(`Chunk ${boundedNextChunk}/${session.totalChunks}`);
        }

        throw new Error("Upload ended without server completion confirmation.");
      } catch (error) {
        setPhase("error");
        setUploadRetryAvailable(Boolean(uploadSessionRef.current));
        setNotice("Upload interrupted. Check internet and retry.");
        setRecordingError(
          error instanceof Error ? error.message : "Upload failed due to an unknown error.",
        );
      }
    },
    [preProcessWarning, recordedBlob, selectedMimeType, userEmail],
  );

  const fetchMeetingSummary = useCallback(async (targetMeetingId: string) => {
    setDashboardLoading(true);
    setDashboardError(null);
    setMeetingsError(null);

    try {
      const response = await fetch(`/api/meetings/${targetMeetingId}/summary`, {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as MeetingSummaryResponse | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load meeting summary.");
      }

      const summary: DashboardSummary = {
        meetingId: payload?.meeting_id ?? targetMeetingId,
        meetingTimestamp: payload?.meeting_timestamp ?? new Date().toISOString(),
        transcriptText: payload?.transcript_text ?? "",
        promisesList: Array.isArray(payload?.promises_list) ? payload.promises_list : [],
        audioDownloadUrl: resolveAudioDownloadUrl(payload?.audio_download_url),
      };

      setDashboardSummary(summary);
      setCompletedPromises(buildCompletedMap(summary.promisesList));
      setAutoProcessPending(false);
      setProcessingProgress(0);
      setShowRecorderView(false);
      setShowMeetingsView(false);
      setShowLandingView(false);
      setMeetingId(summary.meetingId);
      setManualPromisePerson("You");
      setManualPromiseTask("");
      setManualPromiseDueDate("");
      setPreProcessWarning(null);
      setTranscriptionWarnings([]);
      setExtractedPromises(summary.promisesList);
      setTranscriptionText(summary.transcriptText);

      if (typeof window !== "undefined") {
        window.localStorage.setItem("meeting_memory_last_meeting_id", summary.meetingId);
        window.history.replaceState(null, "", `/?meeting_id=${encodeURIComponent(summary.meetingId)}`);
      }
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Failed to load meeting summary.",
      );
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  const fetchMeetingsList = useCallback(
    async (options?: { token?: string; email?: string }) => {
      const token = options?.token ?? inboxToken;
      const email = options?.email ?? inboxEmail.trim();

      if (!token && !isValidEmail(email)) {
        setMeetingsError("Enter a valid email or open a valid inbox link.");
        return;
      }

      setMeetingsLoading(true);
      setMeetingsError(null);
      setDashboardError(null);

      try {
        const params = new URLSearchParams();
        if (token) params.set("token", token);
        else params.set("email", email);
        params.set("limit", "50");

        const response = await fetch(`/api/meetings/list?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response
          .json()
          .catch(() => null)) as MeetingListResponse | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load meetings list.");
        }

        const meetings = Array.isArray(payload?.meetings) ? payload.meetings : [];
        setMeetingsList(meetings);
        setInboxEmail(payload?.email ?? email);
        if (token) {
          setInboxToken(token);
          if (typeof window !== "undefined") {
            window.localStorage.setItem("meeting_memory_inbox_token", token);
            window.history.replaceState(null, "", `/?inbox=${encodeURIComponent(token)}`);
          }
        } else if (typeof window !== "undefined") {
          window.history.replaceState(null, "", "/");
        }

        setShowRecorderView(false);
        setShowMeetingsView(true);
        setShowLandingView(false);
      } catch (error) {
        setMeetingsError(
          error instanceof Error ? error.message : "Failed to load meetings list.",
        );
      } finally {
        setMeetingsLoading(false);
      }
    },
    [inboxEmail, inboxToken],
  );

  const togglePromiseDone = useCallback(
    (promiseKey: string, promiseIndex: number) => {
      if (!dashboardSummary) return;

      const currentValue = Boolean(completedPromises[promiseKey]);
      const nextValue = !currentValue;

      setCompletedPromises((previous) => ({
        ...previous,
        [promiseKey]: nextValue,
      }));

      void fetch(
        `/api/meetings/${dashboardSummary.meetingId}/promises/${promiseIndex}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ done: nextValue }),
        },
      )
        .then(async (response) => {
          if (!response.ok) {
            const payload = (await response
              .json()
              .catch(() => null)) as { error?: string } | null;
            throw new Error(payload?.error ?? "Could not update promise status.");
          }
        })
        .catch((error) => {
          setCompletedPromises((previous) => ({
            ...previous,
            [promiseKey]: currentValue,
          }));
          setDashboardError(
            error instanceof Error ? error.message : "Could not update promise status.",
          );
        });
    },
    [completedPromises, dashboardSummary],
  );

  const addManualPromise = useCallback(async () => {
    if (!dashboardSummary) return;

    const task = manualPromiseTask.trim();
    if (!task) {
      setDashboardError("Task is required when adding a manual promise.");
      return;
    }

    setDashboardError(null);
    const payload = {
      person: manualPromisePerson.trim() || "You",
      task,
      due_date: manualPromiseDueDate || null,
    };

    try {
      const response = await fetch(
        `/api/meetings/${dashboardSummary.meetingId}/promises/manual`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { error?: string; promise?: ExtractedPromise }
        | null;

      if (!response.ok) {
        throw new Error(body?.error ?? "Could not add manual promise.");
      }

      const addedPromise: ExtractedPromise = body?.promise ?? {
        person: payload.person,
        task: payload.task,
        deadline: payload.due_date,
        actual_date: payload.due_date,
      };

      setDashboardSummary((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          promisesList: [...previous.promisesList, addedPromise],
        };
      });
      setManualPromiseTask("");
      setManualPromiseDueDate("");
    } catch (error) {
      setDashboardError(
        error instanceof Error ? error.message : "Could not add manual promise.",
      );
    }
  }, [dashboardSummary, manualPromiseDueDate, manualPromisePerson, manualPromiseTask]);

  const startNewMeeting = useCallback(() => {
    clearTimer();
    releaseMediaResources();

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    setShowLandingView(false);
    setShowMeetingsView(false);
    setShowRecorderView(true);
    setDashboardSummary(null);
    setDashboardLoading(false);
    setDashboardError(null);
    setMeetingsError(null);
    setCompletedPromises({});

    setPhase("idle");
    setElapsedSeconds(0);
    setCapturedBytes(0);
    setRecordedBlob(null);
    setChunkProgressText(null);
    setUploadRetryAvailable(false);
    setUploadProgress(0);
    setMeetingId(null);
    setAutoProcessPending(false);
    setManualPromisePerson("You");
    setManualPromiseTask("");
    setManualPromiseDueDate("");
    setPreProcessWarning(null);
    setTranscriptionWarnings([]);
    setTranscriptionBusy(false);
    setProcessingProgress(0);
    setTranscriptionError(null);
    setTranscriptionText("");
    setExtractedPromises([]);
    setTranscriptionMeta(null);
    setRecordingError(null);
    setNotice("Press Record to request mic permission and start capturing.");
    uploadSessionRef.current = null;
    chunkListRef.current = [];
    recordedBytesRef.current = 0;
    stopRequestedRef.current = false;
    waveformStatsRef.current = createWaveformCaptureStats();

    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  }, [clearTimer, releaseMediaResources]);

  const processWithWhisper = useCallback(async (targetMeetingId?: string) => {
    const processingMeetingId = targetMeetingId ?? meetingId;
    if (!processingMeetingId) {
      setPhase("error");
      setRecordingError("Upload a meeting first, then start Whisper processing.");
      return;
    }

    setTranscriptionBusy(true);
    setProcessingProgress(8);
    setAutoProcessPending(false);
    setTranscriptionError(null);
    setTranscriptionWarnings([]);
    setRecordingError(null);
    setExtractedPromises([]);
    setNotice(
      "Running Whisper transcription. A 1 hour meeting can take around 5-10 minutes.",
    );

    let completed = false;
    try {
      const response = await fetch(`/api/meetings/${processingMeetingId}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedWhisperModel }),
      });

      const payload = (await response
        .json()
        .catch(() => null)) as WhisperProcessResponse | null;

      if (!response.ok) {
        const guidance =
          payload?.error_code === "unclear_audio"
            ? " Try speaking slower and clearer."
            : payload?.error_code === "background_noise"
              ? " Try a quieter place."
              : "";
        throw new Error((payload?.error ?? "Whisper processing failed.") + guidance);
      }

      setTranscriptionText(payload?.transcript_text ?? "");
      const promises = Array.isArray(payload?.promises_list) ? payload.promises_list : [];
      setExtractedPromises(promises);
      const warningsFromServer = Array.isArray(payload?.warnings)
        ? payload.warnings.filter((item): item is string => typeof item === "string")
        : [];
      setTranscriptionWarnings(warningsFromServer);
      setTranscriptionMeta({
        model: (payload?.model as "tiny" | "base" | undefined) ?? selectedWhisperModel,
        duration_seconds: payload?.duration_seconds ?? 0,
        processing_seconds: payload?.processing_seconds ?? 0,
        segment_count: payload?.segment_count ?? 0,
      });
      const summary: DashboardSummary = {
        meetingId: payload?.meeting_id ?? processingMeetingId,
        meetingTimestamp: payload?.meeting_timestamp ?? new Date().toISOString(),
        transcriptText: payload?.transcript_text ?? "",
        promisesList: promises,
        audioDownloadUrl: resolveAudioDownloadUrl(payload?.audio_download_url),
      };
      setDashboardSummary(summary);
      setCompletedPromises(buildCompletedMap(summary.promisesList));
      setShowLandingView(false);
      setShowMeetingsView(false);
      setShowRecorderView(false);
      setManualPromisePerson("You");
      setManualPromiseTask("");
      setManualPromiseDueDate("");
      setProcessingProgress(100);
      completed = true;

      if (typeof window !== "undefined") {
        window.localStorage.setItem("meeting_memory_last_meeting_id", summary.meetingId);
        window.history.replaceState(null, "", `/?meeting_id=${encodeURIComponent(summary.meetingId)}`);
      }
      if (promises.length === 0) {
        setNotice("We couldn't find clear action items");
      } else {
        setNotice("Whisper transcription complete.");
      }
    } catch (error) {
      setNotice(null);
      setTranscriptionError(
        error instanceof Error ? error.message : "Whisper processing failed unexpectedly.",
      );
    } finally {
      setTranscriptionBusy(false);
      if (!completed) {
        setProcessingProgress(0);
      }
    }
  }, [meetingId, selectedWhisperModel]);

  useEffect(() => {
    if (!autoProcessPending) return;
    if (!meetingId) return;
    if (transcriptionBusy) return;
    setAutoProcessPending(false);
    void processWithWhisper(meetingId);
  }, [autoProcessPending, meetingId, processWithWhisper, transcriptionBusy]);

  useEffect(() => {
    if (!transcriptionBusy) return;

    setProcessingProgress((previous) => (previous < 6 ? 6 : previous));
    const interval = window.setInterval(() => {
      setProcessingProgress((previous) => {
        if (previous >= 95) return 95;
        return Math.min(95, previous + 1);
      });
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [transcriptionBusy]);

  const previewUrl = useMemo(() => {
    if (!recordedBlob) return null;
    return URL.createObjectURL(recordedBlob);
  }, [recordedBlob]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    drawIdleWaveform();

    const handleResize = () => {
      if (phase !== "recording") drawIdleWaveform();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [drawIdleWaveform, phase]);

  useEffect(() => {
    return () => {
      clearTimer();
      stopWaveformAnimation();

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }
    };
  }, [clearTimer, stopWaveformAnimation]);

  useEffect(() => {
    if (!("permissions" in navigator) || !navigator.permissions.query) return;

    let mounted = true;
    let removePermissionListener: (() => void) | undefined;
    void navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (!mounted) return;

        const update = () => {
          setPermissionState(status.state);
        };

        update();
        status.addEventListener("change", update);
        removePermissionListener = () => {
          status.removeEventListener("change", update);
        };
      })
      .catch(() => {
        // Optional API; no-op when unavailable.
      });

    return () => {
      mounted = false;
      if (removePermissionListener) removePermissionListener();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (initialRouteHandledRef.current) return;
    initialRouteHandledRef.current = true;

    const url = new URL(window.location.href);
    const meetingFromUrl = url.searchParams.get("meeting_id")?.trim();
    const inboxFromUrl = url.searchParams.get("inbox")?.trim();

    if (inboxFromUrl) {
      setInboxToken(inboxFromUrl);
      void fetchMeetingsList({ token: inboxFromUrl });
      return;
    }

    if (meetingFromUrl) {
      void fetchMeetingSummary(meetingFromUrl);
      return;
    }

    const savedInboxToken = window.localStorage.getItem("meeting_memory_inbox_token");
    if (savedInboxToken) {
      setInboxToken(savedInboxToken);
      void fetchMeetingsList({ token: savedInboxToken });
      return;
    }

    const lastMeetingId = window.localStorage.getItem("meeting_memory_last_meeting_id");
    if (lastMeetingId) {
      void fetchMeetingSummary(lastMeetingId);
      return;
    }

    setShowLandingView(true);
    setShowMeetingsView(false);
    setShowRecorderView(true);
  }, [fetchMeetingSummary, fetchMeetingsList]);

  const hasValidEmail = isValidEmail(userEmail.trim());
  const shouldAskEmail = !!recordedBlob && phase !== "recording" && !hasValidEmail;

  useEffect(() => {
    if (shouldAskEmail) {
      emailInputRef.current?.focus();
    }
  }, [shouldAskEmail]);

  const statusLabel = useMemo(() => {
    switch (phase) {
      case "recording":
        return "Recording";
      case "stopping":
        return "Finalizing";
      case "ready":
        return hasValidEmail ? "Ready To Upload" : "Email Needed";
      case "uploading":
        return "Processing";
      case "uploaded":
        return "Uploaded";
      case "error":
        return uploadRetryAvailable ? "Upload Paused" : "Attention Needed";
      default:
        return "Idle";
    }
  }, [hasValidEmail, phase, uploadRetryAvailable]);

  const fileUsagePercent = Math.min((capturedBytes / MAX_FILE_BYTES) * 100, 100);
  const canRecord = phase !== "uploading" && phase !== "stopping" && !transcriptionBusy;
  const canUpload =
    !!recordedBlob &&
    hasValidEmail &&
    phase !== "recording" &&
    phase !== "stopping" &&
    phase !== "uploading" &&
    !transcriptionBusy;

  const startMeetingJourney = useCallback(() => {
    setShowLandingView(false);
    setShowMeetingsView(false);
    setShowRecorderView(true);
    setManualPromisePerson("You");
    setManualPromiseTask("");
    setManualPromiseDueDate("");
    setPreProcessWarning(null);
    setTranscriptionWarnings([]);
    setProcessingProgress(0);
    setNotice("Press Record to request mic permission and start capturing.");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  }, []);

  const openMeetingsFromEmail = useCallback(() => {
    const normalized = inboxEmail.trim().toLowerCase();
    void fetchMeetingsList({ email: normalized });
  }, [fetchMeetingsList, inboxEmail]);

  if (showMeetingsView) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-[0_16px_40px_rgba(64,30,18,0.12)] backdrop-blur sm:p-6">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#8d4d39]">
            Meeting Memory Inbox
          </p>
          <h1 className="mt-2 text-2xl leading-tight sm:text-4xl">All Your Meetings</h1>
          <p className="mt-2 text-sm text-[#5a392f]">
            {inboxEmail ? `Signed in as ${inboxEmail}` : "Open any meeting to review promises."}
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={inboxEmail}
              onChange={(event) => setInboxEmail(event.target.value)}
              placeholder="you@example.com"
              className="h-11 flex-1 rounded-xl border border-[#d7a789] bg-[#fffaf5] px-3 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
            />
            <button
              type="button"
              onClick={openMeetingsFromEmail}
              className="h-11 rounded-xl bg-[#1f5c3f] px-4 text-sm font-semibold text-white transition hover:bg-[#194c34]"
            >
              Load Meetings
            </button>
          </div>

          {meetingsLoading && <p className="mt-4 text-sm text-[#5a392f]">Loading meetings...</p>}
          {meetingsError && (
            <p className="mt-4 rounded-lg bg-[#fff4e9] p-3 text-sm text-[#8c412a]">
              {meetingsError}
            </p>
          )}

          <div className="mt-4 space-y-3">
            {meetingsList.map((meeting) => {
              const statusText =
                meeting.processing_status === "done"
                  ? `${meeting.open_count} open / ${meeting.done_count} done`
                  : meeting.processing_status;
              return (
                <button
                  key={meeting.meeting_id}
                  type="button"
                  onClick={() => {
                    void fetchMeetingSummary(meeting.meeting_id);
                  }}
                  className="w-full rounded-2xl border border-[#d6def4] bg-white p-4 text-left transition hover:border-[#8f3b26] hover:shadow-sm"
                >
                  <p className="text-sm font-semibold text-[#2d3a33]">
                    {formatLongDate(meeting.meeting_timestamp)}
                  </p>
                  <p className="mt-1 text-xs text-[#5a392f]">{statusText}</p>
                  <p className="mt-1 text-xs text-[#7b4b3c]">ID: {meeting.meeting_id}</p>
                </button>
              );
            })}
            {!meetingsLoading && meetingsList.length === 0 && (
              <p className="text-sm text-[#5a392f]">No meetings found for this inbox yet.</p>
            )}
          </div>

          <div className="mt-5">
            <button
              type="button"
              onClick={startMeetingJourney}
              className="h-11 rounded-xl bg-[#8f3b26] px-4 text-sm font-semibold text-white transition hover:bg-[#7d321f]"
            >
              Start Meeting
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!showRecorderView) {
    const summary = dashboardSummary;
    const meetingDateLabel = summary ? formatLongDate(summary.meetingTimestamp) : "Loading...";

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-[0_16px_40px_rgba(64,30,18,0.12)] backdrop-blur sm:p-6">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#8d4d39]">
            Meeting Memory Dashboard
          </p>
          <h1 className="mt-2 text-2xl leading-tight sm:text-4xl">
            Your Meeting Summary - {meetingDateLabel}
          </h1>

          {dashboardLoading && !summary && (
            <p className="mt-3 text-sm text-[#5a392f]">Loading summary...</p>
          )}

          {dashboardError && (
            <p className="mt-3 rounded-lg bg-[#fff4e9] p-3 text-sm text-[#8c412a]">
              {dashboardError}
            </p>
          )}

          {summary && (
            <>
              <div className="mt-4 rounded-2xl border border-[#cfd8ef] bg-[#f5f8ff] p-4">
                <p className="mb-2 text-sm font-semibold text-[#2e3d74]">Promises Made:</p>
                <div className="space-y-2">
                  {summary.promisesList.map((item, index) => {
                    const promiseKey = buildPromiseKey(item, index);
                    const checked = Boolean(completedPromises[promiseKey]);
                    const personLabel = item.person === "Speaker" ? "You" : item.person;
                    const deadlineText = item.deadline ? ` by ${item.deadline}` : "";
                    const actualDateText = item.actual_date
                      ? ` (${formatShortDate(item.actual_date)})`
                      : "";

                    return (
                      <label
                        key={promiseKey}
                        className="flex items-start gap-3 rounded-xl border border-[#d6def4] bg-white p-3"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePromiseDone(promiseKey, index)}
                          className="mt-0.5 h-5 w-5 accent-[#1f5c3f]"
                        />
                        <span
                          className={`text-sm ${
                            checked ? "text-[#6b7280] line-through" : "text-[#2d3a33]"
                          }`}
                        >
                          {personLabel}: {item.task}
                          {deadlineText}
                          {actualDateText}
                        </span>
                      </label>
                    );
                  })}
                  {summary.promisesList.length === 0 && (
                    <p className="text-sm text-[#5a392f]">We could not find clear action items.</p>
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-[#d7a789] bg-[#fff7ee] p-4">
                <p className="mb-2 text-sm font-semibold text-[#8c412a]">
                  Add Missing Promise
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input
                    type="text"
                    value={manualPromisePerson}
                    onChange={(event) => setManualPromisePerson(event.target.value)}
                    placeholder="Person (default: You)"
                    className="h-10 rounded-lg border border-[#d7a789] bg-white px-3 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
                  />
                  <input
                    type="text"
                    value={manualPromiseTask}
                    onChange={(event) => setManualPromiseTask(event.target.value)}
                    placeholder="Task (required)"
                    className="h-10 rounded-lg border border-[#d7a789] bg-white px-3 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2 sm:col-span-2"
                  />
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="date"
                    value={manualPromiseDueDate}
                    onChange={(event) => setManualPromiseDueDate(event.target.value)}
                    className="h-10 rounded-lg border border-[#d7a789] bg-white px-3 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void addManualPromise();
                    }}
                    className="h-10 rounded-lg bg-[#8f3b26] px-4 text-sm font-semibold text-white transition hover:bg-[#7d321f]"
                  >
                    Add Promise
                  </button>
                </div>
              </div>

              <details className="mt-4 rounded-2xl border border-[#cfe3d8] bg-[#f6fffa] p-4">
                <summary className="cursor-pointer text-sm font-semibold text-[#2f5d47]">
                  Full Transcript (click to expand)
                </summary>
                <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-sm text-[#2d3a33]">
                  {summary.transcriptText || "Transcript not available."}
                </p>
              </details>
            </>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <a
              href={summary?.audioDownloadUrl ?? "#"}
              className={`flex h-12 items-center justify-center rounded-xl text-sm font-semibold text-white transition ${
                summary?.audioDownloadUrl
                  ? "bg-[#1f5c3f] hover:bg-[#194c34]"
                  : "cursor-not-allowed bg-[#9ca3af]"
              }`}
              aria-disabled={!summary?.audioDownloadUrl}
            >
              Download Audio
            </a>
            <button
              type="button"
              onClick={() => {
                if (inboxToken) {
                  void fetchMeetingsList({ token: inboxToken });
                } else {
                  setShowMeetingsView(true);
                  setShowRecorderView(false);
                  setShowLandingView(false);
                }
              }}
              className="h-12 rounded-xl bg-[#2e3d74] text-sm font-semibold text-white transition hover:bg-[#26356a]"
            >
              Meetings List
            </button>
            <button
              type="button"
              onClick={startNewMeeting}
              className="h-12 rounded-xl bg-[#8f3b26] text-sm font-semibold text-white transition hover:bg-[#7d321f]"
            >
              New Meeting
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (showLandingView) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-[0_16px_40px_rgba(64,30,18,0.12)] backdrop-blur sm:p-8">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#8d4d39]">
            Meeting Memory
          </p>
          <h1 className="mt-2 text-3xl leading-tight sm:text-5xl">Capture Promises, Not Notes</h1>
          <p className="mt-3 max-w-2xl text-sm text-[#5a392f] sm:text-base">
            Record your meeting, we transcribe it, extract who promised what by when, then
            remind people automatically.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={startMeetingJourney}
              className="h-14 rounded-xl bg-[#8f3b26] text-base font-semibold text-white transition hover:bg-[#7d321f]"
            >
              Start Meeting
            </button>
            <button
              type="button"
              onClick={() => {
                setShowLandingView(false);
                setShowRecorderView(false);
                setShowMeetingsView(true);
              }}
              className="h-14 rounded-xl border border-[#8f3b26] bg-[#fff7ee] text-base font-semibold text-[#8f3b26] transition hover:bg-[#fde9dc]"
            >
              Open My Meetings
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={inboxEmail}
              onChange={(event) => setInboxEmail(event.target.value)}
              placeholder="Email for meeting list"
              className="h-11 flex-1 rounded-xl border border-[#d7a789] bg-[#fffaf5] px-3 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
            />
            <button
              type="button"
              onClick={openMeetingsFromEmail}
              className="h-11 rounded-xl bg-[#1f5c3f] px-4 text-sm font-semibold text-white transition hover:bg-[#194c34]"
            >
              Load by Email
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <section className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-[0_20px_60px_rgba(64,30,18,0.12)] backdrop-blur">
        <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#8d4d39]">
          Meeting Memory - Phase 7 / Step 12
        </p>
        <h1 className="mt-3 text-3xl leading-tight sm:text-5xl">
          Record A Meeting And Capture Commitments.
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-[#5a392f] sm:text-base">
          Start recording, upload once, and get an email when your summary is ready.
          Returning users can open their meetings inbox and mark tasks done.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <article className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-[0_16px_40px_rgba(64,30,18,0.12)] backdrop-blur sm:p-7">
          <div className="flex items-center justify-between">
            <span className="rounded-full border border-[#d7a789] bg-[#fff7ee] px-4 py-1 text-xs font-medium uppercase tracking-[0.14em] text-[#8b4129]">
              {statusLabel}
            </span>
            <span className="font-mono text-xl text-[#7f3a28]">{formatDuration(elapsedSeconds)}</span>
          </div>

          <div className="mt-6 rounded-2xl border border-[#3f2219] bg-[var(--wave-bg)] p-3">
            <canvas ref={waveformCanvasRef} className="h-36 w-full rounded-xl" />
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              disabled={!canRecord}
              onClick={() => {
                if (phase === "recording") stopRecording("manual");
                else void startRecording();
              }}
              className={`relative flex h-36 w-36 items-center justify-center rounded-full border-8 border-[#ffd9c6] text-lg font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
                phase === "recording"
                  ? "pulse-ring bg-[var(--accent-dark)]"
                  : "bg-[var(--accent)] hover:bg-[var(--accent-dark)]"
              }`}
            >
              {phase === "recording" ? "Stop" : "Record"}
            </button>
          </div>

          <p className="mt-4 text-center text-xs text-[#7f3a28]">
            Best results: speak clearly and record in a quiet place.
          </p>

          {notice && (
            <p className="mt-5 text-center text-sm font-medium text-[#7f3a28]">{notice}</p>
          )}
          {recordingError && (
            <p className="mt-2 text-center text-sm font-medium text-[#9b1f1f]">{recordingError}</p>
          )}
        </article>

        <aside className="rounded-3xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-[0_16px_40px_rgba(64,30,18,0.12)] backdrop-blur sm:p-6">
          <h2 className="text-xl">Upload Panel</h2>
          <div className="mt-4 space-y-3 text-sm text-[#4f3129]">
            <p>
              <strong>Permission:</strong> {permissionState}
            </p>
            <p>
              <strong>Format:</strong> {selectedMimeType}
            </p>
            <p>
              <strong>Current size:</strong> {formatBytes(capturedBytes)} /{" "}
              {formatBytes(MAX_FILE_BYTES)}
            </p>
          </div>

          <div className="mt-4 h-2 w-full rounded-full bg-[#f0ceb8]">
            <div
              className="h-2 rounded-full bg-[#ce5337] transition-all"
              style={{ width: `${fileUsagePercent}%` }}
            />
          </div>

          {shouldAskEmail && (
            <p className="mt-4 rounded-lg border border-[#d7a789] bg-[#fff4e9] px-3 py-2 text-xs font-semibold text-[#8c412a]">
              Enter your email for reminders before upload.
            </p>
          )}

          <label className="mt-5 block text-sm font-medium text-[#4f3129]">
            Reminder Email
            <input
              ref={emailInputRef}
              type="email"
              value={userEmail}
              onChange={(event) => setUserEmail(event.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-xl border border-[#d7a789] bg-[#fffaf5] px-3 py-2 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
            />
          </label>

          <button
            type="button"
            disabled={!canUpload}
            onClick={() => {
              void uploadRecording(false);
            }}
            className="mt-4 w-full rounded-xl bg-[#8f3b26] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#7d321f] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {phase === "uploading" ? `Processing... ${uploadProgress}%` : "Upload Recording"}
          </button>

          {uploadRetryAvailable && phase === "error" && (
            <button
              type="button"
              onClick={() => {
                void uploadRecording(true);
              }}
              className="mt-2 w-full rounded-xl border border-[#8f3b26] bg-[#fff7ee] px-4 py-2.5 text-sm font-semibold text-[#8f3b26] transition hover:bg-[#fde9dc]"
            >
              Retry Upload
            </button>
          )}

          {chunkProgressText && (
            <p className="mt-3 text-xs font-medium text-[#5a3428]">{chunkProgressText}</p>
          )}

          {meetingId && (
            <p className="mt-3 rounded-lg bg-[#fff7ee] p-2 text-xs text-[#5a3428]">
              Meeting ID: <span className="font-mono">{meetingId}</span>
            </p>
          )}

          {previewUrl && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#8b4129]">
                Local Preview
              </p>
              <audio controls src={previewUrl} className="w-full" />
            </div>
          )}

          <div className="mt-6 border-t border-[#d7a789] pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#8b4129]">
              Whisper AI
            </p>
            <p className="mt-2 text-xs text-[#5a3428]">
              `tiny` is faster but less accurate. `base` is the recommended balance.
            </p>

            <label className="mt-3 block text-sm font-medium text-[#4f3129]">
              Model
              <select
                value={selectedWhisperModel}
                onChange={(event) => {
                  const value = event.target.value === "tiny" ? "tiny" : "base";
                  setSelectedWhisperModel(value);
                }}
                className="mt-1 w-full rounded-xl border border-[#d7a789] bg-[#fffaf5] px-3 py-2 text-sm text-[#2c1a13] outline-none ring-[#c14e34] transition focus:ring-2"
              >
                <option value="base">base (recommended)</option>
                <option value="tiny">tiny (fastest)</option>
              </select>
            </label>

            {preProcessWarning && phase === "uploaded" && !transcriptionBusy && (
              <p className="mt-3 rounded-lg border border-[#e3b341] bg-[#fff8e8] p-2 text-xs text-[#8a5714]">
                {preProcessWarning}
              </p>
            )}

            <button
              type="button"
              disabled={!meetingId || transcriptionBusy}
              onClick={() => {
                void processWithWhisper();
              }}
              className="mt-3 w-full rounded-xl bg-[#1f5c3f] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#194c34] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {transcriptionBusy
                ? "Whisper Processing..."
                : preProcessWarning && phase === "uploaded"
                  ? "Process Anyway"
                  : "Process With Whisper"}
            </button>

            {transcriptionBusy && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-[#2f5d47]">
                  <span>Transcription progress</span>
                  <span>{processingProgress}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-[#d5eadf]">
                  <div
                    className="h-2 rounded-full bg-[#1f5c3f] transition-all"
                    style={{ width: `${processingProgress}%` }}
                  />
                </div>
              </div>
            )}

            {transcriptionError && (
              <p className="mt-3 text-sm font-medium text-[#9b1f1f]">{transcriptionError}</p>
            )}

            {transcriptionMeta && (
              <p className="mt-3 rounded-lg bg-[#eef8f2] p-2 text-xs text-[#214734]">
                Model: {transcriptionMeta.model} | Duration:{" "}
                {Math.round(transcriptionMeta.duration_seconds)}s | Time:{" "}
                {Math.round(transcriptionMeta.processing_seconds)}s | Segments:{" "}
                {transcriptionMeta.segment_count}
              </p>
            )}

            {transcriptionWarnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-[#e3b341] bg-[#fff8e8] p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#8a5714]">
                  Quality Warnings
                </p>
                <ul className="mt-2 space-y-1 text-xs text-[#8a5714]">
                  {transcriptionWarnings.map((item, index) => (
                    <li key={`${item}-${index}`}>- {item}</li>
                  ))}
                </ul>
              </div>
            )}

            {extractedPromises.length > 0 && (
              <div className="mt-3 rounded-xl border border-[#cfd8ef] bg-[#f5f8ff] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#2e3d74]">
                  Promises
                </p>
                <div className="space-y-2">
                  {extractedPromises.map((item, index) => (
                    <div
                      key={`${item.person}-${item.task}-${index}`}
                      className="rounded-lg border border-[#d6def4] bg-white p-2"
                    >
                      <p className="text-xs font-semibold text-[#26356a]">Person: {item.person}</p>
                      <p className="text-sm text-[#2d3a33]">What: {item.task}</p>
                      <p className="text-xs text-[#4d5a8a]">
                        Deadline: {item.deadline ?? "Not specified"}
                      </p>
                      <p className="text-xs text-[#4d5a8a]">
                        Actual Date: {item.actual_date ?? "Not resolved"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {transcriptionText && extractedPromises.length === 0 && (
              <p className="mt-3 rounded-lg bg-[#fff7ee] p-2 text-xs text-[#5a3428]">
                We could not find clear action items.
              </p>
            )}

            {transcriptionText && (
              <div className="mt-3 rounded-xl border border-[#cfe3d8] bg-[#f6fffa] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#2f5d47]">
                  Transcript
                </p>
                <p className="max-h-48 overflow-auto whitespace-pre-wrap text-sm text-[#2d3a33]">
                  {transcriptionText}
                </p>
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
