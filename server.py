"""
Latte — AI Chat & Image Studio
FastAPI backend over the `aimind` public API (pip install aimind).

Run:  python server.py          ->  http://localhost:8000
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from aimind import AIMind, AIMindError, ImageGenerationError, RateLimitError

# --------------------------------------------------------------------------- #
#  Paths & constants
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
GEN = ROOT / "gen"                      # generated images (persisted)
MEDIA = ROOT / "media"                  # user uploads (vision attachments)
for _d in (GEN, MEDIA):
    _d.mkdir(parents=True, exist_ok=True)

MAX_SESSIONS = 24                       # LRU cap on live AIMind instances
GEN_KEEP = 240                          # generated images kept on disk
MAX_UPLOAD_MB = 5                       # aimind limit is 5 MB per image
ALLOWED_UPLOADS = {"png", "jpg", "jpeg", "webp", "gif"}
IMG_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="img")
SSE_PING_S = 12                         # keep-alive cadence

# --------------------------------------------------------------------------- #
#  Model catalogue (chat) — surfaced in the UI model picker
# --------------------------------------------------------------------------- #

CHAT_MODELS: list[dict[str, Any]] = [
    {"id": "fast", "name": "Swift", "tier": "Fast", "blurb": "Instant answers, everyday questions", "dot": "#C98A4B"},
    {"id": "balanced", "name": "Balanced", "tier": "Balanced", "blurb": "Best mix of depth and speed", "dot": "#A9713F"},
    {"id": "powerful", "name": "Deep Reason", "tier": "Powerful", "blurb": "Hard problems, long analysis", "dot": "#6E4423"},
    {"id": "creative", "name": "Muse", "tier": "Creative", "blurb": "Writing, ideas, storytelling", "dot": "#C08552"},
    {"id": "coder", "name": "CodeSmith", "tier": "Coder", "blurb": "Refactors, debugging, architecture", "dot": "#8A5A32"},
    {"id": "qwen/qwen3-coder-30b-a3b-instruct", "name": "Qwen3 Coder 30B", "tier": "Explicit", "blurb": "Large coding specialist", "dot": "#9A6B3F"},
    {"id": "deepseek/deepseek-r1", "name": "DeepSeek R1", "tier": "Explicit", "blurb": "Chain-of-thought reasoning", "dot": "#7A4E2A"},
    {"id": "google/gemma-4-26b-a4b-it", "name": "Gemma 4 26B", "tier": "Explicit", "blurb": "Long context, balanced", "dot": "#B07C49"},
    {"id": "mistralai/ministral-8b-2512", "name": "Ministral 8B", "tier": "Explicit", "blurb": "Very fast, very long context", "dot": "#D2A06A"},
]

VISION_MODELS = {"balanced", "powerful", "creative", "google/gemma-4-26b-a4b-it"}

RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
STYLES = [
    ("auto", "Auto"), ("photorealistic", "Photo"), ("cinematic", "Cinematic"),
    ("digital_art", "Digital"), ("anime", "Anime"), ("3d_render", "3D Render"),
    ("oil_painting", "Oil"), ("watercolor", "Watercolor"), ("sketch", "Sketch"),
    ("pixel_art", "Pixel"), ("fantasy", "Fantasy"),
]
QUALITIES = [("standard", "Standard"), ("hd", "HD"), ("ultra", "Ultra")]

SYSTEM_PRESETS: dict[str, str] = {
    "default": (
        "You are Latte, a thoughtful assistant. Be clear, warm and concise. "
        "Use markdown: short paragraphs, lists for steps, tables for comparisons, "
        "fenced code blocks with a language tag. Never pad with filler sentences."
    ),
    "concise": "You are terse. Answer in as few words as possible. No preamble, no summary of the question.",
    "explain": "You are a patient teacher. Explain from first principles, use analogies, then give a one-line takeaway.",
    "code": "You are a senior engineer. Give production-quality code, minimal prose, note trade-offs and edge cases.",
    "creative": "You are a literary collaborator. Vivid, specific, rhythmic prose. Avoid clichés.",
}

# --------------------------------------------------------------------------- #
#  Sessions — one AIMind instance per browser conversation (holds its memory)
# --------------------------------------------------------------------------- #


class Session:
    __slots__ = ("id", "ai", "title", "created", "touched", "messages", "lock", "system", "image_jobs")

    def __init__(self, sid: str, model: str = "balanced"):
        self.id = sid
        self.ai = AIMind(model=model, memory=True, max_history=60, auto_retry=True,
                         max_retries=2, timeout=180, temperature=0.7, warm=False)
        self.title = "New chat"
        self.created = time.time()
        self.touched = self.created
        self.messages: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.system: str = SYSTEM_PRESETS["default"]
        self.image_jobs: dict[str, dict[str, Any]] = {}

    def touch(self) -> None:
        self.touched = time.time()


class SessionStore:
    """Thread-safe LRU store of AIMind-backed sessions."""

    def __init__(self, cap: int = MAX_SESSIONS):
        self._d: "OrderedDict[str, Session]" = OrderedDict()
        self._lock = threading.Lock()
        self._cap = cap

    def create(self, model: str = "balanced") -> Session:
        sid = secrets.token_urlsafe(12)
        s = Session(sid, model)
        with self._lock:
            self._d[sid] = s
            self._d.move_to_end(sid)
            while len(self._d) > self._cap:
                _, old = self._d.popitem(last=False)
                try:
                    old.ai.close()
                except Exception:
                    pass
        return s

    def get(self, sid: Optional[str]) -> Session:
        with self._lock:
            s = self._d.get(sid or "")
            if s is None:
                raise HTTPException(status_code=404, detail="Session expired — start a new chat.")
            self._d.move_to_end(sid)
        s.touch()
        return s

    def all(self) -> list[Session]:
        with self._lock:
            return list(self._d.values())


STORE = SessionStore()

# --------------------------------------------------------------------------- #
#  App
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Fail loudly and early on anything that would break the UI at runtime."""
    try:
        import multipart  # noqa: F401
    except ImportError:
        print("[latte] python-multipart not installed — using the built-in "
              "multipart fallback for uploads.")
    if not STATIC.joinpath("index.html").exists():
        print(f"[latte] WARNING: {STATIC / 'index.html'} missing — the UI will not load.")
    print(f"[latte] images  -> {GEN}")
    print(f"[latte] uploads -> {MEDIA}")
    yield
    IMG_EXECUTOR.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Latte — AI Chat & Image Studio", version="1.0.0",
              docs_url=None, redoc_url=None, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse(event: str, data: Any) -> str:
    """Format one Server-Sent Event frame."""
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def prune_gen() -> None:
    """Keep the image folder bounded: drop the oldest renders past GEN_KEEP."""
    try:
        files = sorted(GEN.glob("*.png"), key=lambda p: p.stat().st_mtime)
        for old in files[:-GEN_KEEP] if len(files) > GEN_KEEP else []:
            old.unlink(missing_ok=True)
    except OSError:
        pass


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def opt_float(v: Any, lo: float, hi: float) -> Optional[float]:
    """Parse a client-supplied float, bounded; None when absent/invalid."""
    if v is None or v == "":
        return None
    try:
        return clamp(float(v), lo, hi)
    except (TypeError, ValueError):
        return None


