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
const overviewRoutes = require("./routes/overview.routes");
const seedDefaultCategories = require("./seed/defaultCategories");
const seedPayments = require("./seed/payments");

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
app.use("/api/overview", overviewRoutes);

Promise.all([seedDefaultCategories(), seedPayments()]).then(() => {
  app.listen(process.env.PORT, () => {
    console.log(`Server running on http://localhost:${process.env.PORT}`);
  });
});
