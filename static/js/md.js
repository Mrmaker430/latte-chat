/* ==========================================================================
   LATTE — md.js
   A small, safe, dependency-free Markdown renderer with warm syntax
   highlighting. Everything is escaped before it is turned into HTML, so
   model output can never inject markup.
   ========================================================================== */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Escaping                                                           */
  /* ------------------------------------------------------------------ */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  /* ------------------------------------------------------------------ */
  /*  Syntax highlighting                                                */
  /* ------------------------------------------------------------------ */
  const GRAMMAR = {
    comment: [
      /#[^\n]*/, /\/\/[^\n]*/, /--[^\n]*/, /\/\*[\s\S]*?\*\//,
      /"""[\s\S]*?"""/, /'''[\s\S]*?'''/, /%[^\n]*/, /;[^\n]*/
    ],
    string: [
      /`(?:[^`\\]|\\.)*`/, /"(?:[^"\\\n]|\\.)*"/, /'(?:[^'\\\n]|\\.)*'/,
      /f"(?:[^"\\]|\\.)*"/, /f'(?:[^'\\]|\\.)*'/, /r"(?:[^"\\]|\\.)*"/,
      /\/(?![*\s/])(?:[^/\\\n]|\\.)+\/[gimsuy]*/
    ],
    keyword: [
      "abstract","as","async","await","break","case","catch","class","const","constexpr",
      "continue","debugger","declare","default","def","del","delete","do","elif","else",
      "enum","except","export","extends","extern","finally","for","from","function","global",
      "goto","if","implements","import","in","instanceof","interface","is","lambda","let",
      "match","module","mut","namespace","new","nonlocal","not","of","or","and","pass",
      "private","public","raise","readonly","return","static","struct","super","switch",
      "template","then","this","throw","trait","try","type","typeof","union","use","using",
      "var","virtual","void","where","while","with","yield","fn","impl","pub","crate","move",
      "self","Self","end","begin","rescue","ensure","unless","until","print","printf"
    ],
    literal: [
      "true","false","null","nil","None","True","False","NaN","Infinity","undefined",
      "int","str","float","bool","list","dict","set","tuple","string","number","boolean",
      "object","array","char","double","long","short","unsigned","signed","usize","i32",
      "i64","u32","u64","f32","f64","vec","map","Promise","Optional","Any","void"
    ]
  };

  const KW_SET = new Set(GRAMMAR.keyword);
  const LIT_SET = new Set(GRAMMAR.literal);

  // one master pattern; order matters (comments → strings → words → numbers → punctuation)
  const MASTER = new RegExp(
    [
      "(?<com>" + GRAMMAR.comment.map((r) => r.source).join("|") + ")",
      "(?<str>" + GRAMMAR.string.map((r) => r.source).join("|") + ")",
      "(?<word>[A-Za-z_$][A-Za-z0-9_$]*)",
      "(?<num>\\b0[xXoObB][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b)",
      "(?<pun>[{}\\[\\]();,.:=+\\-*/%<>!&|?~^@#])"
    ].join("|"),
    "g"
  );

  const ALIAS = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    javascript: "javascript", typescript: "javascript", node: "javascript",
    py: "python", python: "python", python3: "python", py3: "python",
    sh: "bash", shell: "bash", zsh: "bash", bash: "bash", console: "bash",
    yml: "yaml", yaml: "yaml", json: "json", jsonc: "json",
    html: "html", xml: "html", svg: "html", vue: "html",
    css: "css", scss: "css", less: "css",
    sql: "sql", md: "markdown", markdown: "markdown",
    rb: "ruby", ruby: "ruby", go: "go", golang: "go",
    rs: "rust", rust: "rust", java: "java", kotlin: "kotlin", kt: "kotlin",
    c: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", php: "c",
    swift: "c", dart: "javascript", lua: "lua", r: "c", toml: "yaml",
    ini: "yaml", dockerfile: "bash", makefile: "bash", text: "", txt: "", plain: ""
  };

  /** Highlight an already-plain code string. Returns escaped HTML. */
  function highlight(code, lang) {
    const key = ALIAS[(lang || "").toLowerCase().trim()] ?? null;
    if (key === null || key === "") return esc(code);       // unknown/plain

    let out = "";
    let last = 0;
    MASTER.lastIndex = 0;
    let m;
    while ((m = MASTER.exec(code)) !== null) {
      if (m.index > last) out += esc(code.slice(last, m.index));
      const g = m.groups;
      if (g.com !== undefined) {
        out += '<span class="tk-com">' + esc(m[0]) + "</span>";
      } else if (g.str !== undefined) {
        out += '<span class="tk-str">' + esc(m[0]) + "</span>";
      } else if (g.word !== undefined) {
        const w = m[0];
        const after = code.slice(m.index + w.length).match(/^\s*\(/);
        if (KW_SET.has(w)) out += '<span class="tk-kw">' + esc(w) + "</span>";
        else if (LIT_SET.has(w)) out += '<span class="tk-typ">' + esc(w) + "</span>";
        else if (after) out += '<span class="tk-fn">' + esc(w) + "</span>";
        else if (/^[A-Z][A-Za-z0-9_]*$/.test(w) && w.length > 2) out += '<span class="tk-typ">' + esc(w) + "</span>";
        else out += esc(w);
      } else if (g.num !== undefined) {
        out += '<span class="tk-num">' + esc(m[0]) + "</span>";
      } else {
        out += '<span class="tk-pun">' + esc(m[0]) + "</span>";
      }
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Inline markdown                                                    */
  /* ------------------------------------------------------------------ */
  const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;
  const safeUrl = (u) => {
    const t = String(u || "").trim().replace(/[\u0000-\u001f]/g, "");
    return SAFE_URL.test(t) ? t : "#";
  };

  /** Inline pass — input is RAW text; output is HTML with everything escaped. */
  function inline(raw) {
    if (!raw) return "";
    const codes = [];
    // 1. protect inline code
    let s = String(raw).replace(/`+([^`]+?)`+/g, (_, c) => {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    // 2. clean common LaTeX into readable glyphs, then escape everything
    s = esc(deLatex(s));
    // 3. images  ![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      (_, alt, src) => '<img src="' + safeUrl(unescapeAmp(src)) + '" alt="' + alt + '" loading="lazy" decoding="async">');
    // 4. links [text](href)
    s = s.replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      (_, txt, href) => '<a href="' + safeUrl(unescapeAmp(href)) + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>");
    // 5. autolinks (skip ones already inside an href/attribute)
    s = s.replace(/(^|[\s(>])((?:https?:\/\/)[^\s<)"']+[^\s<)."',;:!?])/g,
      (_, pre, url) => pre + '<a href="' + safeUrl(unescapeAmp(url)) + '" target="_blank" rel="noopener noreferrer">' + url.replace(/&amp;$/, "") + "</a>");
    // 6. bold / italic / strike
    s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/___([^_]+?)___/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    s = s.replace(/==([^=]+?)==/g, "<mark>$1</mark>");
    // 7. hard break
    s = s.replace(/ {2,}\n/g, "<br>\n");
    // 8. restore inline code
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => "<code>" + esc(codes[+i]) + "</code>");
    return s;
  }
  const unescapeAmp = (s) => String(s).replace(/&amp;/g, "&");

  /* Common LaTeX commands → clean glyphs, so maths reads as text, not noise. */
  const LATEX = {
    "\\to": "→", "\\rightarrow": "→", "\\leftarrow": "←", "\\Rightarrow": "⇒",
    "\\times": "×", "\\div": "÷", "\\pm": "±", "\\mp": "∓", "\\cdot": "·",
    "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠",
    "\\approx": "≈", "\\equiv": "≡", "\\sim": "∼", "\\propto": "∝",
    "\\infty": "∞", "\\partial": "∂", "\\nabla": "∇", "\\sum": "∑", "\\prod": "∏",
    "\\int": "∫", "\\sqrt": "√", "\\pi": "π", "\\theta": "θ", "\\alpha": "α",
    "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\lambda": "λ", "\\mu": "μ",
    "\\sigma": "σ", "\\omega": "ω", "\\phi": "φ", "\\psi": "ψ", "\\Delta": "Δ",
    "\\Omega": "Ω", "\\Sigma": "Σ", "\\deg": "°", "\\angle": "∠",
    "\\%": "%", "\\$": "$", "\\&": "&", "\\_": "_", "\\#": "#", "@": "@"
  };
  const MATHY = /[→←⇒×÷±≤≥≠≈∞∂∇∑∏∫√πθαβγδλμσωφψΔΩΣ°∠^_²³¹]/;
  const SUP = { "^0": "⁰", "^1": "¹", "^2": "²", "^3": "³", "^4": "⁴", "^5": "⁵", "^6": "⁶", "^7": "⁷", "^8": "⁸", "^9": "⁹" };
  const deLatex = (s) => s
    .replace(/\\[A-Za-z]+/g, (m) => (m in LATEX ? LATEX[m] : m))          // \to \leq …
    .replace(/\\([%$&_#])/g, (_, c) => c)                                  // \% \$ \& \_ \#
    .replace(/\^(\d)/g, (m, d) => SUP[m] || m)                             // x^2 → x²
    // unwrap inline-math dollars once their content is plain glyphs:  $→$  →  →
    .replace(/\$([^$\n]{1,32}?)\$/g, (m, inner) => (MATHY.test(inner) ? inner : m));

  /* ------------------------------------------------------------------ */
  /*  Block parsing                                                      */
  /* ------------------------------------------------------------------ */
  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+\-.#]*)\s*$/;
  const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
  const UL = /^(\s*)([-*+])\s+(.*)$/;
  const OL = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith("|")) l = l.slice(1);
    if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
    return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }
  const alignOf = (c) => {
    const l = c.startsWith(":"), r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  };

  /** Nested list builder — takes [indent, marker, text] tuples. */
  function buildList(items, start) {
    let i = 0;
    function level(indent) {
      const ordered = items[i] && items[i][1] === "ol";
      let html = ordered ? '<ol start="' + (start || 1) + '">' : "<ul>";
      while (i < items.length && items[i][0] >= indent) {
        const cur = items[i][0];
        if (cur > indent) { html += level(cur); continue; }
        let text = items[i][2];
        i++;
        // gather continuation / loose lines belonging to this item
        while (i < items.length && items[i][0] > cur) { text += "\n" + items[i][2]; i++; }
        let cls = "", pre = "";
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) {
          cls = ' class="task"';
          pre = '<input type="checkbox" disabled' + (task[1].toLowerCase() === "x" ? " checked" : "") + "> ";
          text = task[2];
        }
        html += "<li" + cls + ">" + pre + (text.includes("\n") ? block(text) : inline(text)) + "</li>";
      }
      html += ordered ? "</ol>" : "</ul>";
      return html;
    }
    return level(items.length ? items[0][0] : 0);
  }

  /** Full block renderer. */
  function block(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let out = "";
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      /* fenced code */
      const f = FENCE.exec(line);
      if (f) {
        const fence = f[1][0], len = f[1].length, lang = f[2] || "";
        const body = [];
        i++;
        while (i < lines.length) {
          const c = lines[i];
          if (c.trim().startsWith(fence.repeat(len)) && !c.trim().slice(len).trim()) { i++; break; }
          body.push(c); i++;
        }
        const code = body.join("\n");
        const label = (lang || "text").toLowerCase();
        out +=
          '<div class="code"><div class="code__bar">' +
          '<span class="code__dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<span class="code__lang">' + esc(label) + "</span>" +
          '<button class="act code__copy" type="button" data-copy-code aria-label="Copy code">' +
          '<svg aria-hidden="true"><use href="#i-copy"/></svg><span>Copy</span></button></div>' +
          "<pre><code" + (lang ? ' class="language-' + esc(lang) + '"' : "") + ' data-raw="' + esc(code) + '">' +
          highlight(code, label) + "</code></pre></div>";
        continue;
      }

      /* heading */
      const h = HEAD.exec(line);
      if (h) {
        const lvl = h[1].length;
        const txt = h[2].trim();
        const id = txt.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
        out += "<h" + lvl + (id ? ' id="' + esc(id) + '"' : "") + ">" + inline(txt) + "</h" + lvl + ">";
        i++; continue;
      }

      /* hr */
      if (HR.test(line)) { out += "<hr>"; i++; continue; }

      /* blockquote */
      if (QUOTE.test(line)) {
        const q = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && q.length && !UL.test(lines[i]) && !OL.test(lines[i])))) {
          const m = QUOTE.exec(lines[i]);
          q.push(m ? m[1] : lines[i]);
          i++;
        }
        out += "<blockquote>" + block(q.join("\n")) + "</blockquote>";
        continue;
      }

      /* table */
      if (line.includes("|") && i + 1 < lines.length && TSEP.test(lines[i + 1])) {
        const headCells = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(alignOf);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        let t = '<div class="table-scroll"><table><thead><tr>';
        headCells.forEach((c, k) => {
          t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(c) + "</th>";
        });
        t += "</tr></thead><tbody>";
        rows.forEach((r) => {
          t += "<tr>";
          headCells.forEach((_, k) => {
            t += "<td" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(r[k] ?? "") + "</td>";
          });
          t += "</tr>";
        });
        out += t + "</tbody></table></div>";
        continue;
      }

      /* lists */
      if (UL.test(line) || OL.test(line)) {
        const items = [];
        let startNum = 1;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {                                  // blank: peek for list continuation
            const nxt = lines[i + 1] || "";
            if (UL.test(nxt) || OL.test(nxt) || /^\s{2,}\S/.test(nxt)) { i++; continue; }
            break;
          }
          const u = UL.exec(l), o = OL.exec(l);
          if (u) {
            items.push([u[1].replace(/\t/g, "  ").length, "ul", u[3]]);
            i++;
          } else if (o) {
            if (items.length === 0) startNum = parseInt(o[2], 10) || 1;
            items.push([o[1].replace(/\t/g, "  ").length, "ol", o[4]]);
            i++;
          } else if (/^\s{2,}\S/.test(l) && items.length) { // wrapped line
            items[items.length - 1][2] += " " + l.trim();
            i++;
          } else break;
        }
        if (items.length) { out += buildList(items, startNum); continue; }
      }

      /* paragraph */
      const para = [];
      while (i < lines.length && lines[i].trim() &&
             !FENCE.test(lines[i]) && !HEAD.test(lines[i]) && !HR.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out += "<p>" + inline(para.join("\n")) + "</p>";
      else i++;                                              // safety
    }
    return out;
  }

  /** Render markdown → safe HTML. */
  function render(src) {
    return block(String(src ?? ""));
  }

  /** Plain text of rendered markdown (for copy / share). */
  function toText(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    d.querySelectorAll("pre").forEach((p) => { p.textContent = (p.textContent || "") + "\n"; });
    return (d.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  global.MD = { render, inline, highlight, toText, escape: esc };
})(window);
