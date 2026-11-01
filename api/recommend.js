// Vercel 서버 함수: POST /api/recommend
// 입력: { ingredients: [], mood: "", exclude: [] }
// 출력: { source: "ai" | "fallback", menus: [...] }
// API 키는 Vercel 환경변수 GEMINI_API_KEY 에서만 읽는다. (코드·GitHub에 절대 쓰지 않음)
//
// [한계] IP별 횟수 제한과 캐시는 서버 메모리에만 저장한다. 서버 함수가 여러 개 동시에 뜨면
//   서로 값을 공유하지 못하고, 재시작되면 값이 초기화되므로 정확하지 않다.
// [그래도 괜찮은 이유] 결제를 설정하지 않은 무료 계정이라 한도를 넘으면 요금이 아니라
//   오류(429)가 나고, 이때는 기본 레시피 대체 경로가 응답한다.

const { recommendFromRecipes } = require("../recipes.js");

const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// 입력 제한 (Plan.md 7번 "입력 길이 제한")
const MAX_INGREDIENTS = 15;
const MAX_INGREDIENT_LENGTH = 20;
const MAX_EXCLUDE = 60; // 기본 레시피 39개를 모두 제외할 수 있을 만큼
const MAX_EXCLUDE_LENGTH = 30;
const ALLOWED_MOODS = ["", "빠르게", "든든", "가벼움", "매콤", "국물"];

// 한도 보호 (Plan.md 7번)
const DAILY_LIMIT_PER_IP = 20;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분
const CACHE_MAX_ENTRIES = 200;
// AI 대기 시간: 한 번에 최대 10초, 재시도·예비 모델 포함 전체 14초 (응답은 15초 안에)
const AI_ATTEMPT_TIMEOUT_MS = 10 * 1000;
const AI_TOTAL_BUDGET_MS = 14 * 1000;
const MIN_RETRY_TIME_MS = 3 * 1000; // 남은 시간이 이보다 적으면 재시도하지 않음
const OVERLOAD_RETRY_DELAY_MS = 1500; // 503(과부하) 후 재시도 전 잠깐 쉬는 시간

// 메모리 저장소: 서버가 켜져 있는 동안만 유지된다.
const usageByIp = new Map(); // ip → 오늘 AI 요청 횟수
let usageDate = today();
const cache = new Map(); // 조합 키 → { expires, menus }

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- 1. 입력 검사 ----------

function cleanList(value, maxCount, maxLength) {
  if (!Array.isArray(value) || value.length > maxCount) return null;
  const list = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || text.length > maxLength) return null;
    if (!list.includes(text)) list.push(text);
  }
  return list;
}

// 올바른 입력이면 정리된 값을, 아니면 오류 문구를 돌려준다.
function validateInput(body) {
  if (!body || typeof body !== "object") return { error: "요청 형식이 올바르지 않아요." };

  const ingredients = cleanList(body.ingredients, MAX_INGREDIENTS, MAX_INGREDIENT_LENGTH);
  if (!ingredients || ingredients.length === 0) {
    return { error: `재료는 1~${MAX_INGREDIENTS}개, 각 ${MAX_INGREDIENT_LENGTH}자 이하로 보내 주세요.` };
  }

  const mood = body.mood === undefined ? "" : body.mood;
  if (!ALLOWED_MOODS.includes(mood)) return { error: "기분·상황 값이 올바르지 않아요." };

  const exclude = cleanList(body.exclude === undefined ? [] : body.exclude, MAX_EXCLUDE, MAX_EXCLUDE_LENGTH);
  if (!exclude) return { error: "제외 메뉴 목록이 올바르지 않아요." };

  // 프롬프트에는 사용자가 입력한 순서·표기 그대로 쓴다. (정규화는 캐시 키에서만)
  return { ingredients, mood, exclude };
}

// ---------- 2. 캐시 ----------

// 캐시 키용 정규화: 앞뒤 공백 제거, 연속 공백은 하나로, 영문은 소문자로
function normalizeForKey(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

// 목록 정규화: 각 항목 정규화 → 중복 제거 → 정렬 (기본 정렬은 가나다·알파벳 순으로 항상 같은 결과)
function normalizeListForKey(list) {
  return [...new Set(list.map(normalizeForKey))].sort();
}

// 재료 순서·공백·대소문자가 달라도 같은 조합이면 같은 키가 나온다.
function cacheKey({ ingredients, mood, exclude }) {
  return JSON.stringify([normalizeListForKey(ingredients), mood, normalizeListForKey(exclude)]);
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.menus;
}

function setCached(key, menus) {
  // 너무 많이 쌓이면 가장 오래된 것부터 지운다 (Map은 넣은 순서를 기억함)
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, menus });
}

