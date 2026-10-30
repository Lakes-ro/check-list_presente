'use strict';

const STATUS_LABELS = { Available: 'Disponível', Reserved: 'Reservado', Purchased: 'Comprado' };
const STATUS_BUTTONS = { Available: '✓ Disponível', Reserved: '♥ Reservar', Purchased: '✓ Comprado' };
const STATUS_TOASTS = {
    Available: 'Item marcado como disponível!',
    Reserved: 'Item reservado!',
    Purchased: 'Item marcado como comprado!'
};
const STATUS_FROM_BACKUP = { available: 'Available', reserved: 'Reserved', purchased: 'Purchased' };
const STATUS_TO_BACKUP = { Available: 'available', Reserved: 'reserved', Purchased: 'purchased' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_NAME_KEY = 'gl_user_name';
const ADMIN_MODE_KEY = 'gl_admin_mode';
const PRESENCE_KEY = 'gl_presence';
const PRESENCE_MS = 45000;
const ADMIN_REFRESH_MS = 15000;
const TRIPLE_CLICK_MS = 900;
const POLL_GUEST_MS = 15000;
const POLL_USER_MS = 20000;
const MAX_PRICE = 99999999.99;
const MIN_PASSWORD = 8;
const ITEMS_PER_PAGE = 20;
const MAX_ITEMS = 1000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const LOADING_HTML = '<div class="loading"><div class="spinner"></div><p>Carregando suas listas...</p></div>';

// Gerenciador de Estado
const State = {
    lists: [],
    shared: null,
    token: null,
    selectedListId: null,
    page: 1,
    searchTerm: '',
    channel: null,
    pollTimer: null,
    liveBound: false,
    loaded: false,
    live: false,
    sig: null,
    view: 'app',
    settings: { guest_access: false, signups_open: true },
    isAdmin: false,
    adminMode: false,
    presenceId: null,
    presenceTimer: null,
    admin: { tab: 'users', user: '', action: '', stats: null, users: [], sessions: [], activity: [], timer: null, loading: false, error: '' },
    userId: null,
    email: '',
    displayName: '',
    sessionKey: undefined,
    recovering: false,
    authMode: 'signin',
    installPrompt: null,
    iosInstall: false
};

let reloadTimer;
let searchTimer;
let toastTimer;
let lastFocus = null;
let loading = false;
let pendingReload = false;

const $ = (sel) => document.querySelector(sel);

/* ---------- Utilitários ---------- */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function safeUrl(value) {
    try {
        const url = new URL(String(value ?? '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

function firstEmoji(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (window.Intl && typeof Intl.Segmenter === 'function') {
        const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
            .segment(text)[Symbol.iterator]().next();
        return first.done ? '' : first.value.segment;
    }
    return Array.from(text)[0] || '';
}

// Aceita "299,90", "1.299,90", "1,299.90", "R$ 45,00" ou número. Retorna null se não houver valor válido.
function parsePrice(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;

    let s = String(value).replace(/[^\d,.]/g, '');
    if (!/\d/.test(s)) return null;

    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
        s = s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')
            : s.replace(/,/g, '');
    } else if (hasComma) {
        const i = s.lastIndexOf(',');
        s = s.slice(0, i).replace(/,/g, '') + '.' + s.slice(i + 1);
    } else if (hasDot) {
        const parts = s.split('.');
        if (parts.length > 2 || parts[parts.length - 1].length === 3) s = parts.join('');
    }

    const n = parseFloat(s);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    if (!isFinite(n)) return '';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function truncateText(text, maxLength = 100) {
    if (!text || text.length <= maxLength) return text || '';
    return text.substring(0, maxLength) + '...';
}

function uuid() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignora */ }
}

function ssGet(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
}

function ssSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* ignora */ }
}

function ssRemove(key) {
    try { sessionStorage.removeItem(key); } catch { /* ignora */ }
}

async function rpcData(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
}

function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
}

function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortAgent(ua) {
    const s = String(ua || '');
    if (!s) return '—';
    const browser = /edg\//i.test(s) ? 'Edge' : /opr\/|opera/i.test(s) ? 'Opera' : /firefox/i.test(s) ? 'Firefox' : /chrome|crios/i.test(s) ? 'Chrome' : /safari/i.test(s) ? 'Safari' : 'Navegador';
    const os = /android/i.test(s) ? 'Android' : /iphone|ipad|ipod/i.test(s) ? 'iOS' : /windows/i.test(s) ? 'Windows' : /mac os/i.test(s) ? 'macOS' : /linux/i.test(s) ? 'Linux' : '';
    return os ? `${browser} • ${os}` : browser;
}

function toast(message, duration = 3500) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

// Mostra mensagens de limite vindas do banco; esconde detalhes técnicos dos demais erros
function errorText(error, fallback) {
    const msg = error && error.message;
    return typeof msg === 'string' && msg.startsWith('Limite') ? msg : fallback;
}

function setStatus(kind) {
    const dot = $('#status-dot');
    const text = $('#status-text');
    const btn = $('#sync-btn');
    const labels = { syncing: 'Sincronizando...', error: 'Sem conexão', live: 'Ao vivo', ok: 'Sincronizado' };
    if (dot) dot.className = `status-dot ${kind}`;
    if (text) text.textContent = labels[kind] || labels.ok;
    if (btn) {
        const every = State.token ? POLL_GUEST_MS / 1000 : POLL_USER_MS / 1000;
        btn.title = kind === 'live'
            ? 'Tempo real ativo. Clique para sincronizar agora.'
            : `Atualiza a cada ${every} s. Clique para sincronizar agora.`;
    }
}

function idleStatus() {
    setStatus(State.live ? 'live' : 'ok');
}

function redirectUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    return url.href;
}

/* ---------- Instalação do PWA ---------- */

function isStandalone() {
    const media = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    return !!(media || window.navigator.standalone === true);
}

function isIos() {
    const ua = navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Registrado cedo para não perder o evento (Chrome/Edge/Android)
window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    if (isStandalone()) return;
    State.installPrompt = event;
    updateChrome();
});

window.addEventListener('appinstalled', () => {
    State.installPrompt = null;
    State.iosInstall = false;
    updateChrome();
    toast('Aplicativo instalado!');
});

function setupInstall() {
    // Safari no iOS não dispara beforeinstallprompt: mostramos instruções manuais
    State.iosInstall = !isStandalone() && isIos();
    updateChrome();
}

async function installApp() {
    if (State.installPrompt) {
        const promptEvent = State.installPrompt;
        State.installPrompt = null;
        updateChrome();
        try {
            await promptEvent.prompt();
            await promptEvent.userChoice;
        } catch (error) {
            console.warn('Instalação cancelada:', error);
        }
        return;
    }
    if (State.iosInstall) openModal($('#install-modal'));
}

/* ---------- Telas e cabeçalho ---------- */

function setView(name) {
    State.view = name;
    $('#auth-view').hidden = name !== 'auth';
    $('#recovery-view').hidden = name !== 'recovery';
    $('#admin-view').hidden = name !== 'admin';
    $('#lists-container').hidden = name !== 'app';
}

function updateChrome() {
    const guest = !!State.token;
    const loggedIn = !!State.userId;
    const inApp = !State.recovering && (guest || loggedIn);
    const owner = loggedIn && !guest && !State.recovering;
    const setHidden = (sel, hidden) => {
        const el = $(sel);
        if (el) el.hidden = hidden;
    };

    setHidden('#sync-btn', !inApp);
    setHidden('#search-bar', !inApp);
    setHidden('#home-btn', !owner);
    setHidden('#settings-btn', !owner);
    setHidden('#user-info', !loggedIn);
    setHidden('#install-btn', !(State.installPrompt || State.iosInstall));
    // Botão discreto (parece a logo): só existe para o administrador
    setHidden('#admin-logo', !(State.isAdmin && owner));
    const logo = $('#admin-logo');
    if (logo) logo.classList.toggle('on', State.adminMode);

    const nameEl = $('#user-name');
    if (nameEl) nameEl.textContent = State.displayName || State.email || '';
}

function showMessage(text) {
    setView('app');
    updateChrome();
    $('#lists-container').innerHTML = UI.renderMessage(text);
}

function clearSearch() {
    clearTimeout(searchTimer);
    const input = $('#search-input');
    if (input) input.value = '';
    State.searchTerm = '';
}

/* ---------- Componentes de interface ---------- */

