// 화면 테스트용 도우미: 설치된 Edge/Chrome을 화면 없이 띄우고, 끝나면 깨끗이 닫는다.
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, spawnSync } = require("child_process");

const EXIT_SKIPPED = 3; // 브라우저가 없어 건너뜀 (run-all.js 가 구분해서 보여 줌)
const SHOT_DIR = path.join(os.tmpdir(), "today-menu-test-shots"); // 스크린샷 저장 위치 (저장소 밖)
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  return [
    process.env.BROWSER_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => p && fs.existsSync(p));
}

function startBrowser(port) {
  const bin = findBrowser();
  if (!bin) {
    console.log("건너뜀: Edge/Chrome을 찾지 못했어요. (BROWSER_PATH 환경변수로 경로를 지정할 수 있어요)");
    process.exit(EXIT_SKIPPED);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "today-menu-profile-"));
  const proc = spawn(bin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

  async function stop() {
    // 브라우저 전체에 종료 명령을 보낸다. (프로세스만 끊으면 자식 프로세스가 남을 수 있음)
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await sleep(1000);
    } catch {}
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill();
    // 임시 프로필 삭제 (아직 파일을 잡고 있으면 다음 기회에 OS가 정리하도록 넘어감)
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
  return { stop };
}

module.exports = { startBrowser, sleep, SHOT_DIR, EXIT_SKIPPED };
