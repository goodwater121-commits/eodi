/* 어디뒀지 — 우리 집 물건 위치 공유 앱 (PWA)
 * 데이터: Supabase (DB · 로그인 · 사진 저장소 · 실시간)
 * config.js 가 비어 있으면 데모 모드로 실행된다.
 */
(function () {
'use strict';

const APP_VERSION = '1.0.0';
const CFG = window.EODI_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
let sb = null;

/* ================= 공통 도우미 ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const KINDS = { room: '방', furniture: '가구', slot: '칸·서랍', box: '수납함' };
const PRESET = ['거실', '안방', '작은방', '주방', '욕실', '베란다', '현관', '다용도실'];
const QR_PREFIX = 'EODI:';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const S = {
  me: null, hid: null, household: null, households: [], members: new Map(),
  places: new Map(), items: new Map(), logs: [],
  loaded: false, live: false, view: 'find', browseId: null, q: '', recentFilter: 'all',
  lastSeen: 0, pendingPlace: null, pendingAction: null, installPrompt: null, swReg: null, hiddenAt: 0
};

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const cho = s => [...String(s)].map(c => { const k = c.charCodeAt(0) - 0xAC00; return (k >= 0 && k < 11172) ? CHO[Math.floor(k / 588)] : c; }).join('');
const compact = s => String(s || '').replace(/\s+/g, '').toLowerCase();
const isChoQuery = q => /^[ㄱ-ㅎ\s]+$/.test(q);

function pathOf(id) { const out = []; const seen = new Set(); let p = id ? S.places.get(id) : null;
  while (p && !seen.has(p.id)) { seen.add(p.id); out.unshift(p); p = p.parentId ? S.places.get(p.parentId) : null; } return out; }
const pathStr = id => pathOf(id).map(p => p.name).join(' › ');
function childrenOf(pid) { return [...S.places.values()].filter(p => (p.parentId || null) === (pid || null))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ko')); }
function itemsIn(pid) { return [...S.items.values()].filter(i => i.placeId === pid).sort((a, b) => b.updatedAt - a.updatedAt); }
function countDeep(pid, memo) { if (memo.has(pid)) return memo.get(pid); let n = itemsIn(pid).length;
  for (const c of childrenOf(pid)) n += countDeep(c.id, memo); memo.set(pid, n); return n; }
function who(id) { if (!id) return '가족'; if (id === S.me) return '나'; const m = S.members.get(id); return (m && m.name) || '가족'; }
function whoShort(id) { const w = who(id); return w === '나' ? '나' : [...w].slice(0, 2).join(''); }
function ago(ts) { if (!ts) return ''; const d = Date.now() - ts, m = Math.floor(d / 60000); if (m < 1) return '방금'; if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60); if (h < 24) return h + '시간 전'; const t = new Date(ts), y = new Date(); y.setDate(y.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return '어제'; return (t.getMonth() + 1) + '월 ' + t.getDate() + '일'; }
function dayLabel(ts) { const t = new Date(ts), n = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
  if (t.toDateString() === n.toDateString()) return '오늘'; if (t.toDateString() === y.toDateString()) return '어제';
  return (t.getMonth() + 1) + '월 ' + t.getDate() + '일 (' + '일월화수목금토'[t.getDay()] + ')'; }
const hm = ts => { const t = new Date(ts); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
function tapePath(path) { if (!path.length) return '<span class="nopath">위치 미지정</span>';
  return '<span class="tapes">' + path.map((p, i) => `<span class="tape${i < path.length - 2 ? ' dim' : ''}">${esc(p.name)}</span>`).join('<i class="sep">›</i>') + '</span>'; }
function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms || 2600); }
const verb = { add: '새로 정리', move: '위치 옮김', edit: '정보 수정', delete: '삭제' };
function friendlyError(e) {
  const m = String((e && (e.message || e.error_description)) || e || '');
  if (/invalid invite code/i.test(m)) return '초대코드가 맞지 않아요. 6자리를 다시 확인해 주세요.';
  if (/fetch|network|Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인하고 다시 시도해 주세요.';
  if (/violates foreign key/i.test(m)) return '안에 다른 공간이 있어서 지울 수 없어요.';
  if (/row-level security|permission denied/i.test(m)) return '권한이 없어요. 같은 집 구성원인지 확인해 주세요.';
  if (/Token has expired|invalid.*otp|otp.*invalid/i.test(m)) return '인증번호가 틀렸거나 시간이 지났어요. 다시 받아 주세요.';
  if (/rate limit|too many/i.test(m)) return '요청이 너무 많아요. 1분 뒤에 다시 시도해 주세요.';
  return '문제가 생겼어요: ' + m.slice(0, 120);
}
function showScreen(name) { for (const n of ['login', 'onboard', 'app']) $('#screen-' + n).hidden = n !== name; }

/* ================= 데이터 매핑 ================= */
const mapPlace = r => ({ id: r.id, name: r.name, parentId: r.parent_id || null, kind: r.kind, order: r.sort ?? 0 });
const mapItem = r => ({ id: r.id, name: r.name, memo: r.memo || '', placeId: r.place_id || null, photoPath: r.photo_path || null,
  updatedBy: r.updated_by, updatedAt: Date.parse(r.updated_at) || Date.now(), createdAt: Date.parse(r.created_at) || Date.now() });
const mapLog = r => ({ id: String(r.id), itemId: r.item_id, itemName: r.item_name, action: r.action, from: r.from_path || '', to: r.to_path || '',
  by: r.by_user, at: Date.parse(r.at) || Date.now() });
const mapMember = r => ({ id: r.user_id, name: r.display_name, role: r.role });

/* ================= 저장소 (Supabase / 데모) ================= */
async function fetchAll(table, build) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build(sb.from(table).select('*')).range(from, from + size - 1);
    if (error) throw error; out.push(...data); if (data.length < size) break;
  }
  return out;
}

