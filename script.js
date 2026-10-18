'use strict';

const STATUS_LABELS = { Available: 'Disponível', Reserved: 'Reservado', Purchased: 'Comprado' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_NAME_KEY = 'gl_user_name';
const POLL_MS = 15000;
const MAX_PRICE = 99999999.99;
const MIN_PASSWORD = 8;
const LOADING_HTML = '<div class="loading"><div class="spinner"></div><p>Carregando suas listas...</p></div>';

// Gerenciador de Estado
const State = {
    lists: [],
    shared: null,
    token: null,
    searchTerm: '',
    channel: null,
    pollTimer: null,
    liveBound: false,
    loaded: false,
    userId: null,
    email: '',
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

function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    if (!isFinite(n)) return '';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignora */ }
}

function icons() {
    if (window.lucide) window.lucide.createIcons();
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

function setSyncing(on) {
    const btn = $('#sync-btn');
    if (btn) btn.classList.toggle('syncing', on);
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

/* ---------- Telas e controles do cabeçalho ---------- */

function setView(name) {
    $('#auth-view').hidden = name !== 'auth';
    $('#recovery-view').hidden = name !== 'recovery';
    $('#lists-container').hidden = name !== 'app';
}

function updateChrome() {
    const guest = !!State.token;
    const loggedIn = !!State.userId;
    const inApp = !State.recovering && (guest || loggedIn);
    const setHidden = (sel, hidden) => {
        const el = $(sel);
        if (el) el.hidden = hidden;
    };

    setHidden('#sync-btn', !inApp);
    setHidden('#search-bar', !inApp);
    setHidden('#add-list-btn', !(loggedIn && !guest && !State.recovering));
    setHidden('#logout-btn', !loggedIn);
    setHidden('#user-email', !loggedIn);
    setHidden('#install-btn', !(State.installPrompt || State.iosInstall));
    const emailEl = $('#user-email');
    if (emailEl) emailEl.textContent = State.email || '';
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

/* ---------- UI Components ---------- */

const UI = {
    renderItem(item, isOwner) {
        const status = STATUS_LABELS[item.status] ? item.status : 'Available';
        const meta = [item.description, formatPrice(item.price)].filter(Boolean).map(esc).join(' • ');
        const link = safeUrl(item.link);

        return `
            <div class="item-row" id="item-${esc(item.id)}">
                <div class="item-main">
                    <span class="item-emoji">${esc(item.emoji || '🎁')}</span>
                    <div class="item-details">
                        <h3>${esc(item.name)}</h3>
                        ${meta ? `<p>${meta}</p>` : ''}
                        ${link ? `<a class="item-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver produto</a>` : ''}
                    </div>
                </div>
                <div class="item-status">
                    <select class="status-badge status-${status.toLowerCase()}" data-action="status" data-id="${esc(item.id)}" data-current="${status}" aria-label="Status de ${esc(item.name)}">
                        ${Object.entries(STATUS_LABELS).map(([value, label]) =>
                            `<option value="${value}"${value === status ? ' selected' : ''}>${label}</option>`
                        ).join('')}
                    </select>
                    ${isOwner ? `
                        <button type="button" class="action-btn" data-action="delete-item" data-id="${esc(item.id)}" title="Excluir item" aria-label="Excluir ${esc(item.name)}">
                            <i data-lucide="x"></i>
                        </button>
                    ` : ''}
                </div>
            </div>`;
    },

    renderListCard(list, isOwner) {
        const itemsHtml = (list.items || []).map((item) => UI.renderItem(item, isOwner)).join('');
        return `
            <div class="wishlist-card" id="list-${esc(list.id)}">
                <div class="list-header">
                    <div class="list-info">
                        <h2>${esc(list.name)}</h2>
                        <p>Criado por: ${esc(list.user_name || 'Anônimo')}</p>
                    </div>
                    ${isOwner ? `
                        <div class="list-actions">
                            <button type="button" class="action-btn" data-action="share-list" data-id="${esc(list.id)}" title="Compartilhar" aria-label="Compartilhar lista ${esc(list.name)}"><i data-lucide="share-2"></i></button>
                            <button type="button" class="action-btn" data-action="delete-list" data-id="${esc(list.id)}" title="Excluir lista" aria-label="Excluir lista ${esc(list.name)}"><i data-lucide="trash-2"></i></button>
                        </div>
                    ` : ''}
                </div>
                <div class="items-list">${itemsHtml || '<p class="muted">Nenhum item ainda.</p>'}</div>
                ${isOwner ? `
                    <button type="button" class="btn-primary btn-block" data-action="open-item-modal" data-id="${esc(list.id)}">
                        <i data-lucide="plus"></i> Adicionar Item
                    </button>
                ` : ''}
            </div>`;
    },

    renderMessage(text) {
        return `<div class="empty-state"><p>${esc(text)}</p></div>`;
    }
};

function visibleLists() {
    const lists = State.token ? (State.shared ? [State.shared] : []) : State.lists;
    const term = State.searchTerm;
    if (!term) return lists;
    return lists.filter((list) =>
        list.name.toLowerCase().includes(term) ||
        (list.items || []).some((item) =>
            item.name.toLowerCase().includes(term) ||
            (item.description || '').toLowerCase().includes(term))
    );
}

function render() {
    const isOwner = !State.token;
    const lists = visibleLists();
    let html = '';

    if (State.token) {
        html += `
            <div class="shared-banner">
                <i data-lucide="users"></i>
                <span>Lista compartilhada. Você pode reservar ou marcar itens como comprados.</span>
                <a href="${esc(location.pathname)}">Minhas listas</a>
            </div>`;
    }

    if (lists.length) {
        html += lists.map((list) => UI.renderListCard(list, isOwner)).join('');
    } else if (State.token && !State.shared) {
        html += UI.renderMessage('Lista não encontrada. Confira o link com quem compartilhou.');
    } else if (State.searchTerm) {
        html += UI.renderMessage('Nenhum resultado para a busca.');
    } else {
        html += UI.renderMessage('Você ainda não tem listas. Clique em "Nova Lista" para começar.');
    }

    $('#lists-container').innerHTML = html;
    icons();
}

/* ---------- Autenticação ---------- */

function authErrorText(error) {
    const code = error && error.code;
    const msg = String((error && error.message) || '').toLowerCase();

    if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
    if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar (veja a caixa de entrada e o spam).';
    if (code === 'user_already_exists' || msg.includes('already registered')) return 'Este e-mail já tem conta. Entre ou recupere a senha.';
    if (code === 'weak_password' || msg.includes('password should')) return `Senha fraca. Use pelo menos ${MIN_PASSWORD} caracteres.`;
    if (code === 'signup_disabled') return 'O cadastro está desativado neste projeto.';
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

    $('#auth-password2-group').hidden = !signup;
    $('#auth-password2').required = signup;
    $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = signup ? 'Criar conta' : 'Entrar';
    $('#forgot-btn').hidden = signup;
    authMsg('');
}

async function onSession(session) {
    if (State.recovering) return;

    const key = session ? session.user.id : 'none';
    if (key === State.sessionKey) return;
    State.sessionKey = key;
    State.userId = session ? session.user.id : null;
    State.email = session ? (session.user.email || '') : '';

    // Convidado (link compartilhado): não precisa de conta, só atualiza o cabeçalho
    if (State.token) {
        updateChrome();
        return;
    }

    if (!session) {
        stopLive();
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
    await loadAll();
    startLive();
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

            const { data, error } = await db.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: redirectUrl() }
            });
            if (error) return authMsg(authErrorText(error));

            // E-mail já cadastrado: o Supabase devolve um usuário "vazio" para não revelar a conta
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                return authMsg('Este e-mail já tem conta. Entre ou recupere a senha.');
            }
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
        .select('id, name, user_name, share_token, created_at, items(id, name, description, price, emoji, link, status, created_at)')
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

function isSelectActive() {
    const el = document.activeElement;
    return !!(el && el.tagName === 'SELECT' && !el.disabled && el.closest('#lists-container'));
}

async function loadAll({ silent = false, force = false } = {}) {
    if (!State.token && !State.userId) return;

    // Não troca o DOM enquanto o usuário está com um seletor de status aberto
    if (silent && !force && isSelectActive()) {
        scheduleReload();
        return;
    }
    if (loading) {
        pendingReload = true;
        return;
    }
    loading = true;
    setSyncing(true);

    try {
        if (State.token) await fetchShared();
        else await fetchOwn();
        State.loaded = true;
        render();
    } catch (error) {
        console.error('Erro ao carregar:', error);
        if (!State.loaded) {
            $('#lists-container').innerHTML = UI.renderMessage('Não foi possível carregar os dados. Verifique a conexão e tente sincronizar novamente.');
        } else if (!silent) {
            toast('Não foi possível sincronizar. Verifique sua conexão.');
        }
    } finally {
        loading = false;
        setSyncing(false);
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
    if (State.channel) {
        try { db.removeChannel(State.channel); } catch (error) { console.warn(error); }
        State.channel = null;
    }
}

function startLive() {
    stopLive();

    if (State.token) {
        // Convidados não têm acesso às tabelas (RLS), então atualizam por polling
        State.pollTimer = setInterval(() => { if (!document.hidden) loadAll({ silent: true }); }, POLL_MS);
    } else {
        State.channel = db.channel('giftlist-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, scheduleReload)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'wishlists' }, scheduleReload)
            .subscribe();
    }

    if (!State.liveBound) {
        State.liveBound = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) loadAll({ silent: true });
        });
        window.addEventListener('online', () => loadAll({ silent: true }));
    }
}

/* ---------- Ações ---------- */

async function updateStatus(select) {
    const id = select.dataset.id;
    const expected = select.dataset.current;
    const next = select.value;
    if (!UUID_RE.test(id) || !STATUS_LABELS[next] || next === expected) return;

    select.disabled = true;
    let saved = false;
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
            saved = true;
        }
    } catch (error) {
        console.error(error);
        toast('Sem conexão. O status não foi alterado.');
    }

    if (!saved) select.value = expected;
    select.disabled = false;
    select.blur();
    await loadAll({ silent: true, force: true });
}

async function deleteItem(id) {
    if (!UUID_RE.test(id) || !confirm('Excluir este item?')) return;
    const { error } = await db.from('items').delete().eq('id', id).then((r) => r, (e) => ({ error: e }));
    if (error) {
        console.error(error);
        toast('Erro ao excluir o item.');
        return;
    }
    toast('Item removido!');
    await loadAll({ silent: true });
}

async function deleteList(id) {
    const list = State.lists.find((l) => l.id === id);
    if (!list) return;
    if (!confirm(`Excluir a lista "${list.name}" e todos os seus itens?`)) return;

    const { error } = await db.from('wishlists').delete().eq('id', id).then((r) => r, (e) => ({ error: e }));
    if (error) {
        console.error(error);
        toast('Erro ao excluir a lista.');
        return;
    }
    toast('Lista excluída!');
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

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
            toast('Link copiado!');
            return;
        }
    } catch { /* cai no fallback */ }

    window.prompt('Copie o link da lista:', url);
}

/* ---------- Modais e formulários ---------- */

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

function openListModal() {
    openModal($('#list-modal'), '#list-name');
    $('#user-name').value = lsGet(USER_NAME_KEY) || '';
}

function openItemModal(listId) {
    if (!UUID_RE.test(listId)) return;
    openModal($('#item-modal'), '#item-name');
    $('#target-list-id').value = listId;
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

function onListSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = $('#list-name').value.trim();
    const userName = $('#user-name').value.trim();
    if (!name) return;

    withBusy(form, async () => {
        const { error } = await db.from('wishlists').insert({ name, user_name: userName || null });
        if (error) {
            console.error(error);
            toast(errorText(error, 'Erro ao criar a lista.'));
            return;
        }
        lsSet(USER_NAME_KEY, userName);
        closeModal($('#list-modal'));
        toast('Lista criada!');
        await loadAll({ silent: true });
    });
}

function onItemSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const listId = $('#target-list-id').value;
    const name = $('#item-name').value.trim();
    if (!UUID_RE.test(listId) || !name) return;

    let price = null;
    const rawPrice = $('#item-price').value;
    if (rawPrice !== '') {
        price = Number(rawPrice);
        if (!isFinite(price) || price < 0 || price > MAX_PRICE) {
            toast('Preço inválido.');
            return;
        }
        price = Math.round(price * 100) / 100;
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

    const payload = {
        wishlist_id: listId,
        name,
        description: $('#item-desc').value.trim() || null,
        price,
        emoji: firstEmoji($('#item-emoji').value) || '🎁',
        link
    };

    withBusy(form, async () => {
        const { error } = await db.from('items').insert(payload);
        if (error) {
            console.error(error);
            toast(errorText(error, 'Erro ao adicionar o item.'));
            return;
        }
        closeModal($('#item-modal'));
        toast('Item adicionado!');
        await loadAll({ silent: true });
    });
}

/* ---------- Eventos ---------- */

const ACTIONS = {
    'sync': () => loadAll({ force: true }),
    'install': () => installApp(),
    'logout': () => logout(),
    'auth-tab': (el) => setAuthMode(el.dataset.mode === 'signup' ? 'signup' : 'signin'),
    'forgot-password': () => forgotPassword(),
    'back-to-login': () => backToLogin(),
    'open-list-modal': () => openListModal(),
    'close-modal': (el) => closeModal(el.closest('.modal')),
    'open-item-modal': (el) => openItemModal(el.dataset.id),
    'share-list': (el) => shareList(el.dataset.id),
    'delete-list': (el) => deleteList(el.dataset.id),
    'delete-item': (el) => deleteItem(el.dataset.id)
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
    if (el.matches && el.matches('select[data-action="status"]')) updateStatus(el);
}

function onKeydown(event) {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('.modal.open');
    if (open) closeModal(open);
}

function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#recovery-form').addEventListener('submit', onRecoverySubmit);
    $('#list-form').addEventListener('submit', onListSubmit);
    $('#item-form').addEventListener('submit', onItemSubmit);
    $('#search-input').addEventListener('input', (event) => {
        const value = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            State.searchTerm = value.trim().toLowerCase();
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
    icons();

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

    if (State.token) $('#app-title').textContent = 'Lista Compartilhada';
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
