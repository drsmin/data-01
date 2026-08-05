// POE2autohideout.js 의 탭 간 동기화 회귀 테스트.
//
//   실행: node tampermonkey/POE2autohideout.test.js
//   (의존성 없음. 실패하면 exit code 1.)
//
// 브라우저 없이 검증하기 위해, 스크립트 소스를 그대로 읽어 DOM/localStorage/
// 타이머를 스텁으로 갈아끼운 "가짜 탭" 을 여러 개 만들어 돌린다.
// 탭마다 독립된 Response 클래스와 localStorage 래퍼를 주고, setItem 은 다른 탭에만
// storage 이벤트를 쏜다 — 실제 브라우저 동작과 같다.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, 'POE2autohideout.js'), 'utf8');

const LS_ARMED = 'poeAutoHideout.armed';
const LS_LAST_TELEPORT = 'poeAutoHideout.lastTeleport';


// ==================== 공유 localStorage ====================
function makeSharedStore() {

    const data = new Map();
    const tabs = [];
    let writes = 0;

    return {
        register: (tab) => tabs.push(tab),

        // 되쏘기(ping-pong) 를 직접 재는 지표. 사용자 조작 1회당 쓰기는 1회여야 한다.
        writeCount: () => writes,

        // storage 이벤트는 값을 바꾼 탭에는 오지 않는다 — 그걸 그대로 재현한다.
        forTab: (tab) => ({
            getItem: (k) => (data.has(k) ? data.get(k) : null),
            setItem: (k, v) => {
                writes++;
                const oldValue = data.has(k) ? data.get(k) : null;
                data.set(k, String(v));
                for (const t of tabs) {
                    if (t === tab) continue;
                    t.fire({
                        key: k,
                        oldValue,
                        newValue: String(v),
                        storageArea: t.localStorage,
                    });
                }
            },
        }),

        dump: () => Object.fromEntries(data),
    };
}

// 탭 생성 전에 공유 값을 미리 넣는다.
// getLastTeleportMs 는 max(공유, 로컬) 이므로, 탭을 만든 뒤에 과거 시각을 써도
// 쿨다운이 앞당겨지지 않는다(의도된 동작). 초기값은 탭보다 먼저 넣어야 한다.
function seedStore(store, key, value) {
    store.forTab({ fire() {} }).setItem(key, value);
}


// ==================== 제어 가능한 타이머 ====================
function makeClock() {

    let seq = 0;
    const timers = new Map();

    return {
        setTimeout: (fn, ms) => {
            const id = ++seq;
            timers.set(id, { fn, ms });
            return id;
        },
        clearTimeout: (id) => { timers.delete(id); },

        // 예약된 것을 지연 시간 순으로 실행한다.
        // 실행 중 clearTimeout 으로 취소된 항목은 건너뛴다 (delete 반환값으로 판별).
        flush() {
            const entries = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
            for (const [id, t] of entries) {
                if (timers.delete(id)) t.fn();
            }
        },

        pending: () => timers.size,
    };
}


