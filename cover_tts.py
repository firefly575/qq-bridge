# -*- coding: utf-8 -*-
"""翻唱（qwen 复刻音色 + 原曲真实旋律）：真正的"唱"，不是念。

思路：
  1. 歌词来自 LRC（带时间轴），知道每一句在几秒、唱多久
  2. 用 qwen-audio-3.0-tts-flash（复刻音色）把每句歌词念出来
  3. 用 World 把它的基频替换成「原唱那一句的真实音高曲线」——旋律来自原曲，所以是唱
  4. 频谱包络保留 qwen 的（音色是你的复刻嗓），再与伴奏混音

用法：
  python cover_tts.py --song 踏山河.wav --lrc "path.lrc" --out out.mp3 --start 3.5 --seconds 10
"""
from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aliyun_tts  # noqa: E402

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
ROOT = os.path.dirname(os.path.abspath(__file__))
DEMUCS_PY = os.path.join(ROOT, ".venv-demucs", "Scripts", "python.exe")
SR = 24000


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def parse_lrc(path: str):
    """返回 [(start_sec, text), ...]，按时间排序。"""
    out = []
    for line in open(path, "r", encoding="utf-8", errors="replace").read().splitlines():
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)", line)
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        txt = m.group(3).strip()
        if txt and not re.search(r"(作词|作曲|编曲|制作|混音|出品|监制|发行|策划)", txt):
            out.append((t, txt))
    out.sort()
    return out


def cut(src, dst, seconds, start=0.0):
    args = [FFMPEG, "-y", "-loglevel", "error"]
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    args += ["-t", f"{seconds:.3f}", "-i", src, "-ac", "1", "-ar", str(SR), dst]
    run(args)
    return dst


def separate(clip, workdir):
    outroot = os.path.join(workdir, "sep")
    stem = os.path.splitext(os.path.basename(clip))[0]
    outdir = os.path.join(outroot, "htdemucs", stem)
    v = os.path.join(outdir, "vocals.wav")
    inst = os.path.join(outdir, "no_vocals.wav")
    if os.path.isfile(v) and os.path.isfile(inst):
        return v, inst
    print("[sep] demucs 分离…", flush=True)
    run([DEMUCS_PY, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
         "-o", outroot, os.path.abspath(clip)], cwd=workdir, timeout=3600)
    return (v if os.path.isfile(v) else clip), (inst if os.path.isfile(inst) else "")


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--lrc", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--vibrato", type=float, default=0.15)
    a = ap.parse_args()

    import numpy as np
    import pyworld as pw

    lines = parse_lrc(a.lrc)
    if not lines:
        raise SystemExit("LRC 没解析出歌词")
    end = a.start + a.seconds
    picked = []
    for i, (t, txt) in enumerate(lines):
        nxt = lines[i + 1][0] if i + 1 < len(lines) else t + 6.0
        if nxt <= a.start or t >= end:
            continue
        picked.append((max(t, a.start), min(nxt, end), txt))
    if not picked:
        raise SystemExit(f"{a.start}~{end}s 区间没有歌词")
    print(f"[ctts] {len(picked)} 句：" + " / ".join(p[2] for p in picked), flush=True)

    work = tempfile.mkdtemp(prefix="ctts-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    clip = cut(a.song, os.path.join(work, "song.wav"), a.seconds, a.start)
    vocals, inst = separate(clip, work)
    vx = load(vocals)
    vf0, vt = pw.harvest(vx, SR, f0_floor=60.0, f0_ceil=700.0, frame_period=5.0)
    print(f"[ctts] 原唱有声帧 {int((vf0>0).sum())}", flush=True)

    pieces = []
    for i, (s, e, txt) in enumerate(picked):
        dur = max(0.6, e - s)
        raw = os.path.join(work, f"l{i}.wav")
        aliyun_tts.synthesize(txt, raw)
        x = load(raw)
        if len(x) < SR * 0.2:
            continue

        # qwen 音频的 World 分解（要它的音色）
        t_f0, t_t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=700.0, frame_period=5.0)
        sp = pw.cheaptrick(x, t_f0, t_t, SR)
        ap_ = pw.d4c(x, t_f0, t_t, SR)

        # 取原唱这一句的真实音高曲线，重采样到 qwen 音频的帧数
        a_idx = int((s - a.start) * 1000 / 5.0)
        b_idx = int((e - a.start) * 1000 / 5.0)
        seg = vf0[max(0, a_idx):min(len(vf0), b_idx)]
        if len(seg) < 5:
            seg = vf0[vf0 > 0]
        if len(seg) < 5:
            continue
        pos = np.linspace(0, len(seg) - 1, len(t_f0))
        melody = np.interp(pos, np.arange(len(seg)), seg)
        # 原唱没声（气口）的地方保留 qwen 的原始基频
        melody[melody <= 0] = t_f0[melody <= 0]

        if a.vibrato > 0:
            tt = np.arange(len(melody)) * 0.005
            melody = melody * (2 ** ((a.vibrato * np.sin(2 * math.pi * 5.2 * tt)) / 12.0))

        y = pw.synthesize(melody, sp, ap_, SR, frame_period=5.0)
        seg_wav = os.path.join(work, f"s{i}.wav")
        save(y, seg_wav)

        # 拉伸/裁剪到这一句的实际时长
        cur = len(y) / SR
        fixed = os.path.join(work, f"f{i}.wav")
        tempo = max(0.6, min(1.6, cur / dur))
        run([FFMPEG, "-y", "-loglevel", "error", "-i", seg_wav,
             "-af", f"atempo={tempo:.4f},apad=pad_dur={dur},atrim=0:{dur},"
                    f"afade=t=in:st=0:d=0.03,afade=t=out:st={max(0.05,dur-0.06):.3f}:d=0.06",
             "-ac", "1", "-ar", str(SR), fixed])
        pieces.append(fixed)
        print(f"  [{i+1}/{len(picked)}] {txt[:14]}  时长 {dur:.2f}s", flush=True)

    if not pieces:
        raise SystemExit("没有合成成功的句子")
    lst = os.path.join(work, "list.txt")
    open(lst, "w", encoding="utf-8").write("\n".join(f"file '{p.replace(os.sep,'/')}'" for p in pieces))
    voc = os.path.join(work, "voc.wav")
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-ac", "1", "-ar", str(SR), voc])

    if inst and os.path.isfile(inst):
        r = run([FFMPEG, "-y", "-loglevel", "error", "-i", voc, "-i", inst,
                 "-filter_complex",
                 "[0:a]volume=1.0[V];[1:a]volume=0.8[D];"
                 "[V][D]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]",
                 "-map", "[out]", "-ac", "1", "-ar", str(SR), "-b:a", "128k", a.out])
    else:
        r = run([FFMPEG, "-y", "-loglevel", "error", "-i", voc,
                 "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                 "-ac", "1", "-ar", str(SR), "-b:a", "128k", a.out])
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败：" + (r.stderr or "")[:300])
    print(f"OK {a.out} {os.path.getsize(a.out)} bytes", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
