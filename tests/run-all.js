// 모든 테스트 실행: node tests/run-all.js
// API 키도, 설치할 것도 필요 없다. 실제 Gemini는 부르지 않는다. (약 2분)
const { spawnSync } = require("child_process");
const path = require("path");
const { EXIT_SKIPPED } = require("./browser.js");

const TESTS = [
  ["서버 (가짜 AI)", "server.test.js"],
  ["화면 (가짜 AI)", "browser-ai.test.js"],
  ["Plan.md 9번 점검 (키 없음)", "plan9.test.js"],
];

const results = TESTS.map(([label, file]) => {
  console.log(`\n=== ${label}: ${file}`);
  // 서버 함수의 console.warn 로그(stderr)는 테스트 결과와 섞이지 않게 숨기고, 비정상 종료 때만 보여 준다.
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 26, timeout: 5 * 60 * 1000 });
  process.stdout.write(run.stdout || "");
  if (run.status !== 0 && run.status !== EXIT_SKIPPED) console.log((run.stderr || "").split("\n").slice(-20).join("\n"));
  const count = (word) => ((run.stdout || "").match(new RegExp(`^${word} `, "gm")) || []).length;
  return { label, status: run.status, pass: count("PASS"), fail: count("FAIL") };
});

console.log("\n=== 결과");
for (const r of results) {
  const state = r.status === 0 ? "통과" : r.status === EXIT_SKIPPED ? "건너뜀(브라우저 없음)" : "실패";
  console.log(`${state.padEnd(6)} ${r.label}: 통과 ${r.pass}개, 실패 ${r.fail}개`);
}
const failed = results.some((r) => r.status !== 0 && r.status !== EXIT_SKIPPED);
console.log(failed ? "=> 실패한 테스트가 있어요." : "=> 끝났어요.");
process.exit(failed ? 1 : 0);
