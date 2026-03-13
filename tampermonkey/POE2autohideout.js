// ==UserScript==
// @name         POE1&2 Alert (WS → XHR → alert)
// @version      2026-03-14-002
// @description  POE2 live search alert & auto hideout
// @match        https://poe.game.daum.net/trade2/search/poe2/*/live*
// @match        https://poe.game.daum.net/trade/search/Mirage/*/live*
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
    const version = '2026-03-14-002';
    let enabled = true;
    let cooldown = false;
    let lastTeleport = null;

    let autoHideoutArmed = false;
    let autoHideoutTriggered = false;

    const usedItemIds = new Set();
    let lastWhisperResult = null;
    let serverAlive = false;

    const COOLDOWN_MS = 30_000;
    const MAX_ITEM_AGE_MS = 60_000;


    /*********************************************************
     * 랜덤 딜레이
     *********************************************************/
    function randomDelay(min = 123, max = 1345) {
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

    const button = document.createElement('button');

    button.textContent = 'STOP';

    button.style.cssText = `
display:block;
width:100%;
margin-bottom:6px;
padding:6px;
font-weight:bold;
cursor:pointer;
background:#2ecc71;
color:#fff;
border:none;
border-radius:4px;
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

    overlay.appendChild(button);
    overlay.appendChild(hideoutBtn);
    overlay.appendChild(status);

    document.body.appendChild(overlay);


    /*********************************************************
     * 버튼 동작
     *********************************************************/
    button.onclick = () => {

        enabled = !enabled;

        button.textContent = enabled ? 'STOP' : 'START';

        button.style.background =
            enabled ? '#2ecc71' : '#e74c3c';

        updateStatus(enabled ? 'Running' : 'Stopped');

    };

    hideoutBtn.onclick = () => {

        setAutoHideout(!autoHideoutArmed);

    };

    function setAutoHideout(state) {

        autoHideoutArmed = state;
        autoHideoutTriggered = false;

        hideoutBtn.textContent = state ? 'AUTO HO ON' : 'AUTO HO OFF';

        hideoutBtn.style.background =
            state ? '#f39c12' : '#555';

    }


    /*********************************************************
     * 상태 표시
     *********************************************************/
    function updateStatus(text) {

        const last = lastTeleport ?
            lastTeleport.toLocaleTimeString() :
            'None';

        status.textContent =
            `Version: ${version}
Status: ${text}
Server: ${serverAlive ? 'ON':'OFF'}
Cooldown: ${cooldown ? 'Active':'Ready'}
Last Teleport: ${last}`;

    }

    updateStatus('Running');


    /*********************************************************
     * 쿨다운
     *********************************************************/
    function startCooldown() {

        cooldown = true;

        let remain = COOLDOWN_MS / 1000;

        const tick = setInterval(() => {

            if (!cooldown) {

                clearInterval(tick);
                return;

            }

            remain--;

            updateStatus(`Cooldown ${remain}s`);

            if (remain <= 0) {

                cooldown = false;
                updateStatus('Ready');

                clearInterval(tick);

            }

        }, 1000);

    }


    /*********************************************************
     * hideout 클릭
     *********************************************************/
    function clickLastHideoutButton() {

        const buttons = document.querySelectorAll(
            'button.direct-btn'
        );

        if (!buttons.length) return;

        const btn = buttons[buttons.length - 1];

        if (!btn.innerText.includes("Hideout")) return;

        const delay = randomDelay();

        console.log('[POE] hideout delay', delay);

        setTimeout(() => {

            btn.click();

        }, delay);

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

        if (item.name && item.name.trim())
            return `${item.name} ${item.typeLine||""}`.trim();

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
                updateStatus('Running');

            }

        }, 300);

        GM_xmlhttpRequest({

            method: "GET",
            url: "http://127.0.0.1:5001/health",

            onload: () => {

                finished = true;
                clearTimeout(timeout);

                serverAlive = true;
                updateStatus('Running');

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
                updateStatus('Running');

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
                updateStatus('Running');

            },

            onerror: () => {

                serverAlive = false;
                updateStatus('Running');

            }

        });

    }


    /*********************************************************
     * XHR 감지
     *********************************************************/
    const open = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(...args) {

        this.addEventListener('load', function() {

            if (!enabled || cooldown) return;

            if (!this.responseURL.includes('/api/trade2/fetch') &&
                !this.responseURL.includes('/api/trade/fetch')) return;

            try {

                const json = JSON.parse(this.responseText);

                for (const r of json.result || []) {

                    const id = r.id;

                    if (usedItemIds.has(id)) continue;

                    const indexed = r.listing?.indexed;

                    if (!indexed) continue;

                    const age = Date.now() - new Date(indexed).getTime();

                    if (age > MAX_ITEM_AGE_MS) continue;

                    const token = r.listing?.hideout_token;

                    usedItemIds.add(id);

                    console.log('[POE2][XHR] trigger', id);


                    /**********************
                     * AUTO HIDEOUT
                     **********************/
                    if (autoHideoutArmed && !autoHideoutTriggered) {

                        autoHideoutTriggered = true;

                        setTimeout(() => {

                            clickLastHideoutButton();

                            /* 자동 OFF */
                            setAutoHideout(false);

                        }, 300);

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

                    lastTeleport = new Date();

                    startCooldown();

                    updateStatus('Notified');

                    break;

                }

            } catch (e) {

                console.warn('[POE2] XHR parse error', e);

            }

        });

        return open.apply(this, args);

    };

    console.log('[POE] Auto Hideout initialized');

    checkServerAliveOnce();

})();