const photoCache = new Map(); // path -> {url, exp}
const api = {
  async loadAll() {
    if (DEMO) return;
    const hid = S.hid;
    const [h, m, places, items, logs] = await Promise.all([
      sb.from('households').select('id,name,invite_code,created_by').eq('id', hid).single(),
      sb.from('members').select('user_id,display_name,role').eq('household_id', hid),
      fetchAll('places', q => q.eq('household_id', hid)),
      fetchAll('items', q => q.eq('household_id', hid)),
      sb.from('logs').select('*').eq('household_id', hid).order('at', { ascending: false }).limit(300)
    ]);
    if (h.error) throw h.error; if (m.error) throw m.error; if (logs.error) throw logs.error;
    S.household = h.data;
    S.members = new Map(m.data.map(r => [r.user_id, mapMember(r)]));
    S.places = new Map(places.map(r => [r.id, mapPlace(r)]));
    S.items = new Map(items.map(r => [r.id, mapItem(r)]));
    S.logs = logs.data.map(mapLog);
    S.loaded = true;
  },
  async refreshLogs() {
    if (DEMO) return;
    const { data, error } = await sb.from('logs').select('*').eq('household_id', S.hid).order('at', { ascending: false }).limit(300);
    if (!error) { S.logs = data.map(mapLog); scheduleRender(); }
  },
  async addPlace({ name, kind, parentId }) {
    const row = { id: uuid(), household_id: S.hid, parent_id: parentId || null, name, kind, sort: childrenOf(parentId || null).length };
    if (!DEMO) { const { data, error } = await sb.from('places').insert(row).select().single(); if (error) throw error; S.places.set(data.id, mapPlace(data)); }
    else S.places.set(row.id, mapPlace(row));
    scheduleRender(); return row.id;
  },
  async updatePlace(id, { name, kind }) {
    if (!DEMO) { const { data, error } = await sb.from('places').update({ name, kind }).eq('id', id).select().single(); if (error) throw error; S.places.set(id, mapPlace(data)); }
    else Object.assign(S.places.get(id), { name, kind });
    scheduleRender();
  },
  async deletePlace(id) {
    if (!DEMO) { const { error } = await sb.from('places').delete().eq('id', id); if (error) throw error; }
    S.places.delete(id); scheduleRender();
  },
  async saveItem({ id, name, memo, placeId, photoBlob, removePhoto }) {
    const old = id ? S.items.get(id) : null;
    let photoPath = old ? old.photoPath : null; let oldPhoto = null;
    if (photoBlob) {
      const path = `${S.hid}/${uuid()}.jpg`;
      if (!DEMO) { const { error } = await sb.storage.from('photos').upload(path, photoBlob, { contentType: 'image/jpeg', upsert: false }); if (error) throw error; }
      else photoCache.set(path, { url: URL.createObjectURL(photoBlob), exp: Infinity });
      oldPhoto = photoPath; photoPath = path;
    } else if (removePhoto && photoPath) { oldPhoto = photoPath; photoPath = null; }
    const row = { name, memo, place_id: placeId, photo_path: photoPath };
    let saved;
    if (!DEMO) {
      const q = old ? sb.from('items').update(row).eq('id', id) : sb.from('items').insert({ id: uuid(), household_id: S.hid, ...row });
      const { data, error } = await q.select().single(); if (error) throw error; saved = mapItem(data);
      S.items.set(saved.id, saved);
      if (oldPhoto) sb.storage.from('photos').remove([oldPhoto]).catch(() => {});
      api.refreshLogs();
    } else {
      const now = Date.now(); const nid = id || uuid();
      saved = { id: nid, name, memo, placeId, photoPath, updatedBy: S.me, updatedAt: now, createdAt: old ? old.createdAt : now };
      S.items.set(nid, saved);
      const action = !old ? 'add' : (old.placeId !== placeId ? 'move' : 'edit');
      S.logs.unshift({ id: uuid(), itemId: nid, itemName: name, action, from: old && action === 'move' ? pathStr(old.placeId) : '', to: pathStr(placeId), by: S.me, at: now });
    }
    scheduleRender();
    return { saved, action: !old ? 'add' : (old.placeId !== placeId ? 'move' : 'edit') };
  },
  async deleteItem(id) {
    const it = S.items.get(id); if (!it) return;
    if (!DEMO) {
      const { error } = await sb.from('items').delete().eq('id', id); if (error) throw error;
      if (it.photoPath) sb.storage.from('photos').remove([it.photoPath]).catch(() => {});
      api.refreshLogs();
    } else S.logs.unshift({ id: uuid(), itemId: id, itemName: it.name, action: 'delete', from: pathStr(it.placeId), to: '', by: S.me, at: Date.now() });
    S.items.delete(id); scheduleRender();
  },
  async photoUrl(path) {
    if (!path) return null;
    const c = photoCache.get(path); if (c && c.exp > Date.now()) return c.url;
    if (DEMO) return null;
    if (api._pending.has(path)) return api._pending.get(path);
    const p = sb.storage.from('photos').createSignedUrl(path, 60 * 60 * 6).then(({ data, error }) => {
      api._pending.delete(path); if (error || !data) return null;
      photoCache.set(path, { url: data.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 5 }); return data.signedUrl;
    });
    api._pending.set(path, p); return p;
  },
  _pending: new Map(),
  async renameMe(name) {
    if (!DEMO) { const { error } = await sb.from('members').update({ display_name: name }).eq('household_id', S.hid).eq('user_id', S.me); if (error) throw error; }
    const m = S.members.get(S.me); if (m) m.name = name; scheduleRender();
  },
  async renameHouse(name) {
    if (!DEMO) { const { error } = await sb.from('households').update({ name }).eq('id', S.hid); if (error) throw error; }
    S.household.name = name; scheduleRender();
  },
  async rotateCode() {
    if (DEMO) { S.household.invite_code = 'NEW' + Math.floor(Math.random() * 900 + 100); return S.household.invite_code; }
    const { data, error } = await sb.rpc('rotate_invite_code', { hid: S.hid }); if (error) throw error;
    S.household.invite_code = data; return data;
  },
  async myHouseholds() {
    if (DEMO) return [{ id: 'demo', name: S.household.name }];
    const { data, error } = await sb.from('members').select('household_id, role, households(name)').eq('user_id', S.me).order('joined_at');
    if (error) throw error; return data.map(r => ({ id: r.household_id, name: (r.households && r.households.name) || '집' }));
  }
};

/* ================= 실시간 ================= */
let channel = null;
function subscribe() {
  if (DEMO) { S.live = true; return; }
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('house-' + S.hid);
  const filter = `household_id=eq.${S.hid}`;
  for (const t of ['places', 'items', 'logs', 'members']) {
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: t, filter }, p => onRow(t, 'INSERT', p.new));
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: t, filter }, p => onRow(t, 'UPDATE', p.new));
    channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table: t }, p => onRow(t, 'DELETE', p.old));
  }
  channel.subscribe(status => { S.live = status === 'SUBSCRIBED'; renderStatus(); });
}
function onRow(table, ev, r) {
  if (!r) return;
  if (table === 'places') { if (ev === 'DELETE') S.places.delete(r.id); else S.places.set(r.id, mapPlace(r)); }
  else if (table === 'items') { if (ev === 'DELETE') S.items.delete(r.id); else S.items.set(r.id, mapItem(r)); }
  else if (table === 'members') {
    if (ev === 'DELETE') S.members.delete(r.user_id); else S.members.set(r.user_id, mapMember(r));
  } else if (table === 'logs' && ev === 'INSERT') {
    const l = mapLog(r); if (S.logs.some(x => x.id === l.id)) return;
    S.logs.unshift(l); if (S.logs.length > 300) S.logs.length = 300;
    if (l.by && l.by !== S.me) notifyOther(l);
  }
  scheduleRender();
}
function notifyOther(l) {
  const msg = `${who(l.by)}: '${l.itemName}' ${verb[l.action] || '변경'}` + (l.to ? ` → ${l.to}` : '');
  toast(msg, 4500);
  if (document.hidden && lsGet('eodi.notify', false) && 'Notification' in window && Notification.permission === 'granted' && S.swReg) {
    S.swReg.showNotification('어디뒀지', { body: msg, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'eodi-' + l.itemId }).catch(() => {});
  }
}

/* ================= 렌더 ================= */
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function renderStatus() {
  const st = $('#status'); if (!st) return;
  if (DEMO) st.innerHTML = '<span class="dot"></span><span>데모</span>';
  else if (S.live) st.innerHTML = '<span class="dot live"></span><span>함께 보는 중</span>';
  else st.innerHTML = '<span class="dot"></span><span>연결 중</span>';
}
function render() {
  if ($('#screen-app').hidden) return;
  renderStatus();
  $('#house-name').textContent = (S.household && S.household.name) || '어디뒀지';
  for (const v of ['find', 'browse', 'recent']) $('#view-' + v).hidden = S.view !== v;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-current', t.dataset.tab === S.view ? 'page' : 'false'));
  const unseen = unseenLogs().length; const pip = $('#pip'); pip.hidden = !unseen; pip.textContent = unseen > 9 ? '9+' : unseen;
  if (S.view === 'find') renderFind(); else if (S.view === 'browse') renderBrowse(); else renderRecent();
  if (openSheet && openSheet.refresh) openSheet.refresh();
  hydratePhotos(document);
}
function unseenLogs() { return S.logs.filter(l => l.by && l.by !== S.me && l.at > S.lastSeen); }
function markSeen() { S.lastSeen = Date.now(); lsSet('eodi.lastSeen.' + S.hid, S.lastSeen); }

