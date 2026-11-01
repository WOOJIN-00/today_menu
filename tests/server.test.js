// 서버 함수 테스트: 실제 Gemini를 부르지 않고 가짜 응답으로 확인한다. (API 키 불필요)
// 실행: node tests/server.test.js
const path = require("path");
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_FALLBACK_MODEL;
const handler = require(path.join(__dirname, "..", "api", "recommend.js"));
function call(body, { method = "POST", ip = "1.1.1.1" } = {}) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, data: d }); } };
    handler({ method, body, headers: { "x-forwarded-for": ip } }, res);
  });
}
const good = { menus: [1,2,3].map(i => ({ name: "AI메뉴"+i, time_min: 10, ingredients: ["밥"], missing: [], steps: ["a","b","c"] })) };
const reply = (obj, status = 200) => async () => ({ ok: status === 200, status,
  json: async () => ({ candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] }) });
(async () => {
  let fails = 0;
  const check = (label, ok, extraInfo = "") => { console.log((ok ? "PASS " : "FAIL ") + label, extraInfo); if (!ok) fails++; };
  const names = (r) => (r.data.menus || []).map((m) => m.name).join(",");

  // ===== 기본 동작: 키 없음, 입력 검사, AI 성공, 재시도, 429, 오류, 횟수 제한 =====
  delete process.env.GEMINI_API_KEY;
  let r0 = await call({ ingredients: ["밥","계란","김치"], mood: "" });
  check("0-a 키 없음 → 기본 레시피 3개 (no_key)", r0.status === 200 && r0.data.source === "fallback" && r0.data.reason === "no_key" && r0.data.menus.length === 3, names(r0));
  r0 = await call(null, { method: "GET" });
  check("0-b GET 요청 → 405", r0.status === 405);
  const badInputs = [
    ["재료 비어있음", { ingredients: [] }],
    ["재료 16개", { ingredients: Array.from({ length: 16 }, (_, i) => "재료" + i) }],
    ["21자 재료", { ingredients: ["가".repeat(21)] }],
    ["이상한 기분", { ingredients: ["밥"], mood: "해킹" }],
    ["문자열 아닌 재료", { ingredients: [123] }],
    ["제외 메뉴 61개", { ingredients: ["밥"], exclude: Array.from({ length: 61 }, (_, i) => "메뉴" + i) }],
  ];
  for (const [label, body] of badInputs) check("0-c " + label + " → 400", (await call(body)).status === 400);

  process.env.GEMINI_API_KEY = "fake-key-for-test";
  let calls = 0, sentKeyInUrl = false;
  global.fetch = async (url, opts) => { calls++; if (url.includes("fake-key-for-test")) sentKeyInUrl = true; return reply(good)(); };
  r0 = await call({ ingredients: ["밥"], mood: "매콤" });
  check("0-d AI 성공 → source ai, 메뉴 3개", r0.data.source === "ai" && r0.data.menus.length === 3, names(r0));
  r0 = await call({ ingredients: [" 밥 "], mood: "매콤" });
  check("0-e 같은 조합 → 캐시, AI 추가 호출 없음", r0.data.cached === true && calls === 1);
  check("0-f 요청 주소에 키가 들어가지 않음", !sentKeyInUrl);
  let n = 0; global.fetch = async () => (++n === 1 ? reply("깨진{json")() : reply(good)());
  r0 = await call({ ingredients: ["떡"] });
  check("0-g 1회 실패 → 재시도 성공", r0.data.source === "ai" && n === 2);
  global.fetch = reply({ menus: good.menus.slice(0, 2) });
  r0 = await call({ ingredients: ["감자"] });
  check("0-h 메뉴 2개만 와도 AI 추천 (partial)", r0.data.source === "ai" && r0.data.menus.length === 2 && r0.data.partial === true);
  n = 0; global.fetch = async () => { n++; return reply({}, 429)(); };
  r0 = await call({ ingredients: ["두부"] });
  check("0-i 429 → 재시도 없이 기본 레시피 (ai_quota)", r0.data.source === "fallback" && r0.data.reason === "ai_quota" && n === 1, names(r0));
  global.fetch = async () => { throw new Error("network down"); };
  r0 = await call({ ingredients: ["양파"] });
  check("0-j 네트워크 오류 → 기본 레시피 (ai_error)", r0.data.source === "fallback" && r0.data.reason === "ai_error", names(r0));
  global.fetch = reply({ menus: [{ ...good.menus[0], name: "김치볶음밥" }, good.menus[1], good.menus[2]] });
  r0 = await call({ ingredients: ["김치"], exclude: ["김치볶음밥"] });
  check("0-k 제외 메뉴만 버리고 나머지는 AI 추천", r0.data.source === "ai" && r0.data.menus.length === 2 && !names(r0).includes("김치볶음밥"), names(r0));
  global.fetch = reply(good);
  let last; for (let i = 0; i < 21; i++) last = await call({ ingredients: ["재료" + i, "밥"] }, { ip: "9.9.9.9" });
  check("0-l 같은 IP 21번째 요청 → 기본 레시피 (daily_limit)", last.data.source === "fallback" && last.data.reason === "daily_limit", names(last));

  // ===== 캐시 키 정규화 케이스 =====
  let aiCalls = 0, lastPrompt = "";
  global.fetch = async (url, opts) => { aiCalls++; lastPrompt = JSON.parse(opts.body).contents[0].parts[0].text; return reply(good)(); };

  // 1) 순서만 다른 재료 → 캐시 적중
  let r1 = await call({ ingredients: ["김치", "밥"], mood: "든든" }, { ip: "2.2.2.2" });
  check("1-a 첫 요청은 AI 호출", r1.data.source === "ai" && !r1.data.cached && aiCalls === 1);
  check("1-b 프롬프트에 원래 순서(김치, 밥) 유지", lastPrompt.includes('"재료":["김치","밥"]'));
  let r2 = await call({ ingredients: ["밥", "김치"], mood: "든든" }, { ip: "2.2.2.2" });
  check("1-c 순서 바꾼 요청은 캐시 적중, AI 호출 없음", r2.data.cached === true && aiCalls === 1);

  // 2) 공백·중복·대소문자 섞여도 같은 키
  let r3 = await call({ ingredients: ["김치", "밥", " 밥 "], mood: "든든" }, { ip: "2.2.2.2" });
  check("2-a 공백·중복 섞여도 캐시 적중", r3.data.cached === true && aiCalls === 1);
  await call({ ingredients: ["Cheese", "김치  볶음"], mood: "든든" }, { ip: "2.2.2.2" });
  let before = aiCalls;
  let r4 = await call({ ingredients: ["김치 볶음", "  cheese"], mood: "든든" }, { ip: "2.2.2.2" });
  check("2-b 대소문자·연속공백 달라도 캐시 적중", r4.data.cached === true && aiCalls === before);

  // 3) exclude 다르면 다른 키
  before = aiCalls;
  let r5 = await call({ ingredients: ["김치", "밥"], mood: "든든", exclude: ["다른메뉴"] }, { ip: "2.2.2.2" });
  check("3-a exclude 다르면 캐시 안 됨, AI 호출", !r5.data.cached && aiCalls === before + 1);
  before = aiCalls;
  let r6 = await call({ ingredients: ["밥", "김치"], mood: "든든", exclude: [" 다른메뉴 "] }, { ip: "2.2.2.2" });
  check("3-b 같은 exclude(공백만 다름)는 캐시 적중", r6.data.cached === true && aiCalls === before);
  let r7 = await call({ ingredients: ["김치", "밥"], mood: "매콤" }, { ip: "2.2.2.2" });
  check("3-c 기분 다르면 캐시 안 됨", !r7.data.cached);

  // 4) 캐시 적중은 횟수 차감 안 함: 1번 AI + 캐시 30번 + 새 조합 19번 = 정확히 20번째까지 AI
  const ip = "3.3.3.3";
  await call({ ingredients: ["양배추"], mood: "가벼움" }, { ip });
  for (let i = 0; i < 30; i++) await call({ ingredients: ["양배추"], mood: "가벼움" }, { ip });
  let allAi = true;
  for (let i = 0; i < 19; i++) { const r = await call({ ingredients: ["쿼터" + i] }, { ip }); if (r.data.source !== "ai") allAi = false; }
  check("4-a 캐시 30번 후에도 새 조합 19번 모두 AI", allAi);
  const over = await call({ ingredients: ["쿼터초과"] }, { ip });
  check("4-b 21번째 새 조합은 daily_limit", (over.data.cause || over.data.reason) === "daily_limit");

  console.log(fails === 0 ? "=> 모든 정규화 케이스 통과" : "=> 실패 " + fails + "건");
  // ===== 9번 점검 중 보완한 부분 =====
  const mk = (names) => ({ menus: names.map(n => ({ name: n, time_min: 10, ingredients: ["밥"], missing: [], steps: ["a"] })) });
  let bodies = [];
  global.fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return reply(mk(["김치 볶음밥", "B", "C"]))(); };
  let s1 = await call({ ingredients: ["점검1"], exclude: ["김치볶음밥"] }, { ip: "5.5.5.5" });
  check("5-a 띄어쓰기만 다른 제외 메뉴만 버리고 나머지 2개는 AI 추천", s1.data.source === "ai" && s1.data.partial === true && s1.data.menus.map(m => m.name).join() === "B,C" && bodies.length === 1);
  check("5-b 첫 요청에 thinkingLevel low 포함", bodies[0].generationConfig.thinkingConfig?.thinkingLevel === "low");
  bodies = []; global.fetch = async (url, opts) => { bodies.push(1); return reply(mk(["A", "a", "C"]))(); };
  let s2 = await call({ ingredients: ["점검2"] }, { ip: "5.5.5.5" });
  check("5-c 후보끼리 중복(대소문자만 다름)은 하나만 남김", s2.data.source === "ai" && s2.data.menus.map(m => m.name).join() === "A,C" && bodies.length === 1);
  bodies = []; global.fetch = async (url, opts) => { const b = JSON.parse(opts.body); bodies.push(b);
    return bodies.length === 1 ? reply({}, 400)() : reply(mk(["X", "Y", "Z"]))(); };
  let s3 = await call({ ingredients: ["점검3"] }, { ip: "5.5.5.5" });
  check("5-d 400이면 생각 설정 빼고 재시도 → 성공", s3.data.source === "ai" && !!bodies[0].generationConfig.thinkingConfig && !bodies[1].generationConfig.thinkingConfig);
  n = 0; global.fetch = async () => { n++; const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  let s4 = await call({ ingredients: ["점검4"] }, { ip: "5.5.5.5" });
  check("5-e 시간 초과면 재시도 없이 바로 대체 경로", s4.data.source === "fallback" && n === 1);
  console.log(fails === 0 ? "=> 보완 케이스 포함 전부 통과" : "=> 실패 " + fails + "건");
  // ===== 503(과부하)·시간 초과 =====
  const abortErr = () => { const e = new Error("aborted"); e.name = "AbortError"; return e; };
  // ms 동안 기다렸다가 fn 실행 (그 사이 시간 초과로 취소되면 AbortError)
  const after = (ms, fn) => (url, opts) => new Promise((res, rej) => {
    const t = setTimeout(() => res(fn(url, opts)), ms);
    opts.signal.addEventListener("abort", () => { clearTimeout(t); rej(abortErr()); });
  });
  const hang = after(60000, () => null);
  const ok3 = reply(mk(["P", "Q", "R"]));
  // 시계만 ms 앞으로 돌리고 fn 실행: 실제로 기다리지 않고 "시간이 그만큼 지난" 상황을 만든다. (끝나면 resetClock)
  const realNow = Date.now;
  const jump = (ms, fn) => (url, opts) => { const base = Date.now; Date.now = () => base() + ms; return fn(url, opts); };
  const resetClock = () => { Date.now = realNow; };
  // fetch 응답 순서를 정해 두고, 호출된 모델 주소를 기록
  let urls = [];
  const script = (...steps) => { urls = []; let i = 0; global.fetch = (url, opts) => { urls.push(url); return steps[Math.min(i++, steps.length - 1)](url, opts); }; };
  const timed = async (ingredient, ip) => { const t = Date.now(); const r = await call({ ingredients: [ingredient] }, { ip }); return { r, sec: (Date.now() - t) / 1000 }; };
  const model = (u) => u.split("models/")[1].split(":")[0];
  delete process.env.GEMINI_FALLBACK_MODEL;

  script(reply({}, 503), ok3);
  let t = await timed("과부하1", "6.6.6.1");
  check("6-a 503 → 1.5초 쉬고 재시도 → 성공", t.r.data.source === "ai" && urls.length === 2 && t.sec >= 1.4 && t.sec < 3, t.sec + "초");

  script(reply({}, 503));
  t = await timed("과부하2", "6.6.6.2");
  check("6-b 503 두 번, 예비 모델 없음 → 2번만 시도 후 기본 레시피", t.r.data.source === "fallback" && urls.length === 2 && t.sec < 3, t.sec + "초, " + urls.length + "회");

  process.env.GEMINI_FALLBACK_MODEL = "backup-model";
  script(reply({}, 503), reply({}, 503), ok3);
  t = await timed("과부하3", "6.6.6.3");
  check("6-c 503 두 번 → 예비 모델로 성공", t.r.data.source === "ai" && urls.length === 3 && model(urls[1]) === "gemini-3.8-flash" && model(urls[2]) === "backup-model", urls.map(model).join(" → "));

  script(reply({}, 503));
  t = await timed("과부하4", "6.6.6.4");
  check("6-d 예비 모델도 503 → 3번 시도 후 기본 레시피", t.r.data.source === "fallback" && urls.length === 3 && t.sec < 3, t.sec + "초");

  script(reply({}, 500), reply({}, 500));
  t = await timed("서버오류", "6.6.6.5");
  check("6-e 503이 아닌 오류(500)는 예비 모델 안 씀, 쉬지 않음", t.r.data.source === "fallback" && urls.length === 2 && t.sec < 1, t.sec + "초, " + urls.length + "회");

  process.env.GEMINI_FALLBACK_MODEL = "gemini-3.8-flash";
  script(reply({}, 503));
  t = await timed("같은모델", "6.6.6.6");
  check("6-f 예비 모델이 기본 모델과 같으면 건너뜀", urls.length === 2);
  process.env.GEMINI_FALLBACK_MODEL = "backup-model";

  delete process.env.GEMINI_FALLBACK_MODEL;
  script(hang);
  t = await timed("무응답", "6.6.6.7");
  check("6-g 응답 없음, 예비 모델 없음 → 6.5초에 끊고 재시도 없이 기본 레시피", t.r.data.source === "fallback" && urls.length === 1 && t.sec >= 6.4 && t.sec < 7.5, t.sec + "초");
  process.env.GEMINI_FALLBACK_MODEL = "backup-model";

  script(after(6000, reply({}, 503)), hang);
  t = await timed("느린과부하", "6.6.6.8");
  check("6-h 6초 뒤 503 → 남은 시간만큼만 재시도, 재시도 시간 초과면 예비 모델 없이 15초 안에 응답", t.r.data.source === "fallback" && urls.length === 2 && t.sec < 15, t.sec + "초, " + urls.length + "회");

  script(jump(9700, reply({}, 503)), ok3);
  t = await timed("시간부족", "6.6.6.9");
  resetClock();
  check("6-i 9.7초 지난 뒤 503 → 남은 시간 부족, 재시도 없이 기본 레시피", t.r.data.source === "fallback" && urls.length === 1 && t.sec < 11, t.sec + "초");

  script(reply({}, 503), reply({}, 429));
  t = await timed("과부하후한도", "6.6.7.1");
  check("6-j 503 후 재시도가 429 → 예비 모델 없이 ai_quota", (t.r.data.cause || t.r.data.reason) === "ai_quota" && urls.length === 2);
  delete process.env.GEMINI_FALLBACK_MODEL;

  console.log(fails === 0 ? "=> 503·시간 초과 포함 전부 통과" : "=> 실패 " + fails + "건");
  // ===== 다시 추천: 후보 5개 + 걸러내기 + 대체 경로 무관 메뉴 제외 =====
  const warns = []; const origWarn = console.warn; console.warn = (...a) => { warns.push(a.join(" ")); };
  let prompts = [];
  const aiSays = (...rounds) => { prompts = []; let i = 0;
    global.fetch = async (url, opts) => { prompts.push(JSON.parse(opts.body).contents[0].parts[0].text);
      const r = rounds[Math.min(i++, rounds.length - 1)]; return typeof r === "function" ? r(url, opts) : reply(Array.isArray(r) ? mk(r) : r)(); }; };

  aiSays(["제외A", "제외B", "새메뉴1"]);
  let d = (await call({ ingredients: ["밥"], exclude: ["제외A", "제외B"] }, { ip: "8.8.8.1" })).data;
  check("7-a 제외 2개 + 새 1개 → 새 메뉴 1개만 AI 추천, partial 표시", d.source === "ai" && d.menus.length === 1 && d.menus[0].name === "새메뉴1" && d.partial === true && prompts.length === 1);

  aiSays(["N1", "제외A", "N2", "N3", "N4"]);
  d = (await call({ ingredients: ["밥", "김"], exclude: ["제외A"] }, { ip: "8.8.8.2" })).data;
  check("7-b 후보 5개 중 새 메뉴 4개 → 앞의 3개, partial 없음", d.source === "ai" && d.menus.map(m => m.name).join() === "N1,N2,N3" && !d.partial);
  check("7-b 첫 프롬프트는 후보 5개 요청, 재시도 문구 없음", prompts[0].includes("메뉴 후보 5개") && !prompts[0].includes("다시 요청"));

  aiSays(["단호박죽", "단호박 수프", "단호박전"]);
  d = (await call({ ingredients: ["단호박"], exclude: ["단호박 죽"] }, { ip: "8.8.8.3" })).data;
  check("7-c 제외 '단호박 죽' → AI의 '단호박죽' 걸러짐", d.source === "ai" && d.menus.map(m => m.name).join() === "단호박 수프,단호박전");

  // 단호박 하나로 4번 연속: AI는 늘 같은 후보 5개만 낸다고 가정 (게으른 AI)
  const lazy = ["단호박죽", "단호박전", "단호박찜", "단호박샐러드", "단호박구이"];
  const shown = []; const rounds = [];
  for (let r = 1; r <= 4; r++) {
    aiSays(lazy);
    const res = (await call({ ingredients: ["단호박"], exclude: [...shown] }, { ip: "8.8.8.4" })).data;
    rounds.push({ ...res, calls: prompts.length, retryPrompt: prompts[1] });
    shown.push(...res.menus.map(m => m.name));
  }
  const summary = rounds.map((x, i) => (i + 1) + "회차:" + x.source + "/" + (x.reason || "-") + "/" + x.menus.length + "개").join("  ");
  check("7-d 1회차 3개, 2회차 남은 2개(partial)", rounds[0].menus.length === 3 && rounds[1].menus.length === 2 && rounds[1].partial === true, summary);
  check("7-d 3·4회차: AI 정상이지만 새 메뉴 0개 → 재시도 후 빈 목록 + no_match (cause 없음)",
    rounds.slice(2).every(x => x.source === "fallback" && x.reason === "no_match" && !("cause" in x) && x.menus.length === 0 && x.calls === 2));
  check("7-d 4회 동안 나온 메뉴 중복 없음 + 모두 단호박 메뉴", new Set(shown).size === shown.length && shown.every(n => n.includes("단호박")), shown.join(","));
  const rp = rounds[2].retryPrompt;
  check("7-d 재시도 프롬프트에 제외 목록과 다양성 지시 포함", rp.includes("다시 요청") && lazy.every(n => rp.includes("· " + n)) && rp.includes("국, 죽, 구이, 샐러드, 튀김"));

  warns.length = 0;
  aiSays(() => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "{깨짐" }] } }] }) }),
         { menus: [{ name: "형식틀림" }, ...mk(["정상1", "단호박죽"]).menus] });
  d = (await call({ ingredients: ["단호박"], exclude: ["단호박죽"] }, { ip: "8.8.8.5" })).data;
  const log = warns.join(" | ");
  check("7-e 로그에 이유별 기록: JSON 파싱 실패", log.includes("JSON 파싱 실패"));
  check("7-e 로그에 이유별 기록: 필수 항목 누락 / 제외 메뉴 포함 / 개수 부족",
    log.includes("필수 항목 누락 1개") && log.includes("제외 메뉴 포함 1개") && log.includes("개수 부족 - 후보 3개 중 새 메뉴 1개"));
  check("7-e 로그에 사용자 재료·메뉴 이름·키 없음", !/단호박|정상1|fake-key-for-test/.test(log), log.split(" | ").length + "줄");
  check("7-e 재시도로 얻은 1개는 AI 추천", d.source === "ai" && d.menus.length === 1);

  delete process.env.GEMINI_API_KEY;
  d = (await call({ ingredients: ["단호박"] }, { ip: "8.8.8.6" })).data;
  check("7-f 키 없음 + 단호박 → 무관 메뉴 대신 no_match (cause: no_key)", d.reason === "no_match" && d.cause === "no_key" && d.menus.length === 0);
  d = (await call({ ingredients: ["아보카도", "우동면"] }, { ip: "8.8.8.6" })).data;
  check("7-g 기본 레시피도 겹치는 메뉴만 (우동 2개) + partial", d.menus.length === 2 && d.menus.every(m => m.ingredients.includes("우동면")) && d.partial === true, d.menus.map(m => m.name).join(","));
  process.env.GEMINI_API_KEY = "fake-key-for-test";

  // ===== no_match 의 cause 구분 =====
  const jsonBroken = () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "{깨짐" }] } }] }) });
  const http = (st) => () => ({ ok: false, status: st, json: async () => ({}) });
  const ask = async (ip, ex = ["단호박죽", "구분" + ip]) => (await call({ ingredients: ["단호박"], exclude: ex }, { ip })).data;
  const short = (x) => x.reason + (x.cause ? "/cause=" + x.cause : "/cause 없음");

  aiSays(jsonBroken); d = await ask("8.8.9.1");
  check("8-a JSON 깨짐 두 번 → cause ai_error", d.reason === "no_match" && d.cause === "ai_error", short(d));
  aiSays({ menus: [{ name: "형식틀림" }] }); d = await ask("8.8.9.2");
  check("8-b 후보 형식이 모두 틀림 → cause ai_error", d.cause === "ai_error", short(d));
  aiSays(http(503), ["단호박죽"]); d = await ask("8.8.9.3");
  check("8-c 503 후 재시도는 정상이지만 새 메뉴 0개 → cause 없음", d.reason === "no_match" && !("cause" in d), short(d));
  aiSays(["단호박죽"], http(503)); d = await ask("8.8.9.4");
  check("8-d 새 메뉴 0개 후 재시도가 503 → cause ai_error (마지막 시도 기준)", d.cause === "ai_error", short(d));
  aiSays(http(429)); d = await ask("8.8.9.5");
  check("8-e 429 → cause ai_quota", d.reason === "no_match" && d.cause === "ai_quota", short(d));
  aiSays(["단호박죽"]); for (let i = 0; i < 20; i++) await ask("8.8.9.6", ["x" + i]);
  d = await ask("8.8.9.6", ["마지막"]);
  check("8-f 하루 횟수 초과 → cause daily_limit", d.cause === "daily_limit", short(d));
  aiSays(["밥요리"]); d = (await call({ ingredients: ["밥"], exclude: ["밥요리"] }, { ip: "8.8.9.7" })).data;
  check("8-g 새 메뉴 0개라도 기본 레시피가 있으면 기존대로 reason ai_error + 메뉴", d.source === "fallback" && d.reason === "ai_error" && d.menus.length === 3, short(d));

  console.warn = origWarn;
  console.log(fails === 0 ? "=> 다시 추천 보완 포함 전부 통과" : "=> 실패 " + fails + "건");

  // ===== 예비 모델 로그 / 메뉴 품질 프롬프트 =====
  const logs = []; console.warn = (...a) => { logs.push(a.join(" ")); };
  const backupLogs = () => logs.filter(l => l.startsWith("예비 모델"));
  process.env.GEMINI_FALLBACK_MODEL = "backup-model";

  logs.length = 0; aiSays(http(503), http(503), ["백업메뉴1", "백업메뉴2", "백업메뉴3"]);
  d = await ask("8.9.0.1");
  check("9-a 기본 503 두 번 → 예비 모델 성공: 시도·성공 로그", d.source === "ai" &&
    backupLogs().join("|") === "예비 모델 시도: backup-model (기본 모델 gemini-3.8-flash 503 두 번)|예비 모델 성공: backup-model (새 메뉴 3개)", backupLogs().join(" / "));

  logs.length = 0; aiSays(http(503)); d = await ask("8.9.0.2");
  check("9-b 예비 모델도 503 → 시도·실패(HTTP 503) 로그", backupLogs().join("|") === "예비 모델 시도: backup-model (기본 모델 gemini-3.8-flash 503 두 번)|예비 모델 실패: backup-model - HTTP 503", backupLogs().join(" / "));

  logs.length = 0; aiSays(http(503), http(503), ["단호박죽"]); d = await ask("8.9.0.3");
  check("9-c 예비 모델이 이미 나온 메뉴만 → 실패(새 메뉴 0개) 로그", backupLogs().at(-1) === "예비 모델 실패: backup-model - 새 메뉴 0개", backupLogs().at(-1));

  logs.length = 0; aiSays(http(503), after(9800, http(503)), ["백업메뉴9"]); d = await ask("8.9.0.4");
  check("9-d 남은 시간 부족 → 예비 모델 건너뜀 로그, 호출 안 함", backupLogs().join("|") === "예비 모델 건너뜀: backup-model - 남은 시간 부족" && prompts.length === 2, backupLogs().join(" / "));

  logs.length = 0; aiSays(http(503), http(503), ["백업메뉴1"]); await ask("8.9.0.5");
  check("9-e 로그에 키·재료·메뉴 이름 없음", !/fake-key-for-test|단호박|백업메뉴/.test(logs.join(" ")), logs.length + "줄");

  aiSays(["밥요리1", "밥요리2", "밥요리3"]); await call({ ingredients: ["밥", "9-f"] }, { ip: "8.9.0.6" });
  check("9-f 프롬프트에 '실제로 해 먹을 메뉴 먼저, 음료·디저트·과자류는 뒤쪽' 규칙", prompts[0].includes("한 끼 식사나 반찬으로 실제로 해 먹을 만한 메뉴를 앞쪽에") && prompts[0].includes("음료·디저트·과자류(라떼, 칩, 퓨레 등)"));

  // ===== 첫 시도 시간 초과 → 예비 모델 =====
  const timeoutPrompts = () => { const sent = []; return { sent, track: (fn) => (url, opts) => { sent.push(JSON.parse(opts.body).contents[0].parts[0].text); return fn(url, opts); } }; };

  logs.length = 0; const tp = timeoutPrompts(); script(tp.track(hang), tp.track(ok3));
  t = await timed("느린재료1", "8.9.1.1");
  check("10-a 기본 모델 6초 넘게 응답 없음 → 예비 모델 성공", t.r.data.source === "ai" && urls.map(model).join() === "gemini-3.8-flash,backup-model" && t.sec >= 6.4 && t.sec < 7.5, t.sec + "초");
  check("10-a 시도·성공 로그", backupLogs().join("|") === "예비 모델 시도(시간 초과 후): backup-model|예비 모델 성공: backup-model (새 메뉴 3개)", backupLogs().join(" / "));
  check("10-a 예비 모델에는 '다시 요청' 문구 없는 첫 프롬프트", tp.sent.length === 2 && tp.sent[1] === tp.sent[0] && !tp.sent[1].includes("다시 요청"));

  logs.length = 0; script(hang, http(500));
  t = await timed("느린재료2", "8.9.1.2");
  check("10-b 예비 모델도 실패(500) → 기본 레시피 + 시도·실패 로그", (t.r.data.cause || t.r.data.reason) === "ai_error" && t.r.data.source === "fallback" && urls.length === 2 &&
    backupLogs().join("|") === "예비 모델 시도(시간 초과 후): backup-model|예비 모델 실패: backup-model - HTTP 500", backupLogs().join(" / "));

  logs.length = 0; script(hang, hang);
  t = await timed("느린재료3", "8.9.1.3");
  check("10-c 예비 모델도 응답 없음 → 남은 시간까지만 기다리고 15초 안에 기본 레시피", t.r.data.source === "fallback" && urls.length === 2 && t.sec >= 13.5 && t.sec < 15 &&
    backupLogs().at(-1) === "예비 모델 실패: backup-model - 시간 초과", t.sec + "초");

  // 실제로는 6.5초에 끊겨 7.5초가 남으므로, 시계를 돌려 남은 시간이 적은 상황을 만든다.
  logs.length = 0; script(jump(10500, () => { throw abortErr(); }), ok3);
  t = await timed("느린재료4", "8.9.1.4");
  resetClock();
  check("10-d 남은 시간 3.5초 → 예비 모델 건너뜀 + 로그, 호출 안 함", t.r.data.source === "fallback" && urls.length === 1 &&
    backupLogs().join("|") === "예비 모델 건너뜀(남은 시간 부족): backup-model", backupLogs().join(" / "));

  logs.length = 0; script(jump(9500, () => { throw abortErr(); }), ok3);
  t = await timed("느린재료5", "8.9.1.5");
  resetClock();
  check("10-e 남은 시간 4.5초 → 예비 모델 시도", t.r.data.source === "ai" && urls.length === 2, backupLogs().join(" / "));

  logs.length = 0; script(hang, http(429));
  t = await timed("느린재료6", "8.9.1.6");
  check("10-f 시간 초과 후 예비 모델이 429 → ai_quota", (t.r.data.cause || t.r.data.reason) === "ai_quota" && urls.length === 2);

  logs.length = 0; script(http(429), ok3);
  t = await timed("느린재료7", "8.9.1.7");
  check("10-g 첫 시도 429는 예비 모델 설정이 있어도 재시도 없이 ai_quota", (t.r.data.cause || t.r.data.reason) === "ai_quota" && urls.length === 1 && backupLogs().length === 0);

  process.env.GEMINI_FALLBACK_MODEL = "gemini-3.8-flash";
  logs.length = 0; script(() => { throw abortErr(); }, ok3);
  t = await timed("느린재료8", "8.9.1.8");
  check("10-h 예비 모델이 기본 모델과 같으면 시간 초과 후에도 시도 안 함", t.r.data.source === "fallback" && urls.length === 1 && backupLogs().length === 0);
  process.env.GEMINI_FALLBACK_MODEL = "backup-model";

  logs.length = 0; script(() => { throw abortErr(); }, http(503)); await timed("느린재료9", "8.9.1.9");
  check("10-i 시간 초과 로그에 키·재료 없음", logs.length > 0 && !/fake-key-for-test|느린재료/.test(logs.join(" ")), logs.length + "줄");

  // ===== 예비 모델이 thinking 설정을 몰라 400 =====
  const badRequest = (message) => () => ({ ok: false, status: 400, json: async () => ({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }) });
  const thinking400 = badRequest("Unknown name \"thinkingLevel\" at 'generation_config.thinking_config': Cannot find field.");
  const timeout = () => { throw abortErr(); };
  const RETRY_LOG = "예비 모델 thinking 설정 제외 후 재시도: backup-model";
  let sentThinking = [];
  const rec = (fn) => (url, opts) => { const b = JSON.parse(opts.body); sentThinking.push({ thinking: !!b.generationConfig.thinkingConfig, prompt: b.contents[0].parts[0].text }); return fn(url, opts); };

  logs.length = 0; sentThinking = []; script(timeout, rec(thinking400), rec(ok3));
  t = await timed("설정재료1", "8.9.2.1");
  check("11-a 시간 초과 후 예비 모델 설정 400 → 설정 빼고 성공", t.r.data.source === "ai" && urls.map(model).join() === "gemini-3.8-flash,backup-model,backup-model" &&
    backupLogs().join("|") === "예비 모델 시도(시간 초과 후): backup-model|" + RETRY_LOG + "|예비 모델 성공: backup-model (새 메뉴 3개)", backupLogs().join(" / "));
  check("11-a 첫 요청엔 설정 있고 재시도엔 없음, 프롬프트는 같음", sentThinking.length === 2 && sentThinking[0].thinking && !sentThinking[1].thinking && sentThinking[0].prompt === sentThinking[1].prompt);
  check("11-a 로그에 키·재료·오류 본문 없음", !/fake-key-for-test|설정재료|thinkingLevel|Cannot find/.test(logs.join(" ")), logs.length + "줄");

  logs.length = 0; sentThinking = []; script(http(503), http(503), rec(thinking400), rec(ok3));
  t = await timed("설정재료2", "8.9.2.2");
  check("11-b 503 두 번 후 예비 모델 설정 400 → 설정 빼고 성공", t.r.data.source === "ai" && urls.length === 4 && sentThinking[0].thinking && !sentThinking[1].thinking && sentThinking[0].prompt === sentThinking[1].prompt &&
    backupLogs().join("|") === "예비 모델 시도: backup-model (기본 모델 gemini-3.8-flash 503 두 번)|" + RETRY_LOG + "|예비 모델 성공: backup-model (새 메뉴 3개)", backupLogs().join(" / "));

  logs.length = 0; script(timeout, thinking400, http(500), ok3);
  t = await timed("설정재료3", "8.9.2.3");
  check("11-c 설정 빼고도 실패(500) → 기본 레시피, 더 시도 안 함", t.r.data.source === "fallback" && urls.length === 3 && backupLogs().at(-1) === "예비 모델 실패: backup-model - HTTP 500", backupLogs().at(-1));

  logs.length = 0; script(timeout, thinking400, thinking400, ok3);
  t = await timed("설정재료4", "8.9.2.4");
  check("11-d 설정 빼고도 또 설정 400 → 재시도는 한 번뿐", t.r.data.source === "fallback" && urls.length === 3 && backupLogs().filter(l => l === RETRY_LOG).length === 1 && backupLogs().at(-1) === "예비 모델 실패: backup-model - HTTP 400", urls.length + "회");

  logs.length = 0; script(timeout, thinking400, http(429), ok3);
  t = await timed("설정재료5", "8.9.2.5");
  check("11-e 설정 빼고 보낸 요청이 429 → ai_quota, 더 시도 안 함", (t.r.data.cause || t.r.data.reason) === "ai_quota" && urls.length === 3);

  logs.length = 0; script(timeout, badRequest("API key not valid. Please pass a valid API key."), ok3);
  t = await timed("설정재료6", "8.9.2.6");
  check("11-f 다른 사유의 400(시간 초과 경로) → 재시도 안 함", t.r.data.source === "fallback" && urls.length === 2 && !backupLogs().includes(RETRY_LOG) && backupLogs().at(-1) === "예비 모델 실패: backup-model - HTTP 400", backupLogs().join(" / "));

  logs.length = 0; script(http(503), http(503), badRequest("Invalid value at 'generation_config.response_schema'"), ok3);
  t = await timed("설정재료7", "8.9.2.7");
  check("11-g 다른 사유의 400(503 경로) → 재시도 안 함", t.r.data.source === "fallback" && urls.length === 3 && !backupLogs().includes(RETRY_LOG), urls.length + "회");

  logs.length = 0; script(timeout, http(400), ok3);
  t = await timed("설정재료8", "8.9.2.8");
  check("11-h 오류 설명 없는 400 → 재시도 안 함", t.r.data.source === "fallback" && urls.length === 2 && !backupLogs().includes(RETRY_LOG));

  logs.length = 0; script(timeout, () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError("not json"); } }), ok3);
  t = await timed("설정재료9", "8.9.3.1");
  check("11-i 본문이 JSON이 아닌 400 → 재시도 안 함", t.r.data.source === "fallback" && urls.length === 2 && !backupLogs().includes(RETRY_LOG));

  logs.length = 0; script(timeout, http(429), ok3);
  t = await timed("설정재료10", "8.9.3.2");
  check("11-j 예비 모델 429 → 재시도 안 함", (t.r.data.cause || t.r.data.reason) === "ai_quota" && urls.length === 2 && !backupLogs().includes(RETRY_LOG));

  logs.length = 0; script(timeout, jump(11500, thinking400), ok3);
  t = await timed("설정재료11", "8.9.3.3");
  resetClock();
  check("11-k 남은 시간 2.5초 → 설정 400이어도 재시도 안 함", t.r.data.source === "fallback" && urls.length === 2 && !backupLogs().includes(RETRY_LOG) && backupLogs().at(-1) === "예비 모델 실패: backup-model - HTTP 400", backupLogs().join(" / "));

  logs.length = 0; script(hang, after(2000, thinking400), hang);
  t = await timed("설정재료12", "8.9.3.4");
  check("11-l 재시도도 응답 없음 → 남은 시간까지만 기다리고 15초 안에 기본 레시피", t.r.data.source === "fallback" && urls.length === 3 && t.sec >= 13.5 && t.sec < 15 && backupLogs().at(-1) === "예비 모델 실패: backup-model - 시간 초과", t.sec + "초");

  delete process.env.GEMINI_FALLBACK_MODEL;
  console.warn = origWarn;
  console.log(fails === 0 ? "=> 서버 테스트 전부 통과" : "=> 서버 테스트 실패 " + fails + "건");
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
