// 화면 테스트 (가짜 AI): 서버 함수를 띄우고 Edge/Chrome을 화면 없이 조작한다. 실제 Gemini는 부르지 않는다.
// 실행: node tests/browser-ai.test.js
const http = require("http"), fs = require("fs"), path = require("path");
const { startBrowser, sleep, SHOT_DIR } = require("./browser.js");
const ROOT = path.join(__dirname, "..");
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_FALLBACK_MODEL;
process.env.GEMINI_API_KEY = "fake-key-for-test";
const handler = require(path.join(ROOT, "api/recommend.js"));
const realFetch = global.fetch; let round = 0; const received = []; let onlyOne = false; let aiMode = "";
global.fetch = async (url, opts) => {
  if (!String(url).includes("generativelanguage")) return realFetch(url, opts);
  if (aiMode === "503") return { ok: false, status: 503, json: async () => ({}) };
  if (aiMode === "slow") await new Promise((r) => setTimeout(r, 7000)); // 7초 걸리는 AI
  if (aiMode === "allOld") { // 이미 나온 메뉴만 다시 냄 = 정상 응답, 새 메뉴 0개
    const old = received.at(-1).exclude.map((n) => ({ name: n, time_min: 10, ingredients: ["단호박"], missing: [], steps: ["a"] }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ menus: old }) }] } }] }) };
  }
  round++;
  const menus = [1, 2, 3].map((i) => ({
    name: i === 1 && round === 1 ? '<img src=x onerror="window.__xss=1">' : `AI메뉴${round}-${i}`,
    time_min: 10, ingredients: ["밥"], missing: ["대파"], steps: ["a", "b", "c"],
  }));
  const out = onlyOne ? menus.slice(0, 1) : menus; // AI가 새 메뉴를 1개만 찾은 상황
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ menus: out }) }] } }] }) };
};
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/recommend")) {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      req.body = JSON.parse(b || "null"); received.push(req.body);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (d) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(d)); };
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
}).listen(5173);

const browser = startBrowser(9333);

