import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.syncnet_service import (
    ANALYSIS_WINDOW_SECONDS,
    FACE_DETECTION_SCALE,
    MAX_VIDEO_DURATION_SECONDS,
    MIN_FACE_SIZE_PIXELS,
    SyncNetInferenceError,
    SyncNetInputError,
    SYNCNET_CPU_THREADS,
    _syncnet_cpu_thread_limit,
    analyze_syncnet_video,
    get_syncnet_status,
    _extract_analysis_window,
    _probe_duration,
    _select_analysis_window,
)


def test_probe_duration_accepts_video_within_syncnet_limit(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(
        "backend.syncnet_service.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout="42.5\n", stderr=""),
    )

    assert _probe_duration(tmp_path / "sample.mp4") == 42.5


def test_probe_duration_rejects_video_over_limit(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(
        "backend.syncnet_service.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0],
            0,
            stdout=f"{MAX_VIDEO_DURATION_SECONDS + 1}\n",
            stderr="",
        ),
    )

    with pytest.raises(SyncNetInputError, match="no more than"):
        _probe_duration(tmp_path / "long.mp4")


def test_probe_duration_reports_unreadable_media(monkeypatch, tmp_path: Path):
    def fail_to_probe(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0])

    monkeypatch.setattr("backend.syncnet_service.subprocess.run", fail_to_probe)

    with pytest.raises(SyncNetInputError, match="could not be probed"):
        _probe_duration(tmp_path / "invalid.mp4")


def test_extract_analysis_window_seeks_before_decoding(monkeypatch, tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "segment.mp4"
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        output.write_bytes(b"segment")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("backend.syncnet_service.subprocess.run", run)

    _extract_analysis_window(source, output, 20.0, 5.0)

    command = commands[0]
    assert command.index("-ss") < command.index("-i")
    assert command[command.index("-ss") + 1] == "20.000000"


@pytest.mark.parametrize(
    ("source_duration", "expected_start", "expected_duration"),
    [
        (3.5, 0.0, 3.5),
        (ANALYSIS_WINDOW_SECONDS, 0.0, ANALYSIS_WINDOW_SECONDS),
        (7.5, 1.25, ANALYSIS_WINDOW_SECONDS),
        (45.0, 20.0, ANALYSIS_WINDOW_SECONDS),
        (60.0, 27.5, ANALYSIS_WINDOW_SECONDS),
    ],
)
def test_select_analysis_window_handles_short_and_long_videos(
    source_duration: float,
    expected_start: float,
    expected_duration: float,
):
    assert _select_analysis_window(source_duration) == (expected_start, expected_duration)


def test_select_analysis_window_rejects_non_positive_or_non_finite_durations():
    for duration in (0.0, -1.0, float("inf"), float("nan")):
        with pytest.raises(SyncNetInputError, match="positive, finite"):
            _select_analysis_window(duration)


def test_syncnet_cpu_thread_limit_restores_previous_count():
    thread_state = {"count": 8}
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        get_num_threads=lambda: thread_state["count"],
        set_num_threads=lambda count: thread_state.update(count=count),
    )

    with _syncnet_cpu_thread_limit(torch):
        assert thread_state["count"] == SYNCNET_CPU_THREADS

    assert thread_state["count"] == 8
    with pytest.raises(RuntimeError, match="scoring failed"):
        with _syncnet_cpu_thread_limit(torch):
            raise RuntimeError("scoring failed")

    assert thread_state["count"] == 8


@pytest.mark.parametrize(
    ("source_duration", "expected_start", "expected_end", "expect_extraction"),
    [
        (3.5, 0.0, 3.5, False),
        (7.5, 1.25, 6.25, True),
        (45.0, 20.0, 25.0, True),
    ],
)
def test_analysis_reports_analyzed_window_without_claiming_full_video_was_analyzed(
    monkeypatch,
    tmp_path: Path,
    source_duration: float,
    expected_start: float,
    expected_end: float,
    expect_extraction: bool,
):
    monkeypatch.setattr("backend.syncnet_service._require_syncnet", lambda: None)
    monkeypatch.setattr("backend.syncnet_service._probe_duration", lambda _path: source_duration)
    extracted_segments = []

    def extract_segment(source, output, start, duration):
        extracted_segments.append((source, output, start, duration))
        output.write_bytes(b"temporary segment")

    monkeypatch.setattr("backend.syncnet_service._extract_analysis_window", extract_segment)
    pipeline_commands = []
    pipeline_environments = []

    def run_pipeline(command, **kwargs):
        pipeline_commands.append(command)
        pipeline_environments.append(kwargs["env"])
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("backend.syncnet_service.subprocess.run", run_pipeline)

    result = analyze_syncnet_video(tmp_path / "source.mp4")

    assert len(extracted_segments) == int(expect_extraction)
    expected_input = extracted_segments[0][1] if expect_extraction else tmp_path / "source.mp4"
    command = pipeline_commands[0]
    assert Path(command[command.index("--videofile") + 1]) == expected_input
    assert command[command.index("--facedet_scale") + 1] == str(FACE_DETECTION_SCALE)
    assert command[command.index("--min_face_size") + 1] == str(MIN_FACE_SIZE_PIXELS)
    assert {
        variable: pipeline_environments[0][variable]
        for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS")
    } == {
        variable: str(SYNCNET_CPU_THREADS)
        for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS")
    }
    if expect_extraction:
        assert extracted_segments[0][2:] == (expected_start, ANALYSIS_WINDOW_SECONDS)
    assert result["video_duration_seconds"] == source_duration
    assert result["analysis_segment_start_seconds"] == expected_start
    assert result["analysis_segment_end_seconds"] == expected_end
    assert result["analysis_segment_duration_seconds"] == expected_end - expected_start
    assert result["face_detection_scale"] == FACE_DETECTION_SCALE
    assert result["min_face_size_pixels"] == MIN_FACE_SIZE_PIXELS
    assert result["tracks"] == []


def test_pipeline_timeout_is_reported_as_inference_timeout(monkeypatch, tmp_path: Path):
    monkeypatch.setattr("backend.syncnet_service._require_syncnet", lambda: None)
    monkeypatch.setattr("backend.syncnet_service._probe_duration", lambda _path: 3.5)

    def time_out(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr("backend.syncnet_service.subprocess.run", time_out)

    with pytest.raises(SyncNetInferenceError, match="15-minute processing limit"):
        analyze_syncnet_video(tmp_path / "sample.mp4")


def test_status_reports_missing_runtime_dependencies(monkeypatch):
    monkeypatch.setattr(
        "backend.syncnet_service.find_spec",
        lambda module: None if module == "scenedetect" else object(),
    )

    status = get_syncnet_status()

    assert status["configured"] is False
    assert "PySceneDetect" in status["missing_dependencies"]
    assert status["analysis_window_seconds"] == ANALYSIS_WINDOW_SECONDS
