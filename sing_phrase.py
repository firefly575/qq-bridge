# -*- coding: utf-8 -*-
"""用复刻音色唱（v2：整句合成 + 音节切分 + rubberband 保共振峰移调）。

和 v1（逐字合成）的区别：
  v1 每个字单独调 API → 字与字之间没有连读，听起来一顿一顿的。
  v2 整句只调一次 API（保留自然的连读和语调），再按能量低谷切成音节，
     每个音节用 rubberband 移到目标音高（保共振峰，不会变尖/变鸭子）。

用法：
  python sing_phrase.py --text "小星星亮晶晶" --out out.mp3 [--tune star] [--note-sec 0.55]
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

TUNES = {
    "star":  [0, 0, 7, 7, 9, 9, 7],
    "scale": [0, 2, 4, 7, 9, 7, 4, 2],
    "desc":  [7, 5, 4, 2, 0, -3, 0],
    "twinkle_full": [0, 0, 7, 7, 9, 9, 7, 5, 5, 4, 4, 2, 2, 0],
}


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def decode(path: str):
    import numpy as np
    p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
                       capture_output=True)
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def split_points(x, n, sr=24000):
    """按能量找 n-1 个切分点（音节边界近似）。"""
    import numpy as np
    hop = int(0.01 * sr)
    frames = len(x) // hop
    env = np.sqrt((x[:frames * hop].reshape(frames, hop) ** 2).mean(axis=1))
    # 平滑
    k = np.ones(5) / 5
    env = np.convolve(env, k, mode="same")
    total = len(x)
    pts = []
    min_gap = int(0.09 * sr)
    for i in range(1, n):
        # 在理论位置 ±35% 区间内找能量最低点，避免切得太歪
        center = int(total * i / n)
        span = int(total * 0.35 / n)
        lo = max(min_gap, center - span)
        hi = min(total - min_gap, center + span)
        if hi <= lo:
            pts.append(center)
            continue
        seg = env[lo // hop: hi // hop]
        if len(seg) == 0:
            pts.append(center)
            continue
        idx = lo + int(np.argmin(seg)) * hop
        pts.append(idx)
    pts = sorted(set(pts))
    return [0] + pts + [total]


def rubber_shift(src: str, dst: str, ratio: float, tempo: float = 1.0):
    """rubberband 同时做移调与变速：pitch 是比例，formant=preserved 保住音色。"""
    af = f"rubberband=pitch={ratio:.5f}:tempo={tempo:.5f}:formant=preserved:pitchq=quality"
    run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-af", af,
         "-ac", "1", "-ar", "24000", dst])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tune", default="star")
    ap.add_argument("--note-sec", type=float, default=0.55)
    ap.add_argument("--base-f0", type=float, default=0.0)
    a = ap.parse_args()

    tune = TUNES.get(a.tune, TUNES["star"])
    # 只留中文/字母数字，用空格分隔保证 TTS 连读自然
    chars = [c for c in a.text if c.strip() and c.isalnum()][:16]
    if not chars:
        raise SystemExit("没有可唱的字")
    text = "".join(chars)

    work = tempfile.mkdtemp(prefix="singp-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    raw = os.path.join(work, "line.wav")
    # 整句一次合成：让它"拖着念"，作为旋律的载体
    aliyun_tts.synthesize(text, raw, instruction="请用平稳、连贯、稍微拖长的语调念这句话，像唱歌一样保持音高稳定")
    x = decode(raw)
    if len(x) < 2400:
        raise SystemExit("合成音频太短")

    base = a.base_f0 or 0.0
    if base <= 0:
        conf = aliyun_tts.voice_conf()
        ref = os.path.join(ROOT, conf.get("reference", "audio/voices/v2.wav"))
        base = 238.8
        try:
            import numpy as np
            y = decode(ref)
            win, hop, sr = 1024, 512, 24000
            vals = []
            for i in range(0, len(y) - win, hop):
                seg = y[i:i + win]
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
            if vals:
                base = float(np.median(vals))
        except Exception:
            pass

    n = len(chars)
    pts = split_points(x, n)
    print(f"[sing] {n} 字, 基准 {base:.1f}Hz, 切分点 {len(pts)-1} 个", flush=True)

    pieces = []
    note = a.note_sec
    for i in range(n):
        seg = x[pts[i]:pts[i + 1]]
        if len(seg) < 1200:
            seg = x[pts[i]:min(len(x), pts[i] + 2400)]
        src = os.path.join(work, f"n{i}.wav")
        with open(src, "wb") as f:
            import struct
            f.write(b"RIFF" + struct.pack("<I", 36 + len(seg) * 2) + b"WAVEfmt " +
                    struct.pack("<IHHIIHH", 16, 1, 1, 24000, 48000, 2, 16) +
                    b"data" + struct.pack("<I", len(seg) * 2) +
                    (seg * 32767).astype("<i2").tobytes())

        semi = tune[i % len(tune)]
        target = base * (2 ** (semi / 12.0))
        # 该音节自身的中位音高（用于算移调比例）
        f0 = base
        try:
            import numpy as np
            win, hop2, sr2 = 1024, 512, 24000
            vals = []
            for j in range(0, len(seg) - win, hop2):
                s = seg[j:j + win]
                if (s ** 2).mean() ** 0.5 < 0.012:
                    continue
                s = s - s.mean()
                ac = np.correlate(s, s, mode="full")[win - 1:]
                ac /= (ac[0] + 1e-9)
                lo, hi = int(sr2 / 1000), int(sr2 / 70)
                if hi >= len(ac):
                    continue
                k2 = lo + int(np.argmax(ac[lo:hi]))
                if ac[k2] > 0.3:
                    vals.append(sr2 / k2)
            if vals:
                f0 = float(np.median(vals))
        except Exception:
            pass
        ratio = max(0.55, min(1.8, target / max(60.0, f0)))

        shifted = os.path.join(work, f"s{i}.wav")
        dur = max(0.15, len(seg) / 24000.0)
        tempo = max(0.6, min(1.8, dur / note))
        rubber_shift(src, shifted, ratio, tempo)

        fixed = os.path.join(work, f"f{i}.wav")
        run([FFMPEG, "-y", "-loglevel", "error", "-i", shifted,
             "-af", (f"apad=pad_dur={note},atrim=0:{note},"
                     f"afade=t=in:st=0:d=0.04,afade=t=out:st={note-0.08:.3f}:d=0.08,"
                     f"vibrato=f=5.2:d=0.25"),
             "-ac", "1", "-ar", "24000", fixed])
        pieces.append(fixed)

    lst = os.path.join(work, "list.txt")
    open(lst, "w", encoding="utf-8").write("\n".join(f"file '{p.replace(os.sep,'/')}'" for p in pieces))
    vocal = os.path.join(work, "vocal.wav")
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-ac", "1", "-ar", "24000", vocal])

    total = n * note
    # 简单和弦铺底：每 4 个音换一次根音（I - V - vi - IV 的简化）
    prog = [0, 7, 9, 5]
    pad = os.path.join(work, "pad.wav")
    inputs = []
    filters = []
    bar = 4 * note
    for bi in range(int(math.ceil(total / bar))):
        freq = (base / 2.0) * (2 ** (prog[bi % len(prog)] / 12.0))
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={freq:.2f}:duration={bar}"]
        filters.append(f"[{bi}:a]volume=0.5[v{bi}]")
    mix = "".join(f"[v{i}]" for i in range(len(inputs) // 4))
    chain = ";".join(filters) + f";{mix}amix=inputs={len(inputs)//4}:duration=longest,volume=0.16," \
                     f"afade=t=in:st=0:d=0.5,afade=t=out:st={max(0,total-0.8):.2f}:d=0.8[pad]"
    run([FFMPEG, "-y", "-loglevel", "error", *inputs, "-filter_complex", chain, "-map", "[pad]", "-ac", "1", "-ar", "24000", pad])

    run([FFMPEG, "-y", "-loglevel", "error", "-i", vocal, "-i", pad,
         "-filter_complex",
         "[0:a]aecho=0.7:0.45:60|120:0.2|0.1,volume=1.0[V];[1:a]volume=1.0[D];"
         "[V][D]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]",
         "-map", "[out]", "-ac", "1", "-ar", "24000", "-b:a", "128k", a.out])
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败")
    print(f"OK {a.out} {os.path.getsize(a.out)} bytes {total:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