function itemCard(it) {
  return `<button class="card" data-act="item" data-id="${esc(it.id)}"><span class="thumb" data-photo="${esc(it.photoPath || '')}">${esc([...(it.name || '?')][0])}</span>
  <span class="cbody"><span class="cname">${esc(it.name)}</span>${tapePath(pathOf(it.placeId))}<span class="cmeta">${esc(who(it.updatedBy))} · ${ago(it.updatedAt)}</span></span></button>`;
}
function matchItem(it, q) {
  const path = pathStr(it.placeId); const cq = compact(q);
  if (isChoQuery(q)) return compact(cho(it.name)).includes(cq) || compact(cho(path)).includes(cq);
  return compact(it.name).includes(cq) || compact(it.memo).includes(cq) || compact(path).includes(cq);
}
function installCard() {
  if (isStandalone() || lsGet('eodi.installDismissed', false)) return '';
  const can = !!S.installPrompt;
  if (!can && !isIOS()) return '';
  return `<div class="install"><p><b>홈 화면에 설치</b>하면 앱처럼 바로 열려요.</p>
    ${can ? '<button class="btn primary" data-act="install">설치</button>' : '<button class="btn" data-act="install-help">방법 보기</button>'}
    <button class="x" data-act="install-dismiss" aria-label="닫기">✕</button></div>`;
}
function renderFind() {
  const el = $('#find-body');
  if (!S.loaded) { el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>'; return; }
  const q = S.q.trim(); let h = '';
  if (q) {
    const cq = compact(q);
    const res = [...S.items.values()].filter(i => matchItem(i, q)).sort((a, b) => {
      const an = compact(a.name).startsWith(cq) ? 0 : 1, bn = compact(b.name).startsWith(cq) ? 0 : 1; return an - bn || b.updatedAt - a.updatedAt; });
    const pl = [...S.places.values()].filter(p => isChoQuery(q) ? compact(cho(p.name)).includes(cq) : compact(p.name).includes(cq)).slice(0, 6);
    h += `<div><h2 class="sec">물건 ${res.length}개</h2>`;
    h += res.length ? `<div class="list">${res.slice(0, 80).map(itemCard).join('')}</div>` :
      `<div class="empty"><strong>'${esc(q)}'은(는) 아직 기록이 없어요</strong>정리하면서 기록해 두면 다음엔 바로 찾을 수 있어요.
       <div style="margin-top:12px"><button class="btn primary" data-act="new-item" data-name="${esc(q)}">'${esc(q)}' 위치 기록하기</button></div></div>`;
    h += '</div>';
    if (pl.length) h += `<div><h2 class="sec">장소</h2><div class="chips">${pl.map(p => `<button class="chip" data-act="open-place" data-id="${esc(p.id)}">${esc(pathStr(p.id))}</button>`).join('')}</div></div>`;
  } else {
    h += installCard();
    const un = unseenLogs();
    if (un.length) { const names = [...new Set(un.map(l => l.itemName))].slice(0, 3).join(', ');
      h += `<button class="banner" data-act="see-others"><span class="badge">${un.length}</span><span><b>${esc(who(un[0].by))}이(가) 정리한 물건이 있어요</b><span class="bsub">${esc(names)}${un.length > 3 ? ' 외' : ''} · 눌러서 확인</span></span></button>`; }
    if (!S.items.size) {
      h += S.places.size ? `<div class="empty"><strong>첫 물건을 기록해 보세요</strong>아래 <b>정리 기록</b> 버튼으로 사진 한 장과 위치만 남기면 돼요.</div>`
        : `<div class="empty"><strong>먼저 우리 집 방을 만들어요</strong>방을 만들고 그 안에 가구, 서랍, 수납함을 차례로 추가해요.<div style="margin-top:12px"><button class="btn primary" data-act="tab" data-tab="browse">방 만들러 가기</button></div></div>`;
    } else {
      const recent = [...S.items.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
      h += `<div><h2 class="sec">최근 정리한 물건</h2><div class="list">${recent.map(itemCard).join('')}</div></div>`;
      const rooms = childrenOf(null); const memo = new Map();
      if (rooms.length) h += `<div><h2 class="sec">방에서 찾기</h2><div class="chips">${rooms.map(r => `<button class="chip" data-act="open-place" data-id="${esc(r.id)}">${esc(r.name)}<small>${countDeep(r.id, memo)}</small></button>`).join('')}</div></div>`;
    }
  }
  el.innerHTML = h;
}
function renderBrowse() {
  const el = $('#browse-body');
  if (!S.loaded) { el.innerHTML = '<div class="skel"></div><div class="skel"></div>'; return; }
  if (S.browseId && !S.places.has(S.browseId)) S.browseId = null;
  const cur = S.browseId ? S.places.get(S.browseId) : null; const path = pathOf(S.browseId);
  const kids = childrenOf(S.browseId); const memo = new Map(); let h = '';
  h += `<nav class="crumbs" aria-label="현재 위치"><button data-act="open-place" data-id="">${esc((S.household && S.household.name) || '우리 집')}</button>${path.slice(0, -1).map(p => `<i class="sep">›</i><button data-act="open-place" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
    <div class="here">${cur ? esc(cur.name) + ` <span class="kind${cur.kind === 'box' ? ' box' : ''}">${KINDS[cur.kind] || '공간'}</span>` : esc((S.household && S.household.name) || '우리 집')}</div></nav>`;
  if (!cur && !kids.length) {
    h += `<div class="empty"><strong>방부터 만들어요</strong>자주 쓰는 방을 한 번에 만들 수 있어요. 나중에 이름을 바꾸거나 지울 수 있어요.
      <div class="chips" style="justify-content:center;margin-top:12px">${PRESET.map(n => `<span class="chip">${n}</span>`).join('')}</div>
      <div style="margin-top:12px"><button class="btn primary" data-act="preset">이 방들로 시작하기</button></div></div>`;
  }
  if (kids.length) h += `<div><h2 class="sec">${cur ? '안에 있는 공간' : '방'}</h2><div class="places">${kids.map(k => `<button class="place" data-act="open-place" data-id="${esc(k.id)}"><span class="pn">${esc(k.name)}</span><span class="pm"><span class="kind${k.kind === 'box' ? ' box' : ''}">${KINDS[k.kind] || '공간'}</span>물건 ${countDeep(k.id, memo)}개</span></button>`).join('')}</div></div>`;
  if (cur) { const its = itemsIn(cur.id);
    h += `<div><h2 class="sec">여기 바로 있는 물건 ${its.length}개</h2>${its.length ? `<div class="list">${its.map(itemCard).join('')}</div>` : '<p class="hint" style="margin:0">아직 기록된 물건이 없어요.</p>'}</div>`; }
  h += `<div class="actions">` +
    (cur ? `<button class="btn primary" data-act="new-item" data-place="${esc(cur.id)}">+ 여기에 물건 기록</button>` : '') +
    `<button class="btn" data-act="new-place" data-parent="${esc(S.browseId || '')}">+ ${cur ? '칸·수납함 추가' : '방 추가'}</button>` +
    (cur ? `<button class="btn" data-act="qr" data-id="${esc(cur.id)}">QR 라벨</button><button class="btn" data-act="edit-place" data-id="${esc(cur.id)}">이름 바꾸기</button><button class="btn danger" data-act="del-place" data-id="${esc(cur.id)}">삭제</button>`
      : '<button class="btn" data-act="scan" data-target="browse">수납함 QR 찍기</button>') +
    `</div><div id="place-confirm"></div>`;
  el.innerHTML = h;
}
function renderRecent() {
  const el = $('#recent-body'); if (!S.loaded) { el.innerHTML = '<div class="skel"></div><div class="skel"></div>'; return; }
  const f = S.recentFilter; const logs = S.logs.filter(l => f === 'all' || (f === 'me' ? l.by === S.me : l.by !== S.me));
  const nOther = S.logs.filter(l => l.by !== S.me).length, nMe = S.logs.length - nOther;
  let h = `<div class="chips" role="group" aria-label="누가 바꿨는지">
    <button class="chip" data-act="rf" data-f="all" aria-pressed="${f === 'all'}">전체<small>${S.logs.length}</small></button>
    <button class="chip" data-act="rf" data-f="others" aria-pressed="${f === 'others'}">가족이 바꾼 것<small>${nOther}</small></button>
    <button class="chip" data-act="rf" data-f="me" aria-pressed="${f === 'me'}">내가 바꾼 것<small>${nMe}</small></button></div>`;
  if (!logs.length) h += '<div class="empty"><strong>아직 변경 기록이 없어요</strong>물건을 기록하거나 옮기면 여기에 시간순으로 쌓여요.</div>';
  let last = ''; h += '<div class="list">';
  for (const l of logs) { const d = dayLabel(l.at); if (d !== last) { h += `<div class="day">${d}</div>`; last = d; }
    const mine = l.by === S.me; const fresh = !mine && l.at > S.lastSeen;
    h += `<button class="log" data-act="item" data-id="${esc(l.itemId || '')}"><span class="who ${mine ? 'me' : 'other'}">${esc(whoShort(l.by))}</span><span class="lbody">
      <span class="lhead"><b>${esc(l.itemName)}</b> · ${verb[l.action] || '변경'}${fresh ? ' <span class="kind box">NEW</span>' : ''}</span>
      ${l.action === 'move' ? `<span class="move">${esc(l.from || '위치 미지정')} → <span class="to">${esc(l.to)}</span></span>` : (l.to || l.from) ? `<span class="move"><span class="to">${esc(l.to || l.from)}</span></span>` : ''}
    </span><span class="ltime">${hm(l.at)}</span></button>`; }
  h += '</div>'; el.innerHTML = h;
}
function hydratePhotos(root) {
  root.querySelectorAll('[data-photo]').forEach(async el => {
    const path = el.dataset.photo; if (!path || el.dataset.loaded === path) return; el.dataset.loaded = path;
    const src = await api.photoUrl(path);
    if (src && el.isConnected) el.innerHTML = `<img alt="" loading="lazy" src="${esc(src)}">`;
  });
}

/* ================= 시트(하단 창) ================= */
let openSheet = null;
function showSheet(title, html, opts) { opts = opts || {};
  if (openSheet && openSheet.onClose) openSheet.onClose();
  $('#sheet-root').innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
  <div class="shead"><h3>${esc(title)}</h3><button class="x" data-act="close" aria-label="닫기">✕</button></div><div id="sheet-body" style="display:flex;flex-direction:column;gap:16px">${html}</div></div></div>`;
  openSheet = { refresh: opts.refresh || null, kind: opts.kind, onClose: opts.onClose || null };
  document.body.style.overflow = 'hidden'; hydratePhotos($('#sheet-root'));
}
function closeSheet() { if (openSheet && openSheet.onClose) openSheet.onClose(); $('#sheet-root').innerHTML = ''; openSheet = null; document.body.style.overflow = ''; F = null; }

/* 물건 상세 */
function showItem(id) {
  const it = S.items.get(id);
  if (!it) { toast('지금은 없는 물건이에요 (삭제됨)'); return; }
  const hist = S.logs.filter(l => l.itemId === id).slice(0, 10);
  const html = `${it.photoPath ? `<div id="big-photo" style="border-radius:14px;overflow:hidden;background:var(--sunk);min-height:120px;display:grid;place-items:center;color:var(--muted)">사진 불러오는 중</div>` : ''}
    <div class="field"><span class="flabel">여기 있어요</span><div style="font-size:15px">${tapePath(pathOf(it.placeId))}</div></div>
    ${it.memo ? `<div class="field"><span class="flabel">메모</span><div class="memo">${esc(it.memo)}</div></div>` : ''}
    <p class="hint" style="margin:0">마지막 기록: ${esc(who(it.updatedBy))} · ${ago(it.updatedAt)}</p>
    <div class="actions"><button class="btn primary" data-act="edit-item" data-id="${esc(id)}" data-focus="place">위치 옮기기</button>
      <button class="btn" data-act="edit-item" data-id="${esc(id)}">수정</button>
      <button class="btn danger" data-act="del-item" data-id="${esc(id)}">삭제</button></div>
    <div id="item-confirm"></div>
    ${hist.length ? `<div><h2 class="sec">이 물건의 기록</h2><div class="list">${hist.map(l => `<div class="log"><span class="who ${l.by === S.me ? 'me' : 'other'}">${esc(whoShort(l.by))}</span><span class="lbody"><span class="lhead">${verb[l.action] || '변경'}</span>${l.to ? `<span class="move">${l.action === 'move' ? esc(l.from || '위치 미지정') + ' → ' : ''}<span class="to">${esc(l.to)}</span></span>` : ''}</span><span class="ltime">${ago(l.at)}</span></div>`).join('')}</div></div>` : ''}`;
  showSheet(it.name, html, { kind: 'item' });
  const ph = $('#big-photo');
  if (ph) api.photoUrl(it.photoPath).then(src => { if (!ph.isConnected) return; if (src) ph.innerHTML = `<img class="big-photo" alt="${esc(it.name)} 사진" src="${esc(src)}">`; else ph.textContent = '사진을 불러오지 못했어요'; });
}

/* 물건 기록/수정 폼 */
let F = null;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function showItemForm(id, opts) { opts = opts || {}; const it = id ? S.items.get(id) : null;
  F = { id: id || null, placeId: it ? it.placeId : (opts.place || (S.view === 'browse' ? S.browseId : null) || null), photoPath: it ? it.photoPath : null,
    photoBlob: null, photoPreview: null, removePhoto: false };
  const html = `${!it ? `<div class="voice"><span class="flabel">말로 한 번에 입력</span><div class="row">
        ${SR ? `<button class="mic" data-act="mic" id="f-mic" aria-label="말하기"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>` : ''}
        <input class="inp" id="f-voice" placeholder="예) 건전지 주방 상부장에 넣었어" autocomplete="off"><button class="btn primary" data-act="parse">채우기</button></div>
      <span class="hint" style="margin:0">${SR ? '마이크를 누르고 말하면 이름과 위치가 자동으로 채워져요.' : '키보드의 마이크 버튼으로 말한 뒤 채우기를 누르세요.'}</span></div>` : ''}
    <div class="field"><label for="f-name">물건 이름</label><input class="inp" id="f-name" maxlength="100" value="${esc(it ? it.name : (opts.name || ''))}" placeholder="예) 건전지 AA" autocomplete="off"></div>
    <div class="field"><span class="flabel">사진 (선택)</span><div class="photo"><div class="pprev" id="f-pprev">사진 없음</div>
      <div class="pbtns"><button class="btn" data-act="photo" data-src="cam">사진 찍기</button><button class="btn" data-act="photo" data-src="lib">앨범에서</button><button class="btn danger" data-act="photo-rm" id="f-prm" hidden>사진 빼기</button></div></div></div>
    <div class="field" id="f-place-field"><span class="flabel">어디에 뒀나요?</span><div class="picker" id="pk"></div></div>
    <div class="field"><label for="f-memo">메모 (선택)</label><textarea class="inp" id="f-memo" maxlength="1000" placeholder="예) 파란 통 안, 충전기 같이 있음">${esc(it ? it.memo || '' : '')}</textarea></div>
    <button class="btn primary block" data-act="save-item" id="f-save">${it ? '저장하기' : '기록하기'}</button>`;
  showSheet(it ? it.name + ' 수정' : '정리 기록', html, { kind: 'form', refresh: () => renderPicker(), onClose: stopMic });
  renderPicker(); renderPhotoPrev();
  if (opts.focus === 'place') setTimeout(() => { const f = $('#f-place-field'); f && f.scrollIntoView({ block: 'center' }); }, 60);
}
function renderPicker() { const el = $('#pk'); if (!el || !F) return;
  const cur = F.placeId && S.places.has(F.placeId) ? F.placeId : null; F.placeId = cur; const kids = childrenOf(cur);
  el.innerHTML = `<div>${cur ? tapePath(pathOf(cur)) : '<span class="hint" style="margin:0">아래에서 방부터 차례로 골라 주세요</span>'}</div>
   <div class="pk-tools">${cur ? '<button data-act="pk-up">‹ 한 단계 위로</button>' : ''}<button data-act="scan" data-target="picker">수납함 QR로 선택</button></div>
   ${kids.length ? `<div class="pk-list">${kids.map(k => `<button data-act="pk-go" data-id="${esc(k.id)}">${esc(k.name)} <span class="kind${k.kind === 'box' ? ' box' : ''}">${KINDS[k.kind] || ''}</span></button>`).join('')}</div>`
      : cur ? '<span class="hint" style="margin:0">더 안쪽 공간이 없어요. 여기로 저장돼요.</span>' : ''}
   <div class="row"><input class="inp" id="pk-new" maxlength="60" placeholder="${cur ? '여기 안에 칸·서랍 추가' : '새 방 추가'}" autocomplete="off"><button class="btn" data-act="pk-add">추가</button></div>`; }
function renderPhotoPrev() { const el = $('#f-pprev'); if (!el || !F) return; const rm = $('#f-prm');
  if (F.photoPreview) { el.innerHTML = `<img alt="" src="${F.photoPreview}">`; rm.hidden = false; }
  else if (F.photoPath && !F.removePhoto) { el.textContent = '…'; rm.hidden = false; api.photoUrl(F.photoPath).then(s => { if (s && el.isConnected) el.innerHTML = `<img alt="" src="${esc(s)}">`; }); }
  else { el.textContent = '사진 없음'; rm.hidden = true; } }

/* 말로 입력: "건전지 주방 상부장에 넣었어" → 이름 + 위치 */
function parseSpoken(text) { const t = String(text || '').trim(); if (!t) return null; const ct = compact(t);
  let best = null, bs = -1;
  for (const p of S.places.values()) { if (!p.name || !ct.includes(compact(p.name))) continue;
    const anc = pathOf(p.id).slice(0, -1); const hits = anc.filter(a => ct.includes(compact(a.name))).length;
    const sc = hits * 10 + anc.length + compact(p.name).length / 100; if (sc > bs) { bs = sc; best = p; } }
  let rest = t;
  if (best) for (const a of pathOf(best.id)) {
    const re = new RegExp(compact(a.name).split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i'); rest = rest.replace(re, ' '); }
  const drop = /^(넣었어|넣어뒀어|넣어놨어|넣어둠|넣었음|넣음|뒀어|두었어|둠|놨어|놓았어|놔뒀어|있어|있음|있다|정리했어|정리함|보관|보관함|했어|위치|쪽|안|위|밑|옆)$/;
  const toks = rest.split(/\s+/)
    .map(w => w.replace(/(에다가|에다|에서|에는|안에|위에|밑에|옆에|에|으로|로)$/, ''))
    .map(w => w.length >= 3 ? w.replace(/(을|를|은|는)$/, '') : w)
    .filter(w => w && !drop.test(w));
  return { name: toks.join(' ').trim(), placeId: best ? best.id : null }; }
function applyParse() { const v = $('#f-voice'); if (!v) return; const r = parseSpoken(v.value); if (!r) { v.focus(); return; }
  if (r.name) $('#f-name').value = r.name; if (r.placeId) { F.placeId = r.placeId; renderPicker(); }
  toast(r.placeId ? `위치: ${pathStr(r.placeId)}` : '위치를 못 찾았어요. 아래에서 골라 주세요', 3000); }
let rec = null;
function startMic() { if (!SR) return; if (rec) { stopMic(); return; }
  try { rec = new SR(); rec.lang = 'ko-KR'; rec.interimResults = true; rec.maxAlternatives = 1; } catch (e) { toast('이 기기에서는 음성 입력을 쓸 수 없어요'); return; }
  const btn = $('#f-mic'); btn && btn.classList.add('on'); let finalText = '';
  rec.onresult = e => { let txt = ''; for (let i = 0; i < e.results.length; i++) { txt += e.results[i][0].transcript; if (e.results[i].isFinal) finalText = txt; }
    const v = $('#f-voice'); if (v) v.value = txt; };
  rec.onerror = e => { if (e.error === 'not-allowed') toast('마이크 권한을 허용해 주세요 (휴대폰 설정 > 브라우저 > 마이크)', 4000); };
  rec.onend = () => { const b = $('#f-mic'); b && b.classList.remove('on'); rec = null; if (finalText && $('#f-voice')) applyParse(); };
  rec.start(); }
function stopMic() { if (rec) { try { rec.stop(); } catch (e) {} } }

async function saveItem() { const name = $('#f-name').value.trim(); const memo = $('#f-memo').value.trim();
  if (!name) { toast('물건 이름을 적어 주세요'); $('#f-name').focus(); return; }
  if (!F.placeId) { toast('어디에 뒀는지 골라 주세요'); $('#f-place-field').scrollIntoView({ block: 'center' }); return; }
  const btn = $('#f-save'); btn.disabled = true; btn.textContent = '저장 중…';
  try { const { action } = await api.saveItem({ id: F.id, name, memo, placeId: F.placeId, photoBlob: F.photoBlob, removePhoto: F.removePhoto });
    closeSheet(); toast(action === 'add' ? `'${name}' 기록했어요` : action === 'move' ? `'${name}' 위치를 옮겼어요` : '저장했어요');
  } catch (e) { console.warn(e); btn.disabled = false; btn.textContent = '다시 저장하기'; toast(friendlyError(e), 4500); } }

/* 공간 폼 */
function guessKind(pid) { if (!pid) return 'room'; const p = S.places.get(pid); if (!p) return 'room'; if (p.kind === 'room') return 'furniture'; return 'slot'; }
function showPlaceForm(parentId, id) { const p = id ? S.places.get(id) : null; const kind = p ? p.kind : guessKind(parentId);
  const where = parentId ? pathStr(parentId) : ((S.household && S.household.name) || '우리 집');
  showSheet(p ? '이름 바꾸기' : '공간 추가', `${!p ? `<p class="hint" style="margin:0">${esc(where)} 안에 추가해요</p>` : ''}
    <div class="field"><label for="pl-name">이름</label><input class="inp" id="pl-name" maxlength="60" value="${esc(p ? p.name : '')}" placeholder="${kind === 'room' ? '예) 아이방' : kind === 'furniture' ? '예) 붙박이장, 신발장' : '예) 위에서 2번째 서랍'}" autocomplete="off"></div>
    <div class="field"><label for="pl-kind">종류</label><select class="inp" id="pl-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <span class="hint" style="margin:0">수납함에 QR 라벨을 붙여 두면 찍기만 해도 안에 든 물건이 나와요.</span></div>
    <button class="btn primary block" data-act="save-place" data-id="${esc(id || '')}" data-parent="${esc(parentId || '')}">${p ? '저장하기' : '추가하기'}</button>`);
  setTimeout(() => { const i = $('#pl-name'); i && i.focus(); }, 60); }
async function savePlace(id, parentId) { const name = $('#pl-name').value.trim(); const kind = $('#pl-kind').value; if (!name) { toast('이름을 적어 주세요'); return; }
  try { if (id) await api.updatePlace(id, { name, kind }); else await api.addPlace({ name, kind, parentId });
    closeSheet(); toast(id ? '이름을 바꿨어요' : `'${name}' 추가했어요`); } catch (e) { toast(friendlyError(e)); } }
async function addPresetRooms() { try { for (const n of PRESET) await api.addPlace({ name: n, kind: 'room', parentId: null });
  toast('방을 만들었어요. 방을 눌러 가구와 칸을 추가해 보세요', 3500); } catch (e) { toast(friendlyError(e)); scheduleRender(); } }

/* ================= QR 라벨 ================= */
const placeLink = id => location.origin + location.pathname.replace(/index\.html$/, '') + '?place=' + encodeURIComponent(id);
function drawQR(ctx, text, x, y, size) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(); const cell = size / (n + 2); ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size); ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(Math.floor(x + (c + 1) * cell), Math.floor(y + (r + 1) * cell), Math.ceil(cell), Math.ceil(cell));
}
function wrapText(x, text, X, Y, maxW, lh, maxLines) { const lines = []; let line = '';
  for (const ch of [...text]) { if (x.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch; } lines.push(line);
  lines.slice(0, maxLines).forEach((l, i) => x.fillText(l, X, Y + i * lh)); }
function makeLabel(p) {
  const W = 720, H = 300, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H); drawQR(x, placeLink(p.id), 24, 24, 252);
  x.fillStyle = '#F2CD48'; x.fillRect(300, 40, 390, 10);
  x.fillStyle = '#1B221D'; x.font = '600 46px "Gowun Dodum","IBM Plex Sans KR","Apple SD Gothic Neo",sans-serif'; wrapText(x, p.name, 300, 112, 390, 52, 2);
  x.font = '400 22px "IBM Plex Sans KR","Apple SD Gothic Neo",sans-serif'; x.fillStyle = '#5B675E';
  const par = pathOf(p.id).slice(0, -1).map(a => a.name).join(' › '); if (par) wrapText(x, par, 300, 218, 390, 28, 1);
  x.font = '500 18px "IBM Plex Mono",monospace'; x.fillText('어디뒀지 · ' + (KINDS[p.kind] || ''), 300, 266);
  return c;
}
let labelCanvas = null;
function showQR(id) { const p = S.places.get(id); if (!p) return;
  labelCanvas = makeLabel(p);
  showSheet('QR 라벨', `<p class="hint" style="margin:0">수납함이나 서랍 앞에 붙여 두세요. 앱의 QR 버튼이나 휴대폰 카메라로 찍으면 이 공간이 바로 열려요.</p>
    <div class="label-prev"><img alt="${esc(p.name)} QR 라벨" src="${labelCanvas.toDataURL('image/png')}"></div>
    <div class="actions"><button class="btn primary" data-act="save-label" data-id="${esc(id)}">이미지로 저장·공유</button><button class="btn" data-act="print-label" data-id="${esc(id)}">인쇄</button></div>`); }
async function saveLabel(id) { const p = S.places.get(id); if (!p || !labelCanvas) return;
  const blob = await new Promise(r => labelCanvas.toBlob(r, 'image/png')); const fname = 'QR라벨_' + p.name.replace(/[\\/:*?"<>|]/g, '') + '.png';
  try { const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: p.name + ' QR 라벨' }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('라벨 이미지를 저장했어요'); }
function printLabels(ids) { const area = $('#print-area');
  area.innerHTML = ids.map(id => S.places.get(id)).filter(Boolean).map(p => `<img alt="" src="${makeLabel(p).toDataURL('image/png')}">`).join('');
  if (!area.innerHTML) { toast('인쇄할 라벨이 없어요'); return; }
  setTimeout(() => { try { window.print(); } catch (e) { toast('이 기기에서는 인쇄가 안 돼요. 이미지로 저장해서 인쇄해 주세요.'); } }, 100); }

/* ================= QR 스캔 ================= */
let scanTarget = 'browse', scanStream = null, scanTimer = null, detector = null;
async function openScanner(target) {
  scanTarget = target || 'browse';
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { $('#scan-cam').value = ''; $('#scan-cam').click(); return; }
  const root = document.createElement('div'); root.id = 'scan-root';
  root.innerHTML = `<div class="scrim" style="z-index:25" data-act="scan-close"><div class="sheet" role="dialog" aria-modal="true" aria-label="QR 찍기"><div class="grab"></div>
    <div class="shead"><h3>QR 찍기</h3><button class="x" data-act="scan-close" aria-label="닫기">✕</button></div>
    <div class="scan-wrap"><video id="scan-video" playsinline muted></video><div class="scan-frame"></div><div class="scan-msg" id="scan-msg">라벨의 QR을 네모 안에 맞춰 주세요</div></div>
    <button class="btn block" data-act="scan-photo">카메라가 안 되면: 사진 찍어서 읽기</button></div></div>`;
  document.body.appendChild(root);
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const v = $('#scan-video'); if (!v) { stopScanner(); return; } v.srcObject = scanStream; await v.play();
    try { if ('BarcodeDetector' in window) { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } } catch (e) { detector = null; }
    const cv = document.createElement('canvas'); const cx = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!scanStream || !v.videoWidth) { scanTimer = setTimeout(tick, 250); return; }
      let text = null;
      try {
        if (detector) { const r = await detector.detect(v); if (r && r[0]) text = r[0].rawValue; }
        else { const s = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight)); cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s);
          cx.drawImage(v, 0, 0, cv.width, cv.height); const d = cx.getImageData(0, 0, cv.width, cv.height); const r = jsQR(d.data, cv.width, cv.height, { inversionAttempts: 'dontInvert' }); if (r) text = r.data; }
      } catch (e) {}
      if (text) { if (navigator.vibrate) navigator.vibrate(60); stopScanner(); handleQRText(text); return; }
      scanTimer = setTimeout(tick, 220);
    };
    tick();
  } catch (e) {
    const m = $('#scan-msg'); if (m) m.textContent = e && e.name === 'NotAllowedError' ? '카메라 권한을 허용해 주세요. 또는 아래 버튼으로 사진을 찍어 주세요.' : '카메라를 열 수 없어요. 아래 버튼으로 사진을 찍어 주세요.';
  }
}
function stopScanner() { clearTimeout(scanTimer); scanTimer = null; if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } const r = $('#scan-root'); r && r.remove(); }
function decodeQRFile(file) { return new Promise(res => { const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { try { for (const max of [1200, 800, 500]) { const s = Math.min(1, max / Math.max(img.width, img.height)); const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h); const d = x.getImageData(0, 0, w, h);
      const r = jsQR(d.data, w, h, { inversionAttempts: 'attemptBoth' }); if (r && r.data) { URL.revokeObjectURL(url); return res(r.data); } } } catch (e) {}
    URL.revokeObjectURL(url); res(null); };
  img.onerror = () => { URL.revokeObjectURL(url); res(null); }; img.src = url; }); }
