# G — Glossary

> 1 baris + file pemakai. Sumber istilah: inventaris subagent Appendix (Sep 2026).

- slot-hold ber-TTL — kunci slot 5-10 mnt server-enforced sebelum confirm — 01-Strategy/05, 02-Product/01, 03-Technical/01+05
- single-writer — satu endpoint/service boleh tulis booking (cegah race) — 03-Technical/01+02
- idempotency key / wamid — kunci unik per mutasi/pesan agar retry tak ganda — 03-Technical/01+05+06+07
- EXCLUDE USING gist (+btree_gist) — constraint DB cegah overlap slot — 03-Technical/01+02
- advisory lock / FOR UPDATE SKIP LOCKED — klaim atomik Postgres — 03-Technical/01+05
- checkpointer / thread_id / Store — persistensi LangGraph per-percakapan vs lintas-thread — 03-Technical/01+02+03
- interrupt / HITL / HOTL / HOOTL — jeda approve manusia, longgarkan bertahap — 02-Product/04, 03-Technical/03
- outbox — tabel event transaksional untuk worker — 03-Technical/05+07, architecture.md
- audit log append-only — jejak hold→confirm/cancel untuk sengketa — 03-Technical/01+05
- RLS — Row Level Security Postgres jaring pengaman tenant — 03-Technical/05+06+07
- pg-boss / BullMQ-PG — antrean di Postgres — 03-Technical/02+07
- no-show vs cancel vs late-cancel (<24j) — mangkir vs batal vs batal mepet (=no-show) — 01-Strategy/02, 02-Product/02+05
- waitlist fill rate / confirmation rate / time-to-fill — % cancel terisi / % confirm / median menit — 02-Product/05
- recovered revenue — pendapatan terselamatkan/lokasi vs fee — 02-Product/05, 01-Strategy/06
- utility vs marketing vs authentication template — kategori WA penentu tarif; campur promo = marketing — 01-Strategy/05, 02-Product/03, 03-Technical/04
- service window / FEP 72j / free tier 1.000 — jendela balas + pengecualian — 01-Strategy/05, 02-Product/03
- quality-rating / block rate / messaging limit — skor spam-tier penentu limit — 01-Strategy/05, 03-Technical/07
- opt-in/opt-out logging — bukti consent WA terpisah data klinis — 01-Strategy/05, 03-Technical/06
- BAA / PHI / minimum necessary — kontrak + data kesehatan AS — 01-Strategy/03, 03-Technical/06
- ROPA / PDP UU 27/2022 / DPO — register + kewajiban privasi ID — 03-Technical/06
- TAM/SAM/SOM / ARPU / NRR / CAC payback / LTV:CAC / churn — kerangka pasar + ekonomi SaaS — 01-Strategy/03+06
- PMS/FSM / BSP / MCP / adapter — sistem praktik/lapangan, penyedia WA, protokol konektor — 03-Technical/04