def err_message(e: Exception) -> str:
    if isinstance(e, RateLimitError):
        return "The model service is busy right now. Try again in a moment."
    if isinstance(e, ImageGenerationError):
        return f"Image generation failed: {e}"
    if isinstance(e, AIMindError):
        return f"{type(e).__name__}: {e}"
    return f"Unexpected error: {type(e).__name__}: {e}"


# --------------------------------------------------------------------------- #
#  Bootstrap / catalogue
# --------------------------------------------------------------------------- #


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    """Everything the client needs on first paint, plus a fresh session."""
    s = STORE.create("balanced")
    try:
        agents_raw = s.ai.list_agents() or {}
        agents = [
            {"id": k, "name": v.get("name", k), "description": v.get("description", "")}
            for k, v in agents_raw.items()
        ]
    except Exception:
        agents = []
    try:
        img_models = s.ai.list_image_models() or {}
    except Exception:
        img_models = {}
    return {
        "session_id": s.id,
        "chat_models": CHAT_MODELS,
        "image_models": [
            {"id": k, "name": v.get("name", k), "provider": v.get("provider", ""),
             "speed": v.get("speed", ""), "style": v.get("style", "")}
            for k, v in img_models.items()
        ],
        "ratios": RATIOS,
        "styles": [{"id": a, "label": b} for a, b in STYLES],
        "qualities": [{"id": a, "label": b} for a, b in QUALITIES],
        "tone_presets": list(SYSTEM_PRESETS.keys()),
        "agents": sorted(agents, key=lambda a: a["name"]),
        "vision_models": sorted(VISION_MODELS),
        "limits": {"upload_mb": MAX_UPLOAD_MB, "upload_types": sorted(ALLOWED_UPLOADS)},
    }


