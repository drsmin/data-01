// ==UserScript==
// @name         POE1&2 Alert (WS → XHR → alert)
// @version      2026-08-04-008
// @description  POE1/POE2 live search alert & auto hideout
// @match        https://poe.kakaogames.com/trade2/search/poe2/*/live
// @match        https://poe.kakaogames.com/trade/search/*/live
// @run-at       document-idle
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

    let autoHideoutArmed = false;

    // 텔레포트가 진행 중(버튼 대기 또는 클릭 예약)인지. 트리거가 연달아 와도 클릭이 중첩되지 않게 막는다.
    let hideoutPending = false;

    const usedItemIds = new Set();
    let serverAlive = false;

    const COOLDOWN_MS = 30_000;
    const MAX_ITEM_AGE_MS = 60_000;

    // usedItemIds 무한 증가 방지: 상한 초과 시 가장 오래된 항목부터 버린다.
    const MAX_USED_IDS = 1000;

    // hideout 버튼을 이 시간까지 못 찾으면 관찰을 포기한다.
    const HIDEOUT_WAIT_TIMEOUT_MS = 15_000;

    // 이동 1회 성공 후 자동으로 무장을 해제한다.
    // 쿨다운(COOLDOWN_MS)은 간격만 벌리므로, 무장을 켜 둔 채 자리를 비우면
    // 매물이 뜰 때마다 계속 이동한다. 무장 해제가 그걸 끊는 유일한 정지점이다.
    // 연속 이동을 원하면 false 로 두고 쿨다운에만 의존한다.
    const DISARM_AFTER_TELEPORT = true;

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
     *   HOOK     fetch 응답 가로채기
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

    // 공유된 무장 상태. 키가 없으면(첫 탭) null 을 준다.
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
     *********************************************************/
    const overlay = document.createElement('div');

    overlay.style.cssText = `
position: fixed;
bottom: 80px;
right: 20px;
background: #ffffff;
color: #000000;
padding: 10px 12px;
border-radius: 10px;
font-family: sans-serif;
font-size: 12px;
z-index: 999999;
box-shadow: 0 2px 10px rgba(0,0,0,0.3);
white-space: pre;
min-width: 220px;
`;

    const hideoutBtn = document.createElement('button');

    hideoutBtn.textContent = 'AUTO HO OFF';

    hideoutBtn.style.cssText = `
display:block;
width:100%;
margin-bottom:6px;
padding:6px;
font-weight:bold;
cursor:pointer;
background:#555;
color:#fff;
border:none;
border-radius:4px;
`;

    const status = document.createElement('div');

    overlay.appendChild(hideoutBtn);
    overlay.appendChild(status);

    // 오버레이가 못 붙어도 알림/텔레포트는 계속 동작해야 한다.
    // (status 는 분리된 노드로 남아 updateStatus 가 그대로 쓴다.)
    try {

        document.body.appendChild(overlay);

    } catch (e) {

        fail('UI', '오버레이를 body 에 붙이지 못했다 — 상태 표시 없이 계속 진행한다', e);

    }


    /*********************************************************
     * 버튼 동작
     *********************************************************/
    hideoutBtn.onclick = () => {

        setAutoHideout(!autoHideoutArmed, '버튼 클릭');

    };

    // 이 탭에만 상태를 적용한다. 저장소에 쓰지 않으므로 다른 탭에서 온 변경을
    // 반영할 때 쓴다 (여기서 쓰면 탭끼리 서로 되쏘며 무한 반복한다).
    //
    // reason 은 왜 상태가 바뀌었는지 한 줄에 함께 남기기 위한 것이다.
    // 자동 해제 / 버튼 클릭 / 다른 탭을 콘솔에서 구분할 수 있어야 한다.
    function applyAutoHideout(state, reason) {

        log('UI', `auto hideout ${state ? 'ON' : 'OFF'}`
            + (reason ? ` — ${reason}` : ''));

        autoHideoutArmed = state;

        // 끄면 대기 중이거나 예약된 텔레포트도 함께 취소한다.
        // 다른 탭이 껐을 때도 이 경로를 타므로 예약된 클릭이 확실히 취소된다.
        if (!state) cancelHideout();

        hideoutBtn.textContent = state ? 'AUTO HO ON' : 'AUTO HO OFF';

        hideoutBtn.style.background =
            state ? '#f39c12' : '#555';

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

    function updateStatus(text) {

        if (text !== undefined) statusText = text;

        const fmt = (d) => d ? d.toLocaleTimeString() : 'None';

        status.textContent =
            `Version: ${version}
Status: ${statusText}
Server: ${serverAlive ? 'ON':'OFF'}
Last Alert: ${fmt(lastAlert)}
Last Teleport: ${fmt(lastTeleport)}`;

    }

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

        hideoutObserver.observe(document.body, {
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

    // Set 은 삽입 순서를 유지하므로, 상한을 넘으면 앞쪽(가장 오래된)부터 버린다.
    function rememberItemId(id) {

        usedItemIds.add(id);

        if (usedItemIds.size <= MAX_USED_IDS) return;

        const overflow = usedItemIds.size - MAX_USED_IDS;
        let removed = 0;

        for (const old of usedItemIds) {
            usedItemIds.delete(old);
            if (++removed >= overflow) break;
        }

    }

    function processTradeResults(json, source = 'UNKNOWN') {

        // 예외가 터졌을 때 어느 매물에서였는지 알 수 있어야 한다.
        let currentId = null;

        try {

            const results = json?.result;

            if (!Array.isArray(results)) {

                fail(source, 'result 가 배열이 아니다 — 응답 형식 변경 의심', json);
                return;

            }

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
                // 억제는 3단계다: 무장 여부 → hideoutPending → 쿨다운.
                // 이동에 성공하면 simulateHumanClick 이 무장을 해제하므로 여기서 끊긴다.
                if (autoHideoutArmed && canTriggerHideout(id)) {

                    waitForHideoutButton(id);

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

                // POE2 는 /api/trade2/fetch, POE1 은 /api/trade/fetch 를 쓴다.
                // @match 에 두 게임이 다 들어 있으므로 양쪽을 받는다.
                const m = url.match(/\/api\/(trade2?)\/fetch/);

                if (m) {

                    const game = m[1] === 'trade2' ? 'POE2' : 'POE1';

                    log('HOOK', `${game} fetch 응답 ${result?.result?.length ?? 0}건`, url);

                    processTradeResults(result, game);

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

        checkServerAliveOnce();

        // 다른 탭이 이미 무장돼 있으면 그 상태를 따라간다.
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
