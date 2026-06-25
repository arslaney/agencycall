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
      // admin "Görüşmelerim" için sadece_benim=true gönderir → kendi kayıtları
      const sadeceBenim = (payload || {}).sadece_benim === true;
      const filter = (isAdmin && !sadeceBenim) ? '' : `&uw_id=eq.${encodeURIComponent(uw_id)}`;
      const rows = await sb(
        `acente_gorusmeler_kio?select=*,acente_uw(ad)${filter}&order=tarih.asc`
      );
      const mapped = rows.map(r => ({
        id: r.id, uw_id: r.uw_id, uw_ad: r.acente_uw?.ad || r.uw_id,
        tarih: r.tarih, ay: r.ay, yil: r.yil, bolge: r.bolge,
        acente: r.acente, kisi: r.kisi, akis: r.akis_no, tur: r.tur,
        konu: r.konu, sonuc: r.sonuc,
        durum: r.durum || 'Görüşüldü', prim: r.prim,
        secili_kio_kod: r.secili_kio_kod,
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

    // --- BÖLGEYE GÖRE KİO ACENTELERİ (form açılır liste için) ---
    if (action === 'kio_bolge') {
      const bolge = (payload || {}).bolge || '';
      let q = 'acente_kio?select=kod,ad,il,sompo_bolge,hangi_brans&order=ad.asc';
      if (bolge) q += `&sompo_bolge=eq.${encodeURIComponent(bolge)}`;
      const list = await sb(q);
      return res.json({ kio: list });
    }
    if (action === 'hedef_benim') {
      const p = payload || {};
      const yil = p.yil || new Date().getFullYear();
      const ay = p.ay || (new Date().getMonth() + 1);
      const h = await sb(`acente_hedef?select=hedef&uw_id=eq.${encodeURIComponent(uw_id)}&yil=eq.${yil}&ay=eq.${ay}`);
      const g = await sb(`acente_gorusmeler?select=id&uw_id=eq.${encodeURIComponent(uw_id)}&yil=eq.${yil}&ay=eq.${ay}`);
      return res.json({ yil, ay, hedef: (h[0]?.hedef) || 0, gerceklesen: g.length });
    }

    // --- HEDEFLERİ GETİR ---
    if (action === 'hedef_list') {
      const p = payload || {};
      const yil = p.yil || new Date().getFullYear();
      const ay = p.ay || (new Date().getMonth() + 1);
      // tüm UW'ler + bu ay hedefi + bu ay gerçekleşen
      const users = await sb('acente_uw?select=id,ad,rol&aktif=eq.true&order=ad.asc');
      const hedefler = await sb(`acente_hedef?select=uw_id,hedef&yil=eq.${yil}&ay=eq.${ay}`);
      const hedefMap = {}; hedefler.forEach(h => hedefMap[h.uw_id] = h.hedef);
      // bu ay gerçekleşen görüşmeler (uw bazlı)
      const gor = await sb(`acente_gorusmeler?select=uw_id&yil=eq.${yil}&ay=eq.${ay}`);
      const gMap = {}; gor.forEach(g => gMap[g.uw_id] = (gMap[g.uw_id] || 0) + 1);
      const liste = users.map(u => ({
        uw_id: u.id, ad: u.ad, rol: u.rol,
        hedef: hedefMap[u.id] || 0,
        gerceklesen: gMap[u.id] || 0
      }));
      return res.json({ yil, ay, liste });
    }

    // --- HEDEF KAYDET (admin) ---
    if (action === 'hedef_set') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin hedef belirleyebilir' });
      const p = payload || {};
      const yil = p.yil, ay = p.ay, hedefUw = p.uw_id_hedef, hedef = parseInt(p.hedef, 10) || 0;
      if (!yil || !ay || !hedefUw) return res.status(400).json({ error: 'Eksik bilgi' });
      await sb('acente_hedef', {
        method: 'POST',
        body: JSON.stringify({ uw_id: hedefUw, yil, ay, hedef }),
        prefer: 'resolution=merge-duplicates,return=minimal',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
      });
      return res.json({ ok: true });
    }

    // --- AI YÖNETSEL ÖZET (admin) ---
    if (action === 'ai_ozet') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY tanımlı değil' });
      // veriyi topla
      const rows = await sb('acente_gorusmeler_kio?select=uw_id,tarih,ay,bolge,acente,tur,durum,prim,kio_mu,acente_uw(ad)&order=tarih.desc&limit=500');
      const kioAll = await sb('acente_kio?select=kod');
      // özet istatistik çıkar (token tasarrufu için ham değil özet gönderiyoruz)
      const stat = { toplam: rows.length, uw: {}, ay: {}, bolge: {}, durum: {}, kio: 0, dis: 0, prim: 0, acente: {} };
      rows.forEach(r => {
        const uw = r.acente_uw?.ad || r.uw_id;
        stat.uw[uw] = (stat.uw[uw] || 0) + 1;
        if (r.ay) stat.ay[r.ay] = (stat.ay[r.ay] || 0) + 1;
        if (r.bolge) stat.bolge[r.bolge] = (stat.bolge[r.bolge] || 0) + 1;
        if (r.durum) stat.durum[r.durum] = (stat.durum[r.durum] || 0) + 1;
        if (r.acente) stat.acente[r.acente] = (stat.acente[r.acente] || 0) + 1;
        if (r.kio_mu) stat.kio++; else stat.dis++;
        if (r.durum === 'Poliçe Bağlandı') stat.prim += Number(r.prim) || 0;
      });
      const kioArananKod = new Set(rows.filter(r => r.kio_mu && r.kio_kod).map(r => r.kio_kod));
      const topAcente = Object.entries(stat.acente).sort((a,b)=>b[1]-a[1]).slice(0,8);
      const AYLAR = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
      const ayStr = Object.entries(stat.ay).sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${AYLAR[k]}: ${v}`).join(', ');

      const prompt = `Sen Sompo Sigorta Endüstriyel Riskler (Yangın) biriminde bir yönetici asistanısın. Aşağıda underwriter (UW) ekibinin acente arama/görüşme verilerinin özeti var. Bu veriye dayanarak Türkçe, kısa ve yönetsel bir değerlendirme yaz. Yöneticinin (Kıdemli Müdür) hızlıca okuyup aksiyon alabileceği netlikte olsun. Abartısız, veriye dayalı, samimi ama profesyonel.

VERİ ÖZETİ:
- Toplam görüşme: ${stat.toplam}
- KİO listesindeki acentelerle: ${stat.kio} · Liste dışı: ${stat.dis}
- Toplam KİO acente sayısı: ${kioAll.length} · Bunlardan arananlar: ${kioArananKod.size} (kapsama %${Math.round(kioArananKod.size/kioAll.length*100)})
- UW dağılımı: ${Object.entries(stat.uw).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}: ${v}`).join(', ')}
- Aylık dağılım: ${ayStr}
- Bölge dağılımı: ${Object.entries(stat.bolge).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}: ${v}`).join(', ')}
- Durum/aşama dağılımı: ${Object.entries(stat.durum).map(([k,v])=>`${k}: ${v}`).join(', ')}
- Bağlanan toplam prim: ${stat.prim.toLocaleString('tr-TR')} TL
- En aktif acenteler: ${topAcente.map(([k,v])=>`${k.split(' ')[0]} (${v})`).join(', ')}