function placeIdFromQR(text) { if (!text) return null; if (text.startsWith(QR_PREFIX)) return text.slice(QR_PREFIX.length);
  try { return new URL(text).searchParams.get('place'); } catch (e) { return null; } }
function handleQRText(text) { const id = placeIdFromQR(text);
  if (!id) { toast('어디뒀지 라벨이 아닌 QR이에요.', 3000); return; }
  const p = S.places.get(id); if (!p) { toast('이 라벨의 공간을 찾을 수 없어요. 다른 집의 라벨이거나 삭제됐어요.', 4000); return; }
  if (scanTarget === 'picker' && F) { F.placeId = id; renderPicker(); toast(`'${p.name}' 선택했어요`); }
  else { closeSheet(); S.view = 'browse'; S.browseId = id; render(); window.scrollTo(0, 0); toast(`'${p.name}' 열었어요`); } }

/* ================= 사진 압축 ================= */
function compressPhoto(file) { return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { const max = 1080; const s = Math.min(1, max / Math.max(img.width, img.height)); const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
    c.toBlob(b => b ? res(b) : rej(new Error('photo')), 'image/jpeg', 0.75); };
  img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('photo')); }; img.src = url; }); }

/* ================= 설정 ================= */
async function showSettings() {
  const h = S.household || {}; const me = S.members.get(S.me);
  const members = [...S.members.values()].sort((a, b) => (a.role === 'owner' ? -1 : 1) - (b.role === 'owner' ? -1 : 1));
  const isOwner = me && me.role === 'owner';
  const notifyOn = lsGet('eodi.notify', false) && 'Notification' in window && Notification.permission === 'granted';
  const boxes = [...S.places.values()].filter(p => p.kind === 'box');
  showSheet('설정', `
    <div class="field"><span class="flabel">가족 초대</span>
      <div class="code-box"><span class="code">${esc(h.invite_code || '------')}</span><button class="btn primary" data-act="share-invite">초대 보내기</button></div>
      <span class="hint" style="margin:0">가족이 앱에 로그인한 뒤 이 6자리를 넣으면 같은 집에 들어와요.</span>
      ${isOwner ? '<button class="btn" data-act="rotate-code" style="align-self:flex-start">초대코드 새로 만들기</button>' : ''}</div>
    <div class="field"><span class="flabel">구성원 ${members.length}명</span><div>${members.map(m => `<div class="mem"><span class="who ${m.id === S.me ? 'me' : 'other'}">${esc([...m.name].slice(0, 2).join(''))}</span><span class="nm">${esc(m.name)}${m.id === S.me ? ' (나)' : ''}</span>${m.role === 'owner' ? '<span class="kind">만든 사람</span>' : ''}</div>`).join('')}</div></div>
    <div class="field"><label for="set-me">내 이름</label><div class="row"><input class="inp" id="set-me" maxlength="20" value="${esc(me ? me.name : '')}"><button class="btn" data-act="save-me">저장</button></div></div>
    <div class="field"><label for="set-house">집 이름</label><div class="row"><input class="inp" id="set-house" maxlength="40" value="${esc(h.name || '')}"><button class="btn" data-act="save-house">저장</button></div></div>
    <div class="field"><span class="flabel">알림</span>
      <button class="btn" data-act="toggle-notify" style="align-self:flex-start">${notifyOn ? '가족 변경 알림 끄기' : '가족 변경 알림 켜기'}</button>
      <span class="hint" style="margin:0">앱이 열려 있거나 방금 닫았을 때 가족이 물건을 옮기면 알려 줘요. 앱을 완전히 닫았을 때의 푸시 알림은 다음 업데이트에서 추가할 예정이에요.</span></div>
    ${!isStandalone() ? `<div class="field"><span class="flabel">앱 설치</span>${S.installPrompt ? '<button class="btn primary" data-act="install" style="align-self:flex-start">홈 화면에 설치</button>' : installHelpHtml()}</div>` : ''}
    <div class="field"><span class="flabel">QR 라벨</span><button class="btn" data-act="print-all" style="align-self:flex-start" ${boxes.length ? '' : 'disabled'}>수납함 라벨 ${boxes.length}개 한꺼번에 인쇄</button></div>
    <div class="field" id="house-switch"></div>
    <div class="actions">${DEMO ? '' : '<button class="btn danger" data-act="logout">로그아웃</button>'}</div>
    <p class="hint" style="margin:0">어디뒀지 v${APP_VERSION}${DEMO ? ' · 데모 모드' : ''} · <a href="privacy.html" style="color:inherit">개인정보처리방침</a></p>`);
  try { const list = await api.myHouseholds(); const el = $('#house-switch'); if (!el) return;
    el.innerHTML = `<span class="flabel">다른 집</span>${list.length > 1 ? `<div class="chips">${list.map(x => `<button class="chip" data-act="switch-house" data-id="${esc(x.id)}" aria-pressed="${x.id === S.hid}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      ${DEMO ? '' : '<button class="btn" data-act="join-another" style="align-self:flex-start">초대코드로 다른 집 추가</button>'}`; } catch (e) {}
}
function installHelpHtml() {
  return isIOS() ? '<span class="hint" style="margin:0">Safari 아래쪽 <b>공유 버튼(□↑)</b> → <b>홈 화면에 추가</b>를 누르세요.</span>'
    : '<span class="hint" style="margin:0">Chrome 오른쪽 위 <b>⋮</b> → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요.</span>';
}
async function shareInvite() { const code = S.household && S.household.invite_code; if (!code) return;
  const link = location.origin + location.pathname.replace(/index\.html$/, '') + '?invite=' + code;
  const text = `'어디뒀지' 앱에서 우리 집 물건 위치를 같이 봐요.\n초대코드: ${code}\n${link}`;
  try { if (navigator.share) { await navigator.share({ title: '어디뒀지 초대', text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('초대 내용을 복사했어요. 카톡에 붙여넣어 보내세요.', 3500); } catch (e) { toast('초대코드: ' + code, 6000); } }

/* ================= 이벤트 ================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-tab]'); if (!t) return;
  if (t.dataset.tab && !t.dataset.act) { go(t.dataset.tab); return; }
  const a = t.dataset.act, id = t.dataset.id;
  switch (a) {
    case 'scrim': if (e.target === t) closeSheet(); break;
    case 'close': closeSheet(); break;
    case 'tab': go(t.dataset.tab); break;
    case 'item': if (id) showItem(id); break;
    case 'new-item': showItemForm(null, { place: t.dataset.place, name: t.dataset.name || '' }); break;
    case 'edit-item': showItemForm(id, { focus: t.dataset.focus }); break;
    case 'del-item': $('#item-confirm').innerHTML = `<div class="confirm"><span>이 물건 기록을 지울까요? 변경 기록에는 남아요.</span><div class="actions"><button class="btn danger solid" data-act="del-item-yes" data-id="${esc(id)}">삭제</button><button class="btn" data-act="del-no">취소</button></div></div>`; break;
    case 'del-item-yes': { const name = (S.items.get(id) || {}).name; try { await api.deleteItem(id); closeSheet(); toast(`'${name}' 삭제했어요`); } catch (err) { toast(friendlyError(err)); } break; }
    case 'del-no': { const c = t.closest('.confirm'); c && c.remove(); break; }
    case 'open-place': closeSheet(); S.view = 'browse'; S.browseId = id || null; render(); window.scrollTo(0, 0); break;
    case 'new-place': showPlaceForm(t.dataset.parent || null, null); break;
    case 'edit-place': showPlaceForm(null, id); break;
    case 'save-place': savePlace(id || null, t.dataset.parent || null); break;
    case 'del-place': { const has = childrenOf(id).length || itemsIn(id).length;
      $('#place-confirm').innerHTML = has ? `<div class="confirm"><span>안에 공간이나 물건이 있어서 지울 수 없어요. 먼저 옮기거나 지워 주세요.</span><div class="actions"><button class="btn" data-act="del-no">확인</button></div></div>`
        : `<div class="confirm"><span>'${esc(S.places.get(id).name)}'을(를) 지울까요?</span><div class="actions"><button class="btn danger solid" data-act="del-place-yes" data-id="${esc(id)}">삭제</button><button class="btn" data-act="del-no">취소</button></div></div>`; break; }
    case 'del-place-yes': { const p = S.places.get(id); try { await api.deletePlace(id); S.browseId = p ? p.parentId || null : null; render(); toast('삭제했어요'); } catch (err) { toast(friendlyError(err)); } break; }
    case 'preset': t.disabled = true; addPresetRooms(); break;
    case 'qr': showQR(id); break;
    case 'save-label': saveLabel(id); break;
    case 'print-label': printLabels([id]); break;
    case 'print-all': printLabels([...S.places.values()].filter(p => p.kind === 'box').map(p => p.id)); break;
    case 'scan': openScanner(t.dataset.target); break;
    case 'scan-close': if (a === 'scan-close' && (e.target === t || t.tagName === 'BUTTON')) stopScanner(); break;
    case 'scan-photo': { const tgt = scanTarget; stopScanner(); scanTarget = tgt; $('#scan-cam').value = ''; $('#scan-cam').click(); break; }
    case 'rf': S.recentFilter = t.dataset.f; render(); break;
    case 'see-others': S.recentFilter = 'others'; go('recent'); break;
    case 'pk-go': F.placeId = id; renderPicker(); break;
    case 'pk-up': { const p = S.places.get(F.placeId); F.placeId = p ? p.parentId || null : null; renderPicker(); break; }
    case 'pk-add': { const n = $('#pk-new').value.trim(); if (!n) { $('#pk-new').focus(); return; }
      try { const nid = await api.addPlace({ name: n, kind: guessKind(F.placeId), parentId: F.placeId }); F.placeId = nid; renderPicker(); toast(`'${n}' 추가했어요`); } catch (err) { toast(friendlyError(err)); } break; }
    case 'parse': applyParse(); break;
    case 'mic': startMic(); break;
    case 'photo': { const el = $(t.dataset.src === 'cam' ? '#photo-cam' : '#photo-lib'); el.value = ''; el.click(); break; }
    case 'photo-rm': if (F.photoPreview) URL.revokeObjectURL(F.photoPreview); F.photoBlob = null; F.photoPreview = null; F.removePhoto = true; renderPhotoPrev(); break;
    case 'save-item': saveItem(); break;
    case 'settings': showSettings(); break;
    case 'share-invite': shareInvite(); break;
    case 'rotate-code': try { await api.rotateCode(); showSettings(); toast('새 초대코드를 만들었어요. 이전 코드는 더 이상 쓸 수 없어요.', 3500); } catch (err) { toast(friendlyError(err)); } break;
    case 'save-me': { const v = $('#set-me').value.trim(); if (!v) return; try { await api.renameMe(v); toast('이름을 바꿨어요'); } catch (err) { toast(friendlyError(err)); } break; }
    case 'save-house': { const v = $('#set-house').value.trim(); if (!v) return; try { await api.renameHouse(v); toast('집 이름을 바꿨어요'); } catch (err) { toast(friendlyError(err)); } break; }
    case 'toggle-notify': {
      if (lsGet('eodi.notify', false)) { lsSet('eodi.notify', false); showSettings(); toast('알림을 껐어요'); break; }
      if (!('Notification' in window)) { toast(isIOS() ? '아이폰은 홈 화면에 설치한 뒤 알림을 켤 수 있어요.' : '이 브라우저는 알림을 지원하지 않아요.', 4000); break; }
      const perm = await Notification.requestPermission(); lsSet('eodi.notify', perm === 'granted'); showSettings();
      toast(perm === 'granted' ? '알림을 켰어요' : '알림이 차단돼 있어요. 휴대폰 설정에서 허용해 주세요.', 3500); break; }
    case 'install': if (S.installPrompt) { S.installPrompt.prompt(); const r = await S.installPrompt.userChoice; S.installPrompt = null; if (r.outcome === 'accepted') toast('설치했어요'); render(); } break;
    case 'install-help': showSheet('홈 화면에 설치하기', `<p style="margin:0">${installHelpHtml()}</p><p class="hint" style="margin:0">설치하면 주소창 없이 전체 화면으로 열리고, 아이폰에서도 알림을 켤 수 있어요.</p>`); break;
    case 'install-dismiss': lsSet('eodi.installDismissed', true); render(); break;
    case 'switch-house': if (id && id !== S.hid) { lsSet('eodi.hid', id); location.reload(); } break;
    case 'join-another': closeSheet(); showOnboard('join'); break;
    case 'logout': await sb.auth.signOut(); lsDel('eodi.hid'); location.replace(location.pathname); break;
  }
});
function go(v) { closeSheet(); if (v === 'browse' && S.view === 'browse') S.browseId = null; S.view = v; render(); window.scrollTo(0, 0);
  if (v === 'recent') setTimeout(() => { markSeen(); render(); }, 1500); }
$('#q').addEventListener('input', e => { S.q = e.target.value; renderFind(); hydratePhotos($('#find-body')); });
$('#scan-cam').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; toast('QR 읽는 중…', 1500);
  const text = await decodeQRFile(f); if (!text) { toast('QR을 찾지 못했어요. 라벨이 화면 가운데 크게 나오게 다시 찍어 주세요.', 4000); return; } handleQRText(text); });
for (const sel of ['#photo-cam', '#photo-lib']) $(sel).addEventListener('change', async e => { const f = e.target.files[0]; if (!f || !F) return;
  try { const b = await compressPhoto(f); if (F.photoPreview) URL.revokeObjectURL(F.photoPreview); F.photoBlob = b; F.photoPreview = URL.createObjectURL(b); F.removePhoto = false; renderPhotoPrev(); }
  catch (err) { toast('사진을 읽지 못했어요. 다른 사진으로 해 주세요.'); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if ($('#scan-root')) stopScanner(); else if (openSheet) closeSheet(); }
  if (e.key === 'Enter' && e.target.id === 'f-voice') { e.preventDefault(); applyParse(); }
  if (e.key === 'Enter' && e.target.id === 'pk-new') { e.preventDefault(); document.querySelector('[data-act="pk-add"]').click(); }
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; scheduleRender(); });
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { S.hiddenAt = Date.now(); return; }
  if (DEMO || !S.hid || $('#screen-app').hidden) return;
  if (Date.now() - S.hiddenAt > 30000) { try { await api.loadAll(); if (!S.live) subscribe(); scheduleRender(); } catch (e) {} }
});

/* ================= 로그인 · 집 연결 ================= */
function showLogin() {
  showScreen('login'); const err = $('#login-err');
  const fail = e => { err.hidden = false; err.textContent = friendlyError(e); };
  $('#btn-google').onclick = async () => { err.hidden = true;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }); if (error) fail(error); };
  let email = '';
  $('#btn-email').onclick = async () => { err.hidden = true; email = $('#login-email').value.trim(); if (!/^\S+@\S+\.\S+$/.test(email)) { fail('이메일 주소를 확인해 주세요'); return; }
    const b = $('#btn-email'); b.disabled = true; const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } }); b.disabled = false;
    if (error) { fail(error); return; } $('#email-step2').hidden = false; $('#login-otp').focus(); toast('메일을 보냈어요. 메일의 로그인 링크를 누르거나, 6자리 번호가 있으면 아래에 넣어 주세요. (스팸함도 확인)', 6000); };
  $('#btn-otp').onclick = async () => { err.hidden = true; const token = $('#login-otp').value.trim(); if (!token) return;
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' }); if (error) { fail(error); return; }
    S.me = data.user.id; S.user = data.user; enterHousehold(); };
}
function showOnboard(tab) {
  showScreen('onboard'); const err = $('#ob-err'); err.hidden = true;
  const meta = (S.user && S.user.user_metadata) || {};
  if (!$('#ob-name').value) $('#ob-name').value = (meta.full_name || meta.name || '').slice(0, 20);
  const invite = lsGet('eodi.invite', null);
  const setTab = t => { $('#ob-tab-new').setAttribute('aria-pressed', t === 'new'); $('#ob-tab-join').setAttribute('aria-pressed', t === 'join'); $('#ob-new').hidden = t !== 'new'; $('#ob-join').hidden = t !== 'join'; setTab.cur = t; };
  setTab(tab || (invite ? 'join' : 'new')); if (invite) $('#ob-code').value = invite;
  $('#ob-tab-new').onclick = () => setTab('new'); $('#ob-tab-join').onclick = () => setTab('join');
  $('#ob-go').onclick = async () => { err.hidden = true; const name = $('#ob-name').value.trim();
    if (!name) { err.hidden = false; err.textContent = '앱에서 보일 이름을 적어 주세요'; $('#ob-name').focus(); return; }
    const b = $('#ob-go'); b.disabled = true; b.textContent = '연결 중…';
    try { let hid;
      if (setTab.cur === 'new') { const { data, error } = await sb.rpc('create_household', { p_name: $('#ob-house').value.trim() || '우리 집', p_display_name: name }); if (error) throw error; hid = data; }
      else { const code = $('#ob-code').value.trim().toUpperCase(); if (code.length !== 6) throw new Error('invalid invite code');
        const { data, error } = await sb.rpc('join_household', { p_code: code, p_display_name: name }); if (error) throw error; hid = data; }
      lsSet('eodi.hid', hid); lsDel('eodi.invite'); await enterHousehold();
    } catch (e) { err.hidden = false; err.textContent = friendlyError(e); } finally { b.disabled = false; b.textContent = '시작하기'; } };
  $('#ob-logout').onclick = async () => { await sb.auth.signOut(); location.replace(location.pathname); };
}
async function enterHousehold() {
  const { data, error } = await sb.from('members').select('household_id').eq('user_id', S.me).order('joined_at');
  if (error) { showScreen('login'); const e = $('#login-err'); e.hidden = false; e.textContent = friendlyError(error); return; }
  const invite = lsGet('eodi.invite', null);
  if (!data.length || invite) { showOnboard(invite ? 'join' : 'new'); return; }
  const pref = lsGet('eodi.hid', null); const row = data.find(r => r.household_id === pref) || data[0];
  S.hid = row.household_id; lsSet('eodi.hid', S.hid); S.lastSeen = lsGet('eodi.lastSeen.' + S.hid, Date.now() - 3 * 864e5);
  showScreen('app'); render();
  try { await api.loadAll(); } catch (e) { toast(friendlyError(e), 5000); }
  subscribe(); render(); afterLoad();
}
function afterLoad() {
  if (S.pendingPlace) { const id = S.pendingPlace; S.pendingPlace = null;
    if (S.places.has(id)) { S.view = 'browse'; S.browseId = id; render(); } else toast('이 라벨의 공간을 찾을 수 없어요.'); }
  if (S.pendingAction === 'new') { S.pendingAction = null; showItemForm(null, {}); }
  else if (S.pendingAction === 'scan') { S.pendingAction = null; openScanner('browse'); }
}