function countPurchased(items) {
    return (items || []).filter((i) => i.status === 'Purchased').length;
}

const UI = {
    renderMessage(text, extra = '') {
        return `<div class="empty-state"><p>${esc(text)}</p>${extra}</div>`;
    },

    renderListCard(list) {
        const total = (list.items || []).length;
        const purchased = countPurchased(list.items);
        return `
            <div class="card card-clickable" data-action="open-list" data-id="${esc(list.id)}" role="button" tabindex="0" aria-label="Abrir lista ${esc(list.name)}">
                <div class="card-header">
                    <div class="card-heading">
                        <h3 class="card-title">${esc(list.name)}</h3>
                        <span class="badge">${total} item(ns)</span>
                        ${list.visibility === 'private' ? '<span class="badge badge-private">🔒 Privada</span>' : ''}
                    </div>
                </div>
                <p class="card-description">${esc(truncateText(list.description, 60))}</p>
                <div class="card-meta">${purchased}/${total} comprado(s)</div>
                ${total ? `<progress class="progress" max="${total}" value="${purchased}" aria-label="Itens comprados">${purchased}/${total}</progress>` : ''}
                <div class="card-footer">
                    ${canShare(list) ? `<button type="button" class="btn btn-outline" data-action="share-list" data-id="${esc(list.id)}">Compartilhar</button>` : `<button type="button" class="btn btn-outline" data-action="open-list" data-id="${esc(list.id)}">Abrir</button>`}
                    <button type="button" class="btn btn-ghost" data-action="edit-list" data-id="${esc(list.id)}" title="Editar lista" aria-label="Editar lista ${esc(list.name)}">✏️</button>
                    <button type="button" class="btn btn-ghost" data-action="delete-list" data-id="${esc(list.id)}" title="Excluir lista" aria-label="Excluir lista ${esc(list.name)}">🗑️</button>
                </div>
            </div>`;
    },

    renderOtherCard(list, manage) {
        const total = (list.items || []).length;
        const purchased = countPurchased(list.items);
        return `
            <div class="card card-clickable" data-action="open-list" data-id="${esc(list.id)}" role="button" tabindex="0" aria-label="Abrir lista ${esc(list.name)}">
                <div class="card-header">
                    <div class="card-heading">
                        <h3 class="card-title">${esc(list.name)}</h3>
                        <span class="badge">${total} item(ns)</span>
                        ${list.visibility === 'private' ? '<span class="badge badge-private">🔒 Privada</span>' : ''}
                    </div>
                </div>
                <p class="card-description">Lista de ${esc(list.user_name || 'outra pessoa')}${list.description ? ` • ${esc(truncateText(list.description, 50))}` : ''}</p>
                <div class="card-meta">${purchased}/${total} comprado(s)</div>
                ${total ? `<progress class="progress" max="${total}" value="${purchased}" aria-label="Itens comprados">${purchased}/${total}</progress>` : ''}
                <div class="card-footer">
                    <button type="button" class="btn btn-outline" data-action="open-list" data-id="${esc(list.id)}">Abrir</button>
                    ${manage ? `
                        <button type="button" class="btn btn-ghost" data-action="edit-list" data-id="${esc(list.id)}" title="Editar lista" aria-label="Editar lista ${esc(list.name)}">✏️</button>
                        <button type="button" class="btn btn-ghost" data-action="delete-list" data-id="${esc(list.id)}" title="Excluir lista" aria-label="Excluir lista ${esc(list.name)}">🗑️</button>
                    ` : ''}
                </div>
            </div>`;
    },

    renderItemCard(item, isOwner) {
        const status = STATUS_LABELS[item.status] ? item.status : 'Available';
        const link = safeUrl(item.link);
        const price = formatPrice(item.price);
        const buttons = Object.keys(STATUS_LABELS)
            .filter((s) => s !== status)
            .map((s) => `<button type="button" class="btn btn-outline" data-action="set-status" data-id="${esc(item.id)}" data-current="${status}" data-status="${s}">${STATUS_BUTTONS[s]}</button>`)
            .join('');

        return `
            <div class="card item-card" id="item-${esc(item.id)}">
                <div class="item-header">
                    <span class="item-emoji">${esc(item.emoji || '🎁')}</span>
                    <span class="item-status status-${status.toLowerCase()}">${STATUS_LABELS[status]}</span>
                </div>
                <div class="item-body">
                    <h3 class="item-title">${esc(item.name)}</h3>
                    ${item.description ? `<p class="item-description">${esc(truncateText(item.description, 100))}</p>` : ''}
                    <div class="item-price-row">
                        ${price ? `<span class="item-price">${esc(price)}</span>` : '<span class="item-price-empty">Sem preço</span>'}
                        <div class="item-actions">
                            ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" title="Abrir link do produto" aria-label="Abrir link de ${esc(item.name)}">🔗</a>` : ''}
                            ${isOwner ? `
                                <button type="button" class="btn btn-ghost" data-action="edit-item" data-id="${esc(item.id)}" title="Editar item" aria-label="Editar ${esc(item.name)}">✏️</button>
                                <button type="button" class="btn btn-ghost" data-action="delete-item" data-id="${esc(item.id)}" title="Excluir item" aria-label="Excluir ${esc(item.name)}">🗑️</button>
                            ` : ''}
                        </div>
                    </div>
                </div>
                <div class="item-buttons">${buttons}</div>
            </div>`;
    }
};

function isMine(list) {
    return !!State.userId && list.owner_id === State.userId;
}

// Listas privadas: só o dono vê; o admin também vê quando o modo admin está ativo
function isVisibleToMe(list) {
    return isMine(list) || list.visibility !== 'private' || canManageAll();
}

// O link só existe para lista pública e quando o admin permitiu visitantes
function canShare(list) {
    return State.settings.guest_access && list.visibility !== 'private';
}

function applySettings(data) {
    if (data && typeof data === 'object') {
        State.settings = { guest_access: data.guest_access === true, signups_open: data.signups_open !== false };
    }
}

async function loadSettings() {
    try {
        applySettings(await rpcData('public_settings'));
    } catch (error) {
        console.warn('Configurações:', error);
    }
}

function applySignupsUi() {
    const closed = !State.settings.signups_open;
    const tabs = $('#auth-tabs');
    const note = $('#signup-closed-note');
    if (tabs) tabs.hidden = closed;
    if (note) note.hidden = !closed;
    if (closed && State.authMode === 'signup') setAuthMode('signin');
}

function currentList() {
    if (State.token) return State.shared;
    const list = State.lists.find((l) => l.id === State.selectedListId) || null;
    return list && isVisibleToMe(list) ? list : null;
}

function filteredLists() {
    const term = State.searchTerm;
    const base = State.lists.filter(isVisibleToMe);
    if (!term) return base;
    return base.filter((list) =>
        (list.user_name || '').toLowerCase().includes(term) ||
        list.name.toLowerCase().includes(term) ||
        (list.description || '').toLowerCase().includes(term) ||
        (list.items || []).some((item) => item.name.toLowerCase().includes(term))
    );
}

function filteredItems(list) {
    const term = State.searchTerm;
    if (!term) return list.items || [];
    return (list.items || []).filter((item) =>
        item.name.toLowerCase().includes(term) ||
        (item.description || '').toLowerCase().includes(term)
    );
}

function canManageAll() {
    return State.isAdmin && State.adminMode;
}

function renderDashboard() {
    const visible = filteredLists();
    const mine = visible.filter(isMine);
    const others = visible.filter((l) => !isMine(l));
    const allMine = State.lists.filter(isMine);
    const othersCount = State.lists.filter((l) => !isMine(l) && isVisibleToMe(l)).length;
    const itemCount = allMine.reduce((acc, l) => acc + (l.items || []).length, 0);
    const purchasedCount = allMine.reduce((acc, l) => acc + countPurchased(l.items), 0);

    let body = '';
    if (mine.length) {
        body += `<div class="grid">${mine.map((list) => UI.renderListCard(list)).join('')}</div>`;
    } else if (State.searchTerm) {
        if (!others.length) body += UI.renderMessage('Nenhuma lista corresponde à busca.');
    } else {
        body += UI.renderMessage(
            'Nenhuma lista encontrada.',
            '<p>Crie sua primeira lista de presentes!</p><button type="button" class="btn btn-primary" data-action="open-list-modal">+ Nova Lista</button>'
        );
    }

    if (others.length) {
        const manage = canManageAll();
        body += `
            <h3 class="section-title">Listas de outras pessoas</h3>
            <div class="grid">${others.map((list) => UI.renderOtherCard(list, manage)).join('')}</div>`;
    }

    $('#lists-container').innerHTML = `
        <div class="dashboard-header">
            <div>
                <h2>Minhas Listas de Presentes</h2>
                <p class="dashboard-stats">${allMine.length} lista(s) • ${itemCount} item(ns) • ${purchasedCount} comprado(s)${othersCount ? ` • ${othersCount} de outras pessoas` : ''}</p>
            </div>
            <button type="button" class="btn btn-primary" data-action="open-list-modal">
                <span aria-hidden="true">+</span>
                <span>Nova Lista</span>
            </button>
        </div>
        ${body}`;
}

function renderListView() {
    const list = currentList();
    if (!list) {
        if (State.token) {
            $('#lists-container').innerHTML = UI.renderMessage('Lista não encontrada. Confira o link com quem compartilhou.');
        } else {
            State.selectedListId = null;
            renderDashboard();
        }
        return;
    }

    const isGuest = !!State.token;
    const isOwner = !isGuest && isMine(list);
    const manage = isOwner || (!isGuest && canManageAll());
    const items = filteredItems(list);
    const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
    State.page = Math.min(Math.max(1, State.page), totalPages);
    const pageItems = items.slice((State.page - 1) * ITEMS_PER_PAGE, State.page * ITEMS_PER_PAGE);
    const total = (list.items || []).length;
    const purchased = countPurchased(list.items);

    let banner = '';
    if (!isOwner) {
        const action = isGuest
            ? (State.userId
                ? `<a href="${esc(location.pathname)}">Minhas listas</a>`
                : '<button type="button" class="btn btn-primary" data-action="go-login">Entrar para ver todas as listas</button>')
            : '';
        banner = `
            <div class="shared-banner">
                <span aria-hidden="true">👥</span>
                <span>Lista${list.user_name ? ` de ${esc(list.user_name)}` : ' de outra pessoa'}. Você pode reservar ou marcar itens como comprados.${manage ? ' (modo admin: você também pode editar)' : ''}</span>
                ${action}
            </div>`;
    }

    let body;
    if (pageItems.length) {
        body = `<div class="grid">${pageItems.map((item) => UI.renderItemCard(item, manage)).join('')}</div>`;
    } else if (State.searchTerm) {
        body = UI.renderMessage('Nenhum item corresponde à busca.');
    } else if (manage) {
        body = UI.renderMessage('Nenhum item encontrado.', '<p>Adicione o primeiro presente à lista!</p>');
    } else {
        body = UI.renderMessage('Esta lista ainda não tem itens.');
    }

    const pagination = totalPages > 1 ? `
        <div class="pagination">
            ${State.page > 1 ? '<button type="button" class="btn btn-outline" data-action="prev-page">← Anterior</button>' : ''}
            <span class="pagination-info">Página ${State.page} de ${totalPages}</span>
            ${State.page < totalPages ? '<button type="button" class="btn btn-outline" data-action="next-page">Próxima →</button>' : ''}
        </div>` : '';

    $('#lists-container').innerHTML = `
        ${banner}
        <div class="list-view-header">
            <div class="list-view-info">
                ${!isGuest ? '<button type="button" class="btn btn-ghost back-btn" data-action="home">← Minhas listas</button>' : ''}
                <h2>${esc(list.name)}</h2>
                ${list.description ? `<p>${esc(list.description)}</p>` : ''}
                <p class="list-meta">Criado por: ${esc(list.user_name || 'Anônimo')} • ${purchased}/${total} comprado(s)${list.visibility === 'private' ? ' • 🔒 Privada' : ''}</p>
                ${total ? `<progress class="progress" max="${total}" value="${purchased}" aria-label="Itens comprados">${purchased}/${total}</progress>` : ''}
            </div>
            ${manage ? `
                <div class="list-view-actions">
                    ${canShare(list) ? `<button type="button" class="btn btn-outline" data-action="share-list" data-id="${esc(list.id)}">Compartilhar</button>` : ''}
                    <button type="button" class="btn btn-outline" data-action="edit-list" data-id="${esc(list.id)}">✏️ Editar</button>
                    ${canShare(list) ? `<button type="button" class="btn btn-outline" data-action="rotate-link" data-id="${esc(list.id)}" title="O link atual deixa de funcionar para quem não tem conta">Invalidar link</button>` : ''}
                    <button type="button" class="btn btn-primary" data-action="open-item-modal" data-id="${esc(list.id)}">
                        <span aria-hidden="true">+</span>
                        <span>Adicionar Item</span>
                    </button>
                </div>
            ` : ''}
        </div>
        ${body}
        ${pagination}`;
}

function render() {
    if (State.token || (State.selectedListId && currentList())) {
        renderListView();
    } else {
        State.selectedListId = null;
        renderDashboard();
    }
}

/* ---------- Navegação ---------- */

function openList(id) {
    if (!State.lists.some((l) => l.id === id)) return;
    State.selectedListId = id;
    State.page = 1;
    clearSearch();
    try { history.pushState({ listId: id }, ''); } catch { /* ignora */ }
    render();
    window.scrollTo(0, 0);
}

function goHome() {
    if (State.token) return;
    clearSearch();
    State.page = 1;
    // Volta pelo histórico para o botão "voltar" do navegador/celular continuar coerente
    if (State.selectedListId && history.state && history.state.listId === State.selectedListId) {
        history.back();
        return;
    }
    State.selectedListId = null;
    render();
}

function onPopState(event) {
    if (State.token || !State.userId || State.recovering) return;
    const id = event.state && event.state.listId;
    State.selectedListId = id && State.lists.some((l) => l.id === id) ? id : null;
    State.page = 1;
    clearSearch();
    render();
}

/* ---------- Autenticação ---------- */

function authErrorText(error) {
    const code = error && error.code;
    const msg = String((error && error.message) || '').toLowerCase();

    if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
    if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar (veja a caixa de entrada e o spam).';
    if (code === 'user_already_exists' || msg.includes('already registered')) return 'Este e-mail já tem conta. Entre ou recupere a senha.';
    if (code === 'weak_password' || msg.includes('password should')) return `Senha fraca. Use pelo menos ${MIN_PASSWORD} caracteres.`;
    if (code === 'signup_disabled' || msg.includes('database error saving new user') || msg.includes('cadastros fechados')) return 'Novos cadastros estão fechados. Peça ao administrador para liberar.';
    if (msg.includes('session missing') || code === 'session_not_found') return 'Link expirado ou inválido. Peça um novo link de recuperação.';
    if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || msg.includes('rate limit')) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    return 'Não foi possível concluir. Tente novamente.';
}

function setMessage(selector, text, kind = 'error') {
    const el = $(selector);
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('ok', kind === 'ok');
}

function authMsg(text, kind) {
    setMessage('#auth-message', text, kind);
}

function setAuthMode(mode) {
    State.authMode = mode;
    const signup = mode === 'signup';

    document.querySelectorAll('.auth-tab').forEach((btn) => {
        const active = btn.dataset.mode === mode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });

    $('#auth-name-group').hidden = !signup;
    $('#auth-password2-group').hidden = !signup;
    $('#auth-password2').required = signup;
    $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = signup ? 'Criar conta' : 'Entrar';
    $('#forgot-btn').hidden = signup;
    authMsg('');
}

function nameFromSession(session) {
    const meta = session && session.user && session.user.user_metadata;
    const fromMeta = meta && typeof meta.display_name === 'string' ? meta.display_name.trim() : '';
    return (fromMeta || lsGet(USER_NAME_KEY) || '').slice(0, 50);
}

async function onSession(session) {
    if (State.recovering) return;

    const key = session ? session.user.id : 'none';
    if (key === State.sessionKey) return;
    State.sessionKey = key;
    State.userId = session ? session.user.id : null;
    State.email = session ? (session.user.email || '') : '';
    State.displayName = nameFromSession(session);

    // Convidado (link compartilhado): não precisa de conta, só atualiza o cabeçalho
    if (State.token) {
        updateChrome();
        return;
    }

    State.selectedListId = null;
    State.page = 1;
    State.sig = null;
    try { history.replaceState({}, ''); } catch { /* ignora */ }

    if (!session) {
        stopLive();
        stopPresence();
        stopAdminTimer();
        State.isAdmin = false;
        State.adminMode = false;
        applySignupsUi();
        State.lists = [];
        State.loaded = false;
        clearSearch();
        setView('auth');
        updateChrome();
        return;
    }

    setView('app');
    updateChrome();
    $('#lists-container').innerHTML = LOADING_HTML;
    State.loaded = false;
    syncRealtimeAuth(session);
    await loadSettings();
    await loadAll();
    startLive();
    await Promise.all([presenceInit(), adminInit()]);
}

// Garante que o Realtime use o token do usuário (necessário para a RLS entregar os eventos)
function syncRealtimeAuth(session) {
    try {
        if (session && session.access_token && db.realtime && typeof db.realtime.setAuth === 'function') {
            db.realtime.setAuth(session.access_token);
        }
    } catch (error) {
        console.warn('Realtime auth:', error);
    }
}

function onAuthEvent(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
        State.recovering = true;
        setView('recovery');
        updateChrome();
        return;
    }
    onSession(event === 'SIGNED_OUT' ? null : session);
}

async function onAuthSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const signup = State.authMode === 'signup';

    if (!EMAIL_RE.test(email)) return authMsg('Informe um e-mail válido.');
    if (password.length < MIN_PASSWORD) return authMsg(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    if (signup && password !== $('#auth-password2').value) return authMsg('As senhas não conferem.');
    authMsg('');

    await withBusy(form, async () => {
        try {
            if (!signup) {
                const { data, error } = await db.auth.signInWithPassword({ email, password });
                if (error) return authMsg(authErrorText(error));
                $('#auth-password').value = '';
                await onSession(data.session);
                return;
            }

            const name = $('#auth-name').value.trim().slice(0, 50);
            const { data, error } = await db.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: redirectUrl(), data: name ? { display_name: name } : {} }
            });
            if (error) return authMsg(authErrorText(error));

            // E-mail já cadastrado: o Supabase devolve um usuário "vazio" para não revelar a conta
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                return authMsg('Este e-mail já tem conta. Entre ou recupere a senha.');
            }
            if (name) lsSet(USER_NAME_KEY, name);
            if (data.session) {
                await onSession(data.session);
                return;
            }
            setAuthMode('signin');
            $('#auth-password').value = '';
            $('#auth-password2').value = '';
            authMsg('Conta criada! Enviamos um e-mail de confirmação. Confirme e depois entre.', 'ok');
        } catch (error) {
            console.error(error);
            authMsg('Sem conexão. Tente novamente.');
        }
    });
}

async function forgotPassword() {
    const email = $('#auth-email').value.trim();
    if (!EMAIL_RE.test(email)) return authMsg('Digite seu e-mail acima para receber o link de recuperação.');

    try {
        const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
        if (error) authMsg(authErrorText(error));
        else authMsg('Se esse e-mail tiver conta, enviamos um link para redefinir a senha.', 'ok');
    } catch (error) {
        console.error(error);
        authMsg('Sem conexão. Tente novamente.');
    }
}

async function onRecoverySubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = $('#new-password').value;
    const msg = (text, kind) => setMessage('#recovery-message', text, kind);

    if (password.length < MIN_PASSWORD) return msg(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    if (password !== $('#new-password2').value) return msg('As senhas não conferem.');
    msg('');

    await withBusy(form, async () => {
        try {
            const { error } = await db.auth.updateUser({ password });
            if (error) return msg(authErrorText(error));

            form.reset();
            State.recovering = false;
            State.sessionKey = undefined;
            try { history.replaceState(null, '', redirectUrl()); } catch { /* ignora */ }
            const { data } = await db.auth.getSession();
            toast('Senha atualizada!');
            await onSession(data.session);
        } catch (error) {
            console.error(error);
            msg('Sem conexão. Tente novamente.');
        }
    });
}

async function backToLogin() {
    State.recovering = false;
    State.sessionKey = undefined;
    try { history.replaceState(null, '', redirectUrl()); } catch { /* ignora */ }
    const { data } = await db.auth.getSession();
    await onSession(data.session);
}

async function logout() {
    closeAllModals();
    await presenceEnd('logout');
    ssRemove(ADMIN_MODE_KEY);
    try {
        await db.auth.signOut();
    } catch (error) {
        console.error(error);
    }
    await onSession(null);
}

/* ---------- Dados (Supabase) ---------- */

async function fetchOwn() {
    const { data, error } = await db
        .from('wishlists')
        .select('id, owner_id, name, description, visibility, user_name, share_token, created_at, items(id, name, description, price, emoji, link, status, created_at)')
        .order('created_at', { ascending: false })
        .order('created_at', { referencedTable: 'items', ascending: true });
    if (error) throw error;
    State.lists = data || [];
}

async function fetchShared() {
    const { data, error } = await db.rpc('get_shared_list', { p_token: State.token });
    if (error) throw error;
    State.shared = data ? { id: State.token, ...data } : null;
}

async function loadAll({ silent = false } = {}) {
    if (!State.token && !State.userId) return;
    if (loading) {
        pendingReload = true;
        return;
    }
    loading = true;
    setStatus('syncing');

    try {
        if (State.token) await fetchShared();
        else await fetchOwn();
        State.loaded = true;
        idleStatus();
        // Só redesenha quando os dados mudaram (evita piscar e perder o foco nas atualizações periódicas)
        const sig = JSON.stringify(State.token ? State.shared : State.lists);
        if (sig !== State.sig) {
            State.sig = sig;
            render();
        }
    } catch (error) {
        console.error('Erro ao carregar:', error);
        setStatus('error');
        if (!State.loaded) {
            $('#lists-container').innerHTML = UI.renderMessage('Não foi possível carregar os dados. Verifique a conexão e toque em Sincronizar.');
        } else if (!silent) {
            toast('Não foi possível sincronizar. Verifique sua conexão.');
        }
    } finally {
        loading = false;
        if (pendingReload) {
            pendingReload = false;
            loadAll({ silent: true });
        }
    }
}

function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadAll({ silent: true }), 400);
}

function stopLive() {
    clearInterval(State.pollTimer);
    State.pollTimer = null;
    State.live = false;
    if (State.channel) {
        try { db.removeChannel(State.channel); } catch (error) { console.warn(error); }
        State.channel = null;
    }
}

function startLive() {
    stopLive();

    // Atualização periódica: rede de segurança caso o Realtime esteja indisponível
    State.pollTimer = setInterval(
        () => { if (!document.hidden) loadAll({ silent: true }); },
        State.token ? POLL_GUEST_MS : POLL_USER_MS
    );

    // Convidado sem conta não tem acesso às tabelas (RLS), então só usa o polling acima
    if (!State.token) {
        State.channel = db.channel('giftlist-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, scheduleReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'wishlists' }, scheduleReload)
            .subscribe((status) => {
                State.live = status === 'SUBSCRIBED';
                if (!loading) idleStatus();
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('Realtime indisponível:', status);
            });
    }

    if (!State.liveBound) {
        State.liveBound = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                loadAll({ silent: true });
                presenceTick();
            }
        });
        window.addEventListener('online', () => loadAll({ silent: true }));
    }
}

/* ---------- Link de compartilhamento ---------- */

// Quem está logado e abre um link vê a lista dentro do app (todas as listas já ficam visíveis)
async function openFromToken(session) {
    const token = State.token;
    State.token = null;
    State.shared = null;
    try { history.replaceState({}, '', redirectUrl()); } catch { /* ignora */ }
    State.sessionKey = undefined;
    await onSession(session);
    const list = State.lists.find((l) => l.share_token === token);
    if (list) openList(list.id);
    else toast('Lista não encontrada ou link inválido.', 5000);
}

async function rotateLink(id) {
    const list = State.lists.find((l) => l.id === id);
    if (!list) return;
    if (!confirm('Invalidar o link atual? Quem não tem conta e usa o link antigo perde o acesso. Depois use Compartilhar para gerar o novo link.')) return;

    try {
        const ok = await rpcData('rotate_share_token', { p_list_id: id });
        toast(ok ? 'Link invalidado. Use Compartilhar para gerar o novo link.' : 'Não foi possível invalidar o link.', 5000);
    } catch (error) {
        console.error(error);
        toast('Erro ao invalidar o link.');
    }
    await loadAll({ silent: true });
}

/* ---------- Presença: quando entrou, ficou online e saiu ---------- */

function presenceStorageKey() {
    return `${PRESENCE_KEY}:${State.userId}`;
}

async function presenceStart() {
    try {
        const id = await rpcData('presence_start', { p_user_agent: navigator.userAgent });
        if (id) ssSet(presenceStorageKey(), id);
        return id || null;
    } catch (error) {
        console.warn('Presença:', error);
        return null;
    }
}

// true = sessão ativa; false = não existe ou expirou; null = sem conexão
async function presencePing(id) {
    try {
        return !!(await rpcData('presence_ping', { p_session: id }));
    } catch (error) {
        console.warn('Presença:', error);
        return null;
    }
}

async function presenceTick() {
    if (!State.userId) return;
    if (!State.presenceId) {
        State.presenceId = await presenceStart();
        return;
    }
    const alive = await presencePing(State.presenceId);
    if (alive === false) State.presenceId = await presenceStart();
}

function stopPresence() {
    clearInterval(State.presenceTimer);
    State.presenceTimer = null;
    State.presenceId = null;
}

async function presenceInit() {
    stopPresence();
    if (!State.userId) return;

    // Recarregar a página continua a mesma sessão (se ainda estiver ativa)
    const saved = ssGet(presenceStorageKey());
    let id = null;
    if (saved && UUID_RE.test(saved) && (await presencePing(saved)) === true) id = saved;
    if (!id) id = await presenceStart();

    State.presenceId = id;
    State.presenceTimer = setInterval(() => { presenceTick(); }, PRESENCE_MS);
}

async function presenceEnd(reason) {
    const id = State.presenceId;
    const key = presenceStorageKey();
    stopPresence();
    ssRemove(key);
    if (!id) return;
    try {
        await rpcData('presence_end', { p_session: id, p_reason: reason });
    } catch (error) {
        console.warn('Presença:', error);
    }
}

/* ---------- Painel do administrador ---------- */

const ACTION_LABELS = {
    login: 'Entrou',
    logout: 'Saiu',
    list_created: 'Criou lista',
    list_updated: 'Editou lista',
    list_deleted: 'Excluiu lista',
    item_created: 'Criou item',
    item_updated: 'Editou item',
    item_status_changed: 'Mudou status',
    item_deleted: 'Excluiu item',
    share_link_rotated: 'Invalidou link',
    setting_changed: 'Mudou configuração'
};

const SETTING_LABELS = { guest_access: 'Visitantes (link sem conta)', signups_open: 'Novos cadastros' };
const END_REASONS = { logout: 'Saiu pelo app', timeout: 'Sem sinal', closed: 'Fechou o app' };
const ENTITY_LABELS = { list: 'Lista', item: 'Item', session: 'Sessão', setting: 'Configuração' };

let adminClicks = [];

// O botão só existe para o administrador (is_admin no banco). Três cliques rápidos habilitam o modo admin.
async function adminInit() {
    State.isAdmin = false;
    State.adminMode = false;
    try {
        State.isAdmin = (await rpcData('is_admin')) === true;
    } catch (error) {
        console.warn('Admin:', error);
    }
    if (State.isAdmin && ssGet(ADMIN_MODE_KEY) === '1') State.adminMode = true;
    updateChrome();
    if (State.adminMode && State.view === 'app') render();
}

function onAdminLogoClick() {
    if (!State.isAdmin) return;
    if (State.adminMode) {
        if (State.view === 'admin') closeAdminPanel();
        else openAdminPanel();
        return;
    }
    const now = Date.now();
    adminClicks = adminClicks.filter((t) => now - t < TRIPLE_CLICK_MS);
    adminClicks.push(now);
    if (adminClicks.length >= 3) {
        adminClicks = [];
        enableAdminMode();
    }
}

function enableAdminMode() {
    State.adminMode = true;
    ssSet(ADMIN_MODE_KEY, '1');
    toast('Modo admin ativado.');
    updateChrome();
    openAdminPanel();
}

function disableAdminMode() {
    State.adminMode = false;
    ssRemove(ADMIN_MODE_KEY);
    stopAdminTimer();
    setView('app');
    updateChrome();
    State.sig = null;
    render();
    toast('Modo admin desativado.');
}

function stopAdminTimer() {
    clearInterval(State.admin.timer);
    State.admin.timer = null;
}

function openAdminPanel() {
    if (!State.isAdmin || !State.adminMode) return;
    closeAllModals();
    setView('admin');
    updateChrome();
    stopAdminTimer();
    State.admin.timer = setInterval(() => {
        if (!document.hidden && State.view === 'admin') adminLoad();
    }, ADMIN_REFRESH_MS);
    adminLoad();
}

function closeAdminPanel() {
    stopAdminTimer();
    setView('app');
    updateChrome();
    render();
}

function setAdminTab(tab) {
    if (!['users', 'sessions', 'activity', 'access'].includes(tab)) return;
    State.admin.tab = tab;
    adminLoad();
}

function adminShowUser(id, tab) {
    State.admin.user = UUID_RE.test(id) ? id : '';
    State.admin.tab = tab;
    adminLoad();
}

async function adminLoad() {
    const a = State.admin;
    if (a.loading || !State.isAdmin) return;
    a.loading = true;
    a.error = '';

    try {
        const dash = await rpcData('admin_dashboard');
        a.stats = dash.stats;
        a.users = dash.users || [];
        applySettings(dash.settings);
        if (a.tab === 'sessions') {
            a.sessions = (await rpcData('admin_sessions', { p_user: a.user || null, p_limit: 300 })) || [];
        } else if (a.tab === 'activity') {
            a.activity = (await rpcData('admin_activity', { p_user: a.user || null, p_action: a.action || null, p_limit: 300 })) || [];
        }
    } catch (error) {
        console.error('Admin:', error);
        a.error = 'Não foi possível carregar os dados do painel.';
    } finally {
        a.loading = false;
    }
    adminRender();
}

function adminTable(headers, rows) {
    if (!rows.length) return UI.renderMessage('Nenhum registro encontrado.');
    return `
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
                <tbody>${rows.join('')}</tbody>
            </table>
        </div>`;
}

function adminUsersHtml() {
    const rows = State.admin.users.map((u) => `
        <tr>
            <td><strong>${esc(u.name || '—')}</strong><small>${esc(u.email)}</small></td>
            <td>${u.online ? '<span class="online-dot" aria-hidden="true"></span> Online' : 'Offline'}<small>${esc(formatDateTime(u.last_seen || u.last_sign_in_at))}</small></td>
            <td>${esc(u.sessions)}</td>
            <td>${esc(formatDuration(u.total_seconds))}</td>
            <td>${esc(u.lists)}</td>
            <td>${esc(u.items)}</td>
            <td>${esc(formatDateTime(u.created_at))}</td>
            <td class="admin-row-actions">
                <button type="button" class="btn btn-outline" data-action="admin-user-sessions" data-id="${esc(u.id)}">Sessões</button>
                <button type="button" class="btn btn-outline" data-action="admin-user-activity" data-id="${esc(u.id)}">Atividade</button>
            </td>
        </tr>`);
    return adminTable(['Usuário', 'Status / último sinal', 'Sessões', 'Tempo total', 'Listas', 'Itens', 'Cadastro', ''], rows);
}

function adminSessionsHtml() {
    const rows = State.admin.sessions.map((s) => {
        const left = s.ended_at
            ? formatDateTime(s.ended_at)
            : (s.online ? '<span class="online-dot" aria-hidden="true"></span> Online agora' : `Sem sinal (último: ${esc(formatDateTime(s.last_seen_at))})`);
        return `
            <tr>
                <td>${esc(s.email || '—')}</td>
                <td>${esc(formatDateTime(s.started_at))}</td>
                <td>${s.ended_at ? esc(left) : left}</td>
                <td>${esc(formatDuration(s.seconds))}</td>
                <td>${esc(END_REASONS[s.ended_reason] || (s.online ? '—' : 'Sem sinal'))}</td>
                <td>${esc(shortAgent(s.user_agent))}</td>
            </tr>`;
    });
    return adminTable(['Usuário', 'Entrou', 'Saiu', 'Permanência', 'Motivo', 'Dispositivo'], rows);
}

function statusName(value) {
    return STATUS_LABELS[value] || value || '—';
}

function describeActivity(row) {
    const d = row.details || {};
    switch (row.action) {
        case 'item_status_changed':
            return `${statusName(d.from)} → ${statusName(d.to)} (lista ${d.list || '—'})`;
        case 'item_created':
            return `Lista ${d.list || '—'}${d.price !== null && d.price !== undefined ? ` • ${formatPrice(d.price)}` : ''}`;
        case 'item_updated': {
            const changes = Object.entries(d.changes || {}).map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`).join('; ');
            return `Lista ${d.list || '—'} • ${changes}`;
        }
        case 'item_deleted':
            return `Lista ${d.list || '—'} • estava ${statusName(d.status)}`;
        case 'list_created':
            return d.description ? truncateText(String(d.description), 80) : '';
        case 'list_updated': {
            const parts = [];
            if (d.name && d.name.from !== d.name.to) parts.push(`nome: ${d.name.from} → ${d.name.to}`);
            if (d.description && d.description.from !== d.description.to) parts.push('descrição alterada');
            if (d.visibility && d.visibility.from !== d.visibility.to) parts.push(`visibilidade: ${d.visibility.from === 'private' ? 'privada' : 'pública'} → ${d.visibility.to === 'private' ? 'privada' : 'pública'}`);
            return parts.join('; ');
        }
        case 'list_deleted':
            return `${d.items ?? 0} item(ns)${d.created_by ? ` • criada por ${d.created_by}` : ''}`;
        case 'setting_changed':
            return `${d.from ? 'ligado' : 'desligado'} → ${d.to ? 'ligado' : 'desligado'}`;
        default:
            return '';
    }
}

