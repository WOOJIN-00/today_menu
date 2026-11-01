// Plan.md 9번 테스트 계획 점검 (API 키가 없는 실제 서버 경로 + Edge/Chrome 화면)
// 실행: node tests/plan9.test.js
const http = require("http"), fs = require("fs"), path = require("path");
const { startBrowser, sleep, SHOT_DIR } = require("./browser.js");
const ROOT = path.join(__dirname, "..");
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_FALLBACK_MODEL;
delete process.env.GEMINI_API_KEY; // 5번: 키가 없는 상태
const handler = require(path.join(ROOT, "api/recommend.js"));
const responses = [];

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/recommend")) {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      req.body = JSON.parse(b || "null");
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (d) => { responses.push(d); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(d)); };
      handler(req, res);
    });
    return;
  }
  const f = path.join(ROOT, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", f.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
    res.end(d);
  });
}).listen(5174);

const browser = startBrowser(9334);

(async () => {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = await (await fetch("http://127.0.0.1:9334/json/new?http://localhost:5174/", { method: "PUT" })).json(); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; } };
  const send = (method, params = {}) => new Promise((r) => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const helpers = `const $=id=>document.getElementById(id);
    const chip=t=>[...document.querySelectorAll('#ingredientChips .chip')].find(c=>c.textContent===t);
    const wait=async f=>{for(let i=0;i<100;i++){if(f())return true;await new Promise(r=>setTimeout(r,50));}return false;};
    const run=async(btn)=>{$(btn).click();await new Promise(r=>setTimeout(r,100));await wait(()=>!$('recommendBtn').disabled);};
    const cards=()=>[...document.querySelectorAll('#results .card')].map(c=>({name:c.querySelector('h3').textContent,badge:c.querySelector('.badge').textContent,missing:c.querySelector('.missing').textContent}));`;
  const ev = async (expr) => {
    const m = await send("Runtime.evaluate", { expression: `(async()=>{${helpers}${expr}})()`, awaitPromise: true, returnByValue: true });
    if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result.result.value;
  };
  let fails = 0;
  const check = (l, ok, info = "") => { console.log((ok ? "PASS " : "FAIL ") + l, info); if (!ok) fails++; };
  await sleep(1500);

  // 1) 밥·달걀·김치
  const t1 = await ev(`chip('밥').click(); chip('달걀').click(); chip('김치').click(); await run('recommendBtn'); return { cards: cards(), msg: $('message').textContent };`);
  check("1) 밥·달걀·김치 → 메뉴 3개", t1.cards.length === 3, t1.cards.map((c) => c.name + "(" + c.missing + ")").join(" | "));

  // 2) 아보카도(직접 입력)·우동면
  const t2 = await ev(`$('clearBtn').click(); $('customInput').value='아보카도'; $('addForm').requestSubmit(); chip('우동면').click();
    await run('recommendBtn'); return { cards: cards(), msg: $('message').textContent, sent: null };`);
  check("2) 아보카도·우동면 → 우동면 메뉴 2개만 + 개수 안내 (무관 메뉴 없음)", t2.cards.length === 2 && t2.msg.includes("기본 레시피는 2개예요"),
    t2.cards.map((c) => c.name).join(", ") + " / 안내: " + t2.msg);

  // 3) 다시 추천 반복 여부: 밥·달걀·김치로 6번(18개)
  const t3 = await ev(`$('clearBtn').click(); chip('밥').click(); chip('달걀').click(); chip('김치').click();
    await run('recommendBtn'); const all=[...cards().map(c=>c.name)];
    for(let i=0;i<5;i++){ await run('againBtn'); all.push(...cards().map(c=>c.name)); }
    return all;`);
  check("3) 다시 추천 6번(18개) 메뉴 반복 없음", new Set(t3).size === t3.length, `${new Set(t3).size}/${t3.length}개 서로 다름`);
  const t3b = await ev(`for(let i=0;i<10;i++){ await run('againBtn'); } return { msg: $('message').textContent, cards: cards().length };`);
  check("3) 겹치는 메뉴를 다 쓰면(키 없음=AI 못 씀) 바쁨 안내 + 직전 카드는 그대로", t3b.msg.includes("AI가 지금 바빠서") && t3b.cards > 0, t3b.msg);
  const t3c = await ev(`$('clearBtn').click(); $('customInput').value='단호박'; $('addForm').requestSubmit(); await run('recommendBtn');
    return { msg: $('message').textContent, hidden: $('resultArea').hidden };`);
  check("3) 단호박만 첫 추천(키 없음) → 예전 결과 숨기고 바쁨 안내", t3c.hidden && t3c.msg.includes("AI가 지금 바빠서"), t3c.msg);
  await ev(`$('clearBtn').click();`);

  // 4) 재료 비움
  const t4 = await ev(`$('clearBtn').click(); $('recommendBtn').click(); return $('message').textContent;`);
  check("4) 재료 비우고 추천 → 안내 문구", t4.includes("재료를 하나 이상"), t4);

  // 5) 키 없음 → 기본 레시피 자동 전환
  const t5 = await ev(`chip('두부').click(); await run('recommendBtn'); return { cards: cards(), notice: !$('aiNotice').hidden, msg: $('message').textContent };`);
  const last = responses.at(-1);
  check("5) 키 없음 → 서버가 fallback/no_key 응답", last.source === "fallback" && last.reason === "no_key");
  check("5) 화면에 '기본 레시피' 배지, AI 안내 숨김, 오류 문구 없음",
    t5.cards.every((c) => c.badge.includes("기본 레시피")) && !t5.notice && !t5.msg.includes("연결하지 못했어요"), t5.cards.map((c) => c.badge).join("/"));

  check("5) 키 없음(no_key) → '지금은 AI가 바빠서' 안내 안 나옴", await ev(`return $('fallbackNotice').hidden;`));

  // 6) 모바일 레이아웃 (작은 폰 320px, 일반 폰 390px) - 즐겨찾기 목록까지 연 상태
  await ev(`document.querySelector('#results .star').click(); $('favToggle').click(); $('customInput').value='아주긴재료이름열다섯글자까지'; $('addForm').requestSubmit();`);
  // 안내 문구·긴 로딩 문구를 모두 켠 상태에서 확인
  await ev(`$('aiNotice').hidden=false; $('fallbackNotice').hidden=false;
    document.querySelectorAll('#results .card').forEach(c=>{ const p=document.createElement('p'); p.className='safety'; p.textContent='⚠️ AI 추천이므로 조리 전 재료와 익힘 정도를 확인하세요.'; c.appendChild(p); });
    $('recommendBtn').lastChild.textContent='AI가 열심히 찾는 중이에요… (최대 15초 걸릴 수 있어요)';
    $('message').textContent='AI가 새로 찾은 메뉴는 1개예요. 재료를 더 추가하면 더 다양하게 추천받을 수 있어요.';`);
  const favHint = await ev(`return !$('favorites').hidden && document.querySelector('#favorites .fav-hint').textContent;`);
  check("즐겨찾기 목록에 '이 브라우저에만 저장돼요' 안내", String(favHint).includes("이 브라우저에만 저장돼요"), favHint);
  for (const w of [320, 375, 390]) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await sleep(500);
    const m = await ev(`const over=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+1).map(e=>e.tagName+'.'+e.className);
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, over: over.slice(0,5),
        cols: getComputedStyle($('results')).gridTemplateColumns.split(' ').length };`);
    check(`6) 모바일 ${w}px 가로 넘침 없음, 카드 1열`, m.sw <= m.cw && m.over.length === 0 && m.cols === 1, JSON.stringify(m));
    // 제목·즐겨찾기 버튼이 양옆 여백(16px) 안에 있는지 (즐겨찾기 두 자리 수 기준)
    const head = await ev(`const old=$('favToggle').textContent; $('favToggle').textContent='⭐ 즐겨찾기 (12)';
      const b=$('favToggle').getBoundingClientRect(), h=document.querySelector('h1').getBoundingClientRect(), cw=document.documentElement.clientWidth;
      const r={ btnRight: Math.round(b.right), limit: cw-16, h1Lines: Math.round(h.height/parseFloat(getComputedStyle(document.querySelector('h1')).lineHeight)), overlap: h.right > b.left && h.top < b.bottom && b.top < h.bottom };
      $('favToggle').textContent=old; return r;`);
    check(`6) 모바일 ${w}px 제목 한 줄, 즐겨찾기 버튼이 여백 안, 겹침 없음`, head.btnRight <= head.limit && head.h1Lines === 1 && !head.overlap, JSON.stringify(head));
    if (w !== 390) {
      const top = await ev(`return Math.round($('recommendBtn').getBoundingClientRect().top + scrollY) - 60;`);
      const shot = await send("Page.captureScreenshot", { clip: { x: 0, y: top, width: w, height: 1100, scale: 1 }, captureBeyondViewport: true });
      fs.writeFileSync(SHOT_DIR + "/mobile" + w + ".png", Buffer.from(shot.result.data, "base64"));
      const head = await send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: w, height: 700, scale: 1 }, captureBeyondViewport: true });
      fs.writeFileSync(SHOT_DIR + "/mobile" + w + "-top.png", Buffer.from(head.result.data, "base64"));
    }
  }

  console.log(fails === 0 ? "=> Plan.md 9번 점검 전부 통과" : `=> 실패 ${fails}건`);
  ws.close(); await browser.stop(); server.close(); process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await browser.stop(); process.exit(1); });