// ---------- 3. IP별 하루 횟수 제한 ----------

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

// 횟수가 남아 있으면 1 올리고 true, 다 썼으면 false
function useQuota(ip) {
  if (usageDate !== today()) {
    usageByIp.clear(); // 날짜가 바뀌면 모두 초기화
    usageDate = today();
  }
  const used = usageByIp.get(ip) || 0;
  if (used >= DAILY_LIMIT_PER_IP) return false;
  usageByIp.set(ip, used + 1);
  return true;
}

// ---------- 4. Gemini 호출과 결과 검사 ----------

// AI에게는 후보를 5개 받아, 서버가 제외 메뉴·중복을 걸러낸 뒤 앞에서 3개를 쓴다.
const AI_CANDIDATES = 5;
const MENUS_TO_SHOW = 3;

// isRetry: 재시도 때는 이미 나온 메뉴를 목록으로 다시 적고 다양하게 내라고 강조한다.
function buildPrompt({ ingredients, mood, exclude }, isRetry = false) {
  const retryRules = !isRetry ? [] : [
    "",
    "중요 (다시 요청하는 것입니다):",
    ...(exclude.length
      ? ["- 아래 메뉴는 이미 나왔다. 이름이 같거나 띄어쓰기만 다른 메뉴도 절대 쓰지 않는다.", ...exclude.map((n) => `  · ${n}`)]
      : []),
    "- 재료가 적어도 조리법이나 형태가 다른 메뉴(국, 죽, 구이, 샐러드, 튀김 등)로 다양하게 제안하고, 이미 나온 이름은 절대 쓰지 않는다.",
  ];
  // 개인정보 없이 재료·기분·제외 메뉴만 보낸다.
  return [
    `당신은 한국 가정식 요리 도우미입니다. 아래 조건으로 메뉴 후보 ${AI_CANDIDATES}개를 추천하세요.`,
    "",
    "규칙:",
    `- 주어진 재료 위주로 만들 수 있는 서로 다른 메뉴 후보 ${AI_CANDIDATES}개를, 잘 어울리는 순서대로 추천한다.`,
    // 서버는 앞에서부터 3개를 쓰므로, 실제로 해 먹을 만한 메뉴가 앞에 오도록 한다.
    `- 후보 ${AI_CANDIDATES}개는 한 끼 식사나 반찬으로 실제로 해 먹을 만한 메뉴를 앞쪽에 두고, 음료·디저트·과자류(라떼, 칩, 퓨레 등)는 후보가 부족할 때에만 뒤쪽에 둔다.`,
    "- 소금, 설탕, 후추, 간장, 고추장, 된장, 고춧가루, 다진마늘, 식용유, 참기름, 식초, 케첩, 마요네즈 같은 기본 양념은 있다고 가정한다.",
    "- ingredients에는 기본 양념을 제외한 주재료를 적는다.",
    "- missing에는 ingredients 중 사용자가 가지고 있지 않은 재료를 적는다. 없으면 빈 배열.",
    "- 제외 메뉴 목록에 있는 메뉴는 추천하지 않는다.",
    "- time_min은 분 단위 정수, steps는 3~6개의 짧은 한국어 문장으로 쓴다.",
    "- 안전한 조리법만 제안한다.",
    "- 지정한 JSON 형식으로만 응답한다.",
    ...retryRules,
    "",
    "입력(JSON):",
    JSON.stringify({ 재료: ingredients, 기분_상황: mood || "상관없음", 제외_메뉴: exclude }),
  ].join("\n");
}

// Gemini JSON 모드에 넘길 응답 형식 (Plan.md 6번 응답 형식)
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    menus: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          time_min: { type: "INTEGER" },
          ingredients: { type: "ARRAY", items: { type: "STRING" } },
          missing: { type: "ARRAY", items: { type: "STRING" } },
          steps: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["name", "time_min", "ingredients", "missing", "steps"],
      },
    },
  },
  required: ["menus"],
};

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// useLowThinking: 응답을 빨리 받으려고 "생각" 단계를 낮춘다.
// 모델이 이 설정을 모르면 400이 나므로, 그때는 재시도에서 빼고 보낸다.
async function callGemini(prompt, { model, timeoutMs, useLowThinking }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  if (useLowThinking) generationConfig.thinkingConfig = { thinkingLevel: "low" };

  try {
    const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY, // 키는 주소가 아닌 헤더로 보낸다
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new GeminiError(`Gemini HTTP ${res.status}`, res.status);

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
  } finally {
    clearTimeout(timer);
  }
}

const isStringList = (v, allowEmpty) =>
  Array.isArray(v) && (allowEmpty || v.length > 0) && v.every((s) => typeof s === "string" && s.trim());

