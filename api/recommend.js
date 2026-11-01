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
const MAX_EXCLUDE = 30;
const MAX_EXCLUDE_LENGTH = 30;
const ALLOWED_MOODS = ["", "빠르게", "든든", "가벼움", "매콤", "국물"];

// 한도 보호 (Plan.md 7번)
const DAILY_LIMIT_PER_IP = 20;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분
const CACHE_MAX_ENTRIES = 200;
const AI_TIMEOUT_MS = 10 * 1000;

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

function buildPrompt({ ingredients, mood, exclude }) {
  // 개인정보 없이 재료·기분·제외 메뉴만 보낸다.
  return [
    "당신은 한국 가정식 요리 도우미입니다. 아래 조건으로 메뉴 3개를 추천하세요.",
    "",
    "규칙:",
    "- 주어진 재료 위주로 만들 수 있는 메뉴 3개를 추천한다.",
    "- 소금, 설탕, 후추, 간장, 고추장, 된장, 고춧가루, 다진마늘, 식용유, 참기름, 식초, 케첩, 마요네즈 같은 기본 양념은 있다고 가정한다.",
    "- ingredients에는 기본 양념을 제외한 주재료를 적는다.",
    "- missing에는 ingredients 중 사용자가 가지고 있지 않은 재료를 적는다. 없으면 빈 배열.",
    "- 제외 메뉴 목록에 있는 메뉴는 추천하지 않는다.",
    "- time_min은 분 단위 정수, steps는 3~6개의 짧은 한국어 문장으로 쓴다.",
    "- 안전한 조리법만 제안한다.",
    "- 지정한 JSON 형식으로만 응답한다.",
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

async function callGemini(prompt) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY, // 키는 주소가 아닌 헤더로 보낸다
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
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

// AI 응답 글자를 검사해서 올바르면 메뉴 3개를, 아니면 null을 돌려준다.
function parseMenus(text, exclude) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null; // JSON으로 읽을 수 없음
  }
  const menus = data?.menus;
  if (!Array.isArray(menus) || menus.length !== 3) return null;

  for (const m of menus) {
    const ok =
      typeof m?.name === "string" && m.name.trim() &&
      Number.isFinite(m.time_min) && m.time_min > 0 &&
      isStringList(m.ingredients, false) &&
      isStringList(m.missing, true) &&
      isStringList(m.steps, false) &&
      !exclude.includes(m.name.trim());
    if (!ok) return null;
  }

  // 필요한 항목만 골라 깔끔하게 돌려준다.
  return menus.map((m) => ({
    name: m.name.trim(),
    time_min: Math.round(m.time_min),
    ingredients: m.ingredients,
    missing: m.missing,
    steps: m.steps,
  }));
}

// 최대 2번(처음 + 재시도 1회) 시도한다. 한도 초과(429)는 다시 해도 소용없으니 바로 포기.
async function recommendWithAI(input) {
  const prompt = buildPrompt(input);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const menus = parseMenus(await callGemini(prompt), input.exclude);
      if (menus) return { menus };
      console.warn(`AI 응답 검증 실패 (시도 ${attempt})`);
    } catch (err) {
      console.warn(`AI 호출 실패 (시도 ${attempt}): ${err.name === "AbortError" ? "시간 초과" : err.message}`);
      if (err.status === 429) return { reason: "ai_quota" };
    }
  }
  return { reason: "ai_error" };
}

// ---------- 5. 대체 경로 ----------

function fallback(input, reason) {
  const menus = recommendFromRecipes(input.ingredients, input.mood, input.exclude).map((m) => ({
    name: m.name,
    time_min: m.time_min,
    ingredients: m.ingredients,
    missing: m.missing,
    steps: m.steps,
  }));
  return { source: "fallback", reason, menus };
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
    if (cached) return res.status(200).json({ source: "ai", cached: true, menus: cached });

    if (!useQuota(getClientIp(req))) return res.status(200).json(fallback(input, "daily_limit"));

    const result = await recommendWithAI(input);
    if (!result.menus) return res.status(200).json(fallback(input, result.reason));

    setCached(key, result.menus);
    return res.status(200).json({ source: "ai", menus: result.menus });
  } catch (err) {
    console.error("예상치 못한 오류:", err.message);
    return res.status(200).json(fallback(input, "server_error"));
  }
};
