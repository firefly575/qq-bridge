# -*- coding: utf-8 -*-
"""用复刻音色唱（v3：World 声码器替换基频，不做切音）。

思路：
  TTS 合成整句 → World 分解出 f0 / 频谱包络 / 非周期成分
  → 把 f0 换成旋律音符（保留原来的频谱包络 = 保留音色）
  → 重新合成 → 加颤音/混响/铺底

比 v1（逐字合成）和 v2（切音节再变速）好的地方：
  * 不切断音频，连读和辅音都保留
  * 只改基频，音色（频谱包络）完全不动，不会变鸭子或电音

用法：
  python sing_world.py --text "小星星亮晶晶" --out out.mp3 [--tune star] [--note-sec 0.6]
注意：本脚本依赖 pyworld + numpy，要用装了它们的解释器（.venv-demucs）。
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aliyun_tts  # noqa: E402

FFMPEG = aliyun_tts.FFMPEG
ROOT = aliyun_tts.ROOT
SR = 24000

TUNES = {
    "star":  [0, 0, 7, 7, 9, 9, 7],
    "twinkle": [0, 0, 7, 7, 9, 9, 7, 5, 5, 4, 4, 2, 2, 0],
    "scale": [0, 2, 4, 7, 9, 7, 4, 2],
    "desc":  [7, 5, 4, 2, 0, -3, 0],
    "happy": [0, 4, 7, 12, 7, 4, 0],
    "sad":   [0, -2, -4, -5, -4, -2, 0],
}


def load_wav(path: str):
    import numpy as np
    p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f64le", "-"],
                       capture_output=True)
    return np.frombuffer(p.stdout, dtype=np.float64)


def save_wav(x, path: str):
    import numpy as np
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    wav = (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt " +
           (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") +
           SR.to_bytes(4, "little") + (SR * 2).to_bytes(4, "little") +
           (2).to_bytes(2, "little") + (16).to_bytes(2, "little") +
           b"data" + len(pcm).to_bytes(4, "little") + pcm)
    open(path, "wb").write(wav)


def build_target_f0(f0, notes, base_f0, note_sec, glides=0.045):
    """把基频曲线换成旋律：按音符时长铺满有声区间，音符之间做短滑音。"""
    import numpy as np
    voiced = f0 > 0
    if voiced.sum() < 10:
        return f0
    idx = np.where(voiced)[0]
    start, end = int(idx[0]), int(idx[-1])
    total = max(1, end - start)
    n = len(notes)
    # 每个音符占的采样数按比例分配（有声区间的实际长度 / 音符数）
    hop = total / n
    new = np.zeros_like(f0)
    for i, semi in enumerate(notes):
        f = base_f0 * (2 ** (semi / 12.0))
        a = int(start + i * hop)
        b = int(start + (i + 1) * hop)
        new[a:b] = f
    # 滑音（避免音与音之间硬跳）
    g = max(1, int(glides * SR))
    for i in range(1, n):
        pos = int(start + i * hop)
        lo = max(start, pos - g // 2)
        hi = min(end, pos + g // 2)
        if hi > lo:
            f_prev = base_f0 * (2 ** (notes[i - 1] / 12.0))
            f_cur = base_f0 * (2 ** (notes[i] / 12.0))
            new[lo:hi] = np.linspace(f_prev, f_cur, hi - lo)
    # 只在原本有声的地方替换，清音/静音保持 0
    new[~voiced] = 0.0
    return new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tune", default="star")
    ap.add_argument("--note-sec", type=float, default=0.0, help="0 = 按音符数自动铺满")
    ap.add_argument("--vibrato", type=float, default=0.35, help="颤音深度（半音）")
    a = ap.parse_args()

    import numpy as np
    import pyworld as pw

    tune = TUNES.get(a.tune, TUNES["star"])
    chars = [c for c in a.text if c.strip() and c.isalnum()][:24]
    if not chars:
        raise SystemExit("没有可唱的字")
    text = "".join(chars)

    work = tempfile.mkdtemp(prefix="singw-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    raw = os.path.join(work, "line.wav")
    aliyun_tts.synthesize(text, raw, instruction="请用平稳、连贯、稍微拖长的语调念这句话")

    x = load_wav(raw)
    if len(x) < SR * 0.3:
        raise SystemExit("合成音频太短")

    f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=600.0, frame_period=5.0)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap_ = pw.d4c(x, f0, t, SR)

    base = float(np.median(f0[f0 > 0])) if (f0 > 0).any() else 238.8
    notes = [tune[i % len(tune)] for i in range(len(chars))]
    print(f"[singw] {len(chars)} 字 / {len(notes)} 音，基准 {base:.1f}Hz", flush=True)

    tgt = build_target_f0(f0, notes, base, a.note_sec)

    # 颤音：在旋律基频上叠 5.3Hz 的轻微起伏
    tt = np.arange(len(tgt)) * 0.005
    vib = 2 ** ((a.vibrato * np.sin(2 * math.pi * 5.3 * tt)) / 12.0)
    tgt_v = tgt * vib
    tgt_v[tgt == 0] = 0

    y = pw.synthesize(tgt_v, sp, ap_, SR, frame_period=5.0)
    voc = os.path.join(work, "voc.wav")
    save_wav(y, voc)

    # 铺底和弦
    total = len(y) / SR
    prog = [0, 7, 9, 5]
    bar = max(1.2, total / max(1, math.ceil(total / 2.4)))
    inputs, filters = [], []
    for bi in range(int(math.ceil(total / bar))):
        freq = (base / 2.0) * (2 ** (prog[bi % len(prog)] / 12.0))
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={freq:.2f}:duration={bar}"]
        filters.append(f"[{bi}:a]volume=0.5[v{bi}]")
    pad = os.path.join(work, "pad.wav")
    mix = "".join(f"[v{i}]" for i in range(len(inputs) // 4))
    chain = ";".join(filters) + f";{mix}amix=inputs={len(inputs)//4}:duration=longest,volume=0.14," \
                     f"afade=t=in:st=0:d=0.5,afade=t=out:st={max(0,total-0.8):.2f}:d=0.8[pad]"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *inputs, "-filter_complex", chain,
                    "-map", "[pad]", "-ac", "1", "-ar", str(SR), pad], capture_output=True)

    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", voc, "-i", pad,
                        "-filter_complex",
                        "[0:a]aecho=0.75:0.5:55|110:0.22|0.12,volume=1.0[V];[1:a]volume=1.0[D];"
                        "[V][D]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]",
                        "-map", "[out]", "-ac", "1", "-ar", str(SR), "-b:a", "128k", a.out],
                       capture_output=True)
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败：" + (r.stderr or b"").decode("utf-8", "replace")[:300])
    print(f"OK {a.out} {os.path.getsize(a.out)} bytes {total:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
