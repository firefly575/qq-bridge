# -*- coding: utf-8 -*-
"""用百炼复刻音色「唱」出有旋律的句子（纯歌词，无歌源）。

思路：TTS 本身不会作曲，所以旋律由我们自己给——
  1. 把歌词拆成单字，逐字用复刻音色合成（保留音色）
  2. 每个字按旋律音符移调到目标音高，并拉伸到音符时值
  3. 加颤音 + 混响 + 低音铺底，拼成一段"唱"

用法：
  python sing_aliyun.py --text "小猫小猫真可爱" --out sing.mp3
  python sing_aliyun.py --text "..." --out sing.mp3 --tune star|scale|desc
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import tempfile
import urllib.request
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aliyun_tts  # noqa: E402

FFMPEG = aliyun_tts.FFMPEG
ROOT = aliyun_tts.ROOT

# 旋律：相对基音的半音偏移（0 = 基音）
TUNES = {
    # 小星星第一句：1 1 5 5 6 6 5
    "star": [0, 0, 7, 7, 9, 9, 7],
    # 五声音阶上行再下行
    "scale": [0, 2, 4, 7, 9, 7, 4, 2, 0],
    # 下行叹息式
    "desc": [7, 5, 4, 2, 0, -3, 0],
}
NOTE_SEC = 0.42          # 每个音符时长
BASE_F0_FALLBACK = 239.0  # 复刻音色的中位音高（实测 238.8Hz）


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def median_f0(path: str) -> float:
    try:
        import numpy as np
        p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                           capture_output=True)
        x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        win, hop, sr = 1024, 512, 16000
        vals = []
        for i in range(0, len(x) - win, hop):
            s = x[i:i + win]
            if (s ** 2).mean() ** 0.5 < 0.012:
                continue
            s = s - s.mean()
            ac = np.correlate(s, s, mode="full")[win - 1:]
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


def sing_char(ch: str, semitone: float, base_f0: float, workdir: str, idx: int, note_sec: float = 0.42) -> str:
    """合成单字 → 移调到目标音高 → 拉伸到音符时值。"""
    raw = os.path.join(workdir, f"{idx:02d}-raw.wav")
    # 单字合成：加“长音”指令让它别说得太短
    aliyun_tts.synthesize(ch, raw, instruction="请把这个字用平稳、拉长的方式念出来，音调保持")
    f0 = median_f0(raw) or base_f0
    target = base_f0 * (2 ** (semitone / 12.0))
    ratio = max(0.5, min(2.0, target / f0))   # 单次移调限制在 ±12 半音内

    shifted = os.path.join(workdir, f"{idx:02d}-shift.wav")
    # 先按比例改采样率（同时改变时长），再用 atempo 把时长还原
    run([FFMPEG, "-y", "-loglevel", "error", "-i", raw,
         "-af", f"asetrate=24000*{ratio:.5f},aresample=24000,atempo={1/ratio:.5f}",
         "-ac", "1", "-ar", "24000", shifted])

    # 裁到音符时值（长了就截，短了就补静音），两端加短淡入淡出
    out = os.path.join(workdir, f"{idx:02d}-note.wav")
    dur = note_sec
    run([FFMPEG, "-y", "-loglevel", "error", "-i", shifted,
         "-af", (f"apad=pad_dur={dur},atrim=0:{dur},"
                 f"afade=t=in:st=0:d=0.03,afade=t=out:st={dur-0.05:.3f}:d=0.05,"
                 f"vibrato=f=5.4:d=0.30"),
         "-ac", "1", "-ar", "24000", out])
    return out


def build_drone(total: float, base_f0: float, dest: str):
    """低音铺底（根音+五度），让旋律听起来是"在音乐里"而不是干念。"""
    root = base_f0 / 2.0
    fifth = root * 1.5
    run([FFMPEG, "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", f"sine=frequency={root:.2f}:duration={total}",
         "-f", "lavfi", "-i", f"sine=frequency={fifth:.2f}:duration={total}",
         "-filter_complex", "[0:a][1:a]amix=inputs=2,volume=0.18,afade=t=in:st=0:d=0.4,"
                            f"afade=t=out:st={max(0,total-0.6):.3f}:d=0.6",
         "-ac", "1", "-ar", "24000", dest])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tune", default="star")
    ap.add_argument("--note-sec", type=float, default=0.42)
    a = ap.parse_args()
    note_sec = float(a.note_sec)

    tune = TUNES.get(a.tune, TUNES["star"])

    # 只保留汉字/字母数字，标点去掉
    chars = [c for c in a.text if c.strip() and (c.isalnum())]
    chars = chars[:16]
    if not chars:
        raise SystemExit("没有可唱的字")

    conf = aliyun_tts.voice_conf()
    ref = os.path.join(ROOT, conf.get("reference", "audio/voices/v2.wav"))
    base_f0 = median_f0(ref) or BASE_F0_FALLBACK
    print(f"[sing] 基准音高 {base_f0:.1f}Hz，{len(chars)} 个字，旋律 {tune}", flush=True)

    work = tempfile.mkdtemp(prefix="sing-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    notes = []
    for i, ch in enumerate(chars):
        semi = tune[i % len(tune)]
        try:
            notes.append(sing_char(ch, semi, base_f0, work, i, note_sec))
            print(f"  {i+1}/{len(chars)} {ch} {semi:+d}半音 ok", flush=True)
        except Exception as e:
            print(f"  {i+1}/{len(chars)} {ch} 失败：{e}", flush=True)

    if not notes:
        raise SystemExit("一个字都没合成成功")

    lst = os.path.join(work, "list.txt")
    open(lst, "w", encoding="utf-8").write("\n".join(f"file '{n.replace(os.sep,'/')}'" for n in notes))
    vocal = os.path.join(work, "vocal.wav")
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-ac", "1", "-ar", "24000", vocal])

    total = len(notes) * note_sec
    drone = os.path.join(work, "drone.wav")
    build_drone(total, base_f0, drone)

    run([FFMPEG, "-y", "-loglevel", "error", "-i", vocal, "-i", drone,
         "-filter_complex",
         "[0:a]aecho=0.7:0.5:70|130:0.22|0.12,volume=1.0[V];[1:a]volume=1.0[D];"
         "[V][D]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11",
         "-ac", "1", "-ar", "24000", "-b:a", "128k", a.out])
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败")
    print(f"OK {a.out} {os.path.getsize(a.out)} bytes {total:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
