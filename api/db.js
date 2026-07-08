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

// Denetim kaydı yaz (hata olsa bile akışı bozma)
async function logKaydet(uwId, uwAd, islem, detay, kayitId) {
  try {
    await sb('acente_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ uw_id: uwId || null, uw_ad: uwAd || null, islem, detay: detay || null, kayit_id: kayitId || null })
    });
  } catch (e) { /* log hatası sessiz geçilir */ }
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
    // --- VERSİYON (deploy kontrolü, şifresiz) ---
    if (action === 'versiyon') {
      return res.json({ surum: 'ADAY-KIO-2026-06-26', takip: true, aday: true });
    }
    // --- KİO İSİMLERİ (giriş ekranı ağı için, şifresiz — sadece ad+bölge, hassas değil) ---
    if (action === 'kio_isimler') {
      const rows = await sb('acente_kio?select=ad,sompo_bolge&aktif=eq.true&order=ad.asc');
      // sadece ad ve bölge; başka hiçbir veri dönmez
      const isimler = rows.map(r => ({ ad: r.ad, b: r.sompo_bolge }));
      return res.json({ isimler });
    }
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
    const meRows = await sb(`acente_uw?id=eq.${encodeURIComponent(uw_id)}&select=id,ad,rol,aktif`);
    const me = meRows[0];
    if (!me || !me.aktif) return res.status(403).json({ error: 'Geçersiz kullanıcı' });
    const isAdmin = me.rol === 'admin';
    const meAd = me.ad || uw_id;

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
      const now = new Date();
      const buYil = (payload && payload.yil) || now.getFullYear();
      const buAy = (payload && payload.ay) || (now.getMonth() + 1);
      // tüm AKTİF KİO acenteleri (eski/pasif KİO'lar hedef sayılmaz)
      const kio = await sb('acente_kio?select=kod,ad,il,sompo_bolge,hangi_brans,kac_brans&aktif=eq.true&order=ad.asc');
      // hangi KİO kodları görüşülmüş (view üzerinden) — tarih ile
      const gor = await sb('acente_gorusmeler_kio?select=kio_kod,tarih,ay,yil,uw_id&kio_kod=not.is.null');
      const arananKod = {};      // yıl başından bugüne (bu yıl)
      const arananKodAy = {};    // bu ay
      gor.forEach(g => {
        if (!g.kio_kod) return;
        // YIL: bu yıla ait olanlar
        if (g.yil === buYil) {
          if (!arananKod[g.kio_kod]) arananKod[g.kio_kod] = { sayi: 0, son: null };
          arananKod[g.kio_kod].sayi++;
          if (!arananKod[g.kio_kod].son || g.tarih > arananKod[g.kio_kod].son) arananKod[g.kio_kod].son = g.tarih;
        }
        // AY: bu yıl + bu ay
        if (g.yil === buYil && g.ay === buAy) {
          if (!arananKodAy[g.kio_kod]) arananKodAy[g.kio_kod] = { sayi: 0, son: null };
          arananKodAy[g.kio_kod].sayi++;
          if (!arananKodAy[g.kio_kod].son || g.tarih > arananKodAy[g.kio_kod].son) arananKodAy[g.kio_kod].son = g.tarih;
        }
      });
      const liste = kio.map(k => ({
        ...k,
        arandi: !!arananKod[k.kod],
        gorusme_sayisi: arananKod[k.kod]?.sayi || 0,
        son_gorusme: arananKod[k.kod]?.son || null,
        arandi_ay: !!arananKodAy[k.kod],
        gorusme_sayisi_ay: arananKodAy[k.kod]?.sayi || 0
      }));
      // liste dışı aranan acenteler (KİO eşleşmeyen görüşmeler)
      const disRows = await sb('acente_gorusmeler_kio?select=acente,tarih,ay,yil&kio_kod=is.null');
      const disMap = {}; const disMapAy = {};
      disRows.forEach(r => {
        if (r.yil === buYil) {
          if (!disMap[r.acente]) disMap[r.acente] = { sayi: 0, son: null };
          disMap[r.acente].sayi++;
          if (!disMap[r.acente].son || r.tarih > disMap[r.acente].son) disMap[r.acente].son = r.tarih;
        }
        if (r.yil === buYil && r.ay === buAy) {
          disMapAy[r.acente] = (disMapAy[r.acente] || 0) + 1;
        }
      });
      const disListe = Object.entries(disMap).map(([acente, v]) => ({ acente, gorusme_sayisi: v.sayi, son_gorusme: v.son }));
      const disAyAdet = Object.keys(disMapAy).length;

      // === SEGMENT İSTATİSTİKLERİ (KİO / Aday KİO / Diğer × yıllık + aylık) ===
      const segRows = await sb('acente_gorusmeler_kio?select=acente,kio_kod,kio_mu,aday_kio,ay,yil');
      function segHesapla(filtreFn) {
        const r = { kio: { g: 0, set: new Set() }, aday: { g: 0, set: new Set() }, diger: { g: 0, set: new Set() } };
        segRows.forEach(x => {
          if (!filtreFn(x)) return;
          if (x.kio_mu) { r.kio.g++; r.kio.set.add(x.kio_kod); }
          else if (x.aday_kio) { r.aday.g++; r.aday.set.add((x.acente || '').toLocaleUpperCase('tr-TR').trim()); }
          else { r.diger.g++; r.diger.set.add((x.acente || '').toLocaleUpperCase('tr-TR').trim()); }
        });
        const fmt = (o) => ({ gorusme: o.g, ayri: o.set.size, ort: o.set.size ? Math.round(o.g / o.set.size * 10) / 10 : 0 });
        return { kio: fmt(r.kio), aday: fmt(r.aday), diger: fmt(r.diger) };
      }
      const segmentYil = segHesapla(x => x.yil === buYil);
      const segmentAy = segHesapla(x => x.yil === buYil && x.ay === buAy);

      return res.json({ kio: liste, dis: disListe, buYil, buAy, disAyAdet, segmentYil, segmentAy });
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
      let q = 'acente_kio?select=kod,ad,il,sompo_bolge,hangi_brans&aktif=eq.true&order=ad.asc';
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
      const rows = await sb('acente_gorusmeler_kio?select=uw_id,tarih,ay,bolge,acente,tur,durum,prim,kio_mu,kio_kod,acente_uw(ad)&order=tarih.desc&limit=500');
      const kioAll = await sb('acente_kio?select=kod&aktif=eq.true');
      // KİO kapsamasını 500 satır limitinden BAĞIMSIZ hesapla (tüm yıl, tüm görüşmeler)
      const yilNow = new Date().getFullYear();
      const arananRows = await sb(`acente_gorusmeler_kio?select=kio_kod&kio_mu=eq.true&kio_kod=not.is.null&yil=eq.${yilNow}`);
      const kioArananKod = new Set(arananRows.map(r => r.kio_kod));
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
        secili_kio_kod: p.secili_kio_kod || null,
        aday_kio: p.aday_kio === true, aday_not: p.aday_kio === true ? (p.aday_not || null) : null
      };
      const out = await sb('acente_gorusmeler', { method: 'POST', body: JSON.stringify(rec) });
      await logKaydet(uw_id, meAd, 'ekle', `${rec.acente}${rec.kisi ? ' / ' + rec.kisi : ''}`, out[0] && out[0].id);
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
        secili_kio_kod: p.secili_kio_kod || null,
        aday_kio: p.aday_kio === true, aday_not: p.aday_kio === true ? (p.aday_not || null) : null
      };
      const out = await sb(`acente_gorusmeler?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(upd) });
      await logKaydet(uw_id, meAd, 'guncelle', `${upd.acente}`, id);
      return res.json({ ok: true, row: out[0] });
    }

    // --- SİL (kendi kaydı; admin tümünü silebilir) ---
    if (action === 'delete') {
      const id = (payload || {}).id;
      if (!id) return res.status(400).json({ error: 'id gerekli' });
      const owner = await sb(`acente_gorusmeler?id=eq.${id}&select=uw_id`);
      if (!owner[0]) return res.status(404).json({ error: 'Kayıt yok' });
      if (owner[0].uw_id !== uw_id && !isAdmin) return res.status(403).json({ error: 'Sadece kendi kaydınızı silebilirsiniz' });
      const silinen = await sb(`acente_gorusmeler?id=eq.${id}&select=acente`);
      await sb(`acente_gorusmeler?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      await logKaydet(uw_id, meAd, 'sil', silinen[0] ? silinen[0].acente : id, id);
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
      let recs = items.filter(p => p.acente).map(p => ({
        uw_id: hedefUw,
        tarih: p.tarih || null, bolge: p.bolge || null, acente: p.acente,
        kisi: p.kisi || null, akis_no: p.akis || null, tur: p.tur || null,
        konu: p.konu || null, sonuc: p.sonuc || null
      }));
      const gelen = recs.length;
      if (!recs.length) return res.json({ ok: true, added: 0, atlanan: 0, gelen: 0 });

      // 1) Excel'in KENDİ İÇİNDEKİ tekrarları ele (aynı parmak izi birden çok satırda)
      const gorulen = new Set();
      recs = recs.filter(r => {
        const fp = [r.uw_id, r.tarih || '', r.acente || '', r.kisi || '', r.konu || ''].join('||').toLocaleLowerCase('tr-TR');
        if (gorulen.has(fp)) return false;
        gorulen.add(fp);
        return true;
      });

      // 2) Veritabanında ZATEN OLAN kayıtları atla (unique index + ignore-duplicates)
      // PostgREST: çakışanları sessizce yok say, sadece yeni eklenenleri döndür
      let eklenen = [];
      try {
        eklenen = await sb('acente_gorusmeler', {
          method: 'POST',
          body: JSON.stringify(recs),
          prefer: 'return=representation,resolution=ignore-duplicates',
          headers: { Prefer: 'return=representation,resolution=ignore-duplicates' }
        });
      } catch (e) {
        // beklenmedik hata: parça parça dene (tek tek, çakışanı atla)
        eklenen = [];
        for (const r of recs) {
          try {
            const o = await sb('acente_gorusmeler', { method: 'POST', body: JSON.stringify(r), prefer: 'return=representation,resolution=ignore-duplicates', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' } });
            if (o && o[0]) eklenen.push(o[0]);
          } catch (e2) { /* çakışma, atla */ }
        }
      }
      const added = Array.isArray(eklenen) ? eklenen.length : 0;
      const atlanan = gelen - added;
      await logKaydet(uw_id, meAd, 'bulk', `${added} eklendi, ${atlanan} atlandı (mükerrer)`, null);
      return res.json({ ok: true, added, atlanan, gelen, hedef: hedefUw });
    }

    // === TAKİP HATIRLATMALARI ===
    // ekle
    if (action === 'takip_ekle') {
      const p = payload || {};
      if (!p.acente || !p.hatirlatma_tarihi) return res.status(400).json({ error: 'Acente ve tarih gerekli' });
      const rec = {
        uw_id, gorusme_id: p.gorusme_id || null, acente: p.acente,
        hatirlatma_tarihi: p.hatirlatma_tarihi, not_metni: p.not_metni || null
      };
      const out = await sb('acente_takip', { method: 'POST', body: JSON.stringify(rec) });
      await logKaydet(uw_id, meAd, 'takip', `${p.acente} → ${p.hatirlatma_tarihi}`, out[0] && out[0].id);
      return res.json({ ok: true, row: out[0] });
    }
    // listele (kendi takipleri; admin hepsini görebilir)
    if (action === 'takip_list') {
      const p = payload || {};
      const hepsi = isAdmin && p.hepsi === true;
      const filtre = hepsi ? '' : `&uw_id=eq.${encodeURIComponent(uw_id)}`;
      const aktifFiltre = p.tamamlanan === true ? '' : '&tamamlandi=eq.false';
      const rows = await sb(`acente_takip?select=*&order=hatirlatma_tarihi.asc${filtre}${aktifFiltre}`);
      // UW adlarını ayrı çek (embed yerine, daha sağlam)
      let adMap = {};
      if (hepsi && rows.length) {
        const us = await sb('acente_uw?select=id,ad');
        us.forEach(u => { adMap[u.id] = u.ad; });
      }
      return res.json({ takipler: rows.map(r => ({ ...r, uw_ad: adMap[r.uw_id] || r.uw_id })) });
    }
    // tamamla / sil
    if (action === 'takip_tamamla') {
      const p = payload || {};
      if (!p.id) return res.status(400).json({ error: 'id gerekli' });
      const own = await sb(`acente_takip?id=eq.${p.id}&select=uw_id`);
      if (!own[0]) return res.status(404).json({ error: 'Takip yok' });
      if (own[0].uw_id !== uw_id && !isAdmin) return res.status(403).json({ error: 'Yetkisiz' });
      await sb(`acente_takip?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ tamamlandi: true }), prefer: 'return=minimal' });
      return res.json({ ok: true });
    }
    if (action === 'takip_sil') {
      const p = payload || {};
      if (!p.id) return res.status(400).json({ error: 'id gerekli' });
      const own = await sb(`acente_takip?id=eq.${p.id}&select=uw_id`);
      if (!own[0]) return res.status(404).json({ error: 'Takip yok' });
      if (own[0].uw_id !== uw_id && !isAdmin) return res.status(403).json({ error: 'Yetkisiz' });
      await sb(`acente_takip?id=eq.${p.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      return res.json({ ok: true });
    }

    // === DENETİM KAYDI (sadece admin) ===
    if (action === 'log_list') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const limit = Math.min(((payload || {}).limit) || 100, 300);
      const rows = await sb(`acente_log?select=*&order=created_at.desc&limit=${limit}`);
      return res.json({ loglar: rows });
    }

    // === MANUEL KİO EŞLEŞTİRME (sadece admin) ===
    // eşleşmeyen görüşmeleri getir
    if (action === 'eslesmeyenler') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const rows = await sb('acente_gorusmeler_kio?select=id,acente,kisi,bolge,tarih,uw_id,secili_kio_kod&kio_kod=is.null&order=tarih.desc');
      return res.json({ kayitlar: rows });
    }
    // bir görüşmeyi elle bir KİO koduna bağla (veya "KİO değil" işaretle)
    if (action === 'kio_esle') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const p = payload || {};
      if (!p.id) return res.status(400).json({ error: 'id gerekli' });
      const kod = p.kio_kod || null; // null = eşleştirmeyi kaldır
      await sb(`acente_gorusmeler?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ secili_kio_kod: kod }), prefer: 'return=minimal' });
      await logKaydet(uw_id, meAd, 'kio_esle', `${p.acente_ad || p.id} → ${kod || 'temizlendi'}`, p.id);
      return res.json({ ok: true });
    }
    // tüm KİO listesi (manuel eşleştirme arama kutusu için)
    if (action === 'kio_hepsi') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const list = await sb('acente_kio?select=kod,ad,il,sompo_bolge&order=ad.asc');
      return res.json({ kio: list });
    }

    // === ACENTE GEÇMİŞİ ===
    if (action === 'acente_gecmis') {
      const p = payload || {};
      const ad = (p.acente || '').trim();
      if (!ad) return res.status(400).json({ error: 'acente gerekli' });
      const filtre = isAdmin ? '' : `&uw_id=eq.${encodeURIComponent(uw_id)}`;
      const rows = await sb(`acente_gorusmeler_kio?select=*&acente=eq.${encodeURIComponent(ad)}${filtre}&order=tarih.desc`);
      const us = await sb('acente_uw?select=id,ad');
      const adMap = {}; us.forEach(u => { adMap[u.id] = u.ad; });
      return res.json({ gorusmeler: rows.map(r => ({ ...r, uw_ad: adMap[r.uw_id] || r.uw_id })) });
    }

    // === TREND & LİDERLİK (admin) ===
    if (action === 'trend') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const rows = await sb('acente_gorusmeler_kio?select=uw_id,ay,yil,tur,durum,prim,kio_mu&order=tarih.asc');
      const us = await sb('acente_uw?select=id,ad');
      const adMap = {}; us.forEach(u => { adMap[u.id] = u.ad; });
      // aylık toplam
      const aylik = {};
      const uwStat = {};
      rows.forEach(r => {
        const ay = `${r.yil}-${String(r.ay).padStart(2, '0')}`;
        if (r.ay && r.yil) aylik[ay] = (aylik[ay] || 0) + 1;
        const uw = adMap[r.uw_id] || r.uw_id;
        if (!uwStat[uw]) uwStat[uw] = { gorusme: 0, kio: 0, teklif: 0, police: 0, prim: 0 };
        uwStat[uw].gorusme++;
        if (r.kio_mu) uwStat[uw].kio++;
        if (['Teklif Verildi', 'RT Yapıldı', 'Poliçe Bağlandı', 'Kaybedildi'].includes(r.durum)) uwStat[uw].teklif++;
        if (r.durum === 'Poliçe Bağlandı') { uwStat[uw].police++; uwStat[uw].prim += Number(r.prim) || 0; }
      });
      const liderlik = Object.entries(uwStat).map(([ad, s]) => ({
        ad, ...s,
        donusum: s.teklif ? Math.round(s.police / s.teklif * 100) : 0
      })).sort((a, b) => b.gorusme - a.gorusme);
      return res.json({ aylik, liderlik });
    }

    // === ADAY KİO HAVUZU ===
    // aday işaretli görüşmeler (UW kendi, admin hepsi). Zaten gerçek KİO olanları çıkar.
    if (action === 'aday_havuz') {
      const filtre = isAdmin ? '' : `&uw_id=eq.${encodeURIComponent(uw_id)}`;
      const rows = await sb(`acente_gorusmeler_kio?select=*&aday_kio=eq.true${filtre}&order=tarih.desc`);
      const us = await sb('acente_uw?select=id,ad');
      const adMap = {}; us.forEach(u => { adMap[u.id] = u.ad; });
      // acenteye göre grupla (aynı aday birden çok kez işaretlenmiş olabilir)
      const grup = {};
      rows.forEach(r => {
        const key = (r.acente || '').toLocaleUpperCase('tr-TR').trim();
        if (!grup[key]) grup[key] = { acente: r.acente, bolge: r.bolge, kio_mu: false, kez: 0, son_tarih: r.tarih, uwlar: new Set(), notlar: [], ornek_id: r.id };
        grup[key].kez++;
        if (r.kio_mu) grup[key].kio_mu = true; // artık gerçek KİO olmuş
        if (r.tarih > grup[key].son_tarih) grup[key].son_tarih = r.tarih;
        grup[key].uwlar.add(adMap[r.uw_id] || r.uw_id);
        if (r.aday_not) grup[key].notlar.push(adMap[r.uw_id] ? `${adMap[r.uw_id]}: ${r.aday_not}` : r.aday_not);
      });
      const havuz = Object.values(grup).map(g => ({
        acente: g.acente, bolge: g.bolge, kio_mu: g.kio_mu, kez: g.kez,
        son_tarih: g.son_tarih, uwlar: [...g.uwlar], notlar: g.notlar, ornek_id: g.ornek_id
      })).sort((a, b) => (b.son_tarih || '').localeCompare(a.son_tarih || ''));
      return res.json({ havuz });
    }

    // === UW KİŞİSEL PANELİ ===
    // UW'nin kendi istatistikleri + kendi bölgelerindeki KİO durumu + ekip liderlik sırası
    if (action === 'uw_panel') {
      const yil = (payload && payload.yil) || new Date().getFullYear();
      const ay = (payload && payload.ay) || (new Date().getMonth() + 1);

      // 1) Kendi görüşmelerim (tüm yıl)
      const benim = await sb(`acente_gorusmeler_kio?select=bolge,acente,kio_kod,kio_ad,kio_mu,durum,prim,ay,yil,tarih&uw_id=eq.${encodeURIComponent(uw_id)}&yil=eq.${yil}`);
      const benimAy = benim.filter(r => r.ay === ay);
      const istat = (rows) => {
        const kioKod = new Set(), acenteler = new Set();
        let kioG = 0, teklif = 0, police = 0, prim = 0;
        rows.forEach(r => {
          acenteler.add((r.acente || '').toLocaleUpperCase('tr-TR').trim());
          if (r.kio_mu) { kioG++; kioKod.add(r.kio_kod); }
          if (['Teklif Verildi', 'RT Yapıldı', 'Poliçe Bağlandı', 'Kaybedildi'].includes(r.durum)) teklif++;
          if (r.durum === 'Poliçe Bağlandı') { police++; prim += Number(r.prim) || 0; }
        });
        return {
          gorusme: rows.length, kio_gorusme: kioG, kio_acente: kioKod.size,
          ayri_acente: acenteler.size, teklif, police, prim,
          donusum: teklif ? Math.round(police / teklif * 100) : 0,
          ort: acenteler.size ? Math.round(rows.length / acenteler.size * 10) / 10 : 0
        };
      };
      const yilStat = istat(benim);
      const ayStat = istat(benimAy);

      // 2) Kendi çalıştığım bölgelerdeki KİO durumu
      const benimBolgeler = [...new Set(benim.map(r => r.bolge).filter(Boolean))];
      // bu yıl benim aradığım KİO kodları
      const benimKioKod = new Set(benim.filter(r => r.kio_mu).map(r => r.kio_kod));
      // bu bölgelerdeki tüm KİO'lar
      let bolgeKio = [];
      if (benimBolgeler.length) {
        const inList = benimBolgeler.map(b => `"${b}"`).join(',');
        bolgeKio = await sb(`acente_kio?select=kod,ad,il,sompo_bolge&aktif=eq.true&sompo_bolge=in.(${inList})&order=ad.asc`);
      }
      // ekip geneli bu yıl aranan KİO kodları (benim bölgemdeki bir KİO başkası aramışsa da "arandı" say)
      const ekipArananRows = await sb(`acente_gorusmeler_kio?select=kio_kod&kio_mu=eq.true&yil=eq.${yil}`);
      const ekipArananKod = new Set(ekipArananRows.map(r => r.kio_kod));
      const bolgeKioDurum = bolgeKio.map(k => ({
        kod: k.kod, ad: k.ad, il: k.il, bolge: k.sompo_bolge,
        ben_aradim: benimKioKod.has(k.kod),
        ekip_aradi: ekipArananKod.has(k.kod)
      }));

      // 3) Ekip liderlik tablosu (mahremiyet: prim YOK, sadece aktivite + dönüşüm)
      const tumRows = await sb(`acente_gorusmeler_kio?select=uw_id,kio_mu,durum&yil=eq.${yil}`);
      const us = await sb('acente_uw?select=id,ad,rol,aktif');
      const adMap = {}, aktifMap = {}; us.forEach(u => { adMap[u.id] = u.ad; aktifMap[u.id] = u.aktif; });
      const uwStat = {};
      tumRows.forEach(r => {
        if (aktifMap[r.uw_id] === false) return;
        if (!uwStat[r.uw_id]) uwStat[r.uw_id] = { gorusme: 0, kio: 0, teklif: 0, police: 0 };
        uwStat[r.uw_id].gorusme++;
        if (r.kio_mu) uwStat[r.uw_id].kio++;
        if (['Teklif Verildi', 'RT Yapıldı', 'Poliçe Bağlandı', 'Kaybedildi'].includes(r.durum)) uwStat[r.uw_id].teklif++;
        if (r.durum === 'Poliçe Bağlandı') uwStat[r.uw_id].police++;
      });
      const liderlik = Object.entries(uwStat).map(([id, s]) => ({
        uw_id: id, ad: adMap[id] || id, gorusme: s.gorusme, kio: s.kio,
        donusum: s.teklif ? Math.round(s.police / s.teklif * 100) : 0,
        ben: id === uw_id
      })).sort((a, b) => b.gorusme - a.gorusme);
      const benimSira = liderlik.findIndex(x => x.ben) + 1;

      // 4) Hedef
      const h = await sb(`acente_hedef?select=hedef&uw_id=eq.${encodeURIComponent(uw_id)}&yil=eq.${yil}&ay=eq.${ay}`);
      const hedef = (h[0] && h[0].hedef) || 0;

      // === HATIRLATMALAR (dashboard uyarı şeridi) ===
      const hatirlatmalar = [];
      const bugun = new Date();

      // a) Bu ay hiç aramadığım bölgemdeki KİO — bölge bazında bu ay arama var mı
      const buAyArananKod = new Set(benimAy.filter(r => r.kio_mu).map(r => r.kio_kod));
      const bolgeAyDurum = {};
      bolgeKioDurum.forEach(k => {
        if (!bolgeAyDurum[k.bolge]) bolgeAyDurum[k.bolge] = { top: 0, buAy: 0 };
        bolgeAyDurum[k.bolge].top++;
        if (buAyArananKod.has(k.kod)) bolgeAyDurum[k.bolge].buAy++;
      });
      const ayHicAranmayan = Object.entries(bolgeAyDurum).filter(([b, s]) => s.buAy === 0 && s.top > 0);
      if (ayHicAranmayan.length) {
        const bolgeAd = ayHicAranmayan.map(([b]) => b).join(', ');
        const toplamKio = ayHicAranmayan.reduce((a, [b, s]) => a + s.top, 0);
        hatirlatmalar.push({
          tip: 'bolge', renk: 'kirmizi', ikon: '📍',
          baslik: 'Bu ay aranmayan bölge',
          mesaj: `${bolgeAd} bölgen(ler)inde bu ay hiç KİO aramadın (${toplamKio} KİO bekliyor).`
        });
      }

      // b) 30+ gündür aramadığım KİO'lar (bu yıl aradıklarımdan, son arama tarihine göre)
      const kioSonTarih = {};
      benim.filter(r => r.kio_mu && r.kio_kod).forEach(r => {
        const t = r.tarih;
        if (!kioSonTarih[r.kio_kod] || t > kioSonTarih[r.kio_kod].tarih) {
          kioSonTarih[r.kio_kod] = { tarih: t, ad: r.kio_ad || r.acente };
        }
      });
      const eskiKiolar = [];
      Object.entries(kioSonTarih).forEach(([kod, o]) => {
        const gun = Math.floor((bugun - new Date(o.tarih)) / 86400000);
        if (gun >= 30) eskiKiolar.push({ ad: o.ad, gun });
      });
      eskiKiolar.sort((a, b) => b.gun - a.gun);
      if (eskiKiolar.length) {
        const ilk = eskiKiolar.slice(0, 3).map(k => `${k.ad} (${k.gun} gün)`).join(', ');
        hatirlatmalar.push({
          tip: 'eski', renk: 'sari', ikon: '⏰',
          baslik: 'Uzun süredir aranmayan KİO',
          mesaj: `${eskiKiolar.length} KİO 30+ gündür aranmadı. En eskiler: ${ilk}${eskiKiolar.length > 3 ? '…' : ''}`
        });
      }

      // c) Aylık hedef durumu
      if (hedef > 0) {
        const kalan = hedef - ayStat.gorusme;
        if (kalan > 0) {
          hatirlatmalar.push({
            tip: 'hedef', renk: 'sari', ikon: '🎯',
            baslik: 'Aylık hedef',
            mesaj: `Bu ayki hedefine ${kalan} görüşme kaldı (${ayStat.gorusme}/${hedef}).`
          });
        } else {
          hatirlatmalar.push({
            tip: 'hedef', renk: 'yesil', ikon: '🎉',
            baslik: 'Hedef tamam',
            mesaj: `Bu ayki hedefini tamamladın! (${ayStat.gorusme}/${hedef})`
          });
        }
      }

      // d) Teklif verilip takip edilmeyen acenteler (durum 'Teklif Verildi' ama sonrası yok, 14+ gün)
      const teklifAcente = {};
      benim.forEach(r => {
        const ac = (r.acente || '').trim();
        if (!ac) return;
        if (!teklifAcente[ac]) teklifAcente[ac] = { sonTeklif: null, sonrasi: false };
        if (r.durum === 'Teklif Verildi') {
          if (!teklifAcente[ac].sonTeklif || r.tarih > teklifAcente[ac].sonTeklif) teklifAcente[ac].sonTeklif = r.tarih;
        }
        if (['Poliçe Bağlandı', 'Kaybedildi', 'RT Yapıldı'].includes(r.durum)) teklifAcente[ac].sonrasi = true;
      });
      const takipsiz = [];
      Object.entries(teklifAcente).forEach(([ac, o]) => {
        if (o.sonTeklif && !o.sonrasi) {
          const gun = Math.floor((bugun - new Date(o.sonTeklif)) / 86400000);
          if (gun >= 14) takipsiz.push({ ad: ac, gun });
        }
      });
      takipsiz.sort((a, b) => b.gun - a.gun);
      if (takipsiz.length) {
        const ilk = takipsiz.slice(0, 3).map(k => `${k.ad} (${k.gun} gün)`).join(', ');
        hatirlatmalar.push({
          tip: 'takip', renk: 'mavi', ikon: '📋',
          baslik: 'Takip bekleyen teklif',
          mesaj: `${takipsiz.length} acenteye teklif verdin ama sonuç girilmedi: ${ilk}${takipsiz.length > 3 ? '…' : ''}`
        });
      }

      return res.json({
        yil, ay, yilStat, ayStat,
        bolgelerim: benimBolgeler, bolgeKioDurum,
        liderlik, benimSira, toplamUw: liderlik.length,
        hedef, hedefGerceklesen: ayStat.gorusme,
        hatirlatmalar
      });
    }

    // === KİO LİSTESİ REVİZYONU (sadece admin) ===
    // Excel'den gelen güncel KİO listesini mevcutla karşılaştırır.
    // mode: 'onizle' → sadece ne değişeceğini döndür (yazma yok)
    // mode: 'uygula' → değişiklikleri uygula + logla
    if (action === 'kio_revize') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin yapabilir' });
      const pl = payload || {};
      const mode = pl.mode === 'uygula' ? 'uygula' : 'onizle';
      const gelenHam = pl.items || [];

      // JS tarafında normalize (DB acente_normalize ile uyumlu)
      const norm = (s) => {
        let x = (s || '').toString().toLocaleUpperCase('tr-TR');
        x = x.replace(/İ/g, 'I').replace(/I/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C');
        x = x.replace(/\b(SIGORTA|ARACILIK|HIZMETLERI|HIZM|ACENTELIGI|ANONIM|SIRKETI|LTD|STI|LIMITED|TICARET|REASURANS|BROKERLIGI|ARA|AS)\b/g, ' ');
        x = x.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        return x;
      };

      // Gelen Excel satırlarını temizle
      const gelen = gelenHam
        .map(r => ({
          kod: (r.kod || '').toString().trim(),
          ad: (r.ad || '').toString().trim(),
          il: (r.il || '').toString().trim() || null,
          sompo_bolge: (r.sompo_bolge || r.bolge || '').toString().trim() || null,
          kac_brans: r.kac_brans != null && r.kac_brans !== '' ? parseInt(r.kac_brans, 10) : null,
          hangi_brans: (r.hangi_brans || '').toString().trim() || null
        }))
        .filter(r => r.kod || r.ad); // en az kod veya ad olmalı
      gelen.forEach(r => { r._adNorm = norm(r.ad); });

      // Mevcut tüm KİO'lar (aktif + pasif)
      const mevcut = await sb('acente_kio?select=kod,ad,il,sompo_bolge,kac_brans,hangi_brans,aktif');
      const mevcutKodMap = {}; // kod → kayıt
      const mevcutAdMap = {};  // adNorm → kayıt
      mevcut.forEach(m => {
        if (m.kod) mevcutKodMap[m.kod.trim()] = m;
        const an = norm(m.ad);
        if (an) mevcutAdMap[an] = m;
      });

      // Eşleştirme: önce kod, yoksa ad
      const eslesenKodlar = new Set(); // gelen ile eşleşen mevcut kodlar
      const yeniler = [];   // sistemde olmayan (giriş)
      const guncellenenler = []; // eşleşti ama bilgisi değişti
      const geriAktif = []; // pasifti, tekrar listede (geri dönen)

      gelen.forEach(g => {
        let m = null;
        if (g.kod && mevcutKodMap[g.kod]) m = mevcutKodMap[g.kod];
        else if (g._adNorm && mevcutAdMap[g._adNorm]) m = mevcutAdMap[g._adNorm];

        if (m) {
          eslesenKodlar.add(m.kod);
          if (m.aktif === false) geriAktif.push({ gelen: g, mevcut: m });
          // bilgi değişikliği var mı (il/bölge/branş/ad)
          else if ((g.il && g.il !== m.il) || (g.sompo_bolge && g.sompo_bolge !== m.sompo_bolge) ||
                   (g.ad && g.ad !== m.ad) || (g.hangi_brans && g.hangi_brans !== m.hangi_brans)) {
            guncellenenler.push({ gelen: g, mevcut: m });
          }
        } else {
          yeniler.push(g);
        }
      });

      // Çıkanlar: şu an AKTİF olup gelen listede eşleşmeyenler
      const cikanlar = mevcut.filter(m => m.aktif !== false && !eslesenKodlar.has(m.kod));

      const ozet = {
        gelen_satir: gelen.length,
        yeni: yeniler.length,
        cikan: cikanlar.length,
        guncellenen: guncellenenler.length,
        geri_donen: geriAktif.length,
        degismeyen: gelen.length - yeniler.length - guncellenenler.length - geriAktif.length
      };

      // ÖNİZLEME: sadece ne olacağını döndür
      if (mode === 'onizle') {
        return res.json({
          mode: 'onizle', ozet,
          yeniler: yeniler.slice(0, 200).map(y => ({ kod: y.kod, ad: y.ad, il: y.il, bolge: y.sompo_bolge })),
          cikanlar: cikanlar.slice(0, 200).map(c => ({ kod: c.kod, ad: c.ad, il: c.il, bolge: c.sompo_bolge })),
          guncellenenler: guncellenenler.slice(0, 200).map(u => ({ kod: u.mevcut.kod, ad: u.gelen.ad, eski_bolge: u.mevcut.sompo_bolge, yeni_bolge: u.gelen.sompo_bolge })),
          geri_donenler: geriAktif.slice(0, 200).map(r => ({ kod: r.mevcut.kod, ad: r.mevcut.ad }))
        });
      }

      // UYGULA: değişiklikleri yaz + logla
      const revizyonId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : null;
      const bugun = new Date().toISOString().slice(0, 10);
      const loglar = [];

      // 1) Yeni KİO'lar ekle
      for (const y of yeniler) {
        // kod yoksa addan türet (benzersiz olması için ad_norm + sıra)
        let kod = y.kod;
        if (!kod) kod = 'YENI-' + (y._adNorm || y.ad).replace(/\s+/g, '').slice(0, 12) + '-' + Date.now().toString().slice(-5);
        const yeniKayit = {
          kod, ad: y.ad, ad_norm: y._adNorm || norm(y.ad),
          il: y.il, sompo_bolge: y.sompo_bolge, kac_brans: y.kac_brans, hangi_brans: y.hangi_brans,
          aktif: true, giris_tarihi: bugun
        };
        try {
          await sb('acente_kio', { method: 'POST', body: JSON.stringify(yeniKayit), prefer: 'return=minimal,resolution=ignore-duplicates', headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' } });
          loglar.push({ kod, ad: y.ad, il: y.il, sompo_bolge: y.sompo_bolge, islem: 'giris', revizyon_id: revizyonId, uw_id, uw_ad: meAd });
        } catch (e) { /* çakışma, atla */ }
      }

      // 2) Çıkanları pasifle (silme YOK)
      for (const c of cikanlar) {
        await sb(`acente_kio?kod=eq.${encodeURIComponent(c.kod)}`, { method: 'PATCH', body: JSON.stringify({ aktif: false, cikis_tarihi: bugun }), prefer: 'return=minimal' });
        loglar.push({ kod: c.kod, ad: c.ad, il: c.il, sompo_bolge: c.sompo_bolge, islem: 'cikis', revizyon_id: revizyonId, uw_id, uw_ad: meAd });
      }

      // 3) Geri dönenleri tekrar aktif et
      for (const r of geriAktif) {
        await sb(`acente_kio?kod=eq.${encodeURIComponent(r.mevcut.kod)}`, { method: 'PATCH', body: JSON.stringify({ aktif: true, cikis_tarihi: null, giris_tarihi: bugun }), prefer: 'return=minimal' });
        loglar.push({ kod: r.mevcut.kod, ad: r.mevcut.ad, il: r.mevcut.il, sompo_bolge: r.mevcut.sompo_bolge, islem: 'geri_aktif', revizyon_id: revizyonId, uw_id, uw_ad: meAd });
      }

      // 4) Bilgisi değişenleri güncelle
      for (const u of guncellenenler) {
        const upd = {};
        if (u.gelen.ad) { upd.ad = u.gelen.ad; upd.ad_norm = u.gelen._adNorm; }
        if (u.gelen.il) upd.il = u.gelen.il;
        if (u.gelen.sompo_bolge) upd.sompo_bolge = u.gelen.sompo_bolge;
        if (u.gelen.hangi_brans) upd.hangi_brans = u.gelen.hangi_brans;
        if (u.gelen.kac_brans != null) upd.kac_brans = u.gelen.kac_brans;
        if (Object.keys(upd).length) {
          await sb(`acente_kio?kod=eq.${encodeURIComponent(u.mevcut.kod)}`, { method: 'PATCH', body: JSON.stringify(upd), prefer: 'return=minimal' });
          loglar.push({ kod: u.mevcut.kod, ad: u.gelen.ad, il: u.gelen.il, sompo_bolge: u.gelen.sompo_bolge, islem: 'guncelle', revizyon_id: revizyonId, uw_id, uw_ad: meAd });
        }
      }

      // 5) Logları yaz
      if (loglar.length) {
        await sb('acente_kio_log', { method: 'POST', body: JSON.stringify(loglar), prefer: 'return=minimal' });
      }
      await logKaydet(uw_id, meAd, 'kio_revize', `${ozet.yeni} giriş, ${ozet.cikan} çıkış, ${ozet.guncellenen} güncelleme, ${ozet.geri_donen} geri dönen`, null);

      return res.json({ mode: 'uygula', ozet, revizyon_id: revizyonId });
    }

    // KİO revizyon geçmişi (giriş/çıkış logları)
    if (action === 'kio_log') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const limit = Math.min(((payload || {}).limit) || 200, 500);
      const rows = await sb(`acente_kio_log?select=*&order=created_at.desc&limit=${limit}`);
      return res.json({ loglar: rows });
    }

    // Eski (pasif) KİO listesi
    if (action === 'kio_eski') {
      if (!isAdmin) return res.status(403).json({ error: 'Sadece admin' });
      const rows = await sb('acente_kio?select=kod,ad,il,sompo_bolge,cikis_tarihi&aktif=eq.false&order=cikis_tarihi.desc');
      return res.json({ eski: rows });
    }

    return res.status(400).json({ error: 'Bilinmeyen aksiyon' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: 'Sunucu hatası', detail: e.data || String(e) });
  }
};