// ==================== 가짜 탭 ====================
function makeTab(name, store, clock, src = SRC, opts = {}) {

    const logs = [];
    const clicks = [];
    const rows = new Map();
    const created = [];

    // @run-at document-start 재현: 스크립트가 돌 때 body 가 아직 없는 상태.
    const docListeners = [];
    const bodyNode = { appendChild() { bodyNode.attached = true; } };

    const el = () => ({
        style: { cssText: '' },
        textContent: '',
        appendChild() {},
        focus() {},
    });

    const document = {
        title: '',
        body: opts.noBody ? null : bodyNode,
        documentElement: { tag: 'html' },
        addEventListener: (type, fn) => docListeners.push({ type, fn }),
        createElement() { const e = el(); created.push(e); return e; },
        querySelector(sel) {
            const m = /data-id="([^"]+)"/.exec(sel);
            if (!m) return null;
            return rows.get(m[1]) || null;
        },
    };

    const listeners = [];
    const window = {
        innerWidth: opts.width || 1728,
        innerHeight: opts.height || 1084,
        addEventListener: (type, fn) => listeners.push({ type, fn }),
    };

    const tab = { name, logs, clicks, rows };

    tab.localStorage = store.forTab(tab);

    tab.fire = (e) => {
        for (const l of listeners) {
            if (l.type === 'storage') l.fn(e);
        }
    };

    store.register(tab);

    const console_ = {
        log: (...a) => logs.push(['log', a.join(' ')]),
        warn: (...a) => logs.push(['warn', a.join(' ')]),
        error: (...a) => logs.push(['error', a.join(' ')]),
    };

    // 탭마다 독립된 Response 클래스 — 실제 브라우저와 같다.
    // 공유하면 후킹이 겹쳐 한 응답을 여러 탭이 처리해버린다.
    const Response = class FakeResponse {
        constructor(url, data) { this.url = url; this._data = data; }
        async json() { return this._data; }
    };

    const MouseEvent = class { constructor(type) { this.type = type; } };

    // 라이브 소켓 후킹은 프로토타입을 갈아끼운다. 실제 브라우저와 같은 모양을
    // 줘야 (EventTarget 상속 + onmessage 접근자) 후킹 경로가 그대로 검증된다.
    const EventTarget_ = class {
        constructor() { this._listeners = {}; }
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        }
        removeEventListener(type, fn) {
            const l = this._listeners[type];
            if (l) this._listeners[type] = l.filter((f) => f !== fn);
        }
    };

    const WebSocket_ = class extends EventTarget_ {
        constructor(url) { super(); this.url = url; }
        // 서버에서 메시지가 온 것처럼 흘려보낸다.
        deliver(data) {
            const ev = { data };
            for (const fn of this._listeners.message || []) fn(ev);
            if (this.onmessage) this.onmessage(ev);
        }
    };

    Object.defineProperty(WebSocket_.prototype, 'onmessage', {
        configurable: true,
        get() { return this._onmessage || null; },
        set(fn) { this._onmessage = fn; },
    });

    tab.WebSocket = WebSocket_;

    // 사이트가 소켓을 열고 핸들러를 다는 흉내.
    // way: 사이트가 쓰는 두 경로 중 어느 쪽인지 ('addEventListener' | 'onmessage')
    tab.openSocket = (url, way = 'addEventListener') => {
        const sock = new WebSocket_(url);
        const siteHandler = (ev) => { (tab.siteMessages = tab.siteMessages || []).push(ev.data); };
        if (way === 'onmessage') sock.onmessage = siteHandler;
        else sock.addEventListener('message', siteHandler);
        sock.siteHandler = siteHandler;
        return sock;
    };

    const ensureSock = () => {
        if (!tab.sock) {
            tab.sock = tab.openSocket(
                'wss://poe.kakaogames.com/api/trade/live/Standard/9zRwreG8CK');
        }
        return tab.sock;
    };

    // 구 프로토콜: 소켓이 매물 id 목록을 준다.
    tab.livePush = (...ids) => {
        ensureSock().deliver(JSON.stringify({ new: ids }));
    };

    // 실제 카카오 프로토콜: 소켓이 서명 토큰 하나를 주고, 사이트는 그 토큰을
    // fetch 경로에 그대로 박아 요청한다. 매물 id 는 응답 본문에만 있다.
    tab.livePushToken = (token) => {
        ensureSock().deliver(JSON.stringify({ result: token }));
    };

    const MutationObserver = class {
        constructor(cb) { this.cb = cb; tab.observer = this; }
        observe() {}
        disconnect() { if (tab.observer === this) tab.observer = null; }
    };

    // 스크립트는 IIFE 라 즉시 실행된다. 전역 의존성을 인자로 주입한다.
    const fn = new Function(
        'window', 'document', 'localStorage', 'console',
        'Response', 'MouseEvent', 'MutationObserver', 'CSS',
        'setTimeout', 'clearTimeout', 'GM_xmlhttpRequest', 'GM_info',
        'WebSocket', 'EventTarget',
        src);

    fn(window, document, tab.localStorage, console_,
       Response, MouseEvent, MutationObserver, { escape: (s) => s },
       clock.setTimeout, clock.clearTimeout,
       () => {}, { script: { version: 'test' } },
       WebSocket_, EventTarget_);

    // 생성 순서가 아니라 클래스명으로 찾는다. 오버레이에 노드가 늘어도 안 깨진다.
    const byClass = (c) => created.find((e) => e.className === c);

    // 개발자 도구를 열어 창이 좁아진 상황.
    tab.resizeTo = (w, h) => {
        window.innerWidth = w;
        window.innerHeight = h;
        for (const l of listeners) {
            if (l.type === 'resize') l.fn();
        }
    };

    tab.pos = () => [tab.overlay.style.right, tab.overlay.style.bottom];

    tab.overlay = byClass('poe-overlay');
    tab.panel = byClass('poe-panel');
    tab.caption = byClass('poe-caption');
    tab.btn = byClass('poe-ho-btn');
    tab.tabBtn = byClass('poe-tab-btn');
    tab.detailBtn = byClass('poe-detail-btn');
    tab.details = byClass('poe-details');

    // 카드가 호박색으로 빛나고 있는가 = "지금 여기서 실제로 이동한다".
    tab.cardGlowing = () =>
        String(tab.panel.style.boxShadow).includes('240, 160, 32');

    // 상세만 접힌다. 버튼 3개는 언제나 보인다.
    tab.isCollapsed = () => tab.details.style.display === 'none';
    tab.detailText = () => tab.detailBtn.textContent;
    tab.clickDetail = () => tab.detailBtn.onclick();

    // 마우스로 끌기. document 리스너를 그대로 태운다.
    tab.dragBy = (dx, dy) => {
        tab.overlay.onmousedown({ button: 0, clientX: 100, clientY: 100 });
        const fire = (type, x, y) => {
            for (const l of docListeners) {
                if (l.type === type) l.fn({ clientX: x, clientY: y, preventDefault() {} });
            }
        };
        fire('mousemove', 100 + dx, 100 + dy);
        fire('mouseup', 100 + dx, 100 + dy);
    };
    tab.value = (key) => byClass(`poe-v-${key}`);

    // body 가 생기고 DOMContentLoaded 가 발화한 시점.
    tab.domReady = () => {
        document.body = bodyNode;
        for (const l of docListeners) {
            if (l.type === 'DOMContentLoaded') l.fn();
        }
    };

    tab.overlayAttached = () => bodyNode.attached === true;

    tab.armedText = () => tab.btn.textContent;
    tab.clickToggle = () => tab.btn.onclick();

    tab.tabText = () => tab.tabBtn.textContent;
    tab.clickTabToggle = () => tab.tabBtn.onclick();

    // 특정 id 의 결과 행이 이미 렌더링돼 있는 것처럼 만든다.
    tab.addRow = (id) => {
        const button = {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
            dispatchEvent: (e) => { if (e.type === 'click') clicks.push(id); },
            focus() {},
        };
        rows.set(id, {
            querySelector: (s) => (s === 'button.direct-btn' ? button : null),
        });
    };

    // 거래소 fetch 응답 1건을 흘려보낸다.
    // 기본은 POE1(/api/trade/fetch) — 실제 응답/DOM 을 대조해 확인된 쪽이다.
    // POE2 경로를 보려면 api='trade2' 로 넘긴다.
    // path 를 주면 그 경로로 요청한 것처럼 만든다 (라이브는 토큰 경로를 쓴다).
    tab.feed = async (id, indexedIso, api = 'trade', path = null) => {
        const res = new Response(
            `https://poe.kakaogames.com/api/${api}/fetch/`
            + (path || id) + '?query=6zBYj3w9sG',
            {
                result: [{
                    id,
                    listing: {
                        indexed: indexedIso,
                        price: { type: '~b/o', amount: 40, currency: 'divine' },
                        fee: 6758,
                        account: { name: 'seller#0001' },
                    },
                    item: { name: '테스트', typeLine: '건틀릿' },
                }],
            });
        await res.json();
    };

    // 임의의 URL/본문을 그대로 후킹에 흘려보낸다 (진단 로그 검증용).
    tab.feedRaw = async (url, data) => {
        await new Response(url, data).json();
    };

    // 수동 검색(또는 페이지 최초 로드)이 먼저 받는 /search 응답.
    // 본문은 매물 id 문자열 배열이다 (fetch 응답의 객체 배열과 다르다).
    tab.feedSearch = async (ids, api = 'trade') => {
        const res = new Response(
            `https://poe.kakaogames.com/api/${api}/search/poe2/Standard`,
            { id: 'searchid', complexity: 1, total: ids.length, result: ids });
        await res.json();
    };

    return tab;
}