function adminActivityHtml() {
    const rows = State.admin.activity.map((r) => `
        <tr>
            <td>${esc(formatDateTime(r.at))}</td>
            <td>${esc(r.actor_email || 'sistema')}</td>
            <td><span class="action-tag action-${esc(r.action)}">${esc(ACTION_LABELS[r.action] || r.action)}</span></td>
            <td>${esc(ENTITY_LABELS[r.entity] || '')}${r.entity_name ? `: ${esc(truncateText(r.entity === 'setting' ? (SETTING_LABELS[r.entity_name] || r.entity_name) : r.entity_name, 60))}` : ''}</td>
            <td>${esc(truncateText(describeActivity(r), 160))}</td>
        </tr>`);
    return adminTable(['Quando', 'Quem', 'Ação', 'Alvo', 'Detalhes'], rows);
}

function adminAccessHtml() {
    const cards = [
        {
            key: 'guest_access',
            on: State.settings.guest_access,
            onLabel: 'Ativado',
            offLabel: 'Desativado',
            onAction: 'Desativar',
            offAction: 'Ativar',
            text: 'Ativado: quem tem o link de uma lista pública vê a lista e pode reservar ou marcar itens sem criar conta. Desativado: só quem tem conta entra. Listas privadas nunca aparecem para visitantes.'
        },
        {
            key: 'signups_open',
            on: State.settings.signups_open,
            onLabel: 'Aberto',
            offLabel: 'Fechado',
            onAction: 'Fechar',
            offAction: 'Abrir',
            text: 'Aberto: qualquer pessoa pode criar uma conta nova. Fechado: só entram as contas que já existem. Mantenha fechado se o app é só para você e poucas pessoas.'
        }
    ];
    return `<div class="access-list">${cards.map((c) => `
        <div class="access-card">
            <div class="access-info">
                <strong>${esc(SETTING_LABELS[c.key])}</strong>
                <p>${esc(c.text)}</p>
            </div>
            <div class="access-actions">
                <span class="access-state ${c.on ? 'on' : 'off'}">${esc(c.on ? c.onLabel : c.offLabel)}</span>
                <button type="button" class="btn ${c.on ? 'btn-outline btn-danger' : 'btn-primary'}" data-action="admin-toggle-setting" data-key="${esc(c.key)}">${esc(c.on ? c.onAction : c.offAction)}</button>
            </div>
        </div>`).join('')}</div>`;
}

