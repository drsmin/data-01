// ==UserScript==
// @name         POE1&2 Alert (WS → XHR → alert)
// @version      2026-08-04-001
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

    document.body.appendChild(overlay);


    /*********************************************************
     * 버튼 동작
     *********************************************************/
    hideoutBtn.onclick = () => {

        setAutoHideout(!autoHideoutArmed);

    };

    function setAutoHideout(state) {

        console.log('[POE] setAutoHideout ', state);

        autoHideoutArmed = state;

        // 수동으로 끄면 대기 중이거나 예약된 텔레포트도 함께 취소한다.
        if (!state) cancelHideout();

        hideoutBtn.textContent = state ? 'AUTO HO ON' : 'AUTO HO OFF';

        hideoutBtn.style.background =
            state ? '#f39c12' : '#555';

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
    const HIDEOUT_BTN_SELECTOR = 'button.btn.btn-xs.btn-default.direct-btn';

    // 한/영 UI 모두 지원. live search 는 최신 매물이 위에 쌓이므로 화면상 가장 위 버튼을 고른다.
    function findHideoutButton() {

        const matches = [...document.querySelectorAll(HIDEOUT_BTN_SELECTOR)]
            .filter(b => {
                const text = b.textContent || '';
                return text.toLowerCase().includes('hideout')
                    || text.includes('은신처');
            });

        if (!matches.length) return null;

        return matches.sort(
            (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
        )[0];

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

    // 쿨다운: 마지막 실제 텔레포트로부터 COOLDOWN_MS 가 지나야 다시 발동한다.
    function canTriggerHideout() {

        if (hideoutPending) {
            console.log('[POE] hideout already pending — skip');
            return false;
        }

        if (lastTeleport) {

            const elapsed = Date.now() - lastTeleport.getTime();

            if (elapsed < COOLDOWN_MS) {
                console.log('[POE] hideout cooldown',
                            Math.ceil((COOLDOWN_MS - elapsed) / 1000), 's left');
                return false;
            }

        }

        return true;

    }

    function clickHideoutButton(btn) {

        const delay = randomDelay();

        console.log('[POE] hideout delay', delay);

        hideoutClickTimeoutId = setTimeout(() => {

            hideoutClickTimeoutId = null;

            // 클릭이 나가면 이후 억제는 lastTeleport 기반 쿨다운이 담당한다.
            hideoutPending = false;

            simulateHumanClick(btn);

        }, delay);

    }

    function waitForHideoutButton() {

        // 이전 대기가 남아 있으면 정리한다 (관찰자 중복 방지).
        stopWaitingForHideout();

        hideoutPending = true;

        // 버튼이 이미 떠 있으면 MutationObserver 는 발화하지 않으므로 먼저 확인한다.
        const existing = findHideoutButton();

        if (existing) {
            console.log('[POE] hideout button already present');
            clickHideoutButton(existing);
            return;
        }

        console.log('[POE] waiting hideout button...');

        hideoutObserver = new MutationObserver(() => {

            const btn = findHideoutButton();

            if (!btn) return;

            console.log('[POE] hideout button detected');

            stopWaitingForHideout();
            clickHideoutButton(btn);

        });

        hideoutObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 끝내 안 나타나면 포기한다. 없으면 페이지가 살아 있는 동안 body 전체를 계속 관찰한다.
        hideoutWaitTimeoutId = setTimeout(() => {

            console.warn('[POE] hideout button not found — giving up');

            cancelHideout();
            updateStatus('HO timeout');

        }, HIDEOUT_WAIT_TIMEOUT_MS);

    }

    function simulateHumanClick(element) {
        if (!element) return console.error("요소를 찾을 수 없습니다.");

        // 1. 버튼의 화면상 실제 좌표 및 정중앙 위치 계산
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

        console.log("[POE] button click done!");

        // 실제로 클릭이 나간 시점만 텔레포트로 기록한다.
        lastTeleport = new Date();
        updateStatus('Teleported');
    }


    /*********************************************************
     * 알림
     *********************************************************/
    function focusTab(itemName) {

        try {

            document.title = '🔔🔔' + itemName;

        } catch (e) {}

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

        if (!amount || !currency) return "N/A";

        return `${amount} ${currency}`;

    }


    /*********************************************************
     * 로컬 서버 alert
     *********************************************************/
    function sendAlertIfServerAlive(payload) {

        let finished = false;

        const timeout = setTimeout(() => {

            if (!finished) {

                serverAlive = false;
                updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

            }

        }, 300);

        GM_xmlhttpRequest({

            method: "GET",
            url: "http://127.0.0.1:5001/health",

            onload: () => {

                finished = true;
                clearTimeout(timeout);

                serverAlive = true;
                updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

                GM_xmlhttpRequest({

                    method: "POST",
                    url: "http://127.0.0.1:5001/alert",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    data: JSON.stringify(payload)

                });

            },

            onerror: () => {

                finished = true;
                clearTimeout(timeout);

                serverAlive = false;
                updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

            }

        });

    }


    /*********************************************************
     * 서버 체크
     *********************************************************/
    function checkServerAliveOnce() {

        GM_xmlhttpRequest({

            method: "GET",
            url: "http://127.0.0.1:5001/health",

            onload: () => {

                serverAlive = true;
                updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

            },

            onerror: () => {

                serverAlive = false;
                updateStatus();   // 서버 표시만 갱신, Status 문구는 유지

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

        try {

            for (const r of json.result || []) {

                const id = r.id;

                if (usedItemIds.has(id)) continue;

                const indexed = r.listing?.indexed;

                if (!indexed) continue;

                const age =
                    Date.now() - new Date(indexed).getTime();

                if (age > MAX_ITEM_AGE_MS) continue;

                rememberItemId(id);

                console.log(`[POE][${source}] trigger`, id);

                /**********************
                 * AUTO HIDEOUT
                 **********************/
                // 무장 상태를 유지한 채 쿨다운으로만 억제한다 (1회성 아님).
                if (autoHideoutArmed && canTriggerHideout()) {

                    waitForHideoutButton();

                }

                /**********************
                 * 알림
                 **********************/
                const itemName = getItemName(r);
                const priceText = formatPrice(r.listing);

                focusTab(itemName + ' ' + priceText);

                sendAlertIfServerAlive({
                    item: itemName,
                    price: priceText
                });

                lastAlert = new Date();

                updateStatus('Notified');

                break;
            }

        } catch (e) {

            console.error(`[POE][${source}] process error`, e);

        }
    }

    // =========================
    // Response JSON Hook
    // =========================
    (function () {

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

                    console.log('[POE][JSON] trade response detected');
                    console.log('[POE][JSON] URL:', url);
                    console.log('[POE][JSON] result count:',
                                result?.result?.length || 0);

                    processTradeResults(result, game);
                }

            } catch (e) {

                console.error('[POE][JSON]', e);

            }

            return result;
        };

        console.log('[POE] Response.json hook installed');

    })();

    console.log('[POE] Auto Hideout initialized');

    checkServerAliveOnce();

    setAutoHideout(false);

})();
