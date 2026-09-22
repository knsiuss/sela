# 07 — Postmortems

> Tulis maksimal 48 jam setelah insiden berdampak customer. Blameless: sistem, bukan orang.

## Template

```text
# Postmortem YYYY-MM-DD — <judul>
- Severity: S1 (down/data loss) / S2 (degradasi) / S3 (minor)
- Durasi & dampak: <waktu> — <lokasi/booking terdampak>
- Timeline: <waktu: kejadian, deteksi, aksi, pulih>
- Root cause: <5 whys ringkas>
- Yang berjalan / yang tidak:
- Follow-up: [ ] <aksi> — owner — deadline
- Link: alert, log, runbook dipakai
```

## Aturan

- S1/S2 wajib postmortem + follow-up bertiket; S3 opsional.
- Review follow-up di gate fase berikutnya.
- Pertama kali: latih dengan game-day (matikan 1 worker staging, ukur MTTR).
