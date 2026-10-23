# -*- coding: utf-8 -*-
"""本地兜底翻唱（不依赖 HF 额度）：demucs 分离 + World 共振峰搬移换嗓。

和 Seed-VC 的区别：
  Seed-VC 是神经网络换嗓，效果最好，但要 HF 的免费 GPU 额度（每天有限）。
  这个脚本纯本地：把原唱人声的「频谱包络」往目标音色靠（共振峰搬移 + 频谱倾斜匹配），
  保留原唱的基频曲线（= 旋律不动），所以听起来是"同一个人唱的另一个嗓子"。

用法：
  python cover_local.py --song 踏山河.wav --out cover.mp3 --seconds 10 [--start 45]
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
ROOT = os.path.dirname(os.path.abspath(__file__))
DEMUCS_PY = os.path.join(ROOT, ".venv-demucs", "Scripts", "python.exe")
SR = 24000


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def cut(src, dst, seconds, start=0.0):
    args = [FFMPEG, "-y", "-loglevel", "error"]
    if start > 0:
        args += ["-ss", str(start)]
    args += ["-t", str(seconds), "-i", src, "-ac", "1", "-ar", str(SR), dst]
    run(args)
    return dst


def auto_start(src, seconds):
    """跳过前奏：取"够响的最早一段"。"""
    try:
        import numpy as np
        p = subprocess.run([FFMPEG, "-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                           capture_output=True)
        x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        sr = 16000
        if len(x) < seconds * sr:
            return 0.0
        wins = []
        for st in range(0, len(x) - seconds * sr + 1, 5 * sr):
            seg = x[st:st + seconds * sr]
            wins.append((st / sr, float(np.sqrt((seg ** 2).mean()))))
        if not wins:
            return 0.0
        peak = max(r for _, r in wins)
        for t, r in wins:
            if r >= peak * 0.85:
                return float(t)
        return 0.0
    except Exception:
        return 0.0


def load(path):
    import numpy as np
    p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f64le", "-"],
                       capture_output=True)
    return np.frombuffer(p.stdout, dtype=np.float64)


def save(x, path):
    import numpy as np
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    wav = (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt " +
           (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") +
           SR.to_bytes(4, "little") + (SR * 2).to_bytes(4, "little") +
           (2).to_bytes(2, "little") + (16).to_bytes(2, "little") +
           b"data" + len(pcm).to_bytes(4, "little") + pcm)
    open(path, "wb").write(wav)


def separate(vocal_src, workdir):
    outroot = os.path.join(workdir, "sep")
    stem = os.path.splitext(os.path.basename(vocal_src))[0]
    outdir = os.path.join(outroot, "htdemucs", stem)
    v = os.path.join(outdir, "vocals.wav")
    inst = os.path.join(outdir, "no_vocals.wav")
    if os.path.isfile(v) and os.path.isfile(inst):
        return v, inst
    if not os.path.isfile(DEMUCS_PY):
        return vocal_src, ""
    print("[sep] demucs 分离…", flush=True)
    run([DEMUCS_PY, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
         "-o", outroot, os.path.abspath(vocal_src)], cwd=workdir, timeout=3600)
    return (v if os.path.isfile(v) else vocal_src), (inst if os.path.isfile(inst) else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--voice", default="v2")
    ap.add_argument("--formant", type=float, default=1.0, help="共振峰缩放，>1 更厚 <1 更细")
    a = ap.parse_args()

    import numpy as np
    import pyworld as pw

    work = tempfile.mkdtemp(prefix="cvl-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    start = a.start if a.start > 0 else auto_start(a.song, int(a.seconds))
    print(f"[cvl] 起点 {start:.0f}s 时长 {a.seconds:.0f}s", flush=True)
    clip = cut(a.song, os.path.join(work, "song.wav"), a.seconds, start)
    vocals, inst = separate(clip, work)

    x = load(vocals)
    f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=700.0, frame_period=5.0)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap_ = pw.d4c(x, f0, t, SR)

    # 目标音色的平均频谱（按自身音高归一化）
    ref_path = os.path.join(ROOT, "audio", "voices", a.voice + ".wav")
    ref = load(ref_path) if os.path.isfile(ref_path) else None
    if ref is not None and len(ref) > SR:
        rf0, rt = pw.harvest(ref, SR, f0_floor=60.0, f0_ceil=600.0, frame_period=5.0)
        rsp = pw.cheaptrick(ref, rf0, rt, SR)
        vmask = rf0 > 0
        if vmask.sum() > 5:
            tgt_env = np.exp(np.mean(np.log(rsp[vmask] + 1e-12), axis=0))
            src_env = np.exp(np.mean(np.log(sp[f0 > 0] + 1e-12), axis=0))
            # 平滑增益：让源频谱的整体形状靠近目标（音色迁移）
            g = np.log(tgt_env + 1e-12) - np.log(src_env + 1e-12)
            k = np.hanning(31) / np.hanning(31).sum()
            g = np.convolve(g, k, mode="same")
            # 限制幅度，避免过度失真
            g = np.clip(g, -1.2, 1.2)
            sp = sp * np.exp(g * 0.55)
            print("[cvl] 已把频谱形状向目标音色靠拢", flush=True)

    # 共振峰搬移（可选）：按比例压缩/拉伸频率轴
    if abs(a.formant - 1.0) > 1e-3:
        n_bins = sp.shape[1]
        src_idx = np.arange(n_bins) * (1.0 / a.formant)
        lo = np.floor(src_idx).astype(int)
        hi = np.minimum(lo + 1, n_bins - 1)
        frac = (src_idx - lo)[None, :]
        sp = sp[:, lo] * (1 - frac) + sp[:, hi] * frac
        print(f"[cvl] 共振峰缩放 {a.formant:.2f}x", flush=True)

    y = pw.synthesize(f0, sp, ap_, SR, frame_period=5.0)
    voc = os.path.join(work, "voc.wav")
    save(y, voc)

    if inst and os.path.isfile(inst):
        r = run([FFMPEG, "-y", "-loglevel", "error", "-i", voc, "-i", inst,
                 "-filter_complex",
                 "[0:a]volume=1.0,aecho=0.8:0.4:50:0.15[V];[1:a]volume=0.75[D];"
                 "[V][D]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]",
                 "-map", "[out]", "-ac", "1", "-ar", str(SR), "-b:a", "128k", a.out])
    else:
        r = run([FFMPEG, "-y", "-loglevel", "error", "-i", voc,
                 "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                 "-ac", "1", "-ar", str(SR), "-b:a", "128k", a.out])
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败：" + (r.stderr or "")[:300])
    print(f"OK {a.out} {os.path.getsize(a.out)} bytes {a.seconds:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
