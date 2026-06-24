// api/db.js — Acente Aramaları serverless bridge (Vercel)
// Güvenlik bu katmanda: service_role key sadece sunucuda, şifre ve rol kontrolü burada.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || '1234'; // ortak basit şifre

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) throw { status: res.status, data };
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, password, uw_id, payload } = body || {};

  try {
    // --- LOGIN ---
    if (action === 'login') {
      if (password !== APP_PASSWORD) return res.status(401).json({ error: 'Şifre hatalı' });
      const users = await sb('acente_uw?select=id,ad,unvan,rol,aktif&order=rol.desc,ad.asc');
      const me = users.find(u => u.id === uw_id && u.aktif);
      if (!me) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      return res.json({ ok: true, user: me });
    }

    // Diğer tüm aksiyonlar şifre ister
    if (password !== APP_PASSWORD) return res.status(401).json({ error: 'Yetkisiz' });

    // kullanıcının rolünü doğrula
    const meRows = await sb(`acente_uw?id=eq.${encodeURIComponent(uw_id)}&select=id,rol,aktif`);
    const me = meRows[0];
    if (!me || !me.aktif) return res.status(403).json({ error: 'Geçersiz kullanıcı' });
    const isAdmin = me.rol === 'admin';

    // --- KULLANICI LİSTESİ ---
    if (action === 'users') {
      const users = await sb('acente_uw?select=id,ad,unvan,rol,aktif&order=rol.desc,ad.asc');
      return res.json({ users });
    }

    // --- GÖRÜŞMELERİ LİSTELE ---
    if (action === 'list') {
      // admin = hepsi, uw = sadece kendi. KİO bilgisi view'dan gelir.
      const filter = isAdmin ? '' : `&uw_id=eq.${encodeURIComponent(uw_id)}`;
      const rows = await sb(
        `acente_gorusmeler_kio?select=*,acente_uw(ad)${filter}&order=tarih.asc`
      );
      const mapped = rows.map(r => ({
        id: r.id, uw_id: r.uw_id, uw_ad: r.acente_uw?.ad || r.uw_id,
        tarih: r.tarih, ay: r.ay, yil: r.yil, bolge: r.bolge,
        acente: r.acente, kisi: r.kisi, akis: r.akis_no, tur: r.tur,
        konu: r.konu, sonuc: r.sonuc,
        kio_mu: r.kio_mu === true, kio_kod: r.kio_kod, kio_ad: r.kio_ad, kio_brans: r.kio_brans
      }));
      return res.json({ rows: mapped, isAdmin });
    }

    // --- KİO ACENTE LİSTESİ + ARANMA DURUMU ---
    if (action === 'kio_durum') {
      // tüm KİO acenteleri
      const kio = await sb('acente_kio?select=kod,ad,il,sompo_bolge,hangi_brans,kac_brans&order=ad.asc');
      // hangi KİO kodları görüşülmüş (view üzerinden)
      const gor = await sb('acente_gorusmeler_kio?select=kio_kod,tarih,uw_id&kio_kod=not.is.null');
      const arananKod = {};
      gor.forEach(g => {
        if (!g.kio_kod) return;
        if (!arananKod[g.kio_kod]) arananKod[g.kio_kod] = { sayi: 0, son: null };
        arananKod[g.kio_kod].sayi++;
        if (!arananKod[g.kio_kod].son || g.tarih > arananKod[g.kio_kod].son) arananKod[g.kio_kod].son = g.tarih;
      });
      const liste = kio.map(k => ({
        ...k,
        arandi: !!arananKod[k.kod],
        gorusme_sayisi: arananKod[k.kod]?.sayi || 0,
        son_gorusme: arananKod[k.kod]?.son || null
      }));
      // liste dışı aranan acenteler (KİO eşleşmeyen görüşmeler)
      const disRows = await sb('acente_gorusmeler_kio?select=acente,tarih&kio_kod=is.null');
      const disMap = {};
      disRows.forEach(r => {
        if (!disMap[r.acente]) disMap[r.acente] = { sayi: 0, son: null };
        disMap[r.acente].sayi++;
        if (!disMap[r.acente].son || r.tarih > disMap[r.acente].son) disMap[r.acente].son = r.tarih;
      });
      const disListe = Object.entries(disMap).map(([acente, v]) => ({ acente, gorusme_sayisi: v.sayi, son_gorusme: v.son }));
      return res.json({ kio: liste, dis: disListe });
    }

    // --- KİO MANUEL BAĞLAMA (admin) — bir acente adını bir KİO koduna eşle ---
    if (action === 'kio_baglama') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const p = payload || {};
      // ileride: acente takma adı tablosu. Şimdilik no-op placeholder.
      return res.json({ ok: true });
    }

    // --- EKLE ---
    if (action === 'add') {
      const p = payload || {};
      if (!p.acente) return res.status(400).json({ error: 'Acente zorunlu' });
      const rec = {
        uw_id, // her zaman giriş yapan UW adına
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null
      };
      const out = await sb('acente_gorusmeler', { method: 'POST', body: JSON.stringify(rec) });
      return res.json({ ok: true, row: out[0] });
    }

    // --- DÜZENLE (sadece kendi kaydı; admin de sadece kendi yetkisinde değil — kural: kendi kaydı) ---
    if (action === 'update') {
      const p = payload || {};
      const id = p.id;
      if (!id) return res.status(400).json({ error: 'id gerekli' });
      // kaydın sahibini doğrula
      const owner = await sb(`acente_gorusmeler?id=eq.${id}&select=uw_id`);
      if (!owner[0]) return res.status(404).json({ error: 'Kayıt yok' });
      if (owner[0].uw_id !== uw_id && !isAdmin) return res.status(403).json({ error: 'Sadece kendi kaydınızı düzenleyebilirsiniz' });
      const upd = {
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null
      };
      const out = await sb(`acente_gorusmeler?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(upd) });
      return res.json({ ok: true, row: out[0] });
    }

    // --- SİL (kendi kaydı; admin tümünü silebilir) ---
    if (action === 'delete') {
      const id = (payload || {}).id;
      if (!id) return res.status(400).json({ error: 'id gerekli' });
      const owner = await sb(`acente_gorusmeler?id=eq.${id}&select=uw_id`);
      if (!owner[0]) return res.status(404).json({ error: 'Kayıt yok' });
      if (owner[0].uw_id !== uw_id && !isAdmin) return res.status(403).json({ error: 'Sadece kendi kaydınızı silebilirsiniz' });
      await sb(`acente_gorusmeler?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      return res.json({ ok: true });
    }

    // --- TOPLU EKLE (Excel) ---
    if (action === 'bulk') {
      const items = (payload || {}).items || [];
      const recs = items.filter(p => p.acente).map(p => ({
        uw_id,
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null
      }));
      if (!recs.length) return res.json({ ok: true, added: 0 });
      await sb('acente_gorusmeler', { method: 'POST', body: JSON.stringify(recs), prefer: 'return=minimal' });
      return res.json({ ok: true, added: recs.length });
    }

    return res.status(400).json({ error: 'Bilinmeyen aksiyon' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: 'Sunucu hatası', detail: e.data || String(e) });
  }
};