async function adminToggleSetting(key) {
    if (!SETTING_LABELS[key]) return;
    const next = !State.settings[key];
    const messages = {
        guest_access: next
            ? 'Ativar visitantes? Quem tiver o link de uma lista pública poderá ver a lista e reservar itens sem criar conta.'
            : 'Desativar visitantes? Os links deixam de funcionar para quem não tem conta.',
        signups_open: next
            ? 'Abrir novos cadastros? Qualquer pessoa poderá criar uma conta e ver as listas públicas.'
            : 'Fechar novos cadastros? Só as contas que já existem poderão entrar.'
    };
    if (!confirm(messages[key])) return;

    try {
        applySettings(await rpcData('admin_set_setting', { p_key: key, p_enabled: next }));
        toast('Configuração salva.');
    } catch (error) {
        console.error(error);
        toast('Não foi possível salvar a configuração.');
    }
    State.sig = null;
    await adminLoad();
}

function adminRender() {
    const a = State.admin;

    document.querySelectorAll('[data-action="admin-tab"]').forEach((btn) => {
        const active = btn.dataset.tab === a.tab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });

    const st = a.stats || {};
    $('#admin-stats').innerHTML = [['Usuários', st.users], ['Online agora', st.online], ['Listas', st.lists], ['Itens', st.items]]
        .map(([label, value]) => `<div class="admin-stat"><strong>${esc(value ?? '—')}</strong><span>${esc(label)}</span></div>`)
        .join('');

    const userSel = $('#admin-user-filter');
    userSel.hidden = a.tab === 'users' || a.tab === 'access';
    userSel.innerHTML = '<option value="">Todos os usuários</option>' + a.users
        .map((u) => `<option value="${esc(u.id)}"${u.id === a.user ? ' selected' : ''}>${esc(u.name ? `${u.name} (${u.email})` : u.email)}</option>`)
        .join('');

    const actionSel = $('#admin-action-filter');
    actionSel.hidden = a.tab !== 'activity';
    actionSel.innerHTML = '<option value="">Todas as ações</option>' + Object.entries(ACTION_LABELS)
        .map(([key, label]) => `<option value="${esc(key)}"${key === a.action ? ' selected' : ''}>${esc(label)}</option>`)
        .join('');

    let html;
    if (a.error) html = UI.renderMessage(a.error);
    else if (a.tab === 'access') html = adminAccessHtml();
    else if (a.tab === 'sessions') html = adminSessionsHtml();
    else if (a.tab === 'activity') html = adminActivityHtml();
    else html = adminUsersHtml();
    $('#admin-content').innerHTML = html;
}