@app.get("/api/sessions")
def list_sessions() -> dict[str, Any]:
    items = sorted(STORE.all(), key=lambda s: s.touched, reverse=True)
    return {"conversations": [
        {"id": s.id, "title": s.title, "updated": s.touched, "turns": len(s.messages)}
        for s in items
    ]}


@app.get("/api/health")
def health() -> dict[str, Any]:
    s = STORE.all()
    probe = s[0] if s else STORE.create()
    try:
        rep = probe.ai.ping()
        return {"status": rep.get("status", "unknown"), "latency_ms": rep.get("latency_ms"),
                "sessions": len(s)}
    except Exception as e:
        return {"status": "degraded", "error": str(e), "sessions": len(s)}


# --------------------------------------------------------------------------- #
#  Chat — SSE stream
# --------------------------------------------------------------------------- #


@app.post("/api/chat")
def chat(payload: dict = Body(default={})) -> StreamingResponse:
    sid = payload.get("session_id")
    text = (payload.get("message") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is empty.")
    if len(text) > 24000:
        raise HTTPException(status_code=400, detail="Message too long (24k char cap).")

    s = STORE.get(sid)
    model = payload.get("model") or "balanced"
    agent = payload.get("agent") or None
    tone = payload.get("tone") or "default"
    temperature = opt_float(payload.get("temperature"), 0.0, 2.0)
    attachments = payload.get("images") or []          # server-side media ids
    custom_system = payload.get("system_prompt") or None

    # resolve attachment ids -> local paths
    paths: list[str] = []
    for a in attachments[:4]:
        p = (MEDIA / str(a)).resolve()
        if p.parent == MEDIA.resolve() and p.exists():
            paths.append(str(p))

    system = custom_system if custom_system else (
        None if agent else SYSTEM_PRESETS.get(tone, SYSTEM_PRESETS["default"])
    )

    user_msg = {
        "id": uuid.uuid4().hex[:10], "role": "user", "content": text,
        "ts": time.time(), "attachments": list(attachments)[:4], "model": model,
        "agent": agent,
    }

    def gen():
        with s.lock:
            s.messages.append(user_msg)
            if s.title == "New chat":
                s.title = (text[:48] + "…") if len(text) > 48 else text
        yield sse("ack", {"message_id": user_msg["id"], "title": s.title,
                          "model": model, "agent": agent})
        yield sse("meta", {"thinking": True})

        assistant_id = uuid.uuid4().hex[:10]
        buf: list[str] = []
        t0 = time.time()
        try:
            if agent:
                # agents don't stream; emit the answer as one chunk
                out = s.ai.chat_with_agent(agent, text)
                for piece in _word_chunks(out):
                    buf.append(piece)
                    yield sse("token", {"id": assistant_id, "text": piece})
            else:
                kwargs: dict[str, Any] = {"model": model}
                if system:
                    kwargs["system_prompt"] = system
                if temperature is not None:
                    kwargs["temperature"] = temperature
                if paths:
                    kwargs["images"] = paths
                for chunk in s.ai.chat_stream(text, **kwargs):
                    if not chunk:
                        continue
                    buf.append(chunk)
                    yield sse("token", {"id": assistant_id, "text": chunk})

            full = "".join(buf).strip()
            if not full:
                full = "_(empty response)_"
            with s.lock:
                s.messages.append({"id": assistant_id, "role": "assistant", "content": full,
                                   "ts": time.time(), "model": model, "agent": agent,
                                   "latency_ms": int((time.time() - t0) * 1000)})
            try:
                mem = s.ai.memory_status()
            except Exception:
                mem = {}
            yield sse("done", {"id": assistant_id, "content": full,
                               "latency_ms": int((time.time() - t0) * 1000),
                               "memory": mem})
        except Exception as e:                                   # noqa: BLE001
            yield sse("error", {"message": err_message(e),
                                "partial": "".join(buf)})
        finally:
            yield sse("end", {})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


def _word_chunks(text: str, size: int = 3):
    """Split a finished string into small word-ish chunks for smooth streaming."""
    words = text.split(" ")
    for i in range(0, len(words), size):
        piece = " ".join(words[i:i + size])
        yield piece + (" " if i + size < len(words) else "")


@app.post("/api/stop")
def stop_chat(payload: dict = Body(default={})) -> dict[str, Any]:
    """Client-side stop is authoritative (it closes the SSE reader); this is a hook."""
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Conversation management
# --------------------------------------------------------------------------- #


@app.get("/api/history/{sid}")
def history(sid: str) -> dict[str, Any]:
    s = STORE.get(sid)
    with s.lock:
        msgs = [dict(m) for m in s.messages]
    return {"session_id": s.id, "title": s.title, "messages": msgs}


@app.post("/api/new")
def new_chat(payload: dict = Body(default={})) -> dict[str, Any]:
    base = payload.get("session_id")
    model = payload.get("model") or "balanced"
    if base:
        try:
            s = STORE.get(base)
            s.ai.new_chat()
            with s.lock:
                s.messages.clear()
                s.title = "New chat"
            return {"session_id": s.id, "reset": True}
        except HTTPException:
            pass
    s = STORE.create(model)
    return {"session_id": s.id, "reset": False}


@app.post("/api/regenerate")
def regenerate(payload: dict = Body(default={})) -> dict[str, Any]:
    """Drop the trailing assistant turn so the client can re-ask the same prompt."""
    s = STORE.get(payload.get("session_id"))
    with s.lock:
        if s.messages and s.messages[-1]["role"] == "assistant":
            s.messages.pop()
        last_user = next((m for m in reversed(s.messages) if m["role"] == "user"), None)
    try:
        mem = s.ai.get_memory() or []
        if mem and mem[-1].get("role") == "assistant":
            mem.pop()
    except Exception:
        pass
    return {"ok": True, "last_user": (last_user or {}).get("content", "")}


@app.post("/api/memory/clear")
def clear_memory(payload: dict = Body(default={})) -> dict[str, Any]:
    s = STORE.get(payload.get("session_id"))
    try:
        s.ai.clear_memory()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    with s.lock:
        s.messages.clear()
        s.title = "New chat"
    return {"ok": True}


@app.get("/api/memory/{sid}")
def memory_status(sid: str) -> dict[str, Any]:
    s = STORE.get(sid)
    try:
        return s.ai.memory_status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/session/{sid}")
def delete_session(sid: str) -> dict[str, Any]:
    with STORE._lock:                                   # noqa: SLF001 — internal LRU prune
        s = STORE._d.pop(sid, None)
    if s is None:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        s.ai.close()
    except Exception:
        pass
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Image generation — SSE with incremental results for n > 1
# --------------------------------------------------------------------------- #


@app.post("/api/image")
def generate_image(payload: dict = Body(default={})) -> StreamingResponse:
    s = STORE.get(payload.get("session_id"))
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is empty.")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="Prompt too long (4k char cap).")

    ratio = payload.get("aspect_ratio") or "1:1"
    if ratio not in RATIOS:
        ratio = "1:1"
    style = payload.get("style") or "auto"
    if style not in {a for a, _ in STYLES}:
        style = "auto"
    quality = payload.get("quality") or "standard"
    if quality not in {a for a, _ in QUALITIES}:
        quality = "standard"
    def _int(v: Any, default: int) -> int:
        try:
            return int(str(v).strip())
        except (TypeError, ValueError):
            return default

    n = clamp(_int(payload.get("n"), 1), 1, 4)
    negative = (payload.get("negative_prompt") or "").strip() or None
    raw_seed = str(payload.get("seed") or "").strip()
    seed = _int(raw_seed, 0) if raw_seed.lstrip("-").isdigit() else None
    model = payload.get("model") or None
    caption = (payload.get("caption") or "").strip()

    job_id = uuid.uuid4().hex[:12]

    def gen():
        yield sse("start", {"job": job_id, "n": n, "prompt": prompt, "ratio": ratio,
                            "style": style, "quality": quality})
        q: "queue.Queue[tuple[int, dict[str, Any]]]" = queue.Queue()

        def worker(i: int) -> None:
            try:
                kwargs: dict[str, Any] = dict(aspect_ratio=ratio, style=style, quality=quality)
                if negative:
                    kwargs["negative_prompt"] = negative
                if seed is not None:
                    kwargs["seed"] = seed + i
                if model:
                    kwargs["model"] = model
                img = s.ai.generate_image(prompt, **kwargs)
                fname = f"{job_id}_{i}.png"
                img.save(str(GEN / fname))
                prune_gen()
                q.put((i, {"ok": True, "file": fname, "width": img.width, "height": img.height,
                           "model": getattr(img, "model", None) or "",
                           "requested_size": getattr(img, "requested_size", "")}))
            except Exception as e:                        # noqa: BLE001
                q.put((i, {"ok": False, "error": err_message(e)}))

        futs = [IMG_EXECUTOR.submit(worker, i) for i in range(n)]
        t0 = time.time()
        done = 0
        results: list[dict[str, Any]] = []
        while done < n:
            try:
                i, r = q.get(timeout=SSE_PING_S)
            except queue.Empty:
                yield sse("ping", {"elapsed_s": round(time.time() - t0, 1)})
                continue
            done += 1
            r["index"] = i
            results.append(r)
            yield sse("image", r)

        for f in futs:
            f.result()

        ok = [r for r in results if r.get("ok")]
        with s.lock:
            s.messages.append({
                "id": job_id, "role": "assistant", "kind": "image",
                "content": caption or prompt, "ts": time.time(),
                "images": [r["file"] for r in sorted(ok, key=lambda x: x["index"])],
                "params": {"ratio": ratio, "style": style, "quality": quality,
                           "negative": negative, "seed": seed, "model": model},
                "prompt": prompt,
            })
            if s.title == "New chat":
                s.title = ("Image: " + prompt[:40] + "…") if len(prompt) > 40 else "Image: " + prompt
        yield sse("done", {"job": job_id, "count": len(ok),
                           "elapsed_s": round(time.time() - t0, 1),
                           "failed": [r.get("error") for r in results if not r.get("ok")]})
        yield sse("end", {})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    })


