// ==UserScript==
// @name         POE1&2 Alert (WS → XHR → alert)
// @version      2026-08-05-015
// @description  POE1/POE2 live search alert & auto hideout
// @match        https://poe.kakaogames.com/trade2/search/poe2/*/live
// @match        https://poe.kakaogames.com/trade/search/*/live
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
// @downloadURL  https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
// ==/UserScript==

(function() {
    'use strict';

    /*********************************************************
     * 상태
     *********************************************************/
    // @version 헤더를 단일 출처로 삼는다. GM_info 가 없는 환경만 뒤의 값으로 폴백.
    const version =
        (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
        || 'unknown';

    let lastTeleport = null;   // 실제 hideout 클릭 시각
    let lastAlert = null;      // 마지막 알림 시각

    // 자동 이동 스위치는 둘이다. 실효 상태는 두 개가 모두 켜졌을 때뿐이다.
    //
    //   autoHideoutArmed — 모든 탭 스위치. 탭 간 공유되고 localStorage 에 남는다.
    //                      기본값 OFF.
    //   tabEnabled       — 이 탭만 임시로 빼두는 스위치. 공유하지 않고 저장도
    //                      하지 않는다. 기본값 사용(ON), 새로고침하면 되돌아온다.
    //
    // 왜 나누나: 여러 탭에 서로 다른 검색을 띄워두고 그중 한 탭만 잠깐
    // 재우고 싶은데, 전체를 끄면 다른 탭까지 같이 죽는다.
    let autoHideoutArmed = false;
    let tabEnabled = true;

    // 홈(파인 면)의 색. 카드 바탕이 무엇이냐에 따라 같이 움직인다.
    function wellBg() {

        return hideoutActive() ? WELL_BG_ON : WELL_BG;

    }

    // "작동 중" = 지금 이 화면에서 실제로 은신처로 끌려갈 수 있는 상태.
    // 막는 건 자동 이동뿐이다. 알림은 어느 쪽을 꺼도 그대로 나간다.
    function hideoutActive() {

        return autoHideoutArmed && tabEnabled;

    }

    // 텔레포트가 진행 중(버튼 대기 또는 클릭 예약)인지. 트리거가 연달아 와도 클릭이 중첩되지 않게 막는다.
    let hideoutPending = false;

    const usedItemIds = new Set();

    // 검색(/api/trade*/search) 응답이 돌려준 매물 id → 기록 시각(ms).
    // 라이브 소켓이 밀어준 매물과 구분하는 유일한 근거다 — 아래 "매물 출처" 참고.
    const searchOriginIds = new Map();

    let serverAlive = false;

    // 라이브 소켓 관찰 지표. updateStatus 가 초기화 중에 바로 읽으므로
    // (오버레이의 Live 줄) 여기서 선언해야 한다 — 아래에 두면 TDZ 로 터진다.
    let liveSocketCount = 0;   // 관찰한 소켓 수
    let livePushCount = 0;     // 소켓이 알려준 매물 수

    const COOLDOWN_MS = 30_000;
    const MAX_ITEM_AGE_MS = 60_000;

    // usedItemIds 무한 증가 방지: 상한 초과 시 가장 오래된 항목부터 버린다.
    const MAX_USED_IDS = 1000;

    // searchOriginIds 도 같은 방식으로 제한한다. 검색 1회가 수십~수백 건을 돌려주므로
    // 상한을 더 크게 잡는다.
    const MAX_SEARCH_IDS = 5000;

    // 검색 결과 중 끝내 fetch 되지 않은 id 를 이 시간이 지나면 잊는다.
    // (fetch 된 id 는 그 즉시 지우므로 여기까지 오지 않는다.)
    const SEARCH_ORIGIN_TTL_MS = 30 * 60_000;

    // hideout 버튼을 이 시간까지 못 찾으면 관찰을 포기한다.
    const HIDEOUT_WAIT_TIMEOUT_MS = 15_000;

    // 이동 1회 성공 후 모든 탭 스위치를 자동으로 끈다.
    // 쿨다운(COOLDOWN_MS)은 간격만 벌리므로, 켜 둔 채 자리를 비우면 매물이 뜰
    // 때마다 계속 이동한다. 자동으로 꺼지는 것이 그걸 끊는 유일한 정지점이다.
    // 연속 이동을 원하면 false 로 두고 쿨다운에만 의존한다.
    const DISARM_AFTER_TELEPORT = true;

    // 라이브 소켓이 밀어준 매물만 자동 이동시킨다 (아래 "라이브 소켓" 참고).
    // false 로 내리면 라이브 확인 없이 이동한다 — 수동 검색에도 이동하던 예전 동작.
    // 소켓을 못 잡는 상황에서 급히 되돌리기 위한 스위치다.
    //
    // 오버레이(updateStatus)가 초기화 중에 바로 읽으므로 여기 있어야 한다.
    // 라이브 소켓 절에 두면 TDZ 로 터진다.
    const REQUIRE_LIVE_PUSH = true;

    const SERVER_BASE = 'http://127.0.0.1:5001';

    // 헬스체크 응답이 이 시간 안에 안 오면 서버를 죽은 것으로 표시한다.
    const HEALTH_TIMEOUT_MS = 300;

    // 탭 간 공유 상태. @match 가 모두 같은 오리진(poe.kakaogames.com)이라
    // localStorage 하나로 POE1/POE2 탭까지 전부 묶인다.
    // storage 이벤트는 값을 바꾼 탭에서는 발화하지 않으므로 그대로 브로드캐스트로 쓴다.
    const LS_ARMED = 'poeAutoHideout.armed';            // '1' | '0'
    const LS_LAST_TELEPORT = 'poeAutoHideout.lastTeleport';  // epoch ms 문자열


    /*********************************************************
     * 로그
     *
     * 규칙
     *  1. 모든 줄은 `[POE][SCOPE]` 로 시작한다.
     *  2. 레벨을 의미로 구분한다.
     *       log  — 정상 흐름
     *       warn — 기능이 동작하지 않았지만 복구 가능 / 예상 범위
     *       fail — 예외 또는 고쳐야 하는 이상. 예외 객체를 반드시 함께 넘긴다.
     *  3. 한 사건은 한 줄로 찍는다 (여러 줄로 쪼개지 않는다).
     *  4. 아이템 id 는 앞 8자로 줄여 `id=xxxxxxxx` 형태로 넣는다.
     *     DOM 의 data-id 앞부분과 그대로 대조할 수 있다.
     *
     * SCOPE 목록
     *   INIT     스크립트 시작 / 후킹 설치
     *   UI       오버레이, 토글 버튼
     *   HOOK     fetch / search 응답 가로채기
     *   LIVE     라이브 소켓 관찰 / 푸시 수신
     *   POE1     POE1 매물 처리
     *   POE2     POE2 매물 처리
     *   HIDEOUT  은신처 버튼 대기 / 클릭
     *   ALERT    로컬 알림 서버 통신
     *   SYNC     탭 간 상태 공유
     *********************************************************/
    const LOG_TAG = 'POE';

    function log(scope, ...rest) {
        console.log(`[${LOG_TAG}][${scope}]`, ...rest);
    }

    function warn(scope, ...rest) {
        console.warn(`[${LOG_TAG}][${scope}]`, ...rest);
    }

    function fail(scope, ...rest) {
        console.error(`[${LOG_TAG}][${scope}]`, ...rest);
    }

    function shortId(id) {

        if (typeof id !== 'string' || !id) return '?';

        return id.length > 8 ? id.slice(0, 8) : id;

    }


    /*********************************************************
     * 탭 간 공유 저장소
     *
     * localStorage 는 시크릿 모드나 사이트 데이터 차단 설정에서 던질 수 있다.
     * 그 경우 공유를 포기하고 탭 단독으로 계속 동작한다. 조용히 반쪽만 도는 걸
     * 막기 위해 한 번은 반드시 경고를 남긴다.
     *********************************************************/
    let lsFailReported = false;

    function reportLsFailure(op, e) {

        if (lsFailReported) return;

        lsFailReported = true;

        warn('SYNC', `localStorage ${op} 실패 — 탭 간 공유를 끄고`
             + ' 이 탭 단독으로만 동작한다 (이후 동일 경고는 생략)', e);

    }

    function lsRead(key) {

        try {

            return localStorage.getItem(key);

        } catch (e) {

            reportLsFailure('읽기', e);
            return null;

        }

    }

    function lsWrite(key, value) {

        try {

            localStorage.setItem(key, value);
            return true;

        } catch (e) {

            reportLsFailure('쓰기', e);
            return false;

        }

    }

    // 공유된 모든 탭 스위치 상태. 키가 없으면(첫 탭) null 을 준다.
    // false 와 null 을 구분해야 새 탭이 기존 상태를 덮어쓰지 않는다.
    function readSharedArmed() {

        const raw = lsRead(LS_ARMED);

        if (raw === null) return null;

        return raw === '1';

    }

    function readSharedTeleportMs() {

        const raw = lsRead(LS_LAST_TELEPORT);

        if (raw === null) return null;

        const ms = Number(raw);

        return Number.isFinite(ms) ? ms : null;

    }


    /*********************************************************
     * 랜덤 딜레이
     *********************************************************/
    function randomDelay(min = 234, max = 2345) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }


    /*********************************************************
     * UI 오버레이
     *
     * 거래소 위에 얹히는 패널이라 네 가지를 지킨다.
     *   1. 손가락으로 눌린다      — 조작 3개를 전부 큰 버튼으로 세로로 쌓는다
     *   2. 비켜줄 수 있다        — 끌어서 원하는 자리로. 위치는 기억한다
     *   3. 곁눈질로 읽힌다        — 작동 중이면 카드가 호박빛으로 물든다
     *   4. 숫자가 안 흔들린다      — 시각은 tabular-nums 로 자리를 고정한다
     *
     * 1 은 실제 사용 환경에서 나왔다. 이 도구는 휴대폰으로 PC 를 원격하면서
     * 쓰인다. 화면이 축소돼 보이니 작은 표적은 조준 자체가 노동이다.
     * 그래서 접었다 펴는 알약 하나로 시작하던 방식을 버렸다 — 가장 자주 하는
     * 조작(끄고 켜기)이 가장 어려운 조작이 돼버렸다.
     *
     * 지금은 3단이다. 세 버튼은 언제나 같은 자리에 있다.
     *   모든 탭 사용 ON/OFF
     *   이 탭 사용 ON/OFF
     *   자세히 보기 / 접기      ← 아래 상세만 여닫는다. 버튼 자리는 안 움직인다
     *
     * 접기 버튼이 상세 위에 있는 게 핵심이다. 상세 안이나 아래에 두면 열 때마다
     * 버튼이 움직여서, 접으려고 누른 곳에 다른 게 와 있다.
     *
     * 2 도 실제 불편에서 나왔다. 기본 자리(우하단)가 하필 결과 행의 은신처
     * 버튼과 겹쳐서, 상태를 보여주는 물건이 정작 눌러야 할 버튼을 가렸다.
     *
     * 색은 어두운 유리판에 상태색 세 개(호박/초록/빨강)만 쓴다.
     * 클래스명은 테스트가 노드를 찾는 손잡이다 (생성 순서에 기대지 않게).
     *********************************************************/
    // 거래소 배경이 거의 검정이라, 어두운 유리판은 배경에 먹혀 보이지 않는다.
    // 그래서 패널을 배경보다 "밝게" 띄운다. 카드는 밝은 회청색, 그 안의 비활성
    // 버튼은 오히려 더 어둡게 파서 깊이를 만든다 — 명도 차가 곧 경계선이다.
    const C = {
        text: '#eef1f5',
        muted: '#a2abb9',
        faint: '#6f7887',
        amber: '#f0a020',
        green: '#4ac25e',
        red: '#ff6b60'
    };

    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,'
        + ' "Helvetica Neue", Arial, sans-serif';

    const PANEL_W = 216;

    // 접혔을 때의 대략 높이. offsetHeight 를 못 읽는 경우의 보수적 하한이다.
    const PANEL_H = 120;

    const CARD_BG = 'rgba(38, 44, 56, 0.97)';          // 배경보다 밝다

    // 작동 중일 때의 카드 바탕. 같은 밝기에서 색만 호박 쪽으로 민다.
    // 테두리만 물들이면 화면 구석에서는 선 한 줄이라 놓친다. 면이 물들어야
    // 눈길이 안 가 있어도 "저거 켜져 있다" 가 읽힌다.
    const CARD_BG_ON = 'rgba(58, 47, 34, 0.97)';
    const CARD_BORDER = '1px solid rgba(255, 255, 255, 0.22)';
    const WELL_BG = '#13161d';                          // 카드보다 어두운 홈

    // 바탕이 호박빛으로 물들면 그 위의 홈도 같이 따뜻해져야 한다.
    // 차가운 회색 홈만 남으면 덧댄 것처럼 뜬다.
    const WELL_BG_ON = '#241c11';
    const WELL_BORDER = '1px solid rgba(255, 255, 255, 0.14)';

    // 검정 위에서는 그림자가 안 보인다. 바깥으로 밝은 테를 한 겹 둘러
    // 카드 경계를 만든다.
    const CARD_SHADOW = '0 10px 30px rgba(0, 0, 0, 0.7),'
        + ' 0 0 0 1px rgba(255, 255, 255, 0.06)';

    const GLOW_BORDER = '1px solid rgba(247, 187, 82, 0.75)';
    const GLOW_SHADOW = '0 10px 30px rgba(0, 0, 0, 0.7),'
        + ' 0 0 0 1px rgba(240, 160, 32, 0.35),'
        + ' 0 0 18px rgba(240, 160, 32, 0.20)';

    // 상세 접힘 여부와 위치. 탭을 새로 열어도 같은 자리에 있어야 하므로 저장한다.
    const LS_UI = 'poeAutoHideout.ui';   // {c:상세 접힘, r:right px, b:bottom px}

    const UI_DEFAULT_POS = { right: 20, bottom: 80 };

    // 상세는 기본 접힘. 버튼 3개는 항상 보인다 — 접히는 건 아래 표뿐이다.
    let uiCollapsed = true;
    let uiPos = { right: UI_DEFAULT_POS.right, bottom: UI_DEFAULT_POS.bottom };

    function readUiPrefs() {

        const raw = lsRead(LS_UI);

        if (!raw) return;

        try {

            const o = JSON.parse(raw);

            if (typeof o.c === 'boolean') uiCollapsed = o.c;

            if (Number.isFinite(o.r) && Number.isFinite(o.b)) {
                uiPos = { right: o.r, bottom: o.b };
            }

        } catch (e) {

            warn('UI', '저장된 오버레이 설정을 읽지 못했다 — 기본값으로 시작한다', e);

        }

    }

    function saveUiPrefs() {

        lsWrite(LS_UI, JSON.stringify({
            c: uiCollapsed,
            r: Math.round(uiPos.right),
            b: Math.round(uiPos.bottom)
        }));

    }

    readUiPrefs();

    // overlay 는 위치만 잡는 투명한 껍데기다. 보이는 것은 panel 이 갖는다.
    const overlay = document.createElement('div');

    overlay.className = 'poe-overlay';

    overlay.style.cssText = `
position: fixed;
z-index: 999999;
color: ${C.text};
font-family: ${FONT};
font-size: 11px;
line-height: 1.5;
user-select: none;
`;

    const panel = document.createElement('div');

    panel.className = 'poe-panel';

    panel.style.cssText = `
box-sizing: border-box;
width: ${PANEL_W}px;
padding: 10px;
background: ${CARD_BG};
backdrop-filter: blur(10px);
-webkit-backdrop-filter: blur(10px);
border: ${CARD_BORDER};
border-radius: 12px;
box-shadow: ${CARD_SHADOW};
opacity: 1;
transition: box-shadow .25s ease, border-color .25s ease;
`;

    // 평소엔 한 발 물러나 있다가 볼 때만 또렷해진다.
    // 예전엔 평소 흐렸다가 마우스를 올리면 또렷해졌다. 검정 배경 위에서는
    // 그 흐림이 곧 "안 보임" 이라 없앤다 — 대신 자리를 옮길 수 있게 해뒀다.

    // 버튼 두 개가 무엇을 켜고 끄는지는 여기서 한 번만 말한다.
    // 버튼마다 "자동이동" 을 붙이면 두 번 읽히고 폭만 잡아먹는다.
    const caption = document.createElement('div');

    caption.className = 'poe-caption';

    caption.textContent = '자동 은신처 이동';

    caption.style.cssText = `
margin: 0 0 7px;
color: ${C.muted};
font-size: 9.5px;
font-weight: 600;
letter-spacing: 0.6px;
`;

    const hideoutBtn = document.createElement('button');

    hideoutBtn.className = 'poe-ho-btn';

    hideoutBtn.textContent = '모든 탭 OFF';

    // 두 스위치는 한 줄에 반씩 나눠 선다. 세로로 쌓으면 카드가 그만큼 길어지고,
    // 길어진 카드는 결국 가리는 면적이다. 높이(padding)는 줄이지 않는다 —
    // 원격 화면에서 손가락으로 누르는 물건이라 세로 여유가 조준을 좌우한다.
    const switchRow = document.createElement('div');

    switchRow.style.cssText = `
display: flex;
gap: 6px;
margin: 0 0 6px;
`;

    hideoutBtn.style.cssText = `
flex: 1 1 0;
min-width: 0;
box-sizing: border-box;
padding: 11px 4px;
font-family: inherit;
font-size: 11.5px;
font-weight: 700;
letter-spacing: 0.2px;
text-align: center;
white-space: nowrap;
cursor: pointer;
border: none;
border-radius: 8px;
transition: background .15s ease, color .15s ease, box-shadow .15s ease;
`;

    // 이 탭만 재우는 스위치. 상위 스위치보다 조용하게(테두리만) 두되 크기는
    // 줄이지 않는다 — 조용한 것과 누르기 어려운 것은 다른 얘기다.
    const tabBtn = document.createElement('button');

    tabBtn.className = 'poe-tab-btn';

    tabBtn.textContent = '이 탭 ON';

    tabBtn.style.cssText = `
flex: 1 1 0;
min-width: 0;
box-sizing: border-box;
padding: 11px 4px;
font-family: inherit;
font-size: 11.5px;
font-weight: 700;
letter-spacing: 0.2px;
text-align: center;
white-space: nowrap;
cursor: pointer;
border-radius: 8px;
transition: background .15s ease, color .15s ease, border-color .15s ease;
`;

    // 3단째. 아래 상세만 여닫는다. 이 버튼 자체는 상세 위에 고정이라
    // 열든 접든 자리가 안 움직인다 — 접으려고 누른 곳에 다른 게 오면 안 된다.
    const detailBtn = document.createElement('button');

    detailBtn.className = 'poe-detail-btn';

    detailBtn.style.cssText = `
display: block;
box-sizing: border-box;
width: 100%;
margin: 0;
padding: 8px 10px;
font-family: inherit;
font-size: 10.5px;
font-weight: 600;
letter-spacing: 0.4px;
cursor: pointer;
background: transparent;
border-radius: 8px;
transition: color .15s ease, border-color .15s ease;
`;

    // 상세는 이 안에 모아 한 번에 여닫는다.
    const details = document.createElement('div');

    details.className = 'poe-details';

    details.style.cssText = 'margin-top: 10px;';

    const grid = document.createElement('div');

    grid.style.cssText = `
display: grid;
grid-template-columns: auto 1fr;
gap: 3px 10px;
align-items: baseline;
`;

    // 라벨/값 한 줄을 만들고 값 노드를 돌려준다. updateStatus 는 값만 고쳐 쓴다.
    function addRow(label, key) {

        const l = document.createElement('div');

        l.textContent = label;

        l.style.cssText = `
color: ${C.muted};
font-size: 9.5px;
font-weight: 600;
letter-spacing: 0.6px;
text-transform: uppercase;
white-space: nowrap;
`;

        const v = document.createElement('div');

        v.className = `poe-v-${key}`;

        v.style.cssText = `
text-align: right;
font-variant-numeric: tabular-nums;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
`;

        grid.appendChild(l);
        grid.appendChild(v);

        return v;

    }

    const vStatus = addRow('Status', 'status');
    const vServer = addRow('Server', 'server');
    const vLive = addRow('Live', 'live');
    const vAlert = addRow('Alert', 'alert');
    const vTeleport = addRow('Teleport', 'teleport');

    const footer = document.createElement('div');

    footer.className = 'poe-version';

    footer.textContent = `v${version}`;

    footer.style.cssText = `
margin-top: 8px;
padding-top: 7px;
border-top: 1px solid rgba(255, 255, 255, 0.12);
color: ${C.faint};
font-size: 9px;
letter-spacing: 0.3px;
text-align: right;
`;

    details.appendChild(grid);
    details.appendChild(footer);

    switchRow.appendChild(hideoutBtn);
    switchRow.appendChild(tabBtn);

    panel.appendChild(caption);
    panel.appendChild(switchRow);
    panel.appendChild(detailBtn);
    panel.appendChild(details);

    overlay.appendChild(panel);

    // 오버레이가 못 붙어도 알림/텔레포트는 계속 동작해야 한다.
    // (status 는 분리된 노드로 남아 updateStatus 가 그대로 쓴다.)
    //
    // @run-at 이 document-start 라 이 시점에는 body 가 아직 없다.
    // 후킹을 사이트보다 먼저 걸려면 그 편이 맞고 — 특히 라이브 소켓은 우리보다
    // 먼저 열리면 영영 못 본다 — 오버레이만 body 가 생길 때까지 미룬다.
    function attachOverlay() {

        try {

            document.body.appendChild(overlay);

        } catch (e) {

            fail('UI', '오버레이를 body 에 붙이지 못했다'
                 + ' — 상태 표시 없이 계속 진행한다', e);

        }

    }

    if (document.body) {

        attachOverlay();

    } else {

        document.addEventListener('DOMContentLoaded', attachOverlay, { once: true });

    }


    /*********************************************************
     * 버튼 동작
     *********************************************************/
    hideoutBtn.onclick = () => {

        if (swallowClickAfterDrag()) return;

        setAutoHideout(!autoHideoutArmed, '버튼 클릭');

    };

    tabBtn.onclick = () => {

        if (swallowClickAfterDrag()) return;

        setTabEnabled(!tabEnabled, '버튼 클릭');

    };

    detailBtn.onclick = () => {

        if (swallowClickAfterDrag()) return;

        setCollapsed(!uiCollapsed);

    };

    function setCollapsed(state) {

        uiCollapsed = state;

        renderCollapsed();
        saveUiPrefs();

    }

    function renderCollapsed() {

        details.style.display = uiCollapsed ? 'none' : 'block';

        renderDetailBtn();

    }

    // 상세를 접어두면 소켓 상태가 안 보인다. 그런데 "켜뒀는데 소켓이 없다" 는
    // 켜진 줄 알고 자리를 비우게 만드는 상태라 접힌 채로도 드러나야 한다.
    function renderDetailBtn() {

        const blind = REQUIRE_LIVE_PUSH && hideoutActive() && liveSocketCount === 0;

        detailBtn.textContent = (uiCollapsed ? '자세히 보기  ▾' : '접기  ▴')
            + (blind ? '   · 소켓 없음' : '');

        detailBtn.style.color = blind ? C.red : C.muted;

        detailBtn.style.border = blind
            ? '1px solid rgba(255, 107, 96, 0.65)'
            : WELL_BORDER;

        detailBtn.style.background = blind
            ? 'rgba(255, 107, 96, 0.14)'
            : wellBg();

    }

    // 지금 창 안에 완전히 들어오도록 가둔 좌표.
    //
    // right/bottom 기준이라 왼쪽에 놓을수록 right 가 커진다. 창이 좁아지면
    // (개발자 도구를 열면) 그 큰 값이 그대로 남아 패널이 왼쪽 밖으로 밀려나
    // 사라졌다. 예전에 우하단 고정일 때 문제가 없었던 건 right 가 늘 20 이라
    // 어떤 창 크기에서도 화면 안이었기 때문이다.
    function clampPos(pos) {

        const { w, h } = viewport();

        const pw = (panel && panel.offsetWidth) || PANEL_W;
        const ph = (panel && panel.offsetHeight) || PANEL_H;

        return {
            right: clamp(pos.right, 0, Math.max(0, w - pw)),
            bottom: clamp(pos.bottom, 0, Math.max(0, h - ph))
        };

    }

    // 저장된 uiPos 는 "사용자가 원한 자리" 이고, 여기서 가두는 건 그리기용이다.
    // uiPos 자체를 고치지 않는 게 중요하다 — 개발자 도구를 닫아 창이 돌아오면
    // 원래 자리로 복귀해야지, 좁았을 때 밀린 자리에 눌러앉으면 안 된다.
    function applyUiPos() {

        const at = clampPos(uiPos);

        overlay.style.right = `${Math.round(at.right)}px`;
        overlay.style.bottom = `${Math.round(at.bottom)}px`;

    }


    /*********************************************************
     * 끌어서 옮기기
     *
     * 기본 자리가 하필 은신처 버튼과 겹친다는 게 출발점이다. 어느 자리가
     * 안전한지는 사이트 레이아웃과 창 크기에 달렸으니, 고르는 건 사람에게 맡긴다.
     *
     * 버튼 위에서도 끌 수 있게 하되, 4px 을 넘게 움직였을 때만 이동으로 친다.
     * 그러지 않으면 손이 살짝 흔들린 토글이 전부 이동이 되거나 그 반대가 된다.
     * 이동으로 판정되면 뒤따르는 click 은 삼킨다 — 옮기려다 껐다 켜지면 곤란하다.
     *********************************************************/
    const DRAG_THRESHOLD_PX = 4;

    let dragState = null;
    let dragJustFinished = false;

    function swallowClickAfterDrag() {

        if (!dragJustFinished) return false;

        dragJustFinished = false;
        return true;

    }

    function clamp(v, lo, hi) {

        return v < lo ? lo : (v > hi ? hi : v);

    }

    function viewport() {

        const w = (typeof window !== 'undefined' && window.innerWidth) || 1920;
        const h = (typeof window !== 'undefined' && window.innerHeight) || 1080;

        return { w, h };

    }

    overlay.onmousedown = (e) => {

        if (!e || e.button !== 0) return;

        dragState = {
            x: e.clientX,
            y: e.clientY,
            right: uiPos.right,
            bottom: uiPos.bottom,
            moved: false
        };

    };

    function onDragMove(e) {

        if (!dragState) return;

        const dx = e.clientX - dragState.x;
        const dy = e.clientY - dragState.y;

        if (!dragState.moved
            && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;

        dragState.moved = true;

        // right/bottom 기준이라 마우스와 부호가 반대다.
        uiPos = clampPos({
            right: dragState.right - dx,
            bottom: dragState.bottom - dy
        });

        applyUiPos();

        if (e.preventDefault) e.preventDefault();

    }

    function onDragEnd() {

        if (!dragState) return;

        const moved = dragState.moved;

        dragState = null;

        if (!moved) return;

        dragJustFinished = true;
        saveUiPrefs();

        log('UI', `오버레이 위치 저장 (right ${Math.round(uiPos.right)},`
            + ` bottom ${Math.round(uiPos.bottom)})`);

    }

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);

    // 창 크기가 바뀌면 다시 가둔다. 개발자 도구를 열거나 창을 줄이면 저장된
    // 자리가 화면 밖이 될 수 있고, 그러면 다시 잡을 방법이 없다.
    if (window && window.addEventListener) {

        window.addEventListener('resize', applyUiPos);

    }

    // 두 스위치의 조합을 한 곳에서 그린다. 각자 자기 버튼만 고치게 두면
    // "모든 탭 ON + 이 탭 OFF" 같은 조합에서 화면이 거짓말을 하게 된다.
    //
    // 둘은 대등하지 않다. "모든 탭" 이 상위 조건이고 "이 탭" 은 그 아래서만
    // 의미를 갖는다 — 모든 탭이 OFF 면 이 탭을 뭘로 두든 이동은 없다.
    // 그러니 흐려지는 쪽은 항상 하위다. 상위를 흐리게 하면 종속 관계가 뒤집혀
    // 보이고, "모든 탭 OFF 인데 이 탭 ON 이니까 이 탭은 움직이나?" 로 읽힌다.
    function renderControls() {

        const active = hideoutActive();

        hideoutBtn.textContent = autoHideoutArmed ? '모든 탭 ON' : '모든 탭 OFF';

        // 상위 스위치는 어떤 조합에서도 흐려지지 않는다. 전역 상태를 있는 그대로.
        hideoutBtn.style.opacity = '1';

        if (autoHideoutArmed) {

            hideoutBtn.style.background =
                'linear-gradient(180deg, #f7bb52 0%, #e8961a 100%)';
            hideoutBtn.style.color = '#1a1206';
            hideoutBtn.style.boxShadow = '0 2px 10px rgba(240, 160, 32, 0.30)';

        } else {

            hideoutBtn.style.background = wellBg();
            hideoutBtn.style.color = C.muted;
            hideoutBtn.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.14)';

        }

        tabBtn.textContent = tabEnabled ? '이 탭 ON' : '이 탭 OFF';

        if (tabEnabled) {

            tabBtn.style.border = WELL_BORDER;
            tabBtn.style.color = C.text;
            tabBtn.style.background = wellBg();

        } else {

            tabBtn.style.border = '1px solid rgba(255, 107, 96, 0.65)';
            tabBtn.style.color = C.red;
            tabBtn.style.background = 'rgba(255, 107, 96, 0.14)';

        }

        // 모든 탭이 OFF 면 이 탭 스위치는 아무 일도 하지 않는다. 눌러도 되지만
        // (미리 꺼둘 수 있다) 지금은 결정권이 없다는 걸 흐림으로 말한다.
        tabBtn.style.opacity = autoHideoutArmed ? '1' : '0.4';

        // 카드가 빛나는 건 "지금 여기서 실제로 이동한다" 는 뜻이어야 한다.
        // 모든 탭만 켜진 상태에서 빛나면 재워둔 탭이 작동 중인 것처럼 보인다.
        panel.style.background = active ? CARD_BG_ON : CARD_BG;
        panel.style.border = active ? GLOW_BORDER : CARD_BORDER;
        panel.style.boxShadow = active ? GLOW_SHADOW : CARD_SHADOW;

        renderDetailBtn();

    }

    // 이 탭만 재우거나 깨운다. 저장소에 쓰지 않으므로 다른 탭은 영향받지 않고,
    // 새로고침하면 기본값(사용)으로 돌아온다 — "임시" 스위치라 그게 맞다.
    function setTabEnabled(state, reason) {

        log('UI', `이 탭 자동이동 ${state ? 'ON' : 'OFF'}`
            + (reason ? ` — ${reason}` : ''));

        tabEnabled = state;

        // 재우는 순간 대기 중이거나 예약된 이동도 함께 취소한다.
        // 안 그러면 방금 정지시켰는데 몇 초 뒤에 끌려간다.
        if (!state) cancelHideout();

        renderControls();

    }

    // 이 탭에만 상태를 적용한다. 저장소에 쓰지 않으므로 다른 탭에서 온 변경을
    // 반영할 때 쓴다 (여기서 쓰면 탭끼리 서로 되쏘며 무한 반복한다).
    //
    // reason 은 왜 상태가 바뀌었는지 한 줄에 함께 남기기 위한 것이다.
    // 자동 해제 / 버튼 클릭 / 다른 탭을 콘솔에서 구분할 수 있어야 한다.
    function applyAutoHideout(state, reason) {

        log('UI', `모든 탭 자동이동 ${state ? 'ON' : 'OFF'}`
            + (reason ? ` — ${reason}` : ''));

        autoHideoutArmed = state;

        // 끄면 대기 중이거나 예약된 텔레포트도 함께 취소한다.
        // 다른 탭이 껐을 때도 이 경로를 타므로 예약된 클릭이 확실히 취소된다.
        if (!state) cancelHideout();

        renderControls();

    }

    // 이 탭에 적용하고 다른 탭에도 전파한다. 사용자 조작과 자동 해제가 쓰는 쪽.
    function setAutoHideout(state, reason) {

        applyAutoHideout(state, reason);

        lsWrite(LS_ARMED, state ? '1' : '0');

    }


    /*********************************************************
     * 상태 표시
     *********************************************************/
    // 서버 헬스체크 콜백이 'Notified' 를 즉시 덮어쓰지 않도록 마지막 상태를 기억한다.
    let statusText = 'Running';

    // 값 + 색을 함께 쓴다. 색만으로 뜻을 전하지 않도록 글자도 항상 같이 바꾼다.
    function setValue(node, text, color) {

        node.textContent = text;
        node.style.color = color || C.text;

    }

    function updateStatus(text) {

        if (text !== undefined) statusText = text;

        const fmt = (d) => (d ? d.toLocaleTimeString() : '—');

        setValue(vStatus, statusText);

        setValue(vServer,
                 serverAlive ? '● ON' : '● OFF',
                 serverAlive ? C.green : C.faint);

        // Live 는 라이브 소켓이 실제로 관찰되고 있는지 눈으로 확인하는 줄이다.
        // 소켓이 0이면 자동 이동은 절대 발동하지 않으므로(REQUIRE_LIVE_PUSH)
        // 그건 "정보" 가 아니라 "고장" 이다. 빨간색으로 띄운다.
        if (liveSocketCount) {

            setValue(vLive, `● ${liveSocketCount} / 푸시 ${livePushCount}`, C.green);

        } else {

            setValue(vLive, '● 소켓 없음',
                     REQUIRE_LIVE_PUSH ? C.red : C.faint);

        }

        setValue(vAlert, fmt(lastAlert), lastAlert ? C.text : C.faint);
        setValue(vTeleport, fmt(lastTeleport), lastTeleport ? C.text : C.faint);

        // 소켓이 죽고 사는 건 접기 버튼에도 나타나야 한다 (상세를 접어둘 수 있으므로).
        renderDetailBtn();

    }

    applyUiPos();
    renderCollapsed();

    updateStatus('Running');


    /*********************************************************
     * hideout 클릭
     *********************************************************/
    const HIDEOUT_BTN_SELECTOR = 'button.direct-btn';

    // 결과 행은 <div class="row" data-id="<fetch 응답의 r.id>"> 형태다.
    //
    // 검증 범위: POE1(/trade) 의 실제 응답과 DOM 을 짝으로 대조해
    //   data-id === result[].id === result[].item.id 를 확인했고, 브라우저에서도 동작 확인.
    // POE2(/trade2) 마크업은 아직 미확인이다. 새 시즌에서 확인할 것.
    // 구조가 다르면 알림은 그대로 동작하고(JSON 기반) 자동 은신처만 실패하며,
    // 대기 타임아웃에서 "행이 렌더링되지 않음" 경고로 드러난다.
    //
    // 이 함수는 MutationObserver 가 렌더링 중 수십 번 호출한다. 그래서 탐색 실패는
    // 한 번만 찍는다 (매 호출마다 찍으면 콘솔이 잠겨 정작 원인을 못 본다).
    let rowLookupFailReported = false;

    function findRow(itemId) {

        if (!itemId) return null;

        try {

            return document.querySelector(
                `div.row[data-id="${CSS.escape(itemId)}"]`
            );

        } catch (e) {

            if (!rowLookupFailReported) {

                rowLookupFailReported = true;

                fail('HIDEOUT', `행 탐색 실패 id=${shortId(itemId)}`
                     + ' (이후 동일 오류는 생략한다)', e);

            }

            return null;

        }

    }

    // 트리거한 매물의 행만 노린다.
    // 화면 위치로 고르면 안 된다: JSON 후킹은 Vue 렌더링 전에 발화하므로,
    // 그 시점의 맨 위 행은 직전(오래된) 매물이다.
    //
    // 여기서는 못 찾아도 로그를 남기지 않는다. MutationObserver 가 렌더링 중에
    // 수십 번 호출하므로 콘솔이 잠긴다. 진단 로그는 대기 타임아웃에서 한 번만 찍는다.
    function findHideoutButton(itemId) {

        const row = findRow(itemId);

        if (!row) return null;

        // 행 안에서는 direct-btn 이 은신처 버튼 하나뿐이다 (차단은 ignore-btn).
        return row.querySelector(HIDEOUT_BTN_SELECTOR);

    }

    let hideoutObserver = null;
    let hideoutWaitTimeoutId = null;
    let hideoutClickTimeoutId = null;

    // 버튼 탐색만 중단한다 (관찰자 + 탐색 타임아웃).
    function stopWaitingForHideout() {

        if (hideoutObserver) {
            hideoutObserver.disconnect();
            hideoutObserver = null;
        }

        if (hideoutWaitTimeoutId !== null) {
            clearTimeout(hideoutWaitTimeoutId);
            hideoutWaitTimeoutId = null;
        }

    }

    // 진행 중인 텔레포트 자체를 취소한다 (예약된 클릭까지 포함).
    function cancelHideout() {

        stopWaitingForHideout();

        if (hideoutClickTimeoutId !== null) {
            clearTimeout(hideoutClickTimeoutId);
            hideoutClickTimeoutId = null;
        }

        hideoutPending = false;

    }

    // 쿨다운 기준 시각. 다른 탭의 이동까지 포함해야 하므로 저장소를 함께 본다.
    // 저장소를 못 읽는 환경에서도 이 탭의 쿨다운은 유지된다.
    function getLastTeleportMs() {

        const shared = readSharedTeleportMs();
        const local = lastTeleport ? lastTeleport.getTime() : null;

        if (shared === null) return local;
        if (local === null) return shared;

        return Math.max(shared, local);

    }

    // 남은 쿨다운(ms). 0 이면 발동 가능.
    function hideoutCooldownRemaining() {

        const last = getLastTeleportMs();

        if (last === null) return 0;

        const elapsed = Date.now() - last;

        return elapsed >= COOLDOWN_MS ? 0 : COOLDOWN_MS - elapsed;

    }

    // 쿨다운: 마지막 실제 텔레포트로부터 COOLDOWN_MS 가 지나야 다시 발동한다.
    // 어느 탭에서 이동했는지는 상관없다.
    function canTriggerHideout(itemId) {

        if (hideoutPending) {

            log('HIDEOUT', `skip: 이미 진행 중 id=${shortId(itemId)}`);
            return false;

        }

        const remaining = hideoutCooldownRemaining();

        if (remaining > 0) {

            log('HIDEOUT',
                `skip: 쿨다운 ${Math.ceil(remaining / 1000)}s 남음 (탭 공유)`
                + ` id=${shortId(itemId)}`);

            return false;

        }

        return true;

    }

    function clickHideoutButton(btn, itemId) {

        const delay = randomDelay();

        log('HIDEOUT', `click 예약 ${delay}ms 후 id=${shortId(itemId)}`);

        hideoutClickTimeoutId = setTimeout(() => {

            hideoutClickTimeoutId = null;

            // 클릭이 나가면 이후 억제는 lastTeleport 기반 쿨다운이 담당한다.
            hideoutPending = false;

            // 예약과 실행 사이(최대 randomDelay)에 다른 탭이 이동했을 수 있다.
            // canTriggerHideout 은 예약 시점에만 봤으므로 여기서 한 번 더 본다.
            const remaining = hideoutCooldownRemaining();

            if (remaining > 0) {

                log('HIDEOUT',
                    `click 취소: 그 사이 다른 탭이 이동함`
                    + ` (쿨다운 ${Math.ceil(remaining / 1000)}s 남음) id=${shortId(itemId)}`);

                return;

            }

            simulateHumanClick(btn, itemId);

        }, delay);

    }

    function waitForHideoutButton(itemId) {

        // 이전 대기가 남아 있으면 정리한다 (관찰자 중복 방지).
        stopWaitingForHideout();

        hideoutPending = true;

        // 해당 행이 이미 렌더링돼 있으면 MutationObserver 는 발화하지 않으므로 먼저 확인한다.
        const existing = findHideoutButton(itemId);

        if (existing) {

            log('HIDEOUT', `버튼 이미 존재 id=${shortId(itemId)}`);
            clickHideoutButton(existing, itemId);
            return;

        }

        log('HIDEOUT', `버튼 대기 시작 id=${shortId(itemId)}`);

        hideoutObserver = new MutationObserver(() => {

            const btn = findHideoutButton(itemId);

            if (!btn) return;

            log('HIDEOUT', `버튼 발견 id=${shortId(itemId)}`);

            stopWaitingForHideout();
            clickHideoutButton(btn, itemId);

        });

        // document-start 로 앞당겼으므로 body 가 없을 수도 있다 (실제로는 결과 행이
        // 렌더링된 뒤에나 여기 오지만, null 을 넘기면 관찰 자체가 터진다).
        hideoutObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        // 끝내 안 나타나면 포기한다. 없으면 페이지가 살아 있는 동안 body 전체를 계속 관찰한다.
        hideoutWaitTimeoutId = setTimeout(() => {

            // 왜 못 찾았는지를 구분해 찍는다. 두 원인의 대처가 완전히 다르다.
            //   행 자체가 없음      → 렌더링 지연 / 필터에 걸려 화면에 안 뜬 매물
            //   행은 있고 버튼 없음 → 마크업 변경. 셀렉터를 고쳐야 한다.
            if (!findRow(itemId)) {

                warn('HIDEOUT',
                     `포기: ${HIDEOUT_WAIT_TIMEOUT_MS}ms 안에 행이 렌더링되지 않음`
                     + ` id=${shortId(itemId)}`);

            } else {

                fail('HIDEOUT',
                     `포기: 행은 있으나 "${HIDEOUT_BTN_SELECTOR}" 가 없음`
                     + ` — 거래소 마크업 변경 의심 id=${shortId(itemId)}`);

            }

            // 다른 행의 버튼으로 폴백하지 않는다. 오래된 매물로 텔레포트하는 것보다
            // 아무 것도 안 하는 편이 낫다.
            cancelHideout();
            updateStatus('HO timeout');

        }, HIDEOUT_WAIT_TIMEOUT_MS);

    }

    function simulateHumanClick(element, itemId) {

        if (!element) {

            fail('HIDEOUT', `click 중단: 버튼 요소가 없다 id=${shortId(itemId)}`);
            updateStatus('HO click failed');
            return;

        }

        try {

            // 버튼의 화면상 실제 좌표 및 정중앙 위치 계산
            const rect = element.getBoundingClientRect();
            const x = rect.left + (rect.width / 2);
            const y = rect.top + (rect.height / 2);

            // 사람의 클릭을 모방하기 위한 공통 이벤트 옵션
            const eventOptions = {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: 1,
                clientX: x,
                clientY: y
            };

            // 마우스 올리기 (Hover)
            element.dispatchEvent(new MouseEvent("mouseover", eventOptions));
            element.dispatchEvent(new MouseEvent("mouseenter", eventOptions));

            // 포커스 주기 (클릭 전 포커스가 가는 동작 모방)
            element.focus && element.focus();

            // 마우스 버튼 누르기
            element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
            element.dispatchEvent(new MouseEvent("mouseup", eventOptions));
            element.dispatchEvent(new MouseEvent("click", eventOptions));

        } catch (e) {

            // 이벤트 디스패치가 던지면 텔레포트는 일어나지 않았다.
            // lastTeleport 를 갱신하지 않으므로 쿨다운도 걸리지 않는다.
            fail('HIDEOUT', `click 실패 id=${shortId(itemId)}`, e);
            updateStatus('HO click failed');
            return;

        }

        log('HIDEOUT', `click 완료 id=${shortId(itemId)}`);

        // 실제로 클릭이 나간 시점만 텔레포트로 기록한다.
        lastTeleport = new Date();
        updateStatus('Teleported');

        // 다른 탭도 같은 쿨다운을 적용해야 한다.
        lsWrite(LS_LAST_TELEPORT, String(lastTeleport.getTime()));

        // 이동에 성공했으면 여기서 멈춘다. 실패 경로에서는 해제하지 않는다
        // (클릭이 안 나갔으므로 이동도 없었고, 다음 매물에서 다시 시도해야 한다).
        if (DISARM_AFTER_TELEPORT && autoHideoutArmed) {

            setAutoHideout(false, `이동 1회 완료 후 자동 해제 id=${shortId(itemId)}`);

        }

    }


    /*********************************************************
     * 알림
     *********************************************************/
    function focusTab(itemName) {

        try {

            document.title = '🔔🔔' + itemName;

        } catch (e) {

            // 이전에는 통째로 삼켰다. 탭 제목이 안 바뀌는 이유를 알 수 없었다.
            warn('ALERT', '탭 제목 변경 실패', e);

        }

    }


    /*********************************************************
     * 아이템 이름
     *********************************************************/
    function getItemName(r) {

        const item = r.item || {};

        if (item.name && item.name.trim()) {
            return `${item.name} ${item.typeLine||""}`.trim();
        }

        return item.typeLine || item.baseType || "Unknown Item";

    }


    /*********************************************************
     * 가격
     *********************************************************/
    function formatPrice(listing) {

        const price = listing?.price;

        if (!price) return "N/A";

        const amount = price.amount;
        const currency = price.currency;

        // amount 0 은 유효한 값이다 (가격을 잘못 매긴 헐값 매물).
        // falsy 검사로 걸러내면 정작 제일 중요한 매물의 가격이 N/A 가 된다.
        if (amount == null || !currency) return "N/A";

        return `${amount} ${currency}`;

    }


    /*********************************************************
     * 로컬 서버 alert
     *********************************************************/
    // @grant 누락이나 확장 비활성으로 GM API 가 없으면, 원인을 못 찾고
    // "알림이 안 온다" 로만 보인다. 한 번 명시적으로 찍는다.
    let gmMissingReported = false;

    function gmAvailable(scope) {

        if (typeof GM_xmlhttpRequest === 'function') return true;

        if (!gmMissingReported) {

            gmMissingReported = true;

            fail(scope, 'GM_xmlhttpRequest 를 쓸 수 없다'
                 + ' — @grant 누락이거나 Tampermonkey 가 비활성 상태다.'
                 + ' 로컬 서버 알림이 전부 동작하지 않는다.');

        }

        return false;

    }

    // GM_xmlhttpRequest 의 onload 는 404/500 에도 호출된다.
    // 상태 코드를 안 보면 죽은 서버를 살아 있다고 표시한다.
    function isOk(res) {

        return !!res && res.status >= 200 && res.status < 300;

    }

    // 서버 상태는 바뀔 때만 찍는다. 매 알림마다 찍으면 실제 오류가 묻힌다.
    function setServerAlive(alive, scope, reason) {

        if (serverAlive !== alive) {

            const line = `server ${alive ? 'UP' : 'DOWN'}`
                + (reason ? ` — ${reason}` : '');

            if (alive) log(scope, line);
            else warn(scope, line);

        }

        serverAlive = alive;
        updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

    }

    function postAlert(payload) {

        let body;

        try {

            body = JSON.stringify(payload);

        } catch (e) {

            fail('ALERT', `payload 직렬화 실패 id=${shortId(payload?.id)}`, e);
            return;

        }

        GM_xmlhttpRequest({

            method: "POST",
            url: `${SERVER_BASE}/alert`,
            headers: {
                "Content-Type": "application/json"
            },
            data: body,

            // 이 요청에는 원래 콜백이 하나도 없었다. 서버가 500 을 주거나
            // 연결이 끊겨도 콘솔에 아무 흔적이 남지 않아 조용히 알림을 잃었다.
            onload: (res) => {

                if (isOk(res)) {

                    log('ALERT', `sent id=${shortId(payload?.id)} (HTTP ${res.status})`);
                    return;

                }

                fail('ALERT',
                     `서버가 알림을 거부: HTTP ${res.status} id=${shortId(payload?.id)}`,
                     res.responseText);

            },

            onerror: (res) => {

                fail('ALERT',
                     `알림 전송 실패 id=${shortId(payload?.id)}`,
                     res?.error ?? res);

            },

            ontimeout: () => {

                fail('ALERT', `알림 전송 타임아웃 id=${shortId(payload?.id)}`);

            }

        });

    }

    function sendAlertIfServerAlive(payload) {

        if (!gmAvailable('ALERT')) {

            setServerAlive(false, 'ALERT', 'GM_xmlhttpRequest 없음');
            return;

        }

        let finished = false;

        const timeout = setTimeout(() => {

            if (finished) return;

            // finished 를 세우지 않는다. 늦게 도착한 응답은 그대로 반영해야 한다.
            setServerAlive(false, 'ALERT',
                           `health 응답 없음 (>${HEALTH_TIMEOUT_MS}ms)`);

        }, HEALTH_TIMEOUT_MS);

        GM_xmlhttpRequest({

            method: "GET",
            url: `${SERVER_BASE}/health`,

            onload: (res) => {

                finished = true;
                clearTimeout(timeout);

                if (!isOk(res)) {

                    setServerAlive(false, 'ALERT', `health HTTP ${res.status}`);
                    return;

                }

                setServerAlive(true, 'ALERT');

                postAlert(payload);

            },

            onerror: () => {

                finished = true;
                clearTimeout(timeout);

                setServerAlive(false, 'ALERT',
                               `health 연결 실패 (${SERVER_BASE} 미기동?)`);

            },

            ontimeout: () => {

                finished = true;
                clearTimeout(timeout);

                setServerAlive(false, 'ALERT', 'health 요청 타임아웃');

            }

        });

    }


    /*********************************************************
     * 서버 체크
     *********************************************************/
    function checkServerAliveOnce() {

        if (!gmAvailable('INIT')) {

            setServerAlive(false, 'INIT', 'GM_xmlhttpRequest 없음');
            return;

        }

        GM_xmlhttpRequest({

            method: "GET",
            url: `${SERVER_BASE}/health`,

            onload: (res) => {

                if (isOk(res)) setServerAlive(true, 'INIT');
                else setServerAlive(false, 'INIT', `health HTTP ${res.status}`);

            },

            onerror: () => {

                setServerAlive(false, 'INIT',
                               `health 연결 실패 (${SERVER_BASE} 미기동?)`);

            },

            ontimeout: () => {

                setServerAlive(false, 'INIT', 'health 요청 타임아웃');

            }

        });

    }

    // Set/Map 모두 삽입 순서를 유지하므로, 상한을 넘으면 앞쪽(가장 오래된)부터 버린다.
    // 순회 중 현재 항목을 지우는 건 두 자료구조 모두 안전하다.
    function trimOldest(coll, max) {

        if (coll.size <= max) return;

        const overflow = coll.size - max;
        let removed = 0;

        for (const old of coll.keys()) {
            coll.delete(old);
            if (++removed >= overflow) break;
        }

    }

    function expireOlderThan(map, now, ttl) {

        for (const [k, at] of map) {

            if (now - at > ttl) map.delete(k);

        }

    }

    function rememberItemId(id) {

        usedItemIds.add(id);
        trimOldest(usedItemIds, MAX_USED_IDS);

    }


    /*********************************************************
     * 매물 출처 (검색 결과 vs 라이브 푸시)
     *
     * 거래소는 두 경로 모두 같은 /api/trade(2)/fetch 로 매물 본문을 가져온다.
     *   수동 검색 / 페이지 최초 로드 → /search 응답(id 목록) → /fetch
     *   라이브 검색 푸시            → 웹소켓 → /fetch      (/search 를 거치지 않는다)
     *
     * 즉 /fetch 응답만 봐서는 둘을 구분할 수 없다. 구분하지 않으면,
     * 라이브가 꺼진 탭에서 손으로 검색만 해도 60초 이내 매물이 하나라도 있으면
     * 자동으로 은신처로 날아간다 (스위치는 탭 간 공유라 어느 탭이든 발동한다).
     *
     * 그래서 /search 가 돌려준 id 를 기억해 두고, 그 id 로 들어온 매물은
     * 자동 이동 대상에서 뺀다. /search 응답은 항상 /fetch 보다 먼저 도착한다
     * (fetch 가 그 id 목록을 써야 하므로 순서가 보장된다).
     *
     * 제외는 영구가 아니라 "그 검색에 딸린 fetch 1회" 로 한정한다.
     * 매물을 fetch 로 실어 오는 순간 기록을 지운다. 같은 매물이 나중에 재등록돼
     * 라이브로 다시 올라오면 그때는 정상적으로 이동해야 하기 때문이다.
     * 영구 제외로 두면 한 번 검색에 걸린 매물은 두 번 다시 못 잡는다.
     *
     * 끝까지 스크롤하지 않아 fetch 되지 않은 id 는 소비될 일이 없으므로
     * SEARCH_ORIGIN_TTL_MS 로 만료시킨다. 검색 결과를 한참 뒤에 스크롤하는 경우까지
     * 덮으려고 넉넉하게 잡았다 — 놓친 이동보다 엉뚱한 이동이 훨씬 나쁘다.
     *
     * 알림은 막지 않는다. 손으로 검색해서 띄운 결과에 알림이 오는 건 시끄러울 뿐
     * 되돌릴 수 없는 동작이 아니다. 게임을 움직이는 쪽만 막는다.
     *
     * 후킹이 /search 를 놓치면 예전 동작(구분 없음) 으로 돌아갈 뿐, 라이브 푸시로
     * 이동하는 본래 기능은 그대로 산다. 안전한 방향으로 실패한다.
     *********************************************************/
    function recordSearchResults(json, source) {

        const ids = json?.result;

        if (!Array.isArray(ids)) {

            warn(source, 'search 응답의 result 가 배열이 아니다'
                 + ' — 자동 이동이 수동 검색 결과에도 걸릴 수 있다', json);

            return;

        }

        const now = Date.now();

        // 소비되지 않고 남은 지난 검색의 찌꺼기를 먼저 걷어낸다.
        for (const [id, at] of searchOriginIds) {

            if (now - at > SEARCH_ORIGIN_TTL_MS) searchOriginIds.delete(id);

        }

        let added = 0;

        for (const id of ids) {

            if (typeof id !== 'string' || !id) continue;

            searchOriginIds.set(id, now);
            added++;

        }

        trimOldest(searchOriginIds, MAX_SEARCH_IDS);

        log(source, `search 결과 ${added}건 기록`
            + ' — 이 id 들은 뒤따르는 fetch 1회에 한해 자동 이동에서 제외');

    }

    // 이 fetch 응답 중 방금 그 검색이 실어 온 id 를 뽑고, 동시에 기록에서 지운다.
    //
    // 루프 안이 아니라 미리 한 번에 처리하는 이유:
    // processTradeResults 는 나이/중복으로 continue 하거나 첫 발동에서 break 하므로,
    // 루프에 맡기면 응답에 실려 온 id 중 일부만 소비된다. 소비되지 않은 id 는
    // 만료 전까지 계속 제외돼, 나중에 라이브로 올라와도 이동하지 않는다.
    function consumeSearchOrigin(results) {

        const fromSearch = new Set();

        for (const r of results) {

            const id = r?.id;

            if (!id || !searchOriginIds.has(id)) continue;

            fromSearch.add(id);
            searchOriginIds.delete(id);

        }

        return fromSearch;

    }


    /*********************************************************
     * 라이브 소켓 (자동 이동 허용 목록)
     *
     * /search 를 가로채 검색 결과를 빼는 방식은 실패했다. 거래소가 검색 응답을
     * Response.prototype.json 으로 읽지 않아 후킹에 아예 걸리지 않는다
     * (fetch 응답만 잡히고 진단 로그에도 다른 /api 응답이 안 남았다).
     *
     * 그래서 반대 방향으로 간다. "검색 결과를 뺀다" 가 아니라
     * "라이브 소켓이 밀어준 매물만 허용한다".
     *
     * 이쪽이 신호로서 더 정확하다. 사용자가 원하는 건 정확히 "라이브 검색에
     * 걸린 매물로만 이동" 이고, 그걸 아는 유일한 출처가 소켓이다.
     * 실패 방향도 낫다 — 신호를 놓치면 이동을 안 할 뿐, 엉뚱한 이동은 없다.
     *
     * 대신 신호를 놓치면 기능이 통째로 죽으므로 조용히 죽으면 안 된다.
     *   - 관찰한 소켓 URL 을 소켓당 한 번 남긴다
     *   - 형식을 못 알아본 메시지 원문을 한 번 남긴다
     *   - 오버레이에 Live 카운터를 띄운다 (소켓이 살아 있는지 눈으로 확인)
     *   - 막을 때마다 왜 막았는지 남긴다
     * 그래도 안 되면 REQUIRE_LIVE_PUSH 를 false 로 내려 예전 동작으로 되돌린다.
     *********************************************************/
    const MAX_LIVE_IDS = 500;

    // 소켓이 알려준 뒤 이 시간 안에 fetch 되지 않으면 잊는다.
    // 정상이면 수백 ms 안에 fetch 되므로 넉넉한 값이다.
    const LIVE_PUSH_TTL_MS = 5 * 60_000;

    // 소켓이 밀어준 매물 id → 수신 시각(ms).
    const livePushIds = new Map();

    // 소켓이 준 fetch 토큰 → 수신 시각(ms).
    //
    // 카카오 거래소의 라이브 프로토콜은 매물 id 를 보내지 않는다. 서명된 토큰
    // 하나를 보내고, 사이트는 그 토큰을 fetch 경로에 그대로 박아 요청한다.
    //   소켓  {"result":"eyJ0eXAi...<JWT>"}
    //   요청  /api/trade/fetch/eyJ0eXAi...<JWT>?query=<검색id>
    // 매물 id 는 응답 본문에만 나온다 (목록이 토큰 서명 안에 봉인돼 있다).
    //
    // 그래서 id 대신 토큰을 대조한다. 토큰은 푸시마다 유일하므로 추측이 아니라
    // 증명이다 — 그 URL 로 온 응답은 그 푸시가 맞다.
    const livePushTokens = new Map();

    const hookedSockets = new WeakSet();

    // 소켓 원문을 앞쪽 몇 건만 그대로 남긴다.
    //
    // 앞 버전은 "{"new":[...]} 가 아닌 메시지" 만 1회 남겼는데, 그 조건 자체가
    // 형식을 안다고 전제한 것이었다. 실제로는 매물이 떴는데도 아무 로그가 없었다.
    // 무엇이 오는지 모를 때는 판단하지 말고 원문을 남겨야 한다.
    const MAX_RAW_LIVE_LOGS = 8;

    let rawLiveLogged = 0;

    function logRawLive(kind, preview) {

        if (rawLiveLogged >= MAX_RAW_LIVE_LOGS) return;

        rawLiveLogged++;

        log('LIVE', `원문 #${rawLiveLogged} [${kind}] ${preview}`
            + (rawLiveLogged === MAX_RAW_LIVE_LOGS
               ? ' — 원문 로그는 여기까지만 남긴다' : ''));

    }

    // 매물 id 는 64자리 16진수다. 키 이름이 new 든 뭐든 상관없이 그 모양만 줍는다.
    //
    // 키 이름을 맞히려 들면 틀렸을 때 또 조용히 실패한다. 값의 모양은 응답
    // 본문(result[].id)에서 이미 확인된 사실이라 훨씬 단단한 근거다.
    const ITEM_ID_RE = /^[0-9a-f]{64}$/i;

    // fetch 토큰: base64url 세 토막을 점으로 이은 JWT 모양.
    const LIVE_TOKEN_RE =
        /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/;

    // 매물 id 와 fetch 토큰을 함께 줍는다. 어느 쪽이 올지는 프로토콜에 달렸고,
    // 둘 다 받아두면 카카오가 형식을 되돌려도 그대로 동작한다.
    function collectLiveRefs(value, out, depth) {

        out = out || { ids: [], tokens: [] };
        depth = depth || 0;

        if (depth > 6 || out.ids.length + out.tokens.length >= 200) return out;

        if (typeof value === 'string') {

            if (ITEM_ID_RE.test(value)) out.ids.push(value);
            else if (LIVE_TOKEN_RE.test(value)) out.tokens.push(value);

            return out;

        }

        if (Array.isArray(value)) {

            for (const v of value) collectLiveRefs(v, out, depth + 1);

            return out;

        }

        if (value && typeof value === 'object') {

            for (const k of Object.keys(value)) {
                collectLiveRefs(value[k], out, depth + 1);
            }

        }

        return out;

    }

    function processLiveText(text) {

        try {

            logRawLive('text', String(text).slice(0, 300));

            let msg;

            try {

                msg = JSON.parse(text);

            } catch (e) {

                // 하트비트 등 JSON 이 아닌 메시지는 정상이다. 원문은 이미 남겼다.
                return;

            }

            const { ids, tokens } = collectLiveRefs(msg);

            if (!ids.length && !tokens.length) return;

            const now = Date.now();

            expireOlderThan(livePushIds, now, LIVE_PUSH_TTL_MS);
            expireOlderThan(livePushTokens, now, LIVE_PUSH_TTL_MS);

            for (const id of ids) livePushIds.set(id, now);
            for (const t of tokens) livePushTokens.set(t, now);

            trimOldest(livePushIds, MAX_LIVE_IDS);
            trimOldest(livePushTokens, MAX_LIVE_IDS);

            livePushCount += ids.length + tokens.length;
            updateStatus();

            // 무엇으로 왔는지 남긴다. 프로토콜이 또 바뀌면 이 줄이 먼저 달라진다.
            const what = [
                ids.length ? `id ${ids.map(shortId).join(',')}` : '',
                tokens.length ? `토큰 ${tokens.map(shortId).join(',')}` : ''
            ].filter(Boolean).join(' + ');

            log('LIVE', `푸시 ${ids.length + tokens.length}건`
                + ` — 자동 이동 허용 (${what})`);

        } catch (e) {

            fail('LIVE', '소켓 메시지 해석 중 예외', e);

        }

    }

    function handleLiveMessage(ev) {

        try {

            const data = ev?.data;

            if (typeof data === 'string') {

                processLiveText(data);
                return;

            }

            // 바이너리 프레임. 앞 버전은 여기서 로그 한 줄 없이 빠져나갔다.
            if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {

                if (typeof TextDecoder === 'undefined') {

                    logRawLive('ArrayBuffer', `${data.byteLength}바이트 (디코더 없음)`);
                    return;

                }

                processLiveText(new TextDecoder().decode(data));
                return;

            }

            if (typeof Blob !== 'undefined' && data instanceof Blob) {

                data.text()
                    .then(processLiveText)
                    .catch((e) => fail('LIVE', 'Blob 메시지를 읽지 못했다', e));

                return;

            }

            logRawLive(typeof data, String(data).slice(0, 200));

        } catch (e) {

            fail('LIVE', '소켓 메시지 처리 중 예외', e);

        }

    }

    // 사이트의 리스너는 건드리지 않는다. 우리 리스너를 따로 붙일 뿐이라
    // 사이트가 removeEventListener 로 자기 리스너를 떼는 데 지장이 없다.
    function attachLiveListener(sock) {

        try {

            if (!sock || hookedSockets.has(sock)) return;

            hookedSockets.add(sock);

            EventTarget.prototype.addEventListener.call(
                sock, 'message', handleLiveMessage);

            liveSocketCount++;
            updateStatus();

            log('LIVE', `소켓 관찰 시작: ${sock.url || '(url 없음)'}`);

        } catch (e) {

            fail('LIVE', '소켓에 리스너를 붙이지 못했다', e);

        }

    }

    // 소켓 인스턴스를 붙잡는 방법.
    //
    // 생성자(window.WebSocket) 교체는 Tampermonkey 샌드박스에서 페이지 쪽에
    // 반영되지 않을 수 있다(unsafeWindow 가 필요하다). 반면 프로토타입 변경은
    // 이 스크립트의 Response.prototype.json 후킹처럼 확실히 먹는다.
    //
    // 그래서 "사이트가 메시지를 받으려면 반드시 거쳐야 하는 지점" 두 곳을 잡는다.
    // 둘 중 어느 쪽을 쓰든 그 순간 소켓 인스턴스(this)를 얻는다.
    function installWebSocketHook() {

        if (typeof WebSocket !== 'function'
            || typeof EventTarget !== 'function') {

            fail('INIT', 'WebSocket / EventTarget 을 쓸 수 없어 라이브 소켓을'
                 + ' 관찰할 수 없다 — 자동 이동이 전부 막힌다.'
                 + ' REQUIRE_LIVE_PUSH 를 false 로 내리면 예전 동작으로 돌아간다.');

            return;

        }

        const proto = WebSocket.prototype;

        // (1) addEventListener('message', ...) 경로
        const originalAdd = proto.addEventListener
            || EventTarget.prototype.addEventListener;

        Object.defineProperty(proto, 'addEventListener', {
            configurable: true,
            writable: true,
            value: function (...args) {
                if (args[0] === 'message') attachLiveListener(this);
                return originalAdd.apply(this, args);
            }
        });

        // (2) sock.onmessage = ... 경로
        const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');

        if (desc && typeof desc.set === 'function') {

            Object.defineProperty(proto, 'onmessage', {
                configurable: true,
                enumerable: desc.enumerable,
                get: desc.get,
                set: function (fn) {
                    attachLiveListener(this);
                    return desc.set.call(this, fn);
                }
            });

        } else {

            warn('INIT', 'WebSocket.prototype.onmessage 접근자를 못 찾았다'
                 + ' — addEventListener 경로만 관찰한다');

        }

        log('INIT', 'WebSocket 후킹 설치 완료');

    }

    // fetch URL 의 경로 부분 (/api/trade/fetch/<여기>?query=...).
    // 라이브면 소켓이 준 토큰 하나, 수동 검색이면 id 콤마 목록이 들어 있다.
    function fetchPathSegment(url) {

        const m = String(url || '').match(/\/fetch\/([^?#]+)/);

        if (!m) return null;

        try {

            return decodeURIComponent(m[1]);

        } catch (e) {

            // 잘못된 % 시퀀스. 원문 그대로 대조하면 된다.
            return m[1];

        }

    }

    let unknownTokenReported = false;

    // consumeSearchOrigin 과 같은 이유로 루프 밖에서 한 번에 소비한다.
    function consumeLivePush(results, url) {

        const fromLive = new Set();

        // 1) 토큰 경로. URL 자체가 소켓이 준 토큰이면 이 응답 전체가 그 푸시다.
        //
        // 토큰은 소비하지 않는다. 사이트가 같은 토큰으로 재시도해도 서버가 돌려주는
        // 매물은 같다(목록이 서명 안에 봉인돼 있다). 소비해버리면 재시도 한 번에
        // 이동을 놓친다. 중복 발동은 usedItemIds 와 TTL 이 이미 막는다.
        const seg = fetchPathSegment(url);

        if (seg && livePushTokens.has(seg)) {

            for (const r of results) {

                if (r?.id) fromLive.add(r.id);

            }

            return fromLive;

        }

        // 토큰 모양인데 기록에 없다 = 소켓 메시지를 놓쳤다는 뜻이다.
        // 조용히 막으면 또 원인을 못 찾으므로 한 번은 남긴다.
        if (seg && LIVE_TOKEN_RE.test(seg) && !unknownTokenReported) {

            unknownTokenReported = true;

            warn('LIVE', '토큰 경로로 온 fetch 인데 소켓 기록에 없다'
                 + ' — 소켓 메시지를 놓쳤거나 다른 탭의 토큰이다'
                 + ` (기록 ${livePushTokens.size}건, 이후 동일 경고는 생략)`);

        }

        // 2) id 목록 방식. 이쪽은 한 번 쓰면 지운다 (consumeSearchOrigin 참고).
        for (const r of results) {

            const id = r?.id;

            if (!id || !livePushIds.has(id)) continue;

            fromLive.add(id);
            livePushIds.delete(id);

        }

        return fromLive;

    }

    // 막았을 때 왜 막았는지. 원인마다 대처가 다르므로 뭉뚱그리지 않는다.
    function liveBlockReason(id, fromSearch) {

        if (fromSearch.has(id)) return '검색 결과로 들어온 매물';

        if (liveSocketCount === 0) {

            return '라이브 소켓을 하나도 못 봤다'
                + ' (이 탭은 라이브 검색이 아니거나 후킹이 늦었다)';

        }

        return '라이브 푸시로 확인되지 않았다'
            + ` (소켓 ${liveSocketCount}개 관찰, 토큰 ${livePushTokens.size}건 대기)`;

    }

    function processTradeResults(json, source = 'UNKNOWN', url = '') {

        // 예외가 터졌을 때 어느 매물에서였는지 알 수 있어야 한다.
        let currentId = null;

        try {

            const results = json?.result;

            if (!Array.isArray(results)) {

                fail(source, 'result 가 배열이 아니다 — 응답 형식 변경 의심', json);
                return;

            }

            // 루프에 들어가기 전에 출처를 확정한다. 루프 안에서 하면 continue/break
            // 때문에 일부 id 가 소비되지 않은 채 남는다 (consumeSearchOrigin 참고).
            const fromSearch = consumeSearchOrigin(results);
            const fromLive = consumeLivePush(results, url);

            for (const r of results) {

                const id = r?.id;

                currentId = id;

                if (!id) {

                    warn(source, 'skip: 매물에 id 가 없다', r);
                    continue;

                }

                if (usedItemIds.has(id)) continue;

                const indexed = r.listing?.indexed;

                if (!indexed) {

                    warn(source, `skip: listing.indexed 가 없다 id=${shortId(id)}`);
                    continue;

                }

                const indexedMs = new Date(indexed).getTime();

                // NaN 이면 age 비교가 항상 false 라 오래된 매물이 신규로 통과한다.
                // 조용히 지나가면 안 되는 지점이다.
                if (Number.isNaN(indexedMs)) {

                    fail(source,
                         `skip: indexed 파싱 실패 "${indexed}" id=${shortId(id)}`);

                    continue;

                }

                const age = Date.now() - indexedMs;

                // 놓친 매물을 진단하려면 왜 건너뛰었는지 남아야 한다.
                // 페이지 최초 로드 시 과거 매물 한 묶음이 들어오므로 여기서 여러 줄 찍히는 건 정상이다.
                if (age > MAX_ITEM_AGE_MS) {

                    log(source, `skip: ${Math.round(age / 1000)}s 전 매물`
                        + ` (기준 ${MAX_ITEM_AGE_MS / 1000}s) id=${shortId(id)}`);

                    continue;

                }

                rememberItemId(id);

                const itemName = getItemName(r);
                const priceText = formatPrice(r.listing);

                log(source, `trigger id=${shortId(id)} ${itemName} / ${priceText}`
                    + ` (${Math.round(age / 1000)}s 전)`);

                /**********************
                 * AUTO HIDEOUT
                 **********************/
                // 억제는 4단계다:
                //   작동 중(모든 탭 ∧ 이 탭) → 라이브 푸시 확인 → hideoutPending → 쿨다운
                // 이동에 성공하면 simulateHumanClick 이 스위치를 꺼서 여기서 끊긴다.
                if (hideoutActive()) {

                    if (REQUIRE_LIVE_PUSH && !fromLive.has(id)) {

                        log('HIDEOUT', `skip: ${liveBlockReason(id, fromSearch)}`
                            + ` id=${shortId(id)}`);

                    } else if (canTriggerHideout(id)) {

                        waitForHideoutButton(id);

                    }

                }

                /**********************
                 * 알림
                 **********************/
                focusTab(itemName + ' ' + priceText);

                // item/price 는 기존 그대로 둔다. 아래 필드는 추가분이고,
                // 로컬 서버가 모르는 키는 무시하므로 기존 서버와 호환된다.
                sendAlertIfServerAlive({
                    item: itemName,
                    price: priceText,
                    priceType: r.listing?.price?.type ?? null,  // "~b/o" 협상 가능 / "b/o" 즉시 구매
                    fee: r.listing?.fee ?? null,                // POE2 골드 수수료
                    seller: r.listing?.account?.name ?? null,
                    indexed: r.listing?.indexed ?? null,
                    id
                });

                lastAlert = new Date();

                updateStatus('Notified');

                break;
            }

        } catch (e) {

            fail(source, `매물 처리 중 예외 id=${shortId(currentId)}`, e);

        }
    }

    // 후킹은 걸렸는데 /search 를 못 보는 상황을 구분하기 위한 진단.
    //
    // "search 로그가 없다" 만으로는 원인을 좁힐 수 없다.
    //   (a) 거래소가 검색을 fetch() 가 아닌 경로(XHR 등)로 보낸다  → 여기에 아무것도 안 찍힘
    //   (b) 검색 엔드포인트 경로명이 예상과 다르다                  → 여기에 그 경로가 찍힘
    // 경로별로 최초 1회만 남기므로 콘솔이 시끄러워지지 않는다.
    const seenApiPaths = new Set();

    function logUnhandledApi(url) {

        // 쿼리스트링과 오리진을 떼고, fetch 처럼 경로에 id 가 붙는 경우를 감안해
        // 앞 3조각만 남긴다: /api/trade/fetch
        const path = String(url).split('?')[0]
            .replace(/^https?:\/\/[^/]+/, '');

        const key = path.split('/').slice(0, 4).join('/');

        if (seenApiPaths.has(key)) return;

        seenApiPaths.add(key);

        log('HOOK', `처리 대상 아닌 거래소 API: ${key}`
            + ' (경로별 최초 1회만 남긴다)');

    }

    // =========================
    // Response JSON Hook
    // =========================
    function installResponseHook() {

        if (!Response || !Response.prototype || !Response.prototype.json) {

            fail('INIT', 'Response.prototype.json 이 없어 후킹할 수 없다'
                 + ' — 매물 감지가 전혀 동작하지 않는다.');

            return;

        }

        const originalJson = Response.prototype.json;

        Response.prototype.json = async function (...args) {

            const result = await originalJson.apply(this, args);

            try {

                const url = this.url || '';

                // POE2 는 /api/trade2/..., POE1 은 /api/trade/... 를 쓴다.
                // @match 에 두 게임이 다 들어 있으므로 양쪽을 받는다.
                const m = url.match(/\/api\/(trade2?)\/(fetch|search)/);

                if (m) {

                    const game = m[1] === 'trade2' ? 'POE2' : 'POE1';
                    const kind = m[2];

                    // 형식을 구버전(`POE1 fetch 응답 N건`)과 일부러 다르게 뒀다.
                    // 콘솔 한 줄만 봐도 어느 버전이 돌고 있는지 알 수 있어야 한다.
                    log('HOOK',
                        `${game} ${kind} 응답: ${result?.result?.length ?? 0}건`, url);

                    // search 가 먼저, fetch 가 나중이다 (fetch 가 search 의 id 목록을
                    // 써야 하므로). 그래서 여기서 기록해 두면 뒤따르는 fetch 에서
                    // 출처를 판별할 수 있다.
                    if (kind === 'search') recordSearchResults(result, game);
                    else processTradeResults(result, game, url);

                } else if (url.includes('/api/')) {

                    logUnhandledApi(url);

                }

            } catch (e) {

                // 여기서 던지면 사이트의 json() 이 깨진다. 삼키되 반드시 남긴다.
                fail('HOOK', '응답 처리 중 예외', e);

            }

            return result;
        };

        log('INIT', 'Response.json 후킹 설치 완료');

    }


    /*********************************************************
     * 탭 간 동기화
     *********************************************************/
    // storage 이벤트는 값을 바꾼 탭에는 오지 않는다. 즉 여기 도달한 변경은
    // 전부 다른 탭이 만든 것이므로, 되쏘지 않도록 applyAutoHideout 만 쓴다.
    function onSharedStateChanged(e) {

        if (!e || e.storageArea !== localStorage) return;

        // localStorage.clear() 는 key 를 null 로 준다. 전체를 다시 읽어 맞춘다.
        if (e.key === null) {

            const armed = readSharedArmed();

            if (armed !== null && armed !== autoHideoutArmed) {
                applyAutoHideout(armed, '다른 탭에서 저장소 초기화');
            }

            return;

        }

        if (e.key === LS_ARMED) {

            const next = e.newValue === '1';

            // 같은 값이면 로그도 남기지 않는다. 탭이 많을 때 콘솔이 시끄러워진다.
            if (next === autoHideoutArmed) return;

            applyAutoHideout(next, '다른 탭에서 변경');

            return;

        }

        if (e.key === LS_LAST_TELEPORT) {

            const ms = Number(e.newValue);

            if (!Number.isFinite(ms)) return;

            // 표시도 함께 맞춘다. 쿨다운은 getLastTeleportMs 가 저장소를 직접
            // 보므로 이 대입 없이도 동작하지만, 오버레이의 Last Teleport 가
            // 자기 탭 이동만 보여주면 왜 막혔는지 알 수 없다.
            if (!lastTeleport || ms > lastTeleport.getTime()) {

                lastTeleport = new Date(ms);
                updateStatus();

                log('SYNC', `다른 탭이 이동함 — 쿨다운 ${COOLDOWN_MS / 1000}s 공유`);

            }

            return;

        }

    }

    window.addEventListener('storage', onSharedStateChanged);


    /*********************************************************
     * 시작
     *********************************************************/
    try {

        installResponseHook();

        // 응답 후킹보다 먼저 걸어도 되지만, 순서를 이 쪽으로 둔 이유는 없다.
        // 둘 다 사이트가 첫 요청을 보내기 전에 설치되면 된다.
        installWebSocketHook();

        checkServerAliveOnce();

        // 다른 탭이 이미 켜져 있으면 그 상태를 따라간다.
        // 무조건 OFF 로 쓰면 새 탭을 열 때마다 전체가 꺼진다.
        const sharedArmed = readSharedArmed();

        applyAutoHideout(
            sharedArmed === true,
            sharedArmed === null ? '초기화' : '다른 탭 상태 적용'
        );

        // 다른 탭의 이동을 오버레이에 반영한다 (쿨다운은 이미 공유 상태다).
        const sharedTeleportMs = readSharedTeleportMs();

        if (sharedTeleportMs !== null) lastTeleport = new Date(sharedTeleportMs);

        updateStatus();

        log('INIT', `ready (v${version})`);

    } catch (e) {

        fail('INIT', '초기화 실패 — 스크립트가 동작하지 않는다', e);

    }

})();
