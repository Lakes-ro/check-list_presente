// Configurações do Supabase
// Preencha com os dados de Project Settings > API (a anon/publishable key é pública por design;
// a segurança vem das políticas RLS do schema.sql).
const SUPABASE_URL = 'https://ywossdxnqhrhznglsvcr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3b3NzZHhucWhyaHpuZ2xzdmNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxOTIzMjcsImV4cCI6MjA4OTc2ODMyN30.q654hvqIXjT2qi5fsLKYLx_VwCkFRCHNdYqHBfN08Uo';

// Lido ANTES de criar o cliente: a biblioteca limpa o hash da URL ao processar links de e-mail
const URL_HASH = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const RECOVERY_LINK = URL_HASH.get('type') === 'recovery';
const AUTH_LINK_ERROR = URL_HASH.get('error_code') || URL_HASH.get('error') || '';

const CONFIG_OK =
    /^https:\/\//i.test(SUPABASE_URL) &&
    !SUPABASE_URL.startsWith('SUA_') &&
    SUPABASE_ANON_KEY.length > 40 &&
    !SUPABASE_ANON_KEY.startsWith('SUA_');

// Usa "db" (e não "supabase") para não colidir com a variável global da biblioteca CDN
const db = CONFIG_OK && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
    : null;
