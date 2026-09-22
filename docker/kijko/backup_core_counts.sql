CREATE OR REPLACE FUNCTION pg_temp.usesend_table_count(table_name text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  result bigint;
BEGIN
  IF to_regclass(format('public.%I', table_name)) IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SELECT count(*) FROM %I', table_name) INTO result;
  RETURN result;
END;
$$;

SELECT json_build_object(
  'Domain', pg_temp.usesend_table_count('Domain'),
  'ApiKey', pg_temp.usesend_table_count('ApiKey'),
  'Email', pg_temp.usesend_table_count('Email'),
  'EmailEvent', pg_temp.usesend_table_count('EmailEvent'),
  'Contact', pg_temp.usesend_table_count('Contact'),
  'SuppressionList', pg_temp.usesend_table_count('SuppressionList'),
  'Webhook', pg_temp.usesend_table_count('Webhook'),
  'WebhookCall', pg_temp.usesend_table_count('WebhookCall'),
  '_prisma_migrations', pg_temp.usesend_table_count('_prisma_migrations')
)::text;
