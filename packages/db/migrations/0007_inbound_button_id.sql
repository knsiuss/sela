-- 0007_inbound_button_id: retain the deterministic action id for button replies.
-- Apply after 0006_reply_target.sql. Legacy rows remain NULL and are not replayable as button actions.

ALTER TABLE public.inbound_messages
    ADD COLUMN IF NOT EXISTS button_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inbound_messages_button_id_bounds_ck'
          AND conrelid = 'public.inbound_messages'::regclass
    ) THEN
        ALTER TABLE public.inbound_messages
            ADD CONSTRAINT inbound_messages_button_id_bounds_ck
            CHECK (button_id IS NULL OR char_length(button_id) BETWEEN 1 AND 64);
    END IF;
END;
$$;

COMMENT ON COLUMN public.inbound_messages.button_id IS
    'Validated WhatsApp quick-reply action id; NULL for text messages and legacy rows.';