const hasRequiredFields = (m) =>
  typeof m?.name === "string" && m.name.trim() &&
  Number.isFinite(m.time_min) && m.time_min > 0 &&
  isStringList(m.ingredients, false) &&
  isStringList(m.missing, true) &&
  isStringList(m.steps, false);

// 메뉴 이름 비교용: 띄어쓰기·대소문자 차이는 같은 메뉴로 본다 ("단호박 죽" = "단호박죽")
const sameName = (name) => normalizeForKey(name).replace(/ /g, "");

// AI 응답 글자를 검사해서 { menus: 최대 3개 } 를 돌려준다.
// - 새 메뉴가 0개인데 형식이 맞는 후보는 있었다면(전부 이미 나온 메뉴·중복) { noNew: true }
//   → "AI는 정상 응답했지만 새 메뉴가 없음" (AI 오류와 구분해 화면 문구를 다르게 보여 준다)
// - JSON이 깨졌거나 모든 후보의 형식이 틀리면 null
// - 형식이 틀린 후보, 제외 메뉴와 같은 후보, 후보끼리 중복은 그 후보만 버린다.
// - 걸러낸 이유는 개수만 로그에 남긴다. (사용자 입력·메뉴 이름은 남기지 않음)
function parseMenus(text, exclude, label) {
  const warn = (msg) => console.warn(`AI 응답 검증 (${label}): ${msg}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    warn("JSON 파싱 실패");
    return null;
  }
  const candidates = data?.menus;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    warn("필수 항목 누락 - menus 목록이 없음");
    return null;
  }

  const seen = new Set(exclude.map(sameName));
  const menus = [];
  let invalid = 0, excluded = 0, duplicate = 0;
  for (const m of candidates) {
    if (!hasRequiredFields(m)) { invalid++; continue; }
    const key = sameName(m.name);
    if (seen.has(key)) {
      exclude.some((n) => sameName(n) === key) ? excluded++ : duplicate++;
      continue;
    }
    seen.add(key);
    menus.push({
      name: m.name.trim(),
      time_min: Math.round(m.time_min),
      ingredients: m.ingredients,
      missing: m.missing,
      steps: m.steps,
    });
  }

  if (invalid) warn(`필수 항목 누락 ${invalid}개 버림`);
  if (excluded) warn(`제외 메뉴 포함 ${excluded}개 버림`);
  if (duplicate) warn(`후보끼리 중복 ${duplicate}개 버림`);
  if (menus.length < MENUS_TO_SHOW) warn(`개수 부족 - 후보 ${candidates.length}개 중 새 메뉴 ${menus.length}개`);
  if (menus.length) return { menus: menus.slice(0, MENUS_TO_SHOW) };
  return invalid < candidates.length ? { noNew: true } : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 시도 순서 (모두 합쳐 14초 안에, 남은 시간이 부족하면 바로 기본 레시피로)
//   ① 기본 모델
//   ② 기본 모델 재시도 1회 (503 과부하면 1.5초 쉬고)
//   ③ 기본 모델이 계속 503이고 GEMINI_FALLBACK_MODEL 이 있으면 그 모델로 1회
// - 한도 초과(429)는 다시 해도 소용없으니 바로 포기
// - 시간 초과면 재시도하지 않음
async function recommendWithAI(input) {
  const firstPrompt = buildPrompt(input);
  const retryPrompt = buildPrompt(input, true);
  const deadline = Date.now() + AI_TOTAL_BUDGET_MS;
  const primaryModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const backupModel = process.env.GEMINI_FALLBACK_MODEL;
  let useLowThinking = true;

  // 한 번 시도하고 결과를 { menus } / { noNew } / { status, timedOut } 로 돌려준다.
  // 첫 시도가 아니면 재시도용 프롬프트(제외 메뉴 목록·다양성 지시 추가)를 쓴다.
  async function attempt(model, label, isRetry) {
    try {
      const timeoutMs = Math.min(AI_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
      const prompt = isRetry ? retryPrompt : firstPrompt;
      const parsed = parseMenus(await callGemini(prompt, { model, timeoutMs, useLowThinking }), input.exclude, label);
      if (parsed?.menus) return { menus: parsed.menus };
      console.warn(`AI 응답 검증 실패 (${label}): 쓸 수 있는 새 메뉴 0개`);
      return { noNew: !!parsed?.noNew };
    } catch (err) {
      const timedOut = err.name === "AbortError";
      console.warn(`AI 호출 실패 (${label}): ${timedOut ? "시간 초과" : err.message}`);
      return { status: err.status, timedOut };
    }
  }
  const hasTimeFor = (waitMs = 0) => deadline - Date.now() - waitMs >= MIN_RETRY_TIME_MS;

  // ① 기본 모델
  let result = await attempt(primaryModel, "1차", false);
  if (result.menus) return result;
  if (result.status === 429) return { reason: "ai_quota" };
  if (result.timedOut) return { reason: "ai_error" };

  // ② 기본 모델 재시도
  const overloaded = result.status === 503;
  const waitMs = overloaded ? OVERLOAD_RETRY_DELAY_MS : 0;
  if (result.status === 400) useLowThinking = false; // 생각 단계 설정을 모르는 모델일 수 있음
  if (!hasTimeFor(waitMs)) return { reason: "ai_error", noNew: result.noNew };
  await sleep(waitMs);
  result = await attempt(primaryModel, "재시도", true);
  if (result.menus) return result;
  if (result.status === 429) return { reason: "ai_quota" };

  // ③ 예비 모델 (기본 모델이 두 번 다 과부하일 때만)
  //    로그에는 모델 이름과 사유만 남긴다. (키·재료·메뉴 이름은 남기지 않음)
  if (overloaded && result.status === 503 && backupModel && backupModel !== primaryModel) {
    if (!hasTimeFor()) {
      console.warn(`예비 모델 건너뜀: ${backupModel} - 남은 시간 부족`);
    } else {
      console.warn(`예비 모델 시도: ${backupModel} (기본 모델 ${primaryModel} 503 두 번)`);
      result = await attempt(backupModel, `예비 모델 ${backupModel}`, true);
      if (result.menus) {
        console.warn(`예비 모델 성공: ${backupModel} (새 메뉴 ${result.menus.length}개)`);
        return result;
      }
      const why = result.timedOut ? "시간 초과"
        : result.status ? `HTTP ${result.status}`
        : result.noNew ? "새 메뉴 0개"
        : "응답 검증 실패";
      console.warn(`예비 모델 실패: ${backupModel} - ${why}`);
      if (result.status === 429) return { reason: "ai_quota" };
    }
  }
  // noNew: 마지막 시도에서 AI는 정상 응답했지만 새 메뉴가 0개였음
  return { reason: "ai_error", noNew: result.noNew };
}

// ---------- 5. 대체 경로 ----------

// recommendFromRecipes 는 고른 재료와 하나라도 겹치는 레시피만 돌려준다.
// 겹치는 게 하나도 없으면 엉뚱한 메뉴로 채우지 않고 빈 목록 + reason "no_match" 로 응답한다.
// - cause: 원래 대체 경로로 온 이유 (no_key, ai_error 등 = AI를 쓰지 못함)
// - aiNoNew: AI는 정상 응답했지만 새 메뉴가 0개 → cause 없이 보낸다
function fallback(input, reason, aiNoNew = false) {
  const menus = recommendFromRecipes(input.ingredients, input.mood, input.exclude).map((m) => ({
    name: m.name,
    time_min: m.time_min,
    ingredients: m.ingredients,
    missing: m.missing,
    steps: m.steps,
  }));
  if (menus.length === 0) {
    console.warn(`기본 레시피 대체: 겹치는 재료가 있는 메뉴 없음 (원래 이유: ${aiNoNew ? "AI 새 메뉴 0개" : reason})`);
    return aiNoNew
      ? { source: "fallback", reason: "no_match", menus: [] }
      : { source: "fallback", reason: "no_match", cause: reason, menus: [] };
  }
  return withPartial({ source: "fallback", reason, menus });
}

// 메뉴가 3개보다 적으면 partial: true 를 붙여 화면이 안내 문구를 띄울 수 있게 한다.
function withPartial(response) {
  return response.menus.length < MENUS_TO_SHOW ? { ...response, partial: true } : response;
}

// ---------- 서버 함수 본체 ----------

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 받아요." });
  }

  // Vercel이 JSON 본문을 미리 읽어 주지만, 글자로 들어온 경우도 대비한다.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }

  const input = validateInput(body);
  if (input.error) return res.status(400).json({ error: input.error });

  // 여기부터는 무슨 일이 생겨도 기본 레시피로 응답한다.
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(200).json(fallback(input, "no_key"));

    const key = cacheKey(input);
    const cached = getCached(key);
    if (cached) return res.status(200).json(withPartial({ source: "ai", cached: true, menus: cached }));

    if (!useQuota(getClientIp(req))) return res.status(200).json(fallback(input, "daily_limit"));

    const result = await recommendWithAI(input);
    if (!result.menus) return res.status(200).json(fallback(input, result.reason, result.noNew));

    setCached(key, result.menus);
    return res.status(200).json(withPartial({ source: "ai", menus: result.menus }));
  } catch (err) {
    console.error("예상치 못한 오류:", err.message);
    return res.status(200).json(fallback(input, "server_error"));
  }
};
