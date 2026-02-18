#!/usr/bin/env python3
"""
Whisper transcription runner for Meeting Memory.

Outputs JSON to stdout only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

MAX_DURATION_SECONDS = 60 * 60
ALLOWED_MODELS = {"tiny", "base"}


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.exit(exit_code)


def safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return fallback


def build_quality_metrics(segments: list[dict[str, Any]]) -> dict[str, float]:
    if not segments:
        return {
            "avg_no_speech_prob": 1.0,
            "avg_logprob": -10.0,
            "avg_compression_ratio": 10.0,
        }

    total = float(len(segments))
    avg_no_speech = sum(safe_float(s.get("no_speech_prob"), 0.0) for s in segments) / total
    avg_logprob = sum(safe_float(s.get("avg_logprob"), -1.0) for s in segments) / total
    avg_compression = (
        sum(safe_float(s.get("compression_ratio"), 1.0) for s in segments) / total
    )
    return {
        "avg_no_speech_prob": avg_no_speech,
        "avg_logprob": avg_logprob,
        "avg_compression_ratio": avg_compression,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Whisper transcription and return JSON.")
    parser.add_argument("--input", required=True, help="Absolute path to audio file.")
    parser.add_argument(
        "--model",
        default="base",
        choices=sorted(ALLOWED_MODELS),
        help="Whisper model size. tiny/base only for V1.",
    )
    parser.add_argument("--meeting-id", required=True, help="Meeting id for response metadata.")
    parser.add_argument("--language", default=None, help="Optional language code, e.g. en")
    args = parser.parse_args()

    input_path = os.path.abspath(args.input)
    if not os.path.isfile(input_path):
        emit(
            {
                "ok": False,
                "error_code": "missing_file",
                "message": "Audio file not found.",
            }
        )

    try:
        import whisper  # type: ignore
    except Exception as exc:  # pragma: no cover
        emit(
            {
                "ok": False,
                "error_code": "dependency_missing",
                "message": (
                    "Whisper dependencies are not installed. Install python requirements "
                    "and ffmpeg first."
                ),
                "details": str(exc),
            }
        )

    started = time.time()

    try:
        audio = whisper.load_audio(input_path)
        duration_seconds = len(audio) / whisper.audio.SAMPLE_RATE

        if duration_seconds > MAX_DURATION_SECONDS:
            emit(
                {
                    "ok": False,
                    "error_code": "too_long",
                    "message": "Please split into 1 hour parts",
                    "duration_seconds": duration_seconds,
                }
            )

        model = whisper.load_model(args.model)

        transcribe_kwargs: dict[str, Any] = {
            "fp16": False,
            "temperature": 0,
            "verbose": False,
            "task": "transcribe",
        }
        if args.language:
            transcribe_kwargs["language"] = args.language

        result = model.transcribe(input_path, **transcribe_kwargs)
        raw_text = (result.get("text") or "").strip()
        segments = result.get("segments") or []
        quality = build_quality_metrics(segments)

        if len(raw_text) < 8 or quality["avg_no_speech_prob"] >= 0.78:
            emit(
                {
                    "ok": False,
                    "error_code": "unclear_audio",
                    "message": "Couldn't hear clearly",
                    "quality": quality,
                }
            )

        if (
            quality["avg_compression_ratio"] > 2.4
            and quality["avg_logprob"] < -0.9
            and quality["avg_no_speech_prob"] > 0.45
        ):
            emit(
                {
                    "ok": False,
                    "error_code": "background_noise",
                    "message": "Try quieter place",
                    "quality": quality,
                }
            )

        processing_seconds = time.time() - started
        emit(
            {
                "ok": True,
                "meeting_id": args.meeting_id,
                "model": args.model,
                "duration_seconds": duration_seconds,
                "processing_seconds": processing_seconds,
                "segment_count": len(segments),
                "transcript_text": raw_text,
                "quality": quality,
            }
        )
    except Exception as exc:  # pragma: no cover
        message = str(exc)
        lowered = message.lower()

        if (
            "ffmpeg" in lowered
            or "winerror 2" in lowered
            or "system cannot find the file specified" in lowered
        ):
            emit(
                {
                    "ok": False,
                    "error_code": "dependency_missing",
                    "message": "Whisper requires ffmpeg installed on the server.",
                    "details": message,
                }
            )

        emit(
            {
                "ok": False,
                "error_code": "transcription_failed",
                "message": "Transcription failed unexpectedly.",
                "details": message,
            }
        )


if __name__ == "__main__":
    main()
