 // ==UserScript==
 // @name         POE2 Alert (WS → XHR → alert)
 // @version      2026-01-26-002
 // @description  POE2 live search alert & focus
 // @match        https://poe.game.daum.net/trade2/search/poe2/*/live*
 // @run-at       document-idle
 // @grant        none
 // @updateURL    https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
 // @downloadURL    https://raw.githubusercontent.com/drsmin/data-01/refs/heads/master/tampermonkey/POE2autohideout.js
 // ==/UserScript==

 (function() {
     'use strict';

     /*********************************************************
      * 상태
      *********************************************************/
     const version = '2026-01-26-002';
     let enabled = true;
     let cooldown = false;
     let lastTeleport = null;
     const usedItemIds = new Set();
     let lastWhisperResult = null;

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

     function focusTab() {
         try {
             document.title = '🔔🔔 NEW TRADE'; // 시각적 힌트
         } catch (e) {}
     }

     function notifyAndFocusSafe() {
         if (Notification.permission !== 'granted') return;

         const n = new Notification('POE2 Trade', {
             body: '이 알림을 클릭하면 거래 탭으로 이동합니다',
             silent: false,
             requireInteraction: true // 자동으로 안 사라짐
         });

         n.onclick = () => {
             // ❗ 절대 window.open 쓰지 말 것
             try {
                 window.focus();
             } catch (e) {}
             n.close();
         };
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
                     focusTab();
                     notifyAndFocusSafe();

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

 })();
