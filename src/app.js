const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const passport = require("passport");

dotenv.config();

require("./config/passport");

const authRoutes = require("./routes/auth");

const app = express();

app.use(cors());

app.use(express.json());

app.use(passport.initialize());

app.use("/auth", authRoutes);

app.listen(process.env.PORT, () => {
  console.log("Server running");
});