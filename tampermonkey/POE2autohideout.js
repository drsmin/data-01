 // ==UserScript==
 // @name         POE2 Auto Hideout (WS → fetch → fetch)
 // @version      2026-01-15-003
 // @description  POE2 live search auto hideout (fetch first)
 // @match        https://poe.game.daum.net/trade2/search/poe2/*/live*
 // @match        https://www.pathofexile.com/trade2/search/poe2/*/live*
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
      * Vue 서비스 찾기 봉 텔레포트 이후 사용 안함
      *********************************************************/
     /*
         function findVueService() {
             for (const el of document.querySelectorAll('*')) {
                 const vue =
                     el.__vue__ ||
                     el.__vueParentComponent?.proxy ||
                     el.__vue_app__?._instance?.proxy;

                 if (vue?.$root?.service) {
                     return vue.$root.service;
                 }
             }
             return null;
         }
     */

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

     /*********************************************************
      * Vue 기반 순간이동 시도 봉 텔레포트로 교체
      *********************************************************/
     /*
         function tryVueTeleport(token) {
             const service = findVueService();
             if (!service || typeof service.whisperAccount !== 'function') {
                 console.warn('[POE2] Vue service not found');
                 return;
             }

             console.log('[POE2][VUE] whisperAccount →', token);

             lastWhisperResult = null;

             try {
                 service.whisperAccount(token);
             } catch (e) {
                 console.warn('[POE2] Vue call threw error', e);
                 return;
             }

             // 결과 판정 (XHR 응답 대기)
             const start = Date.now();
             const timer = setInterval(() => {
                 if (!lastWhisperResult) {
                     if (Date.now() - start > 3000) {
                         console.warn('[POE2][WHISPER] timeout → fallback');
                         clearInterval(timer);
                         domFallbackClick();
                     }
                     return;
                 }

                 clearInterval(timer);

                 if (lastWhisperResult.success) {
                     console.log('[POE2] Teleport success (XHR)');
                     lastTeleport = new Date();
                     startCooldown();
                     updateStatus('Teleported (XHR)');
                 } else {
                     console.warn('[POE2] Teleport failed → fallback');
                     setTimeout(domFallbackClick, 300);
                 }
             }, 50);
         }
     */

     /*********************************************************
      * DOM fallback bong teleport후 사용안함
      *********************************************************/
     /*
         function domFallbackClick() {
             const btns = [...document.querySelectorAll('button')]
                 .filter(b =>
                     b.textContent.includes('Teleport anyway') ||
                     b.textContent.includes('Hideout')
                 );

             if (btns.length > 0) {
                 console.log('[POE2][DOM] fallback click');
                 btns[0].click();
                 lastTeleport = new Date();
                 startCooldown();
                 updateStatus('Teleported (DOM)');
                 return true;
             }
             return false;
         }
     */

     /*********************************************************
      * XHR 감지 (fetch로 우회)
      *********************************************************/
     /*
         const open = XMLHttpRequest.prototype.open;
         XMLHttpRequest.prototype.open = function (...args) {
             this.addEventListener('load', function () {
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

                         tryBongTeleport(token);
                         break;
                     }
                 } catch (e) {
                     console.warn('[POE2] XHR parse error', e);
                 }
             });
             return open.apply(this, args);
         };
         */

     function getTradeContext() {
         const parts = location.pathname.split('/').filter(Boolean);
         return {
             realm: parts.includes('poe2') ? 'poe2' : 'poe',
             query: parts[parts.length - 1]
         };
     }

     const OriginalWebSocket = window.WebSocket;

     window.WebSocket = function(url, protocols) {
         const ws = new OriginalWebSocket(url, protocols);

         ws.addEventListener('message', async (e) => {
             const raw = e.data;

             queueMicrotask(() => {

                 let data;
                 try {
                     data = JSON.parse(raw);
                 } catch {
                     return;
                 }

                 if (!data.result) return;

                 const {
                     query,
                     realm
                 } = getTradeContext();
                 const token = data.result;

                 const fetchUrl =
                     `/api/trade2/fetch/${token}?query=${query}&realm=${realm}`;

                 if (!enabled || cooldown) return;

                 // 🚀 병렬 fetch (UI XHR과 독립)
                 fetch(fetchUrl, {
                         credentials: 'include'
                     })
                     .then(r => r.json())
                     .then(json => {
                         console.log('[AUTO FETCH]', json);

                         // 👉 자동화 로직은 여기서만 처리
                         try {

                             console.info('[POE2] fetch 병렬 처리');
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

                                 tryBongTeleport(token);
                                 break;
                             }
                         } catch (e) {
                             console.warn('[POE2] XHR parse error', e);
                         }
                     }).catch(console.error);
             });
         });

         return ws;
     };


     console.log('[POE2] Auto Hideout initialized (fetch first)');

 })();
