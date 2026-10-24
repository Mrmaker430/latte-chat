/* ==========================================================================
   LATTE — app.js
   Chat + image studio front-end. Talks to the FastAPI/aimind backend over
   Server-Sent Events (fetch + ReadableStream, so POST bodies work).
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Tiny helpers                                                       */
  /* ------------------------------------------------------------------ */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const icon = (id, cls) =>
    '<svg aria-hidden="true"' + (cls ? ' class="' + cls + '"' : "") + "><use href=\"#i-" + id + '"/></svg>';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? "⌘" : "Ctrl";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ */
  /*  State                                                              */
  /* ------------------------------------------------------------------ */
  const S = {
    sid: null,
    boot: null,
    model: "balanced",
    agent: null,
    mode: "chat",
    busy: false,
    stream: false,                 // an SSE stream is in flight
    abort: null,
    messages: [],
    conversations: [],
    attachments: [],               // [{id, data_uri}]
    img: { ratio: "1:1", style: "auto", quality: "standard", n: 1 },
    lastGallery: [],               // for lightbox navigation
    prefs: {
      theme: "auto", motion: true, blur: 22, scale: 1,
      temp: 0.7, tone: "default", system: ""
    }
  };

  const PREF_KEY = "latte.prefs.v1";

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) Object.assign(S.prefs, JSON.parse(raw));
    } catch (_) { /* first run */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(S.prefs)); } catch (_) { /* private mode */ }
  }

  /* ------------------------------------------------------------------ */
  /*  Toasts                                                             */
  /* ------------------------------------------------------------------ */
  const ICON_FOR = { ok: "check", err: "alert", warn: "alert", info: "info" };
  function toast(msg, kind, ms) {
    kind = kind || "info";
    const t = el("div", "toast");
    t.dataset.kind = kind;
    t.innerHTML = icon(ICON_FOR[kind] || "info");
    t.appendChild(el("span", "toast__msg", msg));
    $("#toasts").appendChild(t);
    const life = ms || (kind === "err" ? 5200 : 2600);
    setTimeout(() => {
      t.dataset.out = "1";
      setTimeout(() => t.remove(), 260);
    }, life);
    return t;
  }

  /* ------------------------------------------------------------------ */
  /*  API + SSE                                                          */
  /* ------------------------------------------------------------------ */
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" }
    }, opts || {}));
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).error || detail; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

  /** POST an SSE stream; handlers keyed by event name. */
  async function sse(path, body, handlers, signal) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok || !res.body) {
      let d = res.statusText;
      try { d = (await res.json()).error || d; } catch (_) { /* ignore */ }
      throw new Error(d);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let ev = "message";
        const dataLines = [];
        frame.split("\n").forEach((l) => {
          if (l.startsWith("event:")) ev = l.slice(6).trim();
          else if (l.startsWith("data:")) dataLines.push(l.slice(5).replace(/^ /, ""));
        });
        if (!dataLines.length) continue;
        let payload;
        try { payload = JSON.parse(dataLines.join("\n")); } catch (_) { continue; }
        const fn = handlers[ev];
        if (fn) fn(payload);
      }
    }
    if (handlers.__close) handlers.__close();
  }

  /* ------------------------------------------------------------------ */
  /*  Theme / prefs application                                          */
  /* ------------------------------------------------------------------ */
  function applyTheme() {
    const sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const eff = S.prefs.theme === "auto" ? sys : S.prefs.theme;
    document.documentElement.dataset.theme = S.prefs.theme;
    document.body.dataset.scheme = eff;
    const meta = $('meta[name="theme-color"][media*="' + eff + '"]');
    $("#themeBtn").innerHTML = icon(eff === "dark" ? "sun" : "moon");
    $("#themeBtn").setAttribute("aria-label", eff === "dark" ? "Switch to light theme" : "Switch to dark theme");
    $$("#themeSeg .seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === S.prefs.theme)));
    if (meta) document.documentElement.style.setProperty("--theme-col", meta.content);
  }
  function applyMotion() {
    document.documentElement.style.setProperty("--t-ambient", S.prefs.motion ? "26s" : "0s");
    document.body.dataset.motion = S.prefs.motion ? "on" : "off";
    $$(".ambient__blob, .ambient__sheen, .grain, .brand__mark").forEach((n) => {
      n.style.animationPlayState = S.prefs.motion ? "running" : "paused";
    });
    $("#motionSwitch").setAttribute("aria-checked", String(!!S.prefs.motion));
  }
  function applyBlur() {
    document.documentElement.style.setProperty("--glass-blur", S.prefs.blur + "px");
    $("#blurRange").value = S.prefs.blur;
    $("#blurRange").style.setProperty("--pct", (S.prefs.blur / 40) * 100 + "%");
    $("#blurOut").textContent = S.prefs.blur + "px";
  }
  function applyScale() {
    document.documentElement.style.fontSize = (16 * S.prefs.scale) + "px";
    $$("#densitySeg .seg__btn").forEach((b) => b.setAttribute("aria-pressed", String(parseFloat(b.dataset.scale) === S.prefs.scale)));
  }
  function applyModel() {
    const m = (S.boot && S.boot.chat_models.find((x) => x.id === S.model)) || { name: S.model, dot: "" };
    $("#modelName").textContent = m.name || S.model;
    $("#modelDot").style.background = m.dot || "var(--accent)";
    $$("#modelPop .pop-item").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === S.model)));
  }
  function applyAgent() {
    const a = S.agent && S.boot ? S.boot.agents.find((x) => x.id === S.agent) : null;
    $("#agentLabel").textContent = a ? a.name.replace(/\s+(Coach|Mentor|Tutor|Guide|Assistant|Specialist|Advisor|Planner|Reviewer|Analyst|Helper|Teacher|Manager|Consultant|Prep)$/i, "") : "Agent";
    $("#agentBtn").setAttribute("aria-pressed", String(!!S.agent));
    $("#agentBtn").style.cssText = S.agent ? "background:var(--accent-wash);color:var(--accent-deep);border-color:var(--accent-ring)" : "";
    $$("#agentPop .pop-item").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === (S.agent || ""))));
    syncInputState();
  }
  function applyTemp() {
    $("#tempRange").value = S.prefs.temp;
    $("#tempRange").style.setProperty("--pct", (S.prefs.temp / 1.4) * 100 + "%");
    $("#tempOut").textContent = Number(S.prefs.temp).toFixed(1);
  }
  function applyAll() { applyTheme(); applyMotion(); applyBlur(); applyScale(); applyTemp(); }

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (S.prefs.theme === "auto") applyTheme();
  });

  /* ------------------------------------------------------------------ */
  /*  Composer plumbing                                                  */
  /* ------------------------------------------------------------------ */
  const input = $("#input");

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  function syncInputState() {
    const hasText = input.value.trim().length > 0;
    const hasAtt = S.attachments.length > 0;
    const send = $("#sendBtn");
    if (S.stream) {
      send.disabled = false;
      send.dataset.state = "stop";
      send.setAttribute("aria-label", "Stop generating");
      $("#sendIcon").innerHTML = '<use href="#i-stop"/>';
    } else {
      const ok = S.mode === "image" ? hasText : (hasText || hasAtt);
      send.disabled = !ok;
      delete send.dataset.state;
      send.setAttribute("aria-label", S.mode === "image" ? "Generate image" : "Send message");
      $("#sendIcon").innerHTML = S.mode === "image" ? '<use href="#i-spark"/>' : '<use href="#i-send"/>';
    }
    const n = input.value.length;
    const cc = $("#charCount");
    cc.textContent = n.toLocaleString() + " / 24000";
    cc.dataset.warn = n > 20000 ? "1" : "0";
  }

  function setMode(mode) {
    S.mode = mode;
    $("#composer").dataset.mode = mode;
    $("#modeChat").setAttribute("aria-selected", String(mode === "chat"));
    $("#modeImage").setAttribute("aria-selected", String(mode === "image"));
    input.placeholder = mode === "image"
      ? "Describe the image you want…"
      : (S.agent ? "Ask " + agentName(S.agent) + "…" : "Ask anything…");
    $("#inputLabel").textContent = mode === "image" ? "Image prompt" : "Message Latte";
    moveThumb();
    syncInputState();
  }
  function moveThumb() {
    const active = S.mode === "chat" ? $("#modeChat") : $("#modeImage");
    const th = $("#modeThumb");
    th.style.width = active.offsetWidth + "px";
    th.style.transform = "translateX(" + (active.offsetLeft - 3) + "px)";
  }
  const agentName = (id) => (S.boot && (S.boot.agents.find((a) => a.id === id) || {}).name) || id;

  /* ------------------------------------------------------------------ */
  /*  Attachments                                                        */
  /* ------------------------------------------------------------------ */
  function renderTray() {
    const tray = $("#tray");
    tray.innerHTML = "";
    S.attachments.forEach((a, idx) => {
      const box = el("div", "att");
      const img = el("img");
      img.src = a.data_uri;
      img.alt = a.name || "attachment " + (idx + 1);
      const x = el("button", "att__x");
      x.type = "button";
      x.setAttribute("aria-label", "Remove attachment");
      x.innerHTML = icon("close");
      x.addEventListener("click", () => { S.attachments.splice(idx, 1); renderTray(); syncInputState(); });
      box.append(img, x);
      tray.appendChild(box);
    });
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!list.length) { toast("Only image files can be attached", "warn"); return; }
    if (S.attachments.length + list.length > 4) { toast("Up to 4 images per message", "warn"); return; }
    const fd = new FormData();
    list.forEach((f, i) => fd.append("f" + i, f));
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd }).then((x) => {
        if (!x.ok) return x.json().then((e) => { throw new Error(e.error || x.statusText); });
        return x.json();
      });
      r.files.forEach((f, i) => S.attachments.push({ id: f.id, data_uri: f.data_uri, name: (list[i] || {}).name }));
      renderTray();
      syncInputState();
      if (S.model === "fast" || S.model === "coder") {
        toast("Switched to Balanced — this model can see images", "info", 3400);
        S.model = "balanced"; applyModel();
      }
    } catch (e) { toast(e.message || "Upload failed", "err"); }
  }

  /* ------------------------------------------------------------------ */
  /*  Message rendering                                                  */
  /* ------------------------------------------------------------------ */
  const stream = $("#stream");
  const inner = $("#streamInner");

  /** Titles are user text — strip markdown noise so the list reads clean. */
  function prettyTitle(t) {
    return String(t || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_`#>~]{1,3}/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function timeAgo(ts) {
    const d = (Date.now() / 1000 - ts);
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function msgShell(role, opts) {
    opts = opts || {};
    const m = el("div", "msg msg--" + role);
    m.dataset.id = opts.id || "";
    if (role === "assistant") {
      const av = el("div", "msg__avatar" + (opts.agent ? " msg__avatar--agent" : ""));
      av.innerHTML = icon(opts.agent ? "agent" : "cup");
      av.setAttribute("aria-hidden", "true");
      m.appendChild(av);
    }
    const col = el("div", "msg__col");
    const head = el("div", "msg__head");
    if (role === "assistant") {
      head.innerHTML = '<span class="msg__who">' + (opts.agent ? MD.escape(agentName(opts.agent)) : "Latte") + "</span>";
      if (opts.tag) head.appendChild(el("span", "msg__tag", opts.tag));
      head.appendChild(el("span", "", ""));
    }
    col.appendChild(head);
    m.appendChild(col);
    return { root: m, col, head };
  }

  function addUser(text, atts, meta) {
    const { root, col, head } = msgShell("user", { id: meta && meta.id });
    head.remove();
    const b = el("div", "bubble-user", text);
    col.appendChild(b);
    if (atts && atts.length) {
      const grid = el("div", "img-grid");
      grid.dataset.n = String(atts.length);
      atts.forEach((a) => {
        const t = el("div", "tile");
        const img = el("img");
        img.src = a.data_uri || ("/media/" + a.id);
        img.alt = "attachment";
        img.loading = "lazy";
        t.appendChild(img);
        grid.appendChild(t);
      });
      col.insertBefore(grid, b);
    }
    inner.appendChild(root);
    return root;
  }

  function addAssistantShell(meta) {
    const { root, col, head } = msgShell("assistant", { id: meta.id, agent: meta.agent, tag: meta.tag });
    const body = el("div", "bubble-ai");
    const md = el("div", "md");
    body.appendChild(md);
    col.appendChild(body);
    const acts = el("div", "msg__actions");
    acts.innerHTML =
      '<button class="act" type="button" data-act="copy">' + icon("copy") + "<span>Copy</span></button>" +
      '<button class="act" type="button" data-act="regen">' + icon("refresh") + "<span>Retry</span></button>" +
      '<button class="act" type="button" data-act="speak">' + icon("vol") + "<span>Read</span></button>" +
      '<button class="act" type="button" data-act="speak-stop" hidden>' + icon("stop") + "<span>Stop</span></button>";
    col.appendChild(acts);
    const stamp = el("span", "", "");
    head.appendChild(stamp);
    inner.appendChild(root);
    wireActions(root, md);
    return { root, md, acts, stamp, head };
  }

  function wireActions(root, mdNode) {
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "copy") {
        const txt = MD.toText(mdNode.innerHTML);
        await copyText(txt);
        btn.dataset.done = "1";
        btn.querySelector("span").textContent = "Copied";
        setTimeout(() => { btn.removeAttribute("data-done"); btn.querySelector("span").textContent = "Copy"; }, 1600);
      } else if (act === "regen") {
        regenerate();
      } else if (act === "speak") {
        speak(mdNode, root, btn);
      } else if (act === "speak-stop") {
        window.speechSynthesis && window.speechSynthesis.cancel();
        $$(".msg").forEach((m) => m.removeAttribute("data-speaking"));
        toggleSpeakBtn(root, false);
      } else if (btn.dataset.copyCode !== undefined) {
        const code = btn.closest(".code").querySelector("code");
        await copyText(code.dataset.raw || code.textContent);
        const s = btn.querySelector("span");
        s.textContent = "Copied";
        setTimeout(() => { s.textContent = "Copy"; }, 1500);
      }
    });
  }

  function toggleSpeakBtn(root, on) {
    const a = root.querySelector('[data-act="speak"]');
    const b = root.querySelector('[data-act="speak-stop"]');
    if (a) a.hidden = on;
    if (b) b.hidden = !on;
  }

  function speak(mdNode, root, btn) {
    if (!("speechSynthesis" in window)) { toast("Speech not supported in this browser", "warn"); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(MD.toText(mdNode.innerHTML));
    u.rate = 1.02; u.pitch = 1.0;
    u.onend = u.onerror = () => { root.removeAttribute("data-speaking"); toggleSpeakBtn(root, false); };
    root.dataset.speaking = "1";
    toggleSpeakBtn(root, true);
    window.speechSynthesis.speak(u);
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (_) {
      const ta = el("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (__) { /* ignore */ }
      ta.remove();
      return true;
    }
  }

  /* ---------- streaming markdown painter ------------------------------ */
  function makePainter(mdNode) {
    let raw = "";
    let queued = false;
    let lastAt = 0;
    const paint = () => {
      lastAt = performance.now();
      queued = false;
      mdNode.innerHTML = MD.render(raw);
      if (!mdNode.querySelector(".caret")) {
        const c = el("span", "caret");
        c.setAttribute("aria-hidden", "true");
        mdNode.appendChild(c);
      }
      maybeStick();
    };
    return {
      push(chunk) {
        raw += chunk;
        if (queued) return;
        const wait = performance.now() - lastAt;
        if (wait > 70) paint();
        else { queued = true; setTimeout(paint, 70 - wait); }
      },
      finish(full) {
        if (full != null) raw = full;
        mdNode.innerHTML = MD.render(raw);
        return raw;
      },
      get raw() { return raw; }
    };
  }

  /* ---------- scroll behaviour ---------------------------------------- */
  let stick = true;
  function maybeStick(force) {
    if (stick || force) stream.scrollTo({ top: stream.scrollHeight, behavior: force ? "smooth" : "auto" });
  }
  stream.addEventListener("scroll", () => {
    const fromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    stick = fromBottom < 90;
    $("#streamWrap").dataset.scrolled = stream.scrollTop > 12 ? "1" : "0";
  }, { passive: true });

  /* ------------------------------------------------------------------ */
  /*  Hero / empty state                                                 */
  /* ------------------------------------------------------------------ */
  const STARTERS = [
    { icon: "brain", text: "Explain how SSE streaming works, with a minimal example" },
    { icon: "image", text: "A terracotta cup on linen, morning light through a window", img: true },
    { icon: "code", text: "Review this function and suggest a cleaner design" },
    { icon: "pen", text: "Write a 120-word product blurb for a warm ceramic mug" },
    { icon: "wand", text: "Give me five names for a cream-and-brown design studio" },
    { icon: "spark", text: "Plan a focused 90-minute deep work block" }
  ];

  function renderHero() {
    inner.innerHTML = "";
    const h = el("div", "hero");
    h.innerHTML =
      '<span class="hero__eyebrow">' + icon("spark") + "Chat &amp; image generation</span>" +
      '<h2 class="hero__title">Good to see you.<br><em>What are we making?</em></h2>' +
      '<p class="hero__sub">Conversation and image generation in one warm place. ' +
      "Pick a model, choose a specialist, or just start typing.</p>";

    const chips = el("div", "chips");
    STARTERS.forEach((s) => {
      const b = el("button", "chip");
      b.type = "button";
      b.innerHTML = icon(s.icon) + "<span>" + MD.escape(s.text) + "</span>";
      b.addEventListener("click", () => {
        if (s.img) setMode("image");
        input.value = s.text;
        grow(); syncInputState(); input.focus();
        if (window.innerWidth <= 860) closeSidebar();
      });
      chips.appendChild(b);
    });
    h.appendChild(chips);

    const feats = el("div", "features");
    [
      ["bolt", "Real streaming", "Tokens arrive as the model writes them — no waiting for the whole answer."],
      ["image", "Image studio", "Aspect, style, quality and up to four renders that appear as they finish."],
      ["agent", "27 specialists", "Coding mentor, UX designer, financial advisor and more, one click away."],
      ["brain", "Persistent memory", "Each conversation keeps its own context, with a live usage meter."]
    ].forEach(([ic, t, d]) => {
      const f = el("div", "feature");
      f.innerHTML = '<div class="feature__ico">' + icon(ic) + "</div><h3>" + t + "</h3><p>" + d + "</p>";
      feats.appendChild(f);
    });
    h.appendChild(feats);
    inner.appendChild(h);
    stick = true;
  }

  /* ------------------------------------------------------------------ */
  /*  Send: chat                                                         */
  /* ------------------------------------------------------------------ */
  async function sendChat(text, atts) {
    const userMsg = { role: "user", content: text, ts: Date.now() / 1000, attachments: atts.slice() };
    addUser(text, atts, {});
    clearHero();

    // thinking pill
    const thinkWrap = el("div", "msg msg--assistant");
    thinkWrap.innerHTML =
      '<div class="msg__avatar" aria-hidden="true">' + icon(S.agent ? "agent" : "cup") + "</div>" +
      '<div class="msg__col"><div class="thinking"><span class="thinking__dots"><i></i><i></i><i></i></span>' +
      "<span>" + (S.agent ? MD.escape(agentName(S.agent)) + " is working" : "Thinking") + "</span></div></div>";
    inner.appendChild(thinkWrap);
    maybeStick(true);

    const ac = new AbortController();
    S.abort = ac;
    let shell = null, painter = null, firstToken = true;

    try {
      await sse("/api/chat", {
        session_id: S.sid,
        message: text,
        model: S.model,
        agent: S.agent,
        tone: S.prefs.tone,
        temperature: S.prefs.temp,
        system_prompt: S.prefs.system || null,
        images: atts.map((a) => a.id)
      }, {
        ack(d) {
          if (d.title) setChatTitle(d.title);
        },
        token(d) {
          if (firstToken) {
            firstToken = false;
            thinkWrap.remove();
            shell = addAssistantShell({ id: d.id, agent: S.agent, tag: S.agent ? "Agent" : null });
            painter = makePainter(shell.md);
            shell.root.dataset.justDone = "";
          }
          painter.push(d.text);
        },
        async error(d) {
          if (!shell) { thinkWrap.remove(); shell = addAssistantShell({ id: "err" }); painter = makePainter(shell.md); }
          painter.finish();
          shell.md.innerHTML +=
            '<div class="callout">' + icon("alert") + "<div>" + MD.inline(d.message || "Something went wrong.") +
            (d.partial ? "<br><br><em>Partial answer kept above.</em>" : "") + "</div></div>";
          toast(d.message || "Generation failed", "err");
        },
        done(d) {
          if (!shell) { thinkWrap.remove(); shell = addAssistantShell({ id: d.id }); painter = makePainter(shell.md); }
          painter.finish(d.content);
          if (shell.stamp) shell.stamp.textContent = (d.latency_ms / 1000).toFixed(1) + "s";
          if (d.memory) setCtx(d.memory);
          S.messages.push(userMsg);
          S.messages.push({ role: "assistant", content: d.content, ts: Date.now() / 1000 });
          setTimeout(() => shell.root.removeAttribute("data-just-done"), 2600);
        },
        end() { /* stream finished */ },
        __close() { /* reader closed */ }
      }, ac.signal);
    } catch (e) {
      thinkWrap.remove();
      if (e.name !== "AbortError") {
        if (!shell) { shell = addAssistantShell({ id: "err" }); shell.md.innerHTML = '<div class="callout">' + icon("alert") + "<div>" + MD.escape(e.message || "Connection failed") + "</div></div>"; }
        toast(e.message || "Connection failed", "err");
      } else if (shell) {
        painter.finish();
        shell.md.innerHTML += '<div class="callout callout--warn">' + icon("info") + "<div>Stopped.</div></div>";
      }
      S.messages.push(userMsg);
    } finally {
      thinkWrap.remove();
      S.abort = null;
      setBusy(false);
      maybeStick();
      refreshConversations();
    }
  }

  function clearHero() { const h = $(".hero"); if (h) h.remove(); }

  /* ------------------------------------------------------------------ */
  /*  Send: image                                                        */
  /* ------------------------------------------------------------------ */
  async function sendImage(prompt) {
    clearHero();
    const { root, col, head } = msgShell("assistant", { id: "job-" + Date.now() });
    head.querySelector(".msg__who").textContent = "Image studio";
    const tag = el("span", "msg__tag", S.img.ratio + " · " + S.img.quality.toUpperCase());
    head.appendChild(tag);

    const grid = el("div", "img-grid");
    grid.dataset.n = String(S.img.n);
    const tiles = [];
    for (let i = 0; i < S.img.n; i++) {
      const t = el("div", "tile tile--pending shimmer");
      t.dataset.ratio = S.img.ratio;
      t.dataset.idx = String(i);
      t.innerHTML = '<div class="tile__pending"><span class="ring"></span><span>Rendering ' + (i + 1) + " of " + S.img.n + "…</span></div>";
      grid.appendChild(t);
      tiles.push(t);
    }
    col.appendChild(grid);
    inner.appendChild(root);
    maybeStick(true);

    const gallery = [];
    const ac = new AbortController();
    S.abort = ac;
    let elapsed = 0;
    const timer = setInterval(() => { elapsed += 1; }, 1000);

    try {
      await sse("/api/image", {
        session_id: S.sid,
        prompt,
        aspect_ratio: S.img.ratio,
        style: S.img.style,
        quality: S.img.quality,
        n: S.img.n,
        negative_prompt: $("#negInput").value.trim() || null,
        seed: $("#seedInput").value.trim() || null
      }, {
        image(d) {
          const idx = d.index || 0;
          const tile = tiles[idx] || tiles[tiles.length - 1];
          tile.className = "tile";
          tile.dataset.ratio = S.img.ratio;
          if (d.ok) {
            const url = "/gen/" + d.file;
            const img = el("img");
            img.src = url; img.alt = prompt; img.loading = "lazy"; img.decoding = "async";
            img.addEventListener("click", () => openLightbox(gallery, gallery.findIndex((g) => g.url === url)));
            const badge = el("span", "tile__badge", (d.model || "render").split("/").pop().slice(0, 18));
            const scrim = el("div", "tile__scrim");
            const tools = el("div", "tile__tools");
            const mk = (ic, label, fn) => {
              const b = el("button", "tile__tool");
              b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
              b.innerHTML = icon(ic);
              b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
              return b;
            };
            tools.append(
              mk("expand", "Open viewer", () => openLightbox(gallery, gallery.findIndex((g) => g.url === url))),
              mk("download", "Download", () => download(url, "latte-" + d.file)),
              mk("paperclip", "Use in chat", () => useGenInChat(d.file, prompt)),
              mk("refresh", "Variation", () => { setMode("image"); input.value = prompt; grow(); syncInputState(); input.focus(); })
            );
            scrim.appendChild(tools);
            tile.append(img, badge, scrim);
            gallery.push({ url, prompt, file: d.file, w: d.width, h: d.height, model: d.model });
          } else {
            tile.innerHTML = '<div class="tile__pending">' + icon("alert") + "<span>" + MD.escape((d.error || "Failed").slice(0, 90)) + "</span></div>";
            tile.style.color = "var(--danger)";
          }
          maybeStick();
        },
        done(d) {
          clearInterval(timer);
          const cap = el("div", "img-caption");
          const meta = el("div", "img-caption__meta");
          [S.img.style !== "auto" ? S.img.style.replace("_", " ") : null,
           S.img.quality.toUpperCase(), S.img.ratio,
           $("#negInput").value.trim() ? "avoiding: " + $("#negInput").value.trim().slice(0, 40) : null,
           $("#seedInput").value.trim() ? "seed " + $("#seedInput").value.trim() : null,
           d.elapsed_s + "s", d.count + (d.count === 1 ? " image" : " images")]
            .filter(Boolean).forEach((t) => meta.appendChild(el("span", "pill", t)));
          cap.innerHTML = "<div style='min-width:0;flex:1'><div>" + MD.escape(prompt) + "</div></div>";
          cap.firstChild.appendChild(meta);
          col.appendChild(cap);
          if (d.failed && d.failed.length) {
            const c = el("div", "callout callout--warn");
            c.innerHTML = icon("alert") + "<div>" + MD.escape(d.failed.filter(Boolean).join(" · ").slice(0, 160)) + "</div>";
            col.appendChild(c);
          }
          S.lastGallery = gallery;
          if (d.count) toast(d.count + (d.count === 1 ? " image" : " images") + " ready in " + d.elapsed_s + "s", "ok");
          setChatTitle("Image: " + prompt.slice(0, 40));
        }
      }, ac.signal);
    } catch (e) {
      clearInterval(timer);
      if (e.name !== "AbortError") {
        tiles.forEach((t) => { if (t.classList.contains("tile--pending")) t.remove(); });
        const c = el("div", "callout");
        c.innerHTML = icon("alert") + "<div>" + MD.escape(e.message || "Image generation failed") + "</div>";
        col.appendChild(c);
        toast(e.message || "Image generation failed", "err");
      }
    } finally {
      clearInterval(timer);
      tiles.forEach((t) => { if (t.classList.contains("tile--pending")) t.remove(); });
      S.abort = null;
      setBusy(false);
      refreshConversations();
      maybeStick();
    }
  }

  async function useGenInChat(file, prompt) {
    try {
      const res = await fetch("/gen/" + file);
      const blob = await res.blob();
      const fd = new FormData();
      fd.append("f0", new File([blob], file, { type: "image/png" }));
      const r = await fetch("/api/upload", { method: "POST", body: fd }).then((x) => x.json());
      if (!r.files) throw new Error(r.error || "Could not attach");
      setMode("chat");
      S.attachments.push({ id: r.files[0].id, data_uri: r.files[0].data_uri, name: file });
      renderTray(); syncInputState();
      input.value = "What do you notice about this image?";
      grow(); syncInputState(); input.focus();
      toast("Image attached to chat", "ok");
    } catch (e) { toast(e.message || "Could not attach image", "err"); }
  }

  function download(url, name) {
    const a = el("a");
    a.href = url; a.download = name || "latte-image.png";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ------------------------------------------------------------------ */
  /*  Lightbox                                                           */
  /* ------------------------------------------------------------------ */
  let lbList = [], lbIdx = 0, lbFocus = null;
  function openLightbox(list, idx) {
    if (!list || !list.length) return;
    lbList = list; lbIdx = clamp(idx || 0, 0, list.length - 1);
    lbFocus = document.activeElement;
    showLb();
    $("#lightbox").dataset.open = "1";
    $("#lightbox").setAttribute("aria-hidden", "false");
    $("#lbClose").focus();
  }
  function showLb() {
    const it = lbList[lbIdx];
    if (!it) return;
    const img = $("#lbImg");
    img.src = it.url; img.alt = it.prompt || "Generated image";
    $("#lbCounter").textContent = (lbIdx + 1) + " / " + lbList.length;
    $("#lbPrompt").textContent = it.prompt || "";
    $("#lbPrev").disabled = lbList.length < 2;
    $("#lbNext").disabled = lbList.length < 2;
  }
  function closeLightbox() {
    $("#lightbox").removeAttribute("data-open");
    $("#lightbox").setAttribute("aria-hidden", "true");
    if (lbFocus && lbFocus.focus) lbFocus.focus();
  }

  /* ------------------------------------------------------------------ */
  /*  Busy / titles / context                                            */
  /* ------------------------------------------------------------------ */
  function setBusy(b) {
    S.busy = b; S.stream = b;
    input.disabled = false;
    $("#statusDot").dataset.s = b ? "busy" : "on";
    $("#statusText").textContent = b ? "Generating…" : "Ready";
    syncInputState();
  }
  function setChatTitle(t) {
    if (!t) return;
    $("#chatTitle").textContent = prettyTitle(t);
    const c = S.conversations.find((x) => x.id === S.sid);
    if (c) c.title = t;
    renderConversations();
  }
  function setCtx(mem) {
    if (!mem || typeof mem.used_percent !== "number") return;
    const pct = clamp(mem.used_percent, 0, 100);
    $("#ctxFill").style.width = pct + "%";
    $("#ctxFill").dataset.hot = pct > 85 ? "1" : "0";
    $("#ctxTxt").textContent = Math.round(pct) + "%";
    $("#memDetail").textContent =
      mem.messages + " messages · " + (mem.characters || 0).toLocaleString() + " / " +
      (mem.capacity || 10000).toLocaleString() + " chars" + (mem.advice ? " — " + mem.advice : "");
  }

  /* ------------------------------------------------------------------ */
  /*  Conversations                                                      */
  /* ------------------------------------------------------------------ */
  async function refreshConversations() {
    try {
      const r = await api("/api/sessions");
      S.conversations = r.conversations || [];
      renderConversations();
    } catch (_) { /* non-fatal */ }
  }

  function renderConversations() {
    const list = $("#convList");
    list.innerHTML = "";
    if (!S.conversations.length) {
      list.appendChild(el("div", "side-empty", "No conversations yet"));
      return;
    }
    S.conversations.forEach((c) => {
      const b = el("button", "conv");
      b.type = "button";
      b.setAttribute("role", "listitem");
      b.setAttribute("aria-current", String(c.id === S.sid));
      b.innerHTML = '<span class="conv__icon">' + icon((c.title || "").startsWith("Image:") ? "image" : "chat") + "</span>";
      const body = el("div", "conv__body");
      const t = el("div", "conv__title ellipsis", prettyTitle(c.title) || "New chat");
      const m = el("div", "conv__meta", (c.turns || 0) + " turns · " + timeAgo(c.updated));
      body.append(t, m);
      const del = el("button", "conv__del");
      del.type = "button";
      del.setAttribute("aria-label", "Delete conversation");
      del.innerHTML = icon("trash");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api("/api/session/" + c.id, { method: "DELETE" });
          if (c.id === S.sid) await newChat(true); else await refreshConversations();
          toast("Conversation deleted", "ok");
        } catch (err) { toast(err.message, "err"); }
      });
      b.appendChild(body);
      b.appendChild(del);
      b.addEventListener("click", () => switchTo(c.id));
      list.appendChild(b);
    });
    // nudge the scroller so compositor tiles invalidate after a rebuild
    requestAnimationFrame(() => { list.scrollTop = list.scrollTop; });
  }

  async function switchTo(id) {
    if (id === S.sid) { closeSidebar(); return; }
    try {
      const r = await api("/api/history/" + encodeURIComponent(id));
      S.sid = id;
      S.messages = r.messages || [];
      $("#chatTitle").textContent = prettyTitle(r.title) || "New chat";
      replay(r.messages || []);
      renderConversations();
      closeSidebar();
      try { setCtx(await api("/api/memory/" + encodeURIComponent(id))); } catch (_) { /* ignore */ }
    } catch (e) { toast(e.message || "Could not open conversation", "err"); refreshConversations(); }
  }

  function replay(msgs) {
    inner.innerHTML = "";
    if (!msgs.length) { renderHero(); return; }
    msgs.forEach((m) => {
      if (m.role === "user") {
        addUser(m.content || "", [], m);
      } else if (m.kind === "image") {
        const { root, col, head } = msgShell("assistant", { id: m.id });
        head.querySelector(".msg__who").textContent = "Image studio";
        const grid = el("div", "img-grid");
        const files = m.images || [];
        grid.dataset.n = String(files.length || 1);
        const gallery = files.map((f) => ({ url: "/gen/" + f, prompt: m.prompt || m.content, file: f }));
        files.forEach((f, i) => {
          const t = el("div", "tile");
          t.dataset.ratio = (m.params || {}).ratio || "1:1";
          const img = el("img");
          img.src = "/gen/" + f; img.alt = m.prompt || "Generated image"; img.loading = "lazy";
          img.addEventListener("click", () => openLightbox(gallery, i));
          const scrim = el("div", "tile__scrim");
          const tools = el("div", "tile__tools");
          const mk = (ic, label, fn) => {
            const b = el("button", "tile__tool"); b.type = "button"; b.title = label;
            b.setAttribute("aria-label", label); b.innerHTML = icon(ic);
            b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
            return b;
          };
          tools.append(
            mk("expand", "Open viewer", () => openLightbox(gallery, i)),
            mk("download", "Download", () => download("/gen/" + f, "latte-" + f)),
            mk("paperclip", "Use in chat", () => useGenInChat(f, m.prompt || ""))
          );
          scrim.appendChild(tools);
          t.append(img, scrim);
          grid.appendChild(t);
        });
        col.appendChild(grid);
        if (m.content) {
          const cap = el("div", "img-caption");
          cap.innerHTML = "<div style='min-width:0;flex:1'><div>" + MD.escape(m.content) + "</div></div>";
          col.appendChild(cap);
        }
        inner.appendChild(root);
        S.lastGallery = gallery;
      } else {
        const sh = addAssistantShell({ id: m.id, agent: m.agent, tag: m.agent ? "Agent" : null });
        sh.md.innerHTML = MD.render(m.content || "");
        if (sh.stamp && m.latency_ms) sh.stamp.textContent = (m.latency_ms / 1000).toFixed(1) + "s";
      }
    });
    stick = true;
    maybeStick(true);
  }

  async function newChat(silent) {
    if (S.stream && S.abort) S.abort.abort();
    try {
      const r = await api("/api/new", { method: "POST", body: JSON.stringify({ session_id: S.sid, model: S.model }) });
      S.sid = r.session_id;
      S.messages = [];
      S.attachments = [];
      S.agent = null;
      renderTray(); applyAgent();
      $("#chatTitle").textContent = "New chat";
      $("#chatSub").textContent = "Ask anything, or switch to image mode";
      $("#ctxFill").style.width = "0%"; $("#ctxTxt").textContent = "0%";
      renderHero();
      await refreshConversations();
      input.focus();
      if (!silent) toast("Fresh conversation", "ok", 1600);
    } catch (e) { toast(e.message || "Could not start a new chat", "err"); }
  }

  async function regenerate() {
    if (S.stream) return;
    const lastUser = S.messages.filter((m) => m.role === "user").pop();
    if (!lastUser) { toast("Nothing to retry yet", "warn"); return; }
    try { await api("/api/regenerate", { method: "POST", body: JSON.stringify({ session_id: S.sid }) }); } catch (_) { /* ignore */ }
    // drop the last assistant bubble from the DOM
    const all = $$(".msg--assistant", inner);
    if (all.length) all[all.length - 1].remove();
    S.messages.pop();
    const atts = (lastUser.attachments || []).map((id) => {
      const a = S.attachments.find((x) => x.id === id);
      return a || { id, data_uri: "/media/" + id };
    });
    // remove the echoed user bubble too — sendChat re-adds it
    const users = $$(".msg--user", inner);
    if (users.length) users[users.length - 1].remove();
    setBusy(true);
    await sendChat(lastUser.content, atts);
  }

  /* ------------------------------------------------------------------ */
  /*  Popovers                                                           */
  /* ------------------------------------------------------------------ */
  let openPop = null;
  function closePop() {
    if (!openPop) return;
    openPop.el.removeAttribute("data-open");
    openPop.el.setAttribute("aria-hidden", "true");
    if (openPop.trigger) openPop.trigger.setAttribute("aria-expanded", "false");
    openPop = null;
  }
  function placePop(popEl, anchor) {
    const r = anchor.getBoundingClientRect();
    popEl.style.visibility = "hidden";
    popEl.hidden = false;
    popEl.setAttribute("data-open", "1");
    const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
    let left = r.left;
    let top = r.bottom + 8;
    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
    left = Math.max(12, left);
    if (top + ph > window.innerHeight - 12) {
      top = Math.max(12, r.top - ph - 8);
      popEl.style.transformOrigin = "bottom left";
    } else popEl.style.transformOrigin = "top left";
    popEl.style.left = left + "px";
    popEl.style.top = top + "px";
    popEl.style.visibility = "";
  }
  function togglePop(popEl, trigger, builder) {
    if (openPop && openPop.el === popEl) { closePop(); return; }
    closePop();
    builder(popEl);
    popEl.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    placePop(popEl, trigger);
    openPop = { el: popEl, trigger };
    const first = popEl.querySelector(".pop-item");
    if (first) first.focus();
  }

  function buildModelPop(pop) {
    pop.innerHTML = "";
    const head = el("div", "pop__head");
    head.innerHTML = '<span class="t-caps">Model</span>';
    pop.appendChild(head);
    (S.boot ? S.boot.chat_models : []).forEach((m) => {
      const b = el("button", "pop-item");
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.id = m.id;
      b.setAttribute("aria-checked", String(m.id === S.model));
      b.innerHTML =
        '<span class="pop-item__dot" style="background:' + m.dot + '"></span>' +
        '<span class="pop-item__body"><span class="pop-item__name">' + MD.escape(m.name) +
        ' <span class="t-mute" style="font-weight:400">· ' + MD.escape(m.tier) + "</span></span>" +
        '<span class="pop-item__desc">' + MD.escape(m.blurb) + "</span></span>" +
        '<span class="pop-item__check">' + icon("check") + "</span>";
      b.addEventListener("click", () => {
        S.model = m.id; applyModel(); closePop();
        toast("Model: " + m.name, "ok", 1600);
      });
      pop.appendChild(b);
    });
    const foot = el("div", "pop__foot");
    foot.innerHTML = "Vision-capable models accept attached images.";
    pop.appendChild(foot);
  }

  function buildAgentPop(pop) {
    pop.innerHTML = "";
    const head = el("div", "pop__head");
    head.innerHTML = '<span class="t-caps">Specialist</span>';
    pop.appendChild(head);

    const none = el("button", "pop-item");
    none.type = "button"; none.setAttribute("role", "option"); none.dataset.id = "";
    none.setAttribute("aria-checked", String(!S.agent));
    none.innerHTML = '<span class="pop-item__dot" style="background:var(--ink-4)"></span>' +
      '<span class="pop-item__body"><span class="pop-item__name">No agent</span>' +
      '<span class="pop-item__desc">General conversation with your chosen model</span></span>' +
      '<span class="pop-item__check">' + icon("check") + "</span>";
    none.addEventListener("click", () => { S.agent = null; applyAgent(); closePop(); });
    pop.appendChild(none);
    pop.appendChild(el("div", "pop__sep"));

    (S.boot ? S.boot.agents : []).forEach((a) => {
      const b = el("button", "pop-item");
      b.type = "button"; b.setAttribute("role", "option"); b.dataset.id = a.id;
      b.setAttribute("aria-checked", String(a.id === S.agent));
      b.innerHTML = '<span class="pop-item__body"><span class="pop-item__name">' + MD.escape(a.name) + "</span>" +
        '<span class="pop-item__desc">' + MD.escape(a.description || "") + "</span></span>" +
        '<span class="pop-item__check">' + icon("check") + "</span>";
      b.addEventListener("click", () => {
        S.agent = S.agent === a.id ? null : a.id;
        applyAgent(); closePop();
        if (S.agent) toast("Talking to " + a.name, "ok", 2000);
      });
      pop.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Image studio segmented controls                                    */
  /* ------------------------------------------------------------------ */
  function buildSeg(host, items, get, set, ariaPrefix) {
    host.innerHTML = "";
    items.forEach(([val, label]) => {
      const b = el("button", "seg__btn");
      b.type = "button";
      b.dataset.val = val;
      b.textContent = label;
      b.setAttribute("aria-label", (ariaPrefix || "") + " " + label);
      b.setAttribute("aria-pressed", String(get() === val));
      b.addEventListener("click", () => {
        set(val);
        $$("button", host).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
      host.appendChild(b);
    });
  }
  function buildStudio() {
    buildSeg($("#ratioSeg"), (S.boot ? S.boot.ratios : ["1:1"]).map((r) => [r, r]),
      () => S.img.ratio, (v) => { S.img.ratio = v; }, "Aspect ratio");
    buildSeg($("#qualSeg"), (S.boot ? S.boot.qualities : []).map((q) => [q.id, q.label]),
      () => S.img.quality, (v) => { S.img.quality = v; }, "Quality");
    buildSeg($("#nSeg"), [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]],
      () => String(S.img.n), (v) => { S.img.n = parseInt(v, 10); }, "Number of images");
    buildSeg($("#toneSeg"), [["default", "Balanced"], ["concise", "Concise"], ["explain", "Teaching"], ["code", "Engineer"], ["creative", "Literary"]],
      () => S.prefs.tone, (v) => { S.prefs.tone = v; savePrefs(); }, "Tone");
    applyStyle();
  }

  function styleLabel(id) {
    const s = (S.boot ? S.boot.styles : []).find((x) => x.id === id);
    return s ? s.label : id;
  }
  function applyStyle() {
    $("#styleName").textContent = styleLabel(S.img.style);
    $$("#stylePop .pop-item").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === S.img.style)));
  }
  function buildStylePop(pop) {
    pop.innerHTML = '<div class="pop__head"><span class="t-caps">Render style</span></div>';
    (S.boot ? S.boot.styles : []).forEach((s) => {
      const b = el("button", "pop-item");
      b.type = "button"; b.setAttribute("role", "option"); b.dataset.id = s.id;
      b.setAttribute("aria-checked", String(s.id === S.img.style));
      b.innerHTML = '<span class="pop-item__body"><span class="pop-item__name">' + MD.escape(s.label) + "</span></span>" +
        '<span class="pop-item__check">' + icon("check") + "</span>";
      b.addEventListener("click", () => { S.img.style = s.id; applyStyle(); closePop(); });
      pop.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Command palette                                                    */
  /* ------------------------------------------------------------------ */
  let palItems = [], palCursor = 0;

  function paletteCommands() {
    const cmds = [
      { id: "new", icon: "plus", title: "New chat", hint: MOD + "K", run: () => newChat() },
      { id: "mode-chat", icon: "chat", title: "Switch to chat mode", run: () => setMode("chat") },
      { id: "mode-image", icon: "image", title: "Switch to image mode", run: () => setMode("image") },
      { id: "settings", icon: "settings", title: "Open settings", run: () => openDrawer() },
      { id: "theme", icon: "moon", title: "Cycle theme (light → auto → dark)", run: cycleTheme },
      { id: "stop", icon: "stop", title: "Stop generating", run: () => S.abort && S.abort.abort() },
      { id: "regen", icon: "refresh", title: "Regenerate last answer", run: () => regenerate() },
      { id: "clear-mem", icon: "brain", title: "Clear this conversation's memory", run: clearMemory },
      { id: "health", icon: "bolt", title: "Run backend health check", run: healthCheck },
      { id: "attach", icon: "paperclip", title: "Attach images", run: () => $("#fileInput").click() },
      { id: "focus", icon: "edit", title: "Focus composer", run: () => input.focus() },
      { id: "top", icon: "send", title: "Scroll to latest", run: () => maybeStick(true) }
    ];
    (S.boot ? S.boot.chat_models : []).forEach((m) => {
      cmds.push({ id: "model:" + m.id, icon: "spark", title: "Model · " + m.name, hint: m.tier,
        run: () => { S.model = m.id; applyModel(); toast("Model: " + m.name, "ok", 1600); } });
    });
    (S.boot ? S.boot.agents : []).forEach((a) => {
      cmds.push({ id: "agent:" + a.id, icon: "agent", title: "Agent · " + a.name, hint: a.description,
        run: () => { S.agent = a.id; applyAgent(); toast("Talking to " + a.name, "ok", 1800); } });
    });
    return cmds;
  }

  function score(q, s) {
    if (!q) return 1;
    q = q.toLowerCase(); s = s.toLowerCase();
    if (s.startsWith(q)) return 100;
    if (s.includes(q)) return 60;
    let i = 0, hits = 0;
    for (const ch of s) { if (ch === q[i]) { i++; hits++; if (i === q.length) break; } }
    return i === q.length ? 20 + hits : 0;
  }

  function renderPalette() {
    const q = $("#paletteInput").value.trim();
    const all = paletteCommands();
    palItems = all
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, c.hint || "") * 0.6, score(q, c.id) * 0.4) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    palCursor = 0;
    const list = $("#paletteList");
    list.innerHTML = "";
    if (!palItems.length) {
      list.appendChild(el("div", "palette__empty", "Nothing matches that"));
      return;
    }
    palItems.forEach((c, i) => {
      const b = el("button", "pop-item");
      b.type = "button"; b.setAttribute("role", "option");
      b.dataset.i = String(i);
      b.innerHTML = '<span class="pop-item__dot" style="background:transparent;display:grid;place-items:center;width:20px;height:20px;margin-top:1px;color:var(--accent-deep)">' +
        icon(c.icon) + "</span>" +
        '<span class="pop-item__body"><span class="pop-item__name">' + MD.escape(c.title) + "</span>" +
        (c.hint ? '<span class="pop-item__desc ellipsis">' + MD.escape(c.hint) + "</span>" : "") + "</span>" +
        (i === 0 ? '<span class="pop-item__check" style="opacity:.6">' + icon("check") + "</span>" : "");
      b.addEventListener("click", () => runPalette(i));
      b.addEventListener("mousemove", () => { palCursor = i; highlightPalette(); });
      list.appendChild(b);
    });
    highlightPalette();
  }
  function highlightPalette() {
    $$("#paletteList .pop-item").forEach((n, i) => (n.dataset.cursor = i === palCursor ? "1" : "0"));
    const cur = $('#paletteList .pop-item[data-cursor="1"]');
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function runPalette(i) {
    const c = palItems[i];
    if (!c) return;
    closePalette();
    setTimeout(() => c.run(), 60);
  }
  function openPalette() {
    $("#palette").dataset.open = "1";
    $("#palette").setAttribute("aria-hidden", "false");
    $("#paletteInput").value = "";
    renderPalette();
    setTimeout(() => $("#paletteInput").focus(), 40);
  }
  function closePalette() {
    $("#palette").removeAttribute("data-open");
    $("#palette").setAttribute("aria-hidden", "true");
  }

  /* ------------------------------------------------------------------ */
  /*  Drawer, sidebar, theme, memory, health                             */
  /* ------------------------------------------------------------------ */
  let drawerFocus = null;
  function openDrawer() {
    drawerFocus = document.activeElement;
    $("#drawer").dataset.open = "1";
    $("#drawer").setAttribute("aria-hidden", "false");
    showScrim(true);
    refreshMemory();
    setTimeout(() => $("#drawerClose").focus(), 60);
  }
  function closeDrawer() {
    $("#drawer").removeAttribute("data-open");
    $("#drawer").setAttribute("aria-hidden", "true");
    if (!$("#sidebar").dataset.open) showScrim(false);
    if (drawerFocus && drawerFocus.focus) drawerFocus.focus();
  }
  function showScrim(on) {
    const s = $("#scrim");
    s.hidden = false;
    if (on) requestAnimationFrame(() => (s.dataset.open = "1"));
    else { s.removeAttribute("data-open"); setTimeout(() => { if (!s.dataset.open) s.hidden = true; }, 260); }
  }
  function openSidebar() {
    $("#sidebar").dataset.open = "1";
    $("#menuBtn").setAttribute("aria-expanded", "true");
    showScrim(true);
    $("#closeSidebar").style.display = window.innerWidth <= 860 ? "grid" : "none";
  }
  function closeSidebar() {
    $("#sidebar").removeAttribute("data-open");
    $("#menuBtn").setAttribute("aria-expanded", "false");
    if (!$("#drawer").dataset.open) showScrim(false);
  }
  function cycleTheme() {
    const order = ["light", "auto", "dark"];
    S.prefs.theme = order[(order.indexOf(S.prefs.theme) + 1) % 3];
    savePrefs(); applyTheme();
    toast("Theme: " + S.prefs.theme, "ok", 1400);
  }
  async function refreshMemory() {
    try { setCtx(await api("/api/memory/" + encodeURIComponent(S.sid))); }
    catch (_) { $("#memDetail").textContent = "Unavailable"; }
  }
  async function clearMemory() {
    try {
      await api("/api/memory/clear", { method: "POST", body: JSON.stringify({ session_id: S.sid }) });
      S.messages = [];
      $("#chatTitle").textContent = "New chat";
      renderHero(); setCtx({ messages: 0, characters: 0, capacity: 10000, used_percent: 0 });
      refreshConversations();
      toast("Memory cleared", "ok");
    } catch (e) { toast(e.message, "err"); }
  }
  async function healthCheck() {
    toast("Pinging backend…", "info", 1400);
    try {
      const r = await api("/api/health");
      $("#statusDot").dataset.s = r.status === "ok" ? "on" : "off";
      $("#statusText").textContent = r.status === "ok" ? "Ready" : "Degraded";
      toast("Backend " + r.status + (r.latency_ms ? " · " + Math.round(r.latency_ms) + "ms" : ""), r.status === "ok" ? "ok" : "warn", 3200);
    } catch (e) { toast(e.message, "err"); }
  }

  /* ------------------------------------------------------------------ */
  /*  Submit                                                             */
  /* ------------------------------------------------------------------ */
  async function submit() {
    if (S.stream) { if (S.abort) S.abort.abort(); return; }
    const text = input.value.trim();
    if (!text) return;

    if (S.mode === "image") {
      input.value = ""; grow();
      setBusy(true);
      await sendImage(text);
      return;
    }
    const atts = S.attachments.slice();
    input.value = ""; grow();
    S.attachments = []; renderTray();
    setBusy(true);
    syncInputState();
    await sendChat(text, atts);
  }

  /* ------------------------------------------------------------------ */
  /*  Wiring                                                             */
  /* ------------------------------------------------------------------ */
  function wire() {
    /* composer */
    input.addEventListener("input", () => { grow(); syncInputState(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === "Escape" && S.attachments.length) { S.attachments = []; renderTray(); syncInputState(); }
    });
    $("#composer").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    $("#sendBtn").addEventListener("click", (e) => {
      if (S.stream) { e.preventDefault(); if (S.abort) S.abort.abort(); }
    });
    $("#modeChat").addEventListener("click", () => setMode("chat"));
    $("#modeImage").addEventListener("click", () => setMode("image"));

    /* attachments */
    $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault(); document.body.dataset.drag = "1";
      }
    }));
    ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => {
      if (ev === "dragleave" && e.relatedTarget) return;
      document.body.removeAttribute("data-drag");
    }));
    document.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault(); uploadFiles(e.dataTransfer.files);
      }
    });
    window.addEventListener("paste", (e) => {
      const items = (e.clipboardData || {}).items || [];
      const files = [];
      for (const it of items) if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); setMode("chat"); uploadFiles(files); }
    });

    /* topbar */
    $("#modelBtn").addEventListener("click", (e) => { e.stopPropagation(); togglePop($("#modelPop"), $("#modelBtn"), buildModelPop); });
    $("#styleBtn").addEventListener("click", (e) => { e.stopPropagation(); togglePop($("#stylePop"), $("#styleBtn"), buildStylePop); });
    $("#agentBtn").addEventListener("click", (e) => { e.stopPropagation(); togglePop($("#agentPop"), $("#agentBtn"), buildAgentPop); });
    $("#themeBtn").addEventListener("click", cycleTheme);
    $("#menuBtn").addEventListener("click", () => ($("#sidebar").dataset.open ? closeSidebar() : openSidebar()));
    $("#closeSidebar").addEventListener("click", closeSidebar);
    $("#scrim").addEventListener("click", () => { closeSidebar(); closeDrawer(); closePop(); });

    /* sidebar */
    $("#newChatBtn").addEventListener("click", () => newChat());
    $("#settingsBtn").addEventListener("click", openDrawer);
    $("#paletteBtn").addEventListener("click", openPalette);
    $("#clearAllBtn").addEventListener("click", async () => {
      if (!S.conversations.length) { toast("Nothing to clear", "warn"); return; }
      if (!confirm("Delete all " + S.conversations.length + " conversations in this browser session?")) return;
      for (const c of S.conversations.slice()) {
        try { await api("/api/session/" + c.id, { method: "DELETE" }); } catch (_) { /* ignore */ }
      }
      await newChat(true);
      toast("All conversations cleared", "ok");
    });

    /* drawer */
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerDone").addEventListener("click", closeDrawer);
    $$("#themeSeg .seg__btn").forEach((b) => b.addEventListener("click", () => {
      S.prefs.theme = b.dataset.theme; savePrefs(); applyTheme();
    }));
    $("#motionSwitch").addEventListener("click", () => { S.prefs.motion = !S.prefs.motion; savePrefs(); applyMotion(); });
    $("#blurRange").addEventListener("input", (e) => { S.prefs.blur = +e.target.value; savePrefs(); applyBlur(); });
    $$("#densitySeg .seg__btn").forEach((b) => b.addEventListener("click", () => {
      S.prefs.scale = parseFloat(b.dataset.scale); savePrefs(); applyScale();
    }));
    $("#tempRange").addEventListener("input", (e) => { S.prefs.temp = +e.target.value; savePrefs(); applyTemp(); });
    $("#systemInput").addEventListener("input", (e) => { S.prefs.system = e.target.value.trim(); savePrefs(); });
    $("#clearMemBtn").addEventListener("click", clearMemory);
    $("#healthBtn").addEventListener("click", healthCheck);

    /* studio extras */
    $("#diceSeed").addEventListener("click", () => {
      $("#seedInput").value = Math.floor(Math.random() * 999999);
      toast("Seed " + $("#seedInput").value, "ok", 1200);
    });

    /* lightbox */
    $("#lbClose").addEventListener("click", closeLightbox);
    $("#lbPrev").addEventListener("click", () => { lbIdx = (lbIdx - 1 + lbList.length) % lbList.length; showLb(); });
    $("#lbNext").addEventListener("click", () => { lbIdx = (lbIdx + 1) % lbList.length; showLb(); });
    $("#lbDl").addEventListener("click", () => { const it = lbList[lbIdx]; if (it) download(it.url, "latte-" + (it.file || "image.png")); });
    $("#lbCopy").addEventListener("click", async () => { const it = lbList[lbIdx]; if (it) { await copyText(it.prompt || ""); toast("Prompt copied", "ok"); } });
    $("#lbUse").addEventListener("click", () => { const it = lbList[lbIdx]; if (it) { closeLightbox(); useGenInChat(it.file, it.prompt); } });
    $("#lightbox").addEventListener("click", (e) => { if (e.target === $("#lightbox") || e.target === $(".lightbox__stage")) closeLightbox(); });

    /* palette */
    $("#paletteInput").addEventListener("input", renderPalette);
    $("#paletteInput").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); palCursor = clamp(palCursor + 1, 0, palItems.length - 1); highlightPalette(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palCursor = clamp(palCursor - 1, 0, palItems.length - 1); highlightPalette(); }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(palCursor); }
    });
    $("#palette").addEventListener("click", (e) => { if (e.target === $("#palette")) closePalette(); });

    /* global keys */
    document.addEventListener("click", (e) => {
      if (openPop && !openPop.el.contains(e.target) && e.target !== openPop.trigger && !openPop.trigger.contains(e.target)) closePop();
    });
    document.addEventListener("keydown", (e) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").dataset.open ? closePalette() : openPalette(); return; }
      if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); newChat(); return; }
      if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); window.innerWidth <= 860 ? ($("#sidebar").dataset.open ? closeSidebar() : openSidebar()) : toast("Sidebar is always visible here", "info", 1600); return; }
      if (mod && e.key.toLowerCase() === ",") { e.preventDefault(); $("#drawer").dataset.open ? closeDrawer() : openDrawer(); return; }
      if (e.key === "Escape") {
        if ($("#palette").dataset.open) return closePalette();
        if ($("#lightbox").dataset.open) return closeLightbox();
        if (openPop) return closePop();
        if ($("#drawer").dataset.open) return closeDrawer();
        if ($("#sidebar").dataset.open) return closeSidebar();
        if (S.stream && S.abort) { S.abort.abort(); toast("Stopped", "warn", 1400); }
      }
      if (e.key === "/" && document.activeElement !== input && !$("#palette").dataset.open) { e.preventDefault(); input.focus(); }
      if ($("#lightbox").dataset.open && lbList.length > 1) {
        if (e.key === "ArrowLeft") { lbIdx = (lbIdx - 1 + lbList.length) % lbList.length; showLb(); }
        if (e.key === "ArrowRight") { lbIdx = (lbIdx + 1) % lbList.length; showLb(); }
      }
    });

    window.addEventListener("resize", () => { moveThumb(); if (openPop) placePop(openPop.el, openPop.trigger); });
    document.addEventListener("visibilitychange", () => { if (document.hidden && window.speechSynthesis) window.speechSynthesis.cancel(); });

    /* keyboard hints reflect the platform */
    $$("kbd").forEach((k) => { k.textContent = k.textContent.replace("⌘", MOD); });
  }

  /* ------------------------------------------------------------------ */
  /*  Boot                                                               */
  /* ------------------------------------------------------------------ */
  async function boot() {
    loadPrefs();
    applyAll();
    $("#systemInput").value = S.prefs.system || "";
    wire();
    setMode("chat");
    renderHero();

    try {
      const b = await api("/api/bootstrap");
      S.boot = b;
      S.sid = b.session_id;
      buildStudio();
      applyModel(); applyAgent();
      $("#chatSub").textContent = (b.chat_models || []).length + " models · " + (b.agents || []).length + " specialists · " + (b.image_models || []).length + " image engines";
      await refreshConversations();
      $("#statusDot").dataset.s = "on";
      $("#statusText").textContent = "Ready";
      $("#boot").dataset.hidden = "1";
      setTimeout(() => { const b2 = $("#boot"); if (b2) b2.remove(); }, 500);
      if (window.innerWidth > 860) setTimeout(moveThumb, 60);
      else setTimeout(moveThumb, 300);
    } catch (e) {
      $("#bootTxt").textContent = "Could not reach the backend";
      $("#bootErr").innerHTML = '<div class="callout">' + icon("alert") + "<div>" + MD.escape(e.message || String(e)) +
        "<br><br>Start it with <code>python server.py</code> then reload.</div></div>";
      $("#statusDot").dataset.s = "off";
      $("#statusText").textContent = "Offline";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
