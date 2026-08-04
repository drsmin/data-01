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
function makeTab(name, store, clock, src = SRC) {

    const logs = [];
    const clicks = [];
    const rows = new Map();
    const created = [];

    const el = () => ({
        style: { cssText: '' },
        textContent: '',
        appendChild() {},
        focus() {},
    });

    const document = {
        title: '',
        body: { appendChild() {} },
        createElement() { const e = el(); created.push(e); return e; },
        querySelector(sel) {
            const m = /data-id="([^"]+)"/.exec(sel);
            if (!m) return null;
            return rows.get(m[1]) || null;
        },
    };

    const listeners = [];
    const window = {
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
        src);

    fn(window, document, tab.localStorage, console_,
       Response, MouseEvent, MutationObserver, { escape: (s) => s },
       clock.setTimeout, clock.clearTimeout,
       () => {}, { script: { version: 'test' } });

    // createElement 호출 순서: overlay, hideoutBtn, status
    tab.btn = created[1];
    tab.status = created[2];

    tab.armedText = () => tab.btn.textContent;
    tab.clickToggle = () => tab.btn.onclick();

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

    // 거래소 fetch 응답 1건을 흘려보낸다. 실제 응답 형태를 따른다.
    tab.feed = async (id, indexedIso) => {
        const res = new Response(
            'https://poe.kakaogames.com/api/trade2/fetch/' + id,
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
    check('A ON', A.armedText(), 'AUTO HO ON');
    check('B ON (전파됨)', B.armedText(), 'AUTO HO ON');
    check('저장소 armed', store.dump()[LS_ARMED], '1');

    section('T2: B 에서 끄면 A 도 꺼진다');
    B.clickToggle();
    check('B OFF', B.armedText(), 'AUTO HO OFF');
    check('A OFF (전파됨)', A.armedText(), 'AUTO HO OFF');

    section('T3: 무장 중 새 탭을 열면 상태를 이어받고, 기존 탭을 끄지 않는다');
    A.clickToggle();                       // 다시 ON
    const C = makeTab('C', store, clock);
    check('C 가 ON 으로 시작', C.armedText(), 'AUTO HO ON');
    check('A 는 여전히 ON', A.armedText(), 'AUTO HO ON');
    check('B 는 여전히 ON', B.armedText(), 'AUTO HO ON');

    section('T4: A 가 이동하면 전체가 해제되고 쿨다운이 공유된다');
    const id1 = 'a'.repeat(64);
    A.addRow(id1);
    await A.feed(id1, new Date().toISOString());
    clock.flush();                         // 예약된 클릭 실행
    check('A 가 클릭 1회', A.clicks, [id1]);
    check('A OFF (자동 해제)', A.armedText(), 'AUTO HO OFF');
    check('B OFF (전파됨)', B.armedText(), 'AUTO HO OFF');
    check('C OFF (전파됨)', C.armedText(), 'AUTO HO OFF');
    check('저장소에 lastTeleport 기록',
          typeof store.dump()[LS_LAST_TELEPORT], 'string');

    section('T5: 쿨다운 중 다른 탭은 이동하지 않는다');
    B.clickToggle();                       // 전체 재무장
    check('B ON', B.armedText(), 'AUTO HO ON');
    const id2 = 'b'.repeat(64);
    B.addRow(id2);
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
    // 실제로 가장 위험한 경합. 두 탭 모두 무장 상태에서 같은 응답을 받으면
    // 둘 다 canTriggerHideout 을 통과한 뒤 각자 랜덤 딜레이로 클릭을 예약한다.
    const store2 = makeSharedStore();
    const clock2 = makeClock();

    seedStore(store2, LS_LAST_TELEPORT, String(Date.now() - 60_000));

    const D = makeTab('D', store2, clock2);
    const E = makeTab('E', store2, clock2);

    D.clickToggle();
    check('D ON', D.armedText(), 'AUTO HO ON');
    check('E ON', E.armedText(), 'AUTO HO ON');

    const id3 = 'c'.repeat(64);
    D.addRow(id3);
    E.addRow(id3);

    const iso3 = new Date().toISOString();
    await D.feed(id3, iso3);
    await E.feed(id3, iso3);

    check('두 탭 모두 클릭 예약됨', clock2.pending() >= 2, true);

    clock2.flush();

    check('전체 클릭 합계 = 1', D.clicks.length + E.clicks.length, 1);

    // 이 모드에서 억제되는 경로: 먼저 이동한 탭이 무장 해제를 브로드캐스트하고,
    // 늦은 탭은 applyAutoHideout → cancelHideout 으로 예약이 취소된다.
    // (클릭 직전 쿨다운 재확인까지 갈 필요가 없다.)
    check('늦은 탭은 무장 해제 전파로 예약이 취소됨',
          [...D.logs, ...E.logs].some(([, m]) =>
              m.includes('auto hideout OFF') && m.includes('다른 탭에서 변경')),
          true);

    section('T8: 연속 이동 모드(DISARM_AFTER_TELEPORT=false)에서도 클릭은 1회');
    // 무장 해제가 없으므로 이번엔 클릭 직전 쿨다운 재확인이 유일한 방어선이다.
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
    check('G ON', G.armedText(), 'AUTO HO ON');
    check('H ON', H.armedText(), 'AUTO HO ON');

    const id4 = 'd'.repeat(64);
    G.addRow(id4);
    H.addRow(id4);

    const iso4 = new Date().toISOString();
    await G.feed(id4, iso4);
    await H.feed(id4, iso4);

    clock3.flush();

    check('전체 클릭 합계 = 1', G.clicks.length + H.clicks.length, 1);
    check('둘 다 여전히 무장 상태',
          [G.armedText(), H.armedText()], ['AUTO HO ON', 'AUTO HO ON']);
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
    check('F 가 크래시 없이 초기화됨', F.armedText(), 'AUTO HO OFF');
    F.clickToggle();
    check('F 수동 토글은 여전히 동작', F.armedText(), 'AUTO HO ON');
    check('F 에 공유 불가 경고 있음',
          F.logs.some(([lvl, m]) =>
              lvl === 'warn' && m.includes('localStorage') && m.includes('탭 간 공유')),
          true);

    section('A 탭 로그 전문 (형식 눈으로 확인용)');
    for (const [lvl, m] of A.logs) console.log(`  [${lvl}] ${m}`);

    console.log(`\n${failures === 0 ? '전체 통과' : failures + '건 실패'}`);
    process.exit(failures === 0 ? 0 : 1);

})();