/* ---------- Ações de listas e itens ---------- */

async function updateStatus(button) {
    const id = button.dataset.id;
    const expected = button.dataset.current;
    const next = button.dataset.status;
    if (!UUID_RE.test(id) || !STATUS_LABELS[next] || !STATUS_LABELS[expected] || next === expected) return;

    const card = button.closest('.item-card');
    const buttons = card ? card.querySelectorAll('.item-buttons button') : [button];
    buttons.forEach((b) => { b.disabled = true; });

    try {
        const { data, error } = await db.rpc('set_item_status', {
            p_item_id: id,
            p_expected: expected,
            p_status: next,
            p_token: State.token
        });

        if (error) {
            console.error(error);
            toast('Erro ao atualizar o status.');
        } else if (!data) {
            toast('Este item já foi alterado por outra pessoa.');
        } else {
            toast(STATUS_TOASTS[next]);
        }
    } catch (error) {
        console.error(error);
        toast('Sem conexão. O status não foi alterado.');
    }

    buttons.forEach((b) => { b.disabled = false; });
    await loadAll({ silent: true });
}

async function deleteItem(id) {
    if (!UUID_RE.test(id) || !confirm('Deseja excluir este item?')) return;
    const { error } = await db.from('items').delete().eq('id', id).then((r) => r, (e) => ({ error: e }));
    if (error) {
        console.error(error);
        toast('Erro ao excluir o item.');
        return;
    }
    toast('Item removido com sucesso!');
    await loadAll({ silent: true });
}