İSTENEN ÇIKTI (madde başları halinde, toplam ~200 kelime):
1. Genel durum (1-2 cümle)
2. Öne çıkanlar (en aktif UW, momentum, güçlü taraflar)
3. Dikkat gerektirenler (KİO kapsama boşlukları, dönüşüm zayıflıkları, az aranan bölgeler)
4. Önerilen aksiyonlar (2-3 somut madde)

Sadece değerlendirmeyi yaz, başka açıklama ekleme.`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) return res.status(500).json({ error: 'AI hatası', detail: aiData });
      const text = (aiData.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      return res.json({ ok: true, ozet: text, meta: { toplam: stat.toplam, kapsama: Math.round(kioArananKod.size/kioAll.length*100) } });
    }

    // --- EKLE ---
    if (action === 'add') {
      const p = payload || {};
      if (!p.acente) return res.status(400).json({ error: 'Acente zorunlu' });
      const rec = {
        uw_id, // her zaman giriş yapan UW adına
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null,
        durum: p.durum || 'Görüşüldü', prim: (p.prim || p.prim === 0) ? p.prim : null,
        secili_kio_kod: p.secili_kio_kod || null
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
        konu: p.konu || null, sonuc: p.sonuc || null,
        durum: p.durum || 'Görüşüldü', prim: (p.prim || p.prim === 0) ? p.prim : null,
        secili_kio_kod: p.secili_kio_kod || null
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
      const pl = payload || {};
      const items = pl.items || [];
      // admin başka UW adına yükleyebilir; UW sadece kendi adına
      let hedefUw = uw_id;
      if (isAdmin && pl.hedef_uw) {
        const chk = await sb(`acente_uw?id=eq.${encodeURIComponent(pl.hedef_uw)}&select=id`);
        if (chk[0]) hedefUw = pl.hedef_uw;
      }
      const recs = items.filter(p => p.acente).map(p => ({
        uw_id: hedefUw,
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null
      }));
      if (!recs.length) return res.json({ ok: true, added: 0 });
      await sb('acente_gorusmeler', { method: 'POST', body: JSON.stringify(recs), prefer: 'return=minimal' });
      return res.json({ ok: true, added: recs.length, hedef: hedefUw });
    }

    return res.status(400).json({ error: 'Bilinmeyen aksiyon' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: 'Sunucu hatası', detail: e.data || String(e) });
  }
};
