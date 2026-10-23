# -*- coding: utf-8 -*-
"""翻唱：把一首歌的人声换成「本机 TTS 音色」，走免费 GPU 空间（Seed-VC 官方 Space）。

为什么这么绕：
  本机没有 NVIDIA 显卡（AMD 核显 0.5G），CPU 跑 Seed-VC 一首歌要 40~100 分钟，不可用。
  而 Hugging Face 上的 Seed-VC 官方 Space 提供免费 GPU 推理，13 秒就能转 10 秒音频。

用法：
  python cover.py --source song.mp3 --out out.mp3 [--seconds 30] [--steps 20]
  python cover.py --source https://v.douyin.com/xxx --out out.mp3   # 需要 yt-dlp

输出：转换后的人声音频（wav→mp3 192k）。伴奏混音由调用方决定（可选）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "ffprobe")
SPACE = "https://plachta-seed-vc.hf.space"
ROOT = os.path.dirname(os.path.abspath(__file__))
REF_WAV = os.path.join(ROOT, "audio", "ref-voice.wav")
DEMUCS_PY = os.path.join(ROOT, ".venv-demucs", "Scripts", "python.exe")
# 本地 Seed-VC（CPU）：不依赖 HF 额度，10 秒音频约 100 秒
SEEDVC_DIR = os.environ.get("SEEDVC_DIR", "")
SEEDVC_PY = DEMUCS_PY
SEEDVC_CKPT = os.path.join(SEEDVC_DIR, "checkpoints", "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth")
SEEDVC_CFG = os.path.join(SEEDVC_DIR, "checkpoints", "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml")
TOKEN_FILE = os.path.join(ROOT, "state", "hf-token.txt")


def voice_presets() -> list[str]:
    d = os.path.join(ROOT, "audio", "voices")
    if not os.path.isdir(d):
        return []
    return sorted(os.path.splitext(f)[0] for f in os.listdir(d) if f.lower().endswith(".wav"))


def hf_token():
    """HF token：环境变量优先，其次本地文件（桥接进程可能是设置变量之前启动的）。"""
    t = os.environ.get("HF_TOKEN", "").strip()
    if not t and os.path.isfile(TOKEN_FILE):
        try:
            t = open(TOKEN_FILE, "r", encoding="utf-8").read().strip()
        except Exception:
            t = ""
    return t or None


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', **kw)


def ensure_reference() -> str:
    """生成/复用目标音色参考（10 秒 TTS，和机器人说话同一个音色）。"""
    if os.path.isfile(REF_WAV) and os.path.getsize(REF_WAV) > 20000:
        return REF_WAV
    os.makedirs(os.path.dirname(REF_WAV), exist_ok=True)
    text = "喵，我是住在群里的猫娘，今天也要开开心心的呀，一起唱歌好不好喵"
    r = run([sys.executable, "-m", "edge_tts", "-t", text, "-v", "zh-CN-XiaoyiNeural",
             "--write-media", REF_WAV])
    if not os.path.isfile(REF_WAV) or os.path.getsize(REF_WAV) < 5000:
        raise SystemExit("生成参考音失败：" + (r.stderr or "")[-300:])
    return REF_WAV


DUOYIN_PARSE_API = "https://api.xingzhige.com/API/douyin/?url="
DOUYIN_PARSE_API = DUOYIN_PARSE_API
KUAISHOU_PARSE_API = "https://api.xingzhige.com/API/kuaishou/?url="

# 公共解析接口：(关键词, 接口地址)
PARSER_APIS = [
    (("douyin.com", "iesdouyin.com"), DOUYIN_PARSE_API),
    (("kuaishou.com", "chenzhongtech.com"), KUAISHOU_PARSE_API),
]


def _download(url: str, dst: str, headers: dict | None = None) -> str:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(dst, "wb") as f:
        f.write(r.read())
    return dst


def audio_seconds(path: str) -> float:
    """用 ffprobe 读音频时长（秒）；读不出来返回 0。用来校验「下到的不是网页/试听片段」。"""
    if not os.path.isfile(path):
        return 0.0
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path])
    try:
        return float((r.stdout or "").strip() or 0)
    except ValueError:
        return 0.0


# ── QQ 音乐：搜索 → vkey → 下载（按歌名找歌源，不走 B站）──────────────────
QQ_UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"
QQ_SEARCH_API = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w={kw}&format=json&n={n}&p=1"
QQ_VKEY_API = "https://u.y.qq.com/cgi-bin/musicu.fcg"


def _qq_get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": QQ_UA_MOBILE, "Referer": "https://y.qq.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _qq_search(keyword: str, limit: int = 8):
    """搜 QQ 音乐，返回候选歌曲（免费的排前面）。"""
    from urllib.parse import quote
    raw = _qq_get(QQ_SEARCH_API.format(kw=quote(keyword), n=limit))
    data = json.loads(raw)
    songs = (((data.get("data") or {}).get("song") or {}).get("list") or [])
    out = []
    for s in songs:
        singers = "/".join(str(x.get("name") or "") for x in (s.get("singer") or []))
        pay = ((s.get("pay") or {}).get("payplay"))
        out.append({
            "mid": str(s.get("songmid") or ""),
            "name": str(s.get("songname") or ""),
            "singer": singers,
            "free": pay in (0, None),
        })
    # 排序：免费的优先 → 歌名干净（不带 Live/DJ/伴奏/现场）优先 → 搜索热度顺序
    bad = ("live", "dj", "伴奏", "翻自", "现场", "cover", "remix", "片段", "铃声")
    def rank(item):
        n = item["name"].lower()
        dirty = any(b in n for b in bad) or ("(" in n) or ("（" in n)
        return (not item["free"], dirty)
    out = [x for x in out if x["mid"]]
    out.sort(key=rank)
    return out


def _qq_vkey(songmid: str):
    """取播放地址：返回 (完整 URL 或 None, result)。"""
    payload = {
        "req_0": {
            "module": "vkey.GetVkeyServer",
            "method": "CgiGetVkey",
            "param": {"guid": "10000", "songmid": [songmid], "songtype": [0],
                      "uin": "0", "loginflag": 1, "platform": "20"},
        },
        "comm": {"uin": 0, "format": "json", "ct": 24, "cv": 0},
    }
    req = urllib.request.Request(
        QQ_VKEY_API, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": QQ_UA_MOBILE,
                 "Referer": "https://y.qq.com/"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    d = (data.get("req_0") or {}).get("data") or {}
    infos = d.get("midurlinfo") or [{}]
    info = infos[0] or {}
    purl = str(info.get("purl") or "")
    if not purl:
        return None, info.get("result")
    sip = (d.get("sip") or ["https://ws.stream.qqmusic.qq.com/"])[0]
    if not sip.endswith("/"):
        sip += "/"
    return sip + purl, 0


def _fetch_qqmusic_by_name(keyword: str, workdir: str) -> str:
    """按歌名从 QQ 音乐拿歌源；付费曲子拿不到就报错（不偷偷换平台）。"""
    cands = _qq_search(keyword)
    if not cands:
        raise SystemExit(f"QQ音乐搜不到「{keyword}」")
    tried = []
    for c in cands[:6]:
        url, code = _qq_vkey(c["mid"])
        if not url:
            tried.append(f"{c['name']}-{c['singer']}(result={code})")
            continue
        title = re.sub(r"[^\w\u4e00-\u9fa5]+", "_", f"{c['name']}_{c['singer']}")[:40]
        dst = os.path.join(workdir, f"src-qq-{title}.m4a")
        print(f"[fetch] QQ音乐：{c['name']} - {c['singer']}", flush=True)
        _download(url, dst)
        if os.path.getsize(dst) > 100 * 1024:
            return dst
        tried.append(f"{c['name']}(文件过小)")
    # QQ 音乐全都要 VIP → 去抖音搜
    print(f"[fetch] QQ音乐没有免费版本（{len(tried)} 首都不行），改去抖音搜", flush=True)
    return _fetch_douyin_by_name(keyword, workdir)


def _try_parser(src: str, api: str, workdir: str, tag: str) -> str:
    """通用去水印/解析接口：从 data.item 里取原声或视频直链。"""
    from urllib.parse import quote
    req = urllib.request.Request(api + quote(src, safe=""), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    if data.get("code") not in (0, 200, None):
        raise SystemExit(f"{tag} 解析接口返回错误：{str(data)[:160]}")
    item = ((data.get("data") or {}).get("item") or {})
    media = item.get("muisic") or item.get("music") or item.get("url") or ""
    if not media:
        # 有些接口把地址放在 data.url
        media = (data.get("data") or {}).get("url") or ""
    if not media:
        raise SystemExit(f"{tag} 解析没拿到音频地址：{str(data)[:160]}")
    title = re.sub(r"[^\w\u4e00-\u9fa5]+", "_", str(item.get("title") or tag))[:40]
    dst = os.path.join(workdir, f"src-{title or tag}.mp3")
    print(f"[fetch] {tag} 解析成功：{title or tag}（{item.get('duration', '?')}s）", flush=True)
    return _download(media, dst)


def _fetch_netease(src: str, workdir: str) -> str:
    """网易云单曲页：优先 Meting 公共接口（能拿到真 mp3），外链只当兜底。

    注意：music.163.com/song/media/outer/url 对无版权/VIP 歌曲会返回一坨 HTML
    （看起来下载成功、实际 0 秒），所以必须校验文件头。
    """
    m = re.search(r"[?&]id=(\d+)", src) or re.search(r"/song/(\d+)", src)
    if not m:
        raise SystemExit("网易云链接里找不到歌曲 id")
    song_id = m.group(1)
    dst = os.path.join(workdir, f"src-netease-{song_id}.mp3")

    def _dur(p):
        try:
            r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=noprint_wrappers=1:nokey=1", p])
            return float((r.stdout or "0").strip() or 0)
        except Exception:
            return 0.0

    meting = f"https://api.injahow.cn/meting/?type=url&id={song_id}&server=netease"
    try:
        print(f"[fetch] 网易云 id={song_id}（Meting）", flush=True)
        _download(meting, dst)
        d = _dur(dst)
        print(f"[fetch] Meting 得到 {d:.0f} 秒", flush=True)
        if d >= 20:
            if d < 60:
                print("[fetch] 注意：这是 30 秒试听片段，可能只截到前奏", flush=True)
            return dst
        print("[fetch] Meting 时长太短，换外链", flush=True)
    except Exception as e:
        print(f"[fetch] Meting 失败：{e}", flush=True)

    url = f"https://music.163.com/song/media/outer/url?id={song_id}.mp3"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"})
    with urllib.request.urlopen(req, timeout=120) as r:
        head = r.read(2048)
        # HTML = 版权页，不是音频
        if head[:15].lower().startswith(b"<!doctype") or head[:5].lower() == b"<html":
            raise SystemExit("网易云这首没有公开外链（可能需要会员），换 B站/抖音的版本")
        rest = r.read()
    with open(dst, "wb") as f:
        f.write(head + rest)
    return dst


def _http_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _http_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _bili_search_download(keyword: str, workdir: str) -> str:
    """在 B站搜这个名字，拿播放量最高的翻唱/原曲，用 yt-dlp 下音频。

    QQ音乐/汽水音乐这类「音频有版权、匿名拿不到直链」的平台，
    统一用「按歌名去 B站找同一首」来兜底——B站基本都有。
    """
    from urllib.parse import quote
    import http.cookiejar
    # B 站有反爬，先访问主页拿 buvid cookie，再搜（否则 412）
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    opener.addheaders = [("User-Agent", ua), ("Accept-Language", "zh-CN,zh;q=0.9")]
    try:
        with opener.open("https://www.bilibili.com/", timeout=20) as r0:
            r0.read(2000)
    except Exception as e:
        print(f"[fetch] B站预热失败（继续尝试）：{e}", flush=True)
    api = ("https://api.bilibili.com/x/web-interface/search/type?search_type=video"
           f"&keyword={quote(keyword)}&page=1&order=click")
    req0 = urllib.request.Request(api, headers={"Referer": "https://www.bilibili.com/", "User-Agent": ua})
    with opener.open(req0, timeout=25) as r1:
        data = json.loads(r1.read().decode("utf-8", "replace"))
    items = ((data.get("data") or {}).get("result") or [])
    if not items:
        raise SystemExit(f"B站也搜不到「{keyword}」")
    bv = items[0].get("bvid")
    if not bv:
        raise SystemExit("B站结果里没有 BV 号")
    title = re.sub(r"<[^>]+>", "", str(items[0].get("title") or ""))
    print(f"[fetch] 改从 B站取：{bv} {title[:30]}", flush=True)
    url = f"https://www.bilibili.com/video/{bv}"
    out_tpl = os.path.join(workdir, "src.%(ext)s")
    run([DEMUCS_PY, "-m", "yt_dlp", "-f", "bestaudio", "-x", "--audio-format", "mp3",
         "-o", out_tpl, url], timeout=900)
    for f in os.listdir(workdir):
        if f.startswith("src.") and not f.endswith(".part"):
            return os.path.join(workdir, f)
    raise SystemExit("B站下载失败")


def _extract_audio(video_path: str, dst: str) -> str:
    """从视频里抽音轨。"""
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", video_path,
             "-vn", "-ac", "1", "-ar", "44100", dst])
    if not os.path.isfile(dst) or os.path.getsize(dst) < 100 * 1024:
        raise SystemExit("抽音轨失败：" + (r.stderr or "")[-200:])
    return dst


def _bing_douyin_links(keyword: str, max_n: int = 10):
    """找抖音视频页链接。

    Bing 视频搜索页对抖音收录很全（一条查询能出几十个），
    普通网页搜索反而很少，所以视频搜索优先，网页搜索兜底。
    """
    from urllib.parse import quote
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

    def fetch(url: str) -> str:
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            print(f"[fetch] 搜索失败：{e}", flush=True)
            return ""

    def harvest(html: str, found: list):
        for m in re.finditer(r"douyin\.com/(?:video|note)/(\d{10,})", html):
            link = f"https://www.douyin.com/video/{m.group(1)}"
            if link not in found:
                found.append(link)

    found = []
    # 1) 视频搜索（命中率最高）
    for q in (keyword, f"{keyword} 完整版", f"{keyword} 歌"):
        if len(found) >= max_n:
            break
        html = fetch(f"https://cn.bing.com/videos/search?q={quote(q)}&count=30")
        if html:
            harvest(html, found)
        if len(found) >= max_n:
            break
    # 2) 网页搜索兜底
    if len(found) < max_n:
        for q in (f"site:douyin.com {keyword}", f"{keyword} 抖音"):
            if len(found) >= max_n:
                break
            html = fetch(f"https://cn.bing.com/search?q={quote(q)}&count=30")
            if html:
                harvest(html, found)
    return found[:max_n]


def _fetch_douyin_by_name(keyword: str, workdir: str) -> str:
    """按歌名去抖音搜：Bing 找抖音视频页 → 解析接口拿视频 → 抽音轨。

    QQ 音乐全是要 VIP 的时候用这条兜底。
    """
    # 先只搜歌名（歌手名常不在抖音标题里），没有再带歌手
    names = [keyword]
    parts = keyword.split()
    if len(parts) > 1:
        names.append(parts[0])

    targets = []
    for n in names:
        targets = _bing_douyin_links(n)
        if targets:
            print(f"[fetch] 抖音搜索命中 {len(targets)} 条（关键词：{n}）", flush=True)
            break
    if not targets:
        raise SystemExit(f"抖音搜不到「{keyword}」")

    for t in targets:
        try:
            data = _parser_json(t)
            item = ((data.get("data") or {}).get("item") or {})
            title = str(item.get("title") or "")
            dur = float(item.get("duration") or 0)
            media = item.get("muisic") or item.get("url") or ""
            if not media or dur < 15:
                continue
            print(f"[fetch] 抖音找到：{title[:40]}（{dur:.0f}s）", flush=True)
            raw = os.path.join(workdir, "dy-src.bin")
            _download(media, raw)
            if media.endswith((".mp3", ".m4a", ".aac")):
                return raw
            out = os.path.join(workdir, "src-douyin.m4a")
            return _extract_audio(raw, out)
        except Exception as e:
            print(f"[fetch] 抖音这条不行：{e}", flush=True)
            continue
    raise SystemExit(f"抖音找到的视频都没法用：「{keyword}」")


def _parser_json(src: str, api: str = DUOYIN_PARSE_API) -> dict:
    from urllib.parse import quote
    req = urllib.request.Request(api + quote(src, safe=""),
                                 headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _fetch_qqmusic(src: str, workdir: str) -> str:
    """QQ音乐链接：直接用它的 songmid 取 vkey；拿不到（VIP）再去抖音搜。"""
    m = (re.search(r"/songDetail/([0-9A-Za-z]+)", src)
         or re.search(r"[?&]songmid=([0-9A-Za-z]+)", src)
         or re.search(r"[?&]mid=([0-9A-Za-z]+)", src))
    if not m:
        raise SystemExit("QQ音乐链接里找不到 songmid")
    mid = m.group(1)
    # 先按这个 songmid 直接要播放地址（不搜索）
    try:
        url, code = _qq_vkey(mid)
    except Exception as e:
        url, code = None, str(e)
    if url:
        print(f"[fetch] QQ音乐直链（songmid={mid}）", flush=True)
        dst = os.path.join(workdir, f"src-qq-{mid}.m4a")
        _download(url, dst)
        if os.path.getsize(dst) > 100 * 1024:
            return dst
    # VIP/拿不到 → 取歌名歌手，转抖音
    name, singers = "", ""
    try:
        api = f"https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid={mid}&format=json"
        data = _http_json(api)
        d0 = (data.get("data") or [{}])[0]
        name = str(d0.get("name") or "").strip()
        singers = " ".join(str(s.get("name") or "") for s in (d0.get("singer") or []))
    except Exception:
        pass
    if not name:
        raise SystemExit(f"QQ音乐这首要 VIP（result={code}），也取不到歌名")
    print(f"[fetch] QQ音乐要 VIP（{name} - {singers}），改去抖音搜", flush=True)
    return _fetch_douyin_by_name(f"{name} {singers}".strip(), workdir)



QISHUI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
QISHUI_REFERER = "https://music.douyin.com/"


def _qishui_page_audio(html: str):
    """从汽水分享页里取出这首歌**自带**的音源，返回 (url, title, artist)。

    分享页就是「这一首歌」的播放页，页面脚本里 `_ROUTER_DATA` 带着
    `loaderData.track_page.audioWithLyricsOption.url`（mime_type=audio_mp4，aac 编码），
    这就是对方分享的那一首。拿它才叫「唱链接里的歌」——只按标题去别处搜，
    很容易搜到同名翻唱、DJ 版或拼接混音（实测《Take me hand》会搜到「+我的歌声里」的 MIX）。
    """
    m = re.search(r"_ROUTER_DATA\s*=\s*", html)
    if not m:
        return "", "", ""
    try:
        data, _ = json.JSONDecoder().raw_decode(html[m.end():])
    except Exception:
        return "", "", ""
    page = (((data.get("loaderData") or {}).get("track_page")) or {})
    awl = page.get("audioWithLyricsOption") or {}
    url = str(awl.get("url") or "").strip()
    if url and awl.get("hasCopyright") is False:
        url = ""  # 没版权时给的地址放不出声音，别浪费时间
    title = _qishui_regex(html, r'<h1[^>]*class="title"[^>]*>([^<]+)</h1>')
    artist = _qishui_regex(html, r'artist-name-max"[^>]*>([^<]+)<')
    return url, title, artist


def _qishui_regex(html: str, pattern: str) -> str:
    m = re.search(pattern, html, re.I)
    return m.group(1).strip() if m else ""


def _qishui_title_from_html(html: str) -> str:
    """静态页兜底：从 og:title / <title> 里认出歌名。"""
    title = ""
    for pat in (
        r'<meta[^>]+og:title[^>]*content="([^"]+)"',
        r'<meta[^>]+content="([^"]+)"[^>]*og:title',
        r'<meta[^>]+twitter:title[^>]*content="([^"]+)"',
        r"<title>([^<]+)</title>",
    ):
        m = re.search(pat, html, re.I)
        if m and m.group(1).strip():
            title = m.group(1).strip()
            break
    # 清掉书名号和平台后缀：《Take me hand》@汽水音乐 -> Take me hand
    title = re.sub(r"[《》]", "", title)
    title = re.split(r"[@（(\-|_]", title)[0].strip()
    title = re.sub(r"(汽水音乐|QQ音乐|网易云音乐|酷狗音乐|酷我音乐)", "", title).strip()
    return title


def _fetch_qishui(src: str, workdir: str) -> str:
    """汽水音乐：优先用分享页自带的音源（就是这首）；拿不到才按歌名去 QQ 音乐搜。"""
    try:
        html = _http_text(src)
    except Exception as e:
        raise SystemExit(f"汽水音乐分享页打不开：{e}")

    media, title, artist = _qishui_page_audio(html)

    # 1) 页面自带音源：直接用 —— 这才是对方分享的那一首
    if media:
        dst = os.path.join(workdir, "src-qishui.m4a")
        label = title or "?"
        if artist:
            label = f"{label} - {artist}"
        try:
            print(f"[fetch] 汽水音乐页面音源：{label}", flush=True)
            _download(media, dst, headers={"User-Agent": QISHUI_UA, "Referer": QISHUI_REFERER})
            size = os.path.getsize(dst)
            seconds = audio_seconds(dst)
            if size > 100 * 1024 and seconds >= 20:
                print(f"[fetch] 汽水音乐直接拿到原曲：{seconds:.0f} 秒", flush=True)
                return dst
            print(f"[fetch] 汽水音源无效（{size} 字节 / {seconds:.0f} 秒），改用歌名搜", flush=True)
        except Exception as e:
            print(f"[fetch] 汽水音源下载失败：{e}（改用歌名搜）", flush=True)

    # 2) 偶尔是纯静态页，正则兜底找直链
    urls = re.findall(r"https?://[^\"'\\\s]+?\.(?:mp3|m4a|aac)(?:\?[^\"'\\\s]*)?", html)
    urls = [u for u in urls if "douyinpic" not in u and "icon" not in u]
    if urls:
        dst = os.path.join(workdir, "src-qishui.m4a")
        try:
            print("[fetch] 汽水音乐直链命中", flush=True)
            _download(urls[0].replace("\\u002F", "/"), dst)
            if os.path.getsize(dst) > 100 * 1024:
                return dst
        except Exception as e:
            print(f"[fetch] 汽水直链下载失败：{e}", flush=True)

    # 3) 还是没拿到 → 按歌名走 QQ 音乐（搜索结果全要 VIP 时会继续转抖音）
    title = title or _qishui_title_from_html(html)
    if not title:
        raise SystemExit("汽水音乐里没认出歌名，直接发音频文件给我更快")
    print(f"[fetch] 汽水音乐按歌名搜：{title}", flush=True)
    return _fetch_qqmusic_by_name(title, workdir)


def fetch_source(src: str, workdir: str) -> str:
    """多平台解析：本地 > 网易云 > QQ音乐/汽水(B站兜底) > yt-dlp > 抖音/快手解析。"""
    if os.path.isfile(src):
        return os.path.abspath(src)
    if not src.lower().startswith(("http://", "https://")):
        # 不是链接也不是文件 → 当成歌名，去 QQ 音乐找歌源
        query = src.strip()
        if not query:
            raise SystemExit("source 为空")
        print(f"[fetch] 按歌名搜歌：{query}", flush=True)
        return _fetch_qqmusic_by_name(query, workdir)

    tried = []

    # 1) 网易云
    if "music.163.com" in src:
        try:
            return _fetch_netease(src, workdir)
        except Exception as e:
            tried.append(f"网易云: {e}")

    # 2) QQ 音乐（直链要 vkey，走 B 站兜底）
    if "y.qq.com" in src or "qq.com" in src and "songmid" in src:
        try:
            return _fetch_qqmusic(src, workdir)
        except Exception as e:
            tried.append(f"QQ音乐: {e}")

    # 3) 汽水音乐（分享页自带音源，直接就是那一首）
    if "qishui" in src or "music.douyin.com" in src:
        try:
            return _fetch_qishui(src, workdir)
        except Exception as e:
            tried.append(f"汽水音乐: {e}")

    # 4) yt-dlp：B站 / YouTube / 微博 / Twitter 等
    out_tpl = os.path.join(workdir, "src.%(ext)s")
    r = run([DEMUCS_PY, "-m", "yt_dlp", "-f", "bestaudio", "-x", "--audio-format", "mp3",
             "-o", out_tpl, src], timeout=600)
    for f in os.listdir(workdir):
        if f.startswith("src.") and not f.endswith(".part"):
            return os.path.join(workdir, f)
    tried.append("yt-dlp: " + ((r.stderr or "").strip().splitlines() or ["失败"])[-1][:120])

    # 5) 公共解析接口：抖音 / 快手
    #    注意：qishui.douyin.com / music.douyin.com 是汽水分享页，不是抖音视频，
    #    走视频解析只会拿到 -404「资源id获取失败」，所以在上面单独处理、这里跳过。
    for hosts, api in PARSER_APIS:
        if any(h in src for h in hosts):
            if "qishui" in src or "music.douyin.com" in src:
                continue
            try:
                return _try_parser(src, api, workdir, hosts[0].split(".")[0])
            except Exception as e:
                tried.append(f"{hosts[0]}: {e}")

    raise SystemExit("这个链接解析不了：" + src + "\n尝试记录：\n  - " + "\n  - ".join(tried))




def cut(src: str, dst: str, seconds: int) -> str:
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-t", str(seconds),
             "-ac", "1", "-ar", "44100", dst])
    if not os.path.isfile(dst) or os.path.getsize(dst) < 5000:
        raise SystemExit("裁剪失败：" + (r.stderr or "")[-300:])
    return dst


def separate(src: str, workdir: str) -> tuple[str, str] | tuple[None, None]:
    """demucs 分离人声/伴奏（CPU）。失败返回 (None, None)，调用方退化为整曲转换。"""
    if not os.path.isfile(DEMUCS_PY):
        print("[sep] 没找到 demucs venv，跳过分离", flush=True)
        return None, None
    outroot = os.path.join(workdir, "separated")
    stem = os.path.splitext(os.path.basename(src))[0]
    outdir = os.path.join(outroot, "htdemucs", stem)
    vocals = os.path.join(outdir, "vocals.wav")
    instrumental = os.path.join(outdir, "no_vocals.wav")
    if os.path.isfile(vocals) and os.path.isfile(instrumental):
        return vocals, instrumental
    print("[sep] demucs 分离人声/伴奏（CPU，可能要几分钟）…", flush=True)
    r = run([DEMUCS_PY, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
             "-o", outroot, os.path.abspath(src)], cwd=workdir, timeout=3600)
    if os.path.isfile(vocals) and os.path.isfile(instrumental):
        return vocals, instrumental
    print("[sep] 分离失败，退化为整曲转换：" + (r.stderr or "")[-300:], flush=True)
    return None, None


def _auto_start(src: str, seconds: int) -> float:
    """按 5 秒窗口的 RMS 找最"满"的一段，用来跳过前奏/静音。"""
    try:
        import numpy as np
        # 注意：这里拿的是二进制 PCM，不能走 run() 的 text 模式
        p = subprocess.run([FFMPEG, "-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                           capture_output=True)
        x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        sr = 16000
        if len(x) < seconds * sr:
            return 0.0
        step = 5 * sr
        wins = []
        for st in range(0, len(x) - seconds * sr + 1, step):
            seg = x[st:st + seconds * sr]
            wins.append((st / sr, float(np.sqrt((seg ** 2).mean()))))
        if not wins:
            return 0.0
        peak = max(r for _, r in wins)
        # 不取最响的那段（通常是末段副歌），取"够响的最早一段"，更像一首歌的开头
        for t, r in wins:
            if r >= peak * 0.85:
                return float(t)
        return float(wins[0][0])
    except Exception:
        return 0.0


def _proxy_alive(proxy: str) -> bool:
    import socket
    from urllib.parse import urlparse
    try:
        u = urlparse(proxy if "://" in proxy else "http://" + proxy)
        host, port = u.hostname or "127.0.0.1", u.port or 7897
        s = socket.create_connection((host, port), timeout=2)
        s.close()
        return True
    except Exception:
        return False


def convert_local(src_wav: str, ref_wav: str, workdir: str, steps: int) -> str:
    """本地 Seed-VC（CPU）。慢但不要额度，10 秒音频约 100 秒。"""
    outdir = os.path.join(workdir, "vc")
    os.makedirs(outdir, exist_ok=True)
    env = dict(os.environ)
    env["HF_ENDPOINT"] = "https://hf-mirror.com"
    env["OMP_NUM_THREADS"] = "8"
    env["MKL_NUM_THREADS"] = "8"
    print("[vc] 本地 Seed-VC（CPU，几分钟）…", flush=True)
    r = run([SEEDVC_PY, "inference.py", "--source", os.path.abspath(src_wav),
             "--target", os.path.abspath(ref_wav), "--output", outdir,
             "--diffusion-steps", str(max(6, steps)), "--inference-cfg-rate", "0.7",
             "--f0-condition", "True", "--auto-f0-adjust", "True", "--fp16", "False",
             "--checkpoint", SEEDVC_CKPT, "--config", SEEDVC_CFG],
            cwd=SEEDVC_DIR, env=env, timeout=7200)
    files = [os.path.join(outdir, f) for f in os.listdir(outdir) if f.lower().endswith((".wav", ".flac"))]
    if not files:
        raise SystemExit("本地 Seed-VC 没产出：" + ((r.stderr or "")[-400:]))
    files.sort(key=os.path.getmtime, reverse=True)
    return files[0]


def convert(src_wav: str, ref_wav: str, workdir: str, steps: int, cfg_rate: float) -> str:
    from gradio_client import Client, handle_file
    import httpx

    last_err = None
    for attempt in range(1, 7):
        try:
            kwargs = {
                "timeout": httpx.Timeout(900.0, connect=60.0, read=900.0, write=900.0, pool=60.0),
            }
            proxy = os.environ.get("COVER_PROXY", "").strip()
            if proxy and _proxy_alive(proxy):
                kwargs["proxy"] = proxy
            elif proxy:
                print("[svc] 代理不可用，改用直连", flush=True)
            client = Client(
                SPACE, verbose=False, download_files=True,
                token=hf_token(),
                httpx_kwargs=kwargs,
            )
            out = _predict_once(client, handle_file, src_wav, ref_wav, steps, cfg_rate)
            return out
        except SystemExit:
            raise
        except Exception as e:  # 免费 Space 会排队/超时，重试；配额超限直接放弃
            if "ZeroGPU" in str(e) or "exceeded" in str(e) or "quota" in str(e).lower():
                raise SystemExit(
                    "HuggingFace ZeroGPU 免费额度已用完。解决办法：设置环境变量 HF_TOKEN（免费账号的 token 即可，"
                    "https://huggingface.co/settings/tokens 新建一个 read 权限的），或等额度重置。原始错误：" + str(e)[:160]
                )
            last_err = e
            print(f"[svc] 第 {attempt} 次失败：{type(e).__name__}: {str(e)[:160]}", flush=True)
            time.sleep(min(10, 2 * attempt))
    raise SystemExit(f"Seed-VC 连续失败：{type(last_err).__name__}: {str(last_err)[:300]}")


def _predict_once(client, handle_file, src_wav, ref_wav, steps, cfg_rate) -> str:
    out = client.predict(
        source_audio_path=handle_file(src_wav),
        target_audio_path=handle_file(ref_wav),
        diffusion_steps=steps,
        length_adjust=1.0,
        intelligebility_cfg_rate=cfg_rate,
        similarity_cfg_rate=cfg_rate,
        top_p=0.9,
        temperature=0.9,
        repetition_penalty=1.1,
        convert_style=False,
        anonymization_only=False,
        api_name="/predict",
    )
    path = None
    if isinstance(out, (tuple, list)):
        for item in out:
            s = str(item)
            if s.lower().endswith((".wav", ".flac", ".mp3")):
                path = s
    else:
        path = str(out)
    if not path or not os.path.isfile(path):
        raise SystemExit("Space 没返回音频：" + str(out)[:300])
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="歌曲文件路径或 URL")
    ap.add_argument("--out", required=True, help="输出 mp3")
    ap.add_argument("--seconds", type=int, default=30, help="只处理前 N 秒（默认 30）")
    ap.add_argument("--start", type=float, default=0.0, help="从第几秒开始截（跳过前奏）")
    ap.add_argument("--steps", type=int, default=20, help="扩散步数（越小越快）")
    ap.add_argument("--cfg-rate", type=float, default=0.7)
    ap.add_argument("--instrumental", default="", help="可选：伴奏文件，用于混音")
    ap.add_argument("--reference", default="", help="音色参考音频（10~20 秒干净人声）")
    ap.add_argument("--voice", default="", help="音色预设名（audio/voices/<名字>.wav）")
    ap.add_argument("--no-separate", action="store_true", help="跳过 demucs，直接转整曲")
    ap.add_argument("--engine", default="local", choices=["auto", "local", "hf"], help="换嗓引擎")
    # 伴奏音量：0.85 → +50%(1.275) → +20%(1.53) → +15%(1.76) → +23%(2.16)
    ap.add_argument("--inst-vol", type=float, default=2.16, help="伴奏音量倍数")
    a = ap.parse_args()

    # 每次跑用独立的临时目录：之前是固定 _cover_work，导致第二个歌命中了第一首的分离缓存
    import tempfile
    workdir = tempfile.mkdtemp(prefix="cover-", dir=os.path.dirname(os.path.abspath(a.out)) or ".")
    os.makedirs(workdir, exist_ok=True)

    t0 = time.time()
    # 音色参考优先级：--reference > --voice 预设 > audio/voices/v2.wav > 现生成的 TTS 参考
    ref = ""
    if a.reference and os.path.isfile(a.reference):
        ref = a.reference
    elif a.voice:
        cand = os.path.join(ROOT, "audio", "voices", a.voice + ".wav")
        if os.path.isfile(cand):
            ref = cand
        else:
            raise SystemExit(f"没有音色预设 {a.voice}（可用：{', '.join(voice_presets()) or '无'}）")
    else:
        cand = os.path.join(ROOT, "audio", "voices", "v2.wav")
        ref = cand if os.path.isfile(cand) else ensure_reference()
    src = fetch_source(a.source, workdir)

    # 没指定起点时自动跳过前奏：按 5 秒窗口找能量最高的一段
    if a.start <= 0:
        auto = _auto_start(src, a.seconds)
        if auto > 0:
            print(f"[auto] 自动跳过前奏，起点 {auto:.0f}s", flush=True)
            a.start = auto

    # 关键顺序：先把要唱的那一小段截出来，再对这段做分离。
    # 对整首 3 分钟的歌跑 demucs 要 5~6 分钟，截 30 秒只要 40 秒左右。
    song_clip = os.path.join(workdir, "song_clip.wav")
    if a.start > 0:
        r0 = run([FFMPEG, "-y", "-loglevel", "error", "-ss", str(a.start), "-t", str(a.seconds),
                  "-i", src, "-ac", "1", "-ar", "44100", song_clip])
        if not os.path.isfile(song_clip):
            raise SystemExit("按起点裁剪失败：" + (r0.stderr or "")[-300:])
    else:
        cut(src, song_clip, a.seconds)

    instrumental = a.instrumental
    vocals = None
    if not a.no_separate:
        vocals, sep_inst = separate(song_clip, workdir)
        if vocals and not instrumental:
            instrumental = sep_inst
    source_for_convert = vocals or song_clip
    clip = cut(source_for_convert, os.path.join(workdir, "clip.wav"), a.seconds)
    if a.engine == "hf":
        conv = convert(clip, ref, workdir, a.steps, a.cfg_rate)
    else:
        conv = convert_local(clip, ref, workdir, a.steps)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    if instrumental and os.path.isfile(instrumental):
        # 伴奏也要对齐到同一段（取前 seconds 秒）
        inst_clip = cut(instrumental, os.path.join(workdir, "inst_clip.wav"), a.seconds + 1)
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", conv, "-i", inst_clip,
               "-filter_complex", f"[0:a]volume=1.0[v];[1:a]volume={a.inst_vol}[m];[v][m]amix=inputs=2:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11",
               "-ac", "1", "-ar", "24000", "-b:a", "128k", a.out]
    else:
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", conv,
               "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ac", "1", "-ar", "24000",
               "-b:a", "128k", a.out]
    r = run(cmd)
    if not os.path.isfile(a.out) or os.path.getsize(a.out) < 5000:
        raise SystemExit("导出失败：" + (r.stderr or "")[-300:])

    # 临时目录用完即删（人声/伴奏/中间文件都不留）
    try:
        import shutil
        shutil.rmtree(workdir, ignore_errors=True)
    except Exception:
        pass

    print(f"OK {a.out} {os.path.getsize(a.out)} bytes {time.time()-t0:.1f}s "
          f"separated={'yes' if vocals else 'no'} ref={os.path.basename(ref)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