/* ================= 데모 모드 ================= */
function startDemo() {
  S.me = 'demo-me'; S.hid = 'demo';
  S.household = { id: 'demo', name: '우리 집', invite_code: 'DEMO42' };
  S.members = new Map([['demo-me', { id: 'demo-me', name: '경일', role: 'owner' }], ['demo-wife', { id: 'demo-wife', name: '아내', role: 'member' }]]);
  const P = (id, name, parentId, kind, order) => S.places.set(id, { id, name, parentId, kind, order });
  P('r1', '거실', null, 'room', 0); P('r2', '안방', null, 'room', 1); P('r3', '주방', null, 'room', 2); P('r4', '베란다', null, 'room', 3);
  P('f1', 'TV장', 'r1', 'furniture', 0); P('s1', '왼쪽 1번 칸', 'f1', 'slot', 0); P('s2', '오른쪽 2번 칸', 'f1', 'slot', 1);
  P('f2', '붙박이장', 'r2', 'furniture', 0); P('s3', '위 서랍', 'f2', 'slot', 0); P('s4', '아래 서랍', 'f2', 'slot', 1);
  P('f3', '싱크대 상부장', 'r3', 'furniture', 0); P('b1', '수납함 A (캠핑)', 'r4', 'box', 0);
  const now = Date.now(), H = 3600e3;
  const I = (id, name, placeId, memo, by, t) => S.items.set(id, { id, name, placeId, memo, photoPath: null, updatedBy: by, updatedAt: now - t, createdAt: now - t });
  I('i1', '건전지 (AA, AAA)', 'f3', '오른쪽 문 안쪽 투명 통', 'demo-me', 2 * H); I('i2', '여권 2개', 's3', '파란 파일 안', 'demo-wife', 26 * H);
  I('i3', '아이 체온계', 's1', '', 'demo-me', 5 * H); I('i4', '캠핑 랜턴', 'b1', '충전 케이블 같이 있음', 'demo-me', 40 * H); I('i5', '겨울 장갑', 's4', '', 'demo-wife', 3 * H);
  const L = (item, action, from, to, by, t) => S.logs.push({ id: uuid(), itemId: item, itemName: S.items.get(item).name, action, from, to, by, at: now - t });
  L('i1', 'move', '거실 › TV장 › 왼쪽 1번 칸', '주방 › 싱크대 상부장', 'demo-me', 2 * H); L('i5', 'move', '베란다 › 수납함 A (캠핑)', '안방 › 붙박이장 › 아래 서랍', 'demo-wife', 3 * H);
  L('i3', 'add', '', '거실 › TV장 › 왼쪽 1번 칸', 'demo-me', 5 * H); L('i2', 'move', '거실 › TV장 › 오른쪽 2번 칸', '안방 › 붙박이장 › 위 서랍', 'demo-wife', 26 * H);
  L('i4', 'add', '', '베란다 › 수납함 A (캠핑)', 'demo-me', 40 * H);
  S.lastSeen = lsGet('eodi.lastSeen.demo', now - 30 * H); S.loaded = true; S.live = true;
  const bar = $('#demo-bar'); bar.hidden = false;
  bar.textContent = '데모 모드예요. config.js에 Supabase 주소와 키를 넣으면 로그인하고 가족과 실제로 함께 쓸 수 있어요.';
  showScreen('app'); render(); afterLoad();
}

/* ================= 시작 ================= */
function readUrlParams() {
  const u = new URL(location.href); const p = u.searchParams;
  if (p.get('invite')) lsSet('eodi.invite', p.get('invite').toUpperCase().slice(0, 6));
  if (p.get('place')) S.pendingPlace = p.get('place');
  if (p.get('action')) S.pendingAction = p.get('action');
}
function cleanUrl() { const u = new URL(location.href); let ch = false;
  for (const k of ['invite', 'place', 'action', 'code']) if (u.searchParams.has(k)) { u.searchParams.delete(k); ch = true; }
  if (ch) history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { S.swReg = await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW', e); }
}
async function boot() {
  registerSW(); readUrlParams();
  if (DEMO) { cleanUrl(); lsDel('eodi.invite'); startDemo(); return; }
  if (typeof supabase === 'undefined') { showScreen('login'); const e = $('#login-err'); e.hidden = false; e.textContent = '앱 파일을 불러오지 못했어요. 새로고침해 주세요.'; return; }
  sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.hid) location.replace(location.pathname); });
  const { data: { session } } = await sb.auth.getSession();
  cleanUrl();
  if (!session) { showLogin(); return; }
  S.me = session.user.id; S.user = session.user;
  enterHousehold();
}
boot();
})();
