# 03 — Team and Roles

> Tim minimal full-AI-agent + 1 manusia owner (pola sesi ini: orchestrator + subagent spesialis).

| Peran | Tanggung jawab | Definisi selesai |
|---|---|---|
| Owner/orchestrator (manusia) | Keputusan D-log, approve HITL desain, gate pilot | Tiap fase ada keputusan tercatat |
| Backend agent | API, writer, lock, idempotency, worker | typecheck + test hijau, 0 double-book simulasi |
| Frontend agent | Dashboard recovered revenue | Metrik gate tampil real-time |
| Research agent | Firecrawl ber-SoT, batch kecil + jeda | Klaim tanpa URL ditolak |
| Audit agent | First-principles + code audit per command repo | Temuan P0 nol sebelum go-live |
| Security agent | OWASP + PDP checklist + secret hygiene | Secrets nol di repo, RLS aktif |

Aturan: subagent dilarang tulis file yang sama (non-overlapping); orchestrator satu-satunya penulis akhir; tiap klaim kode diverifikasi eksekusi.