async function deleteList(id) {
    const list = State.lists.find((l) => l.id === id);
    if (!list) return;
    if (!confirm(`Deseja excluir a lista "${list.name}" permanentemente?`)) return;

    const { error } = await db.from('wishlists').delete().eq('id', id).then((r) => r, (e) => ({ error: e }));
    if (error) {
        console.error(error);
        toast('Erro ao excluir a lista.');
        return;
    }
    if (State.selectedListId === id) State.selectedListId = null;
    toast('Lista excluída com sucesso!');
    await loadAll({ silent: true });
}

function buildShareUrl(token) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('list', token);
    return url.href;
}

async function shareList(id) {
    const list = State.lists.find((l) => l.id === id);
    if (!list || !UUID_RE.test(list.share_token)) return;
    const url = buildShareUrl(list.share_token);

    if (navigator.share) {
        try {
            await navigator.share({ title: list.name, text: list.description || list.name, url });
            return;
        } catch (error) {
            if (error && error.name === 'AbortError') return;
        }
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
            toast('Link copiado para a área de transferência!');
            return;
        }
    } catch { /* cai no fallback */ }

    window.prompt('Copie o link da lista:', url);
}

/* ---------- Modais ---------- */

function openModal(modal, focusSelector) {
    lastFocus = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    if (focusSelector) setTimeout(() => {
        const el = modal.querySelector(focusSelector);
        if (el) el.focus();
    }, 50);
}

