# -*- coding: utf-8 -*-
"""用阿里云百炼「复刻音色」合成语音（比本地 Seed-VC 快 10 倍）。

模型：qwen-audio-3.0-tts-flash（1 元/万字符，免费额度 1 万字符）
音色：state/aliyun-voice.json 里的 voiceId（复刻自 audio/voices/v2.wav）

用法：
  python aliyun_tts.py --text "喵，晚上好呀" --out out.mp3 [--tone happy]
  python aliyun_tts.py --text "..." --out out.mp3 --instruction "用非常兴奋的语气说"
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(ROOT, "state", "aliyun-key.txt")
VOICE_FILE = os.path.join(ROOT, "state", "aliyun-voice.json")
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
BASE = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"

# 预设语气（用户只要说“开心点/难过点”就能用）
# 语气强度：取"原始短指令"和"加强版"之间 —— 有情绪但不夸张
TONES = {
    "happy": "请用比较开朗、开心的语气说，语调稍微上扬一点",
    "excited": "请用兴奋、激动的语气说，音调比平时高一些",
    "sad": "请用有点低落、难过的语气说，句尾往下沉一点",
    "gentle": "请用温柔、轻声细语的语气说",
    "coquettish": "请用撒娇、可爱的语气说，尾音稍微上扬",
    "serious": "请用认真、严肃的语气说，语气沉一点",
    "surprised": "请用有点惊讶的语气说，音调稍微抬高",
}

# 语境 -> 语气 规则表
TONE_RULES = [
    ("excited",   ["太棒", "好耶", "真的假的", "卧槽", "天哪", "天啊", "居然", "不敢相信", "冲啊", "绝了", "牛啊", "厉害啊"]),
    ("surprised", ["什么", "啊？", "咦", "诶", "不会吧", "竟然"]),
    ("happy",     ["哈哈", "开心", "高兴", "笑死", "好呀", "不错", "喜欢", "太好了", "棒", "赞", "嘿嘿"]),
    ("sad",       ["难过", "伤心", "哭", "呜呜", "唉", "委屈", "好累", "烦", "不想", "算了"]),
    ("gentle",    ["晚安", "早点睡", "乖", "别怕", "慢慢来", "抱抱", "想你", "注意休息"]),
    ("coquettish",["哼", "才不", "讨厌", "不要嘛", "人家", "嘛~"]),
    ("serious",   ["注意", "警告", "必须", "重要", "立刻", "马上", "严肃"]),
]


def infer_tone(text: str) -> str:
    """按语境猜语气；没有强线索就返回空（保持 TTS 自然韵律，这也是用户最喜欢的效果）。"""
    t = str(text or "")
    score = {}
    for tone, kws in TONE_RULES:
        for kw in kws:
            if kw in t:
                score[tone] = score.get(tone, 0) + (2 if len(kw) > 1 else 1)
    # 强标点加权
    if "！！" in t or "!" in t:
        score["excited"] = score.get("excited", 0) + 1
    if "？" in t or "?" in t:
        score["surprised"] = score.get("surprised", 0) + 1
    if not score:
        return ""
    best = max(score.items(), key=lambda kv: kv[1])
    # 只有线索够强才上语气，否则保持自然（避免把好好的一段话弄得很做作）
    return best[0] if best[1] >= 2 else ""


def api_key() -> str:
    k = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not k and os.path.isfile(KEY_FILE):
        k = open(KEY_FILE, "r", encoding="utf-8-sig").read().strip()
    if not k:
        raise SystemExit("缺少 DASHSCOPE_API_KEY（state/aliyun-key.txt 或环境变量）")
    return k


def voice_conf() -> dict:
    if not os.path.isfile(VOICE_FILE):
        raise SystemExit("缺少 state/aliyun-voice.json")
    return json.load(open(VOICE_FILE, "r", encoding="utf-8-sig"))


def synthesize(text: str, out: str, tone: str = "", instruction: str = "", auto_tone: bool = True) -> str:
    conf = voice_conf()
    if not tone and not instruction and auto_tone:
        guessed = infer_tone(text)
        if guessed:
            tone = guessed
            print(f"[tone] 按语境选了 {tone}：{text[:20]}", flush=True)
    instr = instruction or TONES.get(tone, "")
    payload = {
        "model": conf["model"],
        "input": {
            "text": text,
            "voice": conf["voiceId"],
            "format": "wav",
            "sample_rate": 24000,
        },
    }
    if instr:
        payload["input"]["instruction"] = instr
    req = urllib.request.Request(
        BASE, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": "Bearer " + api_key(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        raise SystemExit(f"百炼合成失败 HTTP {e.code}：{body}")

    url = ((data.get("output") or {}).get("audio") or {}).get("url")
    if not url:
        raise SystemExit("百炼没有返回音频：" + json.dumps(data, ensure_ascii=False)[:300])

    tmp = out + ".src.wav"
    urllib.request.urlretrieve(url, tmp)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", tmp,
                    "-ac", "1", "-ar", "24000", "-b:a", "128k", out], capture_output=True)
    try:
        os.remove(tmp)
    except Exception:
        pass
    if not os.path.isfile(out) or os.path.getsize(out) < 3000:
        raise SystemExit("导出失败")
    chars = (data.get("usage") or {}).get("characters")
    print(f"OK {out} {os.path.getsize(out)} bytes chars={chars} tone={tone or '-'}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tone", default="")
    ap.add_argument("--instruction", default="")
    ap.add_argument("--no-auto-tone", action="store_true")
    a = ap.parse_args()
    synthesize(a.text, a.out, a.tone, a.instruction, auto_tone=not a.no_auto_tone)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