// ==================== 검증 ====================
let failures = 0;

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`
                + (ok ? '' : `\n        기대=${JSON.stringify(expected)}`
                          + ` 실제=${JSON.stringify(actual)}`));
}

function section(title) {
    console.log(`\n--- ${title} ---`);
}


(async () => {

    const store = makeSharedStore();
    const clock = makeClock();

    const A = makeTab('A', store, clock);
    const B = makeTab('B', store, clock);

    section('T1: A 에서 켜면 B 도 켜진다');
    A.clickToggle();
    check('A ON', A.armedText(), '모든 탭 ON');
    check('B ON (전파됨)', B.armedText(), '모든 탭 ON');
    check('저장소 armed', store.dump()[LS_ARMED], '1');

    section('T2: B 에서 끄면 A 도 꺼진다');
    B.clickToggle();
    check('B OFF', B.armedText(), '모든 탭 OFF');
    check('A OFF (전파됨)', A.armedText(), '모든 탭 OFF');

    section('T3: 켜둔 채로 새 탭을 열면 상태를 이어받고, 기존 탭을 끄지 않는다');
    A.clickToggle();                       // 다시 ON
    const C = makeTab('C', store, clock);
    check('C 가 ON 으로 시작', C.armedText(), '모든 탭 ON');
    check('A 는 여전히 ON', A.armedText(), '모든 탭 ON');
    check('B 는 여전히 ON', B.armedText(), '모든 탭 ON');

    section('T4: A 가 이동하면 모든 탭이 꺼지고 쿨다운이 공유된다');
    const id1 = 'a'.repeat(64);
    A.addRow(id1);
    A.livePush(id1);
    await A.feed(id1, new Date().toISOString());
    clock.flush();                         // 예약된 클릭 실행
    check('A 가 클릭 1회', A.clicks, [id1]);
    check('A OFF (자동으로 꺼짐)', A.armedText(), '모든 탭 OFF');
    check('B OFF (전파됨)', B.armedText(), '모든 탭 OFF');
    check('C OFF (전파됨)', C.armedText(), '모든 탭 OFF');
    check('저장소에 lastTeleport 기록',
          typeof store.dump()[LS_LAST_TELEPORT], 'string');

    section('T5: 쿨다운 중 다른 탭은 이동하지 않는다');
    B.clickToggle();                       // 모든 탭 다시 켜기
    check('B ON', B.armedText(), '모든 탭 ON');
    const id2 = 'b'.repeat(64);
    B.addRow(id2);
    B.livePush(id2);                       // 라이브 확인은 통과시키고 쿨다운만 남긴다
    await B.feed(id2, new Date().toISOString());
    clock.flush();
    check('B 는 클릭하지 않음 (쿨다운 공유)', B.clicks, []);
    check('B 에 쿨다운 로그 있음',
          B.logs.some(([, m]) => m.includes('쿨다운') && m.includes('탭 공유')),
          true);

    section('T6: 무한 되쏘기(ping-pong) 없음');
    // storage 이벤트로 받은 변경을 다시 저장소에 쓰면 탭끼리 서로 되쏜다.
    // applyAutoHideout 이 쓰기를 안 하므로, 탭이 3개여도 사용자 조작 1회 =
    // 저장소 쓰기 1회로 끝나야 한다. 로그 개수가 아니라 쓰기 횟수를 세야
    // 되쏘기가 실제로 없는지 판별된다.
    const writesBefore = store.writeCount();
    A.clickToggle();
    check('탭 3개인데도 토글 1회 = 저장소 쓰기 1회',
          store.writeCount() - writesBefore, 1);

    section('T7: 두 탭이 같은 매물을 동시에 잡아도 클릭은 1회 (자동 해제 모드)');
    // 실제로 가장 위험한 경합. 두 탭 모두 켜진 상태에서 같은 응답을 받으면
    // 둘 다 canTriggerHideout 을 통과한 뒤 각자 랜덤 딜레이로 클릭을 예약한다.
    const store2 = makeSharedStore();
    const clock2 = makeClock();

    seedStore(store2, LS_LAST_TELEPORT, String(Date.now() - 60_000));

    const D = makeTab('D', store2, clock2);
    const E = makeTab('E', store2, clock2);

    D.clickToggle();
    check('D ON', D.armedText(), '모든 탭 ON');
    check('E ON', E.armedText(), '모든 탭 ON');

    const id3 = 'c'.repeat(64);
    D.addRow(id3);
    E.addRow(id3);

    D.livePush(id3);
    E.livePush(id3);

    const iso3 = new Date().toISOString();
    await D.feed(id3, iso3);
    await E.feed(id3, iso3);

    check('두 탭 모두 클릭 예약됨', clock2.pending() >= 2, true);

    clock2.flush();

    check('전체 클릭 합계 = 1', D.clicks.length + E.clicks.length, 1);

    // 이 모드에서 억제되는 경로: 먼저 이동한 탭이 "꺼짐" 을 브로드캐스트하고,
    // 늦은 탭은 applyAutoHideout → cancelHideout 으로 예약이 취소된다.
    // (클릭 직전 쿨다운 재확인까지 갈 필요가 없다.)
    check('늦은 탭은 꺼짐 전파로 예약이 취소됨',
          [...D.logs, ...E.logs].some(([, m]) =>
              m.includes('모든 탭 자동이동 OFF') && m.includes('다른 탭에서 변경')),
          true);

    section('T8: 연속 이동 모드(DISARM_AFTER_TELEPORT=false)에서도 클릭은 1회');
    // 자동으로 꺼지지 않으므로 이번엔 클릭 직전 쿨다운 재확인이 유일한 방어선이다.
    const SRC_NO_DISARM = SRC.replace(
        'const DISARM_AFTER_TELEPORT = true;',
        'const DISARM_AFTER_TELEPORT = false;');

    check('소스 패치 적용됨', SRC_NO_DISARM !== SRC, true);

    const store3 = makeSharedStore();
    const clock3 = makeClock();

    seedStore(store3, LS_LAST_TELEPORT, String(Date.now() - 60_000));

    const G = makeTab('G', store3, clock3, SRC_NO_DISARM);
    const H = makeTab('H', store3, clock3, SRC_NO_DISARM);

    G.clickToggle();
    check('G ON', G.armedText(), '모든 탭 ON');
    check('H ON', H.armedText(), '모든 탭 ON');

    const id4 = 'd'.repeat(64);
    G.addRow(id4);
    H.addRow(id4);

    G.livePush(id4);
    H.livePush(id4);

    const iso4 = new Date().toISOString();
    await G.feed(id4, iso4);
    await H.feed(id4, iso4);

    clock3.flush();

    check('전체 클릭 합계 = 1', G.clicks.length + H.clicks.length, 1);
    check('둘 다 여전히 켜진 상태',
          [G.armedText(), H.armedText()], ['모든 탭 ON', '모든 탭 ON']);
    check('늦은 탭에 click 취소(쿨다운 재확인) 로그 있음',
          [...G.logs, ...H.logs].some(([, m]) =>
              m.includes('click 취소') && m.includes('다른 탭이 이동')),
          true);

    section('T9: localStorage 가 막혀도 탭 단독으로 동작');
    // 시크릿 모드나 사이트 데이터 차단 설정에서 localStorage 가 던진다.
    const blockedStore = {
        register() {},
        forTab: () => ({
            getItem() { throw new Error('blocked'); },
            setItem() { throw new Error('blocked'); },
        }),
        dump: () => ({}),
    };

    const F = makeTab('F', blockedStore, clock);
    check('F 가 크래시 없이 초기화됨', F.armedText(), '모든 탭 OFF');
    F.clickToggle();
    check('F 수동 토글은 여전히 동작', F.armedText(), '모든 탭 ON');
    check('F 에 공유 불가 경고 있음',
          F.logs.some(([lvl, m]) =>
              lvl === 'warn' && m.includes('localStorage') && m.includes('탭 간 공유')),
          true);

    section('T10: POE1 / POE2 fetch URL 을 각각 올바른 스코프로 구분한다');
    // @match 가 두 게임을 다 받으므로 후킹은 /api/trade/fetch 와 /api/trade2/fetch
    // 양쪽을 잡아야 한다. 정규식이 trade2 를 trade 로 잘못 읽으면 로그 스코프가
    // 뒤바뀌어, 어느 게임에서 난 문제인지 추적할 수 없게 된다.
    const storeG = makeSharedStore();
    const clockG = makeClock();

    const P1 = makeTab('P1', storeG, clockG);
    await P1.feed('e'.repeat(64), new Date().toISOString(), 'trade');

    check('POE1 URL → [POE][POE1] 스코프',
          P1.logs.some(([, m]) => m.includes('[POE][POE1] trigger')), true);
    check('POE1 로그에 POE2 스코프 없음',
          P1.logs.some(([, m]) => m.includes('[POE][POE2]')), false);

    const P2 = makeTab('P2', storeG, clockG);
    await P2.feed('f'.repeat(64), new Date().toISOString(), 'trade2');

    check('POE2 URL → [POE][POE2] 스코프',
          P2.logs.some(([, m]) => m.includes('[POE][POE2] trigger')), true);
    check('POE2 로그에 POE1 스코프 없음',
          P2.logs.some(([, m]) => m.includes('[POE][POE1]')), false);

    section('T11: 라이브 푸시가 없으면 이동하지 않는다 (수동 검색 시나리오)');
    // 원래 버그. 라이브가 꺼진 탭에서 손으로 검색해도 스위치는 탭 간 공유라
    // 그대로 발동했다. 이제는 소켓이 알려준 id 가 아니면 이동하지 않는다.
    const storeS = makeSharedStore();
    const clockS = makeClock();

    const S = makeTab('S', storeS, clockS);

    S.clickToggle();
    check('S ON', S.armedText(), '모든 탭 ON');

    const idSearch = '1'.repeat(64);
    S.addRow(idSearch);

    await S.feed(idSearch, new Date().toISOString());      // 검색 결과 본문 fetch
    clockS.flush();

    check('라이브 확인 없으면 클릭하지 않음', S.clicks, []);
    check('스위치 유지 (꺼지지 않음)', S.armedText(), '모든 탭 ON');
    check('소켓을 못 봤다는 이유가 남는다',
          S.logs.some(([, m]) =>
              m.includes('skip: 라이브 소켓을 하나도 못 봤다')), true);
    check('알림은 그대로 나감 (막는 건 이동뿐)',
          S.logs.some(([, m]) => m.includes('trigger')), true);

    section('T12: 소켓이 밀어준 매물은 이동한다');
    // T11 의 억제가 기능을 통째로 죽이면 안 된다.
    const idLive = '2'.repeat(64);
    S.addRow(idLive);
    S.livePush(idLive);
    await S.feed(idLive, new Date().toISOString());
    clockS.flush();

    check('라이브 푸시는 클릭됨', S.clicks, [idLive]);
    check('이동 후 자동으로 꺼짐', S.armedText(), '모든 탭 OFF');
    check('푸시 수신 로그 있음',
          S.logs.some(([, m]) => m.includes('[POE][LIVE] 푸시 1건')), true);

    section('T13: 소켓을 본 뒤에도 목록에 없는 매물은 막고, 이유를 구분한다');
    // 소켓이 살아 있는 탭에서 손으로 검색한 경우. "소켓을 못 봤다" 와는
    // 대처가 다르므로 로그가 달라야 한다.
    const idOther = '7'.repeat(64);
    S.clickToggle();                       // 다시 켜기
    S.addRow(idOther);
    await S.feed(idOther, new Date().toISOString());
    clockS.flush();

    check('목록에 없으면 클릭하지 않음', S.clicks, [idLive]);
    check('소켓은 봤지만 확인 안 됐다는 이유가 남는다',
          S.logs.some(([, m]) =>
              m.includes('skip: 라이브 푸시로 확인되지 않았다')), true);

    section('T14: 라이브 푸시는 1회만 유효하다 (소비)');
    // 목록에 남겨두면 같은 id 의 오래된 fetch 가 나중에 이동을 일으킬 수 있다.
    const storeC = makeSharedStore();
    const clockC = makeClock();

    const Cs = makeTab('Cs', storeC, clockC);
    Cs.clickToggle();

    const idOnce = '8'.repeat(64);
    Cs.addRow(idOnce);
    Cs.livePush(idOnce);

    const oldIso = new Date(Date.now() - 300_000).toISOString();
    await Cs.feed(idOnce, oldIso);         // 첫 fetch — 나이로 skip, 허가는 소비됨
    clockC.flush();

    check('오래된 매물이라 이동 없음', Cs.clicks, []);

    await Cs.feed(idOnce, new Date().toISOString());   // 같은 id 재등장
    clockC.flush();

    check('소비된 허가로는 다시 이동하지 않음', Cs.clicks, []);
    check('두 번째는 확인 안 됨 이유',
          Cs.logs.filter(([, m]) =>
              m.includes('라이브 푸시로 확인되지 않았다')).length, 1);

    section('T15: 사이트가 onmessage 로 핸들러를 달아도 소켓을 관찰한다');
    // 사이트가 addEventListener 를 쓸지 onmessage 를 쓸지 모른다. 둘 다 잡아야 한다.
    // 그리고 후킹이 사이트의 원래 핸들러를 깨면 라이브 검색 자체가 죽는다.
    const storeW = makeSharedStore();
    const clockW = makeClock();

    const W = makeTab('W', storeW, clockW);
    W.clickToggle();

    const sock = W.openSocket(
        'wss://poe.kakaogames.com/api/trade/live/Standard/abc', 'onmessage');

    const idOn = '9'.repeat(64);
    W.addRow(idOn);
    sock.deliver(JSON.stringify({ new: [idOn] }));

    await W.feed(idOn, new Date().toISOString());
    clockW.flush();

    check('onmessage 경로로도 이동한다', W.clicks, [idOn]);
    check('사이트의 원래 핸들러도 그대로 호출된다',
          W.siteMessages.length, 1);
    check('소켓 URL 을 남긴다',
          W.logs.some(([, m]) =>
              m.includes('소켓 관찰 시작') && m.includes('/api/trade/live/')), true);

    section('T16: 처리 대상 아닌 거래소 API 는 경로별 1회만 진단 로그를 남긴다');
    // "search 로그가 없다" 의 원인이 (경로명이 다름) 인지 (fetch 를 안 씀) 인지
    // 구분하는 유일한 단서다. 시끄러우면 사람이 꺼버리므로 중복은 남기지 않는다.
    const storeD = makeSharedStore();
    const clockD = makeClock();

    const Dg = makeTab('Dg', storeD, clockD);

    await Dg.feedRaw('https://poe.kakaogames.com/api/trade/query/Standard?x=1', {});
    await Dg.feedRaw('https://poe.kakaogames.com/api/trade/query/Hardcore?x=2', {});
    await Dg.feedRaw('https://poe.kakaogames.com/api/trade/data/stats', {});
    await Dg.feedRaw('https://poe.kakaogames.com/static/thing.json', {});

    const diag = Dg.logs.filter(([, m]) => m.includes('처리 대상 아닌 거래소 API'));

    check('경로 2종만 남는다 (같은 경로 중복 제거)', diag.length, 2);
    check('쿼리스트링/리그를 떼고 경로만 남긴다',
          diag.some(([, m]) => m.includes('/api/trade/query')), true);
    check('/api 가 아닌 요청은 남기지 않는다',
          diag.some(([, m]) => m.includes('static')), false);

    section('T17: body 가 없는 시점(document-start)에 시작해도 살아남는다');
    // 후킹을 사이트보다 먼저 걸려면 document-start 여야 하는데, 그 시점엔 body 가
    // 없다. 오버레이를 못 붙였다고 후킹까지 죽으면 본전도 못 찾는다.
    const storeE = makeSharedStore();
    const clockE = makeClock();

    const Es = makeTab('Es', storeE, clockE, SRC, { noBody: true });

    check('body 없이도 초기화됨', Es.armedText(), '모든 탭 OFF');
    check('아직 오버레이는 안 붙었다', Es.overlayAttached(), false);
    check('오버레이 실패 오류를 남기지 않는다',
          Es.logs.some(([lvl]) => lvl === 'error'), false);

    Es.domReady();
    check('DOMContentLoaded 에서 오버레이가 붙는다', Es.overlayAttached(), true);

    // body 가 없던 동안에도 후킹은 살아 있어야 한다.
    Es.clickToggle();
    const idLate = 'ab'.repeat(32);
    Es.addRow(idLate);
    Es.livePush(idLate);
    await Es.feed(idLate, new Date().toISOString());
    clockE.flush();

    check('후킹은 그대로 동작한다', Es.clicks, [idLate]);

    section('T18: 오버레이가 상태를 값 노드에 반영한다');
    // Live 줄은 장식이 아니라 고장 표시다. 소켓이 없으면 자동 이동은 절대
    // 발동하지 않으므로 빨간색이어야 하고, 소켓을 잡으면 초록으로 바뀌어야 한다.
    const storeU = makeSharedStore();
    const clockU = makeClock();

    const U = makeTab('U', storeU, clockU);

    check('소켓 없으면 Live 가 경고색', U.value('live').style.color, '#ff6b60');
    check('소켓 없음 문구', U.value('live').textContent, '● 소켓 없음');
    check('이동 이력 없으면 대시', U.value('teleport').textContent, '—');

    U.livePush('cd'.repeat(32));

    check('소켓을 잡으면 초록', U.value('live').style.color, '#4ac25e');
    check('소켓/푸시 개수 표시', U.value('live').textContent, '● 1 / 푸시 1');

    // 작동 중이면 버튼뿐 아니라 카드 전체가 물든다 (곁눈질로 보이도록).
    U.clickToggle();
    check('작동 중엔 카드 테두리가 호박색',
          U.btn.style.boxShadow.includes('240, 160, 32'), true);

    section('T19: 기본값 — 전체 OFF, 개별 사용');
    const storeT = makeSharedStore();
    const clockT = makeClock();

    const T1 = makeTab('T1', storeT, clockT);
    const T2 = makeTab('T2', storeT, clockT);

    check('모든 탭 기본 OFF', T1.armedText(), '모든 탭 OFF');
    check('이 탭 기본 ON', T1.tabText(), '이 탭 ON');

    section('T20: 이 탭 OFF 는 이 탭만 멈추고 다른 탭은 계속 이동한다');
    // 여러 탭에 다른 검색을 띄워두고 그중 하나만 재우는 게 목적이다.
    // 이게 전체를 건드리면 나머지 탭까지 같이 죽는다.
    T1.clickToggle();                      // 전체 ON (양쪽 탭)
    check('T2 도 ON (전파됨)', T2.armedText(), '모든 탭 ON');

    const writesBeforeMute = storeT.writeCount();
    T1.clickTabToggle();                   // T1 만 정지

    check('T1 OFF 표시', T1.tabText(), '이 탭 OFF');
    check('T1 의 전체 스위치는 그대로 ON', T1.armedText(), '모든 탭 ON');
    check('T2 는 영향 없음', T2.tabText(), '이 탭 ON');
    check('저장소에 아무것도 쓰지 않는다',
          storeT.writeCount() - writesBeforeMute, 0);

    const idMuted = 'e1'.repeat(32);
    T1.addRow(idMuted);
    T2.addRow(idMuted);
    T1.livePush(idMuted);
    T2.livePush(idMuted);

    const isoMuted = new Date().toISOString();
    await T1.feed(idMuted, isoMuted);
    await T2.feed(idMuted, isoMuted);
    clockT.flush();

    check('정지된 탭은 이동하지 않음', T1.clicks, []);
    check('다른 탭은 정상 이동', T2.clicks, [idMuted]);

    section('T21: 정지시키면 이미 예약된 이동도 취소된다');
    // 예약만 걸어두고 안 끊으면, 방금 정지 눌렀는데 몇 초 뒤에 끌려간다.
    const storeM = makeSharedStore();
    const clockM = makeClock();

    seedStore(storeM, LS_LAST_TELEPORT, String(Date.now() - 60_000));

    const M = makeTab('M', storeM, clockM);
    M.clickToggle();

    const idPending = 'f1'.repeat(32);
    M.addRow(idPending);
    M.livePush(idPending);
    await M.feed(idPending, new Date().toISOString());

    check('클릭이 예약됨', clockM.pending() >= 1, true);

    M.clickTabToggle();                    // 예약과 실행 사이에 정지
    clockM.flush();

    check('예약된 이동이 취소됨', M.clicks, []);

    section('T22: 다시 사용으로 돌리면 그대로 이동한다');
    // 정지가 탭을 영구히 망가뜨리면 안 된다.
    M.clickTabToggle();
    check('사용 상태로 복귀', M.tabText(), '이 탭 ON');
    check('전체는 계속 ON', M.armedText(), '모든 탭 ON');

    const idResume = 'f2'.repeat(32);
    M.addRow(idResume);
    M.livePush(idResume);
    await M.feed(idResume, new Date().toISOString());
    clockM.flush();

    check('복귀 후 정상 이동', M.clicks, [idResume]);

    section('T23: 모든 탭 ON + 이 탭 OFF 면 카드가 빛나지 않는다');
    // 카드가 빛나는 건 "지금 여기서 실제로 이동한다" 는 뜻이어야 한다.
    const storeV = makeSharedStore();
    const clockV = makeClock();

    const V = makeTab('V', storeV, clockV);

    V.clickToggle();
    check('작동 중이면 카드가 빛난다', V.cardGlowing(), true);

    V.clickTabToggle();
    check('이 탭을 끄면 광채가 꺼진다', V.cardGlowing(), false);
    check('상위 버튼은 흐려지지 않는다', V.btn.style.opacity, '1');
    check('모든 탭 상태 자체는 ON 유지', V.armedText(), '모든 탭 ON');

    V.clickTabToggle();
    check('다시 켜면 광채가 돌아온다', V.cardGlowing(), true);

    section('T23b: 모든 탭이 OFF 면 이 탭 스위치는 결정권이 없다');
    // 흐려지는 쪽은 항상 하위여야 한다. 상위를 흐리게 하면 종속 관계가
    // 뒤집혀 보인다 — "모든 탭 OFF 인데 이 탭 ON 이니 여긴 움직이나?"
    V.clickToggle();                       // 모든 탭 OFF

    check('모든 탭 OFF', V.armedText(), '모든 탭 OFF');
    check('이 탭은 ON 인 채로 남는다', V.tabText(), '이 탭 ON');
    check('하위 버튼이 흐려진다', V.tabBtn.style.opacity, '0.4');
    check('상위 버튼은 선명하다', V.btn.style.opacity, '1');
    check('광채 없음', V.cardGlowing(), false);

    // 그리고 실제로 움직이지 않아야 한다 — 상위 조건이 우선이다.
    const idTopOff = 'a7'.repeat(32);
    V.addRow(idTopOff);
    V.livePush(idTopOff);
    await V.feed(idTopOff, new Date().toISOString());
    clockV.flush();

    check('모든 탭 OFF 면 이 탭이 ON 이어도 이동하지 않는다', V.clicks, []);

    V.clickToggle();                       // 다시 모든 탭 ON
    check('되켜면 하위 버튼도 선명해진다', V.tabBtn.style.opacity, '1');

    section('T24: 키 이름이 new 가 아니어도 64자리 id 를 주워 이동한다');
    // 실제로 막힌 지점. {"new":[...]} 를 전제한 파서가 조용히 통과시켰다.
    // 키 이름을 맞히는 대신 값의 모양(64자리 16진수)으로 찾는다.
    const hex = (c) => c.repeat(64);

    for (const [label, payload, id] of [
        ['{"new":[id]}', (i) => ({ new: [i] }), hex('1')],
        ['{"ids":[id]}', (i) => ({ ids: [i] }), hex('2')],
        ['중첩 {"data":{"items":[{"id":id}]}}',
         (i) => ({ data: { items: [{ id: i }] } }), hex('3')],
        ['벌거벗은 배열 [id]', (i) => [i], hex('4')],
    ]) {

        const st = makeSharedStore();
        const ck = makeClock();
        const tb = makeTab('K', st, ck);

        tb.clickToggle();
        tb.addRow(id);

        const sk = tb.openSocket('wss://poe.kakaogames.com/api/trade/live/L/x');
        sk.deliver(JSON.stringify(payload(id)));

        await tb.feed(id, new Date().toISOString());
        ck.flush();

        check(`${label} → 이동`, tb.clicks, [id]);

    }

    section('T25: 매물 id 가 아닌 문자열은 줍지 않는다');
    // 아무 문자열이나 주우면 인증 토큰 같은 게 허가로 둔갑한다.
    const storeN = makeSharedStore();
    const clockN = makeClock();

    const N = makeTab('N', storeN, clockN);
    N.clickToggle();

    const idNoise = hex('5');
    N.addRow(idNoise);

    const skN = N.openSocket('wss://poe.kakaogames.com/api/trade/live/L/x');
    skN.deliver(JSON.stringify({ auth: true, token: 'abc123', name: '짧은문자열' }));

    await N.feed(idNoise, new Date().toISOString());
    clockN.flush();

    check('무관한 메시지로는 허가가 생기지 않음', N.clicks, []);

    section('T26: 문자열이 아닌 프레임도 로그를 남긴다');
    // 앞 버전은 여기서 로그 한 줄 없이 빠져나갔다 — 매물이 떠도 콘솔이 조용했다.
    const storeB = makeSharedStore();
    const clockB = makeClock();

    const Bn = makeTab('Bn', storeB, clockB);
    Bn.clickToggle();

    const idBin = hex('6');
    Bn.addRow(idBin);

    const skB = Bn.openSocket('wss://poe.kakaogames.com/api/trade/live/L/x');
    skB.deliver(new TextEncoder().encode(JSON.stringify({ new: [idBin] })).buffer);

    await Bn.feed(idBin, new Date().toISOString());
    clockB.flush();

    check('ArrayBuffer 프레임도 해석해 이동', Bn.clicks, [idBin]);
    check('원문 로그를 남긴다',
          Bn.logs.some(([, m]) => m.includes('[POE][LIVE] 원문 #1')), true);

    section('T27: 원문 로그는 상한에서 멈춘다');
    const storeQ = makeSharedStore();
    const clockQ = makeClock();

    const Q = makeTab('Q', storeQ, clockQ);
    const skQ = Q.openSocket('wss://poe.kakaogames.com/api/trade/live/L/x');

    for (let i = 0; i < 20; i++) skQ.deliver('ping');

    const raws = Q.logs.filter(([, m]) => m.includes('[POE][LIVE] 원문 #'));

    check('상한 8건에서 멈춘다', raws.length, 8);
    check('마지막 줄이 끝을 알린다',
          raws[raws.length - 1][1].includes('원문 로그는 여기까지만'), true);

    section('T28: 실제 카카오 프로토콜 — 소켓 토큰과 fetch 경로를 대조한다');
    // 소켓은 매물 id 를 주지 않는다. 서명 토큰 하나를 주고, 사이트가 그 토큰을
    // fetch 경로에 박아 요청한다. id 는 응답 본문에만 나온다.
    const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9'
        + '.eyJpc3MiOiI2ekJZajN3OXNHIiwiZXhwIjoxNzg1OTAyNDU3fQ'
        + '.NcEpUwju3SFrQbk8-gIRTVS5k71WGz1nNAdLUhqpr0BpB7UpEOCfJHb4ScXIPW8';

    const storeZ = makeSharedStore();
    const clockZ = makeClock();

    const Z = makeTab('Z', storeZ, clockZ);
    Z.clickToggle();

    const idTok = '9c'.repeat(32);
    Z.addRow(idTok);

    Z.livePushToken(TOKEN);
    await Z.feed(idTok, new Date().toISOString(), 'trade', TOKEN);
    clockZ.flush();

    check('토큰 경로로 온 응답은 이동한다', Z.clicks, [idTok]);
    check('토큰 수신 로그에 종류가 남는다',
          Z.logs.some(([, m]) => m.includes('[POE][LIVE] 푸시 1건')
                     && m.includes('토큰')), true);

    section('T29: 소켓이 준 적 없는 토큰 경로는 막고 경고를 남긴다');
    // 다른 탭의 토큰이거나 소켓 메시지를 놓친 경우. 조용히 막으면 또 원인을 못 찾는다.
    const storeY = makeSharedStore();
    const clockY = makeClock();

    const Y = makeTab('Y', storeY, clockY);
    Y.clickToggle();

    const idBad = '9d'.repeat(32);
    Y.addRow(idBad);

    await Y.feed(idBad, new Date().toISOString(), 'trade', TOKEN);   // 푸시 없이
    clockY.flush();

    check('기록에 없는 토큰이면 이동하지 않음', Y.clicks, []);
    check('토큰 불일치 경고를 남긴다',
          Y.logs.some(([lvl, m]) =>
              lvl === 'warn' && m.includes('소켓 기록에 없다')), true);

    section('T30: 수동 검색의 id 콤마 경로는 토큰으로 오인하지 않는다');
    // 수동 검색은 /fetch/<id>,<id>,... 로 온다. 이게 토큰으로 통과하면
    // 원래 고치려던 버그가 그대로 돌아온다.
    const storeX = makeSharedStore();
    const clockX = makeClock();

    const X = makeTab('X', storeX, clockX);
    X.clickToggle();
    X.livePushToken(TOKEN);            // 소켓은 살아 있고 토큰도 기록돼 있다

    const idManual = '9e'.repeat(32);
    X.addRow(idManual);

    await X.feed(idManual, new Date().toISOString(), 'trade',
                 `${idManual},${'9f'.repeat(32)}`);
    clockX.flush();

    check('id 콤마 경로로는 이동하지 않음', X.clicks, []);
    check('토큰 경고를 남기지 않는다 (토큰 모양이 아니므로)',
          X.logs.some(([lvl]) => lvl === 'warn'), false);

    section('T31: 조작 3개는 언제나 보인다 (상세만 접힌다)');
    // 휴대폰으로 PC 를 원격하며 쓴다. 화면이 축소돼 보이니 작은 표적을 조준하는
    // 것 자체가 노동이다. 가장 자주 하는 조작이 가장 어려우면 안 된다.
    const storeO = makeSharedStore();
    const clockO = makeClock();

    const O = makeTab('O', storeO, clockO);

    check('세 버튼이 모두 있다',
          [!!O.btn, !!O.tabBtn, !!O.detailBtn], [true, true, true]);
    check('버튼은 숨지 않는다',
          [O.btn.style.display, O.tabBtn.style.display, O.detailBtn.style.display]
              .every((d) => d !== 'none'), true);
    check('상세는 접힌 채로 시작', O.isCollapsed(), true);
    check('접기 버튼이 여는 쪽을 가리킨다',
          O.detailText().includes('자세히 보기'), true);

    O.clickDetail();
    check('누르면 상세가 열린다', O.isCollapsed(), false);
    check('같은 버튼이 접는 쪽으로 바뀐다',
          O.detailText().includes('접기'), true);

    O.clickDetail();
    check('다시 누르면 접힌다', O.isCollapsed(), true);

    section('T32: 상세를 접어둬도 "켜뒀는데 소켓 없음" 은 드러난다');
    // 켜진 줄 알고 자리를 비우게 만드는 상태라 접힌 채로도 보여야 한다.
    check('꺼져 있을 땐 경고하지 않는다',
          O.detailText().includes('소켓 없음'), false);

    O.clickToggle();                       // 모든 탭 ON (소켓은 없음)
    check('켜면 접기 버튼에 경고가 붙는다',
          O.detailText().includes('소켓 없음'), true);
    check('경고색', O.detailBtn.style.color, '#ff6b60');

    O.livePushToken('aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
    check('소켓이 살아나면 경고가 사라진다',
          O.detailText().includes('소켓 없음'), false);

    O.clickTabToggle();                    // 이 탭만 정지 → 이 탭은 안 움직인다
    check('이 탭이 빠져 있으면 소켓 경고도 무의미하다',
          O.detailText().includes('소켓 없음'), false);

    section('T33: 끌어서 옮기면 위치를 기억한다');
    // 어느 자리가 안전한지는 사이트 레이아웃과 창 크기에 달렸다. 사람이 고른다.
    const storeDr = makeSharedStore();
    const clockDr = makeClock();

    const Dr = makeTab('Dr', storeDr, clockDr);

    check('기본 위치', [Dr.overlay.style.right, Dr.overlay.style.bottom],
          ['20px', '80px']);

    Dr.dragBy(-30, -50);                   // 왼쪽 아래로 → right/bottom 증가

    check('끈 만큼 옮겨진다',
          [Dr.overlay.style.right, Dr.overlay.style.bottom], ['50px', '130px']);
    check('위치 저장 로그',
          Dr.logs.some(([, m]) => m.includes('오버레이 위치 저장')), true);

    const Dr2 = makeTab('Dr2', storeDr, clockDr);
    check('새 탭이 저장된 위치를 이어받는다',
          [Dr2.overlay.style.right, Dr2.overlay.style.bottom], ['50px', '130px']);

    section('T34: 옮기려던 손짓이 스위치를 건드리지 않는다');
    // 버튼 위에서 끌기 시작해도 되게 했으므로, 이동 뒤 click 은 삼켜야 한다.
    const storeDg = makeSharedStore();
    const clockDg = makeClock();

    const Dg2 = makeTab('Dg2', storeDg, clockDg);
    Dg2.clickDetail();                     // 상세를 펼쳐두고

    const armedBefore = Dg2.armedText();

    Dg2.dragBy(-40, 0);
    Dg2.btn.onclick();                     // 이동 직후 브라우저가 쏘는 click

    check('이동 뒤 click 은 무시된다', Dg2.armedText(), armedBefore);

    Dg2.btn.onclick();                     // 다음 클릭은 정상 동작
    check('그 다음 클릭은 먹힌다', Dg2.armedText(), '모든 탭 ON');

    check('4px 미만은 이동이 아니다', (() => {
        Dg2.dragBy(1, 1);
        return Dg2.overlay.style.right;
    })(), '60px');

    section('T35: 작동 중이면 카드 바탕까지 호박빛으로 물든다');
    // 테두리만 물들이면 화면 구석에서는 선 한 줄이라 놓친다. 면이 물들어야
    // 눈길이 안 가 있어도 "저거 켜져 있다" 가 읽힌다.
    const storeTn = makeSharedStore();
    const clockTn = makeClock();

    const Tn = makeTab('Tn', storeTn, clockTn);

    check('꺼져 있으면 차가운 회청색', Tn.panel.style.background,
          'rgba(38, 44, 56, 0.97)');

    Tn.clickToggle();
    check('작동 중이면 호박빛 바탕', Tn.panel.style.background,
          'rgba(58, 47, 34, 0.97)');
    check('그 위의 홈도 같이 따뜻해진다', Tn.tabBtn.style.background, '#241c11');

    // 소켓이 없으면 접기 버튼은 경고(빨강)가 우선이다 — 색이 겹치면 경고가 이긴다.
    check('소켓 없을 땐 경고색이 이긴다', Tn.detailBtn.style.background,
          'rgba(255, 107, 96, 0.14)');

    Tn.livePushToken('aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
    check('소켓이 살면 접기 버튼도 따뜻해진다',
          Tn.detailBtn.style.background, '#241c11');

    // 모든 탭만 켜지고 이 탭이 빠지면 여기선 안 움직인다 → 물들면 안 된다.
    Tn.clickTabToggle();
    check('이 탭이 빠지면 바탕이 돌아온다', Tn.panel.style.background,
          'rgba(38, 44, 56, 0.97)');
    check('홈도 차가운 쪽으로', Tn.detailBtn.style.background, '#13161d');

    section('T36: 창이 좁아져도 오버레이가 화면 밖으로 사라지지 않는다');
    // 실제로 겪은 버그. 왼쪽 아래로 옮겨두면 right 가 창 폭에 가까운 큰 값이
    // 된다. 개발자 도구를 열어 창이 좁아지면 그 값이 그대로 남아 패널이 왼쪽
    // 밖으로 밀려나 사라졌고, 폭을 되돌리기 전까지 다시 잡을 방법이 없었다.
    const storeRz = makeSharedStore();
    const clockRz = makeClock();

    const Rz = makeTab('Rz', storeRz, clockRz, SRC, { width: 1728, height: 1084 });

    Rz.dragBy(-1400, -800);                // 왼쪽 아래 구석으로

    check('넓은 창에서는 끈 자리에 있다', Rz.pos(), ['1420px', '880px']);

    Rz.resizeTo(900, 700);                 // 개발자 도구를 열어 창이 좁아짐

    const [r, b] = Rz.pos().map((v) => parseInt(v, 10));

    check('좁아지면 화면 안으로 다시 들어온다',
          [r <= 900 - 216, b <= 700 - 120], [true, true]);
    check('음수로 밀려나지도 않는다', [r >= 0, b >= 0], [true, true]);

    Rz.resizeTo(1728, 1084);               // 개발자 도구를 닫음

    check('창이 돌아오면 원래 자리로 복귀한다', Rz.pos(), ['1420px', '880px']);

    section('T37: 좁은 창에서 새로 연 탭도 화면 안에 그린다');
    // 저장된 값이 이미 지금 창보다 클 수 있다. 시작할 때부터 가둬야 한다.
    const Rz2 = makeTab('Rz2', storeRz, clockRz, SRC, { width: 800, height: 600 });

    const [r2, b2] = Rz2.pos().map((v) => parseInt(v, 10));

    check('처음부터 화면 안', [r2 <= 800 - 216, b2 <= 600 - 120], [true, true]);

    section('A 탭 로그 전문 (형식 눈으로 확인용)');
    for (const [lvl, m] of A.logs) console.log(`  [${lvl}] ${m}`);

    console.log(`\n${failures === 0 ? '전체 통과' : failures + '건 실패'}`);
    process.exit(failures === 0 ? 0 : 1);

})();
