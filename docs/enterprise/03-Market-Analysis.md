# 03 — Market Analysis

## 3.1-3.3 TAM / SAM / SOM

[Fakta — basis] Global scheduling software USD 635.6M (2026). Regional: NA USD 186M (34.1%), Eropa USD 148.5M (27.2%), APAC USD 112.6M (20.6%). US USD 117.3M (2026). Web-based 55.66%. Large enterprise 57.25%.
Source: https://www.fortunebusinessinsights.com/appointment-scheduling-software-market-108614

[Asumsi — eksplisit] Jangan klaim SOM tanpa pilot. Metode yang dipakai nanti:
`SOM = (lokasi beachhead) x (ARPA/mo x 12) x (penetration %)`.
Contoh kerangka (bukan janji): 200 lokasi x $250/mo x 12 = $600k ARR pada penetrasi awal; skala ke 1.000 lokasi = $3M ARR. Ganti dengan data pilot Indonesia/SEA.

## 3.4 Segmentation

- Vertical: dental, klinik umum, fisio, salon/spa, HVAC/plumbing. Rate dan ticket beda (dental $150-200/slot, salon $35-200, HVAC $275-1.200, replacement $3.500+).
- Geography: primer Indonesia & SEA (WhatsApp-first); sekunder US/EU (SMS + voice, HIPAA).
- Size: solo (sensitif harga, $25-150) → multi-location (butuh standardisasi routing + reporting, $1k+/mo).

## 3.5 Trends & Growth Drivers 2024-2028

1. AI scheduling: forecast peak hours dari histori (FBI trend).
2. Conversational booking gantikan form statis.
3. Self-scheduling menurunkan no-show (DialogHealth: -29%).
4. Comprehensive digital engagement klaim potong no-show s.d. 70% (WCHSB 2026 — klaim vendor, perlakukan sebagai [Interpretasi]).
5. Meta WhatsApp Business Agent + Cloud API + MCP menurunkan cost setup di SEA.

## 3.6 Regulatory Landscape

- WhatsApp: agent harus task-specific, patuh Business Policy; template + opt-in.
- Kesehatan US: HIPAA/BAA, SSO, data residency, audit log. Enterprise plan (Bland: dedicated infra, VPC/on-prem, JWT) sebagai benchmark.
- Indonesia: PDPA/UU PDP — [Asumsi] butuh legal review sebelum simpan rekam chat kesehatan; default: minimisasi data + retensi jelas + export saat churn.
