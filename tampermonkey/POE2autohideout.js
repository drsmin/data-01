 // ==UserScript==
 // @name         POE2 Alert (WS → XHR → alert)
 // @version      2026-01-26-004
 // @description  POE2 live search alert & focus
 // @match        https://poe.game.daum.net/trade2/search/poe2/*/live*
 // @run-at       document-idle
 // @grant        GM_xmlhttpRequest
 // @connect      127.0.0.1
 // @updateURL    https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
 // @downloadURL    https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
 // ==/UserScript==

 (function() {
     'use strict';

     /*********************************************************
      * 상태
      *********************************************************/
     const version = '2026-01-26-004';
     let enabled = true;
     let cooldown = false;
     let lastTeleport = null;
     const usedItemIds = new Set();
     let lastWhisperResult = null;
     let serverAlive = false;

     const COOLDOWN_MS = 30_000;
     const MAX_ITEM_AGE_MS = 60_000;

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
        width: 100%;
        margin-bottom: 6px;
        padding: 4px;
        font-weight: bold;
        cursor: pointer;
        background: #2ecc71;   /* START = 빨강 */
        color: #ffffff;
        border: none;
    `;

     const status = document.createElement('div');
     updateStatus('Running');

     overlay.appendChild(button);
     overlay.appendChild(status);
     document.body.appendChild(overlay);

     button.onclick = () => {
         enabled = !enabled;
         button.textContent = enabled ? 'STOP' : 'START';

         /* 🔴🟢 상태에 따른 버튼 색상만 변경 */
         if (enabled) {
             button.style.background = '#2ecc71'; // START = 초록
         } else {
             button.style.background = '#e74c3c'; // STOP = 빨강
         }

         updateStatus(enabled ? 'Running' : 'Stopped');
     };

     function updateStatus(text) {
         const last = lastTeleport ?
             lastTeleport.toLocaleTimeString() :
             'None';
         status.textContent =
             `Version: ${version}\n` +
             `Status: ${text}\n` +
             `Server: ${serverAlive ? 'ON' : 'OFF'}\n` +
             `Cooldown: ${cooldown ? 'Active' : 'Ready'}\n` +
             `Last Teleport: ${last}`;
     }

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
      * Bong 제공 순간이동 시도 (fetch)
      *********************************************************/
     function tryBongTeleport(token) {
         var uurl = "/api/trade2/whisper";

         fetch(uurl, {
             method: "POST",
             headers: {
                 "Content-Type": "application/json",
                 "X-Requested-With": "XMLHttpRequest"
             },
             body: JSON.stringify({
                 "continue": true,
                 "token": token
             })
         });

         console.log('[POE2] Teleport success (BONG)');
         lastTeleport = new Date();
         startCooldown();
         updateStatus('Teleported (BONG)');
     }

     function notify(title, body) {
         if (Notification.permission === 'granted') {
             new Notification(title, {
                 body
             });
         } else if (Notification.permission !== 'denied') {
             Notification.requestPermission().then(p => {
                 if (p === 'granted') new Notification(title, {
                     body
                 });
             });
         }
     }

     function focusTab(itemName) {
         try {
             document.title = '🔔🔔' + itemName; // 시각적 힌트
         } catch (e) {}
     }

     function notifyAndFocusSafe(itemName) {
         const script = document.createElement("script");
         script.textContent = `
        (function() {
            if (!("Notification" in window)) return;

            if (Notification.permission === 'default') {
                Notification.requestPermission();
                return;
            }
            if (Notification.permission !== 'granted') return;

            const n = new Notification('POE2 Trade', {
                body: ${JSON.stringify(itemName)},
                silent: false,
                requireInteraction: true
            });

            n.onclick = () => {
                try { window.focus(); } catch (e) {}
                n.close();
            };
        })();
    `;
         document.documentElement.appendChild(script);
         script.remove();
     }

     function getItemName(r) {
        const item = r.item || {};
        if (item.name && item.name.trim())
          return `${item.name} ${item.typeLine || ""}`.trim();
        return item.typeLine || item.baseType || "Unknown Item";
      }

     function formatPrice(listing) {
         const price = listing?.price;
         if (!price) return "N/A";

         const amount = price.amount;
         const currency = price.currency;

         if (!amount || !currency) return "N/A";
         return `${amount} ${currency}`;
     }

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
                     headers: { "Content-Type": "application/json" },
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

     function checkServerAliveOnce() {
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
      * XHR 감지
      *********************************************************/
     const open = XMLHttpRequest.prototype.open;
     XMLHttpRequest.prototype.open = function(...args) {
         this.addEventListener('load', function() {
             if (!enabled || cooldown) return;
             if (!this.responseURL.includes('/api/trade2/fetch')) return;

             try {
                 const json = JSON.parse(this.responseText);
                 for (const r of json.result || []) {
                     const id = r.id;
                     if (usedItemIds.has(id)) continue;

                     const indexed = r.listing?.indexed;
                     const token = r.listing?.hideout_token;
                     if (!indexed || !token) continue;

                     const age = Date.now() - new Date(indexed).getTime();
                     if (age > MAX_ITEM_AGE_MS) continue;

                     console.log('[POE2][XHR] trigger', id);
                     usedItemIds.add(id);

                     //tryBongTeleport(token);
                     // ✅ 알림 + 포커스만
                     //notify('POE2 Trade', '새 거래가 감지되었습니다.');

                     const itemName = getItemName(r);
                     const priceText = formatPrice(r.listing);

                     focusTab(itemName + ' ' + priceText);
                     sendAlertIfServerAlive({
                         item: itemName,
                         price: priceText
                     });

                     lastTeleport = new Date(); // 상태 표시용으로만 유지
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

     console.log('[POE2] Auto Hideout initialized (fetch first)');
     checkServerAliveOnce();

 })();