function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    const form = modal.querySelector('form');
    if (form) form.reset();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
}

function closeAllModals() {
    document.querySelectorAll('.modal.open').forEach((m) => closeModal(m));
}

async function withBusy(form, task) {
    const btn = form.querySelector('[type="submit"]');
    if (btn) btn.disabled = true;
    try {
        await task();
    } catch (error) {
        console.error(error);
        toast('Sem conexão. Tente novamente.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* Lista */

function openListModal(listId) {
    const list = listId ? State.lists.find((l) => l.id === listId) : null;
    openModal($('#list-modal'), '#list-name');
    $('#list-modal-title').textContent = list ? 'Editar Lista' : 'Criar Nova Lista';
    $('#list-submit').textContent = list ? 'Salvar' : 'Criar Lista';
    $('#list-id').value = list ? list.id : '';
    $('#list-name').value = list ? list.name : '';
    $('#list-desc').value = list ? (list.description || '') : '';
    $('#list-visibility').value = list && list.visibility === 'private' ? 'private' : 'public';
}

function onListSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = $('#list-id').value;
    const name = $('#list-name').value.trim();
    if (!name) {
        toast('Por favor, insira um nome para a lista');
        return;
    }
    const description = $('#list-desc').value.trim();
    const visibility = $('#list-visibility').value === 'private' ? 'private' : 'public';

    withBusy(form, async () => {
        let result;
        if (id) {
            if (!UUID_RE.test(id)) return;
            result = await db.from('wishlists').update({ name, description: description || null, visibility }).eq('id', id);
        } else {
            result = await db.from('wishlists').insert({
                name,
                description: description || `Lista criada em ${new Date().toLocaleDateString('pt-BR')}`,
                user_name: State.displayName || null,
                visibility
            });
        }
        if (result.error) {
            console.error(result.error);
            toast(errorText(result.error, id ? 'Erro ao salvar a lista.' : 'Erro ao criar a lista.'));
            return;
        }
        closeModal($('#list-modal'));
        toast(id ? 'Lista atualizada!' : 'Lista criada com sucesso!');
        await loadAll({ silent: true });
    });
}

/* Item */

function openItemModal(listId, itemId) {
    if (!UUID_RE.test(listId)) return;
    const list = State.lists.find((l) => l.id === listId);
    const item = itemId && list ? (list.items || []).find((i) => i.id === itemId) : null;

    openModal($('#item-modal'), '#item-name');
    $('#item-modal-title').textContent = item ? 'Editar Item' : 'Adicionar Novo Item';
    $('#item-submit').textContent = item ? 'Salvar' : 'Adicionar';
    $('#target-list-id').value = listId;
    $('#item-id').value = item ? item.id : '';
    $('#item-name').value = item ? item.name : '';
    $('#item-desc').value = item ? (item.description || '') : '';
    $('#item-price').value = item && item.price !== null && item.price !== undefined
        ? Number(item.price).toFixed(2).replace('.', ',')
        : '';
    $('#item-emoji').value = item ? (item.emoji || '') : '';
    $('#item-link').value = item ? (item.link || '') : '';
}

function onItemSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const listId = $('#target-list-id').value;
    const itemId = $('#item-id').value;
    const name = $('#item-name').value.trim();
    if (!UUID_RE.test(listId)) return;
    if (!name) {
        toast('Por favor, insira um nome para o item');
        return;
    }

    let price = null;
    const rawPrice = $('#item-price').value.trim();
    if (rawPrice !== '') {
        price = parsePrice(rawPrice);
        if (price === null || price > MAX_PRICE) {
            toast('Preço inválido. Exemplo: 299,90');
            return;
        }
    }

    let link = null;
    const rawLink = $('#item-link').value.trim();
    if (rawLink) {
        link = safeUrl(rawLink);
        if (!link) {
            toast('Link inválido. Use um endereço http(s).');
            return;
        }
    }

    const fields = {
        name,
        description: $('#item-desc').value.trim() || null,
        price,
        emoji: firstEmoji($('#item-emoji').value) || '🎁',
        link
    };

    withBusy(form, async () => {
        let result;
        if (itemId) {
            if (!UUID_RE.test(itemId)) return;
            result = await db.from('items').update(fields).eq('id', itemId);
        } else {
            result = await db.from('items').insert({ wishlist_id: listId, ...fields });
        }
        if (result.error) {
            console.error(result.error);
            toast(errorText(result.error, itemId ? 'Erro ao salvar o item.' : 'Erro ao adicionar o item.'));
            return;
        }
        closeModal($('#item-modal'));
        if (!itemId) {
            clearSearch();
            State.page = 9999; // vai para a última página, onde o item novo aparece
        }
        toast(itemId ? 'Item atualizado!' : 'Item adicionado com sucesso!');
        await loadAll({ silent: true });
    });
}

/* Configurações, exportar, importar e excluir tudo */

function openSettings() {
    openModal($('#settings-modal'), '#settings-name');
    $('#settings-email').value = State.email;
    $('#settings-name').value = State.displayName;
}

function onSettingsSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = $('#settings-name').value.trim().slice(0, 50);
    if (!name) {
        toast('Por favor, insira um nome');
        return;
    }

    withBusy(form, async () => {
        const { error } = await db.auth.updateUser({ data: { display_name: name } });
        if (error) {
            console.error(error);
            toast('Não foi possível salvar o nome.');
            return;
        }
        State.displayName = name;
        lsSet(USER_NAME_KEY, name);
        updateChrome();
        closeModal($('#settings-modal'));
        toast('Configurações salvas!');
    });
}

function buildBackup() {
    return {
        app: 'lista-de-presentes',
        version: 5,
        userName: State.displayName,
        exportedAt: new Date().toISOString(),
        wishLists: State.lists.filter(isMine).map((list) => ({
            name: list.name,
            description: list.description || '',
            visibility: list.visibility === 'private' ? 'private' : 'public',
            createdAt: list.created_at,
            items: (list.items || []).map((item) => ({
                name: item.name,
                description: item.description || '',
                price: formatPrice(item.price),
                status: STATUS_TO_BACKUP[item.status] || 'available',
                image: item.emoji || '🎁',
                link: item.link || '',
                createdAt: item.created_at
            }))
        }))
    };
}

