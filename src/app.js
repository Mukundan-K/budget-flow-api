const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const passport = require("passport");

dotenv.config();

require("./config/passport");

const authRoutes = require("./routes/auth");
const expenseRoutes = require("./routes/expense.routes");
const categoryRoutes = require("./routes/category.routes");
const masterRoutes = require("./routes/master.routes");
const paymentTypeRoutes = require("./routes/paymentType.routes");
const paymentRoutes = require("./routes/payment.routes");
const emiProductRoutes = require("./routes/emiProduct.routes");
const overviewRoutes = require("./routes/overview.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const bankAccountRoutes = require("./routes/bankAccount.routes");
const savingRoutes = require("./routes/saving.routes");
const debtRoutes = require("./routes/debt.routes");
const seedSchema = require("./seed/schema");
const seedDefaultCategories = require("./seed/defaultCategories");
const seedPayments = require("./seed/payments");
const seedExpenseSplits = require("./seed/expenseSplits");
const seedSavings = require("./seed/savings");
const seedReturns = require("./seed/returns");
const seedDebts = require("./seed/debts");

const app = express();

app.use(cors());

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

app.use(passport.initialize());

app.use("/auth", authRoutes);

app.use("/api/expenses", expenseRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/masters", masterRoutes);
app.use("/api/payment-types", paymentTypeRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/emi-products", emiProductRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/bank-accounts", bankAccountRoutes);
app.use("/api/savings", savingRoutes);
app.use("/api/debts", debtRoutes);

// Schema first (users/expenses/monthly_balances), then feature tables
seedSchema()
  .then(() =>
    Promise.all([
      seedDefaultCategories(),
      seedPayments(),
      seedSavings(),
      seedDebts(),
    ])
  )
  .then(() => Promise.all([seedExpenseSplits(), seedReturns()]))
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`Server running on http://localhost:${process.env.PORT}`);
    });
  });