(async () => {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = await (await realFetch("http://127.0.0.1:9333/json/new?http://localhost:5173/", { method: "PUT" })).json(); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; } };
  const send = (method, params = {}) => new Promise((r) => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const m = await send("Runtime.evaluate", { expression: `(async()=>{${helpers}${expr}})()`, awaitPromise: true, returnByValue: true });
    if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result.result.value;
  };
  let fails = 0;
  const check = (l, ok, info = "") => { console.log((ok ? "PASS " : "FAIL ") + l, info); if (!ok) fails++; };
  const helpers = `const $=id=>document.getElementById(id);
    const chip=t=>[...document.querySelectorAll('#ingredientChips .chip')].find(c=>c.textContent===t);
    const wait=async f=>{for(let i=0;i<100;i++){if(f())return true;await new Promise(r=>setTimeout(r,50));}return false;};
    const settle=async()=>{await new Promise(r=>setTimeout(r,100));await wait(()=>!$('recommendBtn').disabled);};`;
  await sleep(1500);

  check("빈 재료 → 안내 문구", (await ev(`$('recommendBtn').click(); return $('message').textContent;`)).includes("재료를 하나 이상"));

  const r1 = await ev(`chip('밥').click(); chip('김치').click(); $('recommendBtn').click();
    const loading = $('recommendBtn').disabled && $('againBtn').disabled && $('recommendBtn').textContent.includes('추천 중');
    await wait(()=>!$('resultArea').hidden && !$('recommendBtn').disabled);
    return { loading, cards: document.querySelectorAll('#results .card').length,
      badges: [...document.querySelectorAll('#results .badge')].map(b=>b.textContent),
      notice: !$('aiNotice').hidden, safety: document.querySelectorAll('#results .safety').length,
      imgs: document.querySelectorAll('#results img').length,
      title: document.querySelector('#results h3').textContent, xss: !!window.__xss };`);
  check("로딩 중 버튼 비활성화·문구", r1.loading);
  check("카드 3개 + AI 추천 배지", r1.cards === 3 && r1.badges.every((b) => b.includes("AI 추천")), r1.badges.join("/"));
  check("AI 안내 + 카드별 안전 문구", r1.notice && r1.safety === 3);
  check("위험 코드가 글자로만 표시(실행 안 됨)", r1.imgs === 0 && !r1.xss && r1.title.startsWith("<img"));

  const r2 = await ev(`$('againBtn').click(); await settle(); return [...document.querySelectorAll('#results h3')].map(h=>h.textContent);`);
  check("다시 추천 → 새 메뉴", r2.every((n) => n.startsWith("AI메뉴2")), r2.join(","));
  // 1회차 첫 메뉴는 37자짜리 위험 코드 이름이라 서버 제한(30자) 때문에 exclude에서 빠지는 게 정상
  check("다시 추천 요청에 이전 메뉴 exclude (30자 초과 이름은 제외)",
    JSON.stringify(received.at(-1).exclude) === JSON.stringify(["AI메뉴1-2", "AI메뉴1-3"]), JSON.stringify(received.at(-1).exclude));
  await ev(`$('againBtn').click(); await settle();`);
  check("세 번째 추천은 exclude 누적 (2+3=5개)", received.at(-1).exclude.length === 5);
  await ev(`$('recommendBtn').click(); await settle();`);
  check("새로 추천받기는 exclude 초기화", received.at(-1).exclude.length === 0);

  onlyOne = true;
  const one = await ev(`chip('대파').click(); $('againBtn').click(); await settle();
    return { cards: document.querySelectorAll('#results .card').length, badge: document.querySelector('#results .badge').textContent, msg: $('message').textContent, notice: !$('aiNotice').hidden };`);
  check("AI 새 메뉴 1개 → 카드 1개, AI 배지, 개수 안내", one.cards === 1 && one.badge.includes("AI 추천") && one.msg.includes("AI가 새로 찾은 메뉴는 1개예요") && one.notice, one.msg);
  onlyOne = false;
  await ev(`$('recommendBtn').click(); await settle();`);
  const pumpkin = await ev(`[...document.querySelectorAll('#ingredientChips .chip.on')].forEach(c=>c.click());
    $('customInput').value='단호박'; $('addForm').requestSubmit(); $('recommendBtn').click(); await settle();
    return document.querySelectorAll('#results .card').length;`);
  aiMode = "allOld";
  const noNew = await ev(`$('againBtn').click(); await settle(); return { msg: $('message').textContent, cards: document.querySelectorAll('#results .card').length };`);
  check("AI 정상·새 메뉴 0개 → '더 추천할 새 메뉴를 못 찾았어요' + 직전 카드 유지", pumpkin === 3 && noNew.msg.includes("더 추천할 새 메뉴를 못 찾았어요") && noNew.cards === 3, noNew.msg);
  aiMode = "503";
  const busy = await ev(`chip('단호박').click(); chip('단호박').click(); $('againBtn').click(); await settle(); return $('message').textContent;`);
  check("AI 503(못 씀) → 'AI가 지금 바빠서' 문구", busy.includes("AI가 지금 바빠서 새 메뉴를 가져오지 못했어요"), busy);
  aiMode = "";
  await ev(`[...document.querySelectorAll('#ingredientChips .chip.on')].forEach(c=>c.click()); chip('밥').click(); chip('김치').click(); $('recommendBtn').click(); await settle();`);
  aiMode = "slow";
  const slow = await ev(`chip('당근').click(); $('recommendBtn').click(); const label = () => $('recommendBtn').textContent;
    await new Promise(r=>setTimeout(r,1000)); const at1 = label();
    await new Promise(r=>setTimeout(r,5800)); const at7 = label(); const disabled7 = $('recommendBtn').disabled && $('againBtn').disabled;
    await settle(); return { at1, at7, disabled7, after: label(), disabledAfter: $('recommendBtn').disabled };`);
  check("6초 전 로딩 문구는 '추천 중이에요'", slow.at1.includes("추천 중이에요"), slow.at1);
  check("6초 뒤 '열심히 찾는 중' 문구 + 버튼 계속 비활성", slow.at7.includes("AI가 열심히 찾는 중이에요… (최대 15초 걸릴 수 있어요)") && slow.disabled7, slow.at7);
  check("응답 오면 '추천받기'로 복귀, 버튼 활성", slow.after.endsWith("추천받기") && !slow.disabledAfter, slow.after);
  aiMode = "503";
  const fb = await ev(`chip('대파').click(); chip('달걀').click(); $('recommendBtn').click(); await settle();
    return { fb: !$('fallbackNotice').hidden, ai: !$('aiNotice').hidden, badges: [...document.querySelectorAll('#results .badge')].map(b=>b.textContent), text: $('fallbackNotice').textContent };`);
  check("AI 503 → 기본 레시피 + '지금은 AI가 바빠서' 안내, AI 안내 숨김", fb.fb && !fb.ai && fb.badges.length > 0 && fb.badges.every(b => b.includes("기본 레시피")) && fb.text.includes("지금은 AI가 바빠서 기본 레시피로 보여드려요"), fb.badges.length + "개");
  aiMode = "";
  const aiAgain = await ev(`chip('양파').click(); $('recommendBtn').click(); await settle(); return { fb: !$('fallbackNotice').hidden, ai: !$('aiNotice').hidden };`);
  check("AI 추천 결과에는 기본 레시피 안내 없음", !aiAgain.fb && aiAgain.ai);
  const fav = await ev(`document.querySelector('#results .star').click();
    return { ls: JSON.parse(localStorage.getItem('menuFavorites')).length, star: document.querySelector('#results .star').textContent };`);
  check("☆ 클릭 → localStorage 저장", fav.ls === 1 && fav.star === "★");
  await send("Page.reload"); await sleep(1500);
  const fav2 = await ev(`$('favToggle').click(); return { btn: $('favToggle').textContent, cards: document.querySelectorAll('#favList .card').length };`);
  check("새로고침 후에도 즐겨찾기 유지·목록 표시", fav2.cards === 1 && fav2.btn.includes("(1)"), fav2.btn);
  const fav3 = await ev(`document.querySelector('#favList .star').click();
    return { cards: document.querySelectorAll('#favList .card').length, empty: !!document.querySelector('#favList .empty') };`);
  check("목록에서 해제", fav3.cards === 0 && fav3.empty);

  const lsBlocked = await ev(`Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});
    chip('밥').click(); $('recommendBtn').click(); await wait(()=>!$('resultArea').hidden && !$('recommendBtn').disabled);
    document.querySelector('#results .star').click();
    return { star: document.querySelector('#results .star').textContent, msg: $('message').textContent };`);
  check("localStorage 막혀도 앱 동작", lsBlocked.star === "★" && lsBlocked.msg.includes("저장할 수 없어요"), lsBlocked.msg);

  const net = await ev(`window.fetch = () => Promise.reject(new TypeError('offline')); chip('달걀').click(); $('recommendBtn').click();
    await settle();
    return { msg: $('message').textContent, badges: [...document.querySelectorAll('#results .badge')].map(b=>b.textContent), notice: !$('aiNotice').hidden };`);
  check("네트워크 오류(offline) → '바빠서' 안내는 안 나옴", await ev(`return $('fallbackNotice').hidden;`));
  check("네트워크 오류 → 안내 + 기본 레시피", net.msg.includes("서버에 연결하지 못했어요") && net.badges.every((b) => b.includes("기본 레시피")) && !net.notice, net.badges.join("/"));

  const lim = await ev(`[...document.querySelectorAll('#ingredientChips .chip')].forEach(c=>{ if(!c.classList.contains('on')) c.click(); });
    return { on: document.querySelectorAll('#ingredientChips .chip.on').length, msg: $('message').textContent };`);
  check("재료 15개 제한", lim.on === 15 && lim.msg.includes("15개"), `선택 ${lim.on}개`);

  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true }); await sleep(500);
  const mob = await ev(`return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    cols: getComputedStyle(document.getElementById('results')).gridTemplateColumns.split(' ').length };`);
  check("모바일(375px) 가로 넘침 없음, 카드 1열", mob.sw <= mob.cw && mob.cols === 1, JSON.stringify(mob));
  const shot = await send("Page.captureScreenshot", { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 375, height: 2200, scale: 1 } });
  fs.writeFileSync(SHOT_DIR + "/mobile.png", Buffer.from(shot.result.data, "base64"));

  console.log(fails === 0 ? "=> 모든 화면 테스트 통과" : `=> 실패 ${fails}건`);
  ws.close(); await browser.stop(); server.close(); process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await browser.stop(); process.exit(1); });