async function exportData() {
    try {
        await fetchOwn();
        const blob = new Blob([JSON.stringify(buildBackup(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `lista-de-presentes-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Dados exportados com sucesso!');
    } catch (error) {
        console.error('Erro ao exportar:', error);
        toast('Erro ao exportar dados.');
    }
}

function normalizeImportItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim().slice(0, 100);
    if (!name) return null;
    const price = parsePrice(raw.price);
    const link = safeUrl(raw.link);
    return {
        name,
        description: String(raw.description ?? '').trim().slice(0, 300) || null,
        price: price !== null && price <= MAX_PRICE ? price : null,
        emoji: firstEmoji(raw.image ?? raw.emoji) || '🎁',
        link: link && link.length <= 2000 ? link : null,
        status: STATUS_FROM_BACKUP[String(raw.status ?? '').toLowerCase()] || (STATUS_LABELS[raw.status] ? raw.status : 'Available')
    };
}

function normalizeImport(data) {
    const raw = Array.isArray(data) ? data : data && data.wishLists;
    if (!Array.isArray(raw)) throw new Error('Formato inválido');

    return raw.map((list) => {
        if (!list || typeof list !== 'object') return null;
        const name = String(list.name ?? '').trim().slice(0, 100);
        if (!name) return null;
        const items = (Array.isArray(list.items) ? list.items : []).slice(0, MAX_ITEMS).map(normalizeImportItem).filter(Boolean);
        const visibility = String(list.visibility ?? '').toLowerCase() === 'private' ? 'private' : 'public';
        return { name, description: String(list.description ?? '').trim().slice(0, 500) || null, visibility, items };
    }).filter(Boolean);
}

async function runImport(lists) {
    let createdLists = 0;
    let createdItems = 0;

    for (const list of lists) {
        const id = uuid();
        const { error } = await db.from('wishlists').insert({
            id,
            name: list.name,
            description: list.description,
            user_name: State.displayName || null,
            visibility: list.visibility
        });
        if (error) {
            toast(errorText(error, 'Erro ao importar. Parte dos dados pode não ter sido importada.'), 6000);
            break;
        }

        let failed = false;
        for (let i = 0; i < list.items.length; i += 200) {
            const rows = list.items.slice(i, i + 200).map((item) => ({ wishlist_id: id, ...item }));
            const { error: itemError } = await db.from('items').insert(rows);
            if (itemError) {
                failed = true;
                await db.from('wishlists').delete().eq('id', id);
                toast(errorText(itemError, `Erro ao importar a lista "${list.name}". Ela foi ignorada.`), 6000);
                break;
            }
        }
        if (failed) break;
        createdLists += 1;
        createdItems += list.items.length;
    }
    return { createdLists, createdItems };
}

async function handleImportFile(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    if (file.size > MAX_IMPORT_BYTES) {
        toast('Arquivo grande demais (máx. 5 MB).');
        return;
    }

    let lists;
    try {
        lists = normalizeImport(JSON.parse(await file.text()));
    } catch (error) {
        console.error('Erro ao ler backup:', error);
        toast('Arquivo inválido. Use um backup em JSON.');
        return;
    }

    if (!lists.length) {
        toast('Nenhuma lista encontrada no arquivo.');
        return;
    }
    const itemTotal = lists.reduce((acc, l) => acc + l.items.length, 0);
    if (!confirm(`Importar ${lists.length} lista(s) com ${itemTotal} item(ns)? Elas serão adicionadas às suas listas atuais.`)) return;

    toast('Importando...', 10000);
    try {
        const { createdLists, createdItems } = await runImport(lists);
        if (createdLists) toast(`Importação concluída: ${createdLists} lista(s) e ${createdItems} item(ns).`, 5000);
    } catch (error) {
        console.error('Erro ao importar:', error);
        toast('Erro ao importar. Verifique sua conexão.');
    }
    await loadAll({ silent: true });
}

async function resetData() {
    if (!confirm('ATENÇÃO: Isto vai excluir TODAS as suas listas e itens. Deseja continuar?')) return;
    if (!confirm('Tem certeza? Esta ação não pode ser desfeita!')) return;

    const { error } = await db.from('wishlists').delete().eq('owner_id', State.userId).then((r) => r, (e) => ({ error: e }));
    if (error) {
        console.error(error);
        toast('Erro ao excluir os dados.');
        return;
    }
    State.selectedListId = null;
    closeModal($('#settings-modal'));
    toast('Todas as listas foram excluídas.');
    await loadAll({ silent: true });
}

/* ---------- Eventos ---------- */

const ACTIONS = {
    'sync': () => loadAll(),
    'install': () => installApp(),
    'home': () => goHome(),
    'open-settings': () => openSettings(),
    'logout': () => logout(),
    'auth-tab': (el) => setAuthMode(el.dataset.mode === 'signup' ? 'signup' : 'signin'),
    'forgot-password': () => forgotPassword(),
    'back-to-login': () => backToLogin(),
    'close-modal': (el) => closeModal(el.closest('.modal')),
    'open-list': (el) => openList(el.dataset.id),
    'open-list-modal': () => openListModal(),
    'edit-list': (el) => openListModal(el.dataset.id),
    'share-list': (el) => shareList(el.dataset.id),
    'rotate-link': (el) => rotateLink(el.dataset.id),
    'go-login': () => { location.href = redirectUrl(); },
    'admin-logo': () => onAdminLogoClick(),
    'admin-close': () => closeAdminPanel(),
    'admin-exit': () => disableAdminMode(),
    'admin-refresh': () => adminLoad(),
    'admin-toggle-setting': (el) => adminToggleSetting(el.dataset.key),
    'admin-tab': (el) => setAdminTab(el.dataset.tab),
    'admin-user-sessions': (el) => adminShowUser(el.dataset.id, 'sessions'),
    'admin-user-activity': (el) => adminShowUser(el.dataset.id, 'activity'),
    'delete-list': (el) => deleteList(el.dataset.id),
    'open-item-modal': (el) => openItemModal(el.dataset.id),
    'edit-item': (el) => openItemModal(State.selectedListId, el.dataset.id),
    'delete-item': (el) => deleteItem(el.dataset.id),
    'set-status': (el) => updateStatus(el),
    'prev-page': () => { State.page = Math.max(1, State.page - 1); renderListView(); window.scrollTo(0, 0); },
    'next-page': () => { State.page += 1; renderListView(); window.scrollTo(0, 0); },
    'export-data': () => exportData(),
    'import-data': () => $('#import-file').click(),
    'reset-data': () => resetData()
};

function onClick(event) {
    if (event.target.classList && event.target.classList.contains('modal')) {
        closeModal(event.target);
        return;
    }
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (Object.prototype.hasOwnProperty.call(ACTIONS, action)) ACTIONS[action](el);
}

function onChange(event) {
    const el = event.target;
    if (el.id === 'admin-user-filter') {
        State.admin.user = el.value;
        adminLoad();
    } else if (el.id === 'admin-action-filter') {
        State.admin.action = el.value;
        adminLoad();
    }
}

function onKeydown(event) {
    if (event.key === 'Escape') {
        const open = document.querySelector('.modal.open');
        if (open) closeModal(open);
        return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches && event.target.matches('.card-clickable')) {
        event.preventDefault();
        openList(event.target.dataset.id);
    }
}

function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('popstate', onPopState);
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#recovery-form').addEventListener('submit', onRecoverySubmit);
    $('#list-form').addEventListener('submit', onListSubmit);
    $('#item-form').addEventListener('submit', onItemSubmit);
    $('#settings-form').addEventListener('submit', onSettingsSubmit);
    $('#import-file').addEventListener('change', handleImportFile);
    $('#search-input').addEventListener('input', (event) => {
        const value = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            State.searchTerm = value.trim().toLowerCase();
            State.page = 1;
            if (State.loaded) render();
        }, 300);
    });
}

/* ---------- Inicialização ---------- */

function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Service Worker:', error));
    }
}

function readToken() {
    const raw = new URLSearchParams(location.search).get('list');
    if (raw === null) return { raw: null, token: null };
    return { raw, token: UUID_RE.test(raw) ? raw.toLowerCase() : null };
}

async function init() {
    registerServiceWorker();
    bindEvents();
    setupInstall();
    setAuthMode('signin');

    const { raw, token } = readToken();
    State.token = token;

    if (raw !== null && !token) {
        showMessage('Link de lista inválido.');
        return;
    }
    if (!db) {
        showMessage('Configure SUPABASE_URL e SUPABASE_ANON_KEY em supabase-config.js.');
        return;
    }

    await loadSettings();
    applySignupsUi();

    if (RECOVERY_LINK && !State.token) {
        State.recovering = true;
        setView('recovery');
        updateChrome();
    }
    if (AUTH_LINK_ERROR && !State.token) authMsg('Link inválido ou expirado. Entre ou peça um novo link.');

    db.auth.onAuthStateChange((event, session) => {
        // setTimeout evita travar a biblioteca ao chamar o Supabase dentro do callback
        setTimeout(() => onAuthEvent(event, session), 0);
    });

    let session = null;
    try {
        const { data } = await db.auth.getSession();
        session = data ? data.session : null;
    } catch (error) {
        console.error('Erro ao ler sessão:', error);
    }

    if (State.token) {
        // Logado: abre a lista dentro do app (todas as listas ficam visíveis para quem tem conta)
        if (session) {
            await openFromToken(session);
            return;
        }
        if (!State.settings.guest_access) {
            setView('app');
            updateChrome();
            $('#lists-container').innerHTML = UI.renderMessage(
                'O acesso por link está desativado. Entre com a sua conta para ver as listas.',
                '<button type="button" class="btn btn-primary" data-action="go-login">Entrar</button>'
            );
            return;
        }
        setView('app');
        updateChrome();
        await onSession(session);
        await loadAll();
        startLive();
        return;
    }

    await onSession(session);
}

document.addEventListener('DOMContentLoaded', init);
