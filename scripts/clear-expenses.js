require("dotenv").config();
const db = require("../src/db");

async function clearExpenses() {
  const before = await db.query("SELECT COUNT(*)::int AS c FROM expenses");
  console.log("before", before.rows[0].c);

  await db.query("TRUNCATE TABLE expenses RESTART IDENTITY CASCADE");

  // Ensure expense_type is boolean (handles leftover text values if any)
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses'
          AND column_name = 'expense_type'
          AND data_type <> 'boolean'
      ) THEN
        ALTER TABLE expenses ALTER COLUMN expense_type DROP DEFAULT;
        ALTER TABLE expenses
          ALTER COLUMN expense_type TYPE BOOLEAN
          USING (
            CASE
              WHEN lower(expense_type::text) IN ('true', 't', '1', 'necessary', 'wanted', 'yes') THEN TRUE
              WHEN lower(expense_type::text) IN ('false', 'f', '0', 'unnecessary', 'unwanted', 'no') THEN FALSE
              ELSE TRUE
            END
          );
        ALTER TABLE expenses ALTER COLUMN expense_type SET DEFAULT TRUE;
        ALTER TABLE expenses ALTER COLUMN expense_type SET NOT NULL;
      END IF;
    END $$;
  `);

  const after = await db.query("SELECT COUNT(*)::int AS c FROM expenses");
  const col = await db.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'expenses' AND column_name = 'expense_type'
  `);

  console.log("after", after.rows[0].c);
  console.log("expense_type column", col.rows[0]);
  await db.end();
}

clearExpenses().catch((err) => {
  console.error(err);
  process.exit(1);
});
