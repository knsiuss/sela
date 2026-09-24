-- 0006_reply_target: retain an encrypted WhatsApp recipient for worker replies.
-- Apply after 0005_inbound_messages.sql. Existing RLS policies and grants remain unchanged.

ALTER TABLE public.inbound_messages
    ADD COLUMN IF NOT EXISTS reply_target_ciphertext TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inbound_messages_reply_target_bounds_ck'
          AND conrelid = 'public.inbound_messages'::regclass
    ) THEN
        ALTER TABLE public.inbound_messages
            ADD CONSTRAINT inbound_messages_reply_target_bounds_ck
            CHECK (
                reply_target_ciphertext IS NULL
                OR (
                    char_length(reply_target_ciphertext) BETWEEN 1 AND 512
                    AND octet_length(reply_target_ciphertext) <= 1024
                )
            );
    END IF;
END;
$$;

COMMENT ON COLUMN public.inbound_messages.reply_target_ciphertext IS
    'Versioned AES-256-GCM ciphertext for the transient WhatsApp reply recipient; never plaintext. Rows created before 0006 have NULL and cannot be replied to, so they must be expired or reprocessed from a new signed webhook delivery.';
