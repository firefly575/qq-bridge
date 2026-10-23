# -*- coding: utf-8 -*-
"""把「要说的话」用翻唱那套音色发出去。

流程：edge-tts 合成 → Seed-VC 换成 ref 音色 → mp3
兜底：Seed-VC 不可用（额度/网络）时，退化为「按音高差移调」的近似音色，至少音区一致。

用法：
  python speak_voice.py --text "喵，晚上好呀" --out out.mp3 [--voice v2]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cover  # noqa: E402

FFMPEG = cover.FFMPEG
ROOT = cover.ROOT


def tts_to_wav(text: str, dest: str, tts_voice: str) -> str:
    r = subprocess.run([sys.executable, "-m", "edge_tts", "-t", text, "-v", tts_voice,
                        "--write-media", dest], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if not os.path.isfile(dest) or os.path.getsize(dest) < 2000:
        raise SystemExit("TTS 合成失败：" + (r.stderr or "")[-300:])
    return dest


def norm_wav(src: str, dst: str) -> str:
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "44100", dst],
                   capture_output=True)
    return dst


def median_f0(path: str) -> float:
    """粗测中位 F0，用于退化方案算移调量。"""
    try:
        import numpy as np
        p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", "16000",
                            "-f", "s16le", "-"], capture_output=True)
        x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        win, hop, sr = 1024, 512, 16000
        vals = []
        for i in range(0, len(x) - win, hop):
            seg = x[i:i + win]
            if (seg ** 2).mean() ** 0.5 < 0.012:
                continue
            seg = seg - seg.mean()
            ac = np.correlate(seg, seg, mode="full")[win - 1:]
            ac /= (ac[0] + 1e-9)
            lo, hi = int(sr / 1000), int(sr / 70)
            if hi >= len(ac):
                continue
            k = lo + int(np.argmax(ac[lo:hi]))
            if ac[k] > 0.3:
                vals.append(sr / k)
        return float(np.median(vals)) if vals else 0.0
    except Exception:
        return 0.0


def pitch_shift(src: str, dst: str, semitones: float) -> str:
    ratio = 2 ** (semitones / 12.0)
    af = f"asetrate=44100*{ratio:.5f},aresample=44100,atempo={1/ratio:.5f},loudnorm=I=-16:TP=-1.5:LRA=11"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-af", af,
                    "-ac", "1", "-ar", "24000", "-b:a", "128k", dst], capture_output=True)
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="v2")
    ap.add_argument("--tts-voice", default="zh-CN-XiaoyiNeural")
    ap.add_argument("--steps", type=int, default=16)
    ap.add_argument("--no-convert", action="store_true", help="只用移调近似，不调 Seed-VC")
    a = ap.parse_args()

    ref = os.path.join(ROOT, "audio", "voices", a.voice + ".wav")
    if not os.path.isfile(ref):
        raise SystemExit(f"没有音色预设 {a.voice}")

    work = tempfile.mkdtemp(prefix="speak-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    raw = os.path.join(work, "tts.wav")
    tts_to_wav(a.text, raw, a.tts_voice)
    clip = norm_wav(raw, os.path.join(work, "tts44.wav"))

    if not a.no_convert:
        try:
            conv = cover.convert(clip, ref, work, a.steps, 0.7)
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", conv,
                            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                            "-ac", "1", "-ar", "24000", "-b:a", "128k", a.out], capture_output=True)
            if os.path.isfile(a.out) and os.path.getsize(a.out) > 3000:
                print(f"OK {a.out} (vc) {os.path.getsize(a.out)}")
                return 0
        except SystemExit as e:
            print(f"[speak] Seed-VC 不可用，退化移调：{e}", flush=True)
        except Exception as e:
            print(f"[speak] Seed-VC 异常，退化移调：{type(e).__name__}: {e}", flush=True)

    # 兜底：按参考音高差移调，至少让音区和翻唱一致
    tts_f0 = median_f0(clip)
    ref_f0 = median_f0(ref)
    semis = 0.0
    if tts_f0 > 0 and ref_f0 > 0:
        import math
        semis = 12 * math.log2(ref_f0 / tts_f0)
        semis = max(-12.0, min(12.0, semis))
    print(f"[speak] 移调近似：tts={tts_f0:.1f}Hz ref={ref_f0:.1f}Hz -> {semis:+.1f} 半音", flush=True)
    pitch_shift(clip, a.out, semis)
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 3000:
        raise SystemExit("输出失败")
    print(f"OK {a.out} (pitch) {os.path.getsize(a.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
