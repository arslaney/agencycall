# Acente Aramaları Sistemi — Kurulum

Sompo Sigorta · Endüstriyel Riskler (Yangın) · Görüşme Takip Sistemi

## Yapı
```
acente-projesi/
├── public/index.html   ← Web arayüzü (giriş, UW paneli, admin paneli)
├── api/db.js           ← Serverless API (Supabase köprüsü, güvenlik katmanı)
├── vercel.json
└── package.json
```

## Veritabanı (HAZIR)
Supabase "teklifverisi" projesinde tablolar kuruldu:
- `acente_uw` — 12 kullanıcı (4 admin: Mustafa, Melek, Emine, Veysel)
- `acente_gorusmeler` — 28 başlangıç kaydı (Veysel Aydın adına)
- `acente_kio` — 133 KİO acentesi (2026 revize listesi)
- `acente_gorusmeler_kio` (view) — her görüşmeyi KİO listesiyle otomatik eşleştirir

RLS açık, policy yok → veriye sadece API (service_role) erişir. Güvenlik API katmanında.

### KİO Eşleştirme
Görüşmedeki acente adı normalize edilip (Türkçe karakter + şirket ekleri temizlenerek) KİO listesiyle karşılaştırılır. Her görüşme "KİO ✓" veya "Liste dışı" olarak işaretlenir. Admin panelindeki **🎯 KİO Takip** sekmesi hangi KİO acentelerinin arandığını / aranmadığını, bölge bazlı boşlukları ve liste dışı aranan acenteleri gösterir.

## Vercel'e Deploy — 3 ortam değişkeni gerekli

Vercel projesinde **Settings → Environment Variables** altına ekle:

| Değişken | Değer |
|---|---|
| `SUPABASE_URL` | `https://cvrjbgvfygrmwfpohjng.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` secret (gizli!) |
| `APP_PASSWORD` | Ekibin ortak giriş şifresi (örn. güçlü bir şey seç, "1234" değil) |

**service_role key nereden:** Supabase paneli → teklifverisi projesi → Project Settings → API → "service_role" satırındaki secret anahtarı kopyala. Bu anahtar tam yetkili, ASLA frontend'e veya GitHub'a yazma — sadece Vercel env'e.

## Deploy yolu (senin alışık olduğun)
1. Bu klasörü GitHub'a push et (`arslaney/acente-aramalar`)
2. Vercel'de "New Project" → repo'yu seç
3. Yukarıdaki 3 env değişkenini gir
4. Deploy

Veya: Vercel Dashboard → klasörü sürükle-bırak + env gir.

## Kullanım
- **Giriş:** isim seç + ortak şifre
- **UW** (8 kişi): Görüşmelerim · Görüşme Ekle · Excel Yükle — sadece kendi kaydını görür/düzenler/siler
- **Admin** (4 kişi): Genel Bakış · UW Karşılaştırma · Rapor — herkesi görür, filtreler, dışa aktarır
