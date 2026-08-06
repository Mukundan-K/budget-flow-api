-- Ensure expense_type is boolean only
-- true / false (no string labels)

ALTER TABLE expenses
  ALTER COLUMN expense_type DROP DEFAULT;

ALTER TABLE expenses
  ALTER COLUMN expense_type TYPE BOOLEAN
  USING (
    CASE
      WHEN lower(expense_type::text) IN ('true', 't', '1', 'necessary', 'wanted', 'yes') THEN TRUE
      WHEN lower(expense_type::text) IN ('false', 'f', '0', 'unnecessary', 'unwanted', 'no') THEN FALSE
      ELSE TRUE
    END
  );

ALTER TABLE expenses
  ALTER COLUMN expense_type SET DEFAULT TRUE;

ALTER TABLE expenses
  ALTER COLUMN expense_type SET NOT NULL;