@app.get("/gen/{name}")
def serve_gen(name: str) -> FileResponse:
    p = (GEN / name).resolve()
    if p.parent != GEN.resolve() or not p.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(p, media_type="image/png")


# --------------------------------------------------------------------------- #
#  Uploads (vision attachments)
# --------------------------------------------------------------------------- #


def _parse_multipart_raw(body: bytes, boundary: str) -> list[tuple[str, bytes]]:
    """Minimal multipart parser used when `python-multipart` is unavailable.
    Returns [(filename, bytes)] for file parts."""
    out: list[tuple[str, bytes]] = []
    sep = b"--" + boundary.encode()
    for part in body.split(sep):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head, _, payload = part.partition(b"\r\n\r\n")
        if not payload:
            continue
        heads = head.decode("utf-8", "replace")
        if "filename=" not in heads:
            continue
        m = re.search(r'filename="([^"]*)"', heads)
        out.append((m.group(1) if m else "upload.bin", payload.rstrip(b"\r\n")))
    return out


@app.api_route("/api/upload", methods=["POST"])
async def upload(request: Request):
    """Multipart image upload for vision attachments. Returns a data URI so the
    client can preview instantly without a second round-trip."""
    ctype = request.headers.get("content-type", "")
    if "multipart/form-data" not in ctype:
        raise HTTPException(status_code=415, detail="Expected multipart/form-data")

    files: list[tuple[str, bytes]] = []
    try:
        form = await request.form()
        for key in form:
            f = form[key]
            if hasattr(f, "filename"):
                files.append((f.filename or "upload.bin", await f.read()))
    except Exception:                                          # noqa: BLE001
        # python-multipart missing (or a malformed part) — parse the body directly
        m = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", ctype)
        if not m:
            raise HTTPException(status_code=400, detail="Multipart boundary missing")
        body = await request.body()
        files = _parse_multipart_raw(body, (m.group(1) or m.group(2)).strip())

    out: list[dict[str, Any]] = []
    for filename, data in files[:6]:
        ext = str(filename).rsplit(".", 1)[-1].lower() if "." in str(filename) else ""
        if ext not in ALLOWED_UPLOADS:
            raise HTTPException(
                status_code=400,
                detail=f".{ext or '?'} is not supported — use {', '.join(sorted(ALLOWED_UPLOADS))}")
        if not data:
            raise HTTPException(status_code=400, detail="That file was empty")
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail=f"{len(data) / 1048576:.1f} MB is over the {MAX_UPLOAD_MB} MB limit")
        name = f"{uuid.uuid4().hex[:14]}.{ext}"
        (MEDIA / name).write_bytes(data)
        out.append({
            "id": name,
            "size": len(data),
            "mime": "image/jpeg" if ext == "jpg" else f"image/{ext}",
            "data_uri": ("data:image/jpeg" if ext == "jpg" else f"data:image/{ext}")
                        + ";base64," + base64.b64encode(data).decode(),
        })
    if not out:
        raise HTTPException(status_code=400, detail="No file received")
    return {"files": out}


@app.get("/media/{name}")
def serve_media(name: str) -> FileResponse:
    p = (MEDIA / name).resolve()
    if p.parent != MEDIA.resolve() or not p.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(p)


# --------------------------------------------------------------------------- #
#  Static + SPA fallback
# --------------------------------------------------------------------------- #

app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(STATIC / "index.html"))


@app.exception_handler(HTTPException)
async def http_exc(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def unhandled_exc(request: Request, exc: Exception) -> JSONResponse:
    """Never leak a bare 500 — the UI shows this string to the user."""
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={
        "error": f"{type(exc).__name__}: {exc}",
        "path": str(request.url.path),
    })


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info", timeout_graceful_shutdown=10)
